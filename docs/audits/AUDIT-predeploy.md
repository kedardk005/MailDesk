# MailDesk — pre-deployment audit

**Date of audit:** 2026-08-10
**Build audited:** `main` @ `ba509b9` (working tree; the API process was restarted twice during the run — see *Audit conditions*)
**Environment:** `./scripts/dev.sh` — Mongo + Redis in Docker, API on :5015, Vite client on :5174, `maildesk_run` database
**Method:** browser walkthrough as all four seeded roles, direct API probing with per-role bearer tokens, and independent re-derivation of every headline number in `mongosh`.

**Verdict: do not ship as-is.** Seven high-severity defects are reproducible on a clean run. Two of them are the dangerous kind — the app tells the user something succeeded when it did not (Gmail sync), and it shows managers task totals that contradict its own task list (Heads). Neither surfaces as an error, so the office would not discover them; they would just quietly act on wrong information.

---

## 1. Role × module matrix

Legend: **OK** = exercised and behaved correctly · **BROKEN** = defect found, see ID · **n/a** = not reachable for this role by design.

| Module | Admin (`admin@`) | Head (`head@`, billing@) | Head 2 (`ops.head@`, ops@) | Employee (`emp@`) |
|---|---|---|---|---|
| Login / logout / session | OK | OK | OK | OK |
| Dashboard | OK | **BROKEN** H-4 | **BROKEN** H-4 | OK (all 4 tiles re-derived, exact) |
| Inbox — message list | **BROKEN** H-3 | **BROKEN** H-3 | **BROKEN** H-3 | n/a (blocked with a clear explanation page) |
| Inbox — email drawer | OK | OK | OK | n/a |
| Inbox — AI summarise | **BROKEN** H-2 | **BROKEN** H-2 | **BROKEN** H-2 | n/a |
| Inbox — AI extract actions | OK | OK | OK | n/a |
| Inbox — bulk select / assign | OK | OK | OK | n/a |
| Inbox — sync mail | **BROKEN** H-1 | **BROKEN** H-1 | **BROKEN** H-1 | n/a |
| Tasks — List | OK | OK | OK | OK |
| Tasks — filters | **BROKEN** H-6 (creator) | **BROKEN** H-6 | **BROKEN** H-6 | OK (only status + priority offered) |
| Tasks — Board | **BROKEN** M-2 | **BROKEN** M-2 | **BROKEN** M-2 | **BROKEN** M-2 |
| Tasks — Calendar | **BROKEN** H-7 | **BROKEN** H-7 | **BROKEN** H-7 | **BROKEN** H-7 |
| Tasks — create (form) | **BROKEN** M-1 | **BROKEN** M-1 | **BROKEN** M-1 | n/a (no create button; server 403) |
| Clients — list | **BROKEN** M-4 | **BROKEN** M-4 | **BROKEN** M-4 | OK (read-only, correctly scoped) |
| Clients — create / edit | OK | OK | OK | n/a |
| Reports — Overview | **BROKEN** H-5 | **BROKEN** H-4, H-5 | **BROKEN** H-4, H-5 | n/a (403; route redirects) |
| Reports — Email volume | OK | OK | OK | n/a |
| Reports — SLA | **BROKEN** M-6 | **BROKEN** M-6, M-8 | **BROKEN** M-6, M-8 | n/a |
| Reports — Employee performance | **BROKEN** M-3 | **BROKEN** M-3 | **BROKEN** M-3 | n/a |
| Reports — Clients | **BROKEN** H-5 | **BROKEN** H-5 | **BROKEN** H-5 | n/a |
| Users & Approvals | OK | n/a (hidden; API 403) | n/a | n/a (URL redirects to /dashboard) |
| Activity Log | OK | n/a (API 403) | n/a | n/a |
| Profile — all 4 tabs | OK | OK | OK | OK |
| Command palette (⌘K) | OK | OK | OK | OK |
| Theme toggle (light/dark) | OK | OK | OK | OK |
| 375 px mobile | **BROKEN** M-5, M-11 | **BROKEN** M-5, M-11 | **BROKEN** M-5, M-11 | **BROKEN** M-5, M-11 |

**Role isolation itself is sound.** Every cross-role probe I ran was correctly refused: an Employee gets 403 on all seven `/api/reports/*` routes, on `/api/gmail/emails`, `/api/users` and `/api/keyword-rules`; a Head gets 403 on `/api/users/activity-logs`, `/api/users/:id`, and on `PUT /api/reports/sla/policy`; and both Heads get 403 (not data, not 404-as-oracle) on the *other* Head's emails, threads, attachments, tasks and keyword rules. Direct URL access to `/admin/users` and `/reports` as an Employee redirects to `/dashboard`. **No IDOR was found.**

---

## 2. Defects, ranked

### HIGH

---

#### H-1 — "Sync now" reports success while every mailbox sync is failing

**Severity:** High. This is the single most dangerous defect here: mail silently stops arriving and the app actively reassures the user.

**Reproduction**
1. Sign in as `ops.head@demo.test` (or any Admin/Head), open **Inbox**.
2. Click **Sync now**.
3. Observe the toast: a green tick and **"Inbox is already up to date"**.
4. `tail -f .dev-logs/api.log` during step 2.

**Observed** — the client gets `POST /api/gmail/fetch → 202 Accepted`, and ~450 ms later the worker logs:
```
{"level":50,"component":"gmail","err":"invalid_grant","inbox":"ops@kmk-demo.test","msg":"mailbox sync failed"}
```
The UI never learns. The same happens on the 10-minute auto-sync cron, which fails for **all four mailboxes** every cycle:
```
{"level":50,"component":"gmail","err":"invalid_grant","inbox":"ops@kmk-demo.test",...}
{"level":50,"component":"gmail","err":"invalid_grant","inbox":"sales@kmk-demo.test",...}
{"level":50,"component":"gmail","err":"invalid_grant","inbox":"billing@kmk-demo.test",...}
{"level":50,"component":"gmail","err":"invalid_grant","inbox":"support@kmk-demo.test",...}
```
Worse, the Activity Log records these as ordinary **"Gmail Fetch Auto"** entries with no failure marker, so even the audit trail says the syncs happened.

**Expected** — a failed sync must surface in the UI ("Could not sync ops@kmk-demo.test — reconnect the mailbox"), the connection status on Profile → Connected Gmail must stop saying **Connected**, and repeated `invalid_grant` should raise an admin-visible alert. `invalid_grant` in production means the refresh token was revoked, the Google password changed, or consent expired — all of which happen to real offices, and all of which currently produce a workspace that looks healthy and receives no mail.

**Where** — the fetch endpoint returns 202 the moment the job is enqueued (`server/routes/gmailRoutes.js:40` → `gmailController.fetchEmails`); nothing propagates the worker's terminal failure back to the poller or to `GET /api/gmail/status`.

---

#### H-2 — AI "Summarise" is broken for every email, for every user

**Severity:** High. A button on every email in the product that can never succeed.

**Reproduction (UI)**
1. Sign in as Admin or Head, open Inbox, click any email to open the drawer.
2. Click **Summarise**.
3. The panel shows a red error: **"Email subject or body is required for summarization."** — on an email whose subject and body are visibly right above it.

**Reproduction (API) — proves it is a contract mismatch, not a missing API key:**
```bash
# what the client actually sends
curl -s -X POST http://127.0.0.1:5015/api/ai/summarize-email \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"emailId":"6a7066100a8c6650d1e846bc"}'
# → 400 {"message":"Email subject or body is required for summarization."}

# what the server actually expects
curl -s -X POST http://127.0.0.1:5015/api/ai/summarize-email \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"subject":"Re: Dispatch schedule for week 4","from":"a@b.example",
       "body":"Requesting a revised quotation including freight and insurance."}'
# → 200 {"summary":"• A revised quotation is requested.\n• Freight costs must be included.\n• Insurance costs must also be included.","cached":false}
```

**Observed vs expected** — the Gemini backend works perfectly (second call). The client and server simply disagree on the request shape.

**Where**
- `client/src/pages/EmailInbox.jsx:697` — `api.post('/ai/summarize-email', { emailId })`, with a comment explaining that only the id travels to avoid a 413.
- `server/controllers/aiController.js:98-102` — `const { subject, from, body } = req.body;` then `if (!body && !subject) return res.status(400)...`. It never loads the email by id.

The sibling endpoint `POST /api/ai/extract-actions` **does** accept `{ emailId }` and works end-to-end (verified: it returned a correct suggestion with `Confidence 100%` from `gemini-2.5-flash`). `summarizeEmail` needs the same `loadExtractionSource`-style lookup.

---

#### H-3 — Inbox category tabs are decorative: Sent, Promotions, Social, Updates and Spam all show the Inbox

**Severity:** High. Five of the six tabs lie, and the "Sent" tab presents **received** mail with a "Received" timestamp column.

**Reproduction (UI)**
1. Sign in as Admin, open **Inbox**. The Inbox tab reads **1,397**.
2. Click **Sent**. The tab still reads **1,397** and the rows are byte-identical to the Inbox rows ("Neha Bhatt", "Priya Dave", …), still labelled *Received*.
3. Same for Promotions, Social, Updates, Spam.

**Reproduction (API)**
```bash
for c in inbox sent promotions social updates spam; do
  curl -s "http://127.0.0.1:5015/api/gmail/emails?page=1&limit=2&category=$c" \
    -H "Authorization: Bearer $ADMIN" | python3 -c "import sys,json;d=json.load(sys.stdin);
print('$c', d['pagination']['total'], d['data'][0]['direction'])"
done
```
**Observed:** `inbox 1397 inbound`, `sent 1397 inbound`, `promotions 1397 inbound`, `social 1397 inbound`, `updates 1397 inbound`, `spam 1397 inbound`. Reproduced identically as `ops.head@` (250 for every category).
**Expected:** Sent should list the 599 `direction: "outbound"` rows the database holds; the Gmail category tabs should filter by category or not be shown.

**Where** — the client sends the parameter (`client/src/pages/EmailInbox.jsx:2163`, `category: view.tab`), and `getEmails` never reads it: `server/controllers/gmailController.js:1128-1210` handles `group`, `direction`, `status`, `approvalStatus`, `accountEmail`, `read`, `dateFrom/dateTo`, `from` and `q` — there is no `category` branch anywhere in the file (`grep -n category server/controllers/gmailController.js` returns nothing). Note the "Sent" case is not even a category question: the default filter is `direction: { $ne: 'outbound' }` (`gmailController.js:1151`), so Sent needs `direction=outbound`.

---

#### H-4 — A Head's dashboard and Reports task totals contradict their own Tasks page

**Severity:** High. This is the "plausible wrong number" case. Nothing errors; a manager simply reads a smaller number than the one their task list will show them thirty seconds later.

**Reproduction (`head@demo.test`)**
1. Dashboard → **OPEN TASKS 6 · "Across the office"**, **OVERDUE 16 · "Across the office"**.
2. Reports → Overview → **TASKS 48**, **COMPLETED 26 (54% of all tasks)**, **OVERDUE 16**.
3. Go to `/tasks` → footer reads **"Showing 1–25 of 55 tasks"**.
4. Go to `/tasks?status=Late` → **"Showing 1–17 of 17 tasks"**.
5. Go to `/tasks?status=Pending` → **"Showing 1–7 of 7 tasks"**.

**Reproduction (`ops.head@demo.test`)** — same defect, different numbers: Dashboard **OPEN TASKS 16 / OVERDUE 23**, Reports **TASKS 85**; `/tasks` shows **94** total and `/tasks?status=Late` shows **24**.

**Independent re-derivation (mongosh):**
```js
const h = ObjectId("6a6f81a7d27c19bd28c48f4a");            // Priya Nair, head@
db.tasks.countDocuments({createdBy: h})                     // 48   <- dashboard/Reports
db.tasks.countDocuments({$or:[{createdBy:h},{assignedTo:h}]}) // 55 <- Tasks page
db.tasks.countDocuments({createdBy:h, status:"Pending"})    // 6    vs 7
db.tasks.countDocuments({createdBy:h, status:"Late"})       // 16   vs 17
```

**Observed vs expected** — two different definitions of "a Head's tasks" ship in the same product. Expected: one scope, used everywhere.

**Where**
- `server/controllers/reportsController.js:163-167` — `getOverallStats` sets `taskQuery.createdBy = toObjectId(req.user._id)` for a Head. Created-by only.
- `server/controllers/taskController.js:204-206` — `getAllTasks` sets `filter.$or = [{ createdBy: req.user._id }, { assignedTo: req.user._id }]`.

Note `getClientStats` uses a *third* rule (the correct `createdBy OR assignedTo`), which is why the Reports page shows three mutually inconsistent task totals for one Head at once (48 in the tile, 42 as the sum of the client table, 55 on the Tasks page).

---

#### H-5 — Client analytics silently drop 17% of tasks and 15% of email, on the same screen as the totals they contradict

**Severity:** High. Client-level reporting is the thing an owner will price work from.

**Reproduction — one screen, two contradictory numbers**
1. Sign in as Admin → **Reports → Clients**.
2. The tiles at the top of that same page read **EMAILS 1,397**, **TASKS 427**, **COMPLETED 224**.
3. Sum the table's own columns (25 rows, all on one page): **Emails 1,185**, **Tasks 353**, **Completed 186**.

The same shortfall appears on the **Clients** page: its *Total tasks* column also sums to 353 and its *Emails* column to 1,185.

**Independent re-derivation (mongosh) — the cause is unmatched `clientName` strings:**
```js
const names = new Set(db.clients.find({},{name:1}).toArray().map(c=>String(c.name||"").toLowerCase()));
const rows  = db.tasks.aggregate([{$group:{_id:{$toLower:{$ifNull:["$clientName",""]}},n:{$sum:1}}}]).toArray();
let m=0,o=[]; rows.forEach(r=> names.has(r._id) ? m+=r.n : o.push(r._id+"="+r.n));
print("matched="+m+" total="+db.tasks.countDocuments({})+" orphans="+JSON.stringify(o));
// matched=353 total=427 orphans=["zenith verification co=1","=70","unassigned=3"]
```
74 of 427 tasks belong to no client at all — 70 with an empty `clientName`, 3 with the literal string `"unassigned"`, and 1 with a client name (`Zenith Verification Co`) that simply does not exist in the `clients` collection.

**Root cause is reachable through the public API** — nothing validates `clientName` against `Client`:
```bash
curl -X POST http://127.0.0.1:5015/api/tasks -H "Authorization: Bearer $HEAD" \
  -H 'Content-Type: application/json' \
  -d '{"title":"probe","clientName":"No Such Client At All",
       "assignedTo":"6a6f81a7d27c19bd28c48f4b","deadline":"2026-09-01T00:00:00Z"}'
# → 201 Created
```
`createTaskSchema` (`server/middleware/schemas.js:118-119`) only requires a 1–200 character string.

**Where** — the join is a lowercased *name string*, not a foreign key: `server/controllers/reportsController.js:405-406` (`const key = String(client.name || '').toLowerCase(); const tasks = taskCounts[key] || {total:0, completed:0}`) fed by `server/utils/clientService.js:83` (`_id: { $toLower: { $ifNull: ['$clientName',''] } }`).

**Expected** — either reject an unknown client at write time, or key tasks to a `clientId`, and show an explicit "Unattributed" row so the columns reconcile with the tiles.

---

#### H-6 — The Tasks "All creators" filter does nothing

**Severity:** High for anyone using it to answer "what did this Head delegate?" — it returns the whole workspace and looks like an answer.

**Reproduction (UI)**
1. As Admin, open `/tasks?creator=6a6f81a7d27c19bd28c48f4a` (Priya Nair). The filter chip reads **"Priya Nair"** and a **Clear filters** button appears, so the UI believes the filter is on.
2. Footer: **"Showing 1–25 of 430 tasks"** — i.e. every task in the workspace. Priya Nair created 48.

**Reproduction (API)**
```bash
curl -s "…/api/tasks?page=1&limit=1" -H "Authorization: Bearer $ADMIN"                          # total 426
curl -s "…/api/tasks?page=1&limit=1&createdBy=6a6f81a7d27c19bd28c48f4a" -H "…"                  # total 426
```
```js
db.tasks.countDocuments({createdBy: ObjectId("6a6f81a7d27c19bd28c48f4a")})  // 48
```

**Where** — `client/src/pages/TaskList.jsx:1752` sends `createdBy: query.creator`; `getAllTasks` (`server/controllers/taskController.js:199-226`) reads `status`, `priority`, `assignedTo`, `clientName` and `q` — `grep -n "query.createdBy" server/controllers/taskController.js` returns nothing.

**Secondary:** the creator dropdown is populated from the whole user list, so it offers ten Employees who have created zero tasks (only the Admin and the two Heads ever create tasks).

---

#### H-7 — The Calendar shows empty months: it only ever loads the newest 100 tasks and never refetches

**Severity:** High. A user paging back one month is shown "nothing scheduled" when 104 tasks are due.

**Reproduction**
1. As Admin, open **Tasks → Calendar**. August 2026 renders correctly, with today (10 Aug) highlighted.
2. Click **‹ Previous month**.
3. **July 2026 renders completely blank** — every cell empty.

**Independent re-derivation:**
```js
db.tasks.countDocuments({deadline:{$gte:ISODate("2026-07-01"),$lt:ISODate("2026-08-01")}})  // 104
db.tasks.countDocuments({deadline:{$gte:ISODate("2026-06-01"),$lt:ISODate("2026-07-01")}})  //  96
```
Task deadlines in the seed span 2026-05-07 → 2026-08-24, so June and July are genuinely full.

**Network evidence** — changing month fires **no request at all**. The page issues exactly one call for the whole calendar:
```
GET /api/tasks?page=1&limit=100&sort=-createdAt → 200
```

**Where** — `client/src/pages/TaskList.jsx:1744-1757` builds `requestParams` from filters only; the calendar's current month is local component state and never enters the query. `WIDE_VIEW_LIMIT = 100` at `client/src/pages/TaskList.jsx:106`. The calendar needs a `deadline` range parameter tied to the visible month (and the server needs to accept one).

---

#### H-8 — Rate limits are per-IP and far too low for an office behind one public IP

**Severity:** High as a deployment defect. Every member of staff in one office shares a single NAT address, so these are effectively *office-wide* budgets.

**Verified configuration** (`server/index.js:57-72`, applied at `:123-126`):
```
app.use('/api', generalLimiter)          // 300 requests / 15 min / IP
app.use('/api/auth/login',    authLimiter)  //  10 requests / 15 min / IP
app.use('/api/auth/register', authLimiter)
app.use('/api/auth/forgot-password', authLimiter)
```
Response headers confirm it live: `RateLimit-Policy: 300;w=900`.

**Measured cost of one page** — a single Dashboard load issues **11 counted API requests** (measured with `performance.getEntriesByType('resource')`: `/api/tasks` ×4, plus `notifications`, `notifications/unread-count`, `reports/overall`, `reports/sla`, `gmail/status`, `keyword-rules/pending-approvals`, `auth/me`). CORS preflights are *not* counted (verified: an `OPTIONS` request does not decrement `RateLimit-Remaining`).

**Consequence:** 300 ÷ 11 ≈ **27 dashboard loads per 15 minutes for the entire office**, before anyone opens the Inbox or Tasks. And **10 sign-ins per 15 minutes for the entire office** — a 15-person firm cannot all log in on Monday morning; the eleventh person gets *"Too many authentication attempts from this IP"* and so does everyone after them.

I hit this myself mid-audit: an ordinary `GET /api/tasks?page=1&limit=1` returned **429** after routine use.

**Expected** — key the general limiter on the authenticated user id rather than the IP (fall back to IP only when unauthenticated), raise the defaults substantially, and document them in `docs/DEPLOY-WINDOWS.md`, which currently does not mention rate limiting at all.

---

#### H-9 — `POST /api/clients` is unvalidated and returns raw JavaScript error text

**Severity:** High. An unvalidated write endpoint that 500s and leaks internals.

**Reproduction**
```bash
curl -s -X POST http://127.0.0.1:5015/api/clients -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"name":[]}'
# → 500 {"success":false,"message":"name.trim is not a function"}
```
Also reproduced with `{"name":{}}`, and with `{"name":"…","associatedEmails":[123]}` → `500 {"message":"e.trim is not a function"}`. A 5,000-character client name returns **201 Created** (no maximum length, unlike `createUserSchema`, which caps names at 120).

**Observed vs expected** — 500 with an internal `TypeError` message; expected 400 with field-level detail.

**Where** — `server/routes/clientRoutes.js:19` attaches no `validate()` middleware, and `server/controllers/clientController.js:158-161` only checks `if (!name)` before calling `name.trim()`.

*(Note: the UI itself is safe — the New client dialog validates inline and shows a clean "Client with this name already exists" banner on a duplicate. This is an API-surface defect.)*

---

#### H-10 — Seven endpoints return 500 on a malformed ObjectId

**Severity:** High-Medium. A Mongoose `CastError` escapes to the generic catch, so a mistyped URL is an internal error rather than a 400/404.

**Reproduction**
```bash
for p in /api/tasks/notanoid /api/users/notanoid /api/gmail/emails/notanoid; do
  curl -s -o /dev/null -w "$p → %{http_code}\n" "http://127.0.0.1:5015$p" -H "Authorization: Bearer $ADMIN"
done
# /api/tasks/notanoid → 500
# /api/users/notanoid → 500
# /api/gmail/emails/notanoid → 500
```
Also confirmed on `PUT /api/notifications/:id/read`, `GET /api/tasks/:id/comments`, `DELETE /api/keyword-rules/:id`, `DELETE /api/clients/:id`. `.dev-logs/api.log` shows `Cast to ObjectId failed for value "notanoid"`.

**Control:** a *valid but non-existent* id returns a clean 404 on all of these, so the defect is specifically the cast path.

**Where** — catch sites at `taskController.js:281`, `userController.js:111`, `notificationController.js:75`, `commentController.js:54`, `gmailController.js:1459`, `keywordRuleController.js:359`, `clientController.js:306`. The correct pattern already exists in this codebase: `clientController.js:154-156` validates the id and returns `400 {"message":"Invalid client ID"}`.

---

### MEDIUM

---

#### M-1 — New-task validation errors never clear as the user fixes each field

**Reproduction**
1. Tasks → **New task** → click **Create task** with everything blank. Four inline errors appear correctly (*A title is required. / A client name is required. / Choose who this task is for. / A deadline is required.*) — good.
2. Now fill every field properly: type a title, pick **Northline Logistics** in the Client combobox (click, type, Enter), pick **Ravi Kumar** as Assignee the same way, set a deadline.

**Observed** — all four fields are filled and correct, yet **all four error messages and all four red borders remain**. Screenshot evidence: the dialog shows `Title = "AUDIT double submit probe"`, `Client = Northline Logistics`, `Assignee = Ravi Kumar`, `Deadline = 20/08/2026, 10:00 AM`, and still reads *"A title is required."* under the filled title box.
**Expected** — each field's error clears on change/blur once valid. As it stands the form looks permanently broken and a cautious user will not press the button.

*(The dialog otherwise behaves: the combobox finds records and offers a "Create «…»" path, and **double-clicking Create task submits exactly once** — verified, one `POST /api/tasks → 201` in the network log and exactly one matching document in Mongo.)*

---

#### M-2 — Board column counts read as workspace totals but describe only the newest 100 tasks

**Reproduction** — Admin → Tasks → **Board**. Columns show **Pending 14 · Completed 39 · Late 47** (= 100). The dashboard on the previous screen says **76 open / 127 overdue**, and the database holds Pending 77 / Completed 224 / Late 126.

The page does show an honest banner — *"Showing the first 100 tasks — 427 tasks match these filters"* — but the count chips sit on the column headers where every kanban board in existence puts a total, and they are the numbers a manager will read and repeat.

**Expected** — label the chips as "of the 100 loaded", or fetch true per-status counts. Network evidence: `GET /api/tasks?page=1&limit=100&sort=-createdAt` (`client/src/pages/TaskList.jsx:106`).

---

#### M-3 — The Reports date-range selector does not control two of the three panels it sits above

**Reproduction** — Admin → Reports → **Employee performance**. Choose **Last 14 days**, then **Last 365 days**, watching the network tab.

| Selector | Request actually made |
|---|---|
| Last 7 days | `/api/reports/employee?filter=weekly` (7 d) |
| Last 14 days | `/api/reports/employee?filter=**monthly**` (30 d) |
| Last 30/60/90/180/365 days | `/api/reports/employee?filter=**monthly**` (30 d) |

The chart's own subtitle keeps saying *"Tasks assigned in the last 30 days"* while the control says *Last 365 days*, and the data is byte-identical across five of the seven options. Separately, **`/api/reports/timeline`** (the Overview "Task throughput" chart) is fetched **once with no range parameter at all** and never refetched — it is permanently 30 days regardless of the selector.

**Expected** — either the endpoint accepts a day count, or the selector only offers the ranges it can honour.

**Also on this tab:** the "Workload by person" chart renders ~11 bars but only **6** Y-axis name labels (Recharts tick auto-skip), so five bars cannot be attributed to a person, and two labelled rows ("Harsh Vora", "Kiran Joshi") sit next to no bar at all. Mitigated by the full **Performance log** table below it, which lists all 14 rows correctly — hence Medium, not High.

---

#### M-4 — The Clients table gives the client *name* 76 px and the email address 198 px

**Reproduction** — Admin → **Clients** at a 1280 px viewport. Every name is truncated to roughly seven characters: *Northl… / Coast… / Zenith… / Ridge… / Quart… / Kaveri… / Orchi… / Sapph… / Nimb… / Gang… / Verte… / Eastp…*

**Measured** (`getBoundingClientRect` on the header cells): `Client 76px`, `Primary email 198px`, `Addresses 102`, `Open tasks 100`, `Total tasks 103`, `Emails 90`, `Status 103`, `Created 121`, `Actions 87`. The name cell's `scrollWidth` equals its `clientWidth` (76) — the text is hard-truncated, not scrollable.

**Expected** — the identifying column should be the widest, not the narrowest. Note the same data renders fine on **Reports → Clients**, so this is purely the column sizing on `ClientList`.

---

#### M-5 — At 375 px the Dashboard cards are 482 px wide, forcing the page to scroll sideways

**Reproduction** — resize to 375 × 812, sign in as any role, open `/dashboard`, scroll down to "Needs attention".

**Measured:**
```
viewport clientWidth        375
"Needs attention" card       482   (also "Recent activity", "Mail queue")
inner <table>                480
main scrollWidth             506   (main is the horizontal scroller)
```
The card's table wrapper does have `overflow-x: auto`, but the card itself is allowed to grow to the table's min-content width instead of the wrapper scrolling — so the *page* scrolls instead of the table. The **Mine / Everyone** toggle inside "Needs attention" is off-screen until the user side-scrolls, which drags the whole layout with it.

**Where** — `client/src/pages/Dashboard.jsx:523-525`: `<div className="grid gap-5 xl:grid-cols-3"><div className="space-y-5 xl:col-span-2">` — neither track carries `min-w-0`, so the grid item takes its intrinsic min-content width.

*(The stat-tile grid above it collapses to two columns correctly and looks good. This is specifically the lower panel row.)*

---

#### M-6 — SLA medians are wrong whenever the sample size is even

`$median` and `$percentile` are called with `method: 'approximate'` (`server/controllers/reportsController.js:580`, `:849`, `:918`). **Verified in the source**; MongoDB's approximate method returns the **lower** of the two middle data points rather than interpolating between them, so any even-sized sample is reported low.

**Verified (I re-ran these):** `GET /api/reports/sla` as `ops.head@` returns `resolution {median: 6660, p90: 11220, max: 11220, count: 8, breachCount: 8}` and `firstResponse {median: 2220, …, count: 24}`. Both sample sizes are **even**, so both medians are affected.

**Likely (not independently re-derived by me — reported by a second API/Mongo pass):** the exact medians and the size of the error.

| Metric | API reports | Exact | Error |
|---|---|---|---|
| `head@` firstResponse.median | 2100 | 2160 | −60 min |
| `ops.head@` firstResponse.median | 2220 | 2250 | −30 min |
| Admin resolution.median | 6480 | 6570 | −90 min |
| **`ops.head@` resolution.median** | **6660** | **7350** | **−690 min (−9.4%)** |

with the `ops.head@` resolution sample given as `n = 8`: `[1800, 3060, 6480, 6660, 8040, 9000, 10200, 11220]` → true median `(6660 + 8040) / 2 = 7350`. Admin's first-response median agrees only because `n = 115` is odd. Every `count`, `breachCount`, `breachRate`, `max` and `p90` checked was **correct** — the median alone is off, and it is rendered to 0.1-minute precision, implying an exactness it does not have.

---

#### M-7 — `POST /api/tasks/bulk` reports a delete count it did not perform

```bash
docker exec maildesk-mongo mongosh maildesk_run --quiet --eval 'print(db.tasks.countDocuments({}))'   # 427
curl -s -X POST http://127.0.0.1:5015/api/tasks/bulk -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"delete","taskIds":["0123456789abcdef01234567"]}'   # id that does not exist
# → {"message":"Bulk action completed.","result":{"deleted":1}}
docker exec maildesk-mongo mongosh maildesk_run --quiet --eval 'print(db.tasks.countDocuments({}))'   # 427
```
Nothing was deleted; the API says one row was.
**Where** — `server/controllers/taskController.js:610`: `result = { deleted: taskIds.length }` uses the *requested* ids, not the matched ones. Expected `deleted: 0`. (The ownership gate itself is sound — a Head correctly gets 403 on a mixed-ownership batch.)

---

#### M-8 — A Head's SLA "Resolution" panel is structurally always empty

`resolveSlaScope` (`server/controllers/reportsController.js:556`) sets `taskScope = { createdBy: userId }` for a Head. For `head@`:
```js
db.tasks.countDocuments({createdBy: HEAD, status:"Completed", linkedEmail:{$ne:null}})  // 0
```
so `resolution` is permanently `{median: null, count: 0}`. Widening to the `createdBy OR assignedTo` rule that `/api/tasks` uses still yields 0 in this dataset, so the seed is also thin here — but it is the same scope inconsistency as H-4 and will bite once real data arrives.

---

#### M-9 — Client timeline `counts` is capped by `limit`, so it reads as a total but is not

```bash
GET /api/clients/6a6f82dea3951a6e5dd8ed57/timeline            → counts {tasks:20, emails:20}
GET /api/clients/6a6f82dea3951a6e5dd8ed57/timeline?limit=100  → counts {tasks:24, emails:55}
```
Mongo truth for Zenith Textiles: **24 tasks, 77 emails**. So the default view reports 20/20, the `limit=100` view reports 24/55, and neither is the real email figure — the number simply tracks whatever `limit` was passed. **Where** — `server/controllers/clientController.js:142`: `counts: { tasks: tasks.length, emails: emails.length }`, computed after each side has already been `.limit(limit)`-ed. Expected a real `countDocuments`, or a different field name.

---

#### M-10 — Pending and Rejected accounts are counted as staff

The Reports **PEOPLE** tile reads **15**. The database holds 11 Approved, 3 Pending and 1 **Rejected** account. The **Performance log** table on Employee performance likewise lists `Harsh Vora (pending1.harsh@)`, `Ishita Rao (pending2.ishita@)`, `Jay Thakkar (pending3.jay@)` and `Kiran Joshi (rejected1.kiran@)` as staff with `0 assigned / 0%` completion — so a manager scanning the list sees five people apparently doing nothing, one of whom was refused access. The same four appear in the "Employee scope" filter dropdown.

---

#### M-11 — Tab strips do not wrap or scroll at 375 px, so the page scrolls sideways and tabs go off-screen

**Reproduction** — 375 × 812, open `/inbox`. The category tab strip measures **460 px** in a 375 px viewport, making `main` 484 px wide. **"Updates" and "Spam" are off-screen.** Reaching them requires horizontally scrolling the whole page, which drags the *Sync now* button, the search box and all three filter dropdowns off the left edge. The Reports tab strip does the same ("Clients" is cut to "Cl…").

**Where** — `client/src/components/ui/Tabs.jsx:18-25`: `TabsList` is `flex items-center gap-1 border-b border-line` with no `overflow-x-auto` and no wrap.

---

#### M-12 — Inconsistent role gates on two URLs for the same operation

`POST /api/clients` admits a Head (201). `POST /api/tasks/clients` is Admin-only (403 for a Head). Same operation, two different answers depending on which URL the client happens to call.

---

#### M-13 — Error bodies outside the Zod-validated routes carry no field-level detail

Zod routes are good — `{message, errors:[{path,message}]}`. But:
- `POST /api/clients` → `{"success":false,"message":"Client name is required"}` — a different envelope, never an `errors[]`.
- Duplicate-key errors have no path at all: `POST /api/users` → `"User with this email already exists."`; `PUT /api/users/:id` → `"Email address is already in use by another user."`; `POST /api/clients` → `"Client with this name already exists"`.

A client cannot attach any of these to an input. Also, `validate.js:22` sets the headline `message` to `issues[0].message`, so an empty `POST /api/tasks` leads with the unusable *"Invalid input: expected string, received undefined"* (the useful detail is in `errors[]`).

Related: `PUT /api/users/:id` with `{}` returns **200** and the unchanged user — every field in `updateUserSchema` is optional, so a malformed edit is a silent no-op write.

---

### LOW

- **L-1 — "Task status" card heading is clipped** on Reports → Overview at 1280 px (`clientWidth 61` vs `scrollWidth 77`, class `truncate text-base font-semibold`), rendering as *"Task s…"*, with its description squeezed into a three-line column beside the legend.
- **L-2 — The empty-state CTA is clipped inside the table scroller.** Filter the Inbox to a term with no matches: *"No emails match these filters"* is clear and helpful, but its **Clear filters** button sits at y 596–628 inside a container whose visible area ends at ~600, so only ~4 px of it shows. Reachable by scrolling the inner container, and duplicated in the filter bar — hence Low.
- **L-3 — Password minimum is 6 characters** (`server/middleware/schemas.js:31, 46, 53, 90`), and the show/hide eye toggle appears on *Current password* but not on *New password* or *Confirm new password*.
- **L-4 — Plaintext OAuth refresh tokens at rest.** `.dev-logs/api.log` carries eight `[CRYPTO] Encountered an unencrypted legacy token. Run scripts/encryptExistingTokens.js, then set ALLOW_LEGACY_PLAINTEXT_TOKENS=false` warnings. The remediation script exists and has not been run.
- **L-5 — The Redis-backed rate-limit store fails to initialise on boot:** `express-rate-limit: async error during store initialization. Error: Stream isn't writeable and enableOfflineQueue options is false` ×2 (`server/index.js:57` and `:66`). The limiter silently falls back to per-process in-memory counting, which under PM2 clustering means N× the intended budget and no shared state.
- **L-6 — Mongoose deprecation warning:** `the 'new' option for findOneAndUpdate() is deprecated`, from `updateSlaPolicyConfig` (`server/controllers/reportsController.js:1042`).
- **L-7 — `DELETE /api/gmail/linked-account` with another Head's `userId` returns 200** while silently ignoring the `userId` (verified: the other Head's `gmailEmail` and refresh token were untouched). Not a vulnerability, but a misleading success for a forbidden target; 403 would be honest.
- **L-8 — `Client.estimatedDocumentCount()` backs the "Clients" tile** (`server/controllers/reportsController.js:197`). It is exact today (25 = 25 = `/api/clients` total for every role) — **no disagreement reproduced** — but it is a metadata read that drifts after an unclean shutdown, and unlike every other tile it is neither filtered nor role-scoped.
- **L-9 — `/admin/*` redirects silently.** An Employee opening `/admin/users` or `/reports` lands on `/dashboard` with no explanation. Safe, but a bookmarked or emailed link just appears to do nothing. Compare `/inbox`, which handles the same situation beautifully (see below).

---

## 3. Not defects — but they will surprise the owner

These are all working as built. Each one is the kind of thing that generates a support call on week one.

1. **The top-bar "Search ⌘K" cannot find anything.** It opens a command palette that navigates between pages. Typing a real client name (`Northline`) returns **"No matching commands."** — no emails, tasks or clients are searchable from it. Each list page has its own search box; the global one does not.
2. **Deletion is locked until you export a backup, and the unlock is per-browser.** The Inbox shows *"Deletion is locked — Export a backup of the inbox to unlock single and bulk deletion in this browser"*, and the Delete button in the email drawer is genuinely disabled (`pointer-events: none`). The flag lives in that browser's `localStorage`, so it resets on a new machine, a new profile, or a cleared cache. Deliberate and defensible; entirely non-obvious.
3. **Board and Calendar cap at 100 tasks by design** and say so in a banner. See M-2 and H-7 for where that design leaks.
4. **Read/unread is per-person, not shared.** Stated in the Inbox footer: *"Read and unread are yours alone. This is a shared mailbox, so marking a message read does not change how it looks for anyone else."* Correct for a shared mailbox, and the opposite of what most staff will assume.
5. **Employees cannot open the shared Inbox at all.** `/inbox` renders a genuinely good explanation — *"The shared inbox is limited to Admins and Heads. Your assigned work is on the Tasks screen, with the source email attached to each task."* with a **Go to my tasks** link. Worth mentioning in training so it does not read as a bug.
6. **Assigning a task sends a real email through Brevo.** `.dev-logs/api.log` shows `{"component":"mail","to":"smoke.employee@example.test","subject":"Assigned to you: …","messageId":"<…@smtp-relay.mailin.fr>","msg":"email sent"}`. A live `BREVO_API_KEY` is configured in `server/.env`, so this **demo/dev environment is sending live mail to non-existent `@example.test` domains**. That accrues hard bounces against the sender reputation of whatever domain ships to production. Worth cleaning before go-live.
7. **Charts fade in over ~1.5–3 seconds.** On first paint the Reports bar charts look empty. I initially recorded "Task throughput renders empty" as a defect; re-checking after a 3-second wait showed a fully correct chart. It is the Recharts entry animation, not a bug — but a user on a slow machine will see a blank chart and reload.
8. **Heads *can* see the "Employee performance" tab.** The comment at `client/src/App.jsx:189-192` claims *"The page hides the Admin-only employee-performance tab for Head on its own."* It does not — the tab is visible to `head@` and `ops.head@`, and the server permits it (`authorizeRoles('Admin','Head')` on `/api/reports/employee`). The behaviour is fine and scoped correctly; the comment is stale.
9. **Every Head sees the full user list.** `GET /api/users` admits Heads by design, so a Head can see all 15 accounts including pending registrations. Intentional (they need an assignee picker), but it is more than "their own team".
10. **Reports is honestly labelled for Heads** — the page subtitle changes to *"Scoped to the mailboxes and tasks you own."* Good. It does not save H-4, because the number under that label still disagrees with the Tasks page.

---

## 4. What I could not test, and why

| Area | Why not |
|---|---|
| **Live Gmail ingestion** | Every seeded mailbox returns `invalid_grant` — the refresh tokens in the demo data are dead. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` *are* present, so the OAuth connect flow could be re-run with a real Google account, but no valid consent exists here. Only the **failure** path was testable — and it produced H-1. Real message fetching, label mapping, thread stitching from live data, and incremental/historyId sync are all unverified. |
| **Sending a reply** | `POST /api/gmail/emails/:id/reply` goes out through the same dead Gmail credential, and I do not send mail on a user's behalf without explicit approval. The Reply composer opens correctly; the send path is unverified. |
| **Transactional email delivery** | Brevo accepts the messages and returns message ids (see §3.6), so the *send* works. Whether they are delivered, bounced or spam-foldered is outside what I can observe here. |
| **Attachment download** | `GET /api/gmail/emails/:id/attachments/:attachmentId` correctly returns 403 across roles, but the seeded emails carry no real attachment payloads, so the success path is unverified. |
| **AI under failure** | The Gemini key is live and both AI endpoints were exercised (extraction end-to-end; summarisation via the server's expected payload). The circuit-breaker path (`AI_UNAVAILABLE`), the 202-poll path for slow models, and the 503 "not configured" path were **not** triggered. |
| **Concurrency / realtime** | Single browser session throughout. Socket.io connect/disconnect was observed in the logs, but two users editing the same task, live notification push, and presence were not tested. |
| **Windows Server deployment** | `docs/DEPLOY-WINDOWS.md` describes a different topology (IIS/PM2, Windows services). Nothing in that path was executed. Note it does not mention rate limiting, which H-8 says it must. |
| **Load and scale** | 2,000 emails and ~430 tasks is a small dataset. Nothing here says how the regex-based inbox search (`gmailController.js:1204-1207`, a deliberate substring `RegExp` rather than a `$text` index) behaves at 200,000 messages. |
| **Backup / restore, upgrade path** | Out of scope for a UI audit; not exercised. |

---

## 5. Audit conditions worth knowing

These affect how you should read the numbers above.

- **A second agent was modifying `server/` and the database throughout.** I watched the total task count move 427 → 437 → 430 → 426 → 427, saw smoke-test rows appear (`Smoke completedAt transitions`, `Pref probe: restored`, …), and saw `Bulk Task Delete` entries by `Priya Nair` in the Activity Log that I did not perform. **The API process was SIGTERM'd and restarted twice mid-audit.** Every figure in this report is paired with a re-derivation taken at the same moment, so the *comparisons* hold even where the absolute numbers have since moved.
- **I created one task and did not delete it:** `AUDIT double submit probe` (client *Northline Logistics*, assignee *Ravi Kumar*, deadline 2026-08-20 10:00 IST, `_id 6a797fb0350cdd0fa5e2373d`). It exists to document the double-submit test in M-1. Delete it when convenient.
- **The browser automation reports a 0 × 0 viewport**, so `elementFromPoint` and any JS geometry taken immediately after navigation are unreliable. Every measurement quoted here was taken after layout had settled and cross-checked against a screenshot; `location.port` and `location.pathname` were asserted inside each measurement script.
- **Provenance of each finding.** Everything in the HIGH section, plus **M-1 – M-5**, **M-7**, **M-9**, **M-10**, **M-11**, **L-1**, **L-2** and **L-3**, I reproduced myself with the exact commands and screenshots quoted. **M-6**, **M-8**, **M-12**, **M-13** and **L-4 – L-8** come from a second, API-and-Mongo-only pass over the same running system; I independently re-confirmed the *observable* half of each (the API responses, the source lines, the log entries) but did not re-derive every exact comparison figure — those are flagged inline where it matters. Nothing here is asserted from code-reading alone except where explicitly labelled.
- **One finding I initially recorded and then withdrew:** clicking a row checkbox appeared to scroll the whole app shell (header at `y = -139`, sidebar at `y = -91`). Re-testing with the product's own documented keyboard path (`j` to move, `x` to select) showed the shell stays put and the **table** scrolls correctly — the earlier result was the automation's `scrollIntoView` interacting with the 0 × 0 viewport, not a product defect. **Scroll containment works.** I mention it because it is exactly the false positive this audit was warned about.

---

## 6. Suggested order of work

1. **H-1** (silent sync failure) — highest consequence, and the fix is a surfaced error state, not a redesign.
2. **H-4** + **H-5** (task scope and client attribution) — one shared root cause each; fix the scope rule once and use it everywhere, and make `clientName` a foreign key.
3. **H-2** (AI summarise) — a one-line contract fix; the backend already works.
4. **H-8** (rate limits) — a deployment-blocking configuration change, cheap to make.
5. **H-3**, **H-6**, **H-7** — three filters/views that silently ignore their input.
6. **H-9**, **H-10** — API hardening; both have an existing correct pattern elsewhere in the codebase to copy.
7. **M-1**, **M-2**, **M-3** — the three places where the UI misrepresents what it is showing.
8. The rest, in severity order.
