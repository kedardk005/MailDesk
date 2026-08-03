# IMPL — Scroll containment across the app

Branch `fix/scroll-containment` off `origin/main` (1649799). Client only.

## The bug

Owner's report: *"in inbox section are infinite scroll of page … also in profile
in notifications when scroll it was scroll with blank page."*

Two distinct failures, both measured live against the seeded app (2,000 emails /
415 tasks, viewport 1280×720, admin session):

1. **`<main>` scrolled instead of the rows.** `TableContainer` was
   `overflow-auto` with no height constraint. A box free to grow never
   overflows — it just gets taller (1,040 px of rows against a 720 px
   viewport), so `<main>` scrolled and dragged the toolbar, sticky table
   header and pagination away.
2. **A document-level scrollbar existed on top of `<main>`'s** on /inbox and
   /profile (settling the open question: **yes, it was real, but only on those
   two pages**). `document.documentElement` measured `scrollHeight` 1378
   (inbox) / 1648 (profile) against `clientHeight` 720 even though the shell
   is `h-screen overflow-hidden`. Real wheel input at the bottom of the list
   chained to the window and shoved the whole app up, leaving a mostly blank
   viewport — reproduced and screenshotted. Hiding the page's in-flow content
   returned the document to 720, so Chromium leaks the clipped content into
   the viewport's scrollable overflow; the trigger for why only these two
   pages is unidentified (both are the only pages rendering Radix Tabs —
   correlation, not proven cause).

## The mechanism

One opt-in chain, `flex-1` **plus `min-h-0`** at every link (md-and-up only —
below `md` the stacked chrome can eat the viewport, so phones keep the plain
scrolling page):

```
<main>  flex column (ProtectedLayout) — html/body overflow locked while mounted
  <PageHeader> / <Toolbar>   shrink-0 (never compressed by the column)
  <PageBody fill>            md:flex md:flex-col md:flex-1 md:min-h-0
    <DataTable fill>         flex-1 min-h-0 flex-col
      <TableContainer>       overflow-auto flex-1 min-h-0  ← the ONLY scroller
      <Pagination>           sibling below the scroller — pinned
```

`TableContainer` also accepts `fill` directly for raw (non-DataTable) tables.

## Files changed

- `client/src/components/ProtectedLayout.jsx` — `<main>` becomes a flex
  column; effect locks `overflow: hidden` on `<html>`/`<body>` while the shell
  is mounted (public Landing/Login pages keep document scrolling).
- `client/src/components/ui/PageHeader.jsx` — `PageBody fill` prop;
  `PageHeader`/`Toolbar` get `shrink-0`.
- `client/src/components/ui/Table.jsx` — `TableContainer fill` prop.
- `client/src/components/ui/DataTable.jsx` — `fill` prop.
- Pages opted in: `EmailInbox` (both message and conversation tables),
  `TaskList` (**list view only**), `ClientList`, `admin/ManageUsers`,
  `admin/ActivityLog`. Inbox `BulkBar` gets `shrink-0`.
- `client/src/components/scrollContainment.test.jsx` — new regression tests
  (5): html/body lock + restore, `<main>` column contract, the full fill
  chain (scroller identity, `min-h-0`/`flex-1` at every link, sticky thead
  inside the scroller, pagination outside/after it), `TableContainer fill`,
  and no-`fill` pages unchanged.

Profile needed no page change: its `<main>` scrolling is by design; the
blank-page glitch was the document scrollbar, which the layout lock removes.

## Measurements (1280×720, seeded data, admin)

docSH/CH = documentElement scrollHeight/clientHeight. "doc scrolls" =
user-visible window scroll (before: verified with real wheel input on /inbox —
app shifted up into blank space).

| Page | Before docSH/CH · doc scrolls | Before scroller | After docSH · doc scrolls | After scroller | Sticky thead | Pagination |
|---|---|---|---|---|---|---|
| /inbox | 1378/720 · **yes (wheel-verified)** | `<main>` 1472/672; rows 1040/1040 (no) | 1378 · locked | rows 1040/**240** ✔ | pins at container top ✔ | y=613, pinned ✔ |
| /tasks?view=list | 720/720 · no | `<main>` 1324/672; rows 1040/1040 (no) | 720 · locked | rows 1040/**388** ✔ | ✔ | y=669, pinned ✔ |
| /clients | 720/720 · no | `<main>` 1171/672; rows 965/965 (no) | 720 · locked | rows 965/**466** ✔ | ✔ | y=669, pinned ✔ |
| /admin/users | 720/720 · no | `<main>` 922/672; rows 640/640 (no) | 720 · locked | rows 640/**390** ✔ | ✔ | y=669, pinned ✔ |
| /admin/activities | 720/720 · no | `<main>` 1318/672; rows 1040/1040 (no) | 720 · locked | rows 1040/**394** ✔ | ✔ | y=669, pinned ✔ |
| /profile?tab=notifications | 1648/720 · **yes** | `<main>` 1932/672 (by design) | 1648\* · locked | `<main>` (unchanged); full content reachable, last element visible at bottom | n/a | n/a |
| /tasks?view=board | 720 · no | columns 4100/461 (independent) | 720 · locked | columns 4100/461 — identical | n/a | n/a |
| /tasks?view=calendar | 720 · no | `<main>` 1012/672 | 720 · locked | `<main>` 1012/672 — identical | n/a | n/a |
| /dashboard, /reports | — | `<main>` | unchanged | `<main>`; dashboard bottom reachable (1240/672), charts render | n/a | n/a |

\* the Chromium overflow quirk still inflates the number on /profile, but the
html/body lock removes the scrollbar and user scrolling of the viewport.

After-state: on every list page `<main>` measures **672/672** — it no longer
scrolls at all; the row container is the only scroller.

**Mobile (375×812, /inbox):** containment intentionally off below `md`.
`<main>` scrolls (1783/764), all 25 rows, pagination and footer reachable at
the bottom — nothing trapped. This is the pre-fix behaviour on phones, which
never had the reported glitch in a damaging form (the row area would otherwise
collapse to ~0 px under the stacked header/tabs/filters).

## Gate

- `npx eslint . --max-warnings=0` → 0 errors
- `npm run test -- --run` → **196 passed** (191 baseline + 5 new)
- `npx vite build` → passes

## Verified / not verified

- Verified: every number above was measured in-page with `location.port` and
  `location.pathname` asserted in the same script (the in-app pane sometimes
  reports a 0×0 viewport when hidden; such readings were detected and
  discarded, and each measurement ran with the pane fronted).
- Verified: the before-fix blank-page glitch with real wheel input on /inbox.
- Likely (not verified live): that real wheel input can no longer scroll the
  locked document after the fix. The pane stopped delivering synthetic wheel
  events during after-testing, so this relies on standard
  `overflow: hidden`-on-root semantics (the same mechanism every modal
  scroll-lock uses) plus the fact that on list pages `<main>` no longer has
  any overflow to chain from. Worth one manual wheel-flick past the bottom of
  the inbox in a normal browser.
- Not attempted: the reading-pane `Drawer`/dialogs were not re-measured; they
  are portal-rendered outside `<main>` and untouched by this change (their
  internal scrolling classes are unchanged).
- Known cosmetic consequence: with few rows (e.g. /admin/users' 15), the
  bordered table box stretches to the bottom of the viewport instead of
  hugging its content — inherent to the fixed-column pattern.
