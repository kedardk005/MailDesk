# IMPL — Client query cache + notification centre

Two related pieces of client work. Nothing under `server/` was changed; the
server-side gaps this uncovered are listed at the end as findings, not fixes.

---

# Part 1 — Client-side query cache

## The problem

There was no query cache at all — no TanStack Query, no SWR. Every page mount
issued its full request set, so Tasks → Inbox → Tasks re-downloaded both lists,
and the dashboard re-ran `fetchTaskOverview` (three to twenty requests on its
own) every single time it was opened.

## What was built

Deliberately **not** TanStack Query: the app is finished, lint-clean work and a
data-layer migration would have touched every page for a problem that needs
about 300 lines.

| File | Role |
|---|---|
| `client/src/lib/queryCache.js` | The store. Keys, TTL, LRU bound, ownership, both invalidation matrices. No React, no imports from the app. |
| `client/src/lib/useCachedQuery.js` | The hook. Stale-while-revalidate, invalidation subscription, `refetch`, `patch`. |
| `client/src/api/axios.js` | Response interceptor: every successful non-GET drops what its URL affects. |
| `client/src/components/ProtectedLayout.jsx` | Relays the three socket events into the cache. |
| `client/src/lib/auth.js` | Binds the cache to the signed-in user; `clearCaches()` now empties it alongside the legacy `cached_*` keys. |

### Keys

`normaliseUrl(url) + '|' + stableStringify(params)`.

`stableStringify` sorts object keys and drops `undefined` / `null` / `''`, so
`{page:1, status:'Late'}` and `{status:'Late', page:1}` are one entry and a
filter cleared to `''` is the same request as one that was never sent. The URL's
own query string is stripped, so `/tasks?x=1` and `/tasks` never split.

Both response shapes from `docs/audits/API-LIST-CONTRACT.md` are stored
verbatim as `response.data` — the pages keep their own `unwrapList` /
`readList`, so the cache has no opinion about `{data, pagination}` versus the
legacy bare array.

### Stale-while-revalidate

| Cache state | What the user sees | Requests |
|---|---|---|
| miss | skeleton | 1 |
| hit, age < TTL | the page, painted on the first render | **0** |
| hit, age ≥ TTL | the page, painted on the first render | 1, in the background |

TTL is **30 s** (`DEFAULT_TTL`). A background revalidation returning an
identical payload does not re-render (`JSON.stringify` equality), and one that
*fails* leaves the rendered page alone rather than blanking it — a stale list
beats an error page for data the user is already reading.

The zero-flash first paint comes from computing the initial state synchronously
in the `useState` initialiser and following key changes during render (the
same "adjust state when an input changes" pattern `ClientList` already used for
its search box) rather than from an effect.

### Bounded

`MAX_ENTRIES = 80`, LRU: reads re-insert, and the oldest key is evicted on
overflow. A long session cannot grow it without limit.

### Wired pages

| Page | Reads now served from the cache |
|---|---|
| `Dashboard` | `/tasks/overview` ×2 (a synthetic tag over `fetchTaskOverview`), `/tasks` recent, `/reports/overall`, `/reports/sla`, `/gmail/status`, `/keyword-rules/pending-approvals` |
| `TaskList` | `/tasks`, `/tasks/clients`, `/users` |
| `EmailInbox` | `/gmail/emails` (messages and conversations), `/gmail/status`, `/keyword-rules/pending-approvals` |
| `ClientList` | `/clients` |
| `NotificationBell` | `/notifications` page 1, `/notifications/unread-count` |

`useCachedQuery` takes an optional `fetcher`, which is how the dashboard's
derived multi-request overview is cached: it is stored under `/tasks/overview`,
so the ordinary `/tasks` prefix rule drops it along with the raw lists.

Deliberately **not** cached: detail reads (`/gmail/emails/:id`, `/tasks/:id`,
comments, timelines), the `Combobox`/picker searches (`lib/pickers.js` — they
are already debounced and per-keystroke), `/auth/me`, and `Reports` (a screen
people open once and read).

## The invalidation matrix

### Mutations — `invalidateForMutation(method, url)`

Runs in the axios **response** interceptor, so no call site opts in. Matching is
by URL prefix, and deliberately over-invalidates: the cost of dropping too much
is one refetch, the cost of dropping too little is a wrong screen.

| Non-GET to | drops |
|---|---|
| `/tasks…` | `/tasks`, `/reports` |
| `/clients…` | `/clients`, `/tasks/clients`, `/reports` |
| `/gmail…` | `/gmail`, `/tasks`, `/reports`, `/keyword-rules` |
| `/keyword-rules…` | `/keyword-rules`, `/gmail`, `/tasks`, `/reports` |
| `/users…` | `/users`, `/auth/me`, `/reports` |
| `/notifications…` | `/notifications` |
| `/auth…`, `/ai…` | nothing |

`/gmail` and `/keyword-rules` drop `/tasks` because assigning or approving mail
creates tasks server-side (`ensureTaskForEmail`, `ensureTasksForEmails`).

A prefix drops its children: `/tasks` also drops `/tasks/clients`,
`/tasks/overview` and `/tasks/:id/comments`.

### Socket events — `invalidateForSocketEvent(event, payload)`

Relayed from `ProtectedLayout`, which is mounted once per session.

| Event | `payload.type` | drops |
|---|---|---|
| `newNotification` | `task_assigned` · `task_completed` · `task_overdue` · `task_comment` | `/notifications`, `/tasks`, `/reports` |
| `newNotification` | `email_assigned` · `email_approval` | `/notifications`, `/gmail`, `/tasks`, `/reports`, `/keyword-rules` |
| `newNotification` | none/unknown, **with** a `taskId` | `/notifications`, `/tasks`, `/reports` |
| `newNotification` | none/unknown, no `taskId` | `/notifications` |
| `user:updated` | — | `/auth/me`, `/users` |
| `session:invalidated` | — | **everything** |
| anything else | — | nothing |

The untyped-with-`taskId` row is not defensive padding: the overdue cron writes
the *assignee's own* notification with no `type` at all (finding S-1 below).

An invalidation notifies subscribers even when nothing was cached — a mounted
page has to refetch either way, because what is on screen is now wrong.

## Non-negotiable: no cross-user leakage

This codebase has already shipped two cross-user leaks (`cached_*` localStorage
keys surviving logout; a missing `Vary: Authorization`). Four independent
mechanisms, so no single mistake is enough:

1. **Memory only.** Nothing is written to `localStorage` or `sessionStorage`.
   Nothing survives a tab close.
2. **Every entry records the user id that fetched it**, and `readCache(key,
   owner, ttl)` refuses to answer unless the caller's id matches — a mismatched
   entry is evicted outright rather than left to be found later. The caller's id
   comes from `useAuth()` (React state), never from this module's own
   bookkeeping, so a stale internal value can only cause a **miss**.
3. **`setCacheOwner()` empties the whole store on any change of user id.** It
   runs synchronously from every session write in `lib/auth.js`
   (`setSession` / `setUser` / `clearSession`), at module load, and from an
   `AuthProvider` effect as the backstop for the cross-tab `storage` event.
   `clearCaches()` — the same function that removes the legacy `cached_*` keys —
   empties it too, so logout has one teardown path, not two.
4. **An unattributed response is never stored.** `writeCache` refuses a null
   owner, and the hook re-checks `getCacheOwner()` after the await, so a
   response in flight across a user switch cannot land in the new user's cache.

(2) is the load-bearing rule; the rest is defence in depth.

Measured live, in one tab: as Admin the cache held 8 entries including a task
list whose first row was "Renewal of annual service contract"; calling
`auth.setSession()` with the Employee's session took the store to **0 entries**,
and reading the Admin's key back returned `null` for both user ids.
`localStorage` held only `token`, `user` and `maildesk_theme`.

## Measured request counts

Seeded demo data (2,000 emails / 415 tasks / 25 clients / 15 users), signed in
as `admin@demo.test`, counted by instrumenting `XMLHttpRequest`. "First visit"
is a cold cache; "revisit" is leaving the page and coming straight back, inside
the TTL. `/auth/me` is excluded — it is issued per navigation for a reason
unrelated to this work (finding S-3).

| Page | First visit | Revisit |
|---|---|---|
| Dashboard | **10** | **0** |
| Tasks | **5** | **0** |
| Inbox | **5** | **0** |
| Clients | **3** | **0** |

As `emp@demo.test`: Dashboard **6 → 0**.

Past the 30 s TTL the same revisit paints instantly from cache and issues the
same count in the background — verified by watching entry ages cross 30 s
mid-measurement.

### A mutation forces a refetch

End to end in the browser, with a real HTTP write:

```
PUT /api/notifications/<id>/read
  → interceptor: invalidateForMutation → dropped ["/notifications"]
  → GET /api/notifications?page=1&limit=30      (refetched)
  → GET /api/notifications/unread-count          (refetched)
  → badge 60 → 59
```

And on the `/tasks` branch, with the Tasks page mounted:

```
invalidateForMutation('PUT', '/tasks/<id>')   → dropped ["/tasks", "/reports"]
  → GET /api/tasks?page=1&limit=25&sort=-createdAt&status=Late   (refetched)
  → GET /api/tasks/clients                                        (refetched)
```

The page refetched **while mounted** — a write is visible without navigating
away.

---

# Part 2 — Notification centre

**Scoping was verified before any change and is correct.** REST filters
`userId: req.user._id`, every emit is `io.to(<userId>)` and never a broadcast,
and the overdue cron sends supervisors one digest rather than one row per task.
There is no cross-user leak. Nothing here re-filters for ownership — a second
place to get it wrong is worse than none. The work is presentation, reach and
role fit.

## Files

- `client/src/lib/notifications.js` — the type table, role gate, deep links,
  grouping and merge. Unit-testable without rendering a Radix popover.
- `client/src/components/NotificationBell.jsx` — the component.

## The type / icon / colour table

Types are read from `NOTIFICATION_EVENTS` in `server/models/User.js`, not
guessed. `type` is **optional** on the model, so `Update` is a real state, not a
defensive fallback.

| `type` | Label | Icon (lucide) | Tone | Deep link (Admin/Head) | Deep link (Employee) |
|---|---|---|---|---|---|
| `task_assigned` | Task assigned | `ClipboardList` | primary | `/tasks?expandTaskId=<id>` | same |
| `task_completed` | Task completed | `CheckCircle2` | success | `/tasks?expandTaskId=<id>` | same |
| `task_overdue` | Task overdue | `TriangleAlert` | danger | `/tasks?expandTaskId=<id>`, or `/tasks?status=Late` for the multi-task digest | same |
| `task_comment` | Comment | `MessageSquare` | neutral | `/tasks?expandTaskId=<id>` | same |
| `email_assigned` | Mail assigned | `Mail` | primary | `/inbox?status=assigned` | **`/tasks`** |
| `email_approval` | Approval | `ShieldCheck` | warning | `/inbox?approval=pending` | **hidden** |
| `system` | System | `Info` | neutral | none | none |
| *(absent / unknown)* | Update | `Bell` | neutral | `/tasks?expandTaskId=<id>` when a `taskId` is present, else none | same |

A `taskId` always wins over the type — it is the strongest evidence there is.

Per `docs/audits/IMPL-light-theme.md`, **neutral is the default and colour marks
the exception**, so the tone is applied to the **icon only**. The message, the
timestamp and the row background stay neutral, and every row carries its type
written out in words next to the icon — colour never carries meaning alone.
Verified in dark theme: `danger-text` `#FCA5A5` and `success-text` `#86EFAC` on
the elevated popover `#232F42` measure ≈7.4:1 and ≈9.5:1.

## Grouping

**Today / Yesterday / Earlier**, by calendar day (00:30 today is "Today", not
"14 hours ago"). Empty groups are dropped rather than rendered as bare headings,
and order within a group is the `-createdAt` order the endpoint sent. An
unparseable timestamp goes under Today — burying a live notification under
"Earlier" is the worse failure.

## Unread state and the badge

- The badge reads **`GET /notifications/unread-count`** — one number over the
  `{userId, read}` index. Counting the rows on screen would under-report past
  the page size; the Admin demo account has 60 unread against a 30-row page.
- Mark-one and mark-all are optimistic and expressed as a **subtraction from
  that single number**, never as a second accumulator, so double-counting is
  structurally impossible. The overrides are dropped the moment real data
  arrives — otherwise "mark all read" would keep marking future arrivals read.
- Socket arrivals and fetched pages are merged by `_id`
  (`mergeNotifications`), so a row that arrives live and again in the next page
  is one row.
- Unread is signalled by a **dot plus font weight** — shape channels — and by
  `(unread)` in the row's accessible name. Not by hue.

## Deep links

Every row goes to the thing it is about, not to a bare list. The Employee
divergence is the important one: `/inbox` is Admin/Head-only (`App.jsx`,
`Sidebar.jsx`), so an Employee's mail assignment routes to `/tasks`, where the
task the server auto-created for that email actually lives. A row with nothing
to open says so ("Nothing to open") instead of being a dead click.

## Real states

Loading skeleton (mirrors the row layout: icon, type line, message, timestamp) ·
empty ("You're all caught up") · error with a working **Try again** · load-more
(`page=1&limit=30`, button reads "Load older (N more)" and disappears when
`loadedCount >= total`). Verified live: 30 → 60 rows on one click, one request,
"Load older (91 more)" → "Load older (61 more)".

## Freshness

The bell owns **no socket subscription** (it used to open a second one).
`ProtectedLayout` turns `newNotification` into a cache invalidation, which both
of the bell's queries observe. One subscription, one path, and reopening the
bell inside the TTL costs nothing.

## Accessibility

- Radix Popover: keyboard-navigable, Escape closes and returns focus to the
  trigger (asserted).
- The unread count is announced by a **dedicated `role="status"
  aria-live="polite"` region**, not by making the list live. A live *list*
  re-reads every row on every change; a live *count* says the one thing that
  changed. Neither moves focus, so a new arrival cannot interrupt the user
  (asserted).
- The trigger's `aria-label` carries the real number ("Notifications, 137
  unread") even though the visual chip caps at "9+".
- Each row's accessible name is `"<Type>: <message>[ (unread)]"`.
- `PopoverContent` carries `aria-label="Notifications"` — Radix gives it
  `role="dialog"`, which axe requires to be named. **This was a real violation
  the new axe test caught.**
- Covered by `a11y.test.jsx` (axe, popover open).

---

# Verification

| Gate | Result |
|---|---|
| `npx eslint . --max-warnings=0` | 0 errors, 0 warnings |
| `npm run test -- --run` | **291 passed** (204 baseline + 87 new) |
| `npx vite build` | passes |

New tests:

| File | Covers |
|---|---|
| `client/src/lib/queryCache.test.js` (30) | keys, hit/miss, TTL, LRU bound, **cross-user isolation ×5**, both invalidation matrices, subscribers |
| `client/src/lib/useCachedQuery.test.jsx` (11) | first visit vs revisit request counts, mutation invalidation (mounted and on next visit), socket invalidation, **cross-user isolation end to end** |
| `client/src/lib/notifications.test.js` (25) | type table vs the server's list, role gate, deep links, grouping, merge/unread |
| `client/src/components/NotificationBell.test.jsx` (19) | badge authority, grouping, role filtering, deep links, mark one/all, loading/empty/error/load-more, untyped rows, signed-out |
| `client/src/a11y.test.jsx` (+2) | axe with the popover open, focus not stolen, Escape returns focus |

`client/src/test/setup.js` now empties the query cache after each test. Without
it, test N+1 renders from test N's rows and never calls its own MSW handler —
the exact false pass this suite exists to prevent.

Browser verification used a temporary Vite proxy on `:5199` so the owner's dev
server on `:5174` was left untouched; the server's CORS allowlist was not
changed. Both themes checked, Admin and Employee both signed in.

---

# Findings — server-side, NOT changed

**S-1. The overdue cron writes the assignee's own notification with no `type`.**
`server/utils/cronJobs.js` pushes `{userId, message, taskId}` for the assignee
but `{userId, message, taskId, type: 'task_overdue'}` for supervisors. Two
consequences: an Employee's own overdue notification renders as the generic
"Update" rather than the danger-toned "Task overdue" (visible in the live
Employee bell), and because `createNotifications` only consults preferences when
a `type` is present, an Employee who muted `task_overdue` still receives it.
One-word fix: add `type: 'task_overdue'` to that push.

**S-2. `email_approval` is declared but never emitted.** It is a member of
`NOTIFICATION_EVENTS` and has a preference toggle in the Profile UI, but no
server code writes a notification with that type — only `seedDemoData.js` does.
Either something should emit it when a keyword match lands in the approval
queue, or the preference toggle is a control that does nothing.

**S-3. `/auth/me` is re-issued on every navigation.** `ProtectedLayout`'s
`syncSession` effect depends on `forceSignOut`, which depends on `navigate` from
`useNavigate` — whose identity changes with the location under react-router v7.
So the effect re-runs on every route change, refetching `/auth/me` and resetting
the 5-minute interval. Pre-existing, unrelated to this work, and left alone
because it is outside `client/`'s cache concern and the fix (a ref for
`navigate`) belongs with whoever owns that file. It is why `/auth/me` is
excluded from the measurements above.

**S-4. `email_assigned` carries no `taskId`.** Both writers
(`keywordRuleController`, `gmailController`) pass `taskId: null`, even though
they have just created or upserted exactly the task the notification is about.
The client works around it by routing to a filtered list; passing the task id
would let it open the task drawer directly, which is what the message implies.

# Unverified / weak

- **The 30 s TTL is a guess.** It is short enough that nothing feels stale and
  long enough to cover a navigate-and-return. No usage data informed it. It is
  one constant in `queryCache.js`.
- **`MAX_ENTRIES = 80` was not stress-tested against a real long session**,
  only against the eviction unit test. Nothing measures the cache's memory
  footprint; a page of 25 emails with snippets is not large, but 80 of them is
  not free either.
- **The socket path was exercised through `invalidateForSocketEvent` directly,
  not by an actual server emit.** The relay in `ProtectedLayout` is a two-line
  handler and the mapping is unit-tested, but no live `newNotification` was
  observed arriving over the wire during verification.
- **Multi-tab was not tested.** The cross-tab `storage` path is covered by an
  `AuthProvider` effect and reasoned about, not measured with two real tabs.
- **`patch()` extends an entry's freshness** by rewriting it with a new
  `storedAt`. For per-row edits (marking mail read, a status change) that is
  arguably right — the row now matches the server. It is still a behaviour
  worth knowing about.
- **Load-more rows are not cached.** Closing and reopening the bell collapses
  back to page 1. Deliberate — reconciling an accumulated tail against a page-1
  invalidation is more machinery than the feature is worth — but it is a
  visible behaviour.
- **The badge caps at "9+"** while the `aria-label` carries the true count. That
  is the pre-existing `CountBadge` convention (`max={9}` in a 16px chip), not a
  decision made here.
- **Employees are shown `task_completed`** even though only Admin/Head can
  create tasks, so in practice they can never receive one. It is listed as
  visible-to-all because an Employee who somehow received one can still open the
  task; hiding it would be hiding information on a theory.
