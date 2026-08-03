#!/usr/bin/env node
/**
 * seedDemoData.js — realistic-volume demo dataset for MailDesk.
 *
 * Creates (approximate targets; exact counts printed at the end):
 *   ~2,000 emails across 4 mailbox accounts, threaded 1-6 msgs, 90 days
 *   ~400 tasks (email-linked + standalone) across every status/priority
 *   ~25 clients (several sharing sender addresses with the seeded mail)
 *   ~15 users (Admin/Head/Employee, a few Pending so the approval queue is live)
 *   comments, notifications, activity-log entries and keyword rules in proportion
 *
 * Usage (from server/):
 *   node scripts/seedDemoData.js                 # seed against the default local demo DB
 *   node scripts/seedDemoData.js --uri mongodb://127.0.0.1:27017/maildesk_run
 *   node scripts/seedDemoData.js --dry-run       # print the plan, write nothing
 *   node scripts/seedDemoData.js --clean         # remove everything this script created
 *   node scripts/seedDemoData.js --force         # bypass the safety gate (NOT recommended)
 *
 * SAFETY: refuses to run unless the target is a loopback host AND the database
 * name looks like a scratch/demo database (contains demo|test|dev|local|
 * scratch|seed|sample|run|stag). `--force` overrides — never use it casually.
 * The script deliberately does NOT read server/.env: the checked-in .env points
 * at an Atlas cluster and a seeder must never inherit that by accident.
 *
 * IDEMPOTENT: every inserted _id is recorded in a `seed_meta` document. A re-run
 * (and `--clean`) first deletes exactly those documents, then re-inserts, so
 * running it twice cannot double the data. Base demo users (admin@demo.test,
 * head@demo.test, emp@demo.test) are never created or deleted here — only their
 * mailbox linkage fields are set (and reverted by --clean).
 *
 * COHERENCE INVARIANTS (verified after insert; the script exits non-zero if any
 * fails):
 *   - thread messages share toEmail/fetchedBy/clientId, dates ascend,
 *     threadPosition is contiguous from 0, first message is inbound
 *   - email.status === 'assigned' iff assignedTo is set (inbound)
 *   - outbound rows carry sentBy/sentAt and are never 'assigned'
 *   - approvalStatus 'pending' rows carry suggestedAssignedTo and are unassigned
 *   - a task's linkedEmail exists, is inbound, and the task's assignee and
 *     clientName match the email's assignee and attributed client
 *   - Pending tasks never have a past deadline (the overdue cron would flip
 *     them mid-audit); overdue work is seeded as Late with overdueNotifiedAt set
 *   - Completed tasks have completedAt >= createdAt
 */

'use strict';

const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Models (registered on the default mongoose connection).
const User = require('../models/User');
const Client = require('../models/Client');
const Email = require('../models/Email');
const Task = require('../models/Task');
const TaskComment = require('../models/TaskComment');
const Notification = require('../models/Notification');
const ActivityLog = require('../models/ActivityLog');
const KeywordRule = require('../models/KeywordRule');

// ---------------------------------------------------------------------------
// CLI + safety gate
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/maildesk_run';
const uri = argValue('--uri') || DEFAULT_URI;
const FORCE = hasFlag('--force');
const DRY_RUN = hasFlag('--dry-run');
const CLEAN = hasFlag('--clean');

const SCRATCH_DB_RE = /(demo|test|dev|local|scratch|seed|sample|run|stag)/i;
const LOOPBACK_RE = /^(localhost|127\.0\.0\.1|::1)$/i;

const assertSafeTarget = (mongoUri) => {
  let parsed;
  try {
    // mongodb:// URIs parse cleanly with the WHATWG parser for our purposes.
    parsed = new URL(mongoUri.replace(/^mongodb\+srv:/, 'mongodb:'));
  } catch (e) {
    console.error(`FATAL: cannot parse Mongo URI "${mongoUri}"`);
    process.exit(1);
  }
  const host = parsed.hostname || '';
  const dbName = (parsed.pathname || '').replace(/^\//, '').split('?')[0];

  const problems = [];
  if (!LOOPBACK_RE.test(host)) problems.push(`host "${host}" is not loopback`);
  if (!dbName) problems.push('no database name in URI');
  else if (!SCRATCH_DB_RE.test(dbName)) {
    problems.push(`database name "${dbName}" does not look like a scratch/demo DB`);
  }

  if (problems.length > 0 && !FORCE) {
    console.error('REFUSING to seed. This does not look like a scratch database:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('Pass --force ONLY if you are certain this target is disposable.');
    process.exit(1);
  }
  if (problems.length > 0 && FORCE) {
    console.warn('WARNING: safety gate bypassed with --force:', problems.join('; '));
  }
  return dbName;
};

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same data every run.
// ---------------------------------------------------------------------------

const mulberry32 = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(42);
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.now();
const DAY = 86400000;
const HOUR = 3600000;
const WINDOW_DAYS = 90;

const PASSWORD = 'RunTest!2345'; // same as the base demo users

const BASE_USERS = {
  admin: 'admin@demo.test',
  head: 'head@demo.test',
  emp: 'emp@demo.test'
};

// 4 mailboxes across 3 owners: exercises the Admin all-accounts view, the
// Admin linked-account path, and Head confinement to their own mailbox.
const MAILBOXES = [
  { addr: 'support@kmk-demo.test', owner: BASE_USERS.admin, primary: true },
  { addr: 'sales@kmk-demo.test', owner: BASE_USERS.admin, primary: false }, // linked account
  { addr: 'billing@kmk-demo.test', owner: BASE_USERS.head, primary: true },
  { addr: 'ops@kmk-demo.test', owner: 'ops.head@demo.test', primary: true }
];

const NEW_USERS = [
  { name: 'Omkar Patil', email: 'ops.head@demo.test', role: 'Head', status: 'Approved' },
  { name: 'Aarti Shah', email: 'u01.aarti@demo.test', role: 'Employee', status: 'Approved' },
  { name: 'Bhavin Mehta', email: 'u02.bhavin@demo.test', role: 'Employee', status: 'Approved' },
  { name: 'Chirag Desai', email: 'u03.chirag@demo.test', role: 'Employee', status: 'Approved' },
  { name: 'Deepa Iyer', email: 'u04.deepa@demo.test', role: 'Employee', status: 'Approved' },
  { name: 'Esha Kulkarni', email: 'u05.esha@demo.test', role: 'Employee', status: 'Approved' },
  { name: 'Farhan Qureshi', email: 'u06.farhan@demo.test', role: 'Employee', status: 'Approved' },
  { name: 'Gauri Nair', email: 'u07.gauri@demo.test', role: 'Employee', status: 'Approved' },
  { name: 'Harsh Vora', email: 'pending1.harsh@demo.test', role: 'Employee', status: 'Pending' },
  { name: 'Ishita Rao', email: 'pending2.ishita@demo.test', role: 'Employee', status: 'Pending' },
  { name: 'Jay Thakkar', email: 'pending3.jay@demo.test', role: 'Head', status: 'Pending' },
  { name: 'Kiran Joshi', email: 'rejected1.kiran@demo.test', role: 'Employee', status: 'Rejected' }
];

// 22 new clients (3 already exist in the base DB and are reused, untouched).
const NEW_CLIENTS = [
  'Apex Fabrics', 'Bluewave Shipping', 'Crestline Traders', 'Dhruv Polymers',
  'Eastport Freight', 'Falcon Industries', 'Ganga Agro', 'Horizon Chemicals',
  'Indus Metalworks', 'Juniper Retail', 'Kaveri Textiles', 'Lotus Packaging',
  'Meridian Motors', 'Nimbus Software', 'Orchid Hospitality', 'Pinnacle Steel',
  'Quartz Ceramics', 'Ridgeway Logistics', 'Sapphire Jewels', 'Trident Marine',
  'Umang Foods', 'Vertex Pharma'
];
const EXISTING_CLIENTS = ['Zenith Textiles', 'Coastal Exports', 'Northline Logistics'];

const domainOf = (name) => name.toLowerCase().replace(/[^a-z]+/g, '') + '.example.com';
const CONTACT_FIRST = ['Rakesh', 'Sunita', 'Vivek', 'Priya', 'Manish', 'Kavita', 'Arjun', 'Neha', 'Suresh', 'Pooja'];
const CONTACT_LAST = ['Agarwal', 'Bhatt', 'Chopra', 'Dave', 'Gandhi', 'Jain', 'Kapoor', 'Malhotra', 'Parekh', 'Trivedi'];

const KEYWORD_RULES = [
  { keyword: 'INVOICE', assigneeEmail: 'u01.aarti@demo.test', autoApprove: true },
  { keyword: 'URGENT', assigneeEmail: 'u02.bhavin@demo.test', autoApprove: false },
  { keyword: 'RENEWAL', assigneeEmail: 'u03.chirag@demo.test', autoApprove: false },
  { keyword: 'COMPLAINT', assigneeEmail: 'u04.deepa@demo.test', autoApprove: false },
  { keyword: 'QUOTATION', assigneeEmail: BASE_USERS.emp, autoApprove: true }
];

const SUBJECT_TEMPLATES = [
  'Invoice #%N for %M shipment',
  'URGENT: delivery delayed for order #%N',
  'Renewal of annual service contract',
  'Quotation request — %M supply',
  'Complaint regarding damaged consignment #%N',
  'Payment remittance advice #%N',
  'Booking confirmation for container #%N',
  'GST credit note query',
  'Revised packing list for order #%N',
  'Follow-up on pending purchase order',
  'Warehouse space availability for %M',
  'Updated bank details for payments',
  'Dispatch schedule for week %W',
  'Rate revision effective next month',
  'Proof of delivery for shipment #%N'
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const BODY_SNIPPETS = [
  'Please find attached the referenced document. Kindly confirm receipt at the earliest.',
  'We would appreciate an update on the current status of this matter.',
  'As discussed on the call, sharing the revised figures for your approval.',
  'The consignment is expected to reach the port by end of week.',
  'Kindly expedite as our production schedule depends on this.',
  'Let us know if any further documentation is required from our side.',
  'Our accounts team has processed the payment; UTR shared below.',
  'Requesting a revised quotation including freight and insurance.'
];

const makeSubject = (i) =>
  pick(SUBJECT_TEMPLATES)
    .replace('%N', String(1000 + (i % 9000)))
    .replace('%M', pick(MONTHS))
    .replace('%W', String(1 + (i % 52)));

// ---------------------------------------------------------------------------
// seed_meta helpers
// ---------------------------------------------------------------------------

const META_ID = 'seedDemoData';
const metaCol = () => mongoose.connection.db.collection('seed_meta');

const loadMeta = async () => (await metaCol().findOne({ _id: META_ID })) || null;
const saveMeta = async (meta) =>
  metaCol().replaceOne({ _id: META_ID }, { _id: META_ID, ...meta }, { upsert: true });

const wipePrevious = async (meta) => {
  if (!meta) return 0;
  const ids = meta.ids || {};
  const oid = (arr) => (arr || []).map((s) => new mongoose.Types.ObjectId(s));
  let removed = 0;
  const rm = async (Model, list) => {
    if (!list || list.length === 0) return;
    const r = await Model.deleteMany({ _id: { $in: oid(list) } });
    removed += r.deletedCount;
  };
  await rm(Email, ids.emails);
  await rm(TaskComment, ids.comments);
  await rm(Notification, ids.notifications);
  await rm(ActivityLog, ids.activitylogs);
  await rm(Task, ids.tasks);
  await rm(KeywordRule, ids.keywordrules);
  await rm(Client, ids.clients);
  await rm(User, ids.users);
  // Revert mailbox linkage on base users.
  for (const email of [BASE_USERS.admin, BASE_USERS.head]) {
    await User.updateOne(
      { email },
      { $set: { gmailEmail: '', gmailAccessToken: null, gmailRefreshToken: null, linkedGmailAccounts: [] } }
    );
  }
  return removed;
};

// Best-effort cache flush so the running API doesn't serve pre-seed numbers.
const flushApiCache = async () => {
  try {
    const Redis = require('ioredis');
    const r = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      lazyConnect: true, maxRetriesPerRequest: 1
    });
    await r.connect();
    const prefix = (process.env.CACHE_PREFIX || 'md') + ':';
    let cursor = '0';
    let n = 0;
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) { await r.del(...keys); n += keys.length; }
    } while (cursor !== '0');
    await r.quit();
    console.log(`cache: flushed ${n} "${prefix}*" keys`);
  } catch (e) {
    console.warn(`cache: flush skipped (${e.message}) — API may serve cached stats for up to 15 min`);
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  const dbName = assertSafeTarget(uri);
  console.log(`target: ${uri} (db "${dbName}")${DRY_RUN ? ' [DRY RUN]' : ''}`);

  await mongoose.connect(uri);

  const prior = await loadMeta();
  if (CLEAN) {
    const removed = await wipePrevious(prior);
    await metaCol().deleteOne({ _id: META_ID });
    await flushApiCache();
    console.log(`clean: removed ${removed} previously seeded documents`);
    await mongoose.disconnect();
    return;
  }

  // Base users must exist — this script augments the known demo workspace.
  const baseUsers = {};
  for (const [k, email] of Object.entries(BASE_USERS)) {
    const u = await User.findOne({ email }).lean();
    if (!u) {
      console.error(`FATAL: base user ${email} not found — wrong database?`);
      process.exit(1);
    }
    baseUsers[k] = u;
  }

  if (DRY_RUN) {
    console.log('plan: ~12 users, ~22 clients, 5 keyword rules, ~800 threads/~2000 emails,');
    console.log('      ~400 tasks, comments/notifications/activity logs in proportion.');
    console.log(`prior seed present: ${prior ? 'yes (would be wiped first)' : 'no'}`);
    await mongoose.disconnect();
    return;
  }

  if (prior) {
    const removed = await wipePrevious(prior);
    console.log(`re-run: wiped ${removed} previously seeded documents first`);
  }

  const ids = { users: [], clients: [], keywordrules: [], emails: [], tasks: [], comments: [], notifications: [], activitylogs: [] };

  // --- users ---------------------------------------------------------------
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const userDocs = NEW_USERS.map((u, i) => ({
    _id: new mongoose.Types.ObjectId(),
    name: u.name,
    email: u.email,
    password: passwordHash,
    role: u.role,
    status: u.status,
    phoneNumber: `+91 98${String(76500000 + i * 137).slice(0, 8)}`,
    lastLoginAt: u.status === 'Approved' ? new Date(NOW - randInt(0, 14) * DAY - randInt(0, 20) * HOUR) : null,
    createdAt: new Date(NOW - randInt(30, WINDOW_DAYS) * DAY)
  }));
  await User.insertMany(userDocs);
  ids.users = userDocs.map((d) => String(d._id));
  const byEmail = Object.fromEntries(userDocs.map((d) => [d.email, d]));
  byEmail[BASE_USERS.admin] = baseUsers.admin;
  byEmail[BASE_USERS.head] = baseUsers.head;
  byEmail[BASE_USERS.emp] = baseUsers.emp;

  // Mailbox linkage. Fake tokens make GET /api/gmail/status list the accounts
  // (the account-filter dropdown source). Side effect: the 10-minute auto-sync
  // cron will try these tokens against Google and fail — harmless log noise on
  // a demo box, called out in the audit doc.
  const primaries = MAILBOXES.filter((m) => m.primary);
  for (const m of primaries) {
    await User.updateOne(
      { email: m.owner },
      { $set: { gmailEmail: m.addr, gmailAccessToken: `seed-fake-token-${m.addr}`, gmailRefreshToken: `seed-fake-refresh-${m.addr}` } }
    );
  }
  const linked = MAILBOXES.filter((m) => !m.primary);
  for (const m of linked) {
    await User.updateOne(
      { email: m.owner },
      { $push: { linkedGmailAccounts: { gmailEmail: m.addr, gmailAccessToken: `seed-fake-token-${m.addr}`, gmailRefreshToken: `seed-fake-refresh-${m.addr}` } } }
    );
  }

  // --- clients -------------------------------------------------------------
  const clientDocs = NEW_CLIENTS.map((name, i) => {
    const dom = domainOf(name);
    const contact = `${pick(CONTACT_FIRST)} ${pick(CONTACT_LAST)}`;
    const emails = [`accounts@${dom}`];
    if (chance(0.7)) emails.push(`${contact.split(' ')[0].toLowerCase()}@${dom}`);
    if (chance(0.3)) emails.push(`dispatch@${dom}`);
    return {
      _id: new mongoose.Types.ObjectId(),
      name,
      associatedEmails: emails,
      contactPerson: contact,
      email: emails[0],
      phone: `+91 79${String(40000000 + i * 911).slice(0, 8)}`,
      notes: 'Seeded demo client',
      status: chance(0.9) ? 'Active' : 'Inactive',
      createdAt: new Date(NOW - randInt(WINDOW_DAYS, WINDOW_DAYS + 200) * DAY)
    };
  });
  await Client.insertMany(clientDocs);
  ids.clients = clientDocs.map((d) => String(d._id));

  // Give the 3 pre-existing clients sender addresses too, so their attribution
  // is exercised. Recorded nowhere destructive: --clean leaves them as-is
  // (addresses are additive and harmless).
  const existingClientDocs = [];
  for (const name of EXISTING_CLIENTS) {
    const dom = domainOf(name);
    const c = await Client.findOneAndUpdate(
      { name },
      { $addToSet: { associatedEmails: { $each: [`accounts@${dom}`, `sales@${dom}`] } } },
      { new: true }
    ).lean();
    if (c) existingClientDocs.push(c);
  }
  const allClients = [...existingClientDocs, ...clientDocs.map((d) => ({ ...d }))];

  // --- keyword rules -------------------------------------------------------
  const ruleDocs = KEYWORD_RULES.map((r) => ({
    _id: new mongoose.Types.ObjectId(),
    keyword: r.keyword,
    assignedTo: byEmail[r.assigneeEmail]._id,
    createdBy: baseUsers.admin._id,
    autoApprove: r.autoApprove,
    isActive: true,
    createdAt: new Date(NOW - randInt(60, WINDOW_DAYS) * DAY)
  }));
  await KeywordRule.insertMany(ruleDocs);
  ids.keywordrules = ruleDocs.map((d) => String(d._id));
  const rulesByKeyword = Object.fromEntries(ruleDocs.map((r, i) => [KEYWORD_RULES[i].keyword, { ...r, autoApprove: KEYWORD_RULES[i].autoApprove }]));

  // --- emails --------------------------------------------------------------
  const employees = [
    byEmail[BASE_USERS.emp],
    ...NEW_USERS.filter((u) => u.role === 'Employee' && u.status === 'Approved').map((u) => byEmail[u.email])
  ];
  const mailboxWeights = [0.35, 0.22, 0.23, 0.20]; // support, sales, billing, ops
  const pickMailbox = () => {
    const r = rand();
    let acc = 0;
    for (let i = 0; i < MAILBOXES.length; i += 1) {
      acc += mailboxWeights[i];
      if (r < acc) return MAILBOXES[i];
    }
    return MAILBOXES[0];
  };
  const threadLen = () => {
    const r = rand();
    if (r < 0.45) return 1;
    if (r < 0.70) return 2;
    if (r < 0.85) return 3;
    if (r < 0.93) return 4;
    if (r < 0.97) return 5;
    return 6;
  };

  const TARGET_EMAILS = 2000;
  const emailDocs = [];
  const assignedInboundByOwner = new Map(); // ownerEmail -> [email docs] for task linking
  let threadIdx = 0;

  while (emailDocs.length < TARGET_EMAILS) {
    threadIdx += 1;
    const mbox = pickMailbox();
    const owner = byEmail[mbox.owner];
    const len = Math.min(threadLen(), TARGET_EMAILS - emailDocs.length);
    const client = chance(0.85) ? pick(allClients) : null;
    const senderAddr = client
      ? pick(client.associatedEmails)
      : `contact${threadIdx}@unattributed-${randInt(1, 40)}.example.net`;
    const senderName = client ? (client.contactPerson || 'Accounts Team') : `${pick(CONTACT_FIRST)} ${pick(CONTACT_LAST)}`;

    // ~20% of threads carry a keyword in the subject.
    let subject = makeSubject(threadIdx);
    let matchedRule = null;
    for (const kw of Object.keys(rulesByKeyword)) {
      if (subject.toUpperCase().includes(kw)) { matchedRule = rulesByKeyword[kw]; break; }
    }

    // Assignment for the thread: rule-driven, or random, or none.
    let assignee = null;
    let approval = 'none';
    let suggested = null;
    if (matchedRule) {
      if (matchedRule.autoApprove) { assignee = { _id: matchedRule.assignedTo }; approval = 'approved'; }
      else if (chance(0.5)) { assignee = { _id: matchedRule.assignedTo }; approval = 'approved'; }
      else { approval = 'pending'; suggested = matchedRule.assignedTo; }
    } else if (chance(0.55)) {
      assignee = pick(employees);
    }

    const startTs = NOW - randInt(1, WINDOW_DAYS) * DAY - randInt(0, 23) * HOUR;
    let ts = startTs;
    const threadId = `seed-t-${threadIdx}`;

    for (let pos = 0; pos < len; pos += 1) {
      // First message inbound; later ones alternate with some randomness but
      // never outbound-first.
      const isOutbound = pos > 0 && (pos % 2 === 1 ? chance(0.75) : chance(0.2));
      const rfc = `<seed-t${threadIdx}-p${pos}@mail.example>`;
      const prevRfcs = [];
      for (let p = 0; p < pos; p += 1) prevRfcs.push(`<seed-t${threadIdx}-p${p}@mail.example>`);
      const bodyText = pick(BODY_SNIPPETS);
      const date = new Date(ts);
      const isRecent = NOW - ts < 7 * DAY;

      const readBy = [];
      if (!isOutbound) {
        if (chance(isRecent ? 0.45 : 0.85)) readBy.push({ user: owner._id, readAt: new Date(ts + randInt(1, 8) * HOUR) });
        if (assignee && chance(isRecent ? 0.4 : 0.75)) readBy.push({ user: assignee._id, readAt: new Date(ts + randInt(2, 24) * HOUR) });
        if (chance(0.25) && String(owner._id) !== String(baseUsers.admin._id)) {
          readBy.push({ user: baseUsers.admin._id, readAt: new Date(ts + randInt(3, 48) * HOUR) });
        }
      } else {
        readBy.push({ user: owner._id, readAt: date });
      }

      const doc = {
        _id: new mongoose.Types.ObjectId(),
        messageId: `seed-m-${threadIdx}-${pos}`,
        threadId,
        rfcMessageId: rfc,
        inReplyTo: pos > 0 ? prevRfcs[pos - 1] : null,
        references: prevRfcs,
        direction: isOutbound ? 'outbound' : 'inbound',
        threadPosition: pos,
        sentBy: isOutbound ? owner._id : null,
        sentAt: isOutbound ? date : null,
        subject: pos === 0 ? subject : `Re: ${subject}`,
        body: `<p>${bodyText}</p><p>Regards,<br/>${isOutbound ? 'MailDesk Team' : senderName}</p>`,
        snippet: bodyText.slice(0, 200),
        from: isOutbound ? mbox.addr : `"${senderName}" <${senderAddr}>`,
        date,
        assignedTo: !isOutbound && assignee ? assignee._id : null,
        status: !isOutbound && assignee ? 'assigned' : 'unassigned',
        fetchedBy: owner._id,
        fetchedAt: new Date(ts + randInt(0, 30) * 60000),
        labelIds: isOutbound ? ['SENT'] : ['INBOX'],
        toEmail: mbox.addr,
        attachments: !isOutbound && chance(0.15)
          ? [{ attachmentId: `seed-att-${threadIdx}-${pos}`, filename: `document-${threadIdx}.pdf`, mimeType: 'application/pdf', size: randInt(20000, 900000) }]
          : [],
        matchedKeyword: !isOutbound && matchedRule ? matchedRule.keyword : null,
        suggestedAssignedTo: !isOutbound && approval === 'pending' ? suggested : null,
        approvalStatus: !isOutbound && matchedRule ? approval : 'none',
        clientId: client ? client._id : null,
        readBy,
        deletedAt: null
      };
      emailDocs.push(doc);

      if (!isOutbound && assignee && pos === 0) {
        const list = assignedInboundByOwner.get(mbox.owner) || [];
        list.push(doc);
        assignedInboundByOwner.set(mbox.owner, list);
      }

      // Replies hours-to-days apart. If the naive step would pass "now",
      // bisect toward now instead — keeps dates strictly ascending AND < now.
      const step = randInt(2, 72) * HOUR;
      ts = ts + step >= NOW ? ts + Math.max(60000, Math.floor((NOW - ts) / 2)) : ts + step;
    }
  }

  // A few soft-deleted emails so the deletedAt filters are exercised.
  for (let i = 0; i < 20 && i < emailDocs.length; i += 1) {
    const d = emailDocs[i * 37 % emailDocs.length];
    if (d.threadPosition === 0 && d.direction === 'inbound' && !d.assignedTo) {
      d.deletedAt = new Date(NOW - randInt(1, 10) * DAY);
      d.deletedBy = baseUsers.admin._id;
    }
  }

  await Email.insertMany(emailDocs, { ordered: false });
  ids.emails = emailDocs.map((d) => String(d._id));

  // --- tasks ---------------------------------------------------------------
  const clientByIdStr = new Map(allClients.map((c) => [String(c._id), c]));
  const taskDocs = [];
  const heads = [byEmail[BASE_USERS.head], byEmail['ops.head@demo.test']];
  const TITLES = [
    'Respond to %C about %S', 'Prepare documents for %C', 'Verify payment from %C',
    'Schedule dispatch for %C', 'Resolve complaint from %C', 'Send revised quote to %C',
    'Reconcile ledger entries for %C', 'Confirm order details with %C'
  ];
  const mkTitle = (clientName, subject) =>
    pick(TITLES).replace('%C', clientName || 'client').replace('%S', (subject || 'their email').slice(0, 40));

  const statusFor = (createdTs) => {
    // A task created in the last ~2 days cannot coherently be Late (its
    // deadline would predate its creation) and one created in the last few
    // hours cannot coherently be Completed — force those to Pending.
    const ageMs = NOW - createdTs;
    const r = rand();
    if (r < 0.55) return ageMs > 6 * HOUR ? 'Completed' : 'Pending';
    if (r < 0.82) return 'Pending';
    return ageMs > 2 * DAY ? 'Late' : 'Pending';
  };

  const buildTask = ({ linkedEmailDoc, createdBy, assignedTo, clientName, createdTs, subject }) => {
    const status = statusFor(createdTs);
    const createdAt = new Date(createdTs);
    let deadline;
    let completedAt = null;
    let overdueNotifiedAt = null;
    if (status === 'Completed') {
      deadline = new Date(createdTs + randInt(2, 10) * DAY);
      completedAt = new Date(Math.max(
        createdTs + 30 * 60000,
        Math.min(createdTs + randInt(4, 200) * HOUR, NOW - HOUR)
      ));
    } else if (status === 'Late') {
      deadline = new Date(Math.max(createdTs + 12 * HOUR, Math.min(createdTs + randInt(1, 5) * DAY, NOW - DAY)));
      overdueNotifiedAt = new Date(deadline.getTime() + randInt(1, 10) * HOUR);
    } else {
      // Pending: deadline strictly in the future so the overdue cron cannot
      // flip counts mid-audit.
      deadline = new Date(NOW + randInt(1, 21) * DAY);
    }
    const isRecurring = !linkedEmailDoc && chance(0.05);
    return {
      _id: new mongoose.Types.ObjectId(),
      title: mkTitle(clientName, subject),
      description: linkedEmailDoc ? `Linked to email: ${subject}` : 'Seeded standalone task',
      linkedEmail: linkedEmailDoc ? linkedEmailDoc._id : null,
      assignedTo,
      clientName: clientName || '',
      deadline,
      status,
      notes: '',
      createdBy,
      priority: pick(['Low', 'Medium', 'Medium', 'High', 'High', 'Urgent']),
      isRecurring,
      recurrence: isRecurring ? pick(['Daily', 'Weekly', 'Monthly']) : null,
      overdueNotifiedAt,
      completedAt,
      firstResponseAt: null,
      createdAt
    };
  };

  // Email-linked tasks: up to 250, distinct linkedEmail (unique index), task
  // fields coherent with the email row.
  let linkedCount = 0;
  for (const [ownerEmail, list] of assignedInboundByOwner.entries()) {
    const creator = byEmail[ownerEmail];
    for (const em of list) {
      if (linkedCount >= 250) break;
      if (chance(0.65)) {
        const clientName = em.clientId ? (clientByIdStr.get(String(em.clientId))?.name || '') : '';
        const t = buildTask({
          linkedEmailDoc: em,
          createdBy: creator._id,
          assignedTo: em.assignedTo,
          clientName,
          createdTs: em.date.getTime() + randInt(1, 6) * HOUR,
          subject: em.subject
        });
        // firstResponseAt: if the thread has an outbound reply, use its date.
        const reply = emailDocs.find((d) => d.threadId === em.threadId && d.direction === 'outbound');
        if (reply) t.firstResponseAt = reply.date;
        taskDocs.push(t);
        linkedCount += 1;
      }
    }
  }

  // Standalone tasks to reach ~400.
  const assignables = [...employees, ...heads];
  while (taskDocs.length < 400) {
    const creator = pick([baseUsers.admin, ...heads]);
    const clientName = chance(0.8) ? pick(allClients).name : '';
    taskDocs.push(buildTask({
      linkedEmailDoc: null,
      createdBy: creator._id,
      assignedTo: pick(assignables)._id,
      clientName,
      createdTs: NOW - randInt(0, WINDOW_DAYS) * DAY - randInt(0, 20) * HOUR,
      subject: null
    }));
  }

  // A couple of recurring parent->child chains.
  const recurring = taskDocs.filter((t) => t.isRecurring).slice(0, 3);
  for (const parent of recurring) {
    if (parent.status === 'Completed') {
      parent.recurrenceSpawnedAt = parent.completedAt;
      const child = { ...parent, _id: new mongoose.Types.ObjectId() };
      child.status = 'Pending';
      child.completedAt = null;
      child.recurrenceSpawnedAt = null;
      child.parentTaskId = parent._id;
      child.createdAt = parent.completedAt;
      child.deadline = new Date(NOW + randInt(2, 14) * DAY);
      child.overdueNotifiedAt = null;
      taskDocs.push(child);
    }
  }

  await Task.insertMany(taskDocs);
  ids.tasks = taskDocs.map((d) => String(d._id));

  // --- comments ------------------------------------------------------------
  const COMMENTS = [
    'Spoke to the client, awaiting confirmation.', 'Documents shared over email.',
    'Blocked on finance approval.', 'Done, please review.', 'Client asked for 2 more days.',
    'Escalating this — no response for a week.', 'Updated the tracker.', 'Will close this today.'
  ];
  const commentDocs = [];
  for (const t of taskDocs) {
    const n = chance(0.5) ? randInt(1, 4) : 0;
    for (let i = 0; i < n; i += 1) {
      const author = pick([t.assignedTo, t.createdBy].filter(Boolean));
      commentDocs.push({
        _id: new mongoose.Types.ObjectId(),
        taskId: t._id,
        author,
        message: pick(COMMENTS),
        createdAt: new Date(t.createdAt.getTime() + randInt(1, 96) * HOUR)
      });
    }
  }
  await TaskComment.insertMany(commentDocs);
  ids.comments = commentDocs.map((d) => String(d._id));

  // --- notifications -------------------------------------------------------
  const notificationDocs = [];
  for (const t of taskDocs) {
    if (t.assignedTo) {
      notificationDocs.push({
        _id: new mongoose.Types.ObjectId(),
        userId: t.assignedTo,
        message: `You have been assigned a new task: ${t.title}`,
        read: chance(0.6),
        taskId: t._id,
        type: 'task_assigned',
        createdAt: t.createdAt
      });
    }
    if (t.status === 'Completed' && t.createdBy && chance(0.7)) {
      notificationDocs.push({
        _id: new mongoose.Types.ObjectId(),
        userId: t.createdBy,
        message: `Task completed: ${t.title}`,
        read: chance(0.5),
        taskId: t._id,
        type: 'task_completed',
        createdAt: t.completedAt
      });
    }
    if (t.status === 'Late' && t.assignedTo) {
      notificationDocs.push({
        _id: new mongoose.Types.ObjectId(),
        userId: t.assignedTo,
        message: `Your task is overdue: ${t.title}`,
        read: chance(0.4),
        taskId: t._id,
        type: 'task_overdue',
        createdAt: t.overdueNotifiedAt
      });
    }
  }
  // Approval notifications to supervisors for pending-approval emails.
  const pendingEmails = emailDocs.filter((d) => d.approvalStatus === 'pending').slice(0, 40);
  for (const em of pendingEmails) {
    notificationDocs.push({
      _id: new mongoose.Types.ObjectId(),
      userId: em.fetchedBy,
      message: `Keyword match "${em.matchedKeyword}" awaits approval: ${em.subject}`,
      read: chance(0.3),
      type: 'email_approval',
      createdAt: em.date
    });
  }
  await Notification.insertMany(notificationDocs);
  ids.notifications = notificationDocs.map((d) => String(d._id));

  // --- activity logs -------------------------------------------------------
  const logDocs = [];
  const approvedUsers = [baseUsers.admin, baseUsers.head, baseUsers.emp,
    ...NEW_USERS.filter((u) => u.status === 'Approved').map((u) => byEmail[u.email])];
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15'
  ];
  for (const u of approvedUsers) {
    const logins = randInt(8, 30);
    for (let i = 0; i < logins; i += 1) {
      logDocs.push({
        _id: new mongoose.Types.ObjectId(),
        userId: u._id,
        action: 'Login',
        details: `User ${u.name || u.email} logged in`,
        ip: `192.168.1.${randInt(2, 250)}`,
        userAgent: pick(UAS),
        targetType: 'User',
        targetId: String(u._id),
        targetLabel: u.email,
        createdAt: new Date(NOW - randInt(0, WINDOW_DAYS) * DAY - randInt(0, 23) * HOUR)
      });
    }
  }
  for (const t of taskDocs) {
    if (!chance(0.8)) continue;
    logDocs.push({
      _id: new mongoose.Types.ObjectId(),
      userId: t.createdBy,
      action: 'Task Creation',
      details: `Created task "${t.title}" (Client: ${t.clientName || 'N/A'})`,
      targetType: 'Task',
      targetId: String(t._id),
      targetLabel: t.title,
      createdAt: t.createdAt
    });
    if (t.status === 'Completed') {
      logDocs.push({
        _id: new mongoose.Types.ObjectId(),
        userId: t.assignedTo || t.createdBy,
        action: 'Task Update',
        details: `Marked task "${t.title}" as Completed`,
        targetType: 'Task',
        targetId: String(t._id),
        targetLabel: t.title,
        before: { status: 'Pending' },
        after: { status: 'Completed' },
        createdAt: t.completedAt
      });
    }
  }
  const outboundSample = emailDocs.filter((d) => d.direction === 'outbound');
  for (const em of outboundSample) {
    if (!chance(0.5)) continue;
    logDocs.push({
      _id: new mongoose.Types.ObjectId(),
      userId: em.sentBy,
      action: 'Email Reply',
      details: `Replied on thread "${em.subject}"`,
      targetType: 'Email',
      targetId: String(em._id),
      targetLabel: em.subject,
      createdAt: em.date
    });
  }
  await ActivityLog.insertMany(logDocs);
  ids.activitylogs = logDocs.map((d) => String(d._id));

  await saveMeta({ ids, seededAt: new Date(), uri: uri.replace(/\/\/[^@]*@/, '//<redacted>@') });
  await flushApiCache();

  // -------------------------------------------------------------------------
  // Verification pass: re-query the database and assert the invariants.
  // -------------------------------------------------------------------------
  console.log('\n--- verification (re-queried from MongoDB) ---');
  const counts = {};
  for (const [name, Model] of Object.entries({
    users: User, clients: Client, emails: Email, tasks: Task,
    comments: TaskComment, notifications: Notification,
    activitylogs: ActivityLog, keywordrules: KeywordRule
  })) {
    counts[name] = await Model.countDocuments({});
  }
  console.log('collection totals:', JSON.stringify(counts));

  const failures = [];
  const check = (label, ok) => { if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`); };

  // Thread coherence.
  const badThreads = await Email.aggregate([
    { $match: { messageId: /^seed-m-/ } },
    { $sort: { threadId: 1, threadPosition: 1 } },
    { $group: {
      _id: '$threadId',
      positions: { $push: '$threadPosition' },
      dates: { $push: '$date' },
      boxes: { $addToSet: '$toEmail' },
      owners: { $addToSet: '$fetchedBy' },
      clientIds: { $addToSet: '$clientId' },
      firstDir: { $first: '$direction' }
    } },
    { $match: { $expr: { $or: [
      { $gt: [{ $size: '$boxes' }, 1] },
      { $gt: [{ $size: '$owners' }, 1] },
      { $gt: [{ $size: '$clientIds' }, 1] },
      { $ne: ['$firstDir', 'inbound'] }
    ] } } },
    { $limit: 5 }
  ]);
  check('threads share mailbox/owner/client and start inbound', badThreads.length === 0);

  const posGap = await Email.aggregate([
    { $match: { messageId: /^seed-m-/ } },
    { $group: { _id: '$threadId', n: { $sum: 1 }, maxPos: { $max: '$threadPosition' }, minDate: { $min: '$date' }, maxDate: { $max: '$date' } } },
    { $match: { $expr: { $ne: ['$maxPos', { $subtract: ['$n', 1] }] } } },
    { $limit: 5 }
  ]);
  check('threadPosition contiguous 0..n-1 per thread', posGap.length === 0);

  // Dates strictly ascend with threadPosition inside every thread.
  const dateOrder = await Email.aggregate([
    { $match: { messageId: /^seed-m-/ } },
    { $sort: { threadId: 1, threadPosition: 1 } },
    { $group: { _id: '$threadId', dates: { $push: '$date' } } },
    { $project: {
      bad: { $anyElementTrue: { $map: {
        input: { $range: [1, { $size: '$dates' }] },
        as: 'i',
        in: { $lte: [{ $arrayElemAt: ['$dates', '$$i'] }, { $arrayElemAt: ['$dates', { $subtract: ['$$i', 1] }] }] }
      } } }
    } },
    { $match: { bad: true } },
    { $limit: 5 }
  ]);
  check('dates strictly ascend within every thread', dateOrder.length === 0);

  const badAssign = await Email.countDocuments({
    messageId: /^seed-m-/, direction: 'inbound',
    $or: [
      { status: 'assigned', assignedTo: null },
      { status: 'unassigned', assignedTo: { $ne: null } }
    ]
  });
  check('email status matches assignedTo', badAssign === 0);

  const badPendingApproval = await Email.countDocuments({
    messageId: /^seed-m-/, approvalStatus: 'pending',
    $or: [{ suggestedAssignedTo: null }, { status: 'assigned' }]
  });
  check('pending-approval emails carry a suggestion and are unassigned', badPendingApproval === 0);

  const badOutbound = await Email.countDocuments({
    messageId: /^seed-m-/, direction: 'outbound',
    $or: [{ sentBy: null }, { sentAt: null }, { status: 'assigned' }]
  });
  check('outbound rows carry sentBy/sentAt and stay unassigned', badOutbound === 0);

  // Task <-> email coherence.
  const linkedTasks = await Task.find({ _id: { $in: taskDocs.map((t) => t._id) }, linkedEmail: { $ne: null } })
    .select('linkedEmail assignedTo clientName').lean();
  const linkedEmails = await Email.find({ _id: { $in: linkedTasks.map((t) => t.linkedEmail) } })
    .select('assignedTo clientId direction').lean();
  const emById = new Map(linkedEmails.map((e) => [String(e._id), e]));
  let taskEmailMismatch = 0;
  for (const t of linkedTasks) {
    const e = emById.get(String(t.linkedEmail));
    if (!e || e.direction !== 'inbound' || String(e.assignedTo) !== String(t.assignedTo)) { taskEmailMismatch += 1; continue; }
    const cname = e.clientId ? (clientByIdStr.get(String(e.clientId))?.name || '') : '';
    if (cname !== t.clientName) taskEmailMismatch += 1;
  }
  check(`linked tasks match their email (assignee+client), n=${linkedTasks.length}`, taskEmailMismatch === 0);

  const pendingPastDeadline = await Task.countDocuments({
    _id: { $in: taskDocs.map((t) => t._id) }, status: 'Pending', deadline: { $ne: null, $lt: new Date() }
  });
  check('no seeded Pending task has a past deadline', pendingPastDeadline === 0);

  const badCompleted = await Task.countDocuments({
    _id: { $in: taskDocs.map((t) => t._id) }, status: 'Completed',
    $or: [{ completedAt: null }, { $expr: { $lt: ['$completedAt', '$createdAt'] } }]
  });
  check('Completed tasks have completedAt >= createdAt', badCompleted === 0);

  // Distribution summary for the audit doc.
  const perBox = await Email.aggregate([
    { $match: { messageId: /^seed-m-/ } },
    { $group: { _id: { box: '$toEmail', dir: '$direction' }, n: { $sum: 1 } } },
    { $sort: { '_id.box': 1, '_id.dir': 1 } }
  ]);
  console.log('emails per mailbox/direction:', JSON.stringify(perBox));
  const taskByStatus = await Task.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  console.log('tasks by status:', JSON.stringify(taskByStatus));
  const approvals = await Email.aggregate([
    { $match: { approvalStatus: { $ne: 'none' } } },
    { $group: { _id: '$approvalStatus', n: { $sum: 1 } } }
  ]);
  console.log('email approval statuses:', JSON.stringify(approvals));

  await mongoose.disconnect();

  if (failures.length > 0) {
    console.error(`\nSEED FAILED VERIFICATION: ${failures.length} invariant(s) violated.`);
    process.exit(2);
  }
  console.log('\nSeed complete and verified.');
};

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
