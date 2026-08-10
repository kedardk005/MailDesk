const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const getEncryptionKey = () => {
  const keyStr = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyStr) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is not defined.');
  }

  let key;
  // Try to decode as hex if it matches hex length (64 chars for 32 bytes)
  if (keyStr.length === 64 && /^[0-9a-fA-F]+$/.test(keyStr)) {
    key = Buffer.from(keyStr, 'hex');
  } else {
    // Try base64
    key = Buffer.from(keyStr, 'base64');
  }

  if (key.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must be exactly 32 bytes. Decoded key length is ${key.length} bytes.`);
  }

  return key;
};

const encrypt = (text) => {
  if (!text) return text;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  // Format: iv:encrypted:authTag
  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
};

/**
 * Thrown when a stored token cannot be recovered. Callers must treat this as
 * "this mailbox is not usable", not as "here is a token".
 */
class TokenDecryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenDecryptionError';
    this.code = 'ETOKENDECRYPT';
  }
}

/**
 * Does this stored value carry the `iv:ciphertext:tag` envelope `encrypt()`
 * produces?
 *
 * Structural, not a guess: three colon-separated parts, each valid lowercase
 * hex, with an IV and an auth tag of exactly the right length. The migration
 * script used to test `!value.includes(':')`, which would have classified any
 * token containing a single stray colon as already-encrypted and SILENTLY LEFT
 * IT IN PLAINTEXT — the one failure mode a migration must not have (L-4).
 *
 * @param {*} value
 * @returns {Boolean}
 */
const isEncrypted = (value) => {
  if (typeof value !== 'string' || value === '') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  const [iv, payload, tag] = parts;
  const hex = /^[0-9a-f]+$/i;
  return (
    iv.length === IV_LENGTH * 2 &&
    tag.length === TAG_LENGTH * 2 &&
    hex.test(iv) &&
    hex.test(tag) &&
    payload.length > 0 &&
    payload.length % 2 === 0 &&
    hex.test(payload)
  );
};

/*
 * L-4 — plaintext OAuth refresh tokens at rest.
 *
 * A workspace that predates scripts/encryptExistingTokens.js still holds raw
 * Google refresh tokens. Those used to pass through with a `console.warn`
 * whose default was PERMISSIVE EVERYWHERE, including production — so the only
 * signal that a firm's mailbox credentials were sitting unencrypted in Mongo
 * was an unstructured line in a log nobody greps, repeated once per mailbox per
 * sync (the audit found eight of them in one dev run).
 *
 * Two changes:
 *
 *  1. The default is now permissive only OUTSIDE production. In production the
 *     guard fails closed unless an operator sets
 *     ALLOW_LEGACY_PLAINTEXT_TOKENS=true deliberately — a decision that then
 *     appears in the deployment config rather than in nobody's memory.
 *  2. The warning goes through the structured logger, is throttled, and
 *     carries a running count, so it is loud once rather than noise forever.
 *     `utils/logger` is required lazily: this module is pulled in by scripts
 *     that must not drag the whole logging stack in with it.
 */
const allowLegacyPlaintext = () => {
  const configured = process.env.ALLOW_LEGACY_PLAINTEXT_TOKENS;
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return process.env.NODE_ENV !== 'production';
};

const LEGACY_WARN_INTERVAL_MS = Number(process.env.LEGACY_TOKEN_WARN_INTERVAL_MS || 300000);
let legacyPlaintextSeen = 0;
let legacyWarnedAt = 0;

/**
 * Warn — loudly, once, then at most every LEGACY_TOKEN_WARN_INTERVAL_MS — that
 * an unencrypted token was read. Never logs the token itself.
 * @returns {void}
 */
const warnLegacyPlaintext = () => {
  legacyPlaintextSeen += 1;
  const now = Date.now();
  if (legacyWarnedAt !== 0 && now - legacyWarnedAt < LEGACY_WARN_INTERVAL_MS) return;
  legacyWarnedAt = now;

  const payload = {
    occurrences: legacyPlaintextSeen,
    remediation: 'node scripts/encryptExistingTokens.js --apply',
    then: 'set ALLOW_LEGACY_PLAINTEXT_TOKENS=false'
  };
  const message =
    'UNENCRYPTED OAuth token read from the database. Refresh tokens are stored in plaintext ' +
    'until the migration script is run. See docs/DEPLOY-WINDOWS.md.';

  try {
    // eslint-disable-next-line global-require
    require('./logger').log('crypto').warn(payload, message);
  } catch {
    console.warn(`[CRYPTO] ${message} ${JSON.stringify(payload)}`);
  }
};

/**
 * How many unencrypted tokens this process has read. Exposed for the boot-time
 * audit and for tests.
 * @returns {Number}
 */
const legacyPlaintextCount = () => legacyPlaintextSeen;

/**
 * Decrypt a stored OAuth token.
 *
 * This function used to FAIL OPEN: on any decryption error it returned the
 * ciphertext, which was then handed to Google as an access token. That turned a
 * key rotation, a truncated field or a tampered record into a stream of opaque
 * 401s from the Gmail API, and it silently defeated encryption at rest — the
 * caller could not tell a real token from a ciphertext. It now throws.
 *
 * @param {String|null} ciphertext
 * @returns {String|null}
 * @throws {TokenDecryptionError}
 */
const decrypt = (ciphertext) => {
  if (!ciphertext) return ciphertext;

  if (typeof ciphertext !== 'string') {
    throw new TokenDecryptionError('Stored token is not a string.');
  }

  // Not in iv:encrypted:authTag form — this is a legacy plaintext token.
  if (!isEncrypted(ciphertext)) {
    if (allowLegacyPlaintext()) {
      warnLegacyPlaintext();
      return ciphertext;
    }
    throw new TokenDecryptionError('Stored token is not encrypted and legacy plaintext is disabled.');
  }

  const parts = ciphertext.split(':');
  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    // Deliberately does NOT include the ciphertext in the message.
    throw new TokenDecryptionError(`Failed to decrypt stored token: ${err.message}`);
  }
};

/**
 * Non-throwing variant for paths that must survive one bad record — a bulk sync
 * over many mailboxes, for instance, should skip the broken one rather than
 * abort every remaining account.
 * @param {String|null} ciphertext
 * @returns {String|null} null when the token cannot be recovered
 */
const tryDecrypt = (ciphertext) => {
  try {
    return decrypt(ciphertext);
  } catch (err) {
    return null;
  }
};

module.exports = {
  encrypt,
  decrypt,
  tryDecrypt,
  isEncrypted,
  allowLegacyPlaintext,
  legacyPlaintextCount,
  TokenDecryptionError
};
