#!/usr/bin/env node
/**
 * F-1 — backfill `Email.threadId`, `Email.direction` and `Email.threadPosition`
 * for rows created before threading existed.
 *
 * WHY THIS IS REQUIRED
 *   Every thread read (`GET /api/gmail/threads`) and every SLA metric groups by
 *   `threadId`. Rows without one are invisible to both. `direction` decides
 *   whether a message counts as received or as our reply, and the whole
 *   first-response metric is that distinction.
 *
 * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT DO
 *   - `direction` is set to `inbound` wherever it is missing. Every row that
 *     predates F-1 was ingested by the sync, which only ever wrote received
 *     mail; there were no outbound rows at all before this wave.
 *   - `threadId` is set to the row's own Gmail `messageId` where it is missing.
 *     Gmail's thread id IS the id of the first message in the conversation, so
 *     for a single-message conversation this is the correct value, and for a
 *     longer one it degrades to "one thread per message" — exactly the
 *     behaviour the app had before F-1, never a WRONG grouping.
 *
 *     It does NOT try to reconstruct conversations by normalising subjects.
 *     "Re: Invoice" from two unrelated clients is the same normalised subject,
 *     and merging two clients' mail into one conversation is a far worse defect
 *     than leaving them apart. `--from-gmail` is deliberately not implemented
 *     either: it would need an OAuth round-trip per message.
 *   - `threadPosition` is recomputed from `date` for every thread it touches.
 *
 * SAFETY
 *   Dry run by default. Nothing is written unless `--apply` is passed.
 *   Idempotent: re-running only touches rows that are still missing a value.
 *   Batched by `_id`, never loading the collection into memory, and it never
 *   selects `body`.
 *
 * USAGE
 *   node scripts/backfillEmailThreads.js                  # dry run
 *   node scripts/backfillEmailThreads.js --apply          # write
 *   node scripts/backfillEmailThreads.js --apply --batch=1000
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Email = require('../models/Email');
const { resyncThreadPositions } = require('../utils/threadHelper');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const BATCH = Number((argv.find((a) => a.startsWith('--batch=')) || '').split('=')[1] || 500);

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'} batch=${BATCH}`);

  const filter = {
    $or: [{ threadId: { $in: [null, ''] } }, { threadId: { $exists: false } }, { direction: { $exists: false } }]
  };

  const total = await Email.countDocuments(filter);
  console.log(`${total} email(s) need a threadId and/or a direction.`);

  let processed = 0;
  let threadWrites = 0;
  let directionWrites = 0;
  let lastId = null;
  const touchedThreads = new Set();

  /* eslint-disable no-await-in-loop */
  while (true) {
    const query = lastId ? { ...filter, _id: { $gt: lastId } } : filter;

    const batch = await Email.find(query)
      .select('_id messageId threadId direction')
      .sort({ _id: 1 })
      .limit(BATCH)
      .lean();

    if (batch.length === 0) break;
    lastId = batch[batch.length - 1]._id;

    const operations = [];

    for (const email of batch) {
      const update = {};

      if (!email.threadId) {
        update.threadId = email.messageId;
        threadWrites += 1;
        touchedThreads.add(email.messageId);
      } else {
        touchedThreads.add(email.threadId);
      }

      if (!email.direction) {
        update.direction = 'inbound';
        directionWrites += 1;
      }

      if (Object.keys(update).length > 0) {
        operations.push({ updateOne: { filter: { _id: email._id }, update: { $set: update } } });
      }
    }

    if (APPLY && operations.length > 0) {
      await Email.bulkWrite(operations, { ordered: false });
    }

    processed += batch.length;
    console.log(`  scanned ${processed}/${total} (threadIds: ${threadWrites}, directions: ${directionWrites})`);

    if (batch.length < BATCH) break;
  }
  /* eslint-enable no-await-in-loop */

  let positioned = 0;
  if (APPLY && touchedThreads.size > 0) {
    console.log(`Recomputing threadPosition for ${touchedThreads.size} thread(s)…`);
    // Chunked so one call never holds tens of thousands of ids.
    const ids = [...touchedThreads];
    for (let i = 0; i < ids.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop
      positioned += await resyncThreadPositions(ids.slice(i, i + 200));
    }
  }

  console.log(
    APPLY
      ? `Done. Wrote ${threadWrites} threadId(s), ${directionWrites} direction(s), ${positioned} position(s).`
      : `Dry run complete. Would write ${threadWrites} threadId(s) and ${directionWrites} direction(s) across ` +
        `${touchedThreads.size} thread(s). Re-run with --apply.`
  );

  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('Backfill failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
