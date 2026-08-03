const Task = require('../models/Task');
const Client = require('../models/Client');
const { parseDeadline } = require('./dateHelper');
const cache = require('./cache');
const { log } = require('./logger');

const logger = log('task-helper');

// Label used when an email's sender matches no known client.
const UNASSIGNED_CLIENT = 'Unassigned';

/**
 * Extract the bare address from a `Name <addr@example.com>` header value.
 * @param {String} from
 * @returns {String} lowercased address, or '' when none can be parsed
 */
const extractEmailAddress = (from) => {
  const value = String(from || '').trim();
  if (!value) return '';
  const angled = value.match(/<([^>]+)>/);
  const candidate = angled ? angled[1] : value;
  const match = candidate.match(/[^\s<>@]+@[^\s<>@,;]+/);
  return match ? match[0].toLowerCase().trim() : '';
};

/**
 * Sender-address -> client lookup table, cached for 10 minutes.
 *
 * This used to be `Client.find({})` — no projection, no lean, no limit — run
 * once PER EMAIL. A 150-message sync where 40 emails matched an auto-approve
 * rule loaded the entire Client collection 40 times; `bulkApproveEmails` over
 * 500 pending emails loaded it 500 times.
 *
 * The cached value is a plain array of pairs so it survives JSON serialisation
 * into Redis.
 *
 * @returns {Promise<Map<String, {id: String, name: String}>>}
 */
const getClientMatcher = async () => {
  const pairs = await cache.wrap(cache.KEYS.clientMatcher(), cache.TTL.clients, async () => {
    const clients = await Client.find({}).select('name email associatedEmails').lean();
    const entries = [];
    for (const client of clients) {
      for (const address of [client.email, ...(client.associatedEmails || [])]) {
        if (!address) continue;
        entries.push([String(address).toLowerCase().trim(), { id: String(client._id), name: client.name }]);
      }
    }
    return entries;
  });

  return new Map(pairs);
};

/**
 * Resolve an email sender to a known client.
 *
 * Matching is an EXACT address comparison, not `String.includes` — the old
 * behaviour matched "a@b.c" inside "not-a@b.co.uk". An unmatched sender is left
 * explicitly unattributed rather than falling back to `clients[0].name`.
 *
 * @param {String} from - raw From header value
 * @param {Map} [matcher] - a pre-built matcher, to avoid a cache read per email
 * @returns {Promise<{clientId: String|null, clientName: String}>}
 */
const resolveClientForSender = async (from, matcher = null) => {
  const address = extractEmailAddress(from);
  if (!address) return { clientId: null, clientName: UNASSIGNED_CLIENT };

  const table = matcher || (await getClientMatcher());
  const hit = table.get(address);
  return hit ? { clientId: hit.id, clientName: hit.name } : { clientId: null, clientName: UNASSIGNED_CLIENT };
};

/**
 * Build the Task document body for an email, without writing anything.
 * @param {Object} email
 * @param {String} assignedUserId
 * @param {String} createdById
 * @param {Map} [matcher]
 * @returns {Promise<Object>}
 */
const buildTaskForEmail = async (email, assignedUserId, createdById, matcher = null) => {
  const { clientName } = await resolveClientForSender(email.from, matcher);

  // Default deadline: 3 days out, end of the business day in APP_TIMEZONE.
  const threeDaysOut = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const deadline = parseDeadline(threeDaysOut.toISOString().slice(0, 10)) || threeDaysOut;

  const title =
    email.subject && String(email.subject).trim()
      ? String(email.subject).trim()
      : `Task from Email [${email.matchedKeyword || 'Mail'}]`;

  return {
    title,
    // Derived from the pre-computed snippet, never from the raw body: running
    // `.replace(/<[^>]*>/g, ' ')` over a multi-megabyte base64-laden body was
    // 10-200 ms of blocked event loop per email.
    description: email.snippet ? String(email.snippet).slice(0, 1000) : '',
    clientName,
    deadline,
    priority: 'Medium',
    createdBy: createdById || email.fetchedBy || assignedUserId,
    // Applied via $set (not $setOnInsert) so a re-assignment updates an
    // existing task too.
    assignedTo: assignedUserId,
    status: 'Pending'
  };
};

/**
 * Split a built task body into the `$set` and `$setOnInsert` halves of an
 * upsert. A field may appear in only one of the two.
 * @param {Object} doc
 * @param {Object} emailId
 * @returns {{set: Object, setOnInsert: Object}}
 */
const splitUpsert = (doc, emailId) => {
  const { assignedTo, status, ...insertOnly } = doc;
  return {
    set: { assignedTo, status },
    setOnInsert: { ...insertOnly, linkedEmail: emailId }
  };
};

/**
 * Ensure exactly one Task exists for an assigned email.
 *
 * Implemented as a single atomic upsert. The previous check-then-act
 * (`findOne` then `new Task().save()`) is a classic race: two concurrent syncs,
 * or two replicas running the same cron tick, both saw "no task" and both
 * created one. The unique partial index on `Task.linkedEmail` is the backstop
 * that makes this correct even under contention.
 *
 * @param {Object} email - Email document or lean object
 * @param {String} assignedUserId
 * @param {String} createdById
 * @param {Map} [matcher] - pre-built client matcher for bulk paths
 * @returns {Promise<Object|null>} the task
 */
const ensureTaskForEmail = async (email, assignedUserId, createdById, matcher = null) => {
  if (!email || !assignedUserId) return null;

  try {
    const doc = await buildTaskForEmail(email, assignedUserId, createdById, matcher);
    const { set, setOnInsert } = splitUpsert(doc, email._id);

    return await Task.findOneAndUpdate(
      { linkedEmail: email._id },
      { $set: set, $setOnInsert: setOnInsert },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  } catch (err) {
    // A duplicate key means another writer won the upsert race; the task
    // exists, which is exactly the desired end state.
    if (err && err.code === 11000) {
      return Task.findOne({ linkedEmail: email._id }).lean();
    }
    logger.error({ err: err.message, emailId: String(email._id) }, 'failed to create/update task for email');
    return null;
  }
};

/**
 * Bulk variant used by the sync worker and the keyword bulk-approve path.
 * Builds every document up front and issues ONE bulkWrite instead of 2N
 * sequential round-trips.
 *
 * @param {Array<Object>} pairs - [{ email, assignedUserId, createdById }]
 * @returns {Promise<Number>} number of tasks created or updated
 */
const ensureTasksForEmails = async (pairs) => {
  const valid = (pairs || []).filter((p) => p && p.email && p.assignedUserId);
  if (valid.length === 0) return 0;

  const matcher = await getClientMatcher();
  const operations = [];

  for (const { email, assignedUserId, createdById } of valid) {
    const doc = await buildTaskForEmail(email, assignedUserId, createdById, matcher);
    const { set, setOnInsert } = splitUpsert(doc, email._id);
    operations.push({
      updateOne: {
        filter: { linkedEmail: email._id },
        update: { $set: set, $setOnInsert: setOnInsert },
        upsert: true
      }
    });
  }

  try {
    const result = await Task.bulkWrite(operations, { ordered: false });
    return (result.upsertedCount || 0) + (result.modifiedCount || 0);
  } catch (err) {
    // Duplicate keys are benign here (another writer created the same task).
    if (err && (err.code === 11000 || err.writeErrors)) return operations.length;
    logger.error({ err: err.message, count: operations.length }, 'bulk task upsert failed');
    return 0;
  }
};

module.exports = {
  ensureTaskForEmail,
  ensureTasksForEmails,
  extractEmailAddress,
  getClientMatcher,
  resolveClientForSender,
  UNASSIGNED_CLIENT
};
