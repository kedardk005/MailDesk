# IMPL — Combobox pickers (client / assignee / email)

Branch `feat/combobox-pickers`, based on `origin/main` (924f345). Client-only —
no server change; every source is an existing list endpoint under
`docs/audits/API-LIST-CONTRACT.md`.

## Why

The task form's Client field was a native `<datalist>` — browser-drawn,
token-blind, single-line, and degrading past a few dozen rows. Assignee was a
native `<Select>` fed by `/users?limit=100` (breaks past 100 users); the email
link pulled 100 emails into memory. All "textual, multi-line" data the owner
complained about now goes through one primitive.

## The primitive — `client/src/components/ui/Combobox.jsx`

Radix Popover (portal, dismissable layers, `z-dropdown` 65 so it paints above
`z-modal` 60 dialogs/drawers) + cmdk (listbox roles, ArrowUp/Down, Home/End,
Enter, `aria-activedescendant` on the `role="combobox"` search input).

```jsx
<Combobox
  value={selected}              // {value, label, description?} | null — fully controlled
  onChange={setSelected}        // option, {…, isNew:true} from the create row, or null from the clear row
  loadOptions={async ({ q, signal }) => ({ options, total })}
  allowCreate                   // explicit «Create “text”» row; never silent free text
  clearLabel="No linked email"  // optional top row that clears the selection
  renderOption={(opt) => …}     // row body override (email unread state)
  inputMaxLength={200}          // forwarded to the search input
  debounceMs={250}
  size invalid disabled placeholder searchPlaceholder emptyMessage errorMessage contentClassName
/>
```

Behaviour contract:

- **Last query wins.** The debounced query is fetched in an effect whose
  cleanup aborts the in-flight request, so at most one request is ever pending
  and a slow early response can never overwrite a newer one (same pattern as
  EmailInbox's list hook). Verified by a unit test that resolves responses out
  of order.
- **Bounded rendering, announced.** Only the server page (`PICKER_LIMIT` = 20,
  `lib/pickers.js`) is rendered. When `total` exceeds it the footer says
  "Showing first N of M — keep typing to narrow" instead of silently truncating.
- **Three distinguishable non-result states.** "Searching…" (pending),
  "No matches for “q”." (fresh empty), "Could not load matches." + Retry
  (failed). A live region (`role="status"`) announces count / searching /
  failed for screen readers.
- **Controlled cmdk highlight.** When an async result replaces the rows, cmdk
  drops its highlight (the highlighted row unmounted) and Enter then does
  nothing — found live against the real API. The component owns cmdk's `value`
  and re-points it at the first row whenever the current highlight no longer
  exists. Regression-tested.
- **Escape closes the picker only.** Radix's dismissable-layer stack gives the
  top layer the Escape, so a parent Dialog/Drawer stays open. Tested in jsdom
  and verified live in both containers.
- **Create is explicit.** With `allowCreate`, unmatched text yields a
  «Create “text”» row (suppressed when a result's label matches
  case-insensitively). Selecting it emits `{value, label, isNew: true}` — the
  old datalist's free-text path survives, but visibly.

## Data sources — `client/src/lib/pickers.js`

Module-level (stable identity, no `useCallback` needed):

| Source | Endpoint | Two-line rendering |
|---|---|---|
| `searchClients` | `GET /clients?page=1&limit=20&sort=name&q=` | name / email or contact person |
| `searchAssignees` | `GET /users?page=1&limit=20&sort=name&q=` (Admin/Head) | name / role · email; non-Approved filtered client-side |
| `searchLinkableEmails` | `GET /gmail/emails?page=1&limit=20&status=unassigned&q=` | subject / sender · age, `unread` flag |

## Adoption

| Surface | Container | Before | After |
|---|---|---|---|
| TaskList → task form Client | Dialog | `<Input>` + `<datalist>` | `Combobox allowCreate` (create-new preserved, `maxLength` 200 kept) |
| TaskList → task form Assignee | Dialog | native `<Select>` from `/users?limit=100` preload | async `Combobox` (edit mode seeds the label from the task's populated assignee) |
| TaskList → task form Link an email | Dialog | native `<Select>` from a 100-email preload | async `Combobox` with unread badge + clear row; inbox deep-links keep their out-of-page email selectable |
| ActionExtraction panel Client + Assignee | Drawer (task detail, email drawer, thread drawer) | plain `<Input>` + `SelectMenu` from a `users` prop | two `Combobox`es; the `users` prop plumbing was deleted |
| EmailInbox AssignDialog Assignee | Dialog | `SelectMenu` from `useInboxAux`'s `/users` preload | async `Combobox`; the aux `/users` fetch was removed entirely |

Dead weight removed: TaskList no longer downloads 100 unassigned emails on
mount, and EmailInbox no longer downloads the user list on mount.

## Sweep — remaining `<datalist>` / capped selects

No `<datalist>` remains. Still preloaded + capped, deliberately NOT migrated
(filter/action dropdowns, not entity pickers — flagged for a follow-up if user
counts grow):

- `TaskList.jsx` toolbar filters (assignee / creator / client `SelectMenu`s)
  and the BulkBar reassign menu — `useTaskOptions` (`/users?limit=100`,
  `/tasks/clients`).
- `admin/ActivityLog.jsx:466` actor filter — `/users?limit=100`.
- `admin/Reports.jsx:759` user filter — `/users` legacy (unpaginated) shape.
- EmailInbox account filter — bounded by the linked-accounts list, fine.

## Verified

Against the seeded app (25 clients / 15 users / 2,000 emails, port asserted as
5174 in every measurement):

- All three form pickers in the New-task dialog, light AND dark; two-line rows;
  cap footers ("first 20 of 25" clients, "first 11 of 15" assignees, "first 20
  of 527" emails); server `q` narrowing ("remittance" → 37).
- End-to-end create: new client via the create row ("Zenith Verification Co") +
  searched assignee + linked email → task created, row renders.
- ExtractActionsPanel inside the task Drawer (real Gemini extraction): both
  pickers open ABOVE the drawer, flip upward near the bottom edge, Escape
  closes only the picker.
- EmailInbox AssignDialog: search + Enter selects, Create enabled.
- `npx eslint . --max-warnings=0` clean · `vitest --run` 204/204 (196 baseline
  + 8 new) · `npx vite build` passes.

## Not verified / known limits

- The assignee cap footer counts the server total, but non-Approved users are
  filtered client-side, so "first 11 of 15" can overstate M by the pending
  count. Cosmetic; fixing it server-side (`status=Approved` param) would skip
  legacy users with no status field.
- Error + retry state was exercised only in unit tests, not against a real
  failing server.
- Light-theme Drawer case not screenshotted (dark was); the styling is
  token-driven and identical to the Dialog case, which was checked in both.
- `/tasks/clients` remains the FILTER dropdown's source; the picker uses
  `/clients` (same names, richer fields, any-role access).
