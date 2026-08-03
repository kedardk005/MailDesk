/**
 * Reconcile email assignment state against existing Tasks.
 *
 * This logic used to run inside `connectDB()` on EVERY process start — every
 * nodemon reload in development and every deploy, restart or crash-loop in
 * production. That silently reset `status` and `assignedTo` on every email with
 * no linked Task, so approved emails reverted to looking unassigned and
 * reappeared in queues.
 *
 * It is now an explicit, opt-in maintenance action. It reports before it writes.
 *
 * Usage:
 *   node scripts/reconcileEmailAssignments.js          # dry run (report only)
 *   node scripts/reconcileEmailAssignments.js --apply  # actually write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Email = require('../models/Email');
const Task = require('../models/Task');

const run = async () => {
  const apply = process.argv.includes('--apply');

  if (!process.env.MONGO_URI) {
    console.error('[FATAL] MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

  const tasks = await Task.find({ linkedEmail: { $ne: null } }).select('linkedEmail');
  const linkedEmailIds = tasks.map((t) => t.linkedEmail);

  const filter = {
    _id: { $nin: linkedEmailIds },
    deletedAt: null,
    $or: [{ status: { $ne: 'unassigned' } }, { assignedTo: { $ne: null } }]
  };

  const affected = await Email.countDocuments(filter);
  console.log(`${affected} email(s) are assigned but have no linked Task.`);

  if (!apply) {
    const sample = await Email.find(filter).select('subject from status assignedTo').limit(20);
    sample.forEach((e) => console.log(`  - "${e.subject}" from ${e.from} (status=${e.status})`));
    console.log('Dry run complete. Re-run with --apply to write these changes.');
  } else if (affected > 0) {
    const result = await Email.updateMany(filter, { $set: { status: 'unassigned', assignedTo: null } });
    console.log(`[APPLIED] Reset ${result.modifiedCount} email(s) to unassigned.`);
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('[ERROR]', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
