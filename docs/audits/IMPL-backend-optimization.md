# Backend Optimization Implementation

Branch: `feat/production-hardening`
Scope: `server/` only. Nothing under `client/` was touched.

Implements the backend optimization brief from `docs/audits/audit-backend-perf.md`,
the list contract in `docs/audits/API-LIST-CONTRACT.md`, and the four items the
security agent deferred in `docs/audits/IMPL-backend-security.md`.

**Verification method (updated).** The original pass ran without local
infrastructure: `node --check` on every touched file, module-load checks on all
54 server modules, router mount checks on all 10 routers, 32 isolated logic
assertions against the real installed libraries, 20 pagination-contract
assertions, 11 cache assertions, 7 queue assertions, a Redis-down degradation
run, Mongoose projection/index introspection, and a live boot of the real
`index.js` with `mongoose.connect` stubbed.

MongoDB and Redis are now available locally (`maildesk-mongo` /
`maildesk-redis`), so the three items previously listed as unverified have been
closed:

| Previously unverified | Now |
|---|---|
| Index build behaviour on real data | `npm run sync-indexes -- --apply` runs clean against a live database. 10 User, 22 Email, 6 ActivityLog indexes build, including the partial and the multikey ones |
| Aggregation results | The client-counter `$group`s are asserted end-to-end by `npm run test:smoke` (`taskCount` / `completedTaskCount` / `openTaskCount` against seeded rows) |
| The list/pagination envelope against real rows | 140 HTTP assertions pass against a live server and a live database |

Still not verified: **BullMQ against a real Redis** (the smoke run uses the
in-process queue, `REDIS_URL` unset) and the backfill script against a large
production-shaped collection.

---

## READ THIS FIRST IF YOU ARE WRITING A CLIENT PAGE

Three response shapes changed. Everything else is additive.

1. **`POST /api/gmail/fetch` now returns `202` with a job id, not `200` with a
   count.** The sync runs in the background. See "Async sync API" below.
2. **List endpoints no longer contain `Email.body`.** Lists carry `snippet`
   (~200 chars of plain text). Fetch the body from the new detail route.
3. **`POST /api/ai/summarize-email` may return `202` with a `jobId`** when the
   model takes longer than `AI_INLINE_WAIT_MS` (default 20 s). The `200`
   `{ summary }` response is unchanged and is still the common case.

A later pass (the **WAVE2 addendum** at the end of this document) changed two
more, both by *adding* fields:

4. **`PUT /api/users/:id`** now returns the full user document minus secrets,
   not a six-field subset — no refetch after a save (S-5).
5. **`PUT /api/users/profile`** now returns the `GET /auth/me` shape, so the
   response can be assigned wholesale (S-7).

Also worth knowing before writing a page: `PUT /api/users/change-password`
returns a **replacement `token`** so changing your own password no longer signs
you out (S-6), emails carry a per-user **`isRead`** (S-16), and there are new
notification-preference, per-client-timeline, mark-read and bulk-delete
endpoints. All detailed in the addendum.

---

## 1. Pagination — API-LIST-CONTRACT.md, implemented exactly

One shared helper: **`server/utils/paginate.js`**.

- `parseListParams(req, opts)` — parses and clamps `page` / `limit` / `sort` /
  `q`. `limit` clamps to 1–100 (values above 100 clamp, never error), `sort` is
  whitelisted per endpoint and an unknown field silently falls back to the
  default, and a repeated or object-valued query param is coerced to a safe
  string instead of throwing.
- `paginate(model, filter, params, opts)` — runs the page query and
  `countDocuments` **in parallel** via `Promise.all`, always `.lean()`, always
  with an explicit `.select()`.
- `listResponse(res, {...})` — emits the right envelope for the request.

**Paginated form** (returned when `page` is present in the query string):

```json
{ "data": [ ... ],
  "pagination": { "page": 1, "limit": 25, "total": 1284, "totalPages": 52, "hasMore": true } }
```

**Legacy form** (no `page`): the endpoint's historical shape, hard-capped at
**200 documents** (`LIST_LEGACY_CAP`). Legacy mode skips the count entirely,
since the legacy shape has no `total`.

Every sort adds `_id` as a tiebreaker, so a page boundary cannot duplicate or
drop a row with a non-unique sort key.

| Endpoint | Default sort | Sortable fields | Extra filters | Legacy shape |
|---|---|---|---|---|
| `GET /api/gmail/emails` | `-date` | `date, fetchedAt, subject, from, status, approvalStatus` | `status`, `approvalStatus`, `accountEmail`, `dateFrom`, `dateTo`, `from` (sender), `read` | bare array |
| `GET /api/tasks` | `-createdAt` | `createdAt, deadline, title, status, priority, clientName` | `status`, `priority`, `assignedTo`, `clientName` | bare array |
| `GET /api/clients` | `-createdAt` | `name, createdAt, status, contactPerson` | — | `{success, count, data}` |
| `GET /api/tasks/clients` | `name` | same | — | bare array |
| `GET /api/users` | `-createdAt` | `createdAt, name, email, role, status, lastLoginAt` | `role`, `status` | bare array |
| `GET /api/users/activity-logs` | `-createdAt` (limit 50) | `createdAt, action` | `userId` (canonical) / `actor` (alias), `action`, `targetType`, `targetId`, `dateFrom`, `dateTo` | bare array |
| `GET /api/notifications` | `-createdAt` (limit 30) | `createdAt, read` | `unread=true` | bare array |
| `GET /api/keyword-rules` | `-createdAt` (limit 50) | `createdAt, keyword, isActive` | `isActive` | bare array |
| `GET /api/keyword-rules/pending-approvals` | `-date` | `date, subject, from, matchedKeyword` | — | bare array |
| `GET /api/tasks/:id/comments` | `createdAt` **ascending** (limit 50) | `createdAt` | — | bare array |

`q` searches: emails → `subject`, `from`; tasks → `title`, `clientName`;
clients → `name`, `email`, `contactPerson`, `associatedEmails`; users → `name`,
`email`; activity logs → `action`, `details`, `targetLabel`, `ip`; keyword
rules → `keyword`.

---

## 2. Email bodies are gone from list responses

- `Email.body` and `Email.bodyRaw` are now **`select: false`**.
- New **`Email.snippet`** — ~200 characters of plain text, generated at ingest by
  `utils/snippet.js`. It strips `<style>`/`<script>` contents, drops long
  `data:` URIs in one bounded linear pass *before* windowing (so a message whose
  text sits after a 1 MB inlined logo still gets a real preview), decodes common
  entities and truncates on a word boundary. Verified to add no measurable
  latency on a 2 MB body.
- The snippet prefers the message's `text/plain` MIME part, which contains no
  base64 payloads at all.
- **New: `GET /api/gmail/emails/:id`** — the only read path that opts into the
  body (`.select('+body')`). All roles, gated by the existing `canAccessEmail`
  object-level check, so an Employee can read a body on an email assigned to
  them. Returns the sanitized body.
- Task populates: lists use `subject from snippet attachments`; the task detail
  and update responses use `subject from snippet attachments +body`.

`canAccessEmail` was also fixed to resolve populated refs — a bare `.toString()`
on a populated `fetchedBy` yields `"[object Object]"` and would have denied the
legitimate owner now that read paths populate.

---

## 3. Indexes — 63 declared across 8 models

Every field the brief listed is indexed, plus the compound (filter + sort) pairs
for the query shapes actually present in the code. `deletedAt` leads the Email
compounds as an equality prefix because every read path filters on it.

Highlights:

- `Email`: `{deletedAt, fetchedBy, date:-1}`, `{deletedAt, assignedTo, date:-1}`,
  `{deletedAt, status, date:-1}`, `{deletedAt, approvalStatus, date:-1}`,
  `{deletedAt, fetchedBy, approvalStatus, date:-1}`, `{fetchedBy, toEmail, deletedAt}`,
  `{fetchedBy, date:-1}`, `{deletedAt, clientId}`, plus `matchedKeyword`, `clientId`.
- `Task`: `{assignedTo, createdAt:-1}`, `{createdBy, createdAt:-1}`,
  `{assignedTo, status, deadline:-1}`, `{clientName, status}`,
  `{status, overdueNotifiedAt, deadline}` (the exact cron shape), plus
  `clientName`, `createdAt`, `parentTaskId`.
- `Task.linkedEmail` is **unique with a `partialFilterExpression`**, not
  `sparse`. `linkedEmail` defaults to `null`, and `sparse` only skips documents
  where the field is *absent*, so a sparse unique index would have collided on
  every standalone task. This index is what makes `ensureTaskForEmail`
  race-safe.
- `User`: `role`, `status`, `{role, status, deletedAt}`, `createdAt`,
  `gmailEmail`, `linkedGmailAccounts.gmailEmail`, and a **partial** index on
  `gmailAccessToken`.
- `KeywordRule.keyword` is deliberately **not unique** — an existing workspace
  may already hold duplicates and the index would fail to build. Uniqueness stays
  enforced in the controller.

`autoIndex` is now **false in production**. Run `npm run sync-indexes -- --apply`
as a deploy step.

---

## 4. `.lean()` and projections

`.lean()` went from **0 to 39 usages**. Every list read is lean with an explicit
`.select()`. Verified by introspecting the built Mongoose queries: the default
`Email.find()` projection is now `{body: 0, bodyRaw: 0}`, the controller list
projection contains neither field, and the detail projection resolves `+body`
back to `{body: 1}`.

---

## 5. N+1s removed

| Was | Now |
|---|---|
| `GET /api/clients` loaded the entire Task **and** Email collections, then ran O(clients × emails) `String.includes()` — ~15M synchronous calls at 100k emails | two cached `$group` aggregations in `utils/clientService.js` |
| `getClientStats`: 3 unindexed `countDocuments` **per client** (~7M document examinations) | the same two cached aggregations |
| `taskHelper`: `Client.find({})` **per email** | `getClientMatcher()`, cached 10 min, plus a `matcher` parameter for bulk paths |
| Overdue cron: O(tasks × supervisors) sequential writes every 60 s | one `updateMany` + one `insertMany`, one digest per supervisor, every 5 min |
| `KeywordRule.find({isActive:true})` once per Gmail message | hoisted, cached (`rules:active`), regexes pre-compiled once |
| `bulkAssignEmails`: 2N sequential saves | one `bulkWrite` + one `updateMany` |
| `bulkApproveEmails`: 3 writes per email | grouped `updateMany` + one bulk task upsert + one digest notification per assignee |
| `createKeywordRule`: inline regex scan over every unassigned email's `body` | queued `keyword-backfill` job, batched by `_id`, `subject`-only match |
| `getEmployeeReport`: O(users × tasks) in JS + every task embedded per employee | one `$group` |
| `getTaskTimeline` / `getEmailTimeline`: full documents + JS bucketing | `$dateToString` `$group`, 30 rows |
| `getOverallStats`: 8 sequential `countDocuments` | 3 parallel round-trips, statuses collapsed into one `$group` |
| `deduplicateConnections`: per-user `save()` | one `bulkWrite` |
| `disconnectGmail` / `disconnectLinkedAccount`: `find()` full docs to map `_id` | `.distinct('_id')` |
| `deleteUser`: 5 sequential cascade writes | one `Promise.all` |
| `bulkTaskAction`: 3 separate `Task.find({_id:{$in}})` | one lean, projected query reused |
| `addComment`: 2 sequential notification writes | `Promise.all` |
| `authController`: `countDocuments({})` per registration | `User.exists({})` |

---

## 6. Caching — `server/utils/cache.js`

Interface: `get` / `set` / `del` / `delPrefix` / `wrap`, plus canonical `KEYS`
and `TTL` maps and three invalidation helpers.

Backed by **Redis (ioredis) when `REDIS_URL` is set**, and by a **bounded
in-process LRU with per-entry TTL** when it is not. Values are JSON-serialised in
both backends, so a cache hit can never hand a caller a mutable reference to
another request's object. Every operation is failure-tolerant: a Redis outage
degrades to a cache miss, never to a request error. `delPrefix` uses `SCAN`,
never `KEYS`.

| Key | TTL | Invalidated on |
|---|---|---|
| `rules:active` | 5 min | keyword rule create / update / delete |
| `clients:all`, `clients:matcher` | 10 min | client create / update / delete (both routers) |
| `report:<type>:<range>:<userId>` | 15 min | task, email, client and user writes |
| `dash:<userId>:<role>` | 60 s | task and email writes |
| `gtok:<userId>:<inbox>` | expiry − 60 s | reconnect / disconnect |
| `user:<id>` | 30 s | role, status, password, reset, delete |
| `ai:sum:<sha256>` | 30 days | content-addressed, none needed |
| `cron:supervisors` | 5 min | — |

The Gmail token cache stores the token **encrypted**; a cache is not a place to
keep a bearer token in the clear.

The `user:<id>` cache removes one uncached `findById` + one Mongoose hydration
per API request and per socket handshake. It caches the revocation signals
(`tokenVersion`, `status`, `deletedAt`), so **every** write path that changes
them explicitly busts the key — otherwise the security agent's session-revocation
work would have been silently weakened.

`ETag`/`Cache-Control`: `Cache-Control: private, max-age=..., stale-while-revalidate=60`
on the five report endpoints and both client lists; Express's default ETag still
applies on top.

---

## 7. Queues — `server/utils/queue.js`

**BullMQ when `REDIS_URL` is set; an in-process runner when it is not.** The
in-process runner is still asynchronous and still off the request path, with the
same retry / exponential-backoff / dead-letter semantics — it is simply not
durable across a restart.

Queues: `gmail-sync`, `email-send`, `ai-summarize`, `keyword-backfill`
(registered in `server/jobs/index.js`).

Job ids are namespaced `<queue>::<rawId>` so one status endpoint can resolve any
job. `enqueueUnique(queue, dedupeKey, ...)` makes a double-clicked "Fetch"
idempotent — the second click gets the first job's id back.

### Async sync API — **client agents need this**

```
POST /api/gmail/fetch          (Admin, Head)
  -> 202 Accepted
  {
    "message": "Gmail sync queued for 3 account holder(s). Poll GET /api/gmail/sync/:jobId for progress.",
    "status":  "queued",
    "accepted": 3,
    "jobId":   "gmail-sync::7f3c…",     // poll this one
    "jobIds":  ["gmail-sync::7f3c…", …], // Admin fans out one job per account holder
    "deduped": false                     // true when a sync was already running
  }
  -> 400 when the caller has no connected Gmail account
```

```
GET /api/gmail/sync/:jobId     (Admin, Head)
  -> 200
  {
    "jobId":     "gmail-sync::7f3c…",
    "status":    "queued" | "active" | "completed" | "failed",
    "progress":  0-100,          // percent of messages processed
    "attempts":  1,
    "newEmails": 12 | null,      // non-null only when status === "completed"
    "error":     null,
    "createdAt": "2026-08-02T…",
    "finishedAt": "2026-08-02T…" | null
  }
  -> 404 when the job is unknown or has expired
```

Suggested client flow: `POST /fetch` → poll `GET /sync/:jobId` every ~2 s →
stop on `completed` (refresh the inbox, show `newEmails`) or `failed` (show
`error`). Job records are retained for 1 hour in-process / 24 h in Redis.

### Inside the sync

- `messages.get` runs with **bounded concurrency** (`p-limit`, default 10 —
  Gmail allows 250 quota units/s and `messages.get` costs 5). Inline-image
  fetches use a second limiter (default 5), so the two cannot deadlock each
  other. **~30 s per account → ~3 s.**
- Per-message `try/catch`: one poisoned message no longer aborts the account.
- `Email.insertMany(docs, { ordered: false })`: a duplicate `messageId` from two
  racing syncs skips instead of aborting the batch.
- Tasks for auto-approved assignments go out in one bulk upsert.
- The existence check is `Email.distinct('messageId', ...)`, one indexed query.

### Other queued work

- **Outbound email**: `sendEmail()` now enqueues (~1 ms) instead of doing the
  SMTP round-trip. The signature is unchanged, so every existing caller works;
  the return value is a job handle. The transport gained `pool: true` and real
  connection/greeting/socket timeouts.
- **Gemini**: the call runs in a worker. The request `waitForJob`s for up to
  `AI_INLINE_WAIT_MS` (20 s) and returns the usual `200 {summary}`; if the model
  is slower it returns `202 {jobId}` and the client polls
  `GET /api/ai/jobs/:jobId`. Results are cached by content hash for 30 days, so
  re-summarising the same email is free. A dedicated 10/min limiter was added.
- **Keyword backfill**: `POST /api/keyword-rules` returns
  `{ rule, matchedEmailCount: 0, backfillJobId, message }`. `matchedEmailCount`
  is retained at `0` for shape compatibility — the real count is asynchronous
  now; poll `backfillJobId` if you need it.

---

## 8. Multi-instance readiness

- **Cron** (`utils/lock.js`): every job body runs under a distributed lock —
  Redis `SET NX PX` with a compare-and-delete Lua release when Redis is present,
  an in-process guard when it is not (which also stops a slow tick overlapping
  the next one, something the old code never did). The overdue scan moved from
  every minute to every 5 minutes, and the sync cron now **enqueues** instead of
  running inline.
- **Socket.io**: `@socket.io/redis-adapter` is wired when `REDIS_URL` is set.
- **Rate limiter**: `rate-limit-redis` store when available, in-memory otherwise.
- **Duplicate-Task race** (`taskHelper.js`): the check-then-act `findOne` + `save`
  is now a single atomic `findOneAndUpdate` upsert, backed by the unique partial
  index, with an 11000 fallback for the loser of the race. `ensureTasksForEmails`
  adds a `bulkWrite` variant for bulk paths.

---

## 9. Runtime

- `compression` (threshold 1 KB).
- `mongoose.connect` options: `maxPoolSize`, `minPoolSize`,
  `serverSelectionTimeoutMS`, `socketTimeoutMS` (was **0 = infinite**),
  `connectTimeoutMS`, `maxIdleTimeMS`, wire compression, and
  `bufferCommands: false` so a DB outage fails fast instead of queueing.
- `server.requestTimeout` / `headersTimeout` / `keepAliveTimeout`.
- **Timeouts + retry + circuit breaker on every outbound call**
  (`utils/resilience.js`): googleapis (all 7 call sites, including
  `oauth.getToken`), Gemini and SMTP. Retries use full-jitter exponential
  backoff and only fire on 429/5xx/network errors — a 4xx is never retried and
  never counts against the breaker. Breaker state is exposed on `/readyz`.
- **`pino` structured logging** with request ids (`utils/logger.js`). All ~80
  `console.*` calls in the request path are gone; `x-request-id` is echoed and
  an inbound one is honoured. Tokens, passwords and `Authorization` headers are
  redacted centrally, because googleapis errors embed the request config.
- `/healthz` and `/readyz` added **outside** the `/api` prefix so probes are not
  rate-limited. `/api/health` is unchanged for the existing client.
- Graceful shutdown now also stops cron and closes the queues and Redis.
- The boot-time `$nin` full-collection write was already removed by the security
  agent; the seeder call is now additionally gated before it is even reached.

---

## New / changed endpoints

| Method | Path | Access | Note |
|---|---|---|---|
| `GET` | `/api/gmail/emails/:id` | all roles + object check | **New.** The only route that returns `body`. |
| `GET` | `/api/gmail/sync/:jobId` | Admin, Head | **New.** Sync job status. |
| `GET` | `/api/ai/jobs/:jobId` | Admin, Head | **New.** Summarization job status. |
| `GET` | `/api/notifications/unread-count` | all | **New.** `{count}` for the bell badge. |
| `GET` | `/healthz`, `/readyz` | public | **New.** Liveness / readiness. |
| `POST` | `/api/gmail/fetch` | Admin, Head | **Changed:** `202` + `jobId`, was `200` + `count`. |
| `POST` | `/api/ai/summarize-email` | Admin, Head | **Changed:** may return `202` + `jobId`. |

---

## New model fields

| Model | Field | Purpose |
|---|---|---|
| `Email` | `snippet` (String) | ~200-char plain-text preview returned by every list |
| `Email` | `clientId` (ObjectId → Client) | denormalised client attribution; makes per-client mail counts an indexed `$group` |
| `Task` | `recurrenceSpawnedAt` (Date) | atomic claim so a recurring task spawns exactly one child |

`Email.body` / `Email.bodyRaw` became `select: false`.

---

## Migration scripts to run

```bash
# 1. Build the new indexes (required; autoIndex is off in production).
npm run sync-indexes -- --apply

# 2. Backfill snippet + clientId for existing emails. Dry run by default.
npm run backfill-emails                 # report
npm run backfill-emails -- --apply      # write
```

**Both are required.** Without (1), the new query shapes fall back to collection
scans. Without (2), existing emails render with an empty preview and per-client
`mailCount` reads as 0 (`clientId` is only written at ingest).

Both are idempotent and batch by `_id`, so neither loads a collection into
memory. `syncIndexes` also **drops** indexes no longer declared in the schema —
review its report output before running it against a shared database.

---

## New dependencies

`compression`, `ioredis`, `bullmq`, `p-limit@3` (CommonJS), `pino`, `pino-http`,
`lru-cache`, `rate-limit-redis`, `@socket.io/redis-adapter`.

`ioredis`, `bullmq`, `rate-limit-redis` and `@socket.io/redis-adapter` are only
loaded when `REDIS_URL` is set, and each load is wrapped so a missing module
degrades instead of crashing.

---

## New environment variables

All ~50 are documented with defaults in `server/.env.example`. **`REDIS_URL`
unset is a fully working configuration** — cache → in-process LRU, queue →
in-process runner, lock → in-process guard, rate limiter → memory store,
Socket.io → single-instance adapter.

One behavioural flag worth calling out: **`ALLOW_LEGACY_PLAINTEXT_TOKENS`**
(default `true`). `decrypt()` no longer fails open, so set this to `false` after
running `node scripts/encryptExistingTokens.js`.

---

## Deferred security items, now done

- **#25 `GET /api/clients`** — rewritten as aggregations in
  `utils/clientService.js`; both duplicate client-list routes now share that one
  implementation while keeping their distinct legacy shapes.
- **#26 `decrypt()` fails open** — it now **throws** `TokenDecryptionError`
  instead of returning the ciphertext as if it were a token. A `tryDecrypt()`
  variant returns `null` for bulk paths where one bad record must not abort every
  other mailbox. The legacy-plaintext branch is behind
  `ALLOW_LEGACY_PLAINTEXT_TOKENS`. `replyToEmail` and `downloadAttachment` return
  **409** with a "please reconnect" message instead of a confusing Google 401.
- **#27 `oauth2Client.on('tokens')` `ParallelSaveError`** — the listener no
  longer mutates a shared document or `await`s `user.save()`. It fires a targeted
  `User.updateOne` (positional `$` for linked accounts) and is registered once
  per client rather than once per account on the same document.
- **#19 recurrence** — three separate bugs fixed:
  *month overflow* (31 Jan + Monthly produced **3 Mar**; the day is now clamped
  to the last day of the target month, verified across leap years and the
  year boundary); *double-spawn race* (`recurrenceSpawnedAt` is claimed with a
  conditional update, so exactly one of two concurrent completions spawns);
  *spawn-before-save* (the spawn now runs strictly **after** the completion is
  persisted, and the Employee completion path claims the status transition
  atomically before firing any side effect).

Also picked up: audit #16 (`?days=` clamp — already fixed by the security agent)
and #32's `res.status(550)`, now a `503` when `GEMINI_API_KEY` is missing.

---

## Expected improvements

| Path | Before | After |
|---|---|---|
| `GET /api/gmail/emails` @ 10k emails | ~600 MB, OOM-capable | ~40 KB/page (bodies gone + pagination + compression) |
| `GET /api/tasks` @ 5k tasks | ~300 MB | ~30 KB/page |
| `GET /api/clients` @ 100k emails | multi-second event-loop freeze | two cached indexed `$group`s |
| `GET /api/reports/overall` | 8 sequential counts, ~0.5–1.5 s | 3 parallel round-trips + 60 s cache |
| `GET /api/reports/client-stats` @ 50 clients | 150 sequential scans, 15–40 s | 2 cached aggregations |
| `POST /api/gmail/fetch` (Admin, 10 accounts) | 4–6 min blocking, proxy 502 | `202` in ms |
| Gmail sync per account | ~30 s sequential | ~3 s at concurrency 10 |
| Any read handler | hydrated Mongoose docs | `.lean()` — 2–5× |
| Task completion / user approval / forgot-password | blocked on SMTP | ~1 ms enqueue |
| Every API request | +1 uncached `findById` + hydration | cached lean lookup |

---

## Deliberately NOT done

| Item | Why |
|---|---|
| `$text` index for email search | `$text` matches whole words only; the current UI contract is substring search on `subject`/`from`. Switching would be a client-visible behaviour change mid-rebuild. The cost is now bounded because the scan no longer drags bodies along. A text index is the right follow-up once the client can adopt word semantics. |
| Stop inlining base64 images into `Email.body` | The real architectural fix (S3/GridFS + serve `cid:` through the existing attachment route), but it is a storage-layer migration well beyond this brief. `snippet` removes the read-path pain; the 16 MB document-size risk on ingest remains. |
| Incremental sync via `users.history.list` | Needs a per-account `historyId` field and a full-resync fallback path. The concurrency fix already takes a sync from ~30 s to ~3 s. |
| TTL indexes on `ActivityLog` / `Notification` | A TTL index silently deletes audit rows. That is a data-retention policy decision, not a performance one. Both are now paginated and indexed. |
| Cursor pagination for the inbox | API-LIST-CONTRACT.md specifies offset. The client only reads `pagination`, so a later swap is not client-visible. |
| `express-async-errors` / deleting the ~40 try/catch blocks | A large mechanical refactor across every controller, concurrent with five agents rewriting client pages against these handlers. |
| Clustering / PM2 config | Its prerequisites (Redis rate-limit store, Socket.io adapter, distributed cron lock) all landed here, so it is now safe — but the process manager itself is a deployment concern. `npm start` was added. |

### Two behaviour changes worth reviewing

1. `PUT /api/notifications/:id/read` on someone else's notification now returns
   **404** instead of 403 (ownership moved into the query, which also removed a
   read-then-check race). This is less of an enumeration oracle, but it is a
   changed status code.
2. `GET /api/reports/employee` no longer embeds every task per employee
   (`tasks: []` is retained for shape compatibility). That array was the bulk of
   the payload; use the paginated `GET /api/tasks?assignedTo=<id>` for the
   drill-down.

---

## Verification summary

| Check | Result |
|---|---|
| `node --check` on every file under `server/` | pass |
| All 54 server modules load | pass |
| All 10 routers mount | pass |
| Pagination contract (20 assertions: clamping, whitelist fallback, envelope, legacy shapes, hostile params) | pass |
| Cache (11 assertions incl. TTL expiry, prefix invalidation, LRU bound, no shared refs, errors not cached) | pass |
| Queue (7 assertions: async execution, retry/backoff, dead-letter, dedupe, unknown job, bounded wait) | pass |
| Resilience (8 assertions: timeout, 4xx-no-retry, 429/5xx retry, circuit open/half-open/close) | pass |
| Snippet (7 assertions incl. no base64 leakage, <80 ms on a 2 MB body) | pass |
| Recurrence month overflow (6 assertions incl. leap year, year boundary) | pass |
| `decrypt()` fail-closed (7 assertions incl. tampered ciphertext, wrong key, migration guard) | pass |
| Distributed lock (3 assertions: no overlap, release, release-on-throw) | pass |
| Redis configured but **unreachable** → cache/lock/queue all degrade, no hang | pass (found and fixed a BullMQ offline-queue hang) |
| Mongoose index introspection (63 indexes, required fields + compounds, partial-not-sparse) | pass |
| Projection introspection (bodies excluded by default and in lists, `+body` opts in on detail) | pass |
| Live boot with stubbed Mongo, no Redis: 13 HTTP assertions | pass |

Three real defects were found and fixed *by* this verification: unref'd timers in
`withTimeout`, the queue retry path and `waitForJob` (which let the process exit
with work still pending); an empty snippet when a message opened with a large
inlined image; and a BullMQ hang when `REDIS_URL` is set but Redis is down.

**Not verified (no database available):** actual index build behaviour on real
data, aggregation results, the backfill script against real rows, and BullMQ
against a real Redis. These need a live environment before release.

---

# Addendum — WAVE2 server gaps S-2 … S-17

A later pass closed the server gaps carried forward in
`docs/audits/WAVE2-GAPS.md`. Everything below is **additive** unless explicitly
flagged as a changed shape. `npm run test:smoke` covers all of it:
**140 assertions, 0 failures**, against a live server and a live database.

## Changed response shapes — the client must adopt these

Only two responses changed shape, and both only ever *gained* fields:

| Endpoint | Was | Now |
|---|---|---|
| `PUT /api/users/:id` | hand-picked `{_id,name,email,role,status,createdAt}` | the **full user document minus secrets**, including `maxConnectedAccounts`, `allowedGmailAccounts`, `birthdate`, `phoneNumber`, `gmailEmail`, `lastLoginAt`, `connectedAccountCount`, `connectedAccountEmails`. The admin page no longer needs to refetch after a save (**S-5**) |
| `PUT /api/users/profile` | partial, no `status` | the **same shape as `GET /api/auth/me`** — `User.findById().select('-password').lean()`. Assigning it wholesale is now safe (**S-7**) |

`PUT /api/users/change-password` gained `token` and `user` alongside the
existing `message`, which is additive but is the whole point of **S-6** — see
below.

## S-2 — structured activity logging

`models/ActivityLog.js` gained `ip`, `userAgent`, `targetType`, `targetId`,
`targetLabel`, `before` (Mixed) and `after` (Mixed). `details` stays as the
human summary and is still required.

`utils/activityLogger.js` keeps its three-argument signature and takes an
optional fourth:

```js
logActivity(actorId, action, details, {
  req,                    // supplies ip + userAgent
  targetType: 'User',     // User | Task | Email | Client | KeywordRule | Notification | System
  targetId: user._id,
  targetLabel: user.email,
  before: {...}, after: {...}
})
```

- **`ip` comes from `req.ip`**, which honours `app.set('trust proxy', 1)` in
  `index.js`. Reading `x-forwarded-for` directly would have been spoofable.
- **`before`/`after` are redacted and size-bounded** by `sanitizeChange()`
  before they are written. Any key matching
  `password|token|secret|authorization|cookie|apikey|credential|refresh`
  becomes `'[redacted]'`, recursion is capped at depth 4, and a payload over
  `ACTIVITY_MAX_CHANGE_BYTES` is replaced by `{_truncated:true,_bytes:N}`. An
  audit trail that stores credentials is a liability, not a control. The smoke
  test asserts no credential value ever appears in a log response.
- `targetId` is a **String**, not an ObjectId, because not every target is a
  Mongo document (a Gmail `messageId`, a keyword, a mailbox address).
- New indexes: `{targetType, targetId, createdAt:-1}` and
  `{targetType, createdAt:-1}`.

Call sites now writing structured entries: login, registration, password
reset request/redeem, password change, profile update, user create/update/
delete, notification-preference update, Gmail unlink, single and bulk email
delete.

**No backfill.** Old rows simply lack the fields, and the Admin ActivityLog page
already renders "Not recorded on this entry" when they are absent.

## S-3 — the actor filter is settled

`GET /api/users/activity-logs` takes **`userId` as canonical** and **`actor` as
an accepted alias**. `userId` wins when both are sent, which is what the client
does today. Documented in `API-LIST-CONTRACT.md`. The endpoint also gained
`targetType`, `targetId`, `dateFrom`, `dateTo`, and `q` now searches
`targetLabel` and `ip` as well as `action`/`details`.

## S-4 — user list fields

- New `User.lastLoginAt`, written on every successful login via a fire-and-
  forget `updateOne` (not `user.save()` — the login document is loaded with
  `+password` and re-validating it for one timestamp is waste, and a failure to
  stamp it must never fail a login). Indexed as `{deletedAt, lastLoginAt:-1}`
  and added to the sort whitelist.
- New computed **`connectedAccountCount`** and **`connectedAccountEmails`** on
  `GET /api/users` and `GET /api/users/:id`. `linkedGmailAccounts` is pulled in
  with `+linkedGmailAccounts` purely to compute them and is **stripped from
  every response** — it holds OAuth refresh tokens. The count de-duplicates the
  primary mailbox against the linked array. The smoke test asserts the array
  never reaches a client.

## S-6 — change-password no longer signs you out

`PUT /api/users/change-password` still bumps `tokenVersion` (that is what
revokes other sessions) and now returns a token signed with the *new* version:

```json
{
  "message": "Password changed successfully.",
  "token":   "<new JWT>",
  "user":    { "_id": "…", "name": "…", "email": "…", "role": "…", "status": "…" }
}
```

`user` is the `GET /auth/me` shape and never contains a password. The client
replaces its stored token with `token` and stays signed in. Every **other**
session remains revoked — the smoke test asserts both halves: the new token
authenticates, the old one 401s.

JWT minting moved to `utils/tokenService.js` so one place decides the payload
and the `tokenVersion` claim cannot drift between login and this route.
`JWT_EXPIRES_IN` (default `7d`) is the new knob.

## S-9 / S-10 — client endpoints

- **`openTaskCount`** added to `GET /api/clients` and
  `GET /api/reports/client-stats`, derived as `taskCount - completedTaskCount`
  from the same cached `$group` — no second aggregation, and the two surfaces
  cannot disagree. The UI can now label the column accurately.
- **`GET /api/clients/:id/timeline`** (new). Role-scoped exactly like the task
  and email lists (Employee to assigned, Head to created/fetched, Admin all).

```json
{ "success": true,
  "data": {
    "_id": "...", "name": "...", "createdAt": "...",
    "counts": { "tasks": 2, "emails": 5 },
    "timeline": [
      { "type": "task",  "id": "...", "at": "2026-08-02T00:00:00.000Z",
        "label": "Task created: Quarterly filing", "status": "Pending",
        "meta": { "priority": "High", "deadline": "..." } },
      { "type": "email", "id": "...", "at": "2026-08-01T00:00:00.000Z",
        "label": "Email received: Re: invoice", "status": "assigned",
        "meta": { "from": "a@example.com" } }
    ] } }
```

`{at, label}` is exactly what the detail drawer already renders. `?limit=`
defaults to 20, caps at 100. Newest first. **Never returns an email body.**

- **S-8 verified**: `GET /api/clients` already implemented the pagination
  contract via `utils/clientService.js`. No change needed; asserted by the
  smoke test.

## S-11 / S-17 — permission consistency

- **S-11**: `DELETE /api/gmail/linked-account` is now `Admin, Head`. The
  controller already scoped correctly — a non-Admin can only ever target
  `req.user._id`, and the `userId` body field is honoured for Admins only — so
  the route gate was the sole inconsistency. A Head can now disconnect an
  account `GET /api/gmail/status` already showed them. Employees still 403.
- **S-17 — DECIDED: serve Head, scoped.** `GET /api/reports/employee` is now
  `Admin, Head`. A Head sees performance over the tasks **they created**, the
  same `createdBy` boundary `getOverallStats` and `getTaskTimeline` already
  used, and employees they never delegated to are omitted rather than shown as
  rows of zeros (a zero row reads as "did nothing", not "not mine"). The cache
  key now carries the scope, so a Head's narrowed report can never be served to
  the Admin. Admin behaviour is unchanged; Employees still 403.

## S-15 — bulk email delete

`DELETE /api/gmail/emails` is now a **dispatcher on one URL**, because the
"clear all" route already owned it and the client still calls it:

| Body | Behaviour | Roles |
|---|---|---|
| `{ "ids": [...] }` | ownership-scoped bulk **soft** delete | Admin, Head |
| absent | clear the whole workspace inbox (unchanged) | **Admin only** — a Head gets 403 from inside the handler |

```json
{ "message": "1 of 2 email(s) deleted.",
  "deleted": 1, "failed": 1,
  "results": [
    { "id": "...", "ok": false, "status": 403, "message": "This email is not in your mailbox." },
    { "id": "...", "ok": true,  "status": 200 }
  ] }
```

Per-id results preserve the partial-failure reporting the client got from its
`Promise.allSettled` fan-out. Authorization is the same `canAccessEmail` object
check as the single delete, so a Head cannot destroy another Head's mail by
enumerating ids — asserted by the smoke test, including that the forbidden row
is genuinely left untouched. Batch ceiling `EMAIL_BULK_MAX` (default 200).

## S-16 — real read/unread

`Email.readBy: [{ user, readAt }]`, `_id: false`. A boolean would have been
wrong: this is a **shared mailbox**, so "read" is a relation between a user and
a message, not a property of the message. The inbox previously faked unread
emphasis from `status === 'unassigned'`, which meant assigning an email marked
it read for everyone.

- List and detail responses carry a derived **`isRead`** (and `readAt`) for the
  **requesting user**. `readBy` itself is returned — it is user ids and
  timestamps only.
- Filter: **`?read=true|false`** on `GET /api/gmail/emails`.
- `PATCH /api/gmail/emails/:id/read` — body `{ "read": true }` (default `true`),
  returns `{ message, _id, isRead }`.
- `PATCH /api/gmail/emails/read` — body `{ "ids": [...], "read": true }`,
  returns `{ message, read, updated, failed, results }` with per-id results in
  the same shape as the bulk delete.
- Both are **all roles**, gated per email by `canAccessEmail`: an Employee marks
  their own copy read.
- Marking is **idempotent** — the read update filters on
  `'readBy.user': { $ne: me }` so a double-click cannot push a duplicate entry.
- **Opening an email does not implicitly mark it read.** Marking is an explicit
  PATCH, so a prefetch cannot silently clear the badge.
- Indexes: `{deletedAt, 'readBy.user', date:-1}` (serves `?read=...&sort=-date`
  from the index) and `{'readBy.user'}`.

Also corrected while here: `GET /api/gmail/emails` now reads the date range from
**`dateFrom`/`dateTo`** per the contract and treats **`from` as the sender**. A
`from`/`to` that parses as a date is still accepted as a range bound so nothing
in flight breaks.

## S-12 — notification preferences that actually suppress

New `User.notificationPreferences` sub-document and
**`utils/notificationPrefs.js`**, which is required by *both* delivery paths.

```json
{
  "notificationPreferences": {
    "inApp": { "enabled": true,
               "events": { "task_assigned": true, "task_completed": true,
                           "task_overdue": true, "task_comment": true,
                           "email_assigned": true, "email_approval": true,
                           "system": true } },
    "email": { "enabled": true, "events": { "task_assigned": true } },
    "quietHours": { "enabled": false, "start": "22:00", "end": "07:00",
                    "timezone": "Asia/Kolkata" }
  },
  "events": ["task_assigned", "task_completed", "task_overdue", "task_comment",
             "email_assigned", "email_approval", "system"]
}
```

`email.events` carries the **same seven keys** as `inApp.events`; abbreviated
above only for brevity.

- **`GET /api/users/notification-preferences`** returns the object above.
  Defaults are materialised on read, so a client never has to guess which keys
  exist. `events` is the canonical list, so the UI can render one toggle per
  event without hard-coding a list that would drift from the server's.
- **`PUT /api/users/notification-preferences`** is a **deep partial merge**.
  Send only the toggle that changed; a concurrent tab cannot clobber an
  unrelated flag. Accepts either a bare preferences object or one wrapped in
  `{ notificationPreferences: ... }`, so the GET response round-trips. Returns
  `{ message, notificationPreferences, events }`.
- Invalid input is **400** with `{ message, errors: [{ field, message }] }` —
  the same shape `middleware/validate.js` produces. Unknown event names,
  non-boolean values, malformed `HH:MM` times and invalid IANA zones are all
  rejected.

**Enforcement — this is the part that matters:**

| Path | Behaviour |
|---|---|
| `utils/notificationHelper.js` | A suppressed in-app notification is **not written at all**. An unread badge for a notification the user muted is exactly what the toggle exists to prevent. `createNotifications` checks all recipients in parallel before the `insertMany` |
| `utils/emailHelper.js` | `sendEmail(to, subject, body, html, { event, userId })`. Preference checking is **opt-in via `event`** |

That opt-in split is deliberate. **Transactional mail is never suppressed**:
password resets and account-approval mail pass no `event` and go out regardless
of the recipient's settings. Only notification-style mail is governed.

Everything **fails open**: a lookup failure, a missing sub-document or an
unrecognised event type all deliver. An unknown event falls back to `system`,
which is on by default, so a newly added notification type can never be
silently swallowed by a stale preference document. Losing an "your account was
approved" mail to a Redis blip is worse than sending one the user had muted.

**Quiet hours suppress email only.** An in-app notification is a passive inbox
item; dropping it would destroy the record rather than defer a ping. Windows
that wrap midnight (22:00 to 07:00) are handled, and an equal start and end
means "never".

Notification `type` values were normalised to the seven canonical events at
every call site (task completion, the overdue cron digest, recurrence spawn,
keyword approval, bulk inbox assignment), so the toggles govern real traffic.
`email_approval` is **reserved** — it is in the taxonomy and rendered as a
toggle, but no producer emits it yet.

Preferences are cached (`nprefs:<userId>`, `CACHE_TTL_NOTIF_PREFS`, default
60 s) because they are read on every notification write and the overdue cron
fans out to every supervisor. `cache.invalidateUser()` drops the preference key
alongside the auth key, and the PUT invalidates explicitly — the smoke test
asserts an un-mute takes effect on the very next write, not after a TTL.

## New endpoints

| Method | Path | Access |
|---|---|---|
| `GET` | `/api/users/notification-preferences` | all roles (own) |
| `PUT` | `/api/users/notification-preferences` | all roles (own) |
| `GET` | `/api/clients/:id/timeline` | all roles, role-scoped |
| `PATCH` | `/api/gmail/emails/:id/read` | all roles + object check |
| `PATCH` | `/api/gmail/emails/read` | all roles + object check |
| `DELETE` | `/api/gmail/emails` with `{ids}` | Admin, Head (was Admin-only clear-all) |
| `DELETE` | `/api/gmail/linked-account` | **widened** to Admin, Head |
| `GET` | `/api/reports/employee` | **widened** to Admin, Head (scoped) |

## New model fields

| Model | Field | Purpose |
|---|---|---|
| `ActivityLog` | `ip`, `userAgent`, `targetType`, `targetId`, `targetLabel`, `before`, `after` | structured audit (S-2) |
| `User` | `lastLoginAt` | last successful login (S-4) |
| `User` | `notificationPreferences` | in-app/email/per-event/quiet hours (S-12) |
| `Email` | `readBy: [{user, readAt}]` | per-user read state (S-16) |

## New indexes

`ActivityLog {targetType, targetId, createdAt:-1}`,
`ActivityLog {targetType, createdAt:-1}`,
`User {deletedAt, lastLoginAt:-1}`,
`Email {deletedAt, 'readBy.user', date:-1}`,
`Email {'readBy.user'}`.

All five build cleanly under `npm run sync-indexes -- --apply` against a live
database. `scripts/syncIndexes.js` already registers all eight models, so no
change was needed there.

## New environment variables

All have defaults and are in `server/.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `ACTIVITY_MAX_USER_AGENT` | `400` | Cap on the stored `User-Agent` (unbounded on the wire) |
| `ACTIVITY_MAX_LABEL` | `300` | Cap on `targetLabel` |
| `ACTIVITY_MAX_CHANGE_BYTES` | `4000` | Cap on a serialised `before`/`after`; over it, the snapshot is replaced by a truncation marker |
| `CACHE_TTL_NOTIF_PREFS` | `60` | TTL for the cached preference lookup |
| `EMAIL_BULK_MAX` | `200` | Ceiling for bulk delete and bulk mark-read |
| `JWT_EXPIRES_IN` | `7d` | Session token lifetime, login and change-password alike |

`REDIS_URL` unset remains a fully working single-instance configuration.

## Verification

| Check | Result |
|---|---|
| `npm run check:syntax` (`node --check`, every file) | pass |
| `npm run test:smoke` against live Mongo + live server | **140 passed, 0 failed**, three consecutive clean runs |
| `npm run sync-indexes -- --apply` against live Mongo | pass, all new indexes build |
| Preference logic in isolation (quiet-hours wrap, boundaries, fail-open, merge validation) | 23 assertions, pass |
| `sendEmail` suppression (muted event, muted channel, transactional bypass, unknown address) | 8 assertions, pass |

The smoke test grew from 40 to 140 assertions. New coverage: structured audit
fields including a credential-leak check, the `actor` alias and that it actually
filters, `lastLoginAt`/`connectedAccountCount` and that `linkedGmailAccounts`
never leaks, the S-5 and S-7 response shapes (S-7 by diffing every key against a
live `/auth/me`), preference CRUD **and end-to-end suppression through the real
notification path**, read/unread including idempotency and per-user isolation,
bulk delete partial failure including that a forbidden row is left untouched,
`openTaskCount`, the timeline endpoint, and every S-11/S-17 permission boundary
in both directions.

### One harness note

The suite performs six logins and `authLimiter` allows `RATE_LIMIT_AUTH_MAX`
(default 10) per 15-minute window. Two back-to-back runs trip it, so the harness
now **aborts with an explicit message** on a 429 instead of cascading a wall of
false 401 failures. For repeat runs start the server with
`RATE_LIMIT_AUTH_MAX=200`.
