# Client test suite — implementation notes

Branch `feat/production-hardening`. Everything below lives under
`client/src/**/*.test.{js,jsx}` and `client/src/test/**`; no application source
was modified. Bugs the tests uncovered are listed at the bottom, unfixed.

## How to run

```bash
cd client && npm run test -- --run        # 184 tests, 12 files
cd client && npm run test:coverage        # same, plus coverage/
cd client && npx eslint .                 # 0 errors
```

Watch mode is `npm run test:watch`. A single file:
`npx vitest --run src/pages/routes.smoke.test.jsx`. A single case:
`npx vitest --run -t "last-QUERY-wins"`.

CI already runs `npm run test -- --run` in the client job
(`.github/workflows/ci.yml`).

## Where it stands

| Area | File | Tests |
|---|---|---|
| Route smoke (every page, render + interaction) | `src/pages/routes.smoke.test.jsx` | 26 |
| `DataTable` | `src/components/ui/DataTable.test.jsx` | 24 |
| axios interceptors | `src/api/axios.test.js` | 23 |
| Dialog / Drawer / ConfirmDialog / `useConfirm` | `src/components/ui/Dialog.test.jsx` | 19 |
| Login / Register / ForgotPassword flows | `src/pages/authFlows.test.jsx` | 19 |
| XSS containment (pre-existing) | `src/components/EmailBody.test.jsx` | 18 |
| EmailInbox integration | `src/pages/EmailInbox.test.jsx` | 11 |
| TaskList integration | `src/pages/TaskList.test.jsx` | 11 |
| Accessibility (jest-axe) | `src/a11y.test.jsx` | 11 |
| Session / cache clearing (pre-existing) | `src/lib/auth.test.js` | 11 |
| `ErrorBoundary` | `src/components/ErrorBoundary.test.jsx` | 8 |
| `StatTile` icon (added by the UI agent) | `src/components/ui/StatTile.icon.test.jsx` | 3 |
| **Total** | | **184 passing, 0 failing** |

Baseline before this work: 29 tests in 2 files.

Coverage (`v8`, whole `src/`):

```
Statements  47.34 % (1926/4068)
Branches    41.42 % (1488/3592)
Functions   43.66 %  (545/1248)
Lines       50.28 % (1758/3496)
```

By layer — the shape matters more than the headline number:

| Layer | Statements |
|---|---|
| `src/api` (`axios.js`) | 97.4 % |
| `src/components/ui` (design system) | 88.3 % |
| `src/lib` | 67.1 % |
| `src/pages` | 47.3 % |
| `src/pages/admin` | 39.7 % |

The design system and the network layer are near-fully covered because they are
shared by every screen. Page coverage is deliberately shallower: each page is
700–2 200 lines of view code, and the route smoke test walks all of them without
pinning their internals.

## Harness

Already existed and was not changed except to add two missing handlers:
Vitest + `@testing-library/react` + `user-event` + `jest-dom` + jsdom + MSW v2 +
`jest-axe`, configured in `client/vitest.config.js`, with
`client/src/test/setup.js` (MSW `onUnhandledRequest: 'error'`),
`client/src/test/handlers.js` and `client/src/test/server.js`.

Added:

- **`client/src/test/utils.jsx`** — not a test file (the `include` glob is
  `*.{test,spec}.{js,jsx}`). Exports `renderWithProviders`, `AppProviders`,
  `seedSession`, `captureConsoleErrors`, `errorFallback`. The provider stack is
  the real one from `App.jsx` (`ThemeProvider → AuthProvider → TooltipProvider →
  ConfirmProvider → Router`, plus `Toaster`) with `MemoryRouter` swapped in for
  `BrowserRouter`. A fake provider would hide exactly the failure class this
  suite exists to catch.
- **Two handlers** in `client/src/test/handlers.js`: `GET /api/reports/employee`
  and `GET /api/reports/email-timeline`. Both routes exist on the server
  (`server/routes/reportsRoutes.js:16,25`) and `admin/Reports.jsx` calls them;
  the handler file simply had not caught up. Without them,
  `onUnhandledRequest: 'error'` failed the Reports route.

Determinism:

- No real network. `onUnhandledRequest: 'error'` means an unmocked request is a
  test failure, not a silent escape.
- No fake timers anywhere. The only time-dependent tests are the EmailInbox
  search ones, which are driven by real 350 ms debounce and a deliberately slow
  MSW handler; fake timers plus MSW plus `user-event` is a three-way advance
  problem that is more fragile than a 500 ms sleep. Total suite runtime ~13 s.
- `restoreMocks` / `clearMocks` are on in `vitest.config.js`, and
  `setup.js` clears both storages after every test.
- `axios.test.js` re-imports `src/api/axios.js` through `vi.resetModules()` for
  every case, because `redirectingToLogin` and the toast throttle are
  module-level state.

## What each area asserts

### 1. Route smoke test (`src/pages/routes.smoke.test.jsx`)

The test that would have caught the shipped `TaskList` crash. Thirteen routes
(twelve components; `ForgotPassword` twice, with and without `?token=`), each
run twice:

- **renders** — mounts inside the real providers wrapped in a real
  `<ErrorBoundary>`, asserts no fallback, no `console.error`, and non-empty
  output;
- **survives interaction** — then clicks every `role="tab"`, every
  `role="radio"` view switcher, changes every native `<select>`, opens and
  closes every Radix `SelectMenu`, clicks every sortable column header, and
  presses a safe allowlist of toolbar buttons, re-asserting after **each** step.
  51 discrete interactions across the 13 routes at the time of writing.

Two design points worth keeping:

- Each control group **restores** the state it started on. Cycling TaskList's
  view switcher and stopping on "Calendar" would unmount the table and silently
  skip every sort and pagination assertion below it.
- `console.error` is asserted *before* the fallback, because `ErrorBoundary`
  logs the thrown error through it — that assertion is the one that prints a
  usable stack.

Adding a route is one line in the `ROUTES` array.

Destructive controls (Delete, Disconnect, Sign out, Save) are excluded by name.

### 2. `DataTable`

Controlled sorting is the point: `sorting` present ⇒ `manualSorting`,
`getSortedRowModel` not installed, rows rendered in server order, and
`onSortingChange` receives a **resolved array** rather than the TanStack updater
function. Both directions of `aria-sort` in controlled and uncontrolled mode;
uncontrolled sorting and `initialSorting` still work; keyboard activation for
`rowActivation` `row` / `cell` / `none`; row selection keyed by `getRowId` with
a real indeterminate select-all; server vs client pagination, 1-based page
emission, and two tables on one screen getting distinct `rows-per-page` ids.

### 3. Dialog / Drawer / ConfirmDialog

Focus moves into the dialog, Tab is trapped (eight tabs, never escapes), Escape
closes, focus returns to the trigger, `dismissable={false}` blocks Escape, and
the rest of the page is hidden from assistive tech while open.
`ConfirmDialog.requireTyped`: confirm disabled until the phrase matches exactly,
case-sensitive, surrounding whitespace forgiven, Enter arms only when valid, and
the field is **cleared between opens** (`ConfirmProvider` keeps one instance
mounted, so this cannot be left to unmount). `useConfirm` resolves `true` /
`false` / `false`-on-Escape and throws a useful error outside its provider.

### 4. axios interceptors

Bearer attachment; 401 clears the session **and all `cached_*` keys** and
redirects exactly once with a `?next=`; a burst of parallel 401s still redirects
once; no redirect for the sign-in request itself or from a public path, and the
latch releases afterwards; 403 permission toast; 429 with `Retry-After` in
seconds and in minutes, and with a nonsense value; toast throttling; network
error vs `navigator.onLine === false`; 5xx and unmapped statuses; a 400
validation payload left intact for the form; `abortable` / `isCanceled` /
`ignoreCancel`, including a last-query-wins race.

### 5. `ErrorBoundary`

Fallback instead of an unmounted tree, siblings survive, `onError` fires,
"Try again" recovers, a changed `resetKey` clears the error (this is what makes
navigating away from a broken route work), custom `fallback` / `title` /
`description`.

### 6. Accessibility

`jest-axe` on Login (clean and in its error state), on `ClientList` with rows,
on a `DataTable` with selection + sorting + pagination, on two tables sharing a
screen (catches duplicate ids), on an open `Dialog`, and on a form of
`FormField`-wrapped `Input` / `Select` / `Textarea` including an error state.
Plus explicit label-association assertions.

`color-contrast` is disabled: jsdom has no layout or computed colour, so axe
cannot evaluate it either way.

### 7. Page flows

- **Login** — success stores the session and redirects; a 400
  `{errors:[{path,message}]}` renders per-field inline messages with
  `aria-invalid` and no summary banner; a non-field failure falls back to the
  banner; local validation short-circuits the request; `?next=` is honoured and
  a protocol-relative `//evil.example.com` is refused.
- **Register** — a 201 **without** a token lands on "awaiting approval" and
  stores no session; a 201 *with* a token signs in; mismatch blocked locally;
  server field errors inline.
- **ForgotPassword** — enumeration-safe confirmation; `?token=` renders the
  redeem form and posts `{token, password}` to `/api/auth/reset-password`; an
  expired-token error surfaces at form level with a "New link" escape.
- **EmailInbox** — rows from `{data, pagination}`, server `total` in the pager,
  filters written to and restored from the query string, page reset on filter
  change, "Clear filters"; search debounced into **one** request, and
  last-QUERY-wins proven with a slow stale response that must never render.
- **TaskList** — status/priority filters and Board/Calendar/List switching
  neither throw nor log; filters reach the server and reset to page 1; sorting
  goes to the server; selection reveals the bulk bar with a live count; the bulk
  action posts `{taskIds, action, value}` to `POST /api/tasks/bulk`; a selection
  filtered off screen is dropped.

Page queries use roles, accessible names and the URL only — never class names or
test ids — so the concurrent page refactor onto the shared primitives does not
break them. (`LocationProbe` is the one `data-testid`, and it is a test-only
component, not page markup.)

## Deliberately not covered

- **`App.jsx` itself (0 %).** Every route is exercised through its page
  component instead. Rendering `App` means `BrowserRouter` + lazy `import()` +
  `ProtectedLayout` + socket.io, and the routing table it encodes is better
  checked by a Playwright run than by jsdom.
- **`ProtectedLayout`, `Navbar`, `Sidebar`, `NotificationBell`,
  `CommandPalette` (0 %).** They pull `lib/socket.js`, which opens a real
  socket.io client. Testing them needs a socket mock; that is the single largest
  remaining gap and the obvious next increment.
- **`lib/socket.js` (0 %)** — same reason.
- **`AdminRoute` / `ProtectedRoute`** — trivial redirect wrappers; the
  role logic underneath them (`lib/auth.js` `hasRole`) is covered.
- **Create/edit/delete dialogs inside the pages** (the long tail of
  `ManageUsers`, `Profile`, `ClientList`). The primitives they are built from
  are covered at 88 %; asserting each page's copy of the same form would be
  filler, and those pages are being rewritten concurrently.
- **Charts (`recharts`) in `Reports`** — no layout in jsdom, so a chart renders
  as an empty SVG. The page mounts and its tabs switch; the chart contents are
  not asserted.
- **Colour contrast, visual layout, real browser focus rings** — wrong tool.
- **The Radix `DropdownMenu` inside table row menus** is opened only in the
  TaskList bulk test; the smoke test does not open row-level menus, because
  every item in them is destructive.

## Bugs the tests uncovered — NOT fixed

### B-1 `DataTable` double-activates any control inside a cell

`client/src/components/ui/DataTable.jsx:227` puts `onClick` on the `<tr>`
whenever `onRowClick` is supplied, and only the built-in `__select` column stops
propagation (`DataTable.jsx:255-257`). Any other control a page renders inside a
cell therefore fires **both** its own handler and the row handler.

The keydown guard at `DataTable.jsx:235` (`if (e.target !== e.currentTarget)
return`) was written to prevent exactly this — its comment says "an Enter on a
button inside a cell must not activate twice" — but it only sees `keydown`.
Pressing Enter on a nested `<button>` synthesises a **click**, which bubbles to
the row and activates it anyway. The documented guarantee does not hold.

Reproduced by `DataTable.test.jsx` → the two cases named `KNOWN DEFECT`, which
assert the current behaviour so the suite stays green. The guard itself is
proven correct in isolation by the `fireEvent.keyDown` case immediately above
them.

Live impact is currently masked by convention: `TaskList.jsx:468` and
`EmailInbox.jsx:424-425` both call `e.stopPropagation()` on their row menus. The
contract is still wrong, and the next cell-level control that forgets will open
a row every time it is clicked. Suggested fix: stop propagation for every cell
in the interactive-row path, or scope `onClick` to the cells that are not
interactive.

### B-2 Actions column has no accessible header (axe `empty-table-header`)

- `client/src/pages/ClientList.jsx:498` — `header: ''`
- `client/src/pages/admin/ManageUsers.jsx:664` — `header: ''`

Screen readers announce an unnamed column. `EmailInbox.jsx:1195-1196` and
`TaskList.jsx:1962-1963` do it correctly with
`header: () => <span className="sr-only">Actions</span>`; these two were missed.

Found by `src/a11y.test.jsx`, which currently disables the
`empty-table-header` rule **for the ClientList case only**, with a comment
pointing here. Re-enable it once the two `header: ''` lines are fixed.

### B-3 `Dialog.jsx` documents an `aria-modal` it does not emit

`client/src/components/ui/Dialog.jsx:8` promises "real focus trap, ESC to close,
**aria-modal**, body scroll lock and focus restore". `@radix-ui/react-dialog`
1.1.23 does not put `aria-modal` on the content; it implements modality by
marking every sibling of the portal `aria-hidden`, which is equivalent (arguably
better for AT support). Everything else in that sentence is true and asserted.

Not a functional defect — a false statement in the contract doc that a reviewer
will act on. Either reword the comment or pass `aria-modal="true"` explicitly.
`Dialog.test.jsx` asserts the behaviour Radix actually provides.

### B-4 A 403 is reported to the user twice

The axios interceptor raises `toast.error(...)` for every 403
(`client/src/api/axios.js:116`), and `Login.jsx:109` additionally renders the
same sentence in an in-form `<Alert>`. Signing in with an unapproved account
puts the identical text on screen in two places at once.

Minor, but it forced `authFlows.test.jsx` to scope its assertion to the banner,
because a bare `findByText` is ambiguous. Worth deciding whether 403 on an auth
endpoint should be exempt from the interceptor toast.

### B-5 (observed, transient) `EmailInbox.jsx` mid-refactor `ReferenceError`s

While this suite was being written, the route smoke test twice caught
`EmailInbox` in a broken intermediate state from the concurrent page refactor:

- `ReferenceError: SortHeader is not defined` at `EmailInbox.jsx:1789`
- `ReferenceError: showClearAll is not defined` at `EmailInbox.jsx:2033`

Both are the **same class as the shipped `TaskList` crash** — an identifier left
behind by a rename, invisible until render. Both were gone by the final run, and
the suite is green against the current working tree. Recorded because it is
direct evidence the smoke test does the job it was written for, and because the
final state of `EmailInbox.jsx` should be re-verified with
`npm run test -- --run` after the page agent finishes.

## Notes for whoever extends this

- `renderWithProviders(ui, { route, errorBoundary })` is the only render entry
  point you should need. Pass `errorBoundary: true` when a throw should be
  observable rather than fatal to the test run.
- `errorFallback(container)` is scoped on purpose. A body-wide query reports the
  previous `it.each` case's DOM against the next one when a case fails
  mid-assertion.
- Add a new route to the smoke test's `ROUTES` array, not to a new file.
- If a page starts calling a new endpoint, add it to
  `client/src/test/handlers.js` — `onUnhandledRequest: 'error'` will tell you.
