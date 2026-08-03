# AUDIT — Realistic volume, all three roles

Date: 2026-08-03 · Branch: `feat/volume-audit` · DB: `mongodb://127.0.0.1:27017/maildesk_run` · API: `http://127.0.0.1:5015` · UI: `http://localhost:5174`

Every number below was **verified by re-querying MongoDB directly** and comparing with the API/UI value, unless explicitly labelled otherwise. The client was being actively rewritten by another workstream during this audit; UI-level observations are marked with the component file they were pinned to.

---

## 1. The seeder — `server/scripts/seedDemoData.js`

### Usage (from `server/`)

```bash
node scripts/seedDemoData.js                 # seed the default local demo DB (maildesk_run)
node scripts/seedDemoData.js --uri <mongo-uri>
node scripts/seedDemoData.js --dry-run       # print the plan, write nothing
node scripts/seedDemoData.js --clean         # remove everything the seeder created
node scripts/seedDemoData.js --force         # bypass the safety gate (do not use casually)
```

### Safety

- Refuses non-loopback hosts and any database whose name does not look like a scratch/demo DB (`demo|test|dev|local|scratch|seed|sample|run|stag`) unless `--force`. Verified: both a fake Atlas URI and `production_db` on localhost are refused with exit 1.
- Deliberately does **not** read `server/.env` — the checked-in `.env` points at an Atlas cluster.
- **Idempotent**: every inserted `_id` is recorded in a `seed_meta` collection; a re-run wipes exactly those documents first. Verified: two consecutive runs produce identical collection totals.
- Runs 9 coherence invariants after insert (thread ordering, status↔assignee consistency, task↔email agreement, no Pending task with a past deadline, `completedAt >= createdAt`, …) and exits non-zero if any fails. All 9 passed.

### What it creates (totals counted in Mongo after seeding, not script intent)

| Collection | Total after seed | Notes |
|---|---|---|
| emails | **2,000** | 1,401 inbound / 599 outbound, 950 threads (1–6 msgs), 4 soft-deleted, spread over 90 days |
| mailboxes | **4** | `support@`/`sales@` (Admin, one linked), `billing@` (Head), `ops@` (second Head) |
| tasks | 409 (400 new + 9 pre-existing) | 250 linked to emails, 8 recurring, 225 Completed / 115 Pending / 69 Late |
| clients | **25** (22 new + 3 existing) | senders drawn from `associatedEmails`, so `clientId` attribution is exercised |
| users | **15** (12 new + 3 base) | 3 Pending (approval queue non-empty), 1 Rejected, 2 Heads with mailboxes |
| keyword rules | 5 | 477 emails keyword-matched: 339 approved, 138 pending approval |
| task comments | 506 · notifications 668 · activity logs 1,019 | proportional, timestamped inside the 90-day window |

Overdue work is seeded directly as `Late` with `overdueNotifiedAt` set, so the 5-minute overdue cron cannot flip counts mid-audit. Base users' `gmailEmail`/token fields are set with **fake tokens** so `GET /api/gmail/status` populates the account dropdown; side effect: the 10-minute auto-sync cron fails against Google with these tokens (log noise only; `--clean` reverts).

---

## 2. Role × module matrix

Legend: OK = verified correct (API value re-derived from Mongo) · — = correctly unavailable (role gate verified 403 or nav hidden) · numbers refer to the defect list in §3.

| Module | Admin | Head | Employee |
|---|---|---|---|
| Dashboard | OK (all 8 tiles = DB) | OK scoped, **but D1 stale-cache leak on account switch** | Tiles from capped fetch: **D3** (Completed uses createdAt), **D4** (200-row cap) |
| Inbox (list/filters/account filter) | OK — 1,397 total; per-mailbox filter = DB for all 4 boxes | OK — 332, confined to `billing@`; cross-mailbox filter returns 0; dropdown hidden for single mailbox | — (API 403, nav hidden; assigned mail reachable via task/thread only) |
| Threads / conversations | OK — counters (messageCount, unreadCount, first/last dates, unanswered=662) = DB | OK — `fetchedBy` scoped in-pipeline | Per-thread object check verified (403 on foreign thread, 200 on own) |
| Tasks | OK — 409, filters = DB | OK — createdBy∪assignedTo = 52 = DB; bulk on foreign tasks refused | OK — 62 = DB; `assignedTo` override ignored; foreign task 403; **D2** raw sender shown as client on bulk-assigned tasks |
| Clients | OK — list + client-stats counts = DB | List counts are **global**, timeline is scoped → 43 vs 7 for the same client (**D5**) | Full list with global counts visible (**D5**) |
| Reports (overall, timelines, employee, SLA) | OK — every figure re-derived exactly (incl. SLA median/p90/breach to the digit) | OK scoped (backlog 62, firstResponse 33), **but no Reports nav in the UI (D6)** | — (403) |
| Users & Approvals | OK — 15 users, 3 Pending visible, approve flow works | List readable (assignment use), no sensitive fields leaked; `/users/:id` 403 | — (403) |
| Keyword rules / approvals | OK — 137 pending = DB; approval mutates correctly | OK — scoped to own mailbox (34 = DB); approving a foreign email: 404, unchanged | — (403) |
| Activity Log | OK — 1,026 = DB, deep page fast | — (403) | — (403) |
| Notifications | own-only | own-only | own-only; unread count 22 = DB |
| Profile | works | works | works (light coverage — see §6) |

Cross-scope write probes all failed closed: Head bulk-assigning Admin's emails (404, fail-closed on mixed sets), Head bulk-completing Admin's tasks (403), Employee PUT on another user's task (403), Employee comment read/write on a foreign task (403), Head approving a pending email on Admin's mailbox (404).

Pagination consistency: full page-walks (limit 100) over emails with `sort=-date`, `sort=subject`, and `sort=status` (highly non-unique key), tasks `sort=-createdAt`, and threads default sort — **zero duplicates, zero lost rows** in every walk (`_id`/`threadId` tiebreaker in `server/utils/paginate.js` works). `limit=5000` clamps to 100.

---

## 3. Defects (ordered by severity)

### D1 — HIGH · Cached API responses can be served to a *different user* after an account switch
- **Observed:** logged in as Admin, opened the dashboard, then switched the same browser to the Head account. The Head dashboard rendered **"Awaiting reply 220"** — the Admin's workspace-global SLA backlog — while the Head-scoped API value is **62**. It corrected itself only after the browser cache expired.
- **Cause:** report/thread/timeline endpoints send `Cache-Control: private, max-age=15–60, stale-while-revalidate=60` with `Vary: Origin, Accept-Encoding` — **no `Vary: Authorization`**. The browser caches by URL, so user A's payload satisfies user B's request for up to max-age+SWR (≈75–120 s).
- **Where:** `server/controllers/reportsController.js:28` (`setReportCacheHeaders`), `server/controllers/gmailController.js:1340` (threads), `server/controllers/clientController.js` (timeline `Cache-Control`).
- **Expected:** add `Vary: Authorization` (or drop browser caching on scoped payloads). Server-side Redis scoping is already correct — this is purely the HTTP cache layer.
- **Repro:** same browser: login admin → view dashboard → logout → login head within 30 s → head dashboard shows admin's numbers.

### D2 — MEDIUM-HIGH · Inbox bulk-assign writes the raw sender header into `Task.clientName`
- **Observed:** `POST /api/gmail/emails/bulk-assign` created tasks with `clientName: "\"Vivek Gandhi\" <accounts@nimbussoftware.example.com>"` although the email carries `clientId` → *Nimbus Software*. The raw address renders in the Tasks UI client column, and the task is invisible to every per-client counter (`getTaskCountsByClient` groups by lower-cased `clientName`).
- **Where:** `server/controllers/gmailController.js:2489` — `clientName: email.from || 'Inbox Client'`. The sync path does it right (`server/utils/taskHelper.js:83` `buildTaskForEmail` → `resolveClientForSender`); bulk-assign skips it.
- **Expected:** resolve via `resolveClientForSender(email.from)` like every other task-from-email path.

### D3 — MEDIUM · Employee dashboard "Completed — Last 30 days" counts the wrong field
- **Observed:** tile shows **9**; tasks actually completed in the last 30 days: **12**. The 9 is "tasks *created* in the last 30 days that are now Completed".
- **Where:** `client/src/pages/Dashboard.jsx:263` — `if (new Date(t.createdAt).getTime() >= monthAgo) completed += 1` — should use `completedAt` (the server records it; 0 completed tasks lack it in this dataset).
- **Expected:** 12. A task created 6 weeks ago and finished yesterday is not counted today.

### D4 — MEDIUM · Dashboard tiles are derived client-side from a 200-row capped fetch
- **Observed:** the dashboard fetches `api.get('/tasks')` with no `page` param (`client/src/pages/Dashboard.jsx:184`); the server caps legacy-mode responses at `LIST_LEGACY_CAP = 200` rows (`server/utils/paginate.js:18`). The Open/Due-today/Overdue/Completed tiles and the "Needs attention" list are computed from that truncated array (`Dashboard.jsx:253–270`).
- **Impact:** any user with more than 200 tasks gets silently wrong tile numbers (newest-200 only). Current employee has 64, so today's tiles are right — this is precisely the class of bug that only appears at volume. Admin/Head "office" tiles are safe (they come from `/api/reports/overall`, which is server-computed) but their "Mine" scope tiles share the capped source.
- **Expected:** tiles from a count endpoint (e.g. `/api/reports/overall`-style scoped counts), not from a truncated list.

### D5 — MEDIUM · Client list/stats counters are workspace-global for every role, but drill-down is scoped
- **Observed (Head):** client list shows *Northline Logistics* `mailCount: 43`; the same client's timeline for that Head returns **7** emails (his mailbox slice). The two numbers sit one click apart with no explanation. An **Employee** sees the full client list with global email/task volumes for clients they have no work on.
- **Where:** `server/utils/clientService.js:39–73` — `getTaskCountsByClient`/`getMailCountsByClient` cache under key `'all'` with no role scope; `server/routes/clientRoutes.js:14` serves the list to all roles; timeline (`clientController.getClientTimeline`) *is* scoped.
- **Expected:** either scope the list counters like the timeline, or label them as workspace totals. Also a mild information-disclosure question for the Employee role (client contact data + volumes).

### D6 — LOW · Head has no Reports page in the UI although the API fully supports Head-scoped reports
- **Observed:** Head sidebar shows Dashboard/Inbox/Tasks/Clients/My Profile only. Every `/api/reports/*` endpoint serves Heads with correct scoping (verified: overall, timelines, employee report, SLA). A Head can see SLA tiles on the dashboard but has no way to reach the full report — a dead end.
- **Where:** client sidebar nav (`client/src/components/Sidebar.jsx`) — client-side role gating.

### D7 — LOW · Email-timeline chart silently drops boundary-day mail
- **Observed:** `/api/reports/email-timeline?days=90` sums to **1,390**; emails received in the last 90×24 h: **1,392–1,397** depending on boundary treatment; 7 rows fall outside the 90 IST bucket keys and are ignored (`reportsController.js` `buildDayBuckets` keeps "one day of slack … rows outside the key list are simply ignored"). Sum matches its own buckets exactly (verified 1,390 = 1,390), so this is a definition/labelling nit, not a math error.

### Notes (not defects)
- Auth rate limiter (10 logins / 15 min / IP, `server/index.js:57–59`) will lock out an office behind one NAT IP at exactly 10 logins; it fired during this audit (429).
- The "Keyword rules" button badge shows the pending-approvals count capped at 99+ (`EmailInbox.jsx:1707`) — intentional but easy to misread as a rule count.
- "Deletion is locked / export a backup to unlock" gating on the inbox is an unusual flow; not exercised destructively here.

---

## 4. Timing (local API, MongoDB in Docker, ~2,000 emails / 412 tasks / 1,038 logs)

Nothing came close to the 500 ms flag. COLD = Redis `md:*` flushed first.

| Endpoint | ms |
|---|---|
| `/api/gmail/emails` p1 limit 25 (admin) | 13–14 |
| `/api/gmail/emails` p56 limit 25 (deepest page) | 14 |
| `/api/gmail/emails` full walk p1…p14, limit 100 | 17–82/page (max 82) |
| `/api/gmail/emails?q=invoice` | 62 |
| `/api/gmail/emails?read=false` | 58 |
| `/api/gmail/threads` p1 / p30 (deep) | 31 / 36 |
| `/api/gmail/threads` COLD, and `unanswered=true` COLD | 28 / 30 |
| `/api/tasks` p1…p5 walk, limit 100 | 7–12 |
| `/api/reports/overall` COLD / WARM | 40 / 5 |
| `/api/reports/client-stats` COLD | 20 |
| `/api/reports/sla` COLD (admin / head) | 21 / 9 |
| `/api/reports/sla/timeseries` COLD | 18 |
| `/api/reports/email-timeline?days=90` COLD | 17 |
| `/api/reports/employee` COLD | 9 |
| `/api/users/activity-logs` p1 / p20 | 9 / 11 |
| `/api/clients` COLD | 7 |

Caveat: 2,000 emails is realistic for a small office but the indexes are built for far more; offset pagination cost was not observable at this depth (max skip ≈ 1,900). No conclusion should be drawn about 100k-row behaviour from this table.

---

## 5. Numbers re-derived and confirmed exact

- Dashboard `/api/reports/overall` for Admin, Head, and second Head: all 8 figures each = fresh Mongo counts.
- SLA summary (admin): firstResponse count 146 / median 2220 / p90 4200 / max 8430 / breach 142 / pending 172; resolution 57 / 6300 / 10620 / 11640 / breach 54; backlog count 220 — every one matched an independent JS re-derivation from raw email/task rows.
- Thread counters (messageCount, unreadCount for the calling user, firstInboundAt, lastMessageAt, unanswered=662) = DB.
- Client-stats email/task counts for all 25 clients = DB (global definition, see D5).
- Head/employee scoped list totals (332 / 62 / 52 / 34 / 22 unread notifications) = DB.

## 6. Not verified (and why)

- **Real Gmail flows** — OAuth connect, actual sync, reply sending, attachment download: no Google account can be connected in this environment; seeded tokens are fakes. These paths were exercised only to their role gates / validation.
- **AI endpoints** (`/api/ai/summarize-email`, extract-actions): call an external Gemini API; not invoked.
- **Email delivery side-effects** (password reset mail, notification emails): no SMTP verification.
- **Socket.io realtime** (presence, live notification push): not exercised; only the REST surfaces.
- **Destructive operations** (`DELETE /api/gmail/emails` clear-all, user hard flows, bulk delete): deliberately not run against the shared demo DB; only small, reversible mutations were made (3 assignments, 1 approval, 1 user approve→reverted).
- **The client UI in depth**: the client was being rewritten by another workstream *during* this audit; the UI findings above (D3, D4, D6, badges) were pinned to the exact source lines current at audit time and may move. Board/Calendar task views, Excel export, and the search palette were not exercised.
- Offset-pagination behaviour beyond ~2,000 rows (see timing caveat).
- One benign bookkeeping oddity: the seeder's re-run wipe reported 4,598 deletions vs 4,599 tracked inserts once; post-run totals were nonetheless identical and all invariants passed. Not chased.

## 7. Audit-time mutations left in the DB

The audit itself created: 3 tasks (2 via bulk-assign — these carry the D2 raw-sender clientName, kept deliberately as a visible repro — and 1 via keyword approval), 3 emails moved to `assigned`, 1 email approved, ~2 notifications, ~19 activity-log rows. Re-running `node scripts/seedDemoData.js` resets everything seeded (audit artifacts on seeded emails disappear with them).
