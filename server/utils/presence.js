/**
 * F-4 — collision detection for the shared mailbox.
 *
 * Two people replying to the same message is the failure this exists to
 * prevent. It is EPHEMERAL PRESENCE, not a record: there is no collection, no
 * document and no audit trail. State lives in Redis when `REDIS_URL` is set and
 * in-process when it is not, matching the degradation policy every other
 * optional-Redis consumer in this codebase follows.
 *
 * Storage shape, per (kind, threadId): a sorted set whose members are the
 * participating sockets and whose score is the entry's expiry timestamp. That
 * gives TTL expiry with one data structure and one read:
 *
 *     ZREMRANGEBYSCORE key -inf <now>     drop what has expired
 *     ZRANGE           key 0 -1           read what is live
 *
 * An entry is removed on disconnect, on an explicit `thread:leave`, and by
 * expiry. A client that closes its laptop lid simply stops heartbeating and
 * ages out within PRESENCE_TTL_SECONDS.
 *
 * AUTHORIZATION. A socket may only join a room for a thread it is allowed to
 * READ, using `utils/emailAccess.emailAccessFilter` — the same rule the thread
 * endpoints enforce. Presence must not become a side channel that reveals a
 * thread exists, or who is working an inbox you cannot see. An unauthorized
 * join and a join for a thread that does not exist produce the SAME response,
 * so the endpoint is not an existence oracle.
 */

const Email = require('../models/Email');
const { getSharedRedis, isRedisConfigured } = require('./redis');
const { emailAccessFilter } = require('./emailAccess');
const { log } = require('./logger');

const logger = log('presence');

const PREFIX = process.env.CACHE_PREFIX || 'md';
// How long an entry survives without a heartbeat. The client should re-emit
// `thread:viewing` at roughly half this interval.
const TTL_SECONDS = Number(process.env.PRESENCE_TTL_SECONDS || 45);
// How often expired entries are swept and a changed roster re-broadcast.
const SWEEP_MS = Number(process.env.PRESENCE_SWEEP_MS || 15000);
// One socket is one reading pane. A handful of tabs is normal; hundreds is an
// attempt to fan a broadcast out across every thread in the workspace.
const MAX_ROOMS_PER_SOCKET = Number(process.env.PRESENCE_MAX_ROOMS_PER_SOCKET || 5);
// Ceiling on a broadcast roster, so one pathological thread cannot produce an
// unbounded payload.
const MAX_PARTICIPANTS = Number(process.env.PRESENCE_MAX_PARTICIPANTS || 25);
// How long a successful authorization is trusted before it is re-checked, so a
// heartbeat every ~20 s does not mean a database query every ~20 s.
const AUTH_TTL_MS = Number(process.env.PRESENCE_AUTH_TTL_MS || 60000);
// Inbound presence events allowed per socket per minute.
const EVENTS_PER_MINUTE = Number(process.env.PRESENCE_EVENTS_PER_MINUTE || 120);

const KINDS = { VIEWING: 'viewing', COMPOSING: 'composing' };

const roomName = (threadId) => `thread:${threadId}`;
const storeKey = (kind, threadId) => `${PREFIX}:presence:${kind}:${threadId}`;

// ---------------------------------------------------------------------------
// Store — Redis when available, an in-process Map otherwise
// ---------------------------------------------------------------------------

// key -> Map<member, expiresAtMs>
const memory = new Map();

// Threads this process currently has at least one local socket in. The sweeper
// only walks these, so a large workspace does not turn into a full keyspace
// scan every SWEEP_MS.
const localRooms = new Map(); // threadId -> Set<socketId>
// Last roster broadcast for a thread, so the sweeper only emits on a change.
const lastBroadcast = new Map(); // threadId -> String

const useRedis = () => isRedisConfigured();

/**
 * A member string uniquely identifies one socket's presence in one room, and
 * carries the payload so a read needs no second round trip. It is stable across
 * heartbeats (`since` does not move), so a re-ZADD updates the score in place
 * rather than creating a duplicate.
 *
 * @param {{socketId: String, userId: String, name: String, since: String}} entry
 * @returns {String}
 */
const encodeMember = (entry) =>
  JSON.stringify([entry.socketId, String(entry.userId), entry.since, entry.name || '']);

/**
 * @param {String} member
 * @returns {{socketId: String, userId: String, since: String, name: String}|null}
 */
const decodeMember = (member) => {
  try {
    const [socketId, userId, since, name] = JSON.parse(member);
    if (!socketId || !userId) return null;
    return { socketId, userId, since, name };
  } catch {
    return null;
  }
};

const memoryBucket = (key) => {
  if (!memory.has(key)) memory.set(key, new Map());
  return memory.get(key);
};

/**
 * Add or refresh one entry.
 * @param {String} kind
 * @param {String} threadId
 * @param {Object} entry
 * @returns {Promise<void>}
 */
const touch = async (kind, threadId, entry) => {
  const key = storeKey(kind, threadId);
  const member = encodeMember(entry);
  const expiresAt = Date.now() + TTL_SECONDS * 1000;

  if (useRedis()) {
    const client = getSharedRedis();
    if (client) {
      try {
        await client.zadd(key, expiresAt, member);
        // A whole-key TTL is a backstop: if every participant vanishes without
        // a clean disconnect, the key still disappears instead of leaking.
        await client.expire(key, TTL_SECONDS * 4);
        return;
      } catch (err) {
        logger.debug({ err: err.message, key }, 'presence write failed; using in-process state');
      }
    }
  }
  memoryBucket(key).set(member, expiresAt);
};

/**
 * Remove one socket's entry.
 * @param {String} kind
 * @param {String} threadId
 * @param {String} socketId
 * @returns {Promise<void>}
 */
const drop = async (kind, threadId, socketId) => {
  const key = storeKey(kind, threadId);
  const owns = (member) => {
    const decoded = decodeMember(member);
    return decoded && decoded.socketId === socketId;
  };

  if (useRedis()) {
    const client = getSharedRedis();
    if (client) {
      try {
        const members = await client.zrange(key, 0, -1);
        const mine = members.filter(owns);
        if (mine.length > 0) await client.zrem(key, ...mine);
        return;
      } catch (err) {
        logger.debug({ err: err.message, key }, 'presence drop failed; using in-process state');
      }
    }
  }
  const bucket = memory.get(key);
  if (!bucket) return;
  for (const member of [...bucket.keys()]) if (owns(member)) bucket.delete(member);
  if (bucket.size === 0) memory.delete(key);
};

/**
 * Live participants for one room, expired entries removed first.
 *
 * De-duplicated BY USER: three tabs is one person, and the roster is a list of
 * people. The earliest `since` wins, so "Priya has been viewing since 14:02"
 * does not reset every time she opens another tab.
 *
 * @param {String} kind
 * @param {String} threadId
 * @returns {Promise<Array<{userId: String, name: String, since: String}>>}
 */
const list = async (kind, threadId) => {
  const key = storeKey(kind, threadId);
  const now = Date.now();
  let members = [];

  if (useRedis()) {
    const client = getSharedRedis();
    if (client) {
      try {
        await client.zremrangebyscore(key, '-inf', now);
        members = await client.zrange(key, 0, MAX_PARTICIPANTS * 4);
      } catch (err) {
        logger.debug({ err: err.message, key }, 'presence read failed; using in-process state');
        members = [];
      }
    }
  }

  if (members.length === 0 && memory.has(key)) {
    const bucket = memory.get(key);
    for (const [member, expiresAt] of [...bucket.entries()]) {
      if (expiresAt <= now) bucket.delete(member);
    }
    if (bucket.size === 0) memory.delete(key);
    else members = [...bucket.keys()];
  }

  const byUser = new Map();
  for (const member of members) {
    const decoded = decodeMember(member);
    if (!decoded) continue;
    const existing = byUser.get(decoded.userId);
    if (!existing || String(decoded.since) < String(existing.since)) {
      byUser.set(decoded.userId, { userId: decoded.userId, name: decoded.name, since: decoded.since });
    }
    if (byUser.size >= MAX_PARTICIPANTS) break;
  }
  return [...byUser.values()];
};

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * May this user read this conversation?
 *
 * Exactly `GET /api/gmail/threads/:threadId`'s rule, expressed as a query so
 * the check costs one indexed `exists` rather than a materialised read.
 *
 * @param {Object} user - socket.data.user
 * @param {String} threadId
 * @returns {Promise<Boolean>}
 */
const mayReadThread = async (user, threadId) => {
  try {
    const found = await Email.exists({ threadId, deletedAt: null, ...emailAccessFilter(user) });
    return Boolean(found);
  } catch (err) {
    // Fail CLOSED. A database blip must not hand out presence on a thread the
    // caller may not read.
    logger.warn({ err: err.message }, 'presence authorization check failed; denying');
    return false;
  }
};

/**
 * Normalise a caller-supplied thread id.
 * @param {*} raw
 * @returns {String|null}
 */
const parseThreadId = (raw) => {
  const value = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.threadId : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  // Control characters in a room name are never legitimate.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
};

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

/**
 * Recompute and emit both rosters for a thread.
 *
 * Emitted to the ROOM, so only sockets that passed the authorization check
 * above ever receive it.
 *
 * @param {Object} io
 * @param {String} threadId
 * @param {Boolean} [onlyIfChanged]
 * @returns {Promise<void>}
 */
const broadcast = async (io, threadId, onlyIfChanged = false) => {
  const [viewers, composers] = await Promise.all([
    list(KINDS.VIEWING, threadId),
    list(KINDS.COMPOSING, threadId)
  ]);

  const signature = JSON.stringify([viewers, composers]);
  if (onlyIfChanged && lastBroadcast.get(threadId) === signature) return;
  lastBroadcast.set(threadId, signature);

  const room = io.to(roomName(threadId));
  room.emit('thread:viewers', { threadId, viewers, count: viewers.length, ttlMs: TTL_SECONDS * 1000 });
  room.emit('thread:composers', {
    threadId,
    composers,
    count: composers.length,
    ttlMs: TTL_SECONDS * 1000
  });
};

// ---------------------------------------------------------------------------
// Socket wiring
// ---------------------------------------------------------------------------

const trackLocal = (threadId, socketId) => {
  if (!localRooms.has(threadId)) localRooms.set(threadId, new Set());
  localRooms.get(threadId).add(socketId);
};

const untrackLocal = (threadId, socketId) => {
  const set = localRooms.get(threadId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) {
    localRooms.delete(threadId);
    lastBroadcast.delete(threadId);
  }
};

/**
 * Per-socket inbound event budget. A presence event is cheap, but "cheap times
 * unbounded" is still a broadcast amplifier.
 *
 * @param {Object} socket
 * @returns {Boolean} true when the event may proceed
 */
const withinBudget = (socket) => {
  const state = socket.data.presence;
  const now = Date.now();
  state.events = state.events.filter((t) => now - t < 60000);
  if (state.events.length >= EVENTS_PER_MINUTE) return false;
  state.events.push(now);
  return true;
};

/**
 * Authorize (with a short-lived per-socket memo) and join the room.
 *
 * @param {Object} socket
 * @param {String} threadId
 * @returns {Promise<Boolean>}
 */
const ensureJoined = async (socket, threadId) => {
  const state = socket.data.presence;
  const memo = state.auth.get(threadId);
  if (memo && memo > Date.now()) return true;

  if (!memo && state.auth.size >= MAX_ROOMS_PER_SOCKET) return false;

  const allowed = await mayReadThread(socket.data.user, threadId);
  if (!allowed) {
    state.auth.delete(threadId);
    return false;
  }

  state.auth.set(threadId, Date.now() + AUTH_TTL_MS);
  socket.join(roomName(threadId));
  trackLocal(threadId, socket.id);
  return true;
};

/**
 * Remove a socket from one thread entirely: both rosters, the room, and the
 * local tracking.
 *
 * @param {Object} io
 * @param {Object} socket
 * @param {String} threadId
 * @returns {Promise<void>}
 */
const leaveThread = async (io, socket, threadId) => {
  await Promise.all([
    drop(KINDS.VIEWING, threadId, socket.id),
    drop(KINDS.COMPOSING, threadId, socket.id)
  ]);
  socket.leave(roomName(threadId));
  socket.data.presence.auth.delete(threadId);
  socket.data.presence.since.delete(threadId);
  // Broadcast BEFORE dropping the local tracking, so the remaining members of
  // the room still get the update from this node.
  await broadcast(io, threadId);
  untrackLocal(threadId, socket.id);
};

/**
 * Attach the F-4 presence handlers to one authenticated socket.
 *
 * The handshake in `index.js` has already verified the JWT and re-checked
 * `status` / `tokenVersion`; this builds on that and never re-implements it.
 *
 * @param {Object} io
 * @param {Object} socket
 * @returns {void}
 */
const registerPresenceHandlers = (io, socket) => {
  const user = socket.data?.user;
  if (!user?._id) return;

  socket.data.presence = {
    auth: new Map(), // threadId -> authorization expiry
    since: new Map(), // threadId -> ISO timestamp of this socket's first join
    events: []
  };

  const identity = () => ({
    socketId: socket.id,
    userId: String(user._id),
    name: user.name || user.email || 'Someone'
  });

  const sinceFor = (threadId) => {
    const state = socket.data.presence;
    if (!state.since.has(threadId)) state.since.set(threadId, new Date().toISOString());
    return state.since.get(threadId);
  };

  /**
   * The single response to "you may not do that". Deliberately identical for a
   * thread that does not exist, a thread on someone else's mailbox, a
   * malformed id and an over-budget socket: presence must not reveal which.
   */
  const deny = (threadId) =>
    socket.emit('thread:presence:denied', { threadId: threadId || null, code: 'NOT_ALLOWED' });

  socket.on('thread:viewing', async (payload) => {
    try {
      if (!withinBudget(socket)) return deny(null);
      const threadId = parseThreadId(payload);
      if (!threadId) return deny(null);
      if (!(await ensureJoined(socket, threadId))) return deny(threadId);

      await touch(KINDS.VIEWING, threadId, { ...identity(), since: sinceFor(threadId) });
      await broadcast(io, threadId);
    } catch (err) {
      logger.debug({ err: err.message }, 'thread:viewing failed');
    }
  });

  socket.on('thread:composing', async (payload) => {
    try {
      if (!withinBudget(socket)) return deny(null);
      const threadId = parseThreadId(payload);
      if (!threadId) return deny(null);
      if (!(await ensureJoined(socket, threadId))) return deny(threadId);

      // `{ composing: false }` is how a client says "I closed the composer"
      // without leaving the thread.
      const composing = !(payload && typeof payload === 'object' && payload.composing === false);

      if (composing) {
        await touch(KINDS.COMPOSING, threadId, { ...identity(), since: sinceFor(threadId) });
        // Composing implies viewing; a client that only ever emits
        // `thread:composing` still shows up as present.
        await touch(KINDS.VIEWING, threadId, { ...identity(), since: sinceFor(threadId) });
      } else {
        await drop(KINDS.COMPOSING, threadId, socket.id);
      }
      await broadcast(io, threadId);
    } catch (err) {
      logger.debug({ err: err.message }, 'thread:composing failed');
    }
  });

  socket.on('thread:leave', async (payload) => {
    try {
      if (!withinBudget(socket)) return;
      const threadId = parseThreadId(payload);
      if (!threadId) return;
      // No authorization check: leaving is always allowed, and a socket that
      // was never in the room simply has nothing to remove.
      await leaveThread(io, socket, threadId);
    } catch (err) {
      logger.debug({ err: err.message }, 'thread:leave failed');
    }
  });

  socket.on('disconnect', async () => {
    try {
      const threads = [...socket.data.presence.auth.keys()];
      for (const threadId of threads) {
        // eslint-disable-next-line no-await-in-loop
        await leaveThread(io, socket, threadId);
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'presence disconnect cleanup failed');
    }
  });
};

let sweeper = null;

/**
 * Sweep expired entries and re-broadcast any roster that changed as a result.
 *
 * Only threads this process has a local socket in are walked. With the Redis
 * adapter every node sweeps its own rooms and reads the same shared state, so a
 * participant that ages out on node A disappears from node B's roster too.
 *
 * @param {Object} io
 * @returns {void}
 */
const startPresenceSweeper = (io) => {
  if (sweeper) return;
  sweeper = setInterval(async () => {
    try {
      for (const threadId of [...localRooms.keys()]) {
        // eslint-disable-next-line no-await-in-loop
        await broadcast(io, threadId, true);
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'presence sweep failed');
    }
  }, SWEEP_MS);
  // Unref'd: an idle presence sweep must never be the reason the process
  // refuses to exit.
  sweeper.unref();
};

/** Stop the sweeper and drop in-process state. Used by graceful shutdown. */
const stopPresence = () => {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  memory.clear();
  localRooms.clear();
  lastBroadcast.clear();
};

module.exports = {
  registerPresenceHandlers,
  startPresenceSweeper,
  stopPresence,
  // Exported for the smoke test and for reuse; not part of the socket contract.
  mayReadThread,
  parseThreadId,
  roomName,
  list,
  KINDS,
  TTL_SECONDS,
  MAX_ROOMS_PER_SOCKET,
  MAX_PARTICIPANTS,
  backend: () => (useRedis() ? 'redis' : 'memory')
};
