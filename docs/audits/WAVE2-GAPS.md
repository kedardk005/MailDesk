# Wave 2 — reported gaps awaiting a consolidation pass

Page agents own only their own files, so anything they needed in a *shared*
component or on the *server* was reported rather than edited. Collected here and
dispatched after Wave 2 completes.

## Shared UI primitives (`client/src/components/ui/`)

| # | Gap | Reported by | Impact | Status |
|---|---|---|---|---|
| U-1 | `ConfirmDialog`/`useConfirm()` has no typed-confirmation option | Admin | Each page hand-rolls its own delete dialog. Needs `requireTyped: { value, label }` | ✅ **FIXED** — `requireTyped: { value, label?, placeholder?, hint? }` |
| U-2 | `DataTable` sorts internally via `getSortedRowModel` with no `sorting`/`onSortingChange` props | Admin | On a server-paginated set, header sorting would sort only the visible page. Admin had to disable header sorting and use a toolbar `Select` instead. Needs controlled sorting props | ✅ **FIXED** — `sorting` / `onSortingChange` / `manualSorting` |
| U-3 | `DataTable` `onRowClick` rows get `cursor-pointer` but no `tabIndex`/`role`/key handler | Admin | Rows are not keyboard-operable — the exact a11y defect the rebuild exists to fix | ✅ **FIXED** — `rowActivation="none"\|"row"\|"cell"` |
| U-4 | `Pagination` hard-codes `id="rows-per-page"` | Admin | Duplicate DOM id the moment two tables render on one screen | ✅ **FIXED** — `useId()` + optional `rowsPerPageId` |

## Server contract

| # | Gap | Reported by | Owner |
|---|---|---|---|
| S-1 | `getActivityLogs` / `getAllUsers` still unpaginated (`userController.js:13`, `:348`) — bare `res.json(array)` | Admin | Backend optimization agent (likely already in flight) |
| S-2 | `logActivity(userId, action, details)` writes only 3 fields — no `ip`, no target, no structured before/after. `ActivityLog.js` has no columns for them; the Wave 1 additions embedded before→after inside the `details` string | Admin | Needs `ActivityLog.js` + `activityLogger.js` change |
| S-3 | Actor-filter param name for `/api/users/activity-logs` unspecified — agent sends both `userId` and `actor` | Admin | Pick one server-side, document in the contract |
| S-4 | `GET /api/users` exposes no last-activity/last-login field; `linkedGmailAccounts` is `select:false` so the connected-Gmail count under-reports for Heads | Admin | Needs a projection/field addition |
| S-5 | `PUT /api/users/:id` response omits `maxConnectedAccounts`/`allowedGmailAccounts`, forcing a refetch after every save | Admin | Return the updated doc |

## Server contract — second batch (Auth/Profile/Client agent)

| # | Gap | Impact |
|---|---|---|
| S-6 | `PUT /api/users/change-password` bumps `tokenVersion` but returns **no replacement token** | Changing your own password kills your own session. The page now signs out cleanly with an explanation rather than 401-ing into a redirect, but returning a fresh token removes the forced sign-out entirely. **Real UX defect — fix server-side.** |
| S-7 | `PUT /api/users/profile` returns a **partial** user (no `status`) | Assigning the response wholesale would drop fields `GET /auth/me` supplied, so the client has to merge. Should return the `/auth/me` shape |
| S-8 | `GET /api/clients` returns legacy `{success,count,data}`, ignores `page/limit/sort/q/status` | Client falls back to local paging; switches to server mode automatically once `pagination` appears |
| S-9 | No `openTaskCount` on clients — only `taskCount` (all tasks matched by `clientName`) | Column is labelled "Tasks" rather than mislabelled "Open tasks". Relabel if added |
| S-10 | No per-client activity endpoint | Detail drawer timeline has only the record's own `createdAt`; it renders `client.timeline[]` if ever supplied and says so explicitly otherwise |
| S-11 | `DELETE /api/gmail/linked-account` is Admin-only, but `GET /api/gmail/status` returns linked accounts to Heads too | Disconnect control hidden for non-Admins so it cannot 403 by construction. Permissions should agree |
| S-12 | No notification-preferences endpoint | Notifications tab documents what actually gets sent instead of showing fake toggles. Real feature gap — see roadmap |

## Third batch (EmailInbox + Dashboard/Reports agents)

### Shared UI
| # | Gap | Impact | Status |
|---|---|---|---|
| U-5 | `CommandPalette` has no registration channel — `ProtectedLayout` mounts a controlled instance and doesn't forward `extraCommands`; mounting a second would double-bind ⌘K and open two dialogs | EmailInbox could not register any inbox commands. Needs a `CommandRegistry` context or an `extraCommands` pass-through | ✅ **FIXED** — `CommandRegistry.jsx`: `CommandRegistryProvider` (mounted in `ProtectedLayout`) + `useRegisterCommands(commands, deps)` |
| U-6 | `StatTile` has no `icon` slot and isn't linkable | Dashboard worked around it by passing a node as `label` and wrapping in `<Link>`. Wants `as`/`to` + `icon` props | ✅ **FIXED** — `icon`, `as`, `to`/`href` |
| U-7 | `chart-1…6` are literal hexes in `tailwind.config.js`, not CSS variables | Charts route around it via `fill="currentColor"` + token classes. A `--chart-N` variable set would allow per-theme tuning | ✅ **FIXED** — `--chart-1…6` in `:root` **and** `.dark`; class names unchanged |

### Server
| # | Gap | Impact |
|---|---|---|
| S-13 | **`GET /api/gmail/emails/:id` does not exist.** `gmailRoutes.js` has only `/reply`, `/attachments/:attachmentId`, `DELETE` | **Blocking.** Now that list responses carry `snippet` instead of `body`, the reading pane has no body without this route. The Drawer degrades to an `Alert` + Retry rather than breaking. Prescribed in `PROJECT_AUDIT.md` §P0-10 |
| S-14 | `POST /api/ai/summarize-email` still requires `subject`/`body` (`aiController.js:8-12`) | Will 400 on the new `{emailId}` payload. Sending the body was what caused the 413 against the 100 kb `express.json()` limit |
| S-15 | No bulk-delete endpoint for emails | Bulk delete fans out to `DELETE /api/gmail/emails/:id` via `Promise.allSettled` with partial-failure reporting. A `DELETE /api/gmail/emails` taking an id array would be better |
| S-16 | `Email` model has no read/unread flag | "Unread emphasis" is rendered from `status === 'unassigned'` as a proxy. Wants a real `readBy`/`isRead` field |
| S-17 | `/reports/employee` is `authorizeRoles('Admin')` while every sibling route serves Head | Reports is now open to Head; the employee-performance tab is correctly hidden for Head. Decide whether Head should see it and scope server-side if so |

### Contract correction made by the orchestrator
- **`from`/`to` → `dateFrom`/`dateTo`.** The original contract listed the date
  range as `from`/`to`, which collides with `from` meaning *sender* on
  `/api/gmail/emails`. Corrected in `API-LIST-CONTRACT.md`; both sides use
  `dateFrom`/`dateTo`, and `from` on the email endpoint means sender only.

### Cross-page URL contract (published by Dashboard, consumed by TaskList/EmailInbox)
`/tasks?status=Pending|Completed|Late`, `?assignee=me|<id>`, `?due=today`,
`?task=<id>`, `?new=1` · `/inbox?status=unassigned`, `?approval=pending`,
`?tab=accounts`

## Confirmed twice

**U-2** (`DataTable` has no controlled `sorting`/`onSortingChange`) and **U-3**
(rows not keyboard-operable) were independently reported by both the Admin and
the Auth/Client agents. Both had to disable header sorting and move sort into a
toolbar `Select`. These are the highest-priority consolidation items.

## Shared-UI consolidation pass — U-1 … U-7 all closed

All seven UI gaps are fixed in `client/src/components/**` (plus the CSS-variable
half of U-7 in `src/index.css` / `tailwind.config.js`). Full prop signatures and
examples are in **`IMPL-frontend-foundation.md`** — that file remains the
contract.

Every change is **purely additive**: each new prop is optional and each default
reproduces the previous behaviour exactly, so **no file under `src/pages/**` was
edited**. Verified with `npx eslint .` (0 errors, 1 pre-existing
`react-hooks/incompatible-library` warning) and `npx vite build` (passes).

Highlights worth knowing before touching a page again:

- **U-2** — a page can now delete its hand-rolled `SortHeader` / toolbar sort
  `Select`, drop `enableSorting: false`, and pass `sorting` + `onSortingChange`
  bound to the `?sort=` query param. `aria-sort` then comes from the header
  itself, so the `sr-only` text and stateful `aria-label`s can go too.
- **U-3** — `rowActivation="cell"` reproduces the `<button data-row-open>` that
  EmailInbox and TaskList hand-rolled, including the attribute their `j`/`k`
  handlers focus. Default is `"none"`, i.e. today's behaviour, so nothing broke.
- **U-5** — pages must NOT mount their own `<CommandPalette>`; call
  `useRegisterCommands()` instead. Commands unregister on unmount.
- **U-6** — a `StatTile` no longer needs a `<Link>` wrapper or an icon smuggled
  in through `label`.

### Also done in the same pass

- **`EmailBody`** — opt-in `imageGate` prop moves EmailInbox's local
  "Show remote images" control into the shared component, and only shows it when
  the body actually references a remote image (`hasRemoteImages()` is exported).
  Default `false` renders the bare `<iframe>` exactly as before. Consent resets
  per message. **TaskList would benefit**: it renders `EmailBody` with no gate at
  all today, so its remote images are blocked with no way to reveal them.
- **Iframe sandbox re-verified** — still `sandbox="allow-popups
  allow-popups-to-escape-sandbox"`, i.e. `allow-popups` only. No `allow-scripts`
  anywhere, and therefore no `allow-scripts` + `allow-same-origin` pairing. The
  inline CSP (`script-src 'none'`, `default-src 'none'`, gated `img-src`) and the
  DOMPurify pass are unchanged. The stored-XSS blocker stays closed.

## Fixed already by the orchestrator

- **Missing `/reset-password` route** — reset emails link to
  `${FRONTEND_URL}/reset-password?token=…` (`authController.js:211`) but no such
  route existed, so the entire reset flow was unreachable (unmatched → shell 404
  → bounce to `/login`). Added to `App.jsx` pointing at the token-driven
  `ForgotPassword` component. Verified: lint clean, build passes.
- **`getEmailTimeline` `?days=` DoS** — clamped to 1–365 in
  `reportsController.js`.

## Notes

- Every page agent was told to tolerate **both** the paginated envelope and the
  legacy bare array, so nothing is blocked on the server landing first.
- U-2 and U-3 are the highest value: they gate real sortable headers and
  keyboard-operable rows across every rebuilt table in the app.
