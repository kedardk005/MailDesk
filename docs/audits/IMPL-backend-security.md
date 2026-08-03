# Backend Security & Correctness Implementation

Branch: `feat/production-hardening`
Scope: `server/` only. Nothing under `client/` or elsewhere in `docs/` was touched.

Implements every item from the backend hardening brief, derived from
`docs/PROJECT_AUDIT.md` and `docs/audits/audit-backend-bugs.md`.

Verification method: there is no local MongoDB or Redis, so nothing was run
against a live database. Everything was verified with `node --check` on every
modified file, module-load checks on all 44 server modules, router mount checks,
executing the real installed libraries (Zod 4.4.3, sanitize-html 2.17.6) against
adversarial input, and booting the real `index.js` with `mongoose.connect`
stubbed to exercise the HTTP surface.

---

## New dependency

| Package | Version | Why |
|---|---|---|
| `sanitize-html` | ^2.17.6 | Sanitizing inbound Gmail HTML at ingest and on read |

---

## New environment variables

All have working defaults and are documented in `server/.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `APP_TIMEZONE` | `Asia/Kolkata` | IANA zone used to interpret deadlines with no UTC offset. Bare dates become end-of-day in this zone; naive date-times are read as wall-clock in this zone. Always stored as UTC. |
| `SEED_CLIENTS` | `false` | Must be `'true'` for demo client seeding to run, and only when the collection is empty. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful shutdown drain timeout before forced exit. |
| `NODE_ENV` | `development` | `production` suppresses stack traces in error responses. |

`JWT_SECRET` gained a comment documenting the high-entropy generation requirement.

---

## New endpoints

| Method | Path | Access | Notes |
|---|---|---|---|
| `POST` | `/api/auth/reset-password` | Public | Redeems a single-use reset token; body `{ token, password }`. |
| `POST` | `/api/gmail/deduplicate` | Admin only | Replaces the implicit sweep that ran on every `GET /api/gmail/status`. Body `{ "apply": true }` writes; omitted/false is a dry run returning the conflict report. |

---

## New model fields

**`Email`**
- `bodyRaw` (String, **`select: false`**) — original unsanitized Gmail HTML, forensics only, never returned unless explicitly selected.
- `deletedAt` (Date, default `null`) — soft delete; every read path filters on it. Indexed.
- `deletedBy` (ObjectId → User).

**`Task`**
- `overdueNotifiedAt` (Date, default `null`) — makes the overdue notification fire once per task instead of every minute forever.

**`User`**
- `resetTokenHash` (String, **`select: false`**) — SHA-256 of the reset token; the raw token is never stored.
- `resetTokenExpires` (Date, **`select: false`**).
- `deletedAt` (Date), `deletedBy` (ObjectId → User), `deletedEmail` (String) — soft delete; `email` is tombstoned on delete so the unique index is freed and the address can be re-registered, with the original preserved in `deletedEmail`.

---

## New files

- `server/utils/sanitizeEmailHtml.js` — the single place inbound email HTML is made safe.
- `server/utils/dateHelper.js` — timezone-correct deadline normalization.
- `server/middleware/mongoKeyGuard.js` — global NoSQL operator-key rejection.
- `server/scripts/reconcileEmailAssignments.js` — the boot-time email cleanup, moved out of the connection path into an explicit dry-run-by-default script.

---

## P0 blockers

### 1. Stored XSS on ingest — FIXED
`utils/sanitizeEmailHtml.js` sanitizes with a hardened allowlist. Removed:
`<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>` and all form controls,
`<base>`, `<link>`, `<meta>`, `<svg>`, `<math>`, every `on*` handler,
`javascript:`/`vbscript:`/`data:text/html` URLs, and any `<style>` block
containing `expression(`, `behavior:`, `-moz-binding` or `@import`. Preserved:
ordinary formatting, headings, lists, tables, links, and images including the
inline base64 `data:` URIs the sync pipeline builds.

Applied at ingest (`gmailController` writes the sanitized HTML to `body` and the
original to `select: false` `bodyRaw`) **and** on every read path
(`getEmails`, `getAllTasks`, `getTaskById`, `updateTask`, `getPendingApprovals`)
so bodies stored before this fix are also neutralised.

Verified against 28 payloads including `<img onerror>`, `data:text/html`,
`java\tscript:`, `</style>` breakout, unclosed `<style>`, and uppercase
`ONERROR`. All neutralised; formatting/tables/inline images preserved; the
function is idempotent.

`allowVulnerableTags: true` is set deliberately — `<style>` is kept because real
business email depends on it for layout, with `stripDangerousStyleBlocks()` as
the compensating control. This is documented inline.

### 2. `replyToEmail` / `downloadAttachment` sending from the Admin's mailbox — FIXED
Both Admin-credential fallback blocks are **deleted** (grep-verified). The
sending identity resolves only from `req.user` via a new
`resolveInboxCredentials(user, inbox)` helper that searches a single user
document. A new `canAccessEmail(email, user)` enforces object-level
authorization (Admin: any; otherwise must own the mailbox via `fetchedBy`;
Employees also qualify for emails assigned to them) and returns **403** on
mismatch.

For `downloadAttachment`, an Employee legitimately reads an attachment on a task
assigned to them but never holds Gmail credentials, so the fetcher's credentials
are used for that role **only after** `canAccessEmail` has confirmed the
assignment.

Also hardened in the same function: `To`, `Subject`, `In-Reply-To`, `References`
and `From` now pass through `sanitizeHeaderValue()`, stripping CR/LF so an
attacker-controlled inbound header cannot inject a `Bcc:` into the reply.

### 3. Zod 4 validation returning 500 — FIXED
Confirmed the bug first by executing the project's own Zod 4.4.3: `e.errors` is
`undefined` and `e.errors[0]` throws a `TypeError`. `middleware/validate.js`
rewritten to use `safeParse` and `.issues`, returning **400** with
`{ message, errors: [{ path, message }] }`. `message` keeps its existing shape so
the current client contract is preserved; `errors` is additive. A missing body is
normalised to `{}` so an empty POST also yields a clean 400.

Verified end to end through the booted app: bad email, empty body, and multi-field
failures all return 400.

### 4. Registration issuing a JWT to unapproved users — FIXED
`generateToken` moved **after** the status gate. A non-`Approved` account gets
201 with an "awaiting admin approval" message and the user object, but **no
token**. Registration now also writes an ActivityLog entry.

### 5. Deactivated users keeping sessions — FIXED
New shared `checkAccountState(user, decoded)` in `authMiddleware`, used by both
the HTTP `protect` middleware and the Socket.io handshake, enforcing: user
exists, not soft-deleted, `tokenVersion` matches, and `status === 'Approved'`
(the approved enum value confirmed from `models/User.js`).

`userController.updateUser` now bumps `tokenVersion` on **every** status change
**and** every role change, so live sessions die immediately on both transports.
Unit-tested across 7 state combinations.

Also hardened here: `Bearer ` now requires the trailing space (`Bearerfoo` no
longer matches), and `jwt.verify` pins `algorithms: ['HS256']` in both places.

### 6. Gmail permission control silent no-op — FIXED
`updateUserSchema` gained `maxConnectedAccounts`
(`z.coerce.number().int().min(0).max(50)`) and `allowedGmailAccounts`
(array of emails, max 100, **or** the comma-separated string the UI submits).
Verified that both now survive parsing, so `userController`'s previously dead
branches populate the allowlist and the guard at the OAuth callback fires.

`updateUserProfileSchema` was deliberately **not** loosened — its stripping is
what prevents self-service `role` mass-assignment. Re-verified that unknown keys
are still stripped there.

### 7. A GET request destroying Gmail connections — FIXED
The call is removed from `getConnectedStatus` entirely. `deduplicateConnections`
is retained but rewritten to be safe:
- deterministic ordering (`sort({ createdAt: 1, _id: 1 })`) — the **earliest**
  connector of an address is its legitimate owner and is never touched;
- only blank entries and genuine duplicates held by a **later** claimant are
  removed;
- an ActivityLog entry is written for **every** change;
- supports a dry run.

Exposed as Admin-only `POST /api/gmail/deduplicate`, defaulting to a dry run.

The call was also removed from the OAuth callback and replaced with a
**uniqueness check at the source**: connecting a Gmail address already claimed by
another user now returns 409 with a clear message, so the duplicate is never
created. This is the root cause the sweep was papering over.

---

## Security (high)

### 8. `deleteComment` IDOR — FIXED
`comment.taskId` is compared against `req.params.id` **before any authorization
logic**, returning 404 on mismatch. Authorization then runs against the
comment's **own** task. Employee/Head branches additionally require current
access to that task. Deletion is now logged.

### 9. `bulkAssignEmails` IDOR — FIXED
Query scoped to `fetchedBy: req.user._id` for non-Admins plus `deletedAt: null`,
and it **fails closed** — if any requested id is outside the caller's mailbox the
whole request is rejected 403 rather than acting on the subset they own.
`email.body` is no longer copied into `Task.description` (stores the link only),
and the response returns only non-sensitive task metadata, never bodies.
`emailIds` is capped at 200 and each element must be a valid ObjectId.

### 10. Keyword-approval endpoints workspace-wide — FIXED
New `scopeEmailQuery(user, base)` restricts non-Admins to their own mailbox,
applied to `getPendingApprovals`, `approveEmailAssignment`, `bulkApproveEmails`,
and the retroactive scan in `createKeywordRule`. Bulk approve now **requires** a
non-empty `keyword` (enforced by `bulkApproveSchema` on the route and re-checked
in the controller). New `canMutateRule()` enforces `createdBy`-or-Admin on rule
update and delete; delete now loads the rule first so ownership is checked before
the document is removed.

### 11. `deleteSingleEmail` no ownership check — FIXED
Added `canAccessEmail` (403 on failure) and converted to **soft delete**
(`deletedAt` + `deletedBy`), filtered out of all read paths.

### 12. `createTask` linkedEmail IDOR — FIXED
`linkedEmail` is verified against a mailbox-scoped query before linking (403 if
not accessible), the assignee is verified to exist (400 instead of a CastError
500), and the 201 response populates only `subject from` — **not** `body` or
`attachments`. `linkedEmail` and `assignedTo` are ObjectId-validated in the
schema.

Also fixed here: the `isRecurring` normalization mismatch — the normalized
boolean is now used in both places, so `{"isRecurring":"false"}` no longer stores
`isRecurring: false` alongside a non-null `recurrence`.

### 13. Forgot-password account-lockout DoS — FIXED
The endpoint **no longer touches the password or `tokenVersion`**. It generates a
32-byte CSPRNG token, stores only its SHA-256 hash with a 30-minute expiry, and
emails a `${FRONTEND_URL}/reset-password?token=...` link. The response is byte-identical
whether or not the account exists.

The new `POST /api/auth/reset-password` looks the user up **by token hash** with
an unexpired expiry, sets the new password, burns the token (single use), and
bumps `tokenVersion` — now that the credential has genuinely changed.

### 14. `PUT /api/tasks/:id` zero validation — FIXED
New `updateTaskSchema` wired onto the route: bounded strings (title 300,
client 200, description/notes 20000), `status`/`priority`/`recurrence` enums,
ObjectId-validated nullable `assignedTo`, and ISO date validation normalized
through `APP_TIMEZONE`. An empty string deadline is treated as "clear" rather
than a validation error, since a cleared form input sends `""`.
Verified: `{"title":123}` and `{"status":"Archived"}` now return 400, not 500.

### 15. Latent NoSQL injection — FIXED
`middleware/mongoKeyGuard.js` **rejects** (400) any request whose query, body or
params contains a key starting with `$` or containing `.`, recursing through
nested objects and arrays with a depth cap. Applied globally. Existing body
sanitization is retained as a second layer. This does not rely on mutating
`req.query`, which is a no-op under Express 5.

---

## Correctness bugs

### 16. Silent client data corruption — FIXED
`taskHelper` no longer falls back to `clients[0].name`; an unmatched sender is
left as `'Unassigned'`. Sender matching also changed from `String.includes` to
exact parsed-address comparison, so a client with `a@b.c` no longer matches
`not-a@b.co.uk` (verified).

`seedClients()` now runs **only** when `SEED_CLIENTS === 'true'` **and** the
Client collection is empty.

### 17. Timezone-wrong deadlines — FIXED
`utils/dateHelper.js` normalizes explicitly against `APP_TIMEZONE` and stores
UTC. ISO-8601 with an offset is used as-is; a naive date-time is read as
wall-clock in `APP_TIMEZONE`; a bare date becomes **end of day** in
`APP_TIMEZONE` (not UTC midnight), so a task due "today" is no longer flipped to
Late at 05:30 local. Wired through `createTaskSchema`, `updateTaskSchema` and
`bulkAssignEmailsSchema`.

Verified across Asia/Kolkata, UTC and America/New_York including a DST boundary.
A millisecond-precision bug found during verification (end-of-day landing at
`00:00:00.997` of the next day) was fixed and re-verified.

### 18. Overdue cron notification spam — FIXED
Added `Task.overdueNotifiedAt`; the query only selects tasks where it is null, so
each task notifies exactly **once**. Supervisors receive a **single digest**
("N tasks are overdue: ...") rather than one notification per task. Writes are
batched: one `updateMany` for the status flip and one `insertMany` via the new
`createNotifications()` helper. Already-notified stragglers are still flipped to
`Late` without re-notifying. `overdueNotifiedAt` is re-armed by `updateTask` when
the deadline moves or the task leaves `Late`.

### 19. Profile "Inbox Address" blank — FIXED
`GET /api/gmail/status` returns **both** `gmailEmail` and `email`.

### 20. Dead endpoint `PUT /api/keyword-rules/:id` — FIXED
Now validated by `updateKeywordRuleSchema` and authorized by `canMutateRule`
(creator or Admin). Ready for the client agent to wire up.

---

## Cross-cutting

- **21.** Global error handler returns a consistent `{ message }`, logs 5xx with
  stack and 4xx as warnings, exposes stack traces only when
  `NODE_ENV !== 'production'`, and defers to Express when headers are already
  sent. A JSON **404 handler** was added so unmatched routes no longer return
  Express's HTML page. `unhandledRejection` and `uncaughtException` now both log
  and **exit via graceful shutdown** instead of leaving a corrupted process
  serving traffic.
- **22.** `connectDB` exits with code 1 when `MONGO_URI` is missing or the
  connection fails.
- **23.** `app.set('trust proxy', 1)` — one hop, deliberately not `true` (which
  would let clients spoof `X-Forwarded-For` and bypass rate limiting entirely).
- **24.** `/api/health` returns **503** when Mongo is not connected or the
  process is draining, and reports `database`, `shuttingDown` and `uptime`.
  Verified returning 503 against a disconnected stub.
- **25.** Graceful shutdown on SIGTERM/SIGINT: flips health to 503, closes
  Socket.io, drains and closes the HTTP server, closes Mongo, with a
  `SHUTDOWN_TIMEOUT_MS` hard stop.
- **26.** ActivityLog entries added for user create, **role change** (records
  before → after), **status change** (before → after), generic update, delete,
  self-registration, comment deletion, and every Gmail de-duplication change.
- **27.** `deleteUser` converted to soft delete. ActivityLog entries and
  TaskComments are now **retained** (the old cascade purged the audit trail of
  the very account being deleted). Keyword rules are deactivated rather than
  deleted. Tasks/emails are unassigned. Gmail tokens and reset tokens are
  revoked, `tokenVersion` bumped, and the email tombstoned so it can be
  re-registered.

---

## Additional changes made (not explicitly requested)

These were required for coherence with the assigned fixes, or were directly
adjacent. Flagged here for review.

1. **Boot-time email cleanup removed from `config/db.js`** and preserved as
   `scripts/reconcileEmailAssignments.js` (dry run by default). It mass-reset
   `status`/`assignedTo` on every email with no linked Task on *every* process
   start, which directly conflicts with the soft-delete work. Nothing was lost —
   the logic is intact in the script.
2. **`deleteAllEmails`, `disconnectGmail`, `disconnectLinkedAccount` converted to
   soft delete.** Leaving hard-delete paths beside a recoverable single delete
   would have been incoherent. Response shapes preserved (`count` now comes from
   `modifiedCount`).
3. **OAuth callback rejects an already-claimed Gmail address with 409** — the
   root-cause fix that makes the de-duplication sweep unnecessary.
4. **Employee null-assignee bypass fixed** (`getTaskById`, `updateTask`). The
   `task.assignedTo &&` short-circuit let an Employee read and complete any
   *unassigned* task, including its populated email body. Now deny-by-default via
   `?.`. This was audit finding 17 and would have undermined the IDOR fixes.
5. **`getEmails` `?q=` array coercion** — repeated query params made `q.trim()`
   throw a 500; `q` is now coerced to a single string and capped at 200 chars.
6. **Cron and user queries exclude soft-deleted/non-approved users**, so no
   background sync runs for a deleted account.
7. **Bulk array bounds and ObjectId validation** on `bulkTaskSchema` (max 500)
   and `bulkAssignEmailsSchema` (max 200), turning CastError 500s into 400s.
8. **Zod 4 `errorMap` → `error`** on all four enum schemas. `errorMap` is
   silently ignored in Zod 4, so the custom messages never reached users; this
   would have surfaced the moment `validate.js` was fixed.

---

## Deliberately NOT done

These are real findings from the audit but were outside the assigned scope. None
are blocked by this work.

| Audit # | Issue | Why not done |
|---|---|---|
| 16 | `getEmailTimeline` `?days=` unbounded → event-loop DoS | Not in the brief. One-line clamp in `reportsController.js:234`. **Recommend doing next** — it is a trivial fix for a real DoS. |
| 19 | Recurrence month-overflow, double-spawn race, spawn-before-save | Not in the brief; needs a conditional-update refactor of the completion path. |
| 22 | Login user enumeration ("User not found" vs "Incorrect password") | Not in the brief, and changing login messages would break the current client contract mid-rebuild. Forgot-password enumeration **was** fixed as specified. |
| 25 | `GET /api/clients` loads all tasks + emails into memory; Employee-accessible | Not in the brief; needs an aggregation rewrite and a decision on which of the two duplicate client CRUD surfaces to delete. |
| 26 | `decrypt()` fails open, returning ciphertext as a token | Not in the brief; changing it to throw needs a coordinated migration check. |
| 27 | `oauth2Client.on('tokens')` async listener → `ParallelSaveError` | Not in the brief; needs the atomic-write refactor. |
| 30 | No pagination on any list endpoint | Not in the brief; a cross-cutting API change the client is being rebuilt against. |
| 31 | 6-char password policy, bcrypt cost 10, 7-day JWT expiry | Not in the brief. Password max length (128) **was** added; minimum left at 6 to avoid locking out existing users mid-rebuild. |
| 32 | `res.status(550)`; AI endpoint is an unmetered LLM proxy | Not in the brief. |
| 33 | Modulo bias in temp-password generator | Moot — the temp-password generator was deleted entirely by fix 13. |

Also not done: `Email.body` still has no length cap and inline images are still
inlined as base64 data URIs, so a mail with large embedded images can approach
MongoDB's 16 MB document limit. Sanitization does not change this. Worth a
follow-up.

---

## Verification summary

| Check | Result |
|---|---|
| `node --check` on all 22 modified + 4 new files | pass |
| All 44 server modules load | pass |
| All 10 routers mount (catches undefined handlers) | pass |
| Sanitizer vs 28 XSS payloads incl. style breakout | all neutralised, formatting preserved, idempotent |
| Zod 4 `.errors` bug reproduced, then fixed | 400 with field errors, no 500 |
| Deadline normalization across 3 zones + DST | pass (1 precision bug found and fixed) |
| `checkAccountState` across 7 state combinations | pass |
| `mongoKeyGuard` vs nested `$`/dotted keys | pass, normal bodies untouched |
| Live boot with stubbed Mongo: health 503, JSON 404, 400s not 500s, `$ne` rejected, 401s | pass |
| New routes registered | `POST /api/gmail/deduplicate`, `POST /api/auth/reset-password` present |

Not verified (no database available): actual persistence, index behaviour, and
the end-to-end reset-password round trip. These need a live Mongo before release.
