#!/usr/bin/env node
/**
 * Audit D2 repair — tasks whose `clientName` holds a raw email From header.
 *
 * WHAT WENT WRONG
 *   `POST /api/gmail/emails/bulk-assign` used to write the raw sender header —
 *   e.g. `"Vivek Gandhi" <accounts@example.com>` — into `Task.clientName`
 *   instead of resolving the client the way the sync path does
 *   (utils/taskHelper `resolveClientForSender`). Such tasks escape every
 *   per-client counter (they group by client name) and render a mangled
 *   header in the Tasks UI. The write path is fixed; this script repairs the
 *   rows the old path already created.
 *
 * WHAT IT DOES
 *   Finds tasks whose `clientName` is header-shaped (contains '<' or '@' —
 *   real client names never do; the resolver's sentinel is 'Unassigned') and
 *   re-resolves each through the SAME `resolveClientForSender` used at ingest:
 *     - matched sender  -> the client's proper name
 *     - unmatched sender -> 'Unassigned' (the sync path's own sentinel)
 *   The sender is taken from the linked email's `from` when the task has one,
 *   otherwise from the stored header itself.
 *
 * SAFETY
 *   Dry run by default; pass --apply to write. Idempotent: after a repair the
 *   `clientName` is no longer header-shaped, so a re-run selects nothing.
 *
 * USAGE
 *   node scripts/repairTaskClientNames.js            # dry run, prints the plan
 *   node scripts/repairTaskClientNames.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Task = require('../models/Task');
const Email = require('../models/Email');
const cache = require('../utils/cache');
const { getClientMatcher, resolveClientForSender } = require('../utils/taskHelper');

const APPLY = process.argv.includes('--apply');

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);

  // Header-shaped clientName: raw From headers always carry '@' (and usually
  // '<'); legitimate client names and the 'Unassigned' sentinel never do.
  const damaged = await Task.find({ clientName: { $regex: /[<@]/ } })
    .select('_id clientName linkedEmail')
    .lean();

  console.log(`${damaged.length} task(s) with a header-shaped clientName${APPLY ? '' : ' (dry run, pass --apply to write)'}`);
  if (damaged.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const emailIds = damaged.map((t) => t.linkedEmail).filter(Boolean);
  const emails = await Email.find({ _id: { $in: emailIds } }).select('_id from').lean();
  const fromByEmail = new Map(emails.map((e) => [String(e._id), e.from]));

  const matcher = await getClientMatcher();
  let repaired = 0;
  const operations = [];

  for (const task of damaged) {
    const sender = fromByEmail.get(String(task.linkedEmail)) || task.clientName;
    const { clientName } = await resolveClientForSender(sender, matcher);
    console.log(`  ${task._id}  ${JSON.stringify(task.clientName)}  ->  ${JSON.stringify(clientName)}`);
    if (clientName === task.clientName) continue;
    repaired += 1;
    operations.push({
      updateOne: { filter: { _id: task._id }, update: { $set: { clientName } } }
    });
  }

  if (APPLY && operations.length > 0) {
    const result = await Task.bulkWrite(operations, { ordered: false });
    // The per-client counters group by clientName and are cached.
    await cache.invalidateStats();
    console.log(`repaired ${result.modifiedCount} task(s).`);
  } else {
    console.log(`${repaired} task(s) would be repaired.`);
  }

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error('repair failed:', err);
  process.exit(1);
});
