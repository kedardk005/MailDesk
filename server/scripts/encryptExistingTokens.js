#!/usr/bin/env node
// server/scripts/encryptExistingTokens.js
/**
 * L-4 — encrypt OAuth tokens that are still stored in plaintext.
 *
 * WHAT IT DOES
 *   Rewrites `gmailAccessToken` / `gmailRefreshToken`, on the User document and
 *   on every entry of `linkedGmailAccounts`, from plaintext to the
 *   `iv:ciphertext:tag` envelope `utils/tokenCrypto.encrypt()` produces. Values
 *   that are already encrypted are left exactly as they are.
 *
 * WHY IT IS DEFENSIVE
 *   This is the one script in the repository that rewrites live credentials, it
 *   had never been run, and it used to: connect to whatever `MONGO_URI`
 *   `dotenv` happened to load, write immediately with no confirmation and no
 *   dry run, decide "already encrypted" by testing `value.includes(':')` (so a
 *   token containing one stray colon would have been left in plaintext
 *   FOREVER, silently), and never verify that what it wrote could be read back.
 *   Every one of those is fixed below.
 *
 * USAGE
 *   node scripts/encryptExistingTokens.js                 # DRY RUN (default)
 *   node scripts/encryptExistingTokens.js --apply         # write
 *   node scripts/encryptExistingTokens.js --apply --yes   # write, no prompt
 *
 * A dry run reads and reports; it writes nothing. `--apply` prints the target
 * host and database and waits for a typed confirmation unless `--yes` is given.
 *
 * NEVER prints a token, encrypted or otherwise.
 */
require('dotenv').config();
const readline = require('readline');
const mongoose = require('mongoose');
const User = require('../models/User');
const { encrypt, decrypt, isEncrypted } = require('../utils/tokenCrypto');

const APPLY = process.argv.includes('--apply');
const ASSUME_YES = process.argv.includes('--yes') || process.argv.includes('-y');

const TOKEN_FIELDS = ['gmailAccessToken', 'gmailRefreshToken'];

/**
 * `mongodb://user:pass@host:27017/db` -> `host:27017/db`, with the credentials
 * removed. The operator has to be able to SEE which database they are about to
 * rewrite, and must not have the password echoed to a terminal to get it.
 *
 * @param {String} uri
 * @returns {String}
 */
const describeTarget = (uri) => {
  try {
    const parsed = new URL(uri);
    const db = (parsed.pathname || '').replace(/^\//, '') || '(default)';
    return `${parsed.host}/${db}`;
  } catch {
    return '(unparseable MONGO_URI)';
  }
};

/**
 * Ask for a typed confirmation on stdin.
 * @param {String} question
 * @returns {Promise<String>}
 */
const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });

/**
 * Encrypt one plaintext value and prove it reads back before it is used.
 *
 * A migration that writes a value it cannot decrypt destroys the credential
 * with no way back, so the round trip is checked for EVERY field rather than
 * trusted from the first one.
 *
 * @param {String} plaintext
 * @returns {String} the ciphertext
 * @throws {Error} if the round trip does not reproduce the input
 */
const encryptVerified = (plaintext) => {
  const ciphertext = encrypt(plaintext);
  if (decrypt(ciphertext) !== plaintext) {
    throw new Error('round-trip verification failed: the encrypted value did not decrypt back');
  }
  return ciphertext;
};

const migrate = async () => {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is not set. Refusing to guess a target database.');
    process.exit(1);
  }

  // Fail before touching the database, not halfway through it.
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    console.error('TOKEN_ENCRYPTION_KEY is not set. Nothing can be encrypted without it.');
    console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
  try {
    encryptVerified('token-crypto-preflight');
  } catch (err) {
    console.error(`TOKEN_ENCRYPTION_KEY is unusable: ${err.message}`);
    process.exit(1);
  }

  const target = describeTarget(mongoUri);
  console.log('');
  console.log(`  target   : ${target}`);
  console.log(`  mode     : ${APPLY ? 'APPLY (writes)' : 'DRY RUN (reads only)'}`);
  console.log('');

  if (APPLY && !ASSUME_YES) {
    const answer = await ask(`Rewrite stored OAuth tokens on ${target}? Type the database name to confirm: `);
    const expected = target.split('/').pop();
    if (answer !== expected) {
      console.error(`Confirmation did not match "${expected}". Nothing was written.`);
      process.exit(1);
    }
  }

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000, autoIndex: false });
  console.log('Connected.\n');

  const users = await User.find({}).select('+gmailAccessToken +gmailRefreshToken +linkedGmailAccounts');

  let plaintextFields = 0;
  let alreadyEncrypted = 0;
  let usersAffected = 0;
  let usersWritten = 0;
  const failures = [];

  for (const user of users) {
    let modified = false;

    for (const field of TOKEN_FIELDS) {
      const value = user[field];
      if (!value) continue;
      if (isEncrypted(value)) {
        alreadyEncrypted += 1;
        continue;
      }
      plaintextFields += 1;
      modified = true;
      if (APPLY) user[field] = encryptVerified(value);
    }

    for (const acct of user.linkedGmailAccounts || []) {
      for (const field of TOKEN_FIELDS) {
        const value = acct[field];
        if (!value) continue;
        if (isEncrypted(value)) {
          alreadyEncrypted += 1;
          continue;
        }
        plaintextFields += 1;
        modified = true;
        if (APPLY) acct[field] = encryptVerified(value);
      }
    }

    if (!modified) continue;
    usersAffected += 1;

    if (!APPLY) {
      console.log(`  would encrypt: ${user.email}`);
      continue;
    }

    try {
      // Explicit for the subdocument array: Mongoose does not always see an
      // in-place field assignment inside it.
      user.markModified('linkedGmailAccounts');
      await user.save();
      usersWritten += 1;
      console.log(`  encrypted: ${user.email}`);
    } catch (err) {
      // One bad record must not abort the rest; a half-migrated collection with
      // a named failure is recoverable, an aborted run at an unknown point is
      // much less so.
      failures.push({ email: user.email, error: err.message });
      console.error(`  FAILED: ${user.email} — ${err.message}`);
    }
  }

  console.log('');
  console.log(`  users scanned          : ${users.length}`);
  console.log(`  token fields, plaintext: ${plaintextFields}`);
  console.log(`  token fields, encrypted: ${alreadyEncrypted}`);
  console.log(`  users needing a rewrite: ${usersAffected}`);
  if (APPLY) console.log(`  users rewritten        : ${usersWritten}`);
  if (failures.length) console.log(`  failures               : ${failures.length}`);
  console.log('');

  if (!APPLY) {
    console.log(
      plaintextFields === 0
        ? 'Nothing to do — every stored token is already encrypted.'
        : 'DRY RUN — nothing was written. Re-run with --apply to encrypt these.'
    );
  } else if (failures.length === 0 && plaintextFields > 0) {
    console.log('Done. Now set ALLOW_LEGACY_PLAINTEXT_TOKENS=false and restart the API.');
  } else if (failures.length > 0) {
    console.log('Finished WITH FAILURES. Do NOT set ALLOW_LEGACY_PLAINTEXT_TOKENS=false yet.');
  }

  await mongoose.disconnect();
  process.exit(failures.length > 0 ? 1 : 0);
};

migrate().catch(async (err) => {
  console.error('Migration failed:', err.message);
  try {
    await mongoose.disconnect();
  } catch {
    /* already down */
  }
  process.exit(1);
});
