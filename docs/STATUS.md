# Build status — hardening & rebuild

Branch `feat/production-hardening`. Nothing committed; all changes are in the
working tree.

## Verified green

| Check | Command | Result |
|---|---|---|
| Server syntax | `cd server && npm run check:syntax` | OK (all files) |
| Server integration | `cd server && npm run test:smoke` | **282 passed, 0 failed** (verified with Redis **and** with `REDIS_URL` unset) |
| Client tests | `cd client && npm run test -- --run` | **185 passed** (12 files) |
| Client lint | `cd client && npx eslint .` | **0 errors**, 1 pre-existing warning |
| Client build | `cd client && npx vite build` | passes |
| Compose config | `docker compose config` | valid |
| Server boot with Redis | `REDIS_URL=... node index.js` | adapter + BullMQ active, 0 unhandled rejections |

Baseline at the start of this work: 100 ESLint problems (85 errors), 0 tests,
single 638 kB bundle, app not deployable.

## ⚠️ MongoDB 7.0+ is now a hard requirement

The SLA percentile aggregations (`reportsController.js`) use `$median` and
`$percentile`, which were introduced in **MongoDB 7.0**. On 6.x those pipeline
stages fail at query time — the rest of the app works, so it will surface as
SLA reports erroring rather than as a boot failure. `docker-compose.yml` and
CI both pin `mongo:7`; verify any managed cluster (e.g. an Atlas tier still on
6.0) before deploying.

Running the smoke suite also needs both rate limiters raised, because 225
assertions exceed the shipped defaults (10 auth / 300 general per 15 min per IP):
`RATE_LIMIT_AUTH_MAX=500 RATE_LIMIT_GENERAL_MAX=5000`. Those are test-run values
only; the production defaults are unchanged.

## Running the stack locally

MongoDB and Redis run as containers created during this work:

```bash
docker start maildesk-mongo maildesk-redis
```

```bash
cd server && npm run dev
```

```bash
cd client && npm run dev
```

Smoke test against a running server (point it at a scratch database):

```bash
cd server && MONGO_URI="mongodb://127.0.0.1:27017/maildesk_smoke" BASE_URL="http://127.0.0.1:5150" npm run test:smoke
```

## What the smoke test proves

Real HTTP against a real database: health + DB state, login, **400 (not 500) on
invalid input with field errors**, 401 when unauthenticated, the
`{data, pagination}` envelope on all six list endpoints, `limit=9999` clamping
to 100, unknown sort fields falling back instead of 500-ing, **email lists
carrying no `body`/`bodyRaw`**, Employee blocked from users and reports, the
`?days=` DoS clamp, and rejection of `$`-operator injection bodies.

## Bugs found and fixed during verification

1. **MongoDB connection flapped every few seconds** (`config/db.js`).
   `compressors: ['zstd','snappy','zlib']` advertised algorithms whose optional
   native modules (`@mongodb-js/zstd`, `snappy`) are not installed, so the
   handshake negotiated a codec the driver could not run and the connection
   dropped and re-established in a loop. Measured: `readyState` oscillating
   1 → 0 → 1, `/readyz` flapping 200 ↔ 503. In production the service would
   have been pulled from the load-balancer rotation permanently.
   Fixed by probing `require.resolve` and advertising only loadable
   compressors; `zlib` (Node core) is always safe. Verified stable: 6 polls
   over 18s, `readyState=1`, 0 drops.
2. **`/reset-password` route did not exist** — the server emails
   `${FRONTEND_URL}/reset-password?token=…` (`authController.js:211`) but
   unmatched paths fell through to the shell 404 and bounced anonymous visitors
   to `/login`, making the whole reset flow unreachable.
3. **385 kB of recharts eagerly preloaded into `/login`** — the `manualChunks`
   rule for `vendor-charts` captured recharts' CJS-interop copy of React, which
   `vendor-react` then imported, making the chart bundle a static import of the
   entry chunk. Removed the rule; recharts now folds into the lazy `/reports`
   chunk.
4. **`?days=` unbounded** on the email timeline — `?days=100000000` allocated
   100M `Date` objects. Clamped to 1–365.
5. **`/reports` was Admin-gated client-side** while the server served Head and
   contained Head-scoping logic that could never run.

6. **Server crashed on boot whenever `REDIS_URL` was set** (`index.js:244`) —
   i.e. the multi-instance configuration the whole Redis layer exists to enable.
   `@socket.io/redis-adapter`'s constructor calls `psubscribe`/`subscribe`
   **synchronously**, and the shared client sets `enableOfflineQueue: false`, so
   those commands rejected before the socket was writeable. Nothing awaited the
   constructor, so the rejection reached the process-level `unhandledRejection`
   handler and shut the server down. `enableOfflineQueue: false` is correct for
   request-path cache reads (fail fast rather than hang) but wrong for pub/sub,
   where a subscribe is one-off setup that must survive a reconnect. Fixed by
   overriding it for the two adapter clients only. This also closed the one item
   `IMPL-backend-optimization.md` listed as genuinely unverified: BullMQ against
   real Redis now runs.
7. **`StatTile` white-screened the Dashboard** given a lucide icon
   (`components/ui/Card.jsx`). lucide-react v1 exports `forwardRef` **objects**,
   so `typeof icon === 'function'` failed and the raw object was rendered as a
   React child. `memo()` results had the same shape. Fixed to accept component
   types and pre-created elements; regression test added.
8. **`DataTable` double-activated any control inside a cell.** The keydown guard
   only saw `keydown`, but activating a nested `<button>` with Enter synthesises
   a **click** that bubbles to the row. Pages were compensating with manual
   `stopPropagation`. The row handler now ignores events originating on an
   interactive descendant; the two tests that pinned the defect became contract
   assertions, plus a new case proving plain-cell activation still works.
9. **Activity-log date filter did nothing.** The page sent `from`/`to`; that
   endpoint reads `dateFrom`/`dateTo`. Found by the client agent while adopting
   the structured-audit fields.

## Method note

`grep` on this machine is a shell function wrapping **ugrep 7.5.0**, where `\|`
alternation silently under-matches: `grep -c "a\|b"` returned 3 where
`grep -cE "a|b"` returns 6. This caused one incorrect finding in an earlier
revision of `PROJECT_AUDIT.md` (since corrected). **Use `-E` for alternation.**

## Features delivered

| ID | Feature | Notes |
|---|---|---|
| F-1 | Email threading | `threadId` is persisted instead of discarded, and **replies are now stored** — the app can finally show that a reply was sent. Conversation list + threaded reading pane, opt-in via `?group=thread` so the existing message view is byte-identical |
| F-2 | SLA analytics | Median and p90 (never mean) first-response, resolution and backlog; configurable targets with per-client overrides and business hours; Reports tab, Dashboard tile, breaches link into the backlog filter |
| F-3 | AI action-item extraction | `{ emailId }` / `{ threadId }` only — never a body payload. Suggestions pre-fill a review form; **nothing is created without an explicit click** |
| F-4 | Collision detection | Ephemeral presence over the existing Socket.io rooms — viewer avatars and a warning when a colleague is already composing. Advisory, never blocking |

### Prompt-injection handling (F-3)

Both the email body **and** the model's reply are treated as untrusted. Content is
fenced with a per-request random nonce, and the nonce and marker words are
stripped from the content so a hostile email cannot close the fence and escape
into the instruction region. Every field of the reply is re-typed and re-bounded
server-side: ≤10 actions, `priority` validated against the `Task` enum, `dueDate`
ISO-or-null, `confidence` clamped and defaulting to **0, not 1**. The output
creates nothing, feeds no further prompt, and selects no tool, recipient or URL.

### Known limitation

`PRESENCE_ENABLED` is off under `MODE === 'test'`: MSW does not mock WebSockets,
so a real handshake in jsdom would be a nondeterministic connection plus a leaked
interval. **F-4 therefore has no automated coverage** — it is advisory
functionality, but it is untested and should be exercised manually.

## Not done yet

Carried forward, with owners in `docs/audits/WAVE2-GAPS.md`:

- **Server gaps S-2 … S-17** — notably structured `ActivityLog` fields
  (`ip`, target, before/after), `PUT /api/users/change-password` returning a
  replacement token (changing your own password currently signs you out), a
  bulk email-delete endpoint, and a real read/unread flag on `Email`.
- **Backend optimization doc** — the agent implemented the layer (pagination in
  all 8 controllers, `cache.js`, `queue.js`, `redis.js`, `lock.js`,
  `resilience.js`, `logger.js`, `syncIndexes.js`, `backfillEmailSnippets.js`)
  but was cut off before writing `IMPL-backend-optimization.md`. The async Gmail
  sync job API (`POST /api/gmail/fetch` → `GET /api/gmail/sync/:jobId`) is
  implemented and needs documenting.
- **Test coverage is narrow.** 29 tests cover the two highest-value regression
  areas (XSS containment, session/cache clearing). Still missing: the route
  smoke test that would have caught the `TaskList` crash class, `DataTable`
  controlled-sorting behaviour, dialog focus traps, axe accessibility
  assertions, and MSW-backed page integration flows. The harness (Vitest + MSW +
  jest-axe) is fully configured, so these are additive.
- **Pages have not adopted the consolidated primitives.** Three pages still
  carry hand-rolled sort headers that can be deleted now that `DataTable` takes
  `sorting`/`onSortingChange`.
- **Feature roadmap untouched** — email threading (`threadId` is read and
  discarded at `gmailController.js:936`), SLA/response-time metrics, AI
  action-item extraction, collision detection.

## Migration steps before first deploy

```bash
cd server && npm run sync-indexes
```

```bash
cd server && npm run backfill-emails
```

Set `REDIS_URL` to enable the Redis-backed cache, queue, Socket.io adapter and
rate-limit store. With it unset everything falls back to in-process equivalents,
which is a working single-instance configuration but **not** safe for more than
one replica.
