# MailDesk — Frontend ↔ Backend Integration Audit

Scope: every file under `client/src/` and every file under `server/routes/` + `server/controllers/` (plus middleware, models, utils read for verification).
Repo: `/Users/darshank/Desktop/WEBX/MailDesk/MailDesk` — branch `main`, commit `4ef4a17`.
Stack: React 19 + Vite 8 (client, port 5174), Express 5 + Mongoose 9 + Socket.io 4 + zod 4.4.3 (server, port 5015).

Everything below was verified by reading the actual code. Claims that could not be confirmed by static reading are explicitly tagged **UNVERIFIED**.

---

## 1. Endpoint contract map

### 1.1 Server inventory vs client callers

| # | Method | Path | Auth / Role | Server (file:line) | Client caller(s) (file:line) | Status |
|---|--------|------|-------------|--------------------|------------------------------|--------|
| 1 | GET | `/api/health` | public | `index.js:59` | — | **DEAD** |
| 2 | POST | `/api/auth/register` | public, `registerSchema`, authLimiter | `authRoutes.js:8` → `authController.js:23` | `Register.jsx:22` | OK |
| 3 | POST | `/api/auth/login` | public, `loginSchema`, authLimiter | `authRoutes.js:11` → `authController.js:95` | `Login.jsx:18` | OK |
| 4 | POST | `/api/auth/forgot-password` | public, `forgotPasswordSchema` | `authRoutes.js:14` → `authController.js:155` | `ForgotPassword.jsx:18` | OK |
| 5 | GET | `/api/auth/me` | protect (any) | `index.js:102` | `ProtectedLayout.jsx:14`, `Profile.jsx:39` | OK (polled every 8 s — see F-09) |
| 6 | GET | `/api/users` | Admin, Head | `userRoutes.js:34` → `userController.js:14` | `TaskList.jsx:220`, `EmailInbox.jsx:235`, `ManageUsers.jsx:59`, `Reports.jsx:118`, `KeywordApprovalModal.jsx:52` | OK |
| 7 | POST | `/api/users` | Admin, `createUserSchema` | `userRoutes.js:35` → `userController.js:43` | `ManageUsers.jsx:79` | OK |
| 8 | PUT | `/api/users/profile` | any, `updateUserProfileSchema` | `userRoutes.js:26` → `userController.js:292` | `Profile.jsx:108` | OK |
| 9 | PUT | `/api/users/change-password` | any, `changePasswordSchema` | `userRoutes.js:29` → `userController.js:349` | `Profile.jsx:141` | OK |
| 10 | GET | `/api/users/activity-logs` | Admin | `userRoutes.js:38` → `userController.js:277` | `ActivityLog.jsx:31` | OK |
| 11 | GET | `/api/users/:id` | Admin | `userRoutes.js:44` → `userController.js:27` | — | **DEAD** |
| 12 | PUT | `/api/users/:id` | Admin, `updateUserSchema` | `userRoutes.js:45` → `userController.js:98` | `ManageUsers.jsx:102`, `ManageUsers.jsx:125` | **PAYLOAD MISMATCH — F-02** |
| 13 | DELETE | `/api/users/:id` | Admin | `userRoutes.js:46` → `userController.js:234` | `ManageUsers.jsx:150` | OK |
| 14 | GET | `/api/gmail/auth-url` | Admin, Head | `gmailRoutes.js:26` → `gmailController.js:133` | `Dashboard.jsx:109`, `Profile.jsx:73`, `EmailInbox.jsx:304` (`?mode=extra`) | OK |
| 15 | GET | `/api/gmail/oauth/callback` | public (Google redirect) | `gmailRoutes.js:29` → `gmailController.js:172` | browser redirect only | OK |
| 16 | POST | `/api/gmail/fetch` | Admin, Head | `gmailRoutes.js:32` → `gmailController.js:497` | `Dashboard.jsx:140`, `EmailInbox.jsx:525` | OK |
| 17 | GET | `/api/gmail/emails` | Admin, Head | `gmailRoutes.js:35` → `gmailController.js:544` | `EmailInbox.jsx:345`, `TaskList.jsx:226` | **ROLE MISMATCH — F-06**, no pagination — F-11 |
| 18 | POST | `/api/gmail/emails/:id/reply` | Admin, Head, `replyToEmailSchema` | `gmailRoutes.js:38` → `gmailController.js:870` | `EmailInbox.jsx:590` | OK |
| 19 | POST | `/api/gmail/emails/bulk-assign` | Admin, Head, `bulkAssignEmailsSchema` | `gmailRoutes.js:41` → `gmailController.js:986` | `EmailInbox.jsx:283` | OK |
| 20 | DELETE | `/api/gmail/emails` | Admin | `gmailRoutes.js:44` → `gmailController.js:587` | `EmailInbox.jsx:555` | OK |
| 21 | DELETE | `/api/gmail/emails/:id` | Admin, Head | `gmailRoutes.js:47` → `gmailController.js:607` | `EmailInbox.jsx:576` | OK |
| 22 | GET | `/api/gmail/emails/:id/attachments/:attachmentId` | protect (any) | `gmailRoutes.js:50` → `gmailController.js:1062` | `EmailInbox.jsx:603`, `TaskList.jsx:413` | OK |
| 23 | GET | `/api/gmail/status` | protect (any) | `gmailRoutes.js:53` → `gmailController.js:630` | `Dashboard.jsx:78`, `EmailInbox.jsx:213`, `Profile.jsx:63` | **RESPONSE MISMATCH — F-04** |
| 24 | DELETE | `/api/gmail/disconnect` | protect (any) | `gmailRoutes.js:56` → `gmailController.js:775` | `Dashboard.jsx:126`, `Profile.jsx:92` | OK |
| 25 | DELETE | `/api/gmail/linked-account` | Admin, `disconnectLinkedAccountSchema` | `gmailRoutes.js:59` → `gmailController.js:699` | `EmailInbox.jsx:321` | **PAYLOAD MISMATCH — F-05** |
| 26 | GET | `/api/tasks/clients` | protect (any) | `taskRoutes.js:20` → `taskController.js:289` | `TaskList.jsx:212`, `ManageUsers.jsx:166` | OK (duplicate API — F-14) |
| 27 | POST | `/api/tasks/clients` | Admin | `taskRoutes.js:21` → `taskController.js:376` | `ManageUsers.jsx:188` | OK |
| 28 | PUT | `/api/tasks/clients/:id` | Admin | `taskRoutes.js:22` → `taskController.js:413` | `ManageUsers.jsx:219` | OK |
| 29 | DELETE | `/api/tasks/clients/:id` | Admin | `taskRoutes.js:23` → `taskController.js:455` | `ManageUsers.jsx:240` | OK |
| 30 | POST | `/api/tasks/bulk` | Admin, Head, `bulkTaskSchema` | `taskRoutes.js:26` → `taskController.js:302` | — | **DEAD — F-13** |
| 31 | GET | `/api/tasks` | protect (any) | `taskRoutes.js:29` → `taskController.js:78` | `TaskList.jsx:194`, `Dashboard.jsx:64` | OK, no pagination |
| 32 | POST | `/api/tasks` | Admin, Head, `createTaskSchema` | `taskRoutes.js:30` → `taskController.js:14` | `TaskList.jsx:254` | OK |
| 33 | GET | `/api/tasks/:id` | protect (any) | `taskRoutes.js:33` → `taskController.js:105` | — | **DEAD** |
| 34 | PUT | `/api/tasks/:id` | protect (any), **no zod** | `taskRoutes.js:34` → `taskController.js:140` | `TaskList.jsx:310`, `:338`, `:647` | OK (validation gap — F-19) |
| 35 | DELETE | `/api/tasks/:id` | Admin, Head | `taskRoutes.js:35` → `taskController.js:255` | `TaskList.jsx:354` | **ROLE MISMATCH — F-07** |
| 36 | GET | `/api/tasks/:id/comments` | protect (any) | `commentRoutes.js:6` → `commentController.js:9` | `TaskList.jsx:373` | OK |
| 37 | POST | `/api/tasks/:id/comments` | protect (any) | `commentRoutes.js:6` → `commentController.js:42` | `TaskList.jsx:386` | OK |
| 38 | DELETE | `/api/tasks/:id/comments/:commentId` | protect (any) | `commentRoutes.js:7` → `commentController.js:123` | `TaskList.jsx:401` | **ROLE MISMATCH — F-16** |
| 39 | GET | `/api/notifications` | protect | `notificationRoutes.js:14` → `notificationController.js:6` | `NotificationBell.jsx:81` | OK (unbounded list) |
| 40 | PUT | `/api/notifications/read-all` | protect | `notificationRoutes.js:17` → `notificationController.js:47` | `NotificationBell.jsx:123` | OK |
| 41 | PUT | `/api/notifications/:id/read` | protect | `notificationRoutes.js:20` → `notificationController.js:21` | `NotificationBell.jsx:109` | OK |
| 42 | GET | `/api/reports/employee` | Admin | `reportsRoutes.js:16` → `reportsController.js:9` | `Reports.jsx:130` | OK |
| 43 | GET | `/api/reports/overall` | Admin, Head | `reportsRoutes.js:19` → `reportsController.js:88` | `Dashboard.jsx:60`, `:143`, `Reports.jsx:72`, `Landing.jsx:39` | **ROLE MISMATCH — F-17** |
| 44 | GET | `/api/reports/timeline` | Admin, Head | `reportsRoutes.js:22` → `reportsController.js:126` | `Reports.jsx:85` | OK |
| 45 | GET | `/api/reports/email-timeline` | Admin, Head | `reportsRoutes.js:25` → `reportsController.js:232` | `Reports.jsx:101` | OK |
| 46 | GET | `/api/reports/client-stats` | Admin, Head | `reportsRoutes.js:28` → `reportsController.js:184` | `Reports.jsx:146` | OK |
| 47 | POST | `/api/ai/summarize-email` | Admin, Head | `aiRoutes.js:6` → `aiController.js:6` | `EmailInbox.jsx:623` | **PAYLOAD SIZE — F-10** |
| 48 | GET | `/api/clients` | protect (any) | `clientRoutes.js:13` → `clientController.js:10` | `ClientList.jsx:61` | OK |
| 49 | POST | `/api/clients` | Admin, Head | `clientRoutes.js:14` → `clientController.js:50` | `ClientList.jsx:126` | OK |
| 50 | PUT | `/api/clients/:id` | Admin, Head | `clientRoutes.js:15` → `clientController.js:95` | `ClientList.jsx:150` | OK |
| 51 | DELETE | `/api/clients/:id` | Admin | `clientRoutes.js:16` → `clientController.js:143` | `ClientList.jsx:167` | OK |
| 52 | GET | `/api/keyword-rules` | Admin, Head | `keywordRuleRoutes.js:19` → `keywordRuleController.js:13` | `KeywordApprovalModal.jsx:50` | OK |
| 53 | POST | `/api/keyword-rules` | Admin, Head | `keywordRuleRoutes.js:20` → `keywordRuleController.js:30` | `KeywordApprovalModal.jsx:84` | OK |
| 54 | GET | `/api/keyword-rules/pending-approvals` | Admin, Head | `keywordRuleRoutes.js:23` → `keywordRuleController.js:172` | `KeywordApprovalModal.jsx:51`, `EmailInbox.jsx:226` | OK |
| 55 | POST | `/api/keyword-rules/approve-email/:id` | Admin, Head | `keywordRuleRoutes.js:26` → `keywordRuleController.js:189` | `KeywordApprovalModal.jsx:129` | OK |
| 56 | POST | `/api/keyword-rules/bulk-approve` | Admin, Head | `keywordRuleRoutes.js:29` → `keywordRuleController.js:251` | `KeywordApprovalModal.jsx:159` | OK |
| 57 | PUT | `/api/keyword-rules/:id` | Admin, Head | `keywordRuleRoutes.js:32` → `keywordRuleController.js:109` | — | **DEAD — F-13** |
| 58 | DELETE | `/api/keyword-rules/:id` | Admin, Head | `keywordRuleRoutes.js:33` → `keywordRuleController.js:149` | `KeywordApprovalModal.jsx:110` | OK |

### 1.2 Summary of contract defects

- **Client → nonexistent endpoint (404 at runtime): NONE.** Every path the client calls exists on the server. Verified by cross-referencing all 74 `api.*` / `axios.*` call sites against all 58 routes.
- **Method mismatches: NONE.** No client PUT hits a server PATCH or vice-versa.
- **Dead server endpoints (5):** `GET /api/health`, `GET /api/users/:id`, `GET /api/tasks/:id`, `POST /api/tasks/bulk`, `PUT /api/keyword-rules/:id`.
- **Payload mismatches (2):** F-02 (`PUT /api/users/:id`), F-05 (`DELETE /api/gmail/linked-account`).
- **Response shape mismatches (1 real + 2 latent):** F-04 (`gmailStatus.email`), plus `ClientList.jsx:62` silently no-ops if `success !== true`, and `KeywordApprovalModal.jsx:59` defensively handles a `{users:[]}` envelope the server never sends.
- **Role mismatches (5):** F-06, F-07, F-16, F-17, F-18.

---

## 2. Findings

### F-01 — `TaskList` crashes on every filter interaction (undefined state setters)
**Severity: CRITICAL**
- Client: `client/src/pages/TaskList.jsx:692-693`, `:712-713`, `:747-748`
- Server: n/a

`setSelectedTaskIds` and `setSelectAll` are called from the Creator filter, Priority filter and the four status tabs, but **neither is declared anywhere in the file**. The state block is `TaskList.jsx:27-113` and contains no `selectedTaskIds` / `selectAll`. Verified: `grep -n "selectedTaskIds" TaskList.jsx` → only lines 692, 712, 747 (call sites, no declaration). The identifiers exist only in `EmailInbox.jsx:54-55` — this is a copy-paste leftover from the inbox bulk-select feature.

**What breaks:** Clicking any status tab (`All`/`Pending`/`Completed`/`Late`), changing the Priority dropdown, or changing the Creator dropdown throws `ReferenceError: setSelectedTaskIds is not defined` inside the React event handler. There is no error boundary in `App.jsx`, so React 19 unmounts the whole tree — the Tasks page goes blank and only a full reload recovers it. This makes task filtering completely unusable for every role.

**Fix:** Delete the three `setSelectedTaskIds(new Set()); setSelectAll(false);` pairs (TaskList has no bulk-select UI), or add `const [selectedTaskIds, setSelectedTaskIds] = useState(new Set()); const [selectAll, setSelectAll] = useState(false);` if bulk-select is intended. Also add a top-level `<ErrorBoundary>` in `App.jsx` so a single handler bug can't blank the app.

---

### F-02 — Admin's Gmail-permission controls are silently discarded by zod strip
**Severity: CRITICAL**
- Client: `client/src/pages/admin/ManageUsers.jsx:102-109` (sends `maxConnectedAccounts`, `allowedGmailAccounts`), UI at `:737-817`
- Server: `server/middleware/schemas.js:30-39` (`updateUserSchema`), `server/middleware/validate.js:9-10`, consumer at `server/controllers/userController.js:100`

`updateUserSchema` declares only `name`, `email`, `role`, `status`. `validate.js:10` does `req.body = parsed`, and zod's default object mode **strips unknown keys**. Verified by execution against the installed zod 4.4.3:
```
parsed: {"name":"x"}     // maxConnectedAccounts and allowedGmailAccounts removed
```
`userController.js:100` destructures `maxConnectedAccounts` and `allowedGmailAccounts` from `req.body` — they are always `undefined`, so the `if (... !== undefined)` guards at `:108` and `:112` never fire.

**What breaks:** The entire "Head Connected Accounts Permissions" panel is a no-op. The admin sets a max-account limit and checks authorized Gmail addresses, gets a green "updated successfully" toast, and nothing is persisted. The enforcement code in `gmailController.js:232-244` (which blocks a Head from connecting an unauthorized Gmail account) therefore always sees an empty `allowedGmailAccounts` and the default `maxConnectedAccounts = 5`. This is a security control that appears to work and does not.

**Fix:** Add to `updateUserSchema`:
```js
maxConnectedAccounts: z.coerce.number().int().min(0).max(50).optional(),
allowedGmailAccounts: z.union([z.array(z.string()), z.string()]).optional()
```
(`z.coerce.number` is needed because `ManageUsers.jsx:756` sends the `<input type="number">` value as a string.)

---

### F-03 — Every validation failure returns 500 instead of 400 (zod 4 API break)
**Severity: CRITICAL**
- Server: `server/middleware/validate.js:15` — `const firstError = error.errors[0]?.message || 'Validation failed.';`
- Client: all form error handlers, e.g. `Register.jsx:42`, `Login.jsx:28`, `Profile.jsx:151`, `ManageUsers.jsx:86`, `TaskList.jsx:286`

In zod 4, `ZodError` exposes `.issues`; `.errors` was removed. Verified by execution:
```
e.errors is: undefined
ACCESSING e.errors[0] THREW: Cannot read properties of undefined (reading '0')
```
The `TypeError` is thrown **inside the catch block**, so it is not caught. Express 5 forwards the synchronous throw to the global handler at `index.js:107-113`, which maps non-4xx to `500` + `'Internal Server Error'`.

**What breaks:** Every zod-guarded endpoint (register, login, forgot-password, create user, update user, update profile, change password, reply, bulk-assign, disconnect-linked-account, create task, bulk task) returns **HTTP 500 `{message:"Internal Server Error"}`** for any bad input instead of 400 with the field message. A user who types a 5-character password sees "Internal Server Error", not "Password must be at least 6 characters." All server-side field validation feedback is lost across the whole app.

**Related:** `errorMap` in `schemas.js:26,34,37,62,88` is the zod 3 API; in zod 4 the key is `error`, so those custom messages are ignored even after `.errors` is fixed (verified: enum error text was zod's default, not `'bad'`).

**Fix:**
```js
const firstError = error.issues?.[0]?.message || 'Validation failed.';
```
and rename every `errorMap: () => ({ message: 'x' })` to `error: () => 'x'`. Add a regression test that posts an invalid body and asserts 400.

---

### F-04 — Profile page never shows the connected Gmail address (response field mismatch)
**Severity: MEDIUM**
- Client: `client/src/pages/Profile.jsx:64` (`setGmailStatus(res.data)`), rendered at `Profile.jsx:375` — `{gmailStatus.email}`
- Server: `server/controllers/gmailController.js:685-689` — returns `{ connected, gmailEmail, linkedAccounts }`

The server has no `email` key. `Dashboard.jsx:81` and `EmailInbox.jsx:216` correctly read `gmailEmail`; only Profile reads `.email`.

**What breaks:** The "Inbox Address" box on the Profile page renders empty whenever Gmail is connected — the user sees a labeled but blank field.

**Fix:** `Profile.jsx:375` → `{gmailStatus.gmailEmail}`. Also `Profile.jsx:9` and `:93` initialise/reset with `{ connected:false, email:'' }` — change to `gmailEmail`.

---

### F-05 — Disconnecting a "blank" Gmail account 500s (empty string fails `.email()`)
**Severity: MEDIUM**
- Client: `client/src/pages/EmailInbox.jsx:321` — `api.delete('/gmail/linked-account', { data: { gmailEmail, userId } })`, invoked from `:1056` with `acct.gmailEmail` which may be `""` (the UI explicitly renders `"Invalid Account"` for that case at `:1033`)
- Server: `server/middleware/schemas.js:65-70` (`disconnectLinkedAccountSchema`), handler `gmailController.js:718-730`

The controller has a dedicated branch for "gmailEmail is empty → clear blank connections", but the zod schema declares `gmailEmail: z.string().trim().email().optional()`. An empty string is *present*, so `.email()` runs and fails — the request never reaches the branch designed to handle it. Combined with F-03 the client receives a 500.

**What breaks:** The "clear blank/invalid Gmail connection" recovery path is unreachable from the UI.

**Fix:** `gmailEmail: z.string().trim().email().or(z.literal('')).optional()` and keep the `.refine` requiring one of the two fields.

---

### F-06 — `/inbox` route is not role-guarded, but the API is; the controller contradicts the route
**Severity: HIGH**
- Client: `client/src/App.jsx:48` — `<Route path="/inbox" element={<EmailInbox />} />` sits inside `ProtectedRoute` (token check only, `ProtectedRoute.jsx:9`), with no `roles` gate. `Sidebar.jsx:63` hides the link for Employees but the URL still resolves.
- Server: `server/routes/gmailRoutes.js:35` — `authorizeRoles('Admin','Head')`

`gmailController.getEmails` at `:549-550` explicitly implements an Employee branch (`query.assignedTo = req.user._id`) that the route makes unreachable, and `EmailInbox.jsx:687` renders Employee-specific copy ("View emails assigned to you"). Three layers disagree about whether Employees have an inbox.

**What breaks:** An Employee who navigates to `/inbox` (bookmark, notification link, typed URL) gets a fully rendered page whose data call 403s; the only feedback is the hardcoded `'Failed to load emails.'` at `EmailInbox.jsx:362`. `fetchGmailStatus` and `fetchPendingApprovalsCount` also fire and 403/500 silently.

**Fix:** Decide the policy. Either (a) wrap `/inbox` in a role guard mirroring `AdminRoute`, or (b) relax `gmailRoutes.js:35` to include `Employee` (the controller already scopes them correctly) and gate the Admin/Head-only UI blocks — several already check `userRole`.

---

### F-07 — Head sees a "Delete Task" button the server rejects with 403
**Severity: MEDIUM**
- Client: `client/src/pages/TaskList.jsx:1292-1301` — the Delete button renders for `role === 'Admin' || role === 'Head'` with no creator check
- Server: `server/controllers/taskController.js:263-265` — a Head may only delete tasks **they created**

`getAllTasks` (`taskController.js:86`) returns to a Head both tasks they created *and* tasks assigned to them. For the latter set the Delete button is always a 403.

**What breaks:** Head clicks Delete on a task an Admin assigned to them, confirms the `window.confirm`, and gets an error toast. The optimistic `setTasks(prev => prev.filter(...))` at `TaskList.jsx:355` already removed the row before the request — the row vanishes, then `fetchTasks()` at `:358` brings it back. Visible flicker plus a confusing failure.

**Fix:** Render Delete only when `currentUser.role === 'Admin' || task.createdBy?._id === currentUser._id`. Also move the optimistic filter to *after* the awaited delete (see F-15).

---

### F-08 — Stored XSS: task-view email iframes run untrusted Gmail HTML with `allow-scripts allow-same-origin`
**Severity: CRITICAL**
- Client: `client/src/pages/TaskList.jsx:1156` and `client/src/pages/TaskList.jsx:1742` — `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`; content built by `renderEmailContent` at `TaskList.jsx:15-24`
- Server: body is stored verbatim — `server/controllers/gmailController.js:349-354` decodes the raw Gmail `text/html` part with no sanitisation and saves it at `:423`

`allow-scripts` + `allow-same-origin` on a same-origin `srcDoc` iframe is the documented sandbox-escape combination: scripts inside the frame run **in the parent's origin** and can read `parent.localStorage`. The only defence is the regex at `TaskList.jsx:18` that strips `<script>…</script>`, which does nothing against `<img src=x onerror=…>`, `<svg onload=…>`, `<iframe srcdoc=…>`, `<body onload=…>` or `javascript:` URLs.

**What breaks:** Any attacker who can email the workspace can exfiltrate the JWT (`localStorage.getItem('token')`, the auth material per `api/axios.js:14`) plus the cached inbox/tasks the moment an Admin or Head expands a task with a linked email. Full account takeover from an inbound email.

Note `EmailInbox.jsx:1343` omits `allow-scripts` and is therefore safe — the two TaskList iframes are the outliers, which strongly suggests the flags were copied before the inbox was hardened.

**Fix (do all three):**
1. Drop `allow-scripts` from both TaskList iframes so they match `EmailInbox.jsx:1343`. Ideally drop `allow-same-origin` too and size the frame via `postMessage` instead of the `onLoad`/`contentDocument` trick at `:1159-1168`.
2. Sanitise server-side on ingest (`gmailController.js:354`) with DOMPurify/`sanitize-html`, allow-listing tags/attrs and stripping all `on*` handlers.
3. Serve email bodies from a distinct origin or add a per-frame CSP if inline rendering must stay.

---

### F-09 — `/auth/me` polled every 8 s trips the app's own rate limiter
**Severity: HIGH**
- Client: `client/src/components/ProtectedLayout.jsx:55-59` — immediate call + `setInterval(..., 8000)`, mounted for every authenticated route
- Server: `server/index.js:28-34` — `generalLimiter`: 300 requests / 15 min **per IP**, applied to all of `/api` at `:49`

900 s ÷ 8 s = **112 requests per 15-minute window per open tab**, before any real work. Two tabs plus normal usage (inbox auto-reload every 5 min at `EmailInbox.jsx:199`, the 4-request refetch storm of F-12) crosses 300. The limiter keys on IP, so an office behind one NAT shares the budget across all staff.

**What breaks:** Users start receiving 429 `{message:'Too many requests…'}` on *every* endpoint. The client has no 429 handling anywhere — `ProtectedLayout.jsx:46` only special-cases 401/403, so the poll silently fails, while pages show generic "Failed to load…" toasts. Symptom presents as random app-wide breakage.

**Fix:** Raise the poll to 60–120 s (or replace it with a Socket.io `user:updated` push — the socket infrastructure already exists), exempt `/api/auth/me` from `generalLimiter`, key the limiter on user id rather than IP, and add a 429 branch to the axios response interceptor (see F-20).

---

### F-10 — AI summarize sends the full HTML body; Express caps JSON at 100 kb
**Severity: HIGH**
- Client: `client/src/pages/EmailInbox.jsx:623-627` — posts `{ subject, from, body }` with the untruncated `email.body`
- Server: `server/index.js:39` — `app.use(express.json())` with no `limit` (default **100 kb**); `server/controllers/aiController.js:23-24` truncates to 3000 chars *after* parsing

`gmailController.js:356-381` inlines every CID image into the stored body as a base64 `data:` URL, so bodies routinely run to hundreds of kilobytes or megabytes.

**What breaks:** Clicking "Summarize" on any email with an inline image/logo — i.e. most business email — produces a 413 `PayloadTooLargeError`. The global handler at `index.js:107` maps `err.status = 413` (< 500) so the raw message surfaces, and `EmailInbox.jsx:630` shows it as the summary error. The feature fails on exactly the emails it is most useful for.

**Fix:** Send only `{ emailId }` and let the server load and truncate the body from Mongo (it already has the document; this also stops the client from shipping data the server already owns). If the shape must stay, truncate client-side to ~4 kb of text and raise `express.json({ limit: '1mb' })`.

---

### F-11 — No pagination anywhere on the server; the client paginates a fully-downloaded dataset
**Severity: HIGH**
- Client: `client/src/pages/EmailInbox.jsx:76-78, 158-163` — `currentPage`/`itemsPerPage` slicing `filteredEmails`; pagination bar at `:1464-1510`
- Server: `server/controllers/gmailController.js:572-575` — `Email.find(query)…sort({date:-1})` with no `.limit()`/`.skip()`; same for `taskController.js:89` (tasks), `notificationController.js:8` (notifications), `userController.js:279` (activity logs)

The pagination UI is pure theatre: page 1 of 25 already required downloading every email in the workspace, bodies and inlined base64 images included. `syncAccountEmails` pulls `maxResults: 150` per account per sync and never prunes, so the collection grows without bound.

**What breaks:** `GET /api/gmail/emails` response size grows linearly with workspace history — tens of MB within weeks. First paint of `/inbox` is gated on that download, `TaskList.jsx:226` downloads the *same* payload again just to populate a "link an email" dropdown, and the localStorage cache write at `EmailInbox.jsx:355` will hit the 5 MB quota (handled, but by silently disabling the cache at `:358`).

**Fix:** Add `?page`/`?limit` to `getEmails` (Mongo `.skip().limit()` + a `countDocuments` total) and return `{ items, total, page }`; move tab/label and account filters into the Mongo query (they are currently client-side over the full set — `EmailInbox.jsx:84-121`). Add a `.select('-body')` list projection and fetch a body only when a row is expanded. Apply the same to tasks, notifications (`NotificationBell.jsx:188` renders only 10 of N) and activity logs.

---

### F-12 — Mutations trigger a 4-request refetch storm, sequentially
**Severity: MEDIUM**
- Client: `client/src/pages/TaskList.jsx:282-283` (create), `:358-359` (delete), and `fetchDropdownData` at `:209-234`
- Server: `/api/tasks`, `/api/tasks/clients`, `/api/users`, `/api/gmail/emails`

`fetchDropdownData` awaits clients → then users → then the entire email collection, a three-deep waterfall. Creating or deleting one task fires `fetchTasks()` **and** `fetchDropdownData()`, i.e. 4 requests, one of which (F-11) is the heaviest endpoint in the app. `handleDeleteTask` additionally `await`s `fetchTasks()` at `:358` after already having filtered the row out optimistically at `:355`.

**What breaks:** Multi-second stalls and a spinner after every task mutation; on a large workspace the email refetch dominates. The Kanban drag handler at `:646` is the only mutation that does it right (optimistic + revert, no refetch).

**Fix:** `Promise.all([...])` inside `fetchDropdownData`; after a create, merge the 201 response body (`taskController.js:68` returns the fully populated task) into state instead of refetching; refresh the unassigned-email dropdown only when the create actually consumed a `linkedEmail`.

---

### F-13 — Dead server endpoints
**Severity: LOW**
- `POST /api/tasks/bulk` — `server/routes/taskRoutes.js:26`, `taskController.js:302-371`, schema `schemas.js:86-92`. ~70 lines implementing bulk delete/status/reassign with Head ownership checks and linked-email sync. No client caller (`grep "tasks/bulk" client/src` → none). The vestigial `setSelectedTaskIds` calls of F-01 are the ghost of its UI.
- `PUT /api/keyword-rules/:id` — `keywordRuleRoutes.js:32`, `keywordRuleController.js:109-144`. `KeywordApprovalModal.jsx` only creates (`:84`) and deletes (`:110`); a rule's assignee, `autoApprove` or `isActive` can never be changed from the UI.
- `GET /api/users/:id` (`userRoutes.js:44`), `GET /api/tasks/:id` (`taskRoutes.js:33`), `GET /api/health` (`index.js:59`).

**What breaks:** Nothing at runtime — but this is untested, unexercised attack surface, and the missing keyword-rule edit UI is a genuine functional gap (users must delete and recreate a rule to change its assignee).

**Fix:** Either wire up the bulk-action toolbar and the rule-edit form, or delete the routes. Keep `/api/health` and point a real health check at it.

---

### F-14 — Two divergent Client APIs with different response envelopes
**Severity: MEDIUM**
- Server A: `/api/tasks/clients` — `taskRoutes.js:20-23` → `taskController.js:289-470`; Admin-only writes; returns a **bare array**; no `contactPerson`/`phone`/`status` support.
- Server B: `/api/clients` — `clientRoutes.js:13-16` → `clientController.js:10-156`; Admin+Head writes; returns **`{success, count, data}`**; full field set plus computed `taskCount`/`mailCount`.
- Client A: `TaskList.jsx:212`, `ManageUsers.jsx:166/188/219/240`
- Client B: `ClientList.jsx:61/126/150/167`

Two pages edit the same collection through different endpoints with different permissions and different validation (A rejects duplicate names case-insensitively at `taskController.js:384`; B does the same at `clientController.js:58` — but A cannot set `status`, so a client created in ManageUsers always defaults to `Active` while ClientList's status filter at `:185` assumes it is meaningful).

**What breaks:** A Head can create a client in ClientList but not in ManageUsers (which is Admin-gated anyway); edits made in one screen silently drop fields the other screen owns; `ClientList.jsx:62` requires `res.data.success`, so pointing it at API A would render a permanently empty, error-free page.

**Fix:** Retire `/api/tasks/clients` (keep a thin alias during migration), move `ManageUsers` onto `/api/clients`, and standardise on one envelope — either bare arrays everywhere or `{success,data}` everywhere. Right now `/api/clients` is the only endpoint in the codebase using the `{success,data}` shape.

---

### F-15 — No AbortController, no unmount guards, no request-ordering protection
**Severity: MEDIUM**
- Client: every fetch. Representative: `EmailInbox.jsx:340-367` (`loadEmails`), `TaskList.jsx:191-207`, `Reports.jsx:70-154`, `NotificationBell.jsx:79-88`
- Search debounce: `EmailInbox.jsx:193-209`

`loadEmails` is debounced 400 ms but never cancels the in-flight request. Typing "gst" issues three overlapping `GET /api/gmail/emails?q=…` calls whose responses can land out of order; the last *response* wins, not the last *query*. Given F-11's payload sizes, out-of-order completion is likely, not theoretical.

`setEmails`/`setLoading`/`setSearchLoading` also run unconditionally in `.then`/`.finally`, so navigating away mid-flight updates state on an unmounted component. The 5-minute `setInterval` at `:199` is cleared correctly, and `NotificationBell.jsx:52-56` cleans up its socket — but no fetch anywhere is cancellable.

**What breaks:** Stale search results displayed for the current query; React unmounted-update warnings; wasted bandwidth on abandoned requests.

**Fix:** Thread an `AbortController` through each fetch and abort in the effect cleanup:
```js
useEffect(() => {
  const ac = new AbortController();
  const t = setTimeout(() => loadEmails(searchQuery, ac.signal), 400);
  return () => { clearTimeout(t); ac.abort(); };
}, [searchQuery]);
```
axios supports `{ signal }` natively. Ignore `err.name === 'CanceledError'` in the catch.

**Related duplicate request:** `EmailInbox.jsx:188` calls `loadEmails('')` on mount, and the debounce effect at `:193` fires `loadEmails('')` again 400 ms later — the heaviest endpoint in the app is called twice on every inbox visit.

---

### F-16 — Comment delete button shown to Head for comments the server won't let them delete
**Severity: LOW**
- Client: `client/src/pages/TaskList.jsx:1221` — `(role === 'Admin' || role === 'Head' || comment.author?._id === currentUser._id)`
- Server: `server/controllers/commentController.js:135-140` — a Head may delete another user's comment only on tasks **they created**

**What breaks:** 403, surfaced as the hardcoded `'Failed to delete comment.'` at `TaskList.jsx:407` — note this handler discards `err.response.data.message`, so the actual reason ("Access denied.") never reaches the user.

**Fix:** Match the client condition to the server rule (`role==='Admin' || task.createdBy?._id===currentUser._id || comment.author?._id===currentUser._id`) and surface the server message.

---

### F-17 — Landing page calls an Admin/Head endpoint for every logged-in user
**Severity: LOW**
- Client: `client/src/pages/Landing.jsx:36-52` — if a token exists, `GET /api/reports/overall`
- Server: `server/routes/reportsRoutes.js:19` — Admin/Head only

**What breaks:** Every Employee who lands on `/` triggers a guaranteed 403, swallowed by `console.error` at `Landing.jsx:49`. The hero stats silently stay at the hardcoded fake values (`1248` emails, `340` tasks — `Landing.jsx:14-21`). Harmless but it pollutes logs and burns rate-limit budget (F-09).

**Fix:** Gate the call on `JSON.parse(localStorage.user).role !== 'Employee'`, or add a public `/api/reports/public-stats`.

---

### F-18 — Reports page hidden from Head although the server serves them
**Severity: LOW**
- Client: `client/src/App.jsx:54-61` wraps `/reports` in `AdminRoute` (`AdminRoute.jsx:21` requires `role === 'Admin'`); `Sidebar.jsx:93` lists `/reports` as `roles: ['Admin']`
- Server: `/api/reports/overall|timeline|email-timeline|client-stats` all allow **Admin and Head** and contain explicit Head-scoping logic (`reportsController.js:93-96`, `:148-150`, `:255-257`)

The one exception is `/api/reports/employee` (Admin-only, `reportsRoutes.js:16`), which `Reports.jsx:130` calls on mount.

**What breaks:** Heads are denied a feature the backend was deliberately built to serve them, including per-Head data scoping that can never execute.

**Fix:** Allow Head into `/reports` and hide the employee-performance table for non-Admins (or open `/api/reports/employee` to Head with a scoped query).

---

### F-19 — `PUT /api/tasks/:id` has no zod schema and no role gate at the route
**Severity: MEDIUM**
- Server: `server/routes/taskRoutes.js:34` — `.put(protect, updateTask)`; every sibling write route carries `authorizeRoles` and/or `validate(...)`
- Client: `TaskList.jsx:310-321` sends the entire edit form

All authorisation lives inside the controller (`taskController.js:149-233`), and there is zero shape validation: `status` is not checked against the enum before assignment at `:211` (Mongoose catches it, but as a 500 via the generic catch at `:246-248`, not a 400), and `title`/`description`/`clientName`/`notes` are `.trim()`ed at `:206-210` without a type check — a JSON body of `{"title": 123}` throws `title.trim is not a function` → 500.

**Fix:** Add an `updateTaskSchema` (all fields optional, `status`/`priority`/`recurrence` as enums, strings as `z.string()`), and mount it with `validate(updateTaskSchema)`. Keep the in-controller role branching.

---

### F-20 — Auth flow: no 401 interceptor, no expiry handling, token in localStorage
**Severity: HIGH**
- Client: `client/src/api/axios.js:1-25` — a **request** interceptor only; there is no response interceptor
- Server: `server/middleware/authMiddleware.js:20-38`; tokens are 7-day JWTs signed at `authController.js:12-18`

Findings:
1. **No response interceptor.** A 401 mid-session (expired token, or `tokenVersion` bumped by a password change at `userController.js:373`) is handled by each call site independently — that is, not at all. Every page shows its own generic failure toast and the user sits on a dead screen. The only recovery is the `/auth/me` poll in `ProtectedLayout.jsx:44-50`, which does clear credentials and redirect — up to 8 seconds later, and only if that particular request isn't the one being rate-limited (F-09).
2. **Token in `localStorage`** (`Login.jsx:21`, read at `axios.js:14`) rather than an httpOnly cookie — directly exploitable by F-08.
3. **No refresh token.** 7-day expiry, then a hard failure; nothing to race, so no refresh/in-flight race condition exists (the one bright spot).
4. **`jwt-decode` is a declared dependency (`client/package.json`) that is never imported** — verified `grep -rn "jwt-decode\|jwtDecode" client/src` → no matches. Authorization decisions instead read `JSON.parse(localStorage.getItem('user')).role` (`AdminRoute.jsx:18-21`, `Sidebar.jsx:7-14`, `Navbar.jsx:18-26`, `TaskList.jsx:120-127`, and 6 other sites). That object is plain, unsigned, user-editable JSON — a user can set `role:"Admin"` in DevTools and unlock every admin screen. **This is a UI-only bypass**: `authorizeRoles` (`authMiddleware.js:50-63`) re-derives the role from the DB user on every request, so no data leaks. The exposure is limited to a spoofer seeing admin UI shells whose API calls all 403.
5. **`baseURL` hardcoded** to `http://localhost:5015/api` (`axios.js:5`); socket URL hardcoded to `http://localhost:5015` (`NotificationBell.jsx:33`). No `import.meta.env.VITE_API_URL` — the build cannot be deployed anywhere.

**Fix:**
```js
api.interceptors.response.use(r => r, (err) => {
  const s = err.response?.status;
  if (s === 401) { localStorage.clear(); window.location.href = '/login'; }
  if (s === 429) { /* surface "slow down" toast */ }
  return Promise.reject(err);
});
```
Move the token to an httpOnly+SameSite cookie (removes the F-08 exfiltration target); keep `localStorage.user` for *display only* and never for gating; switch both URLs to `import.meta.env.VITE_API_URL`.

---

### F-21 — Cached workspace data survives logout (cross-user leak on shared machines)
**Severity: HIGH**
- Client writes: `TaskList.jsx:197` (`cached_tasks_data`), `EmailInbox.jsx:355` (`cached_inbox_emails` — 50 emails incl. 300 chars of body), `ClientList.jsx:65` (`cached_clients_data`), `Dashboard.jsx:62/66` (`cached_dashboard_stats`, `cached_dashboard_tasks`), `Reports.jsx:75/88` (`cached_reports_overall`, `cached_reports_timeline`), `EmailInbox.jsx:514` (`emailsDownloaded`)
- Logout: `Navbar.jsx:29-30` and `Sidebar.jsx:33-34` remove **only** `token` and `user`. `ProtectedLayout.jsx:23-24` and `:47-48` likewise.

Each of those pages seeds its initial state from the cache and renders it before any request completes (e.g. `TaskList.jsx:27-34`, `EmailInbox.jsx:16-23`).

**What breaks:** User A logs out on a shared/office machine; User B logs in; before B's first response arrives, B is shown A's tasks, A's client list, A's dashboard metrics and A's email subjects/senders/body previews. On a slow network that window is seconds long. Employee-role users see Admin-scoped data this way.

**Fix:** Centralise logout in one helper that clears every `cached_*` key (or calls `localStorage.clear()`), and call it from Navbar, Sidebar and both ProtectedLayout branches. Better: key caches by user id, or move them to `sessionStorage`, and stop caching email bodies at rest entirely.

---

### F-22 — Socket.io: no error handling, no re-auth, dev double-connect
**Severity: MEDIUM**
- Client: `client/src/components/NotificationBell.jsx:26-57`
- Server: `server/index.js:142-192` (handshake auth), emit at `notificationHelper.js:26-30`

What is correct: a single mount point (inside `Navbar` inside `ProtectedLayout`), `useEffect([])` so listeners register once, cleanup `socket.disconnect()` at `:52-56`, JWT passed via `handshake.auth.token` at `:34-36`, server-side verification incl. `tokenVersion` at `index.js:156`, and rooms scoped to the user's own id at `:174-178` (the `join` handler at `:181` correctly ignores its argument, so a client cannot join another user's room). **No duplicate-listener leak.**

Problems:
1. **No `connect_error` handler.** If the token is missing/expired/revoked the server rejects the handshake (`index.js:145,151,157,165`); the client logs nothing and silently never receives notifications. socket.io then retries forever, hammering the server.
2. **No re-auth on token change.** After a password change bumps `tokenVersion`, the live socket keeps failing and is never rebuilt with the new token — the effect's dep array is `[]`.
3. **Connects unconditionally** at `:33`, even when `user` is null (the guard at `:28` covers only `fetchNotifications`).
4. **Comment events are dead.** `commentController.js:104-110` emits `task:<id>:comment` and `:153` emits `task:<id>:commentDeleted`; no client anywhere subscribes (`grep "task:" client/src` → no matches). Comments in `TaskList` never update live.
5. **StrictMode double-connect** in dev: two sockets are opened, the first is cleaned up. Cosmetic, but noisy.

**Fix:** Add `socket.on('connect_error', …)` that clears credentials and redirects on an auth error; add `token` to the effect dependencies (or `socket.auth = {token}; socket.connect()` on change); guard the connect on a token being present; and either subscribe to the comment events in TaskList or delete the server emits.

---

### F-23 — Missing loading / error / empty states, and swallowed errors
**Severity: MEDIUM**

**No loading state at all:**
| Fetch | File:line |
|---|---|
| notifications | `NotificationBell.jsx:79-88` (dropdown shows "No notifications yet." while loading — a false empty state) |
| gmail status | `Dashboard.jsx:76-87`, `EmailInbox.jsx:211-222`, `Profile.jsx:61-68` (Dashboard renders the "No Gmail Connected" CTA before the check returns) |
| pending approvals count | `EmailInbox.jsx:224-231` |
| bulk-assign user list | `EmailInbox.jsx:233-241`, `TaskList.jsx:209-234` |
| overall stats on Landing | `Landing.jsx:35-53` |
| clients in ManageUsers | `ManageUsers.jsx:164-172` (`clients.length === 0` at `:511` renders "No clients found" during load) |
| overall stats in Reports | `Reports.jsx:70-81` (only `fetchTimeline` clears `statsLoading`, at `:94` — if `/reports/timeline` fails while `/reports/overall` succeeds, the skeleton is still cleared by the `finally`; if the component's first render has a cache, `statsLoading` starts false anyway) |

**Errors logged and otherwise swallowed** (user sees nothing, or a wrong empty state):
`NotificationBell.jsx:86`, `:115`, `:127`; `Dashboard.jsx:85`; `EmailInbox.jsx:220`, `:229`, `:239`; `TaskList.jsx:232` (a failed `/users` fetch leaves the Assignee dropdown empty with no explanation — the user concludes there are no assignable users), `TaskList.jsx:376`; `Landing.jsx:49`; `ProtectedLayout.jsx:44`; `Reports.jsx:123`; `ClientList.jsx:66`; `Dashboard.jsx:53`.

**Errors replaced with a worse hardcoded message** (server's reason discarded): `EmailInbox.jsx:362` (`'Failed to load emails.'` for a 403/500/429 alike), `TaskList.jsx:407` (`'Failed to delete comment.'`), `TaskList.jsx:425` / `EmailInbox.jsx:615` (`'Failed to download attachment.'`), `Profile.jsx:98`.

**Raw server strings shown to users:** the `err.response?.data?.message` pattern appears at ~30 sites. Server messages are hand-written and safe, with two leaks worth noting: `authMiddleware.js:58` returns `` `Forbidden. Role '${req.user.role}' is not authorized…` `` (echoes internal role naming), and `clientController.js:88/136` returns `err.message` from a raw Mongoose error on 500 — that one can expose schema/index internals.

**No toast system.** Six pages each hand-roll an identical `triggerAlert` + `setTimeout(…, 4500)` + fixed-position div (`TaskList.jsx:184-189`, `EmailInbox.jsx:333-338`, `Dashboard.jsx:100-105`, `Profile.jsx:29-34`, `ManageUsers.jsx:49-54`, `ActivityLog.jsx:21-26`, `Reports.jsx:63-68`), `KeywordApprovalModal.jsx:14-28` has its own variant, `ClientList` uses inline error divs plus one raw **`alert()`** at `ClientList.jsx:172`, and destructive confirmations use `window.confirm` at 8 sites. None of the `setTimeout`s are cleared on unmount.

**Fix:** Extract one `<ToastProvider>` + `useToast()`; render `{loading ? <Skeleton/> : items.length ? <List/> : <Empty/>}` (distinguish "loading", "empty", "failed"); stop discarding `err.response.data.message`; replace the `alert()` and the `window.confirm`s with the existing modal component (`ClientList.jsx:823` already has a proper confirm dialog — reuse it).

---

### F-24 — Forms: validation parity gaps and double-submit holes
**Severity: MEDIUM**

**Double-submit protection — mostly present, two holes:**
- Good: `Login.jsx:33`, `Register.jsx:162`, `ForgotPassword.jsx:107`, `TaskList.jsx:1524/1797`, `ClientList.jsx:681/811/846`, `ManageUsers.jsx:654`, `EmailInbox.jsx:1161`, `KeywordApprovalModal.jsx:411`.
- **Hole 1 — `TaskList.jsx:1241`:** the comment textarea's `onKeyDown` calls `handlePostComment` on Enter with **no `commentSubmitting` guard** (`handlePostComment` at `:382` checks only that the input is non-empty). Two fast Enters post the comment twice — and each duplicate fires notifications to assignee and creator (`commentController.js:80-98`).
- **Hole 2 — `EmailInbox.jsx:773` / `:1265`:** "Clear All Emails" and per-row delete have no in-flight state; only `window.confirm` stands between a double-click and two `DELETE`s.

**Validation parity (client vs zod):**
| Field | Client | Server | Gap |
|---|---|---|---|
| password (register/create user) | `type=password`, no min length | `min(6)` — `schemas.js:7,24` | Server-only; with F-03 the user sees "Internal Server Error" |
| new password (profile) | `>= 6` checked at `Profile.jsx:134` | `min(6)` — `schemas.js:50` | parity OK |
| email | `type=email` (browser) | `.email()` | parity OK |
| task title/client/assignee/deadline | required + future-date check `TaskList.jsx:240-250` | required, **no future-date rule** | Client-only rule; the server accepts past deadlines (the cron at `cronJobs.js:20` immediately flips them to `Late`) |
| keyword rule | `newKeyword.trim()` + assignee `KeywordApprovalModal.jsx:74` | same, `keywordRuleController.js:34` | parity OK |
| client name | `formData.name.trim()` | required + uniqueness | parity OK |
| user role (create) | `<select>` Employee/Head | `z.enum(['Head','Employee'])` | parity OK |
| user role (edit) | `<select>` incl. **Admin** `ManageUsers.jsx:720` | enum allows Admin **but** `userController.js:127-136` rejects a second approved Admin | Client offers an option that usually 400s |
| `maxConnectedAccounts` | `type=number` min 1 max 50 | — | Stripped entirely (F-02) |

**Uncontrolled → controlled warning:** `TaskList.jsx:872-881` (calendar-cell click) rebuilds `newTask` **without** `isRecurring`/`recurrence`; the checkbox at `:1467` then receives `checked={undefined}`, flipping it from controlled to uncontrolled. React logs a warning and the recurrence toggle misbehaves until the modal is reopened another way.

**Fix:** Guard `handlePostComment` with `if (commentSubmitting) return;`; add in-flight state to the two delete buttons; mirror the 6-character password rule client-side; include `isRecurring: false, recurrence: 'Weekly'` in the calendar prefill; hide the Admin role option unless no other approved Admin exists.

---

### F-25 — Inbox tab counts disagree with the list they label
**Severity: MEDIUM**
- Client: `EmailInbox.jsx:87-93` (list filter uses `email.toEmail` **OR** `email.fetchedBy?.gmailEmail`) vs `EmailInbox.jsx:125-130` (count filter uses **only** `email.fetchedBy?.gmailEmail`)

Both functions filter the same array by the same `selectedAccount`, using different predicates.

**What breaks:** With an account selected, the tab badges ("Inbox 12", "Spam 3") do not match the number of rows rendered — for linked (extra) accounts `toEmail` is the linked address while `fetchedBy.gmailEmail` is the *owner's primary* address, so counts can be wildly off or zero. Also, when the server-side search at `gmailController.js:556` narrows the result set, the badges silently become "matches within the current search", not inbox totals.

**Fix:** Extract one predicate used by both, and move counts server-side (`countDocuments` per label) once pagination lands (F-11).

---

### F-26 — Delete protection is enforced only in the browser
**Severity: MEDIUM**
- Client: `EmailInbox.jsx:41` reads `localStorage.getItem('emailsDownloaded')`; gates at `:545-548` (clear all) and `:566-569` (single delete); banner at `:791`
- Server: `DELETE /api/gmail/emails` (`gmailController.js:587`) and `DELETE /api/gmail/emails/:id` (`:607`) have **no backup precondition**

**What breaks:** The "you must download a backup before deleting" safety rule is one `localStorage.setItem('emailsDownloaded','true')` away from being bypassed, and is defeated entirely by clearing site data or using a different browser. It is presented to users as a hard guarantee ("Delete Protection Active").

**Fix:** Record the export server-side (an `exports` collection or a `lastBackupAt` on the workspace) and check it in `deleteAllEmails`. Keep the client gate as UX only.

---

### F-27 — Effect dependency issues in TaskList
**Severity: LOW**
- `TaskList.jsx:133-145` — deps `[location.search, tasks, loading]`; the body calls `navigate('/tasks', {replace:true})` at `:143`. The `expandId` guard means the loop terminates after one pass, but the effect re-runs on every `tasks` identity change (i.e. after every refetch) and re-reads a query string it already consumed.
- `TaskList.jsx:148-168` — deps `[tasks]` while the body reads `location.search`; the eslint exhaustive-deps rule is violated. It happens to work because `tasks` changes right after mount, but a cached-tasks first render can make the create-modal prefill fire before or after the URL is cleared depending on timing. Fragile.
- `TaskList.jsx:192` — `setLoading(prev => tasks.length === 0 ? true : false)` ignores `prev` and closes over a stale `tasks`.

**Fix:** Use `[location.search]` only, consume the params once with a `useRef` latch, and derive `loading` from a plain boolean set before/after the request.

---

### F-28 — Miscellaneous
**Severity: LOW**
- **CORS/port fallback mismatch:** `server/index.js:38` defaults to `http://localhost:5173`, but `client/vite.config.js:6-7` pins `port: 5174, strictPort: true`. The committed `.env` sets `FRONTEND_URL=http://localhost:5174` so dev works; if `.env` is absent (e.g. a fresh clone using `.env.example`, which also says 5173) **every request is CORS-blocked** with no useful error. Align `.env.example` and the fallback to 5174.
- **Non-standard status code:** `aiController.js:45` returns **550** for an invalid Gemini key. 550 is not a valid HTTP status; some proxies/clients reject it. Use 502 or 500.
- **`getEmails` `q` search has no debounce on the server and no index** on `subject`/`from` (`models/Email.js:75-80` indexes `fetchedBy/assignedTo/status/toEmail/date/approvalStatus` only). Regex search over the full collection on every keystroke-debounced request.
- **Head's linked accounts are unmanageable:** `EmailInbox.jsx:962` renders the accounts panel only for `userRole === 'Admin'`, and `DELETE /api/gmail/linked-account` is Admin-only (`gmailRoutes.js:59`) — yet `getConnectedStatus` returns linked accounts to Heads too (`gmailController.js:644`). A Head can connect extra accounts (`getAuthUrl` forces `mode='primary'` for Heads at `:144`, so actually they cannot) but sees them listed nowhere. Dead data in the response.
- **`express-mongo-sanitize` on `req.query`** (`index.js:44`) — in Express 5 `req.query` is a getter; mutating the returned object may not persist. **UNVERIFIED** (not exercised at runtime); worth a targeted test since it is a security control.
- **`server/.env` is committed to the repo** and contains `JWT_SECRET`, `GOOGLE_CLIENT_SECRET`, `SENDER_APP_PASSWORD`, `GEMINI_API_KEY`, `TOKEN_ENCRYPTION_KEY`, `OAUTH_STATE_SECRET`. Out of scope for this audit but should be rotated and removed from git history.

---

## 3. Priority ordering

**Fix today:** F-01 (Tasks page crash), F-08 (stored XSS → token theft), F-03 (all validation → 500), F-02 (security control is a no-op).
**Fix this week:** F-20 (401 handling + env-driven URLs), F-21 (cache leak across users), F-09 (self-inflicted rate limiting), F-11 (pagination), F-10 (413 on summarize), F-06 (inbox role contract).
**Then:** F-12, F-14, F-15, F-19, F-22, F-23, F-24, F-25, F-26.
**Cleanup:** F-05, F-07, F-13, F-16, F-17, F-18, F-27, F-28.
