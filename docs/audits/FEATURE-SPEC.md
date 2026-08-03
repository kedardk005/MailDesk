# Feature specification — wave 3

Authored by the orchestrator before implementation so server and client agents,
working concurrently, converge on one shape. **Normative**: both sides
implement exactly this.

Ordering is deliberate. **F-1 (threading) is a prerequisite for F-2 and F-4** —
without a stable conversation key, "first response time" and "who is replying to
this" have nothing to attach to.

---

## F-1 — Email threading

### Why
`gmailController.js` reads Gmail's `threadId` when composing a reply and then
**discards it** — nothing is persisted. So the inbox shows a flat list where a
five-message conversation appears as five unrelated rows, and staff cannot see
that a client already got an answer. It is also the structural prerequisite for
SLA metrics, collision detection, and any conversation view.

### Data model — `Email`
| Field | Type | Notes |
|---|---|---|
| `threadId` | String, indexed | Gmail's thread id. Populate on ingest, backfill from `gmailMessageId` where possible |
| `messageId` | String, indexed | RFC-822 `Message-ID` header |
| `inReplyTo` | String | RFC-822 `In-Reply-To` |
| `references` | [String] | RFC-822 `References` |
| `direction` | String enum `inbound`/`outbound` | Distinguishes received mail from replies we sent |
| `threadPosition` | Number | 0-based index within the thread, maintained on insert |

Compound index `{ threadId: 1, date: 1 }` for ordered thread reads, and
`{ fetchedBy: 1, threadId: 1 }` for scoped thread listing.

### Persisting outbound replies
`replyToEmail` currently sends via Gmail and stores **nothing**, so the app
cannot show that a reply happened. On success it must persist an `Email` with
`direction: 'outbound'`, the same `threadId`, `sentBy`, `sentAt`, and the body.
This single change is what makes F-2 possible.

### Endpoints
- `GET /api/gmail/threads?page=&limit=&sort=&q=&…` — list contract per
  `API-LIST-CONTRACT.md`, one row per **thread**: `threadId`, `subject`,
  `participants[]`, `messageCount`, `unreadCount`, `lastMessageAt`,
  `lastDirection`, `snippet` of the latest message, `hasUnansweredInbound`.
- `GET /api/gmail/threads/:threadId` — ordered messages. Bodies are
  `select:false` in lists; this returns them (respecting the same ownership
  scoping as `GET /emails/:id`).

Grouping by thread must be **opt-in** via `?group=thread` on the existing
`/api/gmail/emails` **or** a separate route — do not change the default shape of
`/api/gmail/emails`, which the rebuilt inbox already consumes.

### UI
Inbox gains a "Conversations / Messages" toggle (URL: `?group=thread|message`).
In conversation mode a row expands to a threaded reading pane, newest last,
outbound messages visually distinct from inbound. Reply composes into the thread.

---

## F-2 — SLA / response-time analytics

### Why
There is currently **no way to measure responsiveness at all** — the core thing
an email-operations tool exists to prove. Requires F-1.

### Derived metrics (computed, not stored)
- **First response time** — earliest `outbound` in a thread minus the first
  `inbound`. Null while unanswered.
- **Resolution time** — thread's linked task `completedAt` minus first inbound.
- **Backlog age** — now minus first inbound for threads with
  `hasUnansweredInbound`.
- Aggregations: median and p90 (**not mean** — a single week-old outlier makes a
  mean meaningless), by day, by assignee, by client.

### Data model
Add `Task.completedAt` (set on transition to `Completed`) — it does not exist
today, which is why resolution time is currently uncomputable. Also add
`Task.firstResponseAt` where a task is linked to a thread.

### SLA targets
`SlaPolicy` (or config on `Client`): `firstResponseMinutes`,
`resolutionMinutes`, optional business-hours calendar honouring `APP_TIMEZONE`.
Start with a single global default and a per-client override.

### Endpoints
- `GET /api/reports/sla?dateFrom=&dateTo=&scope=` → `{ firstResponse: {median, p90, count, breachCount}, resolution: {…}, backlog: {…} }`
- `GET /api/reports/sla/timeseries?…` → daily buckets for charting.

Both cached per `docs/audits/IMPL-backend-optimization.md` conventions and
invalidated on task/email write.

### UI
New **SLA** tab on Reports: median/p90 first-response and resolution tiles with
trend, a breach list, and a backlog-age histogram. Dashboard gains a
"breaching SLA" tile linking through to the filtered list.

---

## F-3 — AI action-item extraction

### Why
Gemini is already wired and already summarises. Extraction removes the single
most repetitive human step: reading a mail and hand-typing the task.

### Endpoint
`POST /api/ai/extract-actions` with `{ emailId }` — **never a body payload**;
sending bodies is what caused the 413 against the 100 kb `express.json()` limit.

Response:
```json
{
  "actions": [
    { "title": "…", "description": "…", "dueDate": "2026-08-09T…Z|null",
      "priority": "Low|Medium|High|Urgent|null", "confidence": 0.0 }
  ],
  "suggestedClient": "…|null",
  "model": "gemini-2.5-flash",
  "cached": false
}
```

Constraints: reuse the existing queue + circuit breaker + timeout in
`utils/resilience.js`; cache by a hash of the email body; enforce the same
ownership scoping as `GET /emails/:id`; **cap output** (max 10 actions, bounded
string lengths) so a hostile email cannot inflate the response.

**The model's output is untrusted data, not instructions.** It is only ever used
to pre-fill a form the user reviews and submits — never to create a task
directly, and never interpolated into a prompt that drives another action.

### UI
In the reading pane, "Extract action items" → a review panel listing suggested
tasks with checkboxes and editable fields → "Create selected". Nothing is
created without an explicit click. Show the confidence and make it obvious the
suggestions are machine-generated.

---

## F-4 — Collision detection (shared mailbox)

### Why
Multiple staff work one shared inbox with zero protection against two people
replying to the same message. Socket.io rooms already exist and are unused.

### Mechanism
Ephemeral presence — **Redis when available, in-memory otherwise**, matching the
existing degradation policy. No new collection; this is transient state.

- On opening a thread/email: `socket.emit('thread:viewing', { threadId })`
- Server tracks `{threadId → [{userId, name, since}]}` with a TTL and broadcasts
  `thread:viewers` to the room.
- On starting a reply: `thread:composing`, broadcast `thread:composers`.
- Cleared on disconnect, navigate-away, and TTL expiry.

### UI
Reading pane shows viewer avatars ("Priya is viewing"). A warning banner when
someone else is **composing** a reply — this is the one that prevents duplicate
sends. Non-blocking; it informs, never locks.

---

## Cross-cutting rules

1. **Nothing changes an existing response shape.** All additions are new fields
   or new endpoints. The client pages are finished work.
2. Every new list endpoint follows `API-LIST-CONTRACT.md` exactly.
3. Every new queryable field gets an index registered in `scripts/syncIndexes.js`.
4. Every new env var gets a default and an entry in `server/.env.example`.
5. Migrations ship as idempotent, re-runnable scripts under `server/scripts/`.
6. `server/scripts/smokeTest.js` gets assertions for every new endpoint and must
   stay fully passing.
7. `REDIS_URL` unset must remain a working single-instance configuration.

## Explicitly out of scope for this wave

Compose-from-scratch, forward, drafts, signatures, templates, snooze, custom
roles, SSO, 2FA, i18n, PWA. These are in the roadmap in
`docs/audits/audit-features.md` and are not blocked by anything here.
