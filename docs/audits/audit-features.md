# K M KOTHARI (formerly MailDesk) — Feature Gap Analysis

**Scope:** `/Users/darshank/Desktop/WEBX/MailDesk/MailDesk`
**Stack:** React 19 + Vite 8 + Tailwind 3 (client) · Node + Express 5 + Mongoose 9 + Socket.io 4 (server) · MongoDB Atlas · Gmail API · Gemini (`@google/generative-ai`)
**Size:** ~15.1k LOC. Server ~4.2k, client ~10.9k. **0 tests, 0 CI config, 0 Dockerfile, 0 env-var wiring on the client.**

---

## 0. Executive summary

This is a **more complete product than its age suggests**. Verified working: multi-account Gmail OAuth with AES-256-GCM encrypted tokens, keyword-driven auto-assignment with a human approval queue, email→task conversion, recurring tasks, **Kanban + Calendar + List task views with drag-and-drop**, task comments, activity logging, five reports with hand-rolled SVG charts and CSV export, an AI email summarizer, and a mobile drawer nav.

Four things stop it from being deployable and trustworthy today:

1. **It cannot be deployed at all.** `client/src/api/axios.js:5` hardcodes `http://localhost:5015/api` and `client/src/components/NotificationBell.jsx:33` hardcodes `io('http://localhost:5015')`. There is **zero `import.meta.env` usage in the entire client**. The README (lines 90–91, 167–173) claims `VITE_API_URL` wiring that does not exist.
2. **Task filtering is hard-crashed.** `client/src/pages/TaskList.jsx` calls `setSelectedTaskIds(...)` and `setSelectAll(...)` at lines 692/693, 712/713, 747/748 — **neither is declared anywhere in the file** (verified: 3 call sites, 0 declarations). Changing the Creator filter, the Priority filter, or clicking *any* status pill throws a `ReferenceError`. There is no error boundary. Leftovers from a bulk-select feature that was removed.
3. **A same-origin XSS hole in the task view.** `TaskList.jsx:1156` and `:1742` render untrusted client email HTML in an iframe with `sandbox="allow-scripts allow-same-origin ..."` — that combination **cancels the sandbox** and lets attacker HTML run scripts with access to the app's origin, where the JWT sits in `localStorage`. `EmailInbox.jsx:1343` gets this right (no `allow-scripts`); TaskList does not. `renderEmailContent` (`TaskList.jsx:18`) only strips `<script>` tags — not `onerror=`, not `javascript:`.
4. **No conversation model and no SLA concept.** `models/Email.js` has no `threadId` (Gmail returns one, and `gmailController.js:936` reads it during reply then discards it). And the only time metric anywhere is `deadline` vs `now` — there is no first-response time, no resolution time, no per-client SLA. For a firm whose product *is* responsiveness, that scoreboard is missing.

There is also real **built-but-unreachable** surface: `POST /api/tasks/bulk` (delete/status/reassign) has a controller, route, and Zod schema and is called from **nowhere**; socket events `task:<id>:comment` / `:commentDeleted` are emitted by `commentController.js` and **no client listens**; `App.css` (184 lines) is never imported; seven custom CSS classes are used across the app and **defined nowhere**, so every loading skeleton is a blank white box.

---

## 1. Capability matrix — what exists today

Maturity key: **Solid** = works, reasonably complete · **Partial** = works but materially incomplete · **Stub** = exists in one layer only · **Broken** = present but non-functional.

### 1.1 Authentication & identity

| Feature | Where implemented | Maturity | Notes |
|---|---|---|---|
| Email/password register | `server/controllers/authController.js:23-90` | Partial | First user auto-becomes Admin+Approved; later self-registrations are `Pending`. **Bug: a `Pending` user is still issued a working JWT (`:68`, `:82`)**, so they can call protected routes even though `loginUser:118-123` blocks login. Client `Register.jsx:9` holds a `role` state with **no selector in the JSX and no `setRole` call** — dead code; always sends `Employee`. |
| Login + JWT (7d) | `authController.js:95-150` | Solid | `tokenVersion` claim enables revocation. |
| Token revocation on password change | `userController.js:373`, `authMiddleware.js:30-32`, `index.js:156-158` | Solid | Enforced on both HTTP and Socket.io. |
| Forgot password | `authController.js:155-226` | Partial | Mails a 12-char temp password **in cleartext**; never expires, single-use not enforced, no forced rotation. No reset-with-token page exists in the client. |
| Change own password | `userController.js:349-383`, `Profile.jsx:141` | Solid | |
| Role guard (Admin/Head/Employee) | `middleware/authMiddleware.js:50-63` | Solid | 3 hardcoded roles, no per-permission granularity. |
| Single-Admin constraint | `userController.js:127-136, 148-157` | Solid | |
| Client-side route guards | `ProtectedRoute.jsx:9`, `AdminRoute.jsx:21` | Partial | localStorage-only (token presence, `user.role` string) — trivially spoofable, but server-side checks are the real enforcement, so this is cosmetic rather than a hole. |
| Session heartbeat | `ProtectedLayout.jsx:58` | **Risk** | Polls `GET /auth/me` **every 8 seconds** per logged-in user = ~112 requests/user/15 min. The general rate limiter is **300 req/15 min per IP** (`index.js:28-34`). An office behind one NAT IP exhausts its own quota at **~3 concurrent users** on heartbeat traffic alone. |
| Request validation (Zod) | `middleware/validate.js` + `schemas.js` | Partial | Covers auth, users, task create, task bulk, gmail reply/bulk-assign. **Absent** on keyword rules, clients, comments, and task update. |
| SSO / Google Workspace login | — | **Absent** | Gmail OAuth grants mailbox access only, not app login. |
| 2FA / MFA · session & device list · IP allowlist | — | **Absent** | |

### 1.2 Gmail integration

| Feature | Where implemented | Maturity | Notes |
|---|---|---|---|
| Google OAuth connect | `gmailController.js:133-293` | Solid | State is a signed 10-min JWT (`OAUTH_STATE_SECRET`) — good CSRF protection. |
| Multi-account (primary + linked) | `models/User.js:41-51`, `gmailController.js:247-281` | Solid | Head is forced to `primary` mode and constrained by `maxConnectedAccounts` + `allowedGmailAccounts`. |
| Token encryption at rest | `utils/tokenCrypto.js` (AES-256-GCM) + backfill `scripts/encryptExistingTokens.js` | Solid | |
| Manual sync | `POST /api/gmail/fetch` → `gmailController.js:497-542` | Partial | Admin triggers a sync for **all** users. |
| Auto sync | `utils/cronJobs.js:74-106`, every 10 min | Partial | Full `messages.list` (max 150, `includeSpamTrash:true`) each run, then `messages.get` per unseen id. No `historyId` delta sync, no Gmail `users.watch` push, no backfill past 150. |
| HTML body + inline CID images | `gmailController.js:28-89, 356-382` | Partial | Inline images become `data:` URLs **stored inside the Mongo document** — bloats `Email.body`, risks the 16 MB BSON cap on image-heavy mail. |
| Attachment metadata + download proxy | `models/Email.js:51-58`, `gmailController.js:1062-1158`; UI `EmailInbox.jsx:603`, `TaskList.jsx:413` | Solid | Per-role access check; streamed on demand, not stored. |
| Gmail label capture → UI tabs | `Email.labelIds`; `EmailInbox.jsx:37` | Partial | Read-only tabs: Inbox / Sent / Promotions / Social / Updates / Spam with counts. Cannot apply/remove labels; the Spam tab has no mark-as-spam/not-spam action. |
| **Server-side search** | `gmailController.js:544-582` (`?q=`); UI `EmailInbox.jsx:345` with 400 ms debounce | **Solid but shallow** | It *is* wired. But the regex covers only `subject` and `from` — **email bodies are not searchable**, and there is no text index (regex scan on every keystroke-debounce). |
| Reply to email | `gmailController.js:870-981`; UI `EmailInbox.jsx:590` | Partial | Correct `In-Reply-To`/`References`/`threadId` on the Gmail side. But: plain-text textarea only, no CC/BCC, no subject edit, no quoted history, no attachment upload, no signature, no draft — and **the sent reply is never persisted locally**, so the app itself never shows a reply happened. |
| Bulk assign emails → tasks | `gmailController.js:986-1057`; UI `EmailInbox.jsx:283` | Solid | With assignee + deadline + priority. |
| Delete email(s) | `gmailController.js:587-625` | Partial | Hard delete, no soft-delete/restore. UI gates deletion behind a "Download Emails" flag stored in `localStorage.emailsDownloaded` (`EmailInbox.jsx:41, 514`) — a client-side-only safety interlock. |
| Excel backup export | `EmailInbox.jsx:394-515` (styled `.xls` HTML blob) | Solid | UI copy at `:799` still says "CSV". |
| Disconnect account | `gmailController.js:699-811` | Partial | **Deletes all of that account's emails** as a side effect — permanent data loss on a mis-click. |
| Duplicate-connection cleanup | `gmailController.js:814-864` | **Risk** | `deduplicateConnections()` runs on **every** `GET /api/gmail/status` and every OAuth callback; loads *all* users and may `save()` many. O(users) writes on a polled endpoint. |
| Threading / conversation view | — | **Absent** | No `threadId` on `Email`. |
| Compose new · forward · drafts | — | **Absent** | Reply only. |
| Read/unread · star · snooze · archive | — | **Absent** | `Email.status` is only `unassigned`/`assigned`. |
| Full-text (body) search index | — | **Absent** | |
| Templates / canned responses / signatures | — | **Absent** | |
| Sort control in the inbox | — | **Absent** | Server order (date desc) only. |

### 1.3 Rules & auto-assignment

| Feature | Where implemented | Maturity | Notes |
|---|---|---|---|
| Keyword rules CRUD | `models/KeywordRule.js`, `keywordRuleController.js:13-167` | Solid | Uppercased unique keyword → one user; `autoApprove`; `isActive`. |
| Rule evaluation at sync | `gmailController.js:393-416` | Partial | Loads all active rules per email; word-boundary regex over `subject + body`; **first match wins, no rule ordering**; no sender/domain/recipient/attachment conditions; evaluated only at ingest. |
| Retroactive scan on rule creation | `keywordRuleController.js:70-93` | Solid | |
| Approval queue | `Email.approvalStatus`, `keywordRuleController.js:172-311` | Solid | Single + bulk approve with notification and activity log. |
| Approval / rules UI | `components/KeywordApprovalModal.jsx` (480 lines), launched only from `EmailInbox.jsx:1515` | Partial | Two tabs (Pending Approvals, Manage Rules). **No rule editing** (delete + recreate), no priority/ordering, no rule test/preview, no multi-keyword or regex, **no reject/dismiss action** for a pending email — approve is the only exit. Not in the sidebar, so discoverability is poor for a core feature. |
| Round-robin / load-balanced assignment | — | **Absent** | |
| Duplicate / merge detection | — | **Absent** | Dedup only by Gmail `messageId`. |

### 1.4 Tasks

| Feature | Where implemented | Maturity | Notes |
|---|---|---|---|
| Task CRUD | `taskController.js:14-284`, `models/Task.js`, `TaskList.jsx` | Solid | title, description, linkedEmail, assignedTo, clientName, deadline, status, notes, createdBy, priority, isRecurring, recurrence, parentTaskId. |
| **Kanban board with drag-and-drop** | `TaskList.jsx:614-652, 761-801` | **Solid** | Pending / Completed / Late columns, HTML5 DnD, optimistic update with revert on failure, role-correct drop permissions (Employee may only drag own task → Completed). |
| **Calendar month view** | `TaskList.jsx:761-801, 872-881` | Partial | Month grid, prev/next/Today, tasks placed by deadline, click-empty-day prefills Create. No drag in calendar, no week/day views. |
| List view + filters | `TaskList.jsx:686-752` | **Broken** | Creator, Priority, and Status filters all call the undefined `setSelectedTaskIds`/`setSelectAll` → `ReferenceError` on every filter interaction. |
| Email → task conversion | `utils/taskHelper.js:10-70`, deep-link `?linkEmail=&title=&clientName=` | Partial | **Falls back to `clients[0].name` (`taskHelper.js:35`)** — mail from an unknown sender is attributed to whichever client sorts first, which (because of the seeder) is usually a *fake* client. Default deadline hardcoded +3 days. |
| Role-scoped visibility | `taskController.js:78-100, 105-135` | Solid | |
| Priority | `Task.priority` (Low→Urgent), filter + badges in UI | Partial | Set and displayed; nothing consumes it — no SLA weight, no sort weight, no escalation. |
| Recurring tasks | `utils/recurrenceHelper.js`; UI checkbox + Daily/Weekly/Monthly + `🔁` badge | Partial | Next occurrence spawns **only on completion** (`recurrenceHelper.js:15`) — miss one and the series silently dies. No end date, no occurrence count, no "3rd working day of month" (exactly how Indian statutory deadlines work). |
| Overdue → Late automation | `utils/cronJobs.js:14-71`, every minute | **Risk** | Notifies the assignee **and every Admin+Head, every minute, forever**. A task 2 days late has produced ~2,880 notification rows per supervisor. `Late` is terminal — extending a deadline never restores `Pending`. |
| Task comments | `models/TaskComment.js`, `commentController.js`; UI thread with delete + Enter-to-send | Partial | Persisted, ACL'd, notified. **Socket events `task:<id>:comment` are emitted (`commentController.js:102-111`) and no client listens** — real-time comments are dead code. No internal/external flag, no @mentions, no edit, no attachments. |
| Bulk actions (delete/status/reassign) | `taskController.js:302-371`, `taskRoutes.js:26`, `schemas.js:86-92` | **Stub — backend only** | No client call. The UI remnants that *would* have used it are the very lines causing the filter crash. |
| Task search / pagination / sort / assignee filter | — | **Absent** | `TaskList` renders every task with no search box and no pagination. |
| Subtasks · checklists · dependencies | — | **Absent** | |
| Time tracking · effort estimates | — | **Absent** | |
| Attachments on tasks | — | **Absent** | Files arrive only via `linkedEmail`. |
| Task templates · tags/labels | — | **Absent** | |
| "My Day" view | — | **Absent** | |
| Reassignment history | — | **Absent** | `assignedTo` overwritten in place (`taskController.js:217-226`); only a free-text `ActivityLog` line survives. |
| Escalation ladder | — | **Absent** | |

### 1.5 Clients / CRM

| Feature | Where implemented | Maturity | Notes |
|---|---|---|---|
| Client model | `models/Client.js` | Partial | name (unique), associatedEmails[], contactPerson, email, phone, notes, status. |
| **Two competing client APIs and two client UIs** | `clientController.js` (`/api/clients`) ↔ `taskController.js:376-470` (`/api/tasks/clients`) | **Broken by duplication** | Different auth (Admin+Head vs Admin-only), different fields (the `/tasks/clients` version ignores contactPerson/phone/notes/status), different response envelopes (`{success,data}` vs bare), and **only the `/tasks/clients` path writes an activity log**. `ClientList.jsx` uses `/clients`; `ManageUsers.jsx`'s "Manage Clients" tab and `TaskList`'s client autocomplete use `/tasks/clients`. Two admins on two screens get different behaviour on the same record. |
| Client list UI | `ClientList.jsx` (859 lines) | Solid | Search (client-side), status pills, **Table ↔ Card-board toggle**, Add/Edit modals, Admin-only delete, per-client `taskCount` / `mailCount`. |
| Client mail/task counts | `clientController.js:10-45`, `reportsController.js:184-227` | Partial | Loads **every** task and **every** email into Node memory to count (`clientController.js:13-14`); `getClientStats` runs 3 queries per client in a loop. |
| Task ↔ Client linkage | `Task.clientName` is a **String**, not a ref | **Weak** | Renaming a client orphans all historical tasks and breaks every client report. |
| Client detail / timeline page | — | **Absent** | The `taskCount`/`mailCount` tiles are dead-end numbers — you cannot drill into them. |
| Multiple contacts per client | — | **Absent** | One `contactPerson` string. |
| Client-level SLA · client portal | — | **Absent** | |
| Seeded demo clients | `seeders/clientSeeder.js`, invoked at `config/db.js:14` | **Risk** | Seeds Reliance / TCS / Infosys / HDFC / Wipro into **every** database on **every** boot. These appear in the live client list, and via `taskHelper.js:35` they capture real unmatched client mail. |

### 1.6 Notifications

| Feature | Where implemented | Maturity | Notes |
|---|---|---|---|
| Notification model + helper | `models/Notification.js`, `utils/notificationHelper.js` | Solid | |
| Socket.io transport | `index.js:128-192` — JWT-authed, auto-joins a per-user room | **Broken in prod** | Server is correct; client hardcodes `io('http://localhost:5015')` (`NotificationBell.jsx:33`). It also opens the socket **even when nobody is logged in** (the null-check at `:28` only guards the initial fetch). |
| Notification bell UI | `NotificationBell.jsx` | Partial | Badge caps at "9+", dropdown shows **only the first 10**, mark-one/mark-all read, click-to-navigate (`task_assigned`→`/tasks`, else `?expandTaskId=`). No "view all" page, no pagination, no delete, no grouping, no browser Notification API, no sound. |
| Email: task completed | `taskController.js:178-181` via `utils/emailHelper.js` | Solid | |
| Email: account approved · temp password | `userController.js:162-193`, `authController.js:199-218` | Solid | Styled HTML. |
| Per-user preferences · digests · quiet hours | — | **Absent** | `Profile.jsx` has **no notification settings section at all**. |
| Browser push · mobile push | — | **Absent** | |
| Slack / WhatsApp / Teams | — | **Absent** | |

### 1.7 Reports & analytics

| Feature | Where implemented | Maturity |
|---|---|---|
| Overall stats (8 counters) | `reportsController.js:88-121` | Solid |
| Employee performance (weekly/monthly, completion rate) | `reportsController.js:9-83` | Solid |
| Task creation timeline (30 d) | `reportsController.js:126-177` | Solid |
| Email received timeline (7/14/30 d, received vs assigned) | `reportsController.js:232-289` | Solid |
| Client stats | `reportsController.js:184-227` | Partial — N+3 queries per client in a loop |
| Reports UI | `admin/Reports.jsx` (728 lines) | Solid — 6 KPI cards, two **hand-rolled SVG bezier area charts** with hover tooltips, expandable per-employee task breakdown. No chart library in `client/package.json`. |
| **CSV export** | `Reports.jsx` | Partial — employee performance table only; no client or email export, no PDF |
| Inbox `.xls` backup export | `EmailInbox.jsx:394-515` | Solid |
| **SLA / first-response / resolution time** | — | **Absent** |
| **Workload heatmap / capacity** | — | **Absent** |
| **Backlog trend** | — | **Absent** — the timeline charts *created*, not *outstanding* |
| **Custom date range · scheduled/emailed reports · drill-through** | — | **Absent** |
| Per-role dashboards | `Dashboard.jsx` | Partial — one page with role-conditional tiles; no recent-activity feed, no upcoming-deadline list, no quick actions |

### 1.8 Governance & admin

| Feature | Where implemented | Maturity | Notes |
|---|---|---|---|
| Activity log | `models/ActivityLog.js`, `utils/activityLogger.js`, UI `admin/ActivityLog.jsx` | Partial | Logged for login, gmail ops, task CRUD/bulk, comments, keyword rules, `/tasks/clients` CRUD, password change. **Not logged: user create, user update (role & status changes!), user delete, `/api/clients` CRUD, report exports, attachment downloads.** Schema is `{userId, action, details:String}` — **no IP, no user-agent, no target entity id, no before/after**. UI loads the entire log with no pagination, no search, no date filter, no export. |
| User management | `userController.js`, `admin/ManageUsers.jsx` (1014 lines) | Solid | Create Head/Employee, edit, inline Approve/Reject, delete with self-delete guard, plus a Head-permissions block (`maxConnectedAccounts` + allowed-Gmail checkbox list). No search, no pagination, no filters, no bulk approve, no invite flow, no admin-initiated password reset. **Bug:** the checkbox list and the "Additional Custom Authorized Emails" text field are bound to the *same* `allowedGmailAccounts` array (`:771-812`) — each overwrites the other. |
| Custom roles / granular permissions | — | **Absent** | 3 hardcoded enum values. |
| Team / department hierarchy | — | **Absent** | No `manager`, `team`, or `department` on `User`. |
| Delegation / out-of-office | — | **Absent** | |
| Onboarding / offboarding | Approve/Reject + cascade delete | **Risk** | `deleteUser` (`userController.js:249-263`) **deletes** the departing user's notifications, activity logs, and comments — erasing exactly the audit history you would need. |
| Data retention / purge · GDPR / PII · export-my-data | — | **Absent** | Email bodies (client PII, plus embedded base64 images) are stored indefinitely, unencrypted, with no TTL. OAuth tokens *are* encrypted; content is not. |
| Backup / restore | — | **Absent** | Only the manual `.xls` inbox download. |

### 1.9 AI

| Feature | Where implemented | Maturity |
|---|---|---|
| Summarize a single email (Gemini 2.5 Flash, 3–4 bullets) | `aiController.js:6-49`, `aiRoutes.js:6` (Admin/Head), UI `EmailInbox.jsx:623` with Summarize / Re-summarize | Solid — and the *only* AI feature |
| Thread summarization · reply drafting · auto-categorize · priority scoring · action-item extraction · sentiment · smart search · auto-tag by client | — | **All absent** |

*`aiController.js:45` returns HTTP **550** — not a valid status code — on an API-key error.*

### 1.10 Platform, ops & reliability

| Concern | Status | Evidence |
|---|---|---|
| Security headers, rate limiting, NoSQL sanitising | Present | `index.js:20-52` (helmet, express-rate-limit, express-mongo-sanitize) |
| **Rate limit vs. shared office IP** | **Broken in practice** | 300 req/15 min per IP, while `ProtectedLayout.jsx:58` polls `/auth/me` every 8 s (~112 req/user/15 min) → self-throttles at ~3 concurrent users behind one NAT |
| Global error handler + process crash guards | Present | `index.js:107-122` |
| **Client API + Socket URLs** | **Broken** | `api/axios.js:5`, `NotificationBell.jsx:33`; **no `import.meta.env` anywhere in the client** |
| 401 response interceptor | **Missing** | Request interceptor only; README claims otherwise |
| React error boundary | **Missing** | Any render/handler throw blanks the app — which is exactly what the TaskList filter bug does |
| Multi-instance readiness | **No** | No Socket.io Redis adapter; `node-cron` runs in-process → N instances = N× Gmail syncs and N× overdue notifications |
| Destructive startup job | **Risk** | `config/db.js:16-27` runs `Email.updateMany({_id:{$nin:linkedEmailIds}}, {status:'unassigned', assignedTo:null})` on **every boot** |
| Pagination | Inbox: client-side (25/50/100) over a full download. Tasks / clients / activity log / users: **none** | `EmailInbox.jsx:77-78`; `gmailController.js:544-582` returns every email with full bodies |
| Health check | Minimal | `index.js:59-61` returns a static string; `config/db.js:28-31` deliberately swallows connection failure → app reports healthy with no database |
| Structured logging · error tracking · monitoring · alerting · feature flags · migrations · CI · Docker | **All absent** | |
| i18n | **No** | Zero i18n libs; all strings hardcoded English |
| PWA / manifest / service worker / offline | **No** | `client/index.html` has favicon + font + title only |
| Mobile responsiveness | Partial | Hamburger + drawer sidebar exist (`Navbar.jsx:55`, `Sidebar.jsx:127-138`). But `sm:`×102, `md:`×32, `lg:`×42, **`xl:` 0, `2xl:` 0** — desktop-first at `lg`, never adapts above 1024px. `ProtectedLayout` uses `lg:pl-60` (15 rem) against a `w-[260px]` (16.25 rem) sidebar → 4 px overlap. `Sidebar.jsx:136` uses `z-45`, **not a valid Tailwind class** → no z-index at all. |
| **Broken styling (silent)** | **Risk** | Seven classes used app-wide and **defined nowhere**: `animate-fade-in`, `animate-slide-in`, `skeleton-shimmer`, `hover-glow-card`, `animate-shake`, `custom-scrollbar`, `email-body-rendered-container`. Every loading skeleton is a static blank box (`index.css` defines `.animate-shimmer`, not `.skeleton-shimmer`). `App.css` (184 lines) is never imported. ~35 invalid Tailwind shades (`slate-850`, `indigo-550`, `red-650`, `emerald-250`, …) resolve to nothing. |
| Dark mode | **Half-built** | 58 `dark:` classes exist — **all inside `KeywordApprovalModal.jsx`**. `tailwind.config.js` sets no `darkMode` strategy (defaults to `media`), so on a dark-mode OS that one modal renders dark inside an otherwise light app. No toggle. |
| Accessibility | **Absent** | One `aria-label` in the whole client; modals have no `role="dialog"`, no focus trap, no Escape-to-close. Several pages apply `select-none` to `<main>`, blocking text selection of email and task content. |
| **Tests** | **Zero** | `server/package.json:8` is the npm default stub; client has no test runner |
| Docs | README only, **materially stale** | Lists a nonexistent `AdminOrHeadRoute.jsx`; claims `VITE_API_URL` + a 401 interceptor that don't exist; omits the clients, keyword-rules, AI, and comments endpoints; uses `ALLOWED_ORIGINS` where `.env.example` uses `FRONTEND_URL` |
| Dead code | | `jwt-decode` dependency never imported; `navigate` unused in `EmailInbox.jsx:62`; `{true && (...)}` at `EmailInbox.jsx:838`; `Register.jsx:9` role state; `Landing.jsx:14-21` shows hardcoded fake stats (1248 emails / 340 tasks) to logged-out visitors; `Dashboard.jsx:429` links to `/inbox?tab=accounts` but EmailInbox never reads a `tab` param — the link silently does nothing |

---

## 2. Gap analysis

Each gap is stated with **why it matters for this specific business** — a professional-services firm where staff share client mailboxes and partners need to prove work was done on time.

### 2.1 Email workflow

**Threading & conversation view — the single biggest product gap.** `models/Email.js` has no `threadId`, though Gmail returns one on every fetch and `gmailController.js:936` already reads it during reply before discarding it. A 10-message negotiation renders as 10 unrelated rows; keyword rules fire on each reply and can spawn 10 duplicate tasks; nobody can see what was said before. The app models *messages* while the firm works in *matters*. **Consequence:** staff keep opening Gmail to get context, which defeats the entire premise of centralisation.

**Replies are invisible inside the app.** `replyToEmail` sends via Gmail and writes nothing locally. The app can never show "replied", can never compute first-response time, and cannot warn that two people are both drafting a reply.

**Compose, forward, drafts, CC/BCC, HTML, attachments, signatures — all absent.** Reply is a plain textarea (`gmailController.js:956`). Staff cannot send an attachment or a formatted fee quote, so substantive outbound work still happens in Gmail — which means the activity log and every report are systematically incomplete.

**Read/unread, starred, snooze, archive.** `Email.status` is only `unassigned|assigned`. There is no way to say "seen" or "revisit Friday". In a shared inbox that is the difference between a triage tool and a pile.

**Search exists but is shallow.** It *is* wired end-to-end (debounced 400 ms, `EmailInbox.jsx:345` → `gmailController.js:556-569`) — but it regex-scans only `subject` and `from`, with no index. **Email bodies are not searchable.** "Find the mail where the client agreed the fee" is a daily question and still cannot be answered.

**Saved views & advanced filters.** Fixed Gmail-label tabs and an account dropdown only. No date range, no assigned/unassigned filter, no combined "unassigned + High + this client + >2 days old", no sort control.

**SLA timers.** No `firstResponseAt`, no target, no breach state. The app can say a *task* is late; it cannot say a *client email* has sat unanswered for three days — which is the number a partner actually manages by.

**Auto-assignment is one-dimensional.** `KeywordRule` maps a keyword to one fixed user, first-match-wins with no ordering (`gmailController.js:407`), no sender/domain/mailbox/attachment conditions, no load balancing, and **no way to reject a pending suggestion** in the UI. If that one employee is on leave, their queue silently piles up.

**Duplicate / merge detection.** Only `messageId` dedup. The same matter arriving at two connected mailboxes creates two independent task streams.

**Templates, canned responses, signatures.** Absent — and a firm sends the same acknowledgement, document-request list, and fee note dozens of times a week.

### 2.2 Task workflow

**Filtering is crashed.** Before any new task feature, the three filter controls in `TaskList.jsx` throw `ReferenceError` (undefined `setSelectedTaskIds`/`setSelectAll` at `:692-693, :712-713, :747-748`), and with no error boundary the consequences are ugly. This is the most severe defect in the client.

**No task search and no pagination.** `TaskList` renders every task in the workspace. There is no search box at all — on a table that will grow to thousands of rows.

**Subtasks & checklists.** `Task` is flat. Real work ("file the return") is six steps across two people; today that's six disconnected tasks or one opaque one.

**Dependencies.** No blocker concept. "Can't file until the client sends the certificate" is invisible, so the task shows Late and the employee is blamed for a client delay — which will actively erode trust in the reports.

**Recurring tasks are fragile.** `recurrenceHelper.js:15` only spawns the next occurrence when the current one is *completed*. Miss one and the series stops silently with no alert. No end date, no occurrence count, and no "3rd working day of the month" rule — which is precisely how Indian statutory and compliance deadlines are expressed.

**Time tracking & effort estimates.** Absent. No basis for "is this client profitable?", "is this employee overloaded or just slow?", or any capacity planning.

**Attachments on tasks.** Absent — files arrive only if `linkedEmail` happens to have them. Work product produced *by* staff has nowhere to live.

**@mentions.** `commentController.js:80-98` notifies only the assignee and creator. You cannot pull a third colleague into a thread.

**Task templates & tags.** Absent; recurring engagement types (audit, ITR, GST return) are retyped every time.

**Bulk edit — built and unreachable.** `POST /api/tasks/bulk` supports delete/status/reassign and is called from nowhere. The half-removed UI for it is the cause of the filter crash — so finishing this feature and fixing the crash are the same piece of work.

**"My Day" view.** Kanban and Calendar exist (good), but an employee still has no single "what's on my plate today" screen.

**Reassignment history.** `assignedTo` is overwritten (`taskController.js:217-226`); only an unqueryable free-text log line survives. Accountability disputes ("I only got this yesterday") cannot be settled.

**Escalation ladder.** The overdue cron notifies everyone equally, every minute, forever (`cronJobs.js:39-64`). No tiering (assignee → Head at +1 d → Admin at +3 d), no dedup — so the signal is worthless within a day.

### 2.3 Collaboration

**Internal notes vs client-facing.** `TaskComment` has no visibility flag and `Task.notes` is one free-text field. Nothing structurally prevents an internal remark being pasted into a client reply, and there is no safe home for candid commentary.

**Shared-inbox ownership & collision detection.** Zero protection: no claim, no lock, no "who's on this". Two people replying to the same client is the defining failure mode of shared mailboxes, and it costs the firm credibility rather than costing developer time. The infrastructure is already there and unused — Socket.io with JWT auth and per-user rooms is live at `index.js:128-192`.

**Presence.** Same story: rooms exist, presence does not.

**Read receipts / seen-by.** Absent on both emails and tasks.

### 2.4 Client / CRM

**Two divergent client APIs used by two different screens** (`/api/clients` vs `/api/tasks/clients`) with different auth, fields, envelopes, and logging. This is a live consistency bug, not just debt.

**Client link is a string.** `Task.clientName: String` — rename a client and every historical task and client report silently detaches. Should be `clientId: ObjectId ref`.

**No client detail page or timeline.** `ClientList` shows `taskCount` and `mailCount` as dead-end numbers — you cannot click through to the underlying work. A chronological "all mail + tasks + comments for this client" page is *the* screen a partner wants before a call.

**Contact management.** One `contactPerson` and one `email`. Real clients have an accountant, a director, and a billing contact.

**Client-level SLA & tiering.** No way to express "Reliance is 4-hour response, everyone else 24 h".

**Client portal.** Absent — a legitimate P3, and the eventual answer to "where is my file?" calls.

**Seeded fake clients in production.** `clientSeeder.js` inserts five real-company names on every boot; `taskHelper.js:35` then attributes unmatched sender mail to `clients[0]` — usually one of those fakes. Every client report is quietly wrong today.

### 2.5 Admin / governance

**The audit trail is not audit-grade.** `{userId, action, details:String}` with no IP, no user-agent, no target id, no before/after — and the four most sensitive operations (**user create, role change, status change, user delete**) are **not logged at all** (`userController.js:43, 98, 234`). `/api/clients` CRUD is unlogged too. The viewer loads the whole collection unpaginated with no search, no date filter and no export. For a firm handling client financial data this fails a basic internal-controls review.

**Offboarding destroys evidence.** `deleteUser` deletes the departing user's activity logs, notifications and comments (`userController.js:255-259`) — the audit trail of the person most likely to be under scrutiny is the first thing erased.

**Data retention & purge.** Nothing expires. Email bodies with client PII plus embedded base64 images accumulate forever with no TTL, archival tier, or purge policy.

**GDPR / PII.** No data classification, no export-my-data, no erasure workflow, no field-level encryption on bodies. Tokens are encrypted; content is not.

**Backup / restore.** Nothing beyond Atlas defaults and a manual `.xls` download. No documented restore runbook.

**Role granularity.** Three hardcoded roles. No "senior who may reassign but not delete", no "read-only auditor". The firm will hit this within months. Note also that **Employees cannot see the Inbox at all** (`Sidebar.jsx` shows it to Admin/Head only) — so assigned email context reaches them only through a linked task.

**Team / department hierarchy.** No `manager`/`team`/`department`. Reports cannot roll up by department, and "Head" means "whoever fetched this mail" rather than "head of this team".

**Delegation & out-of-office.** Absent — leave means a silently stalling queue.

**SSO (Google Workspace).** The firm already runs on Google. Password login plus a mailed cleartext temp password is strictly worse than the identity provider they already pay for.

**2FA, session/device list, IP allowlist.** All absent.

### 2.6 Analytics

The five existing reports are all **volume counts**. Missing:

- **First-response & resolution time** (per email, client, employee) — impossible today because replies aren't recorded.
- **SLA attainment %** — no SLA exists.
- **Workload heatmap** — open tasks × assignee × due date. A Head cannot see who is drowning.
- **Backlog trend** — the timeline charts *created*, not *outstanding*, so a growing backlog is invisible.
- **Per-client volume trend** — `getClientStats` is a snapshot, not a trend.
- **Custom date ranges** — only weekly/monthly and 7/14/30 presets.
- **Scheduled / emailed reports** — no Monday-morning summary; everything requires someone to log in and click.
- **Drill-through** — charts and client cards are not clickable.
- **Per-role dashboards** — one `Dashboard.jsx` with conditional tiles. Employees need "my day", Heads "team load", Admin "system health".

Performance: `getClientStats` runs 3 queries per client in a loop and `clientController.getClients` loads every task and email into memory — both degrade sharply past tens of thousands of rows.

### 2.7 Notifications

- **The transport is broken in production** (hardcoded localhost). Fix before anything else here.
- **No preferences anywhere** — `Profile.jsx` has no notification section at all.
- **No digest.** A daily/weekly summary is the highest-value, lowest-effort addition, especially for the Admin/Head who currently get the overdue firehose.
- **No quiet hours, dedup, or rate limiting.** The overdue cron is a notification bomb (§2.2).
- **No WhatsApp / Slack / Teams.** For an Indian office **WhatsApp is where staff actually are**; a WhatsApp Business API hook for "assigned" / "overdue" would drive adoption more than any in-app feature.
- **No browser or mobile push** — notifications exist only while a tab is open, and the bell shows only the first 10 with no "view all".

### 2.8 AI (Gemini already integrated)

`@google/generative-ai` is a dependency and `aiController.summarizeEmail` proves the plumbing works end-to-end, including graceful degradation when `GEMINI_API_KEY` is missing (`:15-17`). Everything below is incremental prompt work on infrastructure that already exists — the cheapest large-value surface in the codebase.

| Opportunity | Why it matters here | Approach |
|---|---|---|
| **Extract action items + deadlines → prefill the task form** | Removes the main manual step in the core loop (Head reads mail → types task → guesses deadline). | `POST /api/ai/extract-task` returning `{title, description, suggestedDeadline, suggestedPriority}`; human confirms before save. |
| **Auto-categorize + urgency score** | Replaces brittle keyword regex with intent; lets the inbox sort by "needs attention" instead of date. | Score at sync into `Email.aiCategory`/`aiUrgency`; batch; cache; feature-flag. |
| **Suggest reply draft** | Reply plumbing exists, so this is a small delta and the most visible AI win to staff. Never auto-send. | Thread + firm tone guide → editable draft in the reply box. |
| **Thread summarization** | Blocked on threading — sequence after `threadId`. | Extend `summarizeEmail` to a thread; cache on the thread. |
| **Sentiment / escalation detection** | Flag an angry client before a partner hears it from the client. | |
| **Smart / semantic search** | Would fix body search — but do the Mongo text index first; it's far cheaper and may suffice. | Embeddings + Atlas Vector Search, hybrid with the text index. |
| **Auto-tag by client** | Replaces the `clients[0]` fallback (`taskHelper.js:35`) that is corrupting client reports today. | |

### 2.9 Ops & reliability

- **Cannot deploy without a code change** (two hardcoded localhost URLs, zero env usage).
- **The rate limiter throttles the office itself** — 300 req/15 min per IP against an 8-second `/auth/me` heartbeat means ~3 concurrent users behind one NAT exhaust the quota on heartbeats alone.
- **Cannot scale past one instance** — no Socket.io Redis adapter; in-process `node-cron` means N instances = N× Gmail syncs and N× overdue notifications.
- **Destructive boot-time job** (`config/db.js:16-27`) mass-mutates `Email` on every restart.
- **`deduplicateConnections()` on every status poll** — O(all users) reads and writes on a routine endpoint.
- **Unbounded query** — `GET /api/gmail/emails` returns every email with full bodies and inlined base64 images.
- **No structured logging, error tracking, metrics, or alerting.** In production the only diagnostic is stdout.
- **Health check doesn't check the database**, and `connectDB` swallows connection failure — so the app reports healthy while unable to serve data.
- **No error boundary** in React, which is why the TaskList bug degrades so badly.
- **No CI, Docker, migrations, feature flags, or rollback story.**
- **Silent styling breakage** — seven undefined CSS classes and ~35 invalid Tailwind shades mean loading skeletons, fade-ins, toasts, and several text colours simply don't render. Users experience this as "the app looks unfinished" without anyone being able to name why.
- **i18n:** all English. Do the *plumbing* cheaply (extract strings) and commission Gujarati/Hindi translation only on demand — staff at this level of an Indian professional firm work in English UIs daily. Genuine P3.
- **Mobile:** a drawer nav exists, but there's no PWA manifest, no service worker, no offline handling, a 4 px sidebar/content overlap, and an invalid `z-45` on the drawer. A partner checking status from a car is a real use case; a PWA is the cheap answer.
- **Accessibility:** effectively none — one `aria-label`, no dialog roles, no focus traps, no Escape-to-close, and `select-none` blocking copy of email/task text.

### 2.10 Testing & QA — required strategy

There are **zero** tests; `server/package.json:8` is the npm default stub. For a system that moves client mail and enforces role boundaries this is the largest single risk in the repo — and the TaskList crash and the ManageUsers checkbox conflict are exactly the class of defect any test would have caught. Recommended build order:

1. **Harness (S).** Server: Vitest + Supertest + `mongodb-memory-server` so tests never touch Atlas. Client: Vitest + React Testing Library + MSW. Add `npm test` to both packages and a GitHub Actions workflow running lint + tests on every PR. **Add `eslint --max-warnings 0` to CI immediately** — a no-undef rule would have caught `setSelectedTaskIds` on day one.
2. **Authorization-matrix tests (M) — do these first.** A parameterised table over `{role} × {endpoint} × {owns resource?}` asserting 200/403. The rules are independently reimplemented in `authMiddleware`, `taskController`, `commentController`, and `gmailController.downloadAttachment`, with genuinely different logic in each — precisely the shape of code that breaks silently.
3. **Unit tests for pure logic (S).** `tokenCrypto` (round-trip, tamper detection, legacy-plaintext passthrough), `recurrenceHelper.getNextDeadline` (month-end rollover), `regexHelper.escapeRegex`, keyword word-boundary matching.
4. **Integration tests for the core flows (M).** sync → keyword match → pending approval → approve → task created → notification; task complete → recurrence spawned + email sent; overdue cron → status flips to Late (and notifies **once**).
5. **Adapter refactor for testability (M).** Wrap the Gmail and Gemini SDKs behind thin modules — `googleapis` is currently called directly inside controllers, which makes them unfakeable. Prerequisite for (4).
6. **Component tests for the crash-prone screens (M).** `TaskList` filters, `ManageUsers` edit modal, `KeywordApprovalModal` — all three have verified interaction bugs.
7. **E2E smoke (M).** Playwright over five paths: login, connect Gmail (mocked), assign email→task, complete task, view report. Run on merge to `main`.
8. **Fixture separation (S).** Move `clientSeeder` behind an explicit `npm run seed:dev`; it must never run on a production boot.
9. **Regression test per fixed bug (ongoing).** Start with every item in §5.

Target: ~60 % line coverage on `server/`, but **100 % on the authorization matrix and the money paths** (assignment, completion, deletion).

---

## 3. Prioritized roadmap

Effort: **S** ≈ ≤2 days · **M** ≈ 3–10 days · **L** ≈ 2–6 weeks (one developer).

### P0 — Must-fix / table stakes

*Nothing else matters until the app can be deployed, doesn't crash, and can be audited.*

| # | Item | Why it matters here | Effort | Approach |
|---|---|---|---|---|
| P0-1 | **Externalize API + Socket URLs** | The app literally cannot run outside a dev laptop; real-time notifications — the headline feature — are dead in production. | **S** | `api/axios.js:5` → `import.meta.env.VITE_API_URL`; `NotificationBell.jsx:33` → same. Add `.env` / `.env.production`. Add the missing 401 response interceptor the README already claims. |
| P0-2 | **Fix the TaskList filter crash** | Creator / Priority / Status filters throw `ReferenceError` (`TaskList.jsx:692-693, 712-713, 747-748` — 3 call sites, 0 declarations). Task filtering is unusable. | **S** | Either declare `selectedTaskIds`/`selectAll` and finish the bulk-select UI (which also lights up the unused `POST /api/tasks/bulk`), or delete the six orphan lines. Add a React error boundary and `eslint --max-warnings 0` in CI so this class never ships again. |
| P0-3 | **Fix the iframe XSS in TaskList** | `TaskList.jsx:1156, 1742` render untrusted client email HTML with `sandbox="allow-scripts allow-same-origin"` — that pair **defeats the sandbox**, giving attacker script access to the app origin where the JWT lives in `localStorage`. `EmailInbox.jsx:1343` already does it correctly. | **S** | Drop `allow-scripts` to match EmailInbox; sanitize with DOMPurify instead of the `<script>`-only strip at `TaskList.jsx:18`; move the token out of `localStorage` to an httpOnly cookie as a follow-up. |
| P0-4 | **Remove the destructive boot job & production seeder** | `config/db.js:16-27` silently un-assigns emails on every restart; `clientSeeder.js` injects five fake clients into live data. | **S** | Delete the `updateMany` (or make it a one-off script); gate `seedClients()` behind `NODE_ENV !== 'production'` + `npm run seed:dev`. |
| P0-5 | **Fix the `clients[0]` attribution fallback** | `taskHelper.js:35` attributes unknown-sender mail to an arbitrary — usually seeded and fake — client, corrupting every client report. | **S** | Fall back to `'Unassigned Client'` and surface it in the UI as needing triage. |
| P0-6 | **Tame the overdue-notification cron** | `cronJobs.js:14-71` notifies the assignee **and every Admin/Head every minute, forever**. Users mute the bell within a week, which silently destroys the value of every notification feature built afterwards. | **S** | Notify only on the `Pending → Late` transition (inside the branch that already saves the new status); add a `Notification` TTL index. |
| P0-7 | **Fix the rate-limiter / heartbeat collision** | 300 req/15 min per IP vs an 8-second `/auth/me` poll → an office behind one NAT self-throttles at ~3 concurrent users. | **S** | Slow the heartbeat to 60 s (or replace it with a socket event), key the limiter on user id where authenticated, and raise the authenticated ceiling. |
| P0-8 | **Fix Pending-user token issuance** | `authController.js:68-85` hands a valid JWT to a self-registered user awaiting approval, who can then call protected endpoints. | **S** | Don't issue a token unless `status === 'Approved'`; add the same check inside `protect`. |
| P0-9 | **Server-side pagination + projection on `GET /api/gmail/emails`** | Returns every email with full HTML bodies and inlined base64 images; grows without bound. | **S–M** | `?page&limit&q&account&status`; list projection excludes `body`; fetch body on expand. Add pagination to tasks, users, clients and activity logs while you're here. |
| P0-10 | **Test harness + authorization-matrix suite + CI** | Role logic is reimplemented in ≥4 controllers with differing rules; there is currently no way to change anything safely. | **M** | Vitest + Supertest + `mongodb-memory-server`; parameterised `{role × endpoint × ownership}` table; GitHub Actions running lint + test on PR. (§2.10) |
| P0-11 | **Audit-log completeness** | User create / **role change** / status change / delete are not logged at all; no IP, target id, or before/after. Fails basic internal controls for a firm holding client financial data. | **M** | Extend `ActivityLog` with `{targetType, targetId, before, after, ip, userAgent}`; add the missing `logActivity` calls in `userController` and `clientController`; index `{action, createdAt}`; paginate + filter the viewer. |
| P0-12 | **Soft-delete users instead of erasing their history** | `userController.js:249-263` deletes the departing user's activity logs and comments. | **S** | `isActive`/`deactivatedAt`; block login; retain all history; require explicit reassignment of open tasks rather than nulling `assignedTo`. |
| P0-13 | **Consolidate the duplicate client API** | Two live endpoints with different auth, fields and logging, used by two different screens. | **S** | Keep `/api/clients` (richer), delete `taskController`'s client CRUD, repoint `ManageUsers.jsx` and `TaskList`'s autocomplete, add Zod validation + activity logging. |
| P0-14 | **Replace the mailed cleartext temp password** | `authController.js:171-218` mails a usable, non-expiring password; there is no reset page in the client. | **S** | Signed single-use 30-minute token → `/reset-password?token=…`; bump `tokenVersion` on use. |
| P0-15 | **Fix the ManageUsers allowed-accounts conflict** | The checkbox list and the free-text field are bound to the same array (`ManageUsers.jsx:771-812`), so each wipes the other — an Admin cannot reliably grant a Head mailbox access. | **S** | Separate state for the two inputs; merge on submit. |
| P0-16 | **Production health, logging & error tracking** | A Mongo outage still reports "Server is running" (`index.js:59`, `config/db.js:28-31`). | **S** | `/api/health` checks `mongoose.connection.readyState`; `pino` structured logging with request ids; Sentry on client and server. |
| P0-17 | **Repair the broken CSS contract** | Seven undefined classes and ~35 invalid Tailwind shades make skeletons blank boxes, kill every animation, and blank out several text colours. The product silently looks unfinished. | **S** | Define the missing classes in `index.css` (or delete their usages), fix the invalid shades against `tailwind.config.js`, delete the never-imported `App.css`, fix `z-45` and the `lg:pl-60` / `w-[260px]` mismatch. |

### P1 — High-value near-term

*This is where the product stops being an inbox viewer and becomes a team inbox.*

| # | Item | Why it matters here | Effort | Approach |
|---|---|---|---|---|
| P1-1 | **Email threading (`threadId`) + conversation view** | The foundational data-model fix; prerequisite for thread summaries, per-matter SLA, dedup, collision detection and reply history. | **L** | Add indexed `threadId` to `models/Email.js` (Gmail returns it; `gmailController.js:936` already reads it). Backfill script. Group by thread in `getEmails`; expandable conversation UI. Fire keyword rules once per thread. |
| P1-2 | **Persist outbound replies + first-response tracking** | Unlocks *every* SLA metric and makes replies visible in-app. Without it the app can never prove responsiveness. | **M** | Store sent replies as `Email` docs (`direction:'outbound'`, same `threadId`); set `firstRespondedAt`; add a "Replied" state to the inbox. |
| P1-3 | **SLA timers + response-time analytics** | The metric a partner actually manages by. Depends on P1-2. | **M** | `SlaPolicy` model (per client / priority, first-response + resolution targets, business hours); computed `dueAt` per thread; colour-coded countdown; `/api/reports/sla` (first-response p50/p90, attainment %, breaches by client and assignee). |
| P1-4 | **Collision detection & inbox ownership** | Multiple staff share mailboxes with zero protection; duplicate client replies are inevitable and embarrassing. | **M** | `Email.claimedBy`/`claimedAt`; "X is viewing / replying" broadcast over the existing per-user Socket.io rooms (`index.js:170-192`); soft lock with TTL; warn-on-send. |
| P1-5 | **Rich reply + compose + forward + attachments + signatures + templates** | Until staff can do real outbound work in the app, half the work stays in Gmail and the reports stay wrong. | **M–L** | Multipart MIME (HTML + attachments via `multer` → S3/GridFS); compose/forward endpoints; `User.signature`; `EmailTemplate` model for canned responses. |
| P1-6 | **Read/unread, star, snooze, archive** | Basic triage hygiene for a shared inbox. | **M** | `Email.readBy[]`, `starredBy[]`, `snoozedUntil`, `archivedAt`; un-snooze cron; filter chips. |
| P1-7 | **Full-text (body) search + saved views + sort** | Search exists but skips bodies — the most common question is still unanswerable. | **M** | Mongo text index on `subject/from/body` (or Atlas Search) behind the existing `?q=` param; `SavedView` model; add a sort control. |
| P1-8 | **AI: extract action items + deadlines → prefill task** | Removes the most repetitive human step in the core loop. Gemini is already wired. | **S–M** | `POST /api/ai/extract-task` returning structured JSON; prefill the Create form; human confirms. |
| P1-9 | **AI: auto-categorize + urgency scoring** | Replaces brittle keyword regex with intent; lets the inbox sort by "needs attention". | **M** | Score at sync into `Email.aiCategory`/`aiUrgency`; batch; cache; feature-flag. |
| P1-10 | **Task search, pagination, assignee filter, bulk actions UI** | `TaskList` renders every task with no search. The bulk endpoint is already built (`taskController.js:302-371`). | **S–M** | Server-side task query params; checkbox column + action bar calling `POST /api/tasks/bulk`. Pairs directly with P0-2. |
| P1-11 | **"My Day" view + per-role dashboards** | Kanban and Calendar exist; what's missing is a daily focus screen for employees and a team-load screen for Heads. | **M** | Reuse `GET /api/tasks`; add a due-today/overdue/upcoming digest view; split `Dashboard.jsx` by role. |
| P1-12 | **Reassignment history + escalation ladder** | Settles accountability disputes and replaces the every-minute overdue blast with a real path. | **M** | `TaskAssignment` audit collection (`from,to,by,at,reason`); `EscalationPolicy` (assignee → Head +1 d → Admin +3 d) evaluated by the existing cron. |
| P1-13 | **Notification preferences + daily digest** | Turns notifications from noise back into signal; the digest is what makes Heads open the app each morning. | **M** | `NotificationPreference` model (per type: in-app / email / off, plus quiet hours) with a section in `Profile.jsx`; digest cron reusing `utils/emailHelper.js`; a "view all notifications" page. |
| P1-14 | **Google Workspace SSO** | The firm already runs on Google; removes password management and the whole cleartext-temp-password risk class. | **M** | Google OAuth login (separate scope from the mailbox grant), domain-restricted, auto-provision as `Employee` pending approval. |
| P1-15 | **Client as a first-class reference + client detail/timeline page** | Fixes rename-orphans-everything and gives partners the screen they'll ask for before every client call. | **M** | Migrate `Task.clientName: String` → `clientId: ObjectId ref` (backfill by name); `Contact` sub-collection; `/clients/:id` timeline merging emails + tasks + comments; make the existing count tiles click-through. |
| P1-16 | **Multi-instance readiness** | Any real deployment (or a zero-downtime restart) duplicates Gmail syncs and drops notifications. | **M** | `@socket.io/redis-adapter`; cron behind a distributed lock or a dedicated worker; externalised config; Dockerfile. |
| P1-17 | **Data retention & PII policy** | Client email bodies accumulate forever with no purge and no export-my-data path. | **M** | Configurable per-collection retention; TTL/archival job; documented backup + restore runbook; a data map. |
| P1-18 | **Accessibility & UX baseline** | Modals have no focus trap, no Escape-to-close, no dialog role; `select-none` blocks copying email text — which staff do constantly. | **S–M** | A shared accessible `<Modal>`; remove blanket `select-none`; keyboard nav; axe in CI. |

### P2 — Differentiators

| # | Item | Why it matters here | Effort | Approach |
|---|---|---|---|---|
| P2-1 | **WhatsApp notifications** | For an Indian office this is where staff actually are — likely the single biggest adoption lever outside the app itself. | **M** | WhatsApp Business Cloud API (or Twilio) as an extra channel in `notificationHelper`; templates for assigned / overdue / escalated. |
| P2-2 | **AI: suggest reply draft** | Reply plumbing exists; the most visible AI win to day-to-day staff. Always human-approved. | **M** | Thread + firm tone guide → Gemini → editable draft in the reply box. |
| P2-3 | **AI: thread summarization** | Sequence after P1-1. "Catch me up on this client" in one click. | **S** | Extend `summarizeEmail` to accept a thread; cache on the thread. |
| P2-4 | **Workload heatmap + capacity planning** | Lets a Head rebalance *before* work goes late instead of reading about it after. | **M** | Aggregation over open tasks × assignee × due-week; grid view; combine with P2-5 estimates. |
| P2-5 | **Time tracking + effort estimates** | The basis for client profitability and defensible workload conversations. | **M** | `Task.estimatedMinutes` + `TimeEntry` collection; start/stop timer; roll up per client and employee. |
| P2-6 | **Subtasks, checklists & task templates** | Turns opaque tasks into trackable multi-step engagements; templates kill repetitive typing for recurring engagement types. | **M** | `Task.parentId` + `checklist[]` — **rename the existing `parentTaskId` (used for recurrence lineage) first** to avoid a semantic collision; `TaskTemplate` model. |
| P2-7 | **Advanced routing rules** | Keyword→one-person breaks the moment that person takes leave; there's currently no way to reject a suggestion either. | **M** | Generalise `KeywordRule` into `RoutingRule` with condition groups (sender, domain, recipient mailbox, has-attachment, AI category), actions (assign, round-robin over a group, set priority, apply SLA), explicit `order`, rule editing, and a reject/dismiss path. |
| P2-8 | **Custom roles & granular permissions** | The firm will outgrow Admin/Head/Employee — "senior who can reassign but not delete", "read-only auditor". Also lets Employees see relevant inbox context, which the fixed roles currently forbid entirely. | **M–L** | `Role` + `Permission` collections; replace `authorizeRoles(...)` with `requirePermission('task.delete')`; seed the current three as presets. |
| P2-9 | **Team hierarchy + delegation & OOO** | Makes "Head" mean *head of a team*; stops queues stalling during leave. | **M** | `Team` model; `User.teamId`, `managerId`, `delegateTo`, `outOfOfficeUntil`; routing and escalation become team-aware. |
| P2-10 | **Scheduled / emailed reports + custom date ranges** | Partners read email, not dashboards. A Monday-morning PDF is what makes the analytics actually used. | **M** | `ReportSchedule` model; cron renders existing report queries to PDF/XLSX and mails them; add a date-range picker and chart drill-through. |
| P2-11 | **Internal notes vs client-facing** | Prevents an internal remark reaching a client; gives candid commentary a safe home. | **S** | `TaskComment.visibility: 'internal' \| 'client'`; distinct styling; excluded from any future portal or export. |
| P2-12 | **@mentions in comments** | Pull a third colleague in without reassigning the task. | **S** | Parse `@name` → user ids → notify; autocomplete in the composer. |
| P2-13 | **PWA / installable mobile** | Partners checking status on the move; the cheapest possible mobile story. | **S–M** | `vite-plugin-pwa`, manifest, service-worker caching, Web Push; fix the `xl:`/`2xl:` gap and the sidebar overlap first. |
| P2-14 | **Duplicate & merge detection** | Stops one client matter becoming two parallel task streams. | **M** | Similarity on `{normalized subject, sender domain, 48 h window}`; suggest merge; `Task.mergedInto`. |
| P2-15 | **AI: smart / semantic search** | Answers "the email where they agreed the fee" without exact keywords — but do the text index (P1-7) first; it's far cheaper and may suffice. | **M–L** | Embeddings per email + Atlas Vector Search, hybrid with the text index. |
| P2-16 | **Dark mode, finished** | 58 `dark:` classes already exist in one modal, so a dark-OS user sees an inconsistent app today. Either finish it or remove it. | **S–M** | Set `darkMode:'class'` in `tailwind.config.js`, add a toggle + persisted preference, extend coverage — or strip the orphan classes. |

### P3 — Nice to have

| # | Item | Why | Effort |
|---|---|---|---|
| P3-1 | **Client portal** | Kills "where is my file?" calls — worth it only once the internal product is solid. | **L** |
| P3-2 | **Slack / Teams integration** | Lower value than WhatsApp for this office; build only if a team adopts Slack. | **M** |
| P3-3 | **i18n (Gujarati / Hindi)** | Do the plumbing cheaply now (`react-i18next` string extraction); commission translation only on real demand — staff at this level work in English UIs daily. | **M** |
| P3-4 | **Presence indicators** | Nice polish; rooms already exist. Largely subsumed by the more valuable P1-4. | **S** |
| P3-5 | **Read receipts / seen-by** | Useful for accountability, low urgency. | **S** |
| P3-6 | **Feature flags** | Worth adding once two people ship concurrently. | **S** |
| P3-7 | **Native mobile app** | Only after the PWA proves genuine mobile demand. | **L** |
| P3-8 | **Task dependencies / blockers** | Real need (client-caused delays shouldn't read as employee lateness) but the escalation and internal-notes work covers most of the pain first. | **M** |
| P3-9 | **Sentiment / escalation detection** | Genuinely useful; sequence after the core AI features land. | **S–M** |
| P3-10 | **In-app onboarding / tooltips** | Reduces training load — especially for the keyword-rules modal, which is buried behind an Inbox button. | **S** |
| P3-11 | **Landing-page cleanup** | `Landing.jsx:14-21` shows hardcoded fake stats (1248 emails / 340 tasks) to logged-out visitors, and a 100 ms `setInterval` runs until unmount. Cosmetic, but it's the first thing anyone sees. | **S** |

---

## 4. Top 10 highest-ROI features

Ranked by (business value × confidence) ÷ effort, grounded in verified code.

**1. Externalize the API and Socket URLs (P0-1) — Effort S.**
`client/src/api/axios.js:5` and `client/src/components/NotificationBell.jsx:33` both hardcode `http://localhost:5015`, and there is **not a single `import.meta.env` reference in the entire client**. This is a two-line change that separates "a demo on one laptop" from "a deployed product". Until it lands, real-time notifications — the feature the README leads with — are dead everywhere except a dev machine, and every other item on this roadmap is unshippable. Fold in the missing 401 response interceptor while you're in the file, since the README already promises it and its absence means an expired token produces silent failures instead of a clean re-login.

**2. Fix the TaskList filter crash (P0-2) — Effort S.**
`TaskList.jsx` calls `setSelectedTaskIds(...)` and `setSelectAll(...)` in three separate event handlers (lines 692/693, 712/713, 747/748) and **declares neither anywhere in the file** — verified as 3 call sites and 0 declarations. Changing the Creator filter, the Priority filter, or clicking any status pill throws a `ReferenceError`, and with no React error boundary the failure is ugly. Task filtering is a daily operation on the app's busiest screen, so this is a total loss of core functionality for what is either a six-line deletion or a half-day of finishing the bulk-select UI — which would simultaneously light up the fully-built, entirely unused `POST /api/tasks/bulk` endpoint. Add `eslint --max-warnings 0` to CI so no-undef can never ship again.

**3. Fix the iframe XSS in the task view (P0-3) — Effort S.**
`TaskList.jsx:1156` and `:1742` render untrusted client email HTML inside an iframe declared `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`. Those two tokens together **cancel the sandbox entirely** — attacker-controlled script runs with the app's origin, where the JWT sits in `localStorage`. The firm receives email from outside parties all day, so the attack surface is the product's primary input. `EmailInbox.jsx:1343` already gets this right by omitting `allow-scripts`, which makes the fix a one-token deletion plus swapping the `<script>`-only strip at `TaskList.jsx:18` for DOMPurify. Highest severity-to-effort ratio in the repository.

**4. Email threading (`threadId`) + conversation view (P1-1) — Effort L.**
The highest-value *product* change and a prerequisite for at least five others: thread summaries, per-matter SLA, dedup, collision detection, and reply history. Gmail returns `threadId` on every fetch and `gmailController.js:936` already reads it during reply before throwing it away, so the data is free — the work is the model change, a backfill, and the grouped UI. Without it the app models messages while the firm works in matters: a ten-message client chain becomes ten unrelated rows and can spawn ten duplicate tasks. It's the most expensive item here and still the right thing to build fourth, because everything valuable downstream depends on it.

**5. Persist outbound replies + SLA / response-time analytics (P1-2 + P1-3) — Effort M + M.**
`replyToEmail` sends through Gmail and writes nothing locally, so the app cannot show that a reply happened, cannot compute first-response time, and cannot warn that two people are both replying. For a professional-services firm the real promise is *provable responsiveness*, and the system currently cannot measure the one number that matters. Persisting outbound mail is modest work that immediately unlocks first-response time, resolution time, SLA attainment, and per-client responsiveness — converting five volume-count reports into an actual management scoreboard, and giving partners a reason to open the app.

**6. Tame the overdue-notification cron (P0-6) — Effort S.**
`utils/cronJobs.js:14-71` creates a notification for the assignee **and every Admin and Head every single minute** for every late task, indefinitely. A task two days overdue has generated roughly 2,880 notification rows per supervisor. Staff will mute the bell within a week and never trust it again — which silently destroys the value of every notification feature built afterwards, including the digests, escalations and WhatsApp integration later in this roadmap. Notifying only on the `Pending → Late` transition is a few lines inside a branch that already exists, plus a TTL index. Best damage-prevented per line of code in the project.

**7. Authorization-matrix test suite + CI (P0-10) — Effort M.**
Zero tests exist, and role logic is independently reimplemented in `authMiddleware.js`, `taskController.js`, `commentController.js` and `gmailController.downloadAttachment` with genuinely different rules in each. The system moves client financial correspondence between staff with different clearance, so an authorization regression is a confidentiality incident rather than a bug. A parameterised `{role × endpoint × ownership}` table is a few days of work and converts the entire roadmap from "risky" to "safe to build" — which is why it outranks every feature below it. The lint gate that comes with the same CI setup would have caught items 2 and the ManageUsers state conflict for free.

**8. AI: extract action items and deadlines to prefill the task form (P1-8) — Effort S–M.**
The core loop today is: a Head reads an email, mentally extracts the ask, types a task, and guesses a deadline. Gemini is already integrated and working (`aiController.js:6-49`, wired into `EmailInbox.jsx:623`), so this is one endpoint and one prompt returning structured JSON. It attacks the single most repetitive human step in the product, it is visible from day one, and it degrades gracefully — the existing `GEMINI_API_KEY` guard at `aiController.js:15-17` already proves the pattern. Best value-per-day in the AI category, and unlike thread summarization it does not depend on threading landing first.

**9. Collision detection and inbox ownership (P1-4) — Effort M.**
Multiple staff share connected mailboxes with **zero** protection: no claim, no lock, no indication of who is handling what. Two people replying to the same client is not hypothetical — it is the defining failure mode of shared mailboxes, and it costs the firm credibility with a client rather than costing developer time. The infrastructure is already sitting there unused: Socket.io with JWT auth and per-user rooms is live at `index.js:128-192`, and the same plumbing already emits task-comment events that nothing listens to. Adding `claimedBy` plus a broadcast on open converts existing, paid-for infrastructure into the feature that makes a shared inbox actually safe to share.

**10. Complete the audit trail and stop destroying it on offboarding (P0-11 + P0-12) — Effort M + S.**
`userController.js` never calls `logActivity` on user creation, **role change**, status change, or deletion — the four operations an auditor cares about most — and `/api/clients` CRUD is unlogged too. `ActivityLog` also lacks IP, target entity id and before/after values, and the viewer loads the whole collection with no pagination, search or export. Worse, `deleteUser` (`:249-263`) deletes the departing user's activity logs and comments, erasing exactly the history you would want when someone leaves under a cloud. For a firm holding client financial data this fails a basic internal-controls review, and the remedy is small: extend the schema, add the missing calls, and switch delete to deactivate.

**Quick wins just outside the top ten** (all **S**, all high value per hour): fix the `clients[0]` client-attribution fallback (`taskHelper.js:35`) that is silently corrupting every client report; consolidate the two competing client APIs; fix the ManageUsers allowed-accounts checkbox conflict; fix the rate-limiter/heartbeat collision that throttles the office at ~3 users; and repair the seven undefined CSS classes that make every loading skeleton a blank white box.

---

## 5. Bugs & risks found while auditing (not features)

| Severity | Issue | Location |
|---|---|---|
| **Critical** | `setSelectedTaskIds` / `setSelectAll` called but never declared → `ReferenceError` on every task filter interaction | `client/src/pages/TaskList.jsx:692-693, 712-713, 747-748` |
| **Critical** | `sandbox="allow-scripts allow-same-origin"` on iframes rendering untrusted email HTML → same-origin XSS, JWT in `localStorage` | `client/src/pages/TaskList.jsx:1156, 1742` (cf. correct usage at `EmailInbox.jsx:1343`) |
| High | Client API + Socket URLs hardcoded to localhost; **zero `import.meta.env` in the client** | `client/src/api/axios.js:5`, `client/src/components/NotificationBell.jsx:33` |
| High | Pending (unapproved) users are issued a working JWT at registration | `server/controllers/authController.js:68-85` |
| High | Boot-time `updateMany` un-assigns every email lacking a linked task, on every restart | `server/config/db.js:16-27` |
| High | Unknown senders attributed to `clients[0]` — usually a seeded fake client | `server/utils/taskHelper.js:35` + `server/seeders/clientSeeder.js` |
| High | Overdue cron re-notifies assignee + all supervisors every minute, unbounded | `server/utils/cronJobs.js:39-64` |
| High | Demo clients seeded into every database on every boot | `server/config/db.js:14` |
| High | 8-second `/auth/me` heartbeat vs a 300-req/15-min per-IP limiter → an office self-throttles at ~3 users | `client/src/components/ProtectedLayout.jsx:58`, `server/index.js:28-34` |
| Medium | `deduplicateConnections()` scans and writes all users on every `/api/gmail/status` call | `server/controllers/gmailController.js:633, 814-864` |
| Medium | Two divergent client CRUD APIs used by different screens | `clientController.js` vs `taskController.js:376-470` |
| Medium | User create / role change / status change / delete never activity-logged | `server/controllers/userController.js:43, 98, 234` |
| Medium | `deleteUser` destroys the departing user's activity logs and comments | `server/controllers/userController.js:255-259` |
| Medium | ManageUsers checkbox list and free-text field bound to the same array — each wipes the other | `client/src/pages/admin/ManageUsers.jsx:771-812` |
| Medium | Base64 inline images stored inside `Email.body` — document bloat, 16 MB BSON risk | `server/controllers/gmailController.js:356-382` |
| Medium | Socket events `task:<id>:comment` / `:commentDeleted` emitted; no client listens | `server/controllers/commentController.js:102-111, 149-161` |
| Medium | `GET /api/gmail/emails` unpaginated, returns full bodies | `server/controllers/gmailController.js:544-582` |
| Medium | Forgot-password mails a cleartext, non-expiring temp password; no reset page exists | `server/controllers/authController.js:171-218` |
| Medium | `connectDB` swallows connection failure; `/api/health` reports healthy with no DB | `server/config/db.js:28-31`, `server/index.js:59-61` |
| Medium | No React error boundary — any handler/render throw blanks the app | `client/src/App.jsx` |
| Medium | Socket connection opened even when no user is logged in | `client/src/components/NotificationBell.jsx:28-33` |
| Medium | Seven CSS classes used app-wide but defined nowhere → blank skeletons, dead animations; `App.css` never imported | `client/src/index.css`, `client/src/App.css` |
| Low | ~35 invalid Tailwind shades (`slate-850`, `indigo-550`, `red-650`, `emerald-250`, …) resolve to nothing | across `client/src` |
| Low | `z-45` is not a valid Tailwind class → mobile drawer has no z-index; `lg:pl-60` vs `w-[260px]` 4 px overlap | `client/src/components/Sidebar.jsx:136`, `ProtectedLayout.jsx` |
| Low | `aiController` returns invalid HTTP status **550** | `server/controllers/aiController.js:45` |
| Low | Zod validation missing on keyword-rule, client, comment and task-update routes | `keywordRuleRoutes.js`, `clientRoutes.js`, `commentRoutes.js`, `taskRoutes.js:34` |
| Low | Inbox tab badge counts disagree with the list under an account filter (`getTabCount` matches only `fetchedBy.gmailEmail`; the list also matches `toEmail`) | `client/src/pages/EmailInbox.jsx:88-91, 126` |
| Low | `selectAll` selects only the current page and isn't reset on page change | `client/src/pages/EmailInbox.jsx:259` |
| Low | Dashboard links to `/inbox?tab=accounts`; EmailInbox never reads a `tab` param — link does nothing | `client/src/pages/Dashboard.jsx:429` |
| Low | Delete gate relies on `localStorage.emailsDownloaded` — a client-side-only interlock | `client/src/pages/EmailInbox.jsx:41, 514`; UI copy says "CSV", export is `.xls` (`:799`) |
| Low | `Task.parentTaskId` is used for *recurrence* lineage — will collide with any future subtask feature | `server/models/Task.js:59-63` |
| Low | Dead code: `jwt-decode` never imported; unused `navigate` (`EmailInbox.jsx:62`); `{true && …}` (`EmailInbox.jsx:838`); unused `role` state (`Register.jsx:9`); hardcoded fake stats shown to logged-out visitors (`Landing.jsx:14-21`) | client |
| Low | README materially stale (nonexistent `AdminOrHeadRoute.jsx`, claimed `VITE_API_URL` + 401 interceptor, missing clients/keyword-rules/AI/comments endpoints, `ALLOWED_ORIGINS` vs `FRONTEND_URL`) | `README.md` |
