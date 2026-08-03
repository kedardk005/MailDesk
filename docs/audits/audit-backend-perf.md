# MailDesk Backend — Performance & Scalability Audit

**Scope:** every file under `server/` (43 JS files: controllers, models, routes, middleware, utils, config, index.js, seeders, scripts).
**Stack:** Node.js + Express 5.2 + Mongoose 9.6 + MongoDB + Socket.io 4.8 + googleapis 173 + nodemailer 8 + node-cron 4.2 + @google/generative-ai 0.24.
**Verdict:** the app is architected as a single-instance, single-tenant prototype. There is **zero caching**, **zero pagination on every list endpoint**, **zero background job infrastructure**, and the Gmail sync runs fully inline inside HTTP requests. It will fall over at roughly 2–5k emails / 20 concurrent users.

---

## Executive summary — counts

| Dimension | State |
|---|---|
| Caching layers (Redis / in-proc / HTTP `Cache-Control`) | **0** |
| List endpoints with pagination | **0 of 11** |
| Background job queue (BullMQ/Agenda/etc.) | **0** — Gmail sync, email send, AI all inline |
| Mongoose schema fields queried/sorted with no index | **17** |
| Confirmed N+1 loops | **11** |
| `.lean()` usages | **0** |
| Outbound HTTP calls with a timeout | **0** (Gmail, Gemini, SMTP) |
| Retry / backoff / circuit breaker | **0** |
| `compression` middleware | absent |
| Graceful shutdown | absent |
| Socket.io horizontal-scale adapter | absent |
| Rate-limit store | in-memory (per-instance) |
| Mongo connection pool tuning | absent (`mongoose.connect(uri)` with no options) |

---

# 1. CACHING

### C-1. There is no caching layer of any kind
**Severity: CRITICAL**
**Files:** entire `server/` tree — verified absent in `server/package.json:15-32` (no `redis`, `ioredis`, `node-cache`, `lru-cache`, `apicache`, `compression`), `server/index.js:36-52` (middleware stack).

**What's wrong.** The full middleware stack is:
```js
// server/index.js:37-46
app.use(helmet());
app.use(cors({ origin: ... }));
app.use(express.json());
app.use((req,res,next) => { /* mongo sanitize */ next(); });
```
No `Cache-Control`, no `Last-Modified`, no `res.set('ETag', ...)` anywhere. Express's default weak ETag *is* on, but it is computed **after** the handler has already run the full DB query and serialized the body — so a 304 still costs 100% of the server work. It saves bandwidth only, and only if the client revalidates (axios in `client/src/pages/EmailInbox.jsx:345` sends no `If-None-Match`).

**Why it hurts at scale.** Every dashboard/inbox poll re-executes the full aggregation path. `GET /api/reports/overall` alone issues 8 sequential `countDocuments` per call (see C-3). With 20 Admin/Head users on a dashboard refreshing every 30s that is 320 full-collection counts per minute against MongoDB.

**Fix.** Add Redis (`ioredis`) + a thin cache-aside helper:
```js
// server/utils/cache.js
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });

exports.cached = async (key, ttlSec, producer) => {
  const hit = await redis.get(key).catch(() => null);
  if (hit) return JSON.parse(hit);
  const val = await producer();
  redis.setex(key, ttlSec, JSON.stringify(val)).catch(() => {});
  return val;
};
exports.bust = (...keys) => redis.del(...keys).catch(() => {});
exports.bustPrefix = async (prefix) => {
  const stream = redis.scanStream({ match: `${prefix}*`, count: 200 });
  for await (const keys of stream) if (keys.length) await redis.del(...keys);
};
```

**Concrete cache plan:**

| Endpoint | Key | TTL | Invalidate on |
|---|---|---|---|
| `GET /api/reports/overall` (`reportsController.js:88`) | `stats:overall:${role}:${userId||'all'}` | 60s | Task create/update/delete, Email insert/delete, User create/delete |
| `GET /api/reports/timeline` (`:126`) | `stats:timeline:${userId||'all'}` | 300s | Task insert |
| `GET /api/reports/email-timeline` (`:232`) | `stats:emailtl:${userId||'all'}:${days}` | 300s | Email insert |
| `GET /api/reports/client-stats` (`:184`) | `stats:clients` | 600s | Client CRUD, Task insert, Email insert |
| `GET /api/reports/employee` (`:9`) | `stats:employee:${filter}:${userId||'all'}` | 120s | Task status change |
| `GET /api/clients` (`clientController.js:10`) | `clients:list` | 300s | Client CRUD |
| `GET /api/keyword-rules` (`keywordRuleController.js:13`) | `krules:list` | 300s | rule CRUD |
| **Active keyword rules used inside sync** (`gmailController.js:394`) | `krules:active` | 60s | rule create/update/delete |
| `GET /api/users` (`userController.js:14`) | `users:list` | 120s | user CRUD |
| Auth user lookup (see C-2) | `user:${id}` | 60s | `tokenVersion` bump, user update/delete |

Also set HTTP headers on the report routes so the browser stops re-asking:
```js
res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
```

---

### C-2. Every authenticated request does an uncached `User.findById` (full document)
**Severity: HIGH**
**File:** `server/middleware/authMiddleware.js:23`, `server/index.js:150`

```js
// authMiddleware.js:23
req.user = await User.findById(decoded.id).select('-password');
```

**What's wrong.** One extra DB round-trip **per API request**, returning a hydrated Mongoose document (not `.lean()`), including `allowedGmailAccounts`, `maxConnectedAccounts`, `birthdate`, etc. that almost no handler needs. `server/index.js:150` repeats the same query for every socket handshake.

**Why it hurts at scale.** At 300 req/15min/IP (the configured cap, `index.js:30`) × 50 users that is ~1000 extra `findById` per minute plus 1000 Mongoose document hydrations (~5–10× slower than `.lean()`). Under load this is typically 15–25% of total request latency and doubles the connection-pool checkout rate.

**Fix.**
```js
const { cached, bust } = require('../utils/cache');
const user = await cached(`user:${decoded.id}`, 60, () =>
  User.findById(decoded.id).select('_id name email role status tokenVersion').lean()
);
if (!user || decoded.tokenVersion !== user.tokenVersion) return res.status(401)...
req.user = user;   // note: req.user._id becomes a string — see note below
```
Because the JWT already carries `tokenVersion` (`authController.js:14`), invalidation is trivial: call `bust('user:' + id)` in `changePassword` (`userController.js:374`), `forgotPassword` (`authController.js:191`), `updateUser` (`userController.js:212`) and `deleteUser` (`userController.js:265`).
Caveat: `req.user._id` is used with `.toString()` in ~30 places — with `.lean()` it is an `ObjectId`, so `.toString()` still works. Verify `req.user.name` is still populated (used at `taskController.js:176`, `commentController.js:83`).

---

### C-3. `GET /api/reports/overall` runs 8 sequential `countDocuments` with no cache
**Severity: HIGH**
**File:** `server/controllers/reportsController.js:98-105`

```js
const totalUsers   = await User.countDocuments({});
const totalEmails  = await Email.countDocuments(emailQuery);
const totalTasks   = await Task.countDocuments(taskQuery);
const totalPending   = await Task.countDocuments({ ...taskQuery, status: 'Pending' });
const totalCompleted = await Task.countDocuments({ ...taskQuery, status: 'Completed' });
const totalLate      = await Task.countDocuments({ ...taskQuery, status: 'Late' });
const totalUnassignedEmails = await Email.countDocuments({ ...emailQuery, status: 'unassigned' });
const totalClients = await Client.countDocuments({});
```

**What's wrong.** Eight `await`s in series, none parallelised, none cached. `Email.countDocuments({})` is a **full collection scan** (MongoDB's `countDocuments` cannot use the metadata fast path; only `estimatedDocumentCount()` can). For `Head` users the counts add `fetchedBy`/`createdBy` filters which *are* indexed, but the three Task status counts are separate index scans that could be one `$group`.

**Why it hurts at scale.** At 100k emails, `countDocuments({})` reads 100k index entries ≈ 80–200ms. Times 8 sequential = ~0.5–1.5s per dashboard load, per user, every poll.

**Fix.** One aggregation with `$facet` + cache:
```js
const [taskAgg] = await Task.aggregate([
  { $match: taskQuery },
  { $facet: {
      total:   [{ $count: 'n' }],
      byStatus:[{ $group: { _id: '$status', n: { $sum: 1 } } }]
  }}
]);
const [emailAgg] = await Email.aggregate([
  { $match: emailQuery },
  { $facet: {
      total:      [{ $count: 'n' }],
      unassigned: [{ $match: { status: 'unassigned' } }, { $count: 'n' }]
  }}
]);
const [totalUsers, totalClients] = await Promise.all([
  User.estimatedDocumentCount(), Client.estimatedDocumentCount()
]);
```
8 sequential round-trips → 3 parallel. Then wrap the whole thing in `cached('stats:overall:...', 60, ...)`.

---

### C-4. `GET /api/gmail/status` runs a **workspace-wide write-capable scan** on every poll
**Severity: CRITICAL**
**File:** `server/controllers/gmailController.js:630-633`, `:814-864`

```js
exports.getConnectedStatus = async (req, res) => {
  await deduplicateConnections();          // <-- line 633
  ...
};
// deduplicateConnections, line 816:
const users = await User.find({}).select('+gmailAccessToken +gmailRefreshToken +linkedGmailAccounts');
for (const u of users) { ... if (modified) await u.save(); }   // line 858
```

**What's wrong.** A **GET status check** loads *every user in the database* with their encrypted OAuth tokens and linked-account subdocuments, iterates them in JS, and may issue an unbounded number of individual `save()` writes. It is also called on the OAuth callback path (`:284`). This is not a read endpoint — it is a full-table maintenance job masquerading as one.

**Why it hurts at scale.** At 500 users with 5 linked accounts each, one `/api/gmail/status` call transfers ~500 documents with ~2500 token strings (each encrypted token ≈ 400 bytes) ≈ 1–2 MB out of Mongo, hydrates 500 Mongoose docs, and holds a pool connection for hundreds of ms. The frontend polls this on inbox mount. Two users polling simultaneously can also race and both "clear" the same duplicate, corrupting a valid connection.

**Fix.**
1. Delete the call at `:633` entirely — `getConnectedStatus` must be read-only.
2. Move `deduplicateConnections` into a scheduled job (see Q-4) running once a day, and use `bulkWrite` instead of per-user `save()`.
3. Enforce uniqueness at the schema level instead so dedup is unnecessary:
   `UserSchema.index({ gmailEmail: 1 }, { unique: true, partialFilterExpression: { gmailEmail: { $type: 'string', $ne: '' } } })`.

---

### C-5. Gmail access tokens are re-decrypted and OAuth clients re-created per sync; no token cache
**Severity: MEDIUM**
**File:** `server/controllers/gmailController.js:296-316`, `:455-456`, `:468-469`

Every `syncAccountEmails` builds a fresh `google.auth.OAuth2` and calls `decrypt()` (AES-256-GCM, `tokenCrypto.js:44`) on both tokens. Worse, the `tokens` refresh listener (`:301-316`) calls `await user.save()` — writing **the entire user document including all linked accounts** — on every silent refresh, and it is registered *inside a loop over accounts* so N listeners accumulate on the same `user` object across the sync.

**Fix.** Cache the live access token in Redis keyed `gmail:tok:${gmailEmail}` with TTL = `expiry_date - now - 60s`; in the refresh handler use a targeted positional update instead of a whole-document save:
```js
await User.updateOne(
  { _id: user._id, 'linkedGmailAccounts.gmailEmail': inboxEmail },
  { $set: { 'linkedGmailAccounts.$.gmailAccessToken': encrypt(newTokens.access_token) } }
);
```

---

### C-6. `KeywordRule.find({ isActive: true })` is executed once per Gmail message
**Severity: HIGH**
**File:** `server/controllers/gmailController.js:394` (inside the `for (const message of messages)` loop opened at `:336`)

```js
for (const message of messages) {
  ...
  const activeRules = await KeywordRule.find({ isActive: true });   // line 394
```

**What's wrong.** The rule set is static for the whole sync but is fetched from Mongo for every single message.

**Why it hurts at scale.** `maxResults: 150` (`:322`) × N accounts × every 10 minutes (`cronJobs.js:74`). With 20 connected accounts that is 3,000 identical queries every 10 minutes = 18,000/hour, plus 150 × N `new RegExp()` compilations per sync.

**Fix.** Hoist it out of the loop and cache it:
```js
const activeRules = await cached('krules:active', 60, () =>
  KeywordRule.find({ isActive: true }).select('keyword assignedTo autoApprove').lean()
);
const compiled = activeRules.map(r => ({ ...r, re: new RegExp(`\\b${escapeRegex(r.keyword)}\\b`, 'i') }));
// then inside the loop just test compiled[i].re
```
Bust `krules:active` in `createKeywordRule` (`keywordRuleController.js:60`), `updateKeywordRule` (`:129`), `deleteKeywordRule` (`:151`).

---

# 2. PAGINATION

**Every list endpoint in the application returns an unbounded array.** The recent commit `b44c81d "add inbox pagination"` added *client-side* slicing only — `client/src/pages/EmailInbox.jsx:345` still calls `api.get('/gmail/emails')` with no `page`/`limit`, so the server ships the entire collection and the browser paginates it.

### P-1. `GET /api/gmail/emails` returns every email **including full HTML bodies with base64-inlined images**
**Severity: CRITICAL** — this is the single worst finding in the audit.
**File:** `server/controllers/gmailController.js:572-575`

```js
const emails = await Email.find(query)
  .populate('assignedTo', 'name email')
  .populate('fetchedBy', 'name email gmailEmail')
  .sort({ date: -1 });
```

**What's wrong.** No `.limit()`, no `.skip()`, no `.select()`, no `.lean()`. And critically — the `body` field is not a normal email body. During sync, every inline image is downloaded and **spliced into the HTML as a base64 `data:` URI**:
```js
// gmailController.js:376-379
const dataUrl = `data:${img.mimeType};base64,${standardBase64}`;
decodedBody = decodedBody.replace(regex, dataUrl);
```
A 200 KB logo becomes ~267 KB of text inside `Email.body`.

**Why it hurts at scale.** Measured conservatively at 60 KB average body (one small logo + signature graphics):
- 10,000 emails → **~600 MB** streamed from Mongo, hydrated into 10,000 Mongoose documents, `JSON.stringify`'d into one response buffer, and sent over the wire. Node's default old-space heap is ~1.5–4 GB; a *single* such request OOM-crashes the process, and the `uncaughtException` handler at `index.js:120` does **not** exit, leaving a zombie.
- Even at 1,000 emails (~60 MB) the `JSON.stringify` alone blocks the event loop for ~300–600 ms, stalling every other request and every socket heartbeat.
- Secondary risk: an email with several large inline images can exceed MongoDB's **16 MB document limit** and silently fail to save at `:435`.

**Fix.** Offset pagination is acceptable here since sorting is on an indexed `date` and users jump pages; cursor (keyset) is better for infinite scroll.
```js
const limit = Math.min(parseInt(req.query.limit) || 25, 100);
const page  = Math.max(parseInt(req.query.page) || 1, 1);

const [items, total] = await Promise.all([
  Email.find(query)
    .select('subject from date status assignedTo fetchedBy toEmail matchedKeyword approvalStatus attachments.filename attachments.size labelIds')  // NO body
    .populate('assignedTo', 'name email')
    .populate('fetchedBy', 'name email gmailEmail')
    .sort({ date: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean(),
  Email.countDocuments(query)
]);
res.json({ items, page, limit, total, pages: Math.ceil(total / limit) });
```
Then add a dedicated `GET /api/gmail/emails/:id` that returns the `body` for the one email the user opened. Better still: stop inlining images into `body` — store attachments in S3/GridFS and serve `cid:` via the existing `downloadAttachment` route (`:1062`).

Keyset variant for infinite scroll:
```js
if (req.query.cursor) query.date = { $lt: new Date(req.query.cursor) };
// ... .sort({ date: -1 }).limit(limit)   → return nextCursor = items.at(-1).date
```

---

### P-2. `GET /api/tasks` unbounded, and `populate`s the email `body` of every task
**Severity: CRITICAL**
**File:** `server/controllers/taskController.js:89-93`

```js
const tasks = await Task.find(query)
  .populate('assignedTo', 'name email')
  .populate('linkedEmail', 'subject from body attachments')   // <-- body
  .populate('createdBy', 'name')
  .sort({ createdAt: -1 });
```
Same pathology as P-1: `body` carries base64 images. Admin sees **all** tasks. At 5,000 tasks each with a linked email, this is ~300 MB and 3 populate round-trips (`$in` queries with 5,000 ids each).

**Fix:** paginate (offset, page size 25), drop `body` from the populate (`'subject from attachments'`), add `.lean()`, and add the compound index `{ assignedTo: 1, createdAt: -1 }` (see D-3). Add a separate `GET /api/tasks/:id` for the detail view — it already exists at `:105` and already populates `body`, which is the correct place for it.

---

### P-3. `GET /api/clients` loads **the entire Task and Email collections** into memory to compute two counters
**Severity: CRITICAL**
**File:** `server/controllers/clientController.js:12-31`

```js
const clients = await Client.find().sort({ createdAt: -1 });
const tasks   = await Task.find({}, 'clientName status');   // ALL tasks
const emails  = await Email.find({}, 'from');               // ALL emails
const result = clients.map((client) => {
  const taskCount = tasks.filter(t => t.clientName?.toLowerCase() === client.name.toLowerCase()).length;
  const mailCount = emails.filter(e => allClientEmails.some(ce => e.from.toLowerCase().includes(ce))).length;
```

**What's wrong.** Three unbounded finds, then an **O(clients × tasks) + O(clients × emails × associatedEmails)** nested JS scan on the main thread.

**Why it hurts at scale.** 50 clients × 100k emails × 3 associated addresses = **15 million string `.includes()` calls per request**, fully synchronous. That is a multi-second event-loop freeze — the server stops answering *everything*, including socket pings, for the duration. Memory: 100k `{from}` docs ≈ 12 MB plus Mongoose hydration overhead ≈ 60 MB.

**Fix.** Push the counting into MongoDB and paginate the client list:
```js
const clients = await Client.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
const names = clients.map(c => c.name);
const taskCounts = await Task.aggregate([
  { $match: { clientName: { $in: names } } },
  { $group: { _id: { $toLower: '$clientName' }, n: { $sum: 1 } } }
]);
```
For `mailCount`, denormalise: add `Email.clientId` (set once at sync time in `taskHelper.ensureTaskForEmail`-style matching) with an index, then `Email.aggregate([{ $match: { clientId: { $in: ids } } }, { $group: { _id: '$clientId', n: { $sum: 1 } } }])`. Cache the whole payload for 300s (see C-1).

---

### P-4. `GET /api/users/activity-logs` unbounded — the fastest-growing collection in the system
**Severity: HIGH**
**File:** `server/controllers/userController.js:279-281`

```js
const logs = await ActivityLog.find({}).populate('userId', 'name email role').sort({ createdAt: -1 });
```

**What's wrong.** No limit. `ActivityLog` is written on *every* login, task create/update/delete, every Gmail fetch (`gmailController.js:486`), every comment, every client change. `logActivity` also `console.log`s each write (`activityLogger.js:14`).

**Why it hurts at scale.** One active workspace generates ~500–2000 rows/day. After 6 months: ~250k rows × ~200 bytes = 50 MB response, plus a `$in` populate over up to 250k distinct-ish user ids. The Admin activity page becomes a denial-of-service button.

**Fix.**
```js
const limit = Math.min(+req.query.limit || 50, 200);
const cursor = req.query.before;                    // keyset on createdAt (indexed at ActivityLog.js:24)
const q = cursor ? { createdAt: { $lt: new Date(cursor) } } : {};
const logs = await ActivityLog.find(q).populate('userId','name email role')
  .sort({ createdAt: -1 }).limit(limit + 1).lean();
```
Also add a TTL index to cap retention:
```js
ActivityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 }); // 180 days
```

---

### P-5. `GET /api/notifications` unbounded
**Severity: HIGH**
**File:** `server/controllers/notificationController.js:8-9`

```js
const notifications = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 });
```
The overdue cron (`cronJobs.js:58-64`) creates **one notification per overdue task per supervisor, every single minute** — see Q-2. A single stuck overdue task generates 1,440 notifications/day/supervisor. Within a week the bell-icon endpoint returns 10k rows.

**Fix.** `.limit(30).lean()` for the dropdown + a separate `GET /api/notifications/unread-count` backed by `countDocuments({userId, read:false})` (the `{userId:1, read:1}` index at `Notification.js:32` already supports it). Add a 90-day TTL index on `createdAt`.

---

### P-6. Remaining unbounded list endpoints
**Severity: MEDIUM–HIGH**

| Endpoint | File:line | Current | Recommended |
|---|---|---|---|
| `GET /api/users` | `userController.js:16` | `User.find({}).select('-password').sort({createdAt:-1})` | offset, page 50, `.lean()`; index `createdAt` |
| `GET /api/tasks/:id/comments` | `commentController.js:28` | `TaskComment.find({taskId}).populate('author').sort({createdAt:1})` | keyset ascending, page 50; compound index `{taskId:1, createdAt:1}` |
| `GET /api/keyword-rules` | `keywordRuleController.js:15` | `KeywordRule.find()` + 2 populates | offset, page 50, `.lean()`, cache 300s |
| `GET /api/keyword-rules/pending-approvals` | `keywordRuleController.js:174` | `Email.find({approvalStatus:'pending'})` + populates — **full bodies** | offset, page 25, `.select()` excluding `body` |
| `GET /api/tasks/clients` | `taskController.js:291` | `Client.find({}).sort({name:1})` | bounded (`.limit(500).lean()`), cache 300s |
| `GET /api/reports/employee` | `reportsController.js:40` | `Task.find({...})` all tasks in window, **embeds full task list per employee** in response (`:68-74`) | `$group` aggregation for counters; separate paginated drill-down for `tasks[]` |
| `GET /api/reports/timeline` | `reportsController.js:153` | `Task.find(taskQuery)` full documents (incl. `description`) for 30 days | `$group` by `$dateToString` — return only 30 rows |
| `GET /api/reports/email-timeline` | `reportsController.js:259` | `Email.find(emailQuery, 'date status')` — projection present, still unbounded | `$group` by day + `$sum` on `assigned` |
| `GET /api/reports/client-stats` | `reportsController.js:186-220` | `Client.find({})` then 3 `countDocuments` **per client** | single `$lookup`/`$group` pipeline, cache 600s |

---

### P-7. Internal unbounded finds that exist only to collect `_id`s
**Severity: MEDIUM**

- `gmailController.js:756-758` — `Email.find({toEmail, fetchedBy})` loads **full documents including bodies**, maps to `_id`, then `deleteMany` on the same filter. Use `.distinct('_id')` or `.select('_id').lean()`.
- `gmailController.js:790-794` — identical pattern in `disconnectGmail`.
- `config/db.js:19-23` — `Task.find({linkedEmail:{$ne:null}}).select('linkedEmail')` at **every boot**, then `Email.updateMany({_id: {$nin: linkedEmailIds}}, ...)`. `$nin` with an array of every linked email id is unindexable and grows without bound; at 50k tasks this is a 50k-element array shipped in the query and a full collection scan on every process start. See I-2.
- `keywordRuleController.js:72-76` — `Email.find({status:'unassigned', $or:[{subject:re},{body:re}]})` — **regex over the `body` field of every unassigned email**, then a JS loop that `save()`s each match individually.
- `keywordRuleController.js:260` — `Email.find({approvalStatus:'pending'})` full docs, then a per-document loop.
- `taskController.js:317, 328, 357` — three separate `Task.find({_id:{$in:taskIds}})` in one handler; consolidate.

---

# 3. QUEUES / BACKGROUND JOBS

### Q-1. Gmail sync runs **inline inside the HTTP request** and iterates all users sequentially
**Severity: CRITICAL**
**File:** `server/controllers/gmailController.js:497-542` (`fetchEmails`), `:296-444` (`syncAccountEmails`), `:447-489` (`syncUserEmails`)

```js
// fetchEmails, line 501-517 — Admin path
const users = await User.find({ gmailAccessToken: { $ne: null, $ne: "" } })...;
for (const u of users) {
  const count = await syncUserEmails(u, true);   // fully sequential
}
```
and inside `syncAccountEmails`:
```js
// line 320-324
const listRes = await gmail.users.messages.list({ userId:'me', maxResults:150, includeSpamTrash:true });
// line 336-441 — sequential per message
for (const message of messages) {
  const msgDetails = await gmail.users.messages.get({ userId:'me', id: message.id });   // line 339
  ...
  await gmail.users.messages.attachments.get({...});   // line 364, per inline image, also sequential
  ...
  await emailRecord.save();                            // line 435, one write per email
  await ensureTaskForEmail(...);                       // line 437 → does Client.find({}) — see D-6
}
```

**Why it hurts at scale.** Per account: 1 list + up to 150 sequential `messages.get` at ~150–250 ms RTT = **22–37 seconds**, plus attachment fetches. For an Admin with 10 connected accounts across users: **4–6 minutes of a single blocking HTTP request**. Consequences:
1. Any reverse proxy (nginx default `proxy_read_timeout 60s`, Heroku hard 30s, ALB default 60s) kills the connection — the client sees a 502 while the sync keeps running server-side.
2. Node holds one Mongo pool connection and one socket for minutes.
3. A user double-clicking "Fetch" starts a second concurrent full sync — there is **no idempotency lock**. Two syncs racing on the same `messageId` rely on the unique index to reject the duplicate, which throws inside the loop and aborts the rest of the sync (`emailRecord.save()` at `:435` is not wrapped in try/catch).
4. Gmail per-user quota is 250 units/sec; `messages.get` = 5 units. 150 sequential gets is under quota but there is **no `429` handling and no backoff** — one rate-limit response aborts the entire sync with a 500.

**Fix — BullMQ:**
```js
// server/queues/index.js
const { Queue, Worker } = require('bullmq');
const connection = { url: process.env.REDIS_URL };

const gmailSyncQueue = new Queue('gmail-sync', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500          // acts as the dead-letter view
  }
});

// enqueue with a deterministic jobId → dedupes double-clicks and overlapping cron ticks
await gmailSyncQueue.add('sync-account',
  { userId, gmailEmail },
  { jobId: `sync:${userId}:${gmailEmail}` }
);
```
`POST /api/gmail/fetch` becomes:
```js
const jobs = await Promise.all(accounts.map(a => gmailSyncQueue.add(...)));
return res.status(202).json({ message: 'Sync queued', jobIds: jobs.map(j => j.id) });
```
Progress is pushed back over the existing Socket.io channel (`io.to(userId).emit('gmail:sync:progress', ...)`).

Inside the worker, replace the sequential `messages.get` loop with the **Gmail batch endpoint** or a bounded concurrency pool (see X-1), and replace the per-email `save()` with a single `Email.insertMany(docs, { ordered: false })` — `ordered:false` makes duplicate-`messageId` collisions skip rather than abort.

Also add **incremental sync**: store `historyId` per account and use `gmail.users.history.list({ startHistoryId })` instead of re-listing 150 messages every 10 minutes.

---

### Q-2. The overdue cron does O(tasks × supervisors) writes **every 60 seconds**, forever
**Severity: CRITICAL**
**File:** `server/utils/cronJobs.js:14-71`

```js
cron.schedule('* * * * *', async () => {
  const overdueTasks = await Task.find({ status:'Pending', deadline:{ $lt: now } }).populate('assignedTo','name');
  const supervisors  = await User.find({ role: { $in: ['Admin','Head'] } });   // no index on role
  for (const task of overdueTasks) {
    task.status = 'Late'; await task.save();                                   // 1 write/task
    if (task.assignedTo) await createNotification(...);                        // 1 write + 1 socket emit
    for (const supervisor of supervisors) {
      await createNotification(supervisor._id, staffAlertMessage, io);         // 1 write per supervisor per task
    }
  }
});
```

**What's wrong.**
- Every minute, `User.find({role:{$in:[...]}})` runs against an **unindexed** `role` field → full collection scan (D-1).
- Notifications are created **sequentially** inside a nested loop.
- The status *is* flipped to `Late` so tasks don't re-trigger — but tasks whose `save()` throws (validation, connection blip) are silently caught by the outer try/catch at `:68`, and the remaining tasks in the batch are skipped entirely, then retried in full next minute.

**Why it hurts at scale.** A backlog of 500 tasks going overdue at midnight, with 10 supervisors = 500 task writes + 500 employee notifications + **5,000 supervisor notifications** = 6,000 sequential Mongo writes + 5,500 socket emits, all inside one cron tick, all on the main event loop. The next tick fires while this is still running (`node-cron` does not skip overlapping executions).

**Fix.**
```js
// 1. one bulk status update
const overdue = await Task.find({ status:'Pending', deadline:{$lt:now} })
  .select('_id title assignedTo').limit(1000).lean();
await Task.updateMany({ _id: { $in: overdue.map(t=>t._id) } }, { $set: { status:'Late' } });

// 2. one bulk notification insert
const supervisorIds = await cached('supervisors', 300, () =>
  User.find({ role: { $in: ['Admin','Head'] } }).distinct('_id'));
const docs = [];
for (const t of overdue) {
  if (t.assignedTo) docs.push({ userId:t.assignedTo, message:`Your task is overdue: ${t.title}`, taskId:t._id, type:'overdue' });
  for (const s of supervisorIds) docs.push({ userId:s, message:`Task overdue: ${t.title}`, taskId:t._id, type:'overdue' });
}
await Notification.insertMany(docs, { ordered: false });
```
Then emit **one aggregate socket event per user** rather than one per notification. Consider changing the schedule from `* * * * *` to `*/5 * * * *` — a one-minute SLA on an overdue flag is not a product requirement.

---

### Q-3. `node-cron` is unsafe for multi-instance deployment — every replica runs every job
**Severity: CRITICAL (blocks horizontal scaling)**
**File:** `server/utils/cronJobs.js:14, 74`; started from `server/index.js:199-203`

```js
server.listen(PORT, () => { startCronJobs(io); });
```

**What's wrong.** `node-cron` is an in-process timer with no distributed lock. Run 3 replicas behind a load balancer and:
- The overdue job fires **3× per minute**, each replica creating its own duplicate notification rows.
- The Gmail sync fires **3× per 10 minutes** per account. Three workers race to insert the same `messageId`; two get duplicate-key errors that abort their loops mid-way, and any that succeed create duplicate `Task` documents via `ensureTaskForEmail` (`taskHelper.js:15` checks `Task.findOne({linkedEmail})` — a classic check-then-act race with no unique index on `Task.linkedEmail`).

**Fix (in order of preference).**
1. **BullMQ repeatable jobs** — Redis-backed, one execution cluster-wide:
   ```js
   await overdueQueue.add('scan', {}, { repeat: { pattern: '*/5 * * * *' }, jobId: 'overdue-scan' });
   ```
2. **Agenda** (Mongo-backed, no new infrastructure) — uses `findOneAndUpdate` locking on the existing MongoDB.
3. Minimum viable stopgap if neither is adopted: a Mongo advisory lock
   ```js
   const lock = await Lock.findOneAndUpdate(
     { _id: 'overdue-cron', expiresAt: { $lt: new Date() } },
     { $set: { expiresAt: new Date(Date.now() + 55_000), owner: process.pid } },
     { upsert: true, new: true }
   ).catch(() => null);
   if (!lock) return;   // another instance holds it
   ```
   plus `TaskSchema.index({ linkedEmail: 1 }, { unique: true, sparse: true })` to make `ensureTaskForEmail` race-safe.

---

### Q-4. Transactional email (nodemailer) is sent inline in the request path with no retry
**Severity: HIGH**
**Files:** `server/utils/emailHelper.js:41`; callers at `taskController.js:181`, `authController.js:218`, `userController.js:189`

```js
// emailHelper.js:41
const info = await transporter.sendMail(mailOptions);
```
No `connectionTimeout` / `greetingTimeout` / `socketTimeout`, no `pool: true`, no retry. `sendMail` to `smtp.gmail.com` typically takes 300 ms–3 s; if Gmail is slow or throttling it can hang for the OS TCP default (~2 minutes).

**Where it blocks:**
- `taskController.js:181` — an Employee marking a task Complete waits for the SMTP round-trip before getting a response.
- `authController.js:218` — `/forgot-password` blocks on SMTP. Combined with `authLimiter` (10/15min) this is a cheap way to tie up connections.
- `userController.js:189` — Admin approving a user waits for SMTP.

**Fix.**
```js
// emailHelper.js
const transporter = nodemailer.createTransport({
  service: 'gmail',
  pool: true, maxConnections: 5, maxMessages: 100,
  connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  auth: {...}
});
```
and move the send off the request path:
```js
// queues/email.js
emailQueue.add('send', { to, subject, body, html },
  { attempts: 5, backoff: { type:'exponential', delay: 10_000 }, removeOnFail: 1000 });
```
Callers become `await emailQueue.add(...)` — a ~1 ms Redis write instead of a multi-second SMTP round-trip. Failed jobs land in the failed set = dead-letter queue with the full payload for replay.

---

### Q-5. Gemini AI call is inline with no timeout, no retry, no cache
**Severity: HIGH**
**File:** `server/controllers/aiController.js:19-39`

```js
const genAI = new GoogleGenerativeAI(apiKey);              // new client per request (line 19)
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
const result = await model.generateContent(prompt);        // line 38 — no timeout
```

**What's wrong.** `gemini-2.5-flash` p95 for a 3k-char prompt is 2–6 s, p99 can exceed 30 s. There is no `AbortSignal`, no timeout, no retry on 429/503, and no cache — summarising the *same email twice* costs two full inference calls. The route (`aiRoutes.js:6`) is only rate-limited by the shared 300/15min general limiter.

**Why it hurts at scale.** 20 users each clicking "Summarize" holds 20 Node request contexts open for up to 30 s each. Gemini free-tier is 15 RPM — the 16th concurrent user gets a 429 surfaced to them as a generic 500 (`:47`).

**Fix.**
1. Hoist the client to module scope (it is stateless).
2. Add a hard timeout + abort:
   ```js
   const ac = new AbortController();
   const t = setTimeout(() => ac.abort(), 15_000);
   try {
     const result = await model.generateContent({ contents:[{role:'user',parts:[{text:prompt}]}] },
                                                { signal: ac.signal });
   } finally { clearTimeout(t); }
   ```
3. Cache by content hash — summaries are deterministic enough:
   `key = ai:sum:${crypto.createHash('sha1').update(subject+plainBody).digest('hex')}`, TTL 30 days, invalidation: none needed (content-addressed).
4. Dedicated rate limiter on `/api/ai/*`: `rateLimit({ windowMs: 60_000, max: 10, store: RedisStore })`.
5. Circuit breaker (`opossum`) so a Gemini outage fails fast instead of queueing 30 s timeouts:
   ```js
   const breaker = new CircuitBreaker(callGemini, { timeout: 15000, errorThresholdPercentage: 50, resetTimeout: 30000 });
   ```

---

### Q-6. Two more jobs that belong on a queue
**Severity: MEDIUM**
- `deduplicateConnections` (`gmailController.js:814`) — currently on the request path (C-4). Should be a nightly repeatable job.
- `keywordRuleController.createKeywordRule:72-93` — a retroactive scan over all unassigned emails, executed inline in the POST. At 50k unassigned emails this is a multi-minute regex scan over `body` plus one `save()` per match plus `ensureTaskForEmail` (with its own `Client.find({})`) per match. Return `202` and enqueue `keyword-backfill`.

---

# 4. DATABASE

### D-1. Schema fields that are queried/sorted/filtered with **no index**
**Severity: HIGH**

| Model | Field | Queried at | Impact |
|---|---|---|---|
| `User` | `role` | `cronJobs.js:33` (every 60s), `gmailController.js:905`, `:1111`, `reportsController.js:26`, `userController.js:128`, `:149` | COLLSCAN every minute |
| `User` | `status` | `userController.js:128-131`, `:149-153` | COLLSCAN on every role change |
| `User` | `gmailAccessToken` | `gmailController.js:503`, `:657`; `cronJobs.js:80` | COLLSCAN every 10 min |
| `User` | `linkedGmailAccounts.gmailEmail` | `cronJobs.js:82` (`'linkedGmailAccounts.0': {$exists:true}`) | COLLSCAN |
| `User` | `createdAt` | sorted at `userController.js:16` | in-memory sort |
| `Email` | `matchedKeyword` | `keywordRuleController.js:257` | COLLSCAN |
| `Email` | `subject`, `body`, `from` | regex search `gmailController.js:557-561`; `keywordRuleController.js:71-74`; `reportsController.js:194` | **unanchored regex = COLLSCAN + full body decompression** |
| `Email` | `(fetchedBy, date)` compound | `gmailController.js:572-575`, `reportsController.js:254-259` | filter uses one index, sort needs an in-memory sort (32 MB limit → query *fails* past that) |
| `Email` | `(assignedTo, date)` compound | `gmailController.js:550`, `:575` | same |
| `Email` | `(toEmail, fetchedBy)` compound | `gmailController.js:756`, `:758` | 2 index intersections |
| `Task` | `clientName` | `reportsController.js:202`, `:207`; `clientController.js:20` | COLLSCAN ×2 per client (D-5) |
| `Task` | `createdAt` | sorted `taskController.js:93`; filtered `reportsController.js:41`, `:147` | in-memory sort of the whole collection |
| `Task` | `(assignedTo, createdAt)` compound | `taskController.js:84 + :93` | filter+sort split |
| `Task` | `parentTaskId` | written `recurrenceHelper.js:30`, never indexed | future queries scan |
| `Client` | `createdAt` | sorted `clientController.js:12` | in-memory sort |
| `KeywordRule` | `isActive` | `gmailController.js:394` (150× per sync!) | COLLSCAN ×150 |
| `KeywordRule` | `keyword` | `keywordRuleController.js:47` | COLLSCAN |
| `TaskComment` | `(taskId, createdAt)` compound | `commentController.js:28-30` | sort not covered |

**Fix — add to the schemas:**
```js
// models/User.js
UserSchema.index({ role: 1, status: 1 });
UserSchema.index({ createdAt: -1 });
UserSchema.index({ gmailAccessToken: 1 }, { partialFilterExpression: { gmailAccessToken: { $type: 'string' } } });
UserSchema.index({ 'linkedGmailAccounts.gmailEmail': 1 });

// models/Email.js  (replace the 6 single-field indexes at :75-80)
EmailSchema.index({ fetchedBy: 1, date: -1 });
EmailSchema.index({ assignedTo: 1, date: -1 });
EmailSchema.index({ status: 1, date: -1 });
EmailSchema.index({ approvalStatus: 1, date: -1 });
EmailSchema.index({ toEmail: 1, fetchedBy: 1 });
EmailSchema.index({ matchedKeyword: 1 });
EmailSchema.index({ subject: 'text', from: 'text' });   // replaces the regex search — see D-2

// models/Task.js
TaskSchema.index({ assignedTo: 1, createdAt: -1 });
TaskSchema.index({ createdBy: 1, createdAt: -1 });
TaskSchema.index({ clientName: 1, status: 1 });
TaskSchema.index({ createdAt: -1 });
TaskSchema.index({ linkedEmail: 1 }, { unique: true, sparse: true });   // also fixes the Q-3 race
TaskSchema.index({ parentTaskId: 1 });

// models/Client.js
ClientSchema.index({ createdAt: -1 });

// models/KeywordRule.js
KeywordRuleSchema.index({ keyword: 1 }, { unique: true });
KeywordRuleSchema.index({ isActive: 1 });

// models/TaskComment.js
TaskCommentSchema.index({ taskId: 1, createdAt: 1 });
```
Ship these with `autoIndex: false` in production plus an explicit migration (`Model.syncIndexes()` in a deploy step) — otherwise Mongoose builds them on every boot of every replica.

---

### D-2. Email search uses an unanchored `$regex` — full collection scan over multi-MB bodies
**Severity: HIGH**
**File:** `server/controllers/gmailController.js:556-569`

```js
const searchRegex = new RegExp(escapeRegex(q.trim()), 'i');
const searchConditions = [{ subject: searchRegex }, { from: searchRegex }];
```
Case-insensitive, unanchored regex cannot use a B-tree index. Mongo scans every document. Combined with P-1 (no projection), each scanned document is decompressed with its full base64 body.

Worse at `keywordRuleController.js:71-74`, which regexes `body` directly:
```js
$or: [{ subject: searchRegex }, { body: searchRegex }]
```
At 100k emails × 60 KB average body, that is **6 GB read off disk** for one keyword-rule creation.

**Fix.** Add a text index and use `$text`:
```js
EmailSchema.index({ subject: 'text', from: 'text' });
// query:
if (q?.trim()) query.$text = { $search: q.trim() };
```
For matching keyword rules against bodies, do it **once at ingest time** (already done at `gmailController.js:394-413`) and never re-scan; the retroactive scan in `createKeywordRule` should be a queued background job (Q-6) that walks the collection in `_id` batches of 500 with `.select('_id subject body').lean()`.

---

### D-3. Zero use of `.lean()` anywhere in the codebase
**Severity: HIGH**
**Files:** every read handler — `gmailController.js:572`, `taskController.js:89, 107, 291, 317, 328, 357`, `userController.js:16, 279`, `notificationController.js:8`, `commentController.js:28`, `keywordRuleController.js:15, 174, 260`, `clientController.js:12-14`, `reportsController.js:31, 40, 153, 186, 259`, `cronJobs.js:20, 33, 79`.

**What's wrong.** Mongoose hydrates every result into a full document with getters, setters, change-tracking, virtuals and a `$__` internal state object — roughly **3–8× the memory** of the plain object and ~5× the CPU to construct.

**Why it hurts at scale.** For read-only handlers (all the `GET` list endpoints), `.lean()` is a free 2–5× throughput win. On a 10k-email query the difference is roughly 600 MB hydrated vs. 180 MB lean, and ~1.2 s vs ~250 ms of construction time.

**Fix.** Add `.lean()` to every query whose result is only serialized to JSON. Do **not** add it where the code calls `.save()` on the result (`gmailController.js:756`? no — safe; but `keywordRuleController.js:260`, `:78`, `cronJobs.js:20`, `gmailController.js:816` all mutate-and-save, so those need the bulk-write rewrites described in Q-2/C-4/Q-6 first).

---

### D-4. Missing projections — `body` is fetched everywhere it isn't needed
**Severity: CRITICAL**

| Location | Missing projection |
|---|---|
| `gmailController.js:572` | list view fetches `body` (base64 images) |
| `gmailController.js:756`, `:790` | fetches full docs to extract `_id` only |
| `taskController.js:91`, `:109`, `:240` | `.populate('linkedEmail','subject from body attachments')` — `body` in a list |
| `keywordRuleController.js:174` | pending approvals fetch `body` |
| `keywordRuleController.js:260` | bulk approve fetches `body` |
| `gmailController.js:1005` | `Email.find({_id:{$in:emailIds}})` fetches `body`, uses it at `:1018` (legitimate) but should `.select('subject body from')` |
| `reportsController.js:40` | `Task.find(...)` full docs incl. `description` (which is a 1000-char email body excerpt, `taskHelper.js:48`) — only `status`/`assignedTo` used |
| `reportsController.js:153` | `Task.find(taskQuery)` full docs — only `createdAt` used |
| `userController.js:279` | `ActivityLog.find({})` fine, but populate is unbounded |

**Fix.** Add `.select()` to every one. As a systemic guard, move `body` out of the hot document:
```js
// Option A: exclude by default at the schema level
body: { type: String, default: '', select: false }
```
Then only `GET /api/gmail/emails/:id` opts in with `.select('+body')`. This one change fixes P-1, P-2, P-6 and D-4 simultaneously with minimal blast radius — grep shows `email.body` is read at `gmailController.js:1018`, `taskHelper.js:47`, `keywordRuleController.js:74`, all of which can add `+body`.

---

### D-5. `getClientStats` — 3 `countDocuments` **per client**, all with unindexed regex
**Severity: HIGH**
**File:** `server/controllers/reportsController.js:189-220`

```js
for (const client of clients) {
  emailCount = await Email.countDocuments({ $or: conditions });        // line 196 — regex on `from`
  const taskCount = await Task.countDocuments({
    clientName: { $regex: new RegExp(`^${escapedName}$`, 'i') } });    // line 202
  const completedTaskCount = await Task.countDocuments({ ... });        // line 207
}
```

**Why it hurts at scale.** 50 clients → **150 sequential queries**, each a full collection scan (regex, unindexed `clientName`, unindexed `from`). At 100k emails and 20k tasks: 50 × (100k + 20k + 20k) = **7 million document examinations per request**, ~15–40 seconds.

**Fix.** One pipeline for tasks, one for emails, both `$group`ed, `$facet`-combined:
```js
const taskStats = await Task.aggregate([
  { $group: { _id: { $toLower: '$clientName' },
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status','Completed'] }, 1, 0] } } } }
]);
```
Then join in JS against the (small) client list. Cache 600s. For `emailCount`, denormalise `Email.clientId` at ingest.

---

### D-6. `ensureTaskForEmail` loads **the entire Client collection** on every single email assignment
**Severity: HIGH**
**File:** `server/utils/taskHelper.js:25`

```js
const clients = await Client.find({});          // no projection, no lean, no limit
const matchedClient = clients.find(c => { ... senderLower.includes(ce) });
```
Called from `gmailController.js:437` (inside the per-message sync loop), `keywordRuleController.js:86`, `:223`, `:286`.

**Why it hurts at scale.** During a 150-message sync where 40 emails match auto-approve rules, this fires 40 times = 40 full `Client` collection loads. During `bulkApproveEmails` over 500 pending emails, 500 loads.

Also note the fallback at `taskHelper.js:35`: `clientName = clients[0].name` — every unmatched email is silently attributed to whichever client sorts first. That's a correctness bug that also inflates the client-stats numbers computed in D-5.

**Fix.** Hoist + cache + accept the client map as a parameter:
```js
const getClientMatcher = () => cached('clients:matcher', 300, async () => {
  const clients = await Client.find({}).select('name email associatedEmails').lean();
  const map = new Map();
  for (const c of clients)
    for (const e of [c.email, ...(c.associatedEmails||[])].filter(Boolean))
      map.set(e.toLowerCase().trim(), c.name);
  return [...map];                                   // serialisable
});
```
and in the sync loop build the `Map` once before the loop, not per email.

---

### D-7. Confirmed N+1 / sequential-await loops (complete list)
**Severity: HIGH**

| # | File:line | Loop | Per-iteration cost |
|---|---|---|---|
| 1 | `gmailController.js:336-441` | per Gmail message | 1 HTTP `messages.get` + 1 `KeywordRule.find` + 1 `Email.save` + 1 `ensureTaskForEmail` (→ `Client.find({})`) |
| 2 | `gmailController.js:358-381` | per inline image | 1 HTTP `attachments.get` |
| 3 | `gmailController.js:464-478` | per linked account | full `syncAccountEmails` (30 s each) |
| 4 | `gmailController.js:508-516` | per user (Admin fetch) | full `syncUserEmails` |
| 5 | `gmailController.js:662-682` | per other user | in-memory, but over an unbounded `User.find` |
| 6 | `gmailController.js:819-860` | per user (dedup) | 1 `u.save()` |
| 7 | `gmailController.js:1014-1033` | per email (bulk assign) | 1 `task.save()` + 1 `email.save()` |
| 8 | `keywordRuleController.js:78-93` | per matching email | 1 `email.save()` + `ensureTaskForEmail` |
| 9 | `keywordRuleController.js:268-295` | per pending email | 1 `email.save()` + `ensureTaskForEmail` + `createNotification` (write + emit) |
| 10 | `cronJobs.js:39-65` | per overdue task **× per supervisor** | 1 `task.save()` + (1+S) notification writes |
| 11 | `seeders/clientSeeder.js:56-63` | per seed client | 1 `findOne` + 1 `save`, on **every boot** |
| 12 | `reportsController.js:189-220` | per client | 3 `countDocuments` |
| 13 | `scripts/encryptExistingTokens.js:21-55` | per user | 1 `save()` — one-off script, acceptable |

**Generic fix pattern:** replace `for (...) { await Model.save() }` with `Model.bulkWrite([...ops])` or `insertMany(docs, {ordered:false})`; replace independent sequential awaits with `Promise.all` / `p-limit`.

Example for #7 (`bulkAssignEmails`):
```js
const taskDocs = emails.map(e => ({ title: e.subject||'Assigned Email', description: e.body||'',
  linkedEmail: e._id, assignedTo: assignee._id, clientName: e.from||'Inbox Client',
  deadline: taskDeadline, priority: taskPriority, createdBy: req.user._id, status:'Pending' }));
const createdTasks = await Task.insertMany(taskDocs, { ordered: false });
await Email.updateMany({ _id: { $in: emails.map(e=>e._id) } },
                       { $set: { assignedTo: assignee._id, status: 'assigned' } });
```
2N writes → 2 writes.

---

### D-8. `countDocuments({})` on unbounded collections
**Severity: MEDIUM**
**File:** `reportsController.js:98`, `:105`; `authController.js:44`

`User.countDocuments({})`, `Client.countDocuments({})` and `Email.countDocuments(emailQuery)` where `emailQuery` may be `{}` all scan. `authController.js:44` runs `User.countDocuments({})` on **every registration attempt** just to detect "is this the first user".

**Fix.** Use `estimatedDocumentCount()` where an exact number isn't needed (it reads collection metadata — O(1)). For `authController.js:44` use `await User.exists({})` — stops at the first document.

---

### D-9. Aggregations that should be `$facet` / `$group` but are done in JS
**Severity: MEDIUM–HIGH**

| Handler | Current | Should be |
|---|---|---|
| `reportsController.js:9-83` `getEmployeeReport` | `User.find` + `Task.find` all, then `users.map(u => tasks.filter(...))` — **O(users × tasks)** in JS | `$group` by `assignedTo` with `$cond` sums, `$lookup` user names |
| `reportsController.js:126-177` `getTaskTimeline` | `Task.find` full docs, JS date bucketing | `$group: { _id: { $dateToString: { format:'%Y-%m-%d', date:'$createdAt' } }, n: { $sum: 1 } }` |
| `reportsController.js:232-289` `getEmailTimeline` | `Email.find` + JS bucketing | same `$dateToString` `$group` with `$cond` for `assignedCount` |
| `reportsController.js:88-121` `getOverallStats` | 8 sequential counts | `$facet` (see C-3) |
| `reportsController.js:184-227` `getClientStats` | 3 counts per client | `$group` (see D-5) |
| `clientController.js:10-40` `getClients` | 2 full collection loads + nested JS filter | `$group` (see P-3) |

`getEmployeeReport` at `:45-76` is the worst of these: for 30 employees and 5,000 tasks in the window it does 150,000 array scans, then embeds **every task** for every employee in the JSON response (`:68-74`).

---

# 5. CONCURRENCY / BLOCKING

### X-1. Gmail message fetching is fully sequential — no `Promise.all`, no batch API
**Severity: CRITICAL**
**File:** `server/controllers/gmailController.js:339`, `:364`

```js
for (const message of messages) {                                    // 150 iterations
  const msgDetails = await gmail.users.messages.get({ userId:'me', id: message.id });
```
150 × ~200 ms RTT = **30 s per account**, single-threaded, blocking the HTTP response (Q-1) or the cron tick.

**Fix.** Bounded concurrency with `p-limit` (respects Gmail's 250 units/s/user; `messages.get` = 5 units → 50/s ceiling, so 10 in flight is safe):
```js
const pLimit = require('p-limit');
const limit = pLimit(10);
const details = await Promise.all(
  newIds.map(id => limit(() => gmail.users.messages.get({ userId:'me', id, format:'full' })))
);
```
30 s → ~3 s. Then `Email.insertMany(docs, { ordered: false })` instead of 150 individual saves.
Same treatment for the inline-image loop at `:358-381`.

---

### X-2. Independent awaits that should be parallel
**Severity: MEDIUM**

| File:line | Sequential | Parallelisable |
|---|---|---|
| `reportsController.js:98-105` | 8 counts | `Promise.all` / `$facet` (C-3) |
| `gmailController.js:453-478` | primary sync then linked syncs | `Promise.all` over accounts (with `p-limit`) |
| `userController.js:251-263` | 7 cascade cleanup writes on user delete | `Promise.all([...])` — they touch different collections |
| `clientController.js:12-14` | `Client.find` → `Task.find` → `Email.find` | `Promise.all` (though P-3 removes them) |
| `taskController.js:317, 328` | two `Task.find({_id:{$in:taskIds}})` | one query, reused |
| `commentController.js:81-98` | two `createNotification` awaits | `Promise.all` |
| `gmailController.js:756-760` | find → deleteMany → updateMany | find is redundant; `deleteMany` then `updateMany` in parallel |

Example for `userController.js:251-263`:
```js
await Promise.all([
  Task.updateMany({ assignedTo: userId }, { $set: { assignedTo: null } }),
  Email.updateMany({ assignedTo: userId }, { $set: { assignedTo: null, status: 'unassigned' } }),
  Notification.deleteMany({ userId }),
  ActivityLog.deleteMany({ userId }),
  TaskComment.deleteMany({ author: userId }),
  KeywordRule.deleteMany({ createdBy: userId }),
  KeywordRule.updateMany({ assignedTo: userId }, { $set: { assignedTo: null, isActive: false } })
]);
```
7 sequential round-trips → 1 round-trip's latency.

---

### X-3. Synchronous CPU-bound work on the event loop during sync
**Severity: HIGH**
**File:** `server/controllers/gmailController.js:352-353`, `:375-379`, `taskHelper.js:47-48`, `aiController.js:23-24`

```js
const base64Body = rawBody.replace(/-/g,'+').replace(/_/g,'/');       // full-body string copy
decodedBody = Buffer.from(base64Body,'base64').toString('utf-8');      // full decode
...
const standardBase64 = base64Data.replace(/-/g,'+').replace(/_/g,'/'); // image-sized string copy
decodedBody = decodedBody.replace(regex,dataUrl);                      // regex over the whole body
```

**What's wrong.** For a message with a 2 MB image: `.replace()` on a 2.7 MB base64 string allocates two more 2.7 MB strings, `Buffer.from` allocates 2 MB, and `decodedBody.replace(regex, dataUrl)` scans and rebuilds the whole body. All synchronous. Repeated per image, per message, 150 messages deep.

`taskHelper.js:48` runs `body.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ')` over the same multi-MB base64-laden string. `aiController.js:24` does the same before slicing to 3000 chars — it strips tags across the *entire* body first, then takes the first 3000 characters.

**Why it hurts at scale.** Each of these is 10–200 ms of blocked event loop. During a sync of 150 messages this is seconds of cumulative stall where **no other request, socket ping, or health check is served**. Node's HTTP keep-alive timeouts start firing.

**Fix.**
1. Stop inlining images into `body` (root cause) — store attachments externally and keep `cid:` references, serving through the existing `downloadAttachment` route.
2. `aiController.js:24` — slice *before* the regex: `body.slice(0, 20000).replace(/<[^>]*>/g,' ')...slice(0,3000)`.
3. `taskHelper.js:48` — same, slice to ~5000 chars first.
4. Move the whole decode/inline step into the BullMQ worker process (Q-1) so it can't stall the API process at all.

---

### X-4. No timeouts on **any** outbound HTTP call
**Severity: HIGH**
**Files:** `gmailController.js:221, 320, 339, 364, 935, 966, 1135` (googleapis); `aiController.js:38` (Gemini); `emailHelper.js:41` (SMTP)

`googleapis` defaults to no timeout — `gaxios` will wait indefinitely on a hung socket. A single stalled Gmail connection during the 10-minute cron will pin a worker forever, and the next cron tick starts a second one (no overlap guard, Q-3).

**Fix.**
```js
// gmailController.js — getOAuth2Client / gmail client creation
const gmail = google.gmail({ version: 'v1', auth: oauth2Client, timeout: 15_000, retry: true,
  retryConfig: { retry: 3, retryDelay: 1000, statusCodesToRetry: [[429,429],[500,599]] } });
```
Plus SMTP timeouts (Q-4) and the Gemini `AbortController` (Q-5).

---

### X-5. No retry, no exponential backoff, no circuit breaker anywhere
**Severity: HIGH**

Failure handling today is `try { ... } catch (e) { console.error(e); return res.status(500) }` in every controller. Consequences:
- A transient Gmail `429` or `503` mid-sync aborts the remaining messages; they are only picked up on the next 10-minute tick (`gmailController.js:339` has no per-message try/catch — one bad message kills the whole account's sync).
- `emailRecord.save()` at `:435` throwing on a duplicate key kills the loop.
- Gemini outages produce 15+ concurrent 30-second hangs (Q-5).

**Fix.** BullMQ `attempts: 5` + `backoff: { type:'exponential', delay: 5000 }` covers the queued paths. For synchronous outbound calls add `opossum` circuit breakers on the Gemini and Gmail clients. Wrap the per-message body of the sync loop in its own `try/catch` so one poisoned message doesn't abort the batch.

---

# 6. RUNTIME / INFRA

### I-1. `mongoose.connect` has **no options at all** — no pool sizing, no timeouts
**Severity: HIGH**
**File:** `server/config/db.js:10`

```js
const conn = await mongoose.connect(process.env.MONGO_URI);
```

**What's wrong.** Defaults are `maxPoolSize: 100`, `minPoolSize: 0`, `serverSelectionTimeoutMS: 30000`, `socketTimeoutMS: 0` (infinite). With `socketTimeoutMS: 0`, a query that hangs (e.g. the unindexed regex scans in D-2) holds its pool connection forever. `minPoolSize: 0` means cold-start latency on the first request after idle. And `maxPoolSize: 100` per replica × N replicas can exceed an Atlas M10's 1500-connection limit surprisingly fast.

**Fix.**
```js
await mongoose.connect(process.env.MONGO_URI, {
  maxPoolSize: Number(process.env.MONGO_POOL_MAX || 20),
  minPoolSize: 5,
  serverSelectionTimeoutMS: 5_000,
  socketTimeoutMS: 45_000,
  connectTimeoutMS: 10_000,
  maxIdleTimeMS: 60_000,
  compressors: ['zstd', 'snappy'],   // meaningful given the multi-MB email bodies
  autoIndex: process.env.NODE_ENV !== 'production'
});
mongoose.set('bufferCommands', false);   // fail fast instead of queueing when DB is down
```

---

### I-2. Boot does a full-collection maintenance write and a seeder — on every process start of every replica
**Severity: HIGH**
**File:** `server/config/db.js:14-27`

```js
await seedClients();                                                    // line 14
const tasks = await Task.find({ linkedEmail: { $ne: null } }).select('linkedEmail');
const linkedEmailIds = tasks.map(t => t.linkedEmail.toString());
const result = await Email.updateMany(
  { _id: { $nin: linkedEmailIds } },                                    // line 22
  { status: 'unassigned', assignedTo: null }
);
```

**What's wrong.**
1. `seedClients` (`clientSeeder.js:56-63`) does 5 `findOne` queries on every boot.
2. The cleanup loads **every** linked email id into a JS array, then issues `$nin` with that array. `$nin` is **non-selective and cannot use an index**; MongoDB scans every email. At 50k tasks the query document itself is ~1.2 MB (50k × 24-byte ObjectIds) and exceeds practical BSON query limits at ~600k ids.
3. It **writes to every unlinked email** on every boot — an unbounded write amplification event at startup.
4. Deploy 3 replicas → 3 concurrent full-collection updates racing each other.
5. `linkedEmail.toString()` is called on the raw docs and then compared against `_id` ObjectIds — the string/ObjectId mismatch means `$nin` may not match as intended, so this may be resetting emails it shouldn't.

**Fix.** Remove both from `connectDB` entirely. Make the cleanup an explicit, idempotent script under `scripts/` run manually or as a one-shot migration job, expressed as an aggregation rather than `$nin`:
```js
await Email.aggregate([
  { $lookup: { from: 'tasks', localField: '_id', foreignField: 'linkedEmail', as: 't' } },
  { $match: { t: { $size: 0 }, status: 'assigned' } },
  { $project: { _id: 1 } }
]);   // then updateMany over batched _ids
```
Move `seedClients` behind `if (process.env.SEED_ON_BOOT === 'true')`.

---

### I-3. `connectDB` swallows connection failure and the server starts anyway
**Severity: HIGH**
**File:** `server/config/db.js:28-31`, `server/index.js:17`

```js
} catch (error) {
  console.error(`MongoDB Connection Error: ${error.message}`);
  // Log the error but do not crash the process, allowing server health check to run
}
```
`connectDB()` at `index.js:17` is called **without `await`** and its rejection is swallowed. The server binds the port and reports healthy while every single request 500s (Mongoose buffers commands for 10 s then throws `MongooseError: Operation buffered timed out`).

**Why it hurts at scale.** In Kubernetes/ECS this is the worst possible failure mode: the readiness probe passes, traffic is routed to a replica that cannot serve anything, and the rollout completes "successfully".

**Fix.** Fail closed on startup, and make the health endpoint honest (I-5).

---

### I-4. No graceful shutdown
**Severity: HIGH**
**File:** `server/index.js:199-203` (end of file — no `SIGTERM`/`SIGINT` handler exists)

On `SIGTERM` (every deploy, every autoscale-down, every container restart) the process dies instantly:
- In-flight HTTP requests are dropped mid-response.
- A Gmail sync running inline (Q-1) is killed mid-loop, leaving emails saved without their `Task` (`gmailController.js:435` succeeded, `:437` never ran).
- Socket.io connections are severed without a `disconnect` frame.
- Mongo connections are left for the server to time out.

**Fix.**
```js
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} received`);
  server.close(() => console.log('[SHUTDOWN] HTTP closed'));
  io.close();
  await gmailSyncQueue.close?.();          // once BullMQ lands
  await mongoose.connection.close(false);
  setTimeout(() => process.exit(1), 15_000).unref();   // hard-kill backstop
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```
Pair with `server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000;` (must exceed the ALB/nginx idle timeout or you get random 502s).

---

### I-5. Health endpoint is a liveness stub, no readiness check
**Severity: MEDIUM**
**File:** `server/index.js:59-61`

```js
app.get('/api/health', (req, res) => { res.json({ status: "Server is running" }); });
```
Returns 200 even when Mongo is down (I-3), Redis is down, or the process is mid-shutdown.

**Fix.** Split liveness from readiness:
```js
app.get('/healthz', (req,res) => res.json({ ok: true }));           // liveness: is the loop alive
app.get('/readyz', async (req,res) => {
  const dbUp = mongoose.connection.readyState === 1;
  if (shuttingDown || !dbUp) return res.status(503).json({ ok:false, db: dbUp, shuttingDown });
  res.json({ ok: true, db: true, uptime: process.uptime() });
});
```
Also note: `/api/health` sits **behind** `app.use('/api', generalLimiter)` (`index.js:49`) — a burst of probes from a shared-IP orchestrator can rate-limit the health check itself. Move it outside the `/api` prefix.

---

### I-6. `uncaughtException` handler does not exit — leaves a corrupted process serving traffic
**Severity: HIGH**
**File:** `server/index.js:120-122`

```js
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT EXCEPTION]', err); });
```

**What's wrong.** Node's documented contract is that after an uncaught exception the process is in an **undefined state** — resources may be half-released, locks half-held. Suppressing the exit means the process keeps accepting requests with corrupted internal state, and the orchestrator never restarts it because the health check (I-5) still returns 200. This directly enables the OOM-zombie scenario in P-1.

**Fix.**
```js
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException', err);
  shutdown('uncaughtException').finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection', reason);
  // count them; exit after N, or exit immediately once the codebase is clean
});
```
Rely on the orchestrator (K8s/PM2/systemd) to restart. This is only safe **after** I-4 (graceful shutdown) exists.

---

### I-7. No `compression` middleware — multi-MB JSON goes over the wire uncompressed
**Severity: HIGH**
**File:** `server/index.js:37-46` (absent), `server/package.json:15-32` (dependency absent)

Email/task list responses are HTML-heavy JSON — typically **8–15× compressible** with gzip, more with brotli.

**Fix.**
```js
const compression = require('compression');
app.use(compression({ threshold: 1024 }));   // before the routes
```
A 60 MB inbox response becomes ~5 MB. (This is a band-aid; P-1's projection fix is the real answer — but compression is a two-line win for every endpoint.)

---

### I-8. Rate limiter uses the default in-memory store — breaks across replicas
**Severity: HIGH**
**File:** `server/index.js:20-34`

```js
const authLimiter    = rateLimit({ windowMs: 15*60*1000, max: 10,  ... });
const generalLimiter = rateLimit({ windowMs: 15*60*1000, max: 300, ... });
```
No `store` option → `express-rate-limit` uses `MemoryStore`, which is **per-process**. With 3 replicas the effective limits become 30 and 900. It also leaks memory proportional to unique IPs, and every counter resets on deploy.

**Fix.**
```js
const { RedisStore } = require('rate-limit-redis');
const generalLimiter = rateLimit({
  windowMs: 15*60*1000, max: 300,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  standardHeaders: 'draft-7', legacyHeaders: false
});
```

---

### I-9. `trust proxy` is not set — rate limiting is keyed on the load balancer's IP
**Severity: HIGH**
**File:** `server/index.js:14` (`const app = express();` — no `app.set('trust proxy', ...)` anywhere)

Behind nginx/ALB/Cloudflare, `req.ip` resolves to the proxy's address for **every** client. All users share one rate-limit bucket: the 10-request auth limit is consumed globally in seconds, locking everyone out. `express-rate-limit` v8 also emits `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` and may refuse to start when it detects `X-Forwarded-For` without `trust proxy`.

**Fix.** `app.set('trust proxy', 1)` (or the exact hop count / subnet). Never `true` in production — that lets clients spoof `X-Forwarded-For` and bypass limits entirely.

---

### I-10. Socket.io has no adapter — real-time silently breaks the moment you run 2 instances
**Severity: CRITICAL (blocks horizontal scaling)**
**File:** `server/index.js:128-133`

```js
const io = new Server(server, { cors: {...} });
```
Default in-memory adapter. `io.to(userId).emit(...)` (`notificationHelper.js:28`, `commentController.js:106-109`) only reaches sockets connected to **this** process. With 3 replicas, ~67% of notifications are silently dropped. There is also no `transports` config, so long-polling is enabled — and without sticky sessions the polling handshake fails across replicas.

**Fix.**
```js
const { createAdapter } = require('@socket.io/redis-adapter');
const pub = new Redis(process.env.REDIS_URL), sub = pub.duplicate();
io.adapter(createAdapter(pub, sub));
```
Plus either sticky sessions at the LB, or `transports: ['websocket']` to skip the polling handshake entirely.
Additionally, `index.js:150` does a `User.findById` per handshake — cache it (C-2).

---

### I-11. No clustering — one CPU core is used regardless of instance size
**Severity: MEDIUM**
**File:** `server/index.js:199` (single `server.listen`), `server/package.json:7` (`"dev": "nodemon index.js"`, no `start` script at all)

There is no `start` script, so `npm start` fails. There is no `cluster` module usage, no PM2 config, no Dockerfile. On a 4-vCPU box, 3 cores idle while the single event loop is stalled by the synchronous work in X-3 and P-3.

**Fix.** Add `"start": "node index.js"` and run under PM2 cluster mode (`pm2 start index.js -i max`) or K8s with `replicas: N`. **Prerequisites:** I-8 (Redis rate-limit store), I-10 (Socket.io adapter), Q-3 (distributed cron lock) must land first, or scaling out will cause duplicate cron execution and dropped notifications.

---

### I-12. No request timeout — a slow handler pins a connection indefinitely
**Severity: MEDIUM**
**File:** `server/index.js` (no `connect-timeout`, no `server.requestTimeout` set)

Combined with X-4 (no outbound timeouts), `POST /api/gmail/fetch` can hold a connection for many minutes.

**Fix.**
```js
server.requestTimeout = 60_000;      // Node 18+ built-in
server.headersTimeout = 66_000;
server.keepAliveTimeout = 65_000;
```
and once Q-1 lands, the fetch endpoint returns `202` immediately so the timeout is never approached.

---

### I-13. `console.log` everywhere — unstructured, unsampled, and on the hot path
**Severity: MEDIUM**
**Files:** `gmailController.js:327, 409, 439, 454, 466, 480, 832, 845`; `activityLogger.js:14`; `notificationHelper.js:29`; `cronJobs.js:16, 27, 30, 76, 96, 98`; `index.js:171, 177, 185, 190`

`gmailController.js:439` logs **one line per email saved** including the subject. `notificationHelper.js:29` logs every socket emit. `cronJobs.js:16` logs "Checking for pending tasks" **every 60 seconds forever**. `index.js:171/190` logs every socket connect/disconnect.

`console.log` to a pipe is **synchronous** on Linux when stdout is a pipe (which it is under Docker/PM2) — each call blocks the event loop until the write completes. During a 150-email sync that is 150+ blocking writes. There are also no request ids, so tracing a single request across the log stream is impossible.

**Fix.** `pino` + `pino-http` (async, JSON, ~5× faster):
```js
const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'info',
  redact: ['req.headers.authorization', '*.gmailAccessToken', '*.gmailRefreshToken', '*.password'] });
app.use(require('pino-http')({ logger, genReqId: () => crypto.randomUUID() }));
```
Demote all the per-item sync logs to `logger.debug`, and log one summary line per sync instead of one per email. Note the redaction list — `gmailController.js` currently logs objects that could contain tokens on error paths (`:224`, `:371`).

---

### I-14. Global error handler is registered before some routes and after none of the async ones
**Severity: LOW–MEDIUM**
**File:** `server/index.js:107-113`

The handler is correctly last, but **every controller wraps itself in try/catch and returns `res.status(500)` directly**, so the handler is effectively dead code. That means: no centralised error metrics, no request-id correlation, no distinction between a Mongo timeout and a validation error. Also, `express.json()` parse errors (malformed body) do reach it and are returned as a generic `Internal Server Error` with a 500 instead of a 400.

**Fix.** Adopt `express-async-errors` (or a `wrap(fn)` helper), delete the ~40 duplicated try/catch blocks, and let the single handler classify by `err.name` (`ValidationError` → 400, `CastError` → 400, `MongoServerError code 11000` → 409, `MongooseError timeout` → 503).

---

# Prioritised remediation plan

### Phase 1 — stop the bleeding (1–2 days, no new infrastructure)
1. **P-1/D-4** — add `select: false` to `Email.body` in the schema; add `.select()`/`+body` at the 4 call sites. *Single highest-impact change in this audit.*
2. **P-1/P-2/P-4/P-5** — add `limit`/`page` to `/api/gmail/emails`, `/api/tasks`, `/api/users/activity-logs`, `/api/notifications`. Default page size 25–50, hard cap 100.
3. **C-4** — delete `await deduplicateConnections()` from `getConnectedStatus` (`gmailController.js:633`).
4. **D-1** — add the 17 missing indexes; deploy with `autoIndex: false` + an explicit `syncIndexes()` step.
5. **D-3** — add `.lean()` to all read-only queries.
6. **I-7** — add `compression`.
7. **I-1** — add connection-pool options.
8. **I-9** — `app.set('trust proxy', 1)`.
9. **X-3** — slice before regex in `aiController.js:24` and `taskHelper.js:48`.
10. **I-2** — remove the boot-time `$nin` cleanup and seeder from `connectDB`.

Expected effect: inbox response drops from ~60 MB to ~40 KB; dashboard from ~1.5 s to ~150 ms; the OOM-crash class of failure is eliminated.

### Phase 2 — remove blocking work (3–5 days, +Redis)
11. **Q-1** — BullMQ; move Gmail sync off the request path; `insertMany` + `p-limit(10)`.
12. **C-6** — hoist and cache `KeywordRule.find({isActive:true})` out of the message loop.
13. **D-6** — cache the client matcher.
14. **Q-2** — bulk-write the overdue cron.
15. **Q-4/Q-5** — queue nodemailer; timeout + cache + circuit-break Gemini.
16. **X-4** — timeouts on all googleapis/SMTP/Gemini calls.
17. **C-1/C-2/C-3** — Redis cache-aside for reports + auth user lookup.
18. **D-5/D-9** — rewrite the 6 JS-side aggregations as `$group`/`$facet` pipelines.

### Phase 3 — make it horizontally scalable (2–3 days)
19. **I-10** — `@socket.io/redis-adapter`.
20. **I-8** — `rate-limit-redis`.
21. **Q-3** — BullMQ repeatable jobs replace `node-cron`; add `Task.linkedEmail` unique sparse index.
22. **I-4/I-6** — graceful shutdown + exit-on-uncaught.
23. **I-5** — `/healthz` + `/readyz`, moved outside `/api`.
24. **I-13** — pino structured logging with token redaction.
25. **I-11** — `start` script + PM2 cluster / K8s replicas.
26. **I-12** — request timeouts.
27. **D-2** — text index for email search; move the retroactive keyword scan to a queued job.

### Architectural follow-up
- Stop inlining base64 images into `Email.body` (`gmailController.js:376-379`). Store attachments in S3/GridFS keyed by `messageId+attachmentId`; serve inline images through the existing `downloadAttachment` route. This removes the 16 MB document-size risk, the multi-MB regex work, and the bulk of the memory pressure at its source.
- Add incremental Gmail sync via `users.history.list({ startHistoryId })` instead of re-listing 150 messages per account every 10 minutes.
- Denormalise `Email.clientId` at ingest so client statistics become an indexed `$group` instead of N regex scans.
