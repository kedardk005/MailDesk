#!/usr/bin/env node
/**
 * Build/refresh every index declared on the Mongoose schemas.
 *
 * In production `autoIndex` is FALSE (see config/db.js): letting every replica
 * build indexes on every boot is a production hazard — it is a foreground
 * operation on older servers and a duplicated background build on newer ones.
 * Run this once as an explicit deploy step instead.
 *
 * NOTE `syncIndexes()` also DROPS indexes that are no longer declared in the
 * schema. Review the output before running it against a shared database.
 *
 * USAGE
 *   node scripts/syncIndexes.js            # report only
 *   node scripts/syncIndexes.js --apply    # build/drop
 */

require('dotenv').config();
const mongoose = require('mongoose');

const models = [
  require('../models/User'),
  require('../models/Email'),
  require('../models/Task'),
  require('../models/TaskComment'),
  require('../models/Client'),
  require('../models/KeywordRule'),
  require('../models/Notification'),
  require('../models/ActivityLog'),
  // F-2 — SLA targets (global default + per-client override).
  require('../models/SlaPolicy')
];

const APPLY = process.argv.includes('--apply');

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false });
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'REPORT ONLY'}`);

  for (const model of models) {
    const declared = model.schema.indexes();
    console.log(`\n${model.modelName}: ${declared.length} index(es) declared`);
    for (const [keys, options] of declared) {
      const flags = [];
      if (options?.unique) flags.push('unique');
      if (options?.partialFilterExpression) flags.push('partial');
      console.log(`  ${JSON.stringify(keys)}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
    }

    if (APPLY) {
      try {
        const dropped = await model.syncIndexes();
        console.log(`  -> synced${dropped && dropped.length ? `, dropped: ${dropped.join(', ')}` : ''}`);
      } catch (err) {
        // A unique index cannot build over existing duplicate data. Report it
        // rather than aborting the whole run.
        console.error(`  -> FAILED: ${err.message}`);
      }
    }
  }

  console.log(APPLY ? '\nIndex sync complete.' : '\nReport only. Re-run with --apply to build.');
  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('syncIndexes failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
