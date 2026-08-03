# F-3 (AI action extraction) + F-4 (collision detection) — server implementation

Implements `docs/audits/FEATURE-SPEC.md` §F-3 and §F-4. Built on the primitives
from `docs/audits/IMPL-backend-optimization.md` (`utils/cache.js`,
`utils/queue.js`, `utils/resilience.js`, `utils/logger.js`, `utils/redis.js`) and
the ownership rules from `docs/audits/IMPL-backend-security.md`. F-4 attaches to
the conversations F-1 introduced (`docs/audits/IMPL-features-threading-sla.md`).

**A client agent builds the UI from this document.** Every shape below is exact
and asserted field-by-field in `server/scripts/smokeTest.js`.

Harness: **279 assertions, 0 failures** (baseline before this work: 225), against
MongoDB 7.0.39 + Redis, and again with `REDIS_URL` unset.

---

## READ THIS FIRST IF YOU ARE WRITING A CLIENT PAGE

1. **Nothing existing changed shape.** F-3 and F-4 are new surfaces only.
2. `POST /api/ai/extract-actions` takes **`{ emailId }` or `{ threadId }` and
   nothing else**. Sending an email body is a **400 that names the offending
   key**, not a 413. The schema is `.strict()` on purpose.
3. The response is **suggestions to review, never a commitment**. Nothing on the
   server creates a task from it. The user ticks boxes and submits the existing
   `POST /api/tasks`. Show the `confidence` and label the panel as machine
   generated.
4. Extraction may return **`202` with a `jobId`** when the model runs longer than
   `AI_INLINE_WAIT_MS` (20 s). Poll `GET /api/ai/extract-actions/:jobId` — a
   **different** endpoint from `/api/ai/jobs/:jobId`, for the reason in §2.4.
5. Every degraded outcome is a **coded JSON error**, never a 500. Render
   `code`, not `message`, when you branch.
6. F-4 presence is **advisory and non-blocking**. It informs; it never locks a
   reply. A user who is denied a room gets `thread:presence:denied` and should
   simply see no presence UI — not an error toast.

---

## 1. What was built

| Area | File | Note |
|---|---|---|
| Shared ownership rule | `server/utils/emailAccess.js` | **New.** One definition of "may this user read this email", in both object and query form |
| Extraction prompt + sanitiser | `server/utils/aiExtraction.js` | **New.** Pure and synchronous, so the security boundary is testable without an inference call |
| Extraction endpoint | `server/controllers/aiController.js` | `extractActions`, `getExtractJobStatus`, `runExtractActionsJob` |
| Route | `server/routes/aiRoutes.js` | `POST /api/ai/extract-actions`, `GET /api/ai/extract-actions/:jobId` |
| Request schema | `server/middleware/schemas.js` | `extractActionsSchema` |
| Queue | `server/utils/queue.js`, `server/jobs/index.js` | New `ai-extract` queue + handler |
| Cache | `server/utils/cache.js` | `KEYS.aiActions`, `TTL.aiActions` |
| Presence | `server/utils/presence.js` | **New.** F-4 store, authorization, socket handlers, sweeper |
| Socket wiring | `server/index.js` | Handler registration, sweeper start, shutdown stop |

`gmailController.canAccessEmail` now **delegates** to `utils/emailAccess.js`.
Behaviour is byte-for-byte identical — it was moved so that three transports
(HTTP, the AI endpoint, the socket) cannot drift into three subtly different
authorization rules. That drift is exactly how the `[object Object]` bug in the
original `canAccessEmail` survived as long as it did.

---

## 2. F-3 — `POST /api/ai/extract-actions`

### 2.1 Request

```jsonc
{ "emailId": "66ae21f0c0ffee0000000040" }   // exactly one of these
{ "threadId": "18f3c0a1b2c3d4e5" }          // extract across a conversation
```

Validated by `extractActionsSchema`:

| Failure | Status | Message |
|---|---|---|
| neither id | 400 | `Provide exactly one of emailId or threadId.` |
| both ids | 400 | `Provide exactly one of emailId or threadId.` |
| any other key (e.g. `body`) | 400 | `Only emailId or threadId may be sent. Never send the email body.` |
| `emailId` not an ObjectId | 400 | `Email ID must be a valid ID.` |

### 2.2 Access

**`protect` only at the route; authorization is the OBJECT-level check** — the
same rule `GET /api/gmail/emails/:id` enforces, via
`utils/emailAccess.canAccessEmail`:

- Admin: any email.
- Head: emails on a mailbox they fetched.
- Employee: emails they fetched **or** that are assigned to them.

| Case | Status |
|---|---|
| unknown `emailId` | 404 `Email not found.` |
| `threadId` with no messages | 404 `Conversation not found.` |
| readable by nobody the caller is | 403 |
| unauthenticated | 401 |

A blanket `Admin, Head` gate (which is what the other `/api/ai` routes carry)
would have been simultaneously **wider** — any Head, any mailbox — and
**narrower** — never an Employee working an assigned message — than the rule
that actually governs reading the mail. For a `threadId`, only the messages the
caller may see are fed to the model; if that set is empty the answer is 403.

Rate limit: the existing `aiLimiter`, `AI_RATE_LIMIT_PER_MINUTE` (default 10/min
per IP).

### 2.3 Response — `200`

Exactly the spec's shape:

```json
{
  "actions": [
    {
      "title": "Send the signed engagement letter",
      "description": "The client asked for the countersigned letter before the audit starts.",
      "dueDate": "2026-08-07T00:00:00.000Z",
      "priority": "High",
      "confidence": 0.9
    }
  ],
  "suggestedClient": "Acme Holdings",
  "model": "gemini-2.5-flash",
  "cached": false
}
```

Guaranteed by the sanitiser, not by the model:

| Field | Guarantee |
|---|---|
| `actions` | array, **at most `AI_EXTRACT_MAX_ACTIONS` (10)**, de-duplicated by title |
| `actions[].title` | non-empty string, **≤ 200 chars**, markup and control characters stripped |
| `actions[].description` | string **≤ 1000 chars**, or `null` |
| `actions[].dueDate` | ISO-8601 string or `null`. Unparseable, > 730 days out, or > 365 days past → `null` |
| `actions[].priority` | `Low` \| `Medium` \| `High` \| `Urgent` \| `null` — matches `Task.priority` exactly |
| `actions[].confidence` | number **clamped to 0–1**, 2 decimals. Unparseable → `0`, never `1` |
| `suggestedClient` | string **≤ 200 chars**, or `null` |
| `model` | string |
| `cached` | boolean |

`Cache-Control: private, max-age=300` on a cache hit.

### 2.4 Response — `202` and the poll endpoint

When the model runs past `AI_INLINE_WAIT_MS`:

```json
{ "message": "Action extraction is still running. Poll GET /api/ai/jobs/:jobId.",
  "status": "active", "jobId": "ai-extract::7f3c…" }
```

```
GET /api/ai/extract-actions/:jobId
  -> 200 { "jobId", "status": "queued|active|completed|failed",
           "actions": [...] | null, "suggestedClient": "…|null",
           "model": "gemini-2.5-flash", "cached": false, "error": null }
  -> 404 unknown, expired, OR someone else's job
```

**Why a separate endpoint from `GET /api/ai/jobs/:jobId`.** Under BullMQ a job id
is a small **incrementing integer**, so `ai-extract::1`, `::2`, `::3` are
trivially enumerable. Serving extraction results from the existing role-gated
route would have let any Head read the extraction another Head ran on a mailbox
they cannot see. This route resolves a job **only for the user who created it**
(the claim is written to `aijob:owner:<jobId>` before the job can be polled) and
answers **404, never 403**, so it is not an existence oracle either.

`GET /api/ai/jobs/:jobId` is therefore **unchanged**: still `Admin, Head`, still
`{ jobId, status, summary, error }`, and it never returns `actions`.

> The same enumerable-id weakness exists on the pre-existing **summarization**
> poll route. It is out of scope here and was left alone rather than changed
> under a feature task; it is called out in §7.

### 2.5 Degraded paths — all coded, none a 500

| Condition | Status | Body |
|---|---|---|
| `GEMINI_API_KEY` unset or empty | `503` | `{ message, code: "AI_NOT_CONFIGURED" }` |
| `gemini` circuit breaker **open** | `503` | `{ message, code: "AI_UNAVAILABLE", retryInMs }` |
| job failed with a circuit error | `503` | `{ message, code: "AI_UNAVAILABLE" }` |
| job failed for any other reason | `502` | `{ message, code: "AI_FAILED" }` |
| message has no readable content | `400` | `{ message }` |

The breaker is checked **before** the job is enqueued, so an outage fails in
microseconds instead of queueing work guaranteed to be rejected and then
reporting it as a generic 502. Both 503 paths were verified end to end (§6).

### 2.6 Prompt-injection mitigations

The threat is a hostile **email**, not a hostile user: anyone can send mail into
a shared inbox, and its body reaches an LLM. Seven mitigations, in the order
they apply:

1. **The email never travels in the request.** The endpoint takes an id and
   reads the body server-side. There is no path by which a client controls the
   prompt input for a message it cannot read.
2. **Bounded input.** `AI_EXTRACT_INPUT_CHARS` (6000) total,
   `AI_EXTRACT_MESSAGE_CHARS` (1500) per message, newest
   `AI_EXTRACT_THREAD_MESSAGES` (10) messages of a conversation. The slice
   happens *before* the tag-stripping regex, so a 2 MB base64-laden body does
   not cost 200 ms of blocked event loop.
3. **The content is fenced with a per-request random nonce.**
   `BEGIN_UNTRUSTED_EMAIL_DATA_<12 random bytes>` … `END_…_<same nonce>`. The
   attacker cannot guess the delimiter, so they cannot terminate the fence and
   have the rest of their text read as instruction.
4. **The nonce and the marker words are stripped out of the content** before it
   is fenced (`stripFence`). Belt and braces on top of (3), and cheap.
5. **The instruction block declares the fenced region to be data**, states that
   it outranks anything inside the fence, and pre-empts the standard payloads:
   role change, prompt disclosure, tool-call requests, exfiltration requests,
   format changes. It also forbids emitting URLs, addresses, commands or markup.
6. **The output is treated as untrusted data.** It is parsed defensively
   (`parseModelJson` tolerates markdown fences and surrounding prose without
   trusting any of it) and every field is **re-typed and re-bounded** by
   `sanitizeExtraction` before it leaves the server. See the table in §2.3.
7. **The output drives nothing.** It is not used to create a task, is never
   interpolated into another prompt, and never selects a tool, a recipient, a
   URL or a query. It fills form fields the user reviews and submits through the
   ordinary, separately authorized `POST /api/tasks`.

A hostile email therefore cannot inflate the response (10 actions, bounded
strings), fabricate a plausible deadline (out-of-window dates become `null`),
fake certainty (`confidence` is clamped, and an unparseable one is `0`), inject
markup, or reach any side effect.

**Logging.** The document and the raw model response are logged **only at
`debug`, and only as a length** — never the content, at no level. The `info`
line carries `{ actionCount, model }`. `utils/logger.js`'s central redaction
still applies on top.

### 2.7 Cache

| Key | TTL | Invalidated by |
|---|---|---|
| `ai:act:<sha256>` | `CACHE_TTL_AI_ACTIONS` (30 days) | nothing — content-addressed |
| `aijob:owner:<jobId>` | `AI_JOB_OWNER_TTL` (3600 s) | expiry |

The hash covers **`PROMPT_VERSION` + model name + the whole document**. Including
the prompt version is what stops a prompt or contract change from serving a
stale, differently-shaped payload out of a 30-day entry.

**On the scope-discipline rule.** This key deliberately carries **no user or
role component**, and that is not the trap
`docs/audits/IMPL-features-threading-sla.md` §5 describes. That trap is a
*derived, role-narrowed slice* cached under a key that does not name the scope —
a Head's filtered aggregate served to an Admin. Here the cached value is a pure
function of a document the caller has already proved they may read, under the
same object-level check as `GET /emails/:id`. Nothing is narrowed, so there is no
narrowed thing to leak. Adding a userId would simply mean N inference calls for
one message, and the sanitiser output would be identical N times over. The
authorization gate is the endpoint, not the cache key.

### 2.8 Resilience

Reuses `callResilient('gemini', …)` — the **same breaker instance** as
summarisation, so one Gemini outage opens one circuit for both features rather
than each discovering the outage separately. `timeoutMs = AI_TIMEOUT_MS` (15 s),
3 attempts with full-jitter backoff, retrying only 429/5xx/network.

The inference runs on a **separate `ai-extract` queue** from `ai-summarize`, so a
burst of extractions cannot starve summarisation at `QUEUE_CONCURRENCY`. The
request only *waits* on the job and can give up without cancelling the work.

---

## 3. F-4 — collision detection

Ephemeral presence over the Socket.io rooms that already existed and were
unused. **No new collection, no new document, no new model field** — this is
transient state, and a record of who looked at what is a liability nobody asked
for.

### 3.1 Transport and lifecycle

The handshake in `index.js` is unchanged: it verifies the JWT and re-checks
`status` / `tokenVersion` through the shared `loadUser` / `checkAccountState`.
Presence **builds on that** and never re-implements or bypasses it. Handlers are
attached inside the existing `io.on('connection')`.

Room name: **`thread:<threadId>`**. A socket is placed in it only after passing
the authorization check in §3.4.

### 3.2 Inbound events (client → server)

| Event | Payload | Meaning |
|---|---|---|
| `thread:viewing` | `{ threadId }` | I have this conversation open. **Also the heartbeat** — re-emit every ~`ttlMs / 2` |
| `thread:composing` | `{ threadId }` | I have started a reply |
| `thread:composing` | `{ threadId, composing: false }` | I closed the composer but I am still reading |
| `thread:leave` | `{ threadId }` | Navigate-away. Clears both rosters and leaves the room |

`thread:composing` implies viewing, so a client that only ever emits it still
appears in `thread:viewers`.

### 3.3 Outbound events (server → client)

Broadcast **to the room**, so only authorized sockets receive them. The emitting
socket is included in its own roster — the client filters itself out.

```jsonc
// thread:viewers
{
  "threadId": "18f3c0a1b2c3d4e5",
  "viewers": [
    { "userId": "66ad0011c0ffee0000000007", "name": "Priya", "since": "2026-08-02T14:02:11.004Z" }
  ],
  "count": 1,
  "ttlMs": 45000
}
```

```jsonc
// thread:composers — identical shape, different key
{
  "threadId": "18f3c0a1b2c3d4e5",
  "composers": [
    { "userId": "66ad0011c0ffee0000000009", "name": "Sam", "since": "2026-08-02T14:03:40.881Z" }
  ],
  "count": 1,
  "ttlMs": 45000
}
```

```jsonc
// thread:presence:denied — sent ONLY to the offending socket
{ "threadId": "18f3c0a1b2c3d4e5", "code": "NOT_ALLOWED" }
```

Both rosters are emitted together on every change, so the client never has to
reconcile a half-updated view. `ttlMs` is `PRESENCE_TTL_SECONDS × 1000`: use it
to set the heartbeat interval rather than hard-coding one that could drift from
the server's.

**A participant is a person, not a socket.** Three tabs is one entry, and the
**earliest** `since` wins, so "Priya has been viewing since 14:02" does not reset
every time she opens another tab.

`viewers` and `composers` contain **only** `userId`, `name` and `since`. No
email content, no subject, no message id.

### 3.4 Authorization — the part that matters

A socket may join `thread:<threadId>` only if
`Email.exists({ threadId, deletedAt: null, ...emailAccessFilter(user) })` — the
query-level twin of `canAccessEmail`, and the same rule
`GET /api/gmail/threads/:threadId` enforces.

- **Not an existence oracle.** An unknown thread, a thread on a mailbox the
  caller cannot see, a malformed id and an over-budget socket all produce the
  **identical** `thread:presence:denied` with `code: "NOT_ALLOWED"`. Presence
  cannot be used to discover that a conversation exists.
- **Fails closed.** If the authorization query throws, access is denied. A
  database blip must not hand out presence.
- **Denied sockets receive nothing.** No roster, no room membership, no later
  broadcast.
- **Re-checked, not trusted forever.** A successful check is memoised per socket
  for `PRESENCE_AUTH_TTL_MS` (60 s) so a 20-second heartbeat is not a query
  every 20 seconds, but the check is re-run after that.

### 3.5 Bounds

| Bound | Default | Why |
|---|---|---|
| `PRESENCE_MAX_ROOMS_PER_SOCKET` | 5 | A reading pane needs one. Hundreds is an attempt to fan a broadcast across the workspace |
| `PRESENCE_MAX_PARTICIPANTS` | 25 | Ceiling on one broadcast payload |
| `PRESENCE_EVENTS_PER_MINUTE` | 120 | Per-socket inbound budget; a cheap event times unbounded is still an amplifier |
| thread id | ≤ 200 chars, no control characters | Room names are derived from it |

### 3.6 Storage and degradation

**Redis when `REDIS_URL` is set, an in-process `Map` when it is not** — the same
policy as the cache, the queue, the lock, the rate limiter and the Socket.io
adapter. A Redis error on any single operation degrades to the in-process store
for that operation and is logged at `debug`; it is never a socket error.

Per `(kind, threadId)` the store is a **sorted set** whose members are the
participating sockets and whose score is the entry's expiry:

```
ZADD              key <expiresAt> <member>     join / heartbeat
EXPIRE            key <ttl * 4>                backstop if everyone vanishes
ZREMRANGEBYSCORE  key -inf <now>               drop what expired
ZRANGE            key 0 -1                     read what is live
```

One structure gives both TTL expiry and the roster in a single read. The member
string is stable across heartbeats (`since` does not move), so a re-`ZADD`
updates the score in place instead of creating a duplicate.

An entry is removed on **`thread:leave`**, on **`disconnect`**, and by
**expiry**. A laptop lid closing simply stops the heartbeat and ages out within
`PRESENCE_TTL_SECONDS` (45 s).

The **sweeper** runs every `PRESENCE_SWEEP_MS` (15 s) over only the threads this
process has a local socket in — never a keyspace scan — and re-broadcasts a
roster **only when it changed**. With the Redis adapter each node sweeps its own
rooms against the shared state, so a participant who ages out on node A
disappears from node B's roster too. The interval is `unref`'d, and
`stopPresence()` runs in graceful shutdown.

---

## 4. New environment variables

All have defaults and are in `server/.env.example`. **`REDIS_URL` unset remains a
fully working single-instance configuration** — the full 279-assertion suite
passes on the in-process cache, queue and presence store.

| Variable | Default | Purpose |
|---|---|---|
| `AI_EXTRACT_MAX_ACTIONS` | `10` | Ceiling on returned actions |
| `AI_EXTRACT_TITLE_MAX` | `200` | Title character ceiling |
| `AI_EXTRACT_DESCRIPTION_MAX` | `1000` | Description character ceiling |
| `AI_EXTRACT_CLIENT_MAX` | `200` | `suggestedClient` character ceiling |
| `AI_EXTRACT_INPUT_CHARS` | `6000` | Total prompt input ceiling |
| `AI_EXTRACT_MESSAGE_CHARS` | `1500` | Per-message ceiling within a conversation |
| `AI_EXTRACT_THREAD_MESSAGES` | `10` | Newest messages of a thread fed to the model |
| `AI_EXTRACT_DUE_DATE_MAX_DAYS` | `730` | A suggested due date beyond this becomes `null` |
| `AI_EXTRACT_DUE_DATE_MIN_DAYS` | `365` | …and before this |
| `AI_EXTRACT_RAW_MAX` | `40000` | Raw model response we will attempt to parse |
| `CACHE_TTL_AI_ACTIONS` | `2592000` | Extraction cache TTL (30 days) |
| `AI_JOB_OWNER_TTL` | `3600` | How long an extraction job stays pollable by its creator |
| `PRESENCE_TTL_SECONDS` | `45` | Presence entry lifetime without a heartbeat |
| `PRESENCE_SWEEP_MS` | `15000` | Sweep / re-broadcast interval |
| `PRESENCE_MAX_ROOMS_PER_SOCKET` | `5` | Threads one socket may be present in |
| `PRESENCE_MAX_PARTICIPANTS` | `25` | Ceiling on a broadcast roster |
| `PRESENCE_AUTH_TTL_MS` | `60000` | How long a room authorization is memoised |
| `PRESENCE_EVENTS_PER_MINUTE` | `120` | Inbound presence events per socket |

Reused, not introduced: `GEMINI_API_KEY`, `GEMINI_MODEL`, `AI_TIMEOUT_MS`,
`AI_INLINE_WAIT_MS`, `AI_RETRY_ATTEMPTS`, `AI_JOB_ATTEMPTS`,
`AI_RATE_LIMIT_PER_MINUTE`, `THREAD_MESSAGE_CAP`, `CACHE_PREFIX`.

---

## 5. Indexes and migrations

**None.** No model field was added or changed, so `scripts/syncIndexes.js` is
untouched and there is no backfill to run.

The one new query shape is presence authorization:
`Email.exists({ threadId, deletedAt: null, fetchedBy|assignedTo })`. It is served
by the F-1 indexes already declared — `{ fetchedBy: 1, threadId: 1 }` for a Head
and `{ threadId: 1, date: 1 }` for the highly selective `threadId` equality —
and touches at most one conversation's worth of documents. No new index is
warranted.

---

## 6. Verification

| Check | Result |
|---|---|
| `npm run check:syntax` (`node --check`, every file under `server/`) | pass |
| `npm run test:smoke`, live Mongo 7.0.39 + live Redis | **279 passed, 0 failed** |
| `npm run test:smoke`, **`REDIS_URL` unset** (in-process cache/queue/presence) | **279 passed, 0 failed** |
| `GEMINI_API_KEY` empty → `503 AI_NOT_CONFIGURED` | pass (verified end to end) |
| `gemini` breaker forced open → `503 AI_UNAVAILABLE` + `retryInMs` | pass (verified against the controller) |
| Live Gemini call against a hostile email, then a repeat → `cached: true` | pass |

### Running the suite

```bash
MONGO_URI="mongodb://127.0.0.1:27017/maildesk_dev" REDIS_URL="redis://127.0.0.1:6379" \
  RATE_LIMIT_AUTH_MAX=500 RATE_LIMIT_GENERAL_MAX=5000 \
  AI_RATE_LIMIT_PER_MINUTE=200 PORT=5150 node index.js

MONGO_URI="mongodb://127.0.0.1:27017/maildesk_dev" BASE_URL="http://127.0.0.1:5150" npm run test:smoke
```

**`AI_RATE_LIMIT_PER_MINUTE=200` is new and required for repeat runs.**
`/api/ai/*` carries its own `aiLimiter` (default 10 per **minute**) and the F-3
section issues roughly eight calls: one run fits, two inside the same minute do
not. The harness now aborts with a message that names `aiLimiter` and the right
knob, rather than misattributing it to `generalLimiter`.

### What the 54 new assertions cover

**F-3, offline against the real sanitiser** (so the security boundary is proven
whether or not a model is reachable): the 10-action cap against a 50-action
response, title/description/`suggestedClient` truncation, out-of-enum priority
rejection, absurd-due-date rejection, confidence clamping (including `99` and
`-5`), lowercase priority normalisation to the `Task` enum, real due date parsed
to ISO, actions with no title dropped, de-duplication by title, non-object
entries ignored, a non-JSON response yielding an empty extraction, a
markdown-fenced response still parsed, markup stripped from a title, the prompt
fencing content with a nonced delimiter, the delimiter being stripped from the
content, the fenced region containing exactly one closing delimiter, the prompt
declaring the region untrusted, and document length bounding.

**F-3, over HTTP**: 400 for neither/both ids, 400 for a request carrying a body
payload, 404 for an unknown email, 403 for a Head extracting from another
mailbox, 403 for an Employee, the documented 200 shape (with every cap
re-asserted on the live response), `cached: true` on a repeat, 404 — not 403 —
when polling someone else's job, and that `GET /api/ai/jobs/:jobId` is still
`Admin, Head`.

**F-4**: an invalid token cannot open a socket; `thread:viewing` broadcasts
`thread:viewers`; the participant payload is exactly `{ userId, name, since }`;
a second user joining is broadcast to the room; a user who cannot read the
thread is denied **and receives no roster**; an unknown thread is denied
*identically* to a forbidden one; `thread:composing` broadcasts
`thread:composers`; `composing: false` clears the composer without leaving;
`thread:leave` removes the viewer; two tabs of one user count once; disconnect
clears presence immediately; and no presence payload carries message content.

The harness gained `socket.io-client@4.8.3` as a **devDependency** — it is the
only way to assert a socket contract, and it is not loaded by the server.

---

## 7. Not done, and why

- **No UI.** `client/` belongs to another agent. Nothing under `client/` was
  touched.
- **No task creation from the model output**, by design and by spec. The
  extraction endpoint is read-only with respect to application state.
- **`suggestedClient` is not resolved to a `Client` document.** The model returns
  a name; matching it against the client list would mean the model's output
  selecting a record, which is precisely the coupling §2.6(7) exists to avoid.
  The client UI can offer it as a typeahead default the user confirms.
- **No per-user rate accounting on extraction.** `aiLimiter` is per IP, as it
  already was for summarisation. A per-user budget is a sensible follow-up but
  would be a new mechanism rather than a reuse.
- **The pre-existing summarization poll route was left alone.**
  `GET /api/ai/jobs/:jobId` is `Admin, Head` with no per-job ownership claim, and
  under BullMQ its job ids are enumerable, so one Head can read another Head's
  summary. F-3 does **not** inherit this (§2.4), but the existing route still has
  it. Fixing it changes a status code on an existing endpoint (200 → 404 for a
  foreign job), which is a behaviour change outside an additive-only feature
  task. It should be closed separately.
- **Presence is not persisted across a restart.** It is transient by
  specification. With Redis the entries survive an API restart and age out
  normally; without Redis a restart clears them and clients re-announce on their
  next heartbeat.
- **No presence for the message list**, only for a conversation. The spec's
  collision case is "two people replying to the same message", which is a thread
  concern; per-row avatars in the inbox would multiply the room count by the page
  size.
- **No "someone else replied while you were composing" notification.** The
  composer banner is advisory and non-blocking, as the spec requires. A
  post-hoc collision notice is a different feature (and needs a delivery channel
  decision) rather than a presence one.
