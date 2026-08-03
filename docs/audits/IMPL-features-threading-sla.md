# F-1 (email threading) + F-2 (SLA analytics) — server implementation

Implements `docs/audits/FEATURE-SPEC.md` F-1 and F-2. Every list endpoint here
follows `docs/audits/API-LIST-CONTRACT.md` exactly; the caching, pagination,
resilience and logging primitives are the existing ones from
`docs/audits/IMPL-backend-optimization.md`.

**A client agent builds the UI from this document.** The response shapes below
are exact — they are asserted, field by field, in `server/scripts/smokeTest.js`.

Harness: **225 assertions, all passing**, against MongoDB 7.0 with Redis, and
again with `REDIS_URL` unset. (Baseline before this work: 140.)

---

## READ THIS FIRST IF YOU ARE WRITING A CLIENT PAGE

1. `GET /api/gmail/emails` is **unchanged by default**. Its rows gained new
   fields (`threadId`, `direction`, `threadPosition`, `rfcMessageId`,
   `inReplyTo`, `sentBy`, `sentAt`) and nothing was removed or renamed.
2. Conversation mode is opt-in, two equivalent spellings:
   `GET /api/gmail/threads` **or** `GET /api/gmail/emails?group=thread`.
   Both return the same thread rows and the same pagination envelope.
3. Replies we send are now stored as `Email` rows with
   `direction: 'outbound'`. They are **excluded from the default message list**,
   so the inbox looks exactly as it did. Opt in with
   `?direction=outbound` or `?direction=all`.
4. SLA numbers are **minutes**, as a number with one decimal, or `null` when
   there is nothing to measure. Never render `null` as `0`.
5. Every SLA figure is a **median or p90**. There is no mean anywhere, and
   adding one would defeat the metric.

---

## 1. New model fields

### `Email` (`server/models/Email.js`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `threadId` | String | `null` | Gmail's conversation id. Written at ingest and on every persisted reply. Backfilled for old rows |
| `rfcMessageId` | String | `null` | RFC-822 `Message-ID` header **of this message** |
| `inReplyTo` | String | `null` | RFC-822 `In-Reply-To` |
| `references` | [String] | `[]` | RFC-822 `References`, split into individual ids (max 50) |
| `direction` | String enum `inbound`\|`outbound` | `inbound` | `outbound` = a reply we sent |
| `threadPosition` | Number | `0` | 0-based index within the thread, ordered by `date` |
| `sentBy` | ObjectId → User | `null` | Author of an outbound message |
| `sentAt` | Date | `null` | When we sent it |

> **Deviation from FEATURE-SPEC.md, deliberate.** The spec's field table asks
> for `messageId` to hold the RFC-822 header. `Email.messageId` already existed,
> already held **Gmail's message id**, and is `unique` — the sync's
> de-duplication (`Email.distinct('messageId')` plus
> `insertMany({ordered:false})` skip-on-duplicate) is built on it. Repurposing
> it would have been a silent, unrecoverable data migration. The Gmail id keeps
> its meaning and the RFC header is `rfcMessageId`. Nothing else in the spec
> changed.

New indexes (all registered in `scripts/syncIndexes.js`):

```
{ threadId: 1, date: 1 }                 ordered thread reads + SLA grouping
{ fetchedBy: 1, threadId: 1 }            scoped thread listing
{ deletedAt: 1, threadId: 1, date: 1 }   every read carries the soft-delete prefix
{ deletedAt: 1, direction: 1, date: -1 } the default "not outbound" inbox filter
{ threadId: 1, direction: 1, date: 1 }   the resolution pipeline's inner lookup
{ rfcMessageId: 1 }
```

### `Task` (`server/models/Task.js`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `completedAt` | Date | `null` | Set on the transition **into** `Completed`, cleared on the transition out |
| `firstResponseAt` | Date | `null` | When the first outbound reply went out on the linked thread |

New indexes: `{completedAt:-1}`, `{status:1, completedAt:-1}`,
`{createdBy:1, completedAt:-1}`, `{firstResponseAt:1}`.

`completedAt` write points, all of them:

- `PUT /api/tasks/:id` (Employee path) — stamped by the **same atomic claim**
  that sets the status, so a losing concurrent completion cannot move it.
- `PUT /api/tasks/:id` (Admin/Head path) — set only when the task was not
  already `Completed`; cleared when the status leaves `Completed`.
- `POST /api/tasks/bulk` `action=status` — `completedAt` is stamped first, and
  only on tasks that are not already completed, so a bulk re-apply cannot reset
  the resolution time of tasks finished last week.

### `SlaPolicy` (`server/models/SlaPolicy.js`, new)

```js
{
  scope: 'global' | 'client',
  client: ObjectId | null,            // null on the global row
  firstResponseMinutes: Number|null,  // null = inherit
  resolutionMinutes: Number|null,
  businessHours: {
    enabled: Boolean,                 // default false
    startHour: Number,                // 0..23,  default 9
    endHour: Number,                  // 1..24 exclusive, default 18
    workingDays: [Number],            // ISO 1=Mon..7=Sun, default [1,2,3,4,5]
    timezone: String|null             // null = APP_TIMEZONE
  },
  updatedBy, createdAt, updatedAt
}
```

Unique index `{scope:1, client:1}` — one row per client, and exactly one global
row. Layering, cheapest first: **environment defaults → the `global` row → the
client's row**. A `null` field means inherit, never zero.

---

## 2. F-1 endpoints

### `GET /api/gmail/threads` — conversation list

Also reachable as `GET /api/gmail/emails?group=thread` (identical output).

**Access**: Admin, Head. Same gate as `GET /api/gmail/emails`. An Employee gets
403. Scoping is applied **inside** the aggregation: Admin sees everything, a
Head only `fetchedBy: <self>`, so a Head can never observe another mailbox's
conversation, not even transiently.

**Query**: `page`, `limit` (1–100, clamps), `sort`, `q`, plus

| Param | Values | Meaning |
|---|---|---|
| `sort` | `lastMessageAt`, `firstMessageAt`, `messageCount`, `unreadCount`, `subject` (`-` prefix for desc) | default `-lastMessageAt`; unknown fields fall back silently |
| `q` | string | substring over `subject` and `from` |
| `dateFrom` / `dateTo` | ISO-8601 | inclusive |
| `accountEmail` | address | the mailbox the thread lives on |
| `unanswered` | `true` | only conversations with an unanswered inbound |
| `unread` | `true` | only conversations with `unreadCount > 0` |

`q` and the date range select **messages**, but a row describes a whole
**conversation**. They are therefore resolved to a thread-id set first, and the
counters are then computed over every message in those threads — so searching
"Charlie" still reports `messageCount: 2`, not `1`. That resolution is capped at
`THREAD_MATCH_CAP` (2000) thread ids.

**Response** (paginated form, when `page` is present):

```json
{
  "data": [
    {
      "threadId": "18f3c0a1b2c3d4e5",
      "subject": "Re: Invoice 4471",
      "participants": ["Priya <priya@client.test>", "ops@ourfirm.test"],
      "messageCount": 5,
      "inboundCount": 3,
      "outboundCount": 2,
      "unreadCount": 1,
      "firstMessageAt": "2026-08-01T09:12:00.000Z",
      "lastMessageAt": "2026-08-02T14:30:00.000Z",
      "firstInboundAt": "2026-08-01T09:12:00.000Z",
      "lastInboundAt": "2026-08-02T14:30:00.000Z",
      "firstOutboundAt": "2026-08-01T11:02:00.000Z",
      "lastOutboundAt": "2026-08-02T09:40:00.000Z",
      "lastDirection": "inbound",
      "snippet": "Thanks — one more question about the…",
      "latestFrom": "Priya <priya@client.test>",
      "latestEmailId": "66ae21f0c0ffee0000000042",
      "clientId": "66ad0011c0ffee0000000007",
      "accountEmail": "ops@ourfirm.test",
      "hasUnansweredInbound": true
    }
  ],
  "pagination": { "page": 1, "limit": 25, "total": 84, "totalPages": 4, "hasMore": true }
}
```

Without `page`: a **bare array** of the same rows, hard-capped at
`LIST_LEGACY_CAP` (200), per the list contract's legacy form.

Notes for the UI:

- **No `body` and no `bodyRaw`, ever.** `snippet` is the preview; bodies come
  from the detail route.
- `unreadCount` is derived for the **requesting user** — read state is a
  per-user relation on a shared mailbox (WAVE2 gap S-16), not a flag.
- `hasUnansweredInbound` is `lastOutboundAt < lastInboundAt` (or no outbound at
  all) — **not** "the newest message is inbound". A thread that received two
  follow-ups after our reply is unanswered; a thread whose newest message is our
  reply is not.
- `subject` is the **newest** message's subject: a conversation is identified by
  what it became.
- `Cache-Control: private, max-age=15, stale-while-revalidate=60`.

### `GET /api/gmail/threads/:threadId` — one conversation, with bodies

**Access**: all roles, `protect` only at the route; authorization is the
**per-message `canAccessEmail` check**, i.e. exactly the rule
`GET /api/gmail/emails/:id` enforces. Unknown thread → **404**. A thread that
exists but that the caller owns no message of → **403**. Only messages the
caller may see are returned.

```json
{
  "threadId": "18f3c0a1b2c3d4e5",
  "subject": "Re: Invoice 4471",
  "participants": ["Priya <priya@client.test>", "ops@ourfirm.test"],
  "accountEmail": "ops@ourfirm.test",
  "clientId": "66ad0011c0ffee0000000007",
  "messageCount": 5,
  "inboundCount": 3,
  "outboundCount": 2,
  "unreadCount": 1,
  "firstMessageAt": "2026-08-01T09:12:00.000Z",
  "lastMessageAt": "2026-08-02T14:30:00.000Z",
  "firstInboundAt": "2026-08-01T09:12:00.000Z",
  "lastInboundAt": "2026-08-02T14:30:00.000Z",
  "firstOutboundAt": "2026-08-01T11:02:00.000Z",
  "lastOutboundAt": "2026-08-02T09:40:00.000Z",
  "lastDirection": "inbound",
  "hasUnansweredInbound": true,
  "firstResponseAt": "2026-08-01T11:02:00.000Z",
  "firstResponseMinutes": 110,
  "truncated": false,
  "messages": [
    {
      "_id": "66ae21f0c0ffee0000000040",
      "messageId": "18f3c0a1b2c3d4e5",
      "threadId": "18f3c0a1b2c3d4e5",
      "threadPosition": 0,
      "direction": "inbound",
      "rfcMessageId": "<CAF…@mail.gmail.com>",
      "inReplyTo": null,
      "subject": "Invoice 4471",
      "from": "Priya <priya@client.test>",
      "toEmail": "ops@ourfirm.test",
      "date": "2026-08-01T09:12:00.000Z",
      "snippet": "Could you confirm…",
      "body": "<sanitized html>",
      "attachments": [],
      "assignedTo": { "_id": "…", "name": "…", "email": "…" },
      "fetchedBy": { "_id": "…", "name": "…", "email": "…", "gmailEmail": "…" },
      "sentBy": null,
      "sentAt": null,
      "status": "assigned",
      "approvalStatus": "none",
      "labelIds": ["INBOX"],
      "isRead": true,
      "readAt": "2026-08-01T09:30:00.000Z"
    }
  ]
}
```

- `messages` is ordered **oldest first**, so the reading pane renders newest
  last, as the spec's UI section requires.
- Bodies are sanitized on the way out as well as at ingest.
- Capped at `THREAD_MESSAGE_CAP` (200) messages; `truncated: true` says so.
- Opening a thread does **not** mark anything read — marking stays an explicit
  `PATCH`, so a prefetch cannot clear the badge.

### `GET /api/gmail/emails` — additions only

| Param | Values | Meaning |
|---|---|---|
| `group` | `thread` | delegate to the thread list above |
| `direction` | `inbound` \| `outbound` \| `all` | **default: everything except `outbound`** |

Row additions: `threadId`, `direction`, `threadPosition`, `rfcMessageId`,
`inReplyTo`, `sentBy`, `sentAt`. Nothing removed, nothing renamed, default
result set identical to before F-1.

### `POST /api/gmail/emails/:id/reply` — now persists

The handler read Gmail's `threadId` and discarded it, and stored **nothing**
after a successful send. It now writes an `Email` on success:

```
messageId     Gmail's id for the message we sent (unique index holds; a later
              sync of the Sent label cannot duplicate the row)
threadId      from the send response, falling back to the stored thread
direction     'outbound'
from/toEmail  the sending mailbox
sentBy/sentAt the authenticated user, and now
fetchedBy     the ORIGINAL message's owner — this is what keeps a Head's thread
              scoping consistent between a received message and our reply
body/snippet  the reply text, sanitized
readBy        [the author]  — you have read what you wrote
inReplyTo/references  the RFC headers actually sent
```

It then re-derives `threadPosition` for the thread, stamps
`Task.firstResponseAt` on any task linked to that conversation
(`firstResponseAt: null` in the filter makes it first-write-wins), and calls
`cache.invalidateStats()`.

**A persistence failure never fails the request** — the mail has already left.
It is logged at `error` and the response is still `200`.

Response (additive; `message` is unchanged):

```json
{ "message": "Reply sent successfully.",
  "threadId": "18f3c0a1b2c3d4e5",
  "emailId": "66ae21f0c0ffee0000000043",
  "sentAt": "2026-08-02T09:40:00.000Z" }
```

### Places that had to learn about outbound rows

Outbound replies are real `Email` documents now, so every counter that has
always meant "mail received" excludes them explicitly. None of these response
shapes or numbers change:

- `GET /api/reports/overall` (`totalEmails`, `totalUnassignedEmails`)
- `GET /api/reports/email-timeline`
- `utils/clientService.getMailCountsByClient` → the client list's `mailCount`
  and `GET /api/reports/client-stats`
- `GET /api/clients/:id/timeline`
- `keywordRuleController.scopeEmailQuery` — without this a keyword backfill
  could match **our own reply** by subject and queue it for approval.

---

## 3. F-2 endpoints

### `GET /api/reports/sla`

**Access**: Admin, Head. Employee → 403. A Head is **always** scoped to their
own mailbox and their own tasks; `scope` can only narrow further.

| Param | Values | Default |
|---|---|---|
| `dateFrom` / `dateTo` | ISO-8601 | last `SLA_DEFAULT_RANGE_DAYS` (30) days, ending now |
| `scope` | `mine` \| `all` | Admin: `all`; Head: always `mine` |

Range longer than `SLA_MAX_RANGE_DAYS` (366) is clamped, not rejected.

```json
{
  "range": { "dateFrom": "2026-07-03T…Z", "dateTo": "2026-08-02T…Z", "days": 30, "timezone": "Asia/Kolkata" },
  "scope": "all",
  "unit": "minutes",
  "policy": {
    "source": "global",
    "firstResponseMinutes": 240,
    "resolutionMinutes": 1440,
    "businessHours": { "enabled": false, "startHour": 9, "endHour": 18, "workingDays": [1,2,3,4,5], "timezone": "Asia/Kolkata" },
    "clientOverrides": 0
  },
  "firstResponse": { "median": 20, "p90": 300, "max": 300, "count": 3, "breachCount": 1, "breachRate": 0.333, "pendingCount": 1 },
  "resolution":    { "median": 310, "p90": 310, "max": 310, "count": 1, "breachCount": 0, "breachRate": 0 },
  "backlog":       { "median": 400, "p90": 400, "max": 400, "count": 2, "breachCount": 2, "breachRate": 1 },
  "generatedAt": "2026-08-02T…Z"
}
```

Definitions — these are the contract, not an implementation detail:

- **firstResponse** — per thread, earliest `outbound` minus first `inbound`,
  for threads whose **first inbound** falls in the range. A thread with no reply
  yet is **not** a zero-minute response: it is excluded from the percentiles and
  counted in `pendingCount`.
- **resolution** — the linked task's `completedAt` minus the **thread's first
  inbound** (falling back to the linked message's own date for a task whose
  email predates the threading backfill). Only tasks with `completedAt` in range
  and a `linkedEmail` are counted, so a task completed before `completedAt`
  existed and unresolvable by the backfill is simply absent.
- **backlog** — now minus first inbound, for threads with an unanswered inbound.
  `breachCount` uses the **first-response** target.
- `median`/`p90`/`max` are minutes (one decimal) or `null` when `count` is 0.
- `breachRate` is `breachCount / count`, 3 decimals, `0` when `count` is 0.

`source` is `"default"` (environment only) or `"global"` (a `SlaPolicy` row).

### `GET /api/reports/sla/timeseries`

Same access, same `dateFrom`/`dateTo`/`scope`. Daily buckets in `APP_TIMEZONE`,
zero-filled, oldest first, anchored to the **requested range** (not to "today").

```json
{
  "range": { … }, "scope": "mine", "unit": "minutes",
  "buckets": [
    { "date": "2026-07-04", "label": "Jul 4",
      "firstResponseMedian": 18.5, "firstResponseP90": 240, "firstResponseCount": 12, "firstResponseBreachCount": 1,
      "resolutionMedian": null, "resolutionP90": null, "resolutionCount": 0, "resolutionBreachCount": 0 }
  ],
  "generatedAt": "2026-08-02T…Z"
}
```

First-response buckets are keyed by the day the **conversation started**;
resolution buckets by the day the task was **completed**. An empty bucket
reports `null` medians and `0` counts — render the gap, not a zero.

### `GET /api/reports/sla/policy` (Admin, Head)

```json
{
  "default": { "scope": "global", "client": null, "firstResponseMinutes": 240, "resolutionMinutes": 1440,
               "businessHours": { "enabled": false, "startHour": 9, "endHour": 18, "workingDays": [1,2,3,4,5], "timezone": "Asia/Kolkata" } },
  "clientOverrides": [
    { "clientId": "…", "clientName": "Acme", "firstResponseMinutes": 60, "resolutionMinutes": 480,
      "businessHours": { … } }
  ]
}
```

### `PUT /api/reports/sla/policy` (**Admin only**)

Body — at least one of the three; `clientId` absent means the global row:

```json
{ "clientId": "…optional…",
  "firstResponseMinutes": 240,
  "resolutionMinutes": 1440,
  "businessHours": { "enabled": true, "startHour": 9, "endHour": 18, "workingDays": [1,2,3,4,5], "timezone": null } }
```

`200 → { "message": "SLA policy updated.", "policy": { …the saved row… } }`.
`400` for an empty body, a target below 1 minute or above one year, or business
hours that end at or before they start. `404` for an unknown `clientId`. `403`
for a Head. The write drops the cached policy set **and** the whole `report:`
prefix, so a new target changes the breach counts on the very next request.

---

## 4. Percentiles, and why there is no mean

`$median` and `$percentile` (MongoDB **7.0+**, `method: 'approximate'`) run
inside the aggregation. The t-digest is computed by the server in bounded
memory; nothing is materialised into JS.

The rejected alternatives, for the record: a mean is meaningless here (the smoke
test's fixture is 10 / 20 / 300 minutes — mean 110, median 20, and the harness
asserts the endpoint reports ≤ 30), and `$push` + `$sortArray` would build the
whole value set into one 16 MB document, failing at exactly the volume where the
metric starts to matter.

**MongoDB 7.0 is therefore a hard requirement for the SLA endpoints.** The
verified environment is 7.0.39.

### Business hours

Off by default. When enabled, elapsed time counts only working minutes.

`utils/dateHelper.js` already does the zone maths correctly — including an
end-of-day sub-second bug that was found and fixed — so it is **reused, not
reimplemented**: JS enumerates the working windows for the reporting range once
(`utils/slaCalendar.businessWindows`, using `zonedWallClockToUtc`), and the
pipeline sums each interval's overlap with those windows via a `$reduce` over a
literal array. The percentile work still happens entirely in the aggregation.

Verified against a JS reference implementation on MongoDB 7.0, in
`Asia/Kolkata`:

| Interval | Business minutes |
|---|---|
| Mon 09:30 → Mon 11:30 | 120 |
| Mon 17:30 → Tue 09:30 | 60 |
| Fri 17:00 → Mon 10:00 | 120 (weekend skipped) |
| Sat 12:00 → Sun 12:00 | 0 |

The window list extends `SLA_WINDOW_LOOKAHEAD_DAYS` (14) past `dateTo`, so a
reply that lands after the end of the range is still measured.

---

## 5. Caching and invalidation

| Key | TTL | Dropped by |
|---|---|---|
| `report:sla:<from>_<to>:<scope>` | `CACHE_TTL_SLA` (900 s) | any task/email write (`cache.invalidateStats()`), any policy write |
| `report:sla-timeseries:<from>_<to>:<scope>` | 900 s | same |
| `sla:policies` | `CACHE_TTL_SLA_POLICY` (300 s) | `cache.invalidateSlaPolicies()` on every policy write |

`<scope>` is `all` for an Admin asking for everything, and
`<Role>:<userId>` otherwise. **The scope is part of the key.** This codebase has
already been bitten once by a Head's narrowed slice being served to an Admin for
a whole TTL, so the harness asserts it directly: with an identical range and an
identical query string, a Head sees 3 conversations and an Admin asking for
their own slice sees 0.

`<from>_<to>` is minute-truncated; a second-granularity key would make every
request a miss.

The thread endpoints are **not** server-cached (a conversation list must reflect
a reply immediately); they carry
`Cache-Control: private, max-age=15, stale-while-revalidate=60`.

Reply, task-completion and bulk-status writes all call `cache.invalidateStats()`,
which drops the `report:` and `dash:` prefixes.

---

## 6. New environment variables

All have defaults and are documented in `server/.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `THREAD_MESSAGE_CAP` | 200 | Max messages per thread read (this route returns bodies) |
| `THREAD_PARTICIPANT_CAP` | 12 | Max `participants[]` on a thread row |
| `THREAD_MATCH_CAP` | 2000 | Max thread ids resolved by a `q`/date narrowing filter |
| `SLA_FIRST_RESPONSE_MINUTES` | 240 | Default first-response target |
| `SLA_RESOLUTION_MINUTES` | 1440 | Default resolution target |
| `SLA_BUSINESS_HOURS` | `false` | Enable the business-hours calendar |
| `SLA_BUSINESS_START_HOUR` | 9 | |
| `SLA_BUSINESS_END_HOUR` | 18 | Exclusive |
| `SLA_BUSINESS_DAYS` | `1,2,3,4,5` | ISO weekdays, 1 = Monday |
| `SLA_TIMEZONE` | `APP_TIMEZONE` | Zone the calendar resolves in |
| `SLA_DEFAULT_RANGE_DAYS` | 30 | |
| `SLA_MAX_RANGE_DAYS` | 366 | Range clamp (DoS guard, same class as the `?days=` clamp) |
| `SLA_MAX_BUSINESS_WINDOWS` | 500 | Ceiling on windows in one pipeline |
| `SLA_WINDOW_LOOKAHEAD_DAYS` | 14 | Windows enumerated past `dateTo` |
| `CACHE_TTL_SLA` | 900 | |
| `CACHE_TTL_SLA_POLICY` | 300 | |

`REDIS_URL` unset remains a fully working single-instance configuration: the
full 225-assertion suite passes on the in-process LRU cache and the in-process
queue runner.

---

## 7. Migration — run in this order

```bash
cd server

# 1. Build the new indexes. REQUIRED before the backfills, and before the thread
#    or SLA endpoints see production traffic (autoIndex is off in production).
MONGO_URI=... npm run sync-indexes -- --apply

# 2. F-1. Populate threadId + direction, then recompute threadPosition.
#    Dry run first — it prints exactly what it would write.
MONGO_URI=... npm run backfill-threads
MONGO_URI=... npm run backfill-threads -- --apply

# 3. F-2. Best-effort completedAt for tasks completed before the field existed.
MONGO_URI=... npm run backfill-completed-at
MONGO_URI=... npm run backfill-completed-at -- --apply
```

Both scripts are **idempotent**, dry-run by default, batched by `_id` (never
loading a collection into memory) and never select `body`. Re-running is a
no-op.

### What `backfill-threads` does, and what it refuses to do

`direction` → `inbound` wherever missing. Every pre-F-1 row was written by the
sync, which only ever ingested received mail.

`threadId` → the row's own Gmail `messageId` wherever missing. Gmail's thread id
**is** the id of the conversation's first message, so this is exactly right for
a single-message conversation and degrades to "one thread per message" for a
longer one — which is precisely the behaviour the app already had, never a
*wrong* grouping.

It deliberately does **not** reconstruct conversations by normalising subjects.
"Re: Invoice" from two unrelated clients normalises identically, and merging two
clients' mail into one conversation is a far worse defect than leaving them
apart. A `--from-gmail` mode is also not implemented: it would need an OAuth
round-trip per message.

### What `backfill-completed-at` can and cannot recover

`Task` has no `updatedAt` and the status was overwritten in place, so for most
historical rows **the completion instant does not exist anywhere**. The default
strategy (`--strategy=activity-log`) recovers it from the audit trail:
`updateTask` writes `action: 'Task Update'`, `details: 'Updated task "<title>"
(Status: Completed…'`, and the **earliest** such row is the moment the task was
first completed.

Guards: the title must be unique across `Task` (otherwise the row could belong
to a different task — reported as `ambiguous` and skipped), and a candidate
timestamp that predates the task's own `createdAt` is rejected.

Everything else keeps `completedAt: null` **on purpose** and is excluded from
resolution metrics. A fabricated timestamp would appear as a real median and
quietly misreport the exact thing the metric exists to prove. `--strategy=none`
skips the heuristic and only reports the size of the gap.

Verified on seeded legacy rows: 1 resolved from the audit trail, 1 left null.

---

## 8. Two bugs found and fixed while building this

Both are in code this work extends; neither changes a response shape.

1. **`aggregate()` does not cast ids, and `req.user._id` is a string on a cache
   hit.** `req.user` is served from the JSON `user:<id>` cache entry, so
   `_id` is an ObjectId on a miss and a **String** on a hit. `find()` casts;
   `aggregate()` does not. Every Head-scoped aggregation
   (`getEmployeeReport`, `getOverallStats`, `getTaskTimeline`,
   `getEmailTimeline`) therefore matched nothing whenever the cache was warm,
   and reported a clean, empty, wrong report. All now go through
   `threadHelper.toObjectId`. The failure mode was under-reporting, never a data
   leak.
2. **A bare number at the top level of `$project` is an inclusion flag.**
   `{ targetMs: 14400000 }` includes a field that does not exist, so `targetMs`
   came out **missing**, and `<number> $gt missing` is true — every conversation
   was reported as an SLA breach. The constant is now wrapped in `$literal`.
   Caught by the smoke assertion that a 240-minute target yields exactly one
   breach.

---

## 9. Smoke test

`server/scripts/smokeTest.js` — **225 assertions, 0 failures** (140 before).

```bash
# The suite now issues well over generalLimiter's default 300 requests.
MONGO_URI="mongodb://127.0.0.1:27017/maildesk_dev" REDIS_URL="redis://127.0.0.1:6379" \
  RATE_LIMIT_AUTH_MAX=200 RATE_LIMIT_GENERAL_MAX=5000 PORT=5150 node index.js

MONGO_URI="mongodb://127.0.0.1:27017/maildesk_dev" BASE_URL="http://127.0.0.1:5150" npm run test:smoke
```

A 429 on any non-auth route now aborts the run with an explanation instead of
producing a wall of false failures.

The F-1/F-2 fixtures are owned by the **freshly created** Head user, so the
assertions are exact regardless of what else is in the target database — no
pre-existing row can reference a user id created seconds earlier. Everything is
removed afterwards, including the `SlaPolicy` rows.

What the new assertions cover: the thread list contract and envelope, thread row
fields and counters, `hasUnansweredInbound` in both directions, per-user
`unreadCount`, no body in a list row, thread scoping (a Head cannot read another
mailbox's thread; an Admin can), 404 vs 403 vs 401, `?group=thread`,
`?unanswered=`, `?q=` preserving whole-conversation counters, sort fallback and
limit clamp, outbound rows excluded from the default message list and reachable
via `?direction=`, thread detail ordering/bodies/`threadPosition`/`isRead`,
median-not-mean, p90, `pendingCount`, breach counts against the policy, backlog
ageing, resolution from the thread's first inbound, cache invalidation on a task
write and on a policy write, cache **scope isolation**, `completedAt` transition
semantics (set / not moved on re-save / cleared on reopen), the timeseries
bucket shape and its agreement with the summary, and the policy endpoints
including all four validation failures.

---

## 10. Not done, and why

- **No UI.** `client/` is another agent's; nothing under `client/src/pages/**`
  was touched.
- **No `Client`-embedded SLA config.** FEATURE-SPEC.md offers `SlaPolicy` *or*
  config on `Client`; a separate collection keeps `GET /api/clients` unchanged
  and makes the global default a real row rather than a magic client.
- **Per-assignee and per-client SLA breakdowns.** The spec lists "by day, by
  assignee, by client" as aggregations. **By day** ships (the timeseries);
  by-assignee and by-client do not. The grouping key would have to be a thread's
  *current* owner, which is not a stable property of a conversation, and
  by-client needs `Email.clientId` backfilled on the old rows first. The pipeline
  already carries `clientId` through every stage, so adding a `$group` key later
  is a small change.
- **No breach *list* endpoint.** The SLA tab's "breach list" is served by the
  existing thread list: `GET /api/gmail/threads?unanswered=true&sort=-lastMessageAt`
  returns exactly the conversations the backlog metric counts, already
  paginated and already ownership-scoped. A dedicated endpoint would have been a
  second definition of "breach" to keep in sync.
- **Outbound replies are excluded from the client timeline.** They could
  reasonably appear there ("we replied on the 3rd"); it is left out because that
  timeline has always meant mail *received* and changing it silently changes a
  finished page's content.
- **`rfcMessageId` is null on a reply we sent.** Gmail assigns the RFC
  `Message-ID` after the fact and does not return it from `messages.send`.
  Recovering it means a second `messages.get`; the value is not used by anything
  today, so it stays honestly null rather than invented.
- **F-3 (AI action extraction) and F-4 (collision detection)** are out of scope
  for this task.
