/**
 * F-1 — email threading.
 *
 * Gmail hands us a `threadId` on every message and the sync pipeline used to
 * throw it away, so a five-message conversation rendered as five unrelated
 * rows. This module owns everything derived from that id:
 *
 *   - parsing the RFC-822 threading headers off a message,
 *   - keeping `threadPosition` consistent after an insert,
 *   - the ownership scope for a thread read (identical to `GET /emails/:id`),
 *   - the one `$group` stage that turns messages into thread rows, shared by
 *     the thread list and by the SLA pipelines so the two can never disagree
 *     about what "unanswered" means.
 */

const mongoose = require('mongoose');
const Email = require('../models/Email');

/**
 * Coerce an id to a real ObjectId.
 *
 * `req.user` is served from a JSON cache (`user:<id>`), so `req.user._id` is a
 * STRING on a cache hit and an ObjectId on a miss. `find()` casts for you;
 * `aggregate()` does NOT, so an uncoerced id silently matches nothing — a
 * scoped pipeline would return an empty page rather than an error.
 *
 * @param {*} value
 * @returns {Object|null}
 */
const toObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const raw = String(value._id || value);
  return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : null;
};

// A thread read never returns more than this many messages. A conversation
// that long is pathological, and the detail route opts into `body`, so an
// unbounded read here is an OOM in the same way the old list response was.
const THREAD_MESSAGE_CAP = Number(process.env.THREAD_MESSAGE_CAP || 200);

// Ceiling on the participant list carried by a thread row, so one mailing-list
// thread cannot inflate a page of the list response.
const THREAD_PARTICIPANT_CAP = Number(process.env.THREAD_PARTICIPANT_CAP || 12);

/**
 * Split an RFC-822 `References` / `In-Reply-To` header into individual ids.
 * @param {String} header
 * @returns {String[]}
 */
const parseReferences = (header) => {
  if (!header || typeof header !== 'string') return [];
  const found = header.match(/<[^<>\s]+>/g);
  if (found) return [...new Set(found)].slice(0, 50);
  return header
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
};

/**
 * Recompute `threadPosition` for every message in the given threads.
 *
 * Position cannot be assigned correctly at insert time: a sync inserts a whole
 * batch at once, two replicas can insert into the same thread concurrently, and
 * Gmail does not guarantee that we see a conversation in date order. Deriving
 * the position from `date` after the write is the only stable answer, and it is
 * idempotent, so re-running it is free.
 *
 * Bounded work: one indexed read plus one bulkWrite per thread, and only for
 * threads that were actually touched.
 *
 * @param {String[]} threadIds
 * @returns {Promise<Number>} number of documents whose position changed
 */
const resyncThreadPositions = async (threadIds) => {
  const ids = [...new Set((threadIds || []).filter(Boolean))];
  if (ids.length === 0) return 0;

  let changed = 0;

  for (const threadId of ids) {
    // eslint-disable-next-line no-await-in-loop
    const messages = await Email.find({ threadId })
      .select('_id threadPosition')
      .sort({ date: 1, _id: 1 })
      .limit(THREAD_MESSAGE_CAP)
      .lean();

    const operations = [];
    messages.forEach((message, index) => {
      if (message.threadPosition === index) return;
      operations.push({
        updateOne: { filter: { _id: message._id }, update: { $set: { threadPosition: index } } }
      });
    });

    if (operations.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await Email.bulkWrite(operations, { ordered: false });
      changed += operations.length;
    }
  }

  return changed;
};

/**
 * The ownership scope for any thread read.
 *
 * Identical to the rule `canAccessEmail` enforces on `GET /emails/:id`:
 * Admin sees everything, a Head only the mailboxes they fetched, an Employee
 * only what is assigned to them. Returned as a filter so the scope is applied
 * INSIDE the aggregation, never as a post-filter over an already-materialised
 * page — a Head must not be able to page through an inbox they do not own even
 * for the duration of one pipeline stage.
 *
 * @param {Object} user - req.user
 * @returns {Object} mongo filter fragment
 */
const threadScopeFilter = (user) => {
  if (!user) return { _id: null };
  if (user.role === 'Admin') return {};
  const id = toObjectId(user._id);
  if (!id) return { _id: null };
  if (user.role === 'Head') return { fetchedBy: id };
  return { assignedTo: id };
};

/**
 * A stable cache discriminator for a thread/SLA read.
 *
 * The trap this exists for has already bitten this codebase once: a Head's
 * narrowed slice served to an Admin (or the reverse) for the whole TTL. The
 * scope is therefore part of every cache key, never just the endpoint name.
 *
 * @param {Object} user
 * @returns {String}
 */
const scopeDiscriminator = (user) =>
  user.role === 'Admin' ? 'all' : `${user.role}:${String(user._id)}`;

/**
 * The `$group` stage that collapses messages into one row per thread.
 *
 * Shared by the thread list and by the SLA backlog pipeline. Everything the
 * two need is derived here so "unanswered" cannot mean two different things on
 * two screens.
 *
 * `hasUnansweredInbound` is derived as `lastOutboundAt < lastInboundAt` (or no
 * outbound at all) rather than from the last message's direction, because a
 * thread whose newest message is an automated outbound bounce is still
 * answered, and a thread that received two follow-ups after our reply is not.
 *
 * @param {Object} userId - the CALLER's ObjectId, for the unread count
 * @returns {Object} a $group stage
 */
const threadGroupStage = (rawUserId) => ({
  $group: {
    _id: '$threadId',
    subject: { $first: '$subject' },
    participants: { $addToSet: '$from' },
    messageCount: { $sum: 1 },
    inboundCount: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 0, 1] } },
    outboundCount: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
    // Unread is a per-user relation on a shared mailbox (WAVE2 gap S-16), so
    // the count is computed for the CALLER, never stored on the document.
    unreadCount: {
      $sum: {
        $cond: [{ $in: [toObjectId(rawUserId), { $ifNull: ['$readBy.user', []] }] }, 0, 1]
      }
    },
    firstMessageAt: { $min: '$date' },
    lastMessageAt: { $max: '$date' },
    firstInboundAt: { $min: { $cond: [{ $eq: ['$direction', 'outbound'] }, null, '$date'] } },
    lastInboundAt: { $max: { $cond: [{ $eq: ['$direction', 'outbound'] }, null, '$date'] } },
    firstOutboundAt: { $min: { $cond: [{ $eq: ['$direction', 'outbound'] }, '$date', null] } },
    lastOutboundAt: { $max: { $cond: [{ $eq: ['$direction', 'outbound'] }, '$date', null] } },
    clientId: { $max: '$clientId' },
    accountEmail: { $max: '$toEmail' },
    // Mongo 5.2+. The newest message supplies the row's snippet and subject.
    latest: {
      $top: {
        sortBy: { date: -1, _id: -1 },
        output: {
          _id: '$_id',
          subject: '$subject',
          snippet: '$snippet',
          from: '$from',
          date: '$date',
          direction: '$direction'
        }
      }
    }
  }
});

/**
 * Shape a grouped thread row into the documented list response.
 * @param {Object} row - output of threadGroupStage
 * @returns {Object}
 */
const projectThreadStage = () => ({
  $project: {
    _id: 0,
    threadId: '$_id',
    // The newest message's subject: a conversation is identified by what it has
    // become, not by what it was opened as.
    subject: { $ifNull: ['$latest.subject', '$subject'] },
    participants: { $slice: ['$participants', THREAD_PARTICIPANT_CAP] },
    messageCount: 1,
    inboundCount: 1,
    outboundCount: 1,
    unreadCount: 1,
    firstMessageAt: 1,
    lastMessageAt: 1,
    firstInboundAt: 1,
    lastInboundAt: 1,
    firstOutboundAt: 1,
    lastOutboundAt: 1,
    lastDirection: { $ifNull: ['$latest.direction', 'inbound'] },
    // NEVER a body. API-LIST-CONTRACT.md rule 1 applies to thread rows too.
    snippet: { $ifNull: ['$latest.snippet', ''] },
    latestFrom: { $ifNull: ['$latest.from', ''] },
    latestEmailId: '$latest._id',
    clientId: 1,
    accountEmail: 1,
    hasUnansweredInbound: {
      $and: [
        { $ne: ['$lastInboundAt', null] },
        {
          $or: [
            { $eq: ['$lastOutboundAt', null] },
            { $lt: ['$lastOutboundAt', '$lastInboundAt'] }
          ]
        }
      ]
    }
  }
});

// Sortable fields for GET /api/gmail/threads (API-LIST-CONTRACT.md).
const THREAD_SORT_FIELDS = ['lastMessageAt', 'firstMessageAt', 'messageCount', 'unreadCount', 'subject'];

module.exports = {
  toObjectId,
  parseReferences,
  resyncThreadPositions,
  threadScopeFilter,
  scopeDiscriminator,
  threadGroupStage,
  projectThreadStage,
  THREAD_SORT_FIELDS,
  THREAD_MESSAGE_CAP,
  THREAD_PARTICIPANT_CAP
};
