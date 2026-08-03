#!/usr/bin/env node
/**
 * Backfill `Email.snippet` and `Email.clientId` for rows created before the
 * list-response optimisation.
 *
 * WHY THIS IS REQUIRED
 *   - `snippet` is what every list endpoint returns in place of `body`. Rows
 *     without it render with an empty preview.
 *   - `clientId` is the denormalised client attribution that makes per-client
 *     mail counts an indexed `$group` instead of N regex scans over the whole
 *     Email collection. Rows without it are counted as 0.
 *
 * SAFETY
 *   Dry run by default. Nothing is written unless `--apply` is passed.
 *   Idempotent: re-running only touches rows that are still missing a value.
 *   Batched by `_id` so it never loads the collection into memory, and it reads
 *   `body` explicitly (the field is `select: false`).
 *
 * USAGE
 *   node scripts/backfillEmailSnippets.js                 # dry run
 *   node scripts/backfillEmailSnippets.js --apply         # write
 *   node scripts/backfillEmailSnippets.js --apply --batch=500
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Email = require('../models/Email');
const { makeSnippet } = require('../utils/snippet');
const { getClientMatcher, resolveClientForSender } = require('../utils/taskHelper');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const BATCH = Number((argv.find((a) => a.startsWith('--batch=')) || '').split('=')[1] || 200);

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'} batch=${BATCH}`);

  const matcher = await getClientMatcher();

  const filter = {
    $or: [{ snippet: { $in: [null, ''] } }, { clientId: null }]
  };

  const total = await Email.countDocuments(filter);
  console.log(`${total} email(s) need a snippet and/or client attribution.`);

  let processed = 0;
  let snippetWrites = 0;
  let clientWrites = 0;
  let lastId = null;

  /* eslint-disable no-await-in-loop */
  while (true) {
    const query = lastId ? { ...filter, _id: { $gt: lastId } } : filter;

    const batch = await Email.find(query)
      // `+body` because the field is select:false on the schema.
      .select('_id from subject snippet clientId +body')
      .sort({ _id: 1 })
      .limit(BATCH)
      .lean();

    if (batch.length === 0) break;
    lastId = batch[batch.length - 1]._id;

    const operations = [];

    for (const email of batch) {
      const update = {};

      if (!email.snippet) {
        const snippet = makeSnippet(email.body || '', '');
        if (snippet) {
          update.snippet = snippet;
          snippetWrites += 1;
        }
      }

      if (!email.clientId) {
        const { clientId } = await resolveClientForSender(email.from, matcher);
        if (clientId) {
          update.clientId = clientId;
          clientWrites += 1;
        }
      }

      if (Object.keys(update).length > 0) {
        operations.push({ updateOne: { filter: { _id: email._id }, update: { $set: update } } });
      }
    }

    if (APPLY && operations.length > 0) {
      await Email.bulkWrite(operations, { ordered: false });
    }

    processed += batch.length;
    console.log(`  scanned ${processed}/${total} (snippets: ${snippetWrites}, clients: ${clientWrites})`);

    if (batch.length < BATCH) break;
  }
  /* eslint-enable no-await-in-loop */

  console.log(
    APPLY
      ? `Done. Wrote ${snippetWrites} snippet(s) and ${clientWrites} client attribution(s).`
      : `Dry run complete. Would write ${snippetWrites} snippet(s) and ${clientWrites} client attribution(s). Re-run with --apply.`
  );

  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('Backfill failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
