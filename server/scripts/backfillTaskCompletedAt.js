#!/usr/bin/env node
/**
 * F-2 — backfill `Task.completedAt` for tasks that were already `Completed`
 * before the field existed.
 *
 * THE HONEST PART FIRST
 *   For most historical rows there is NO record of when the task was completed.
 *   `Task` has no `updatedAt`, the status was overwritten in place, and nothing
 *   else stored the instant. Where no defensible timestamp exists this script
 *   leaves `completedAt` NULL and the task is simply excluded from resolution
 *   metrics. It does not invent one — a fabricated completion time would show
 *   up as a real median and quietly misreport the thing the metric exists to
 *   prove.
 *
 * WHERE A TIMESTAMP DOES EXIST
 *   `updateTask` writes an audit row on every update:
 *
 *     action  = 'Task Update'
 *     details = 'Updated task "<title>" (Status: Completed…'
 *
 *   The EARLIEST such row for a task is the moment it was first marked
 *   complete. That is what `--strategy=activity-log` (the default) uses. The
 *   match is on the quoted title plus `Status: Completed`, so a task whose
 *   title is ambiguous with another task's may resolve to the wrong row; such
 *   rows are reported as `ambiguous` and skipped rather than guessed.
 *
 *   `--strategy=none` skips the heuristic entirely and only reports the gap.
 *
 * SAFETY
 *   Dry run by default. Idempotent: only rows with `completedAt: null` and
 *   `status: 'Completed'` are considered, so re-running never moves a value
 *   that a real completion has since written.
 *
 * USAGE
 *   node scripts/backfillTaskCompletedAt.js                     # dry run
 *   node scripts/backfillTaskCompletedAt.js --apply
 *   node scripts/backfillTaskCompletedAt.js --apply --strategy=none
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Task = require('../models/Task');
const ActivityLog = require('../models/ActivityLog');
const { escapeRegex } = require('../utils/regexHelper');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const BATCH = Number((argv.find((a) => a.startsWith('--batch=')) || '').split('=')[1] || 200);
const STRATEGY = (argv.find((a) => a.startsWith('--strategy=')) || '').split('=')[1] || 'activity-log';

/**
 * Find the earliest audit row that recorded this task being set to Completed.
 * @param {Object} task
 * @returns {Promise<{at: Date|null, ambiguous: Boolean}>}
 */
const findCompletionFromAuditTrail = async (task) => {
  const title = String(task.title || '').trim();
  if (!title) return { at: null, ambiguous: false };

  const rows = await ActivityLog.find({
    action: 'Task Update',
    details: new RegExp(`"${escapeRegex(title)}"[^"]*Status: Completed`, 'i')
  })
    .select('createdAt details')
    .sort({ createdAt: 1 })
    .limit(2)
    .lean();

  if (rows.length === 0) return { at: null, ambiguous: false };

  // More than one task can share a title. Only accept the match when the title
  // is unique across the collection; otherwise the row could belong to a
  // different task entirely.
  const sameTitleCount = await Task.countDocuments({ title: task.title });
  if (sameTitleCount > 1) return { at: null, ambiguous: true };

  return { at: rows[0].createdAt, ambiguous: false };
};

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(
    `Connected. Mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'} strategy=${STRATEGY} batch=${BATCH}`
  );

  const filter = { status: 'Completed', completedAt: null };
  const total = await Task.countDocuments(filter);
  console.log(`${total} completed task(s) have no completedAt.`);

  if (STRATEGY === 'none') {
    console.log('strategy=none: nothing resolved. These tasks stay out of resolution metrics.');
    await mongoose.connection.close();
    return;
  }

  let processed = 0;
  let resolved = 0;
  let ambiguous = 0;
  let unresolved = 0;
  let lastId = null;

  /* eslint-disable no-await-in-loop */
  while (true) {
    const query = lastId ? { ...filter, _id: { $gt: lastId } } : filter;

    const batch = await Task.find(query).select('_id title createdAt').sort({ _id: 1 }).limit(BATCH).lean();

    if (batch.length === 0) break;
    lastId = batch[batch.length - 1]._id;

    const operations = [];

    for (const task of batch) {
      const { at, ambiguous: isAmbiguous } = await findCompletionFromAuditTrail(task);

      if (isAmbiguous) {
        ambiguous += 1;
        continue;
      }
      if (!at) {
        unresolved += 1;
        continue;
      }
      // A completion cannot predate the task. If the audit row does, the match
      // is wrong; leave it null.
      if (task.createdAt && at < task.createdAt) {
        ambiguous += 1;
        continue;
      }

      resolved += 1;
      operations.push({ updateOne: { filter: { _id: task._id }, update: { $set: { completedAt: at } } } });
    }

    if (APPLY && operations.length > 0) {
      await Task.bulkWrite(operations, { ordered: false });
    }

    processed += batch.length;
    console.log(`  scanned ${processed}/${total} (resolved: ${resolved}, ambiguous: ${ambiguous}, none: ${unresolved})`);

    if (batch.length < BATCH) break;
  }
  /* eslint-enable no-await-in-loop */

  console.log(
    `${APPLY ? 'Done' : 'Dry run complete'}. resolved=${resolved} ambiguous=${ambiguous} no-evidence=${unresolved}.` +
      `\n${ambiguous + unresolved} task(s) keep completedAt: null and are EXCLUDED from resolution metrics.` +
      (APPLY ? '' : '\nRe-run with --apply to write.')
  );

  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('Backfill failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
