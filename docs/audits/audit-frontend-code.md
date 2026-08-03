# Frontend Code Quality, Architecture & Performance Audit
**Target:** `/Users/darshank/Desktop/WEBX/MailDesk/MailDesk/client`
**Stack:** React 19.2 · Vite 8 · Tailwind 3.4 · React Router 7 · Axios · socket.io-client
**Scope:** All 29 files under `client/src/` read in full, plus `vite.config.js`, `tailwind.config.js`, `eslint.config.js`, `postcss.config.js`, `index.html`, `index.css`, `App.css`, `package.json`.
**Out of scope (owned by another agent):** API contracts / backend integration correctness, auth/security semantics.

---

## Executive numbers (all verified by running tooling, not estimated)

| Metric | Value |
|---|---|
| Total source lines (`src/**/*.{js,jsx,css}`) | **10,643** |
| Largest file | `pages/TaskList.jsx` — **1,846 lines** |
| Top 5 files as % of all JSX | TaskList + EmailInbox + ManageUsers + ClientList + Reports = **5,976 lines = 56%** |
| `npm run lint` result | **100 problems (85 errors, 15 warnings)** |
| — of which `no-undef` (hard crash bugs) | **6** |
| — of which `no-unused-vars` | **42** |
| — of which `react-hooks/*` errors + warnings | **48** |
| Automated tests | **0** (no test runner, no test file, no `test` script) |
| Error boundaries | **0** |
| 404 / not-found route | **0** (wildcard redirects to `/login`) |
| `React.lazy` / `Suspense` / code splitting | **0** |
| `useMemo` / `useCallback` / `React.memo` | **0** |
| Production JS bundle | **637.96 kB raw / 160.95 kB gzip — single chunk**, Vite emits its >500 kB warning |
| Production CSS bundle | 64.16 kB / 11.29 kB gzip |
| `console.*` calls | **80 across 18 files** (of which 3 are `console.log`) |
| `window.confirm()` calls | **9 across 7 files** |
| Bare `alert()` calls | **3 across 2 files** |
| Inline `style={{…}}` objects | **57 across 4 files** |
| Hardcoded hex colours in JS/JSX | **96 occurrences, 36 distinct values** |
| **Non-existent Tailwind colour classes** | **128 occurrences, 33 distinct names — verified as 0 rules in built CSS** |
| Non-existent Tailwind utility classes (`z-45`, `scale-98`, `w-4.5`, `shadow-xs`, `left-1/6`…) | **11 more occurrences** |
| CSS class names referenced in JSX but defined nowhere | **6** (`animate-fade-in`, `animate-slide-in`, `skeleton-shimmer`, `hover-glow-card`, `animate-shake`, `custom-scrollbar`) — **used 40+ times** |
| `<button>` elements | **117** |
| `<input>` / `<select>` / `<textarea>` | **49 / 25 / 10** |
| `<table>` elements | **7** |
| Modal overlays hand-rolled (`fixed inset-0 z-50`) | **11** |
| `<label>` elements | **70** — only **6** have `htmlFor` |
| `aria-label` attributes | **1** (and it is on the wrong element) |
| `role=` / `aria-modal` / `aria-expanded` / `tabIndex` / `sr-only` / skip link | **0 / 0 / 0 / 0 / 0 / 0** |
| `focus:outline-none` (focus ring suppressed) | **60** |
| `onClick` handlers | **113** — 8 of them on non-interactive `div`/`tr`/`span` |
| Shared UI component library | **none — 0 reusable Button/Input/Modal/Table/Badge/Toast components** |
| State management (Context / Zustand / Redux / TanStack Query) | **none** |
| Custom hooks | **0** |
| PropTypes / TypeScript | **none** |
| Dead files never imported | **2** (`src/App.css`, `src/utils/moduleCursor.js`) + 3 unused assets |

---

# CRITICAL

## C1. `TaskList` crashes with `ReferenceError` on every filter interaction
**Severity: CRITICAL** · `pages/TaskList.jsx:692, 693, 712, 713, 747, 748`

Three separate handlers call two setters that **do not exist anywhere in the file**:

```jsx
// line 688-694 — Creator filter
onChange={(e) => {
  setCreatorFilter(e.target.value);
  setSelectedTaskIds(new Set());   // ← not defined
  setSelectAll(false);             // ← not defined
}}
```
```jsx
// line 710-714 — Priority filter
onChange={e => {
  setPriorityFilter(e.target.value);
  setSelectedTaskIds(new Set());   // ← not defined
  setSelectAll(false);             // ← not defined
}}
```
```jsx
// line 745-749 — Status tabs (All / Pending / Completed / Late)
onClick={() => {
  setStatusFilter(filter);
  setSelectedTaskIds(new Set());   // ← not defined
  setSelectAll(false);             // ← not defined
}}
```

Verified: `grep -n "SelectedTaskIds" pages/TaskList.jsx` returns exactly those 3 write sites and **no declaration**. `selectAll` is declared only in `EmailInbox.jsx:55`. ESLint confirms with 6 `no-undef` errors. This is leftover code from a bulk-selection feature that was copied from `EmailInbox` and then half-removed.

**Impact:** Every click on the four status tabs, every priority change, and every creator change throws an uncaught `ReferenceError` into `window.onerror`. Because there is **no error boundary** (see B1) and React does not catch handler exceptions, this floods the console, breaks any downstream error reporting, and any code appended to those handlers later will silently never run. The Tasks page is the app's primary workspace — this fires on the most-used control in the product.

**Fix:** Delete the six dead lines. (Or, if bulk selection is wanted, declare `const [selectedTaskIds, setSelectedTaskIds] = useState(new Set())` and `const [selectAll, setSelectAll] = useState(false)` and build the UI.) Then add `"lint": "eslint ."` to CI so `no-undef` can never ship again.

---

## C2. No error boundary anywhere — one throw = permanent white screen
**Severity: CRITICAL** · `src/App.jsx` (whole file), `src/main.jsx:6-9`

```jsx
createRoot(document.getElementById('root')).render(
  <StrictMode><App /></StrictMode>
)
```
No `componentDidCatch`, no `ErrorBoundary`, no `errorElement` on any route (React Router 7 supports `errorElement`/`ErrorBoundary` per route and none is used). Verified: `grep -rn "ErrorBoundary\|componentDidCatch" src/` → 0 hits.

**Impact:** React 18/19 unmounts the entire tree on an uncaught render error. Any single bad record — a task with `assignedTo` shaped unexpectedly, `client.name` null at `ClientList.jsx:339` (`client.name.slice(0,2)`), `log.action.includes(...)` at `ActivityLog.jsx:220` when `action` is null, `email.from.charAt(0)` at `EmailInbox.jsx:1193` — blanks the whole app to a white page with no recovery except a manual browser reload. For office software where staff live in this tool all day, this is the single highest-impact structural gap.

**Fix:** Add a top-level `<ErrorBoundary>` in `main.jsx` wrapping `<App/>` with a "Something went wrong — Reload" fallback, plus per-route boundaries inside `ProtectedLayout` so a broken page keeps the nav/sidebar usable. Optional-chain the six `.name`/`.from`/`.action` accesses listed above.

---

## C3. Zero automated tests, zero type safety
**Severity: CRITICAL** · `package.json:6-11`

```json
"scripts": { "dev": "vite", "build": "vite build", "lint": "eslint .", "preview": "vite preview" }
```
No test runner (`vitest`/`jest`), no `@testing-library/*`, no `.test.jsx`/`.spec.jsx` anywhere, no `playwright`/`cypress`. No TypeScript (`@types/react` is present in devDependencies but there is no `tsconfig.json` and every file is `.jsx`). No `prop-types` package, and **0** `Component.propTypes` declarations.

**Impact:** Nothing mechanically prevents regressions. C1 (a hard `ReferenceError` on the primary page) shipped and survived — that is the empirical proof. Every prop contract in the app (`<KeywordApprovalModal isOpen onClose onRuleUpdated/>`, `<Sidebar isOpen onClose/>`, `<Navbar onToggleSidebar/>`, `<CountUp end duration suffix prefix/>`) is undocumented and unenforced. With 10.6k lines and 1,800-line god components, refactoring is effectively unsafe.

**Fix:** In priority order: (1) run `eslint` in CI and make it blocking — this alone catches C1; (2) add Vitest + React Testing Library and cover the 5 riskiest flows (task create, task filter, email bulk-assign, user approve, login redirect); (3) migrate to TypeScript incrementally (`allowJs: true`, rename leaf components first) or at minimum add `prop-types` to the 8 components that take props.

---

## C4. Single 638 kB bundle — no code splitting, no lazy routes
**Severity: CRITICAL** · `src/App.jsx:3-18`, `vite.config.js`

All 12 routes are **statically imported** at the top of `App.jsx`:
```jsx
import Landing from './pages/Landing';
import Login from './pages/Login';
… (12 more)
```
Build output (verified by running `npx vite build`):
```
dist/assets/index-005V_ewq.js   637.96 kB │ gzip: 160.95 kB
(!) Some chunks are larger than 500 kB after minification.
```
`vite.config.js` contains only `plugins` + `server` — no `build.rollupOptions.manualChunks`, no chunking strategy.

**Impact:** A user landing on `/login` downloads, parses, and evaluates the entire admin Reports SVG charting engine, the 1,846-line TaskList, the 1,529-line EmailInbox, the full Landing page with its cursor/tilt effect libraries, **and** the entire `socket.io-client` runtime — before they can type a password. On a 4G office connection this is roughly 1.5–3 s of avoidable blocking work on every cold load. Employee-role users can never reach `/inbox`, `/reports`, or `/admin/*` yet still pay for all of them.

**Fix:**
```jsx
const TaskList = lazy(() => import('./pages/TaskList'));
const EmailInbox = lazy(() => import('./pages/EmailInbox'));
const Reports = lazy(() => import('./pages/admin/Reports'));
// … wrap <Routes> in <Suspense fallback={<PageSkeleton/>}>
```
Split at minimum: Landing (public, never needed after login), the three admin pages, EmailInbox, TaskList. Expect the initial chunk to drop below ~200 kB. Add `manualChunks: { vendor: ['react','react-dom','react-router-dom'], realtime: ['socket.io-client'] }`.

---

## C5. 128 Tailwind colour classes that generate no CSS at all
**Severity: CRITICAL (visual correctness)** · across all 22 `.jsx` files

`tailwind.config.js` extends exactly **three** custom shades:
```js
colors: { slate: { 450: '#8494a7' }, indigo: { 650: '#4338ca' }, emerald: { 55: '#ecfdf5' } }
```
But the JSX uses **33 distinct colour class names that do not exist** in either the default scale or the config, **128 times**. Verified empirically — I built the project and grepped the emitted CSS; every one of these produced **zero** rules:

| Class | Occurrences | Where it matters |
|---|---|---|
| `ring-indigo-150` | **40** | `focus:ring-indigo-150` on almost every form field app-wide |
| `text-slate-805` | **18** | `<select>` text in every modal |
| `border-indigo-505` | 8 | `focus:border-indigo-505` on Edit-User/Edit-Task fields |
| `border-indigo-550` | 5 | account filter, creator filter |
| `text-slate-850`, `text-red-650`, `ring-indigo-550`, `bg-slate-55` | 4 each | headings, overdue badges, hover states |
| `text-slate-750/550/455/755/655/405/855/650/605/350`, `text-red-550/655`, `text-purple-650`, `text-indigo-550`, `text-emerald-650` | 1–3 each | body copy, metadata, badges |
| `border-slate-150/250`, `border-emerald-150/250`, `border-red-150`, `border-amber-150/250`, `bg-slate-105/150` | 1–3 each | card and badge borders |

Plus 11 more non-existent non-colour utilities: `z-45` (`Sidebar.jsx:136`), `active:scale-98` ×3 (`Sidebar.jsx:198`, `TaskList.jsx:1525, 1802`), `w-4.5 h-4.5` ×2 (`TaskList.jsx:828, 842`), `shadow-xs` ×2 (`KeywordApprovalModal.jsx:210, 228`), `shadow-2xs` (`Reports.jsx:655` — a Tailwind **v4** name in a v3 project), `left-1/6 right-1/6` (`Landing.jsx:493`).

**Impact:**
- **Every focus ring in the app is the wrong colour.** `focus:ring-2 focus:ring-indigo-150` emits the width but not the colour, so `--tw-ring-color` falls back to Tailwind's default `rgb(59 130 246 / .5)` (blue). 40 fields render a blue ring in an indigo-branded product.
- 18 `<select>` elements inherit their parent's colour instead of the intended slate-800 → inconsistent contrast, some against light backgrounds.
- Badge borders silently vanish (`border-emerald-150`, `border-amber-150`, `border-red-150` on the deadline pills at `TaskList.jsx:576-583`), so overdue/at-risk/on-track badges lose their outline and read as flat fills.
- `z-45` means the sidebar has **no stacking context of its own**; it currently paints above the `z-40` backdrop only by DOM order. Any future reordering silently buries the mobile nav under its own scrim.
- The developer cannot tell any of this is broken because Tailwind fails silently.

**Fix:** Add the missing shades to `tailwind.config.js` (a 30-line `extend.colors` block) **or** — better — run a codemod snapping every off-scale value to the nearest legal shade (`150→100`, `505/550→500`, `650→600`, `805/850/855→800`, `750/755→700`, `55→50`). Then add `eslint-plugin-tailwindcss` with `no-custom-classname` so this class of bug is caught at lint time. Replace `shadow-2xs`→`shadow-sm`, `shadow-xs`→`shadow-sm`, `scale-98`→`scale-[0.98]`, `w-4.5 h-4.5`→`w-[1.125rem] h-[1.125rem]`, `z-45`→`z-40` (and lower the backdrop), `left-1/6 right-1/6`→`left-[16.666%] right-[16.666%]`.

---

## C6. Six CSS class names used 40+ times are defined nowhere
**Severity: CRITICAL (visual correctness)** · `index.css` vs. all pages

These are applied throughout the app but exist in **neither `index.css` nor Tailwind's default set** (Tailwind ships only `animate-spin/ping/pulse/bounce/none`). Verified against the built CSS — 0 rules each:

| Class | Files using it | What was intended |
|---|---|---|
| `animate-fade-in` | **9** | modal / page entrance animation |
| `animate-slide-in` | **7** | toast entrance |
| `skeleton-shimmer` | **7 files, 11 sites** | loading-skeleton shimmer |
| `hover-glow-card` | **4** | card hover glow |
| `animate-shake` | **3** | error-banner shake on Login/Register/ForgotPassword |
| `custom-scrollbar` | 1 | styled inner scrollbars |

Ironically `index.css:194` **does** define `.animate-shimmer` (with the correct gradient and `@keyframes shimmer`), but every call site writes `skeleton-shimmer`.

**Impact:** Every loading state renders as a **static blank white rectangle** with no motion — users cannot distinguish "loading" from "empty" or "frozen". Example, `TaskList.jsx:805-810`:
```jsx
{[...Array(5)].map((_, i) => (
  <div key={i} className="h-20 bg-white border border-slate-200/80 rounded-2xl p-5 skeleton-shimmer" />
))}
```
That is five inert grey boxes. Modals appear with a hard pop, toasts appear instantly with no slide, login errors don't shake. The app looks unfinished for reasons no one can find by reading the JSX.

**Fix:** Rename `skeleton-shimmer` → `animate-shimmer` (already implemented), and add the five missing definitions to `index.css` — the `@keyframes fadeInUp`/`fadeInDown` already exist at `index.css:155-163`, so `animate-fade-in` is a 3-line addition. Or define them as Tailwind `theme.extend.animation` entries so they're checkable.

---

# HIGH

## H1. God components: two files hold 3,375 lines of fetching + state + filtering + rendering + modals
**Severity: HIGH** · `pages/TaskList.jsx` (1,846), `pages/EmailInbox.jsx` (1,529)

`TaskList.jsx` holds **21 `useState` calls** and does, in one function body: localStorage cache hydration, task fetching, dropdown data fetching (clients + users + emails), create-task form state, edit-task form state, two independent client-autocomplete widgets with their own refs and outside-click handlers, comment CRUD, attachment download, calendar month-grid generation, drag-and-drop kanban with optimistic updates and rollback, three view modes (list/kanban/calendar), three filters, and two full inline modal implementations (lines 1339-1841 — **502 lines of modal JSX**).

`EmailInbox.jsx` holds **28 `useState` calls** and does: email fetching with debounced search, localStorage cache, Gmail account status + connect + disconnect, six category tabs, account filtering, pagination, bulk selection + bulk assign panel, reply composer, AI summarisation per-email, attachment download, per-email delete, clear-all, and a 108-line hand-built Excel/HTML export string (lines 394-501).

Neither file has a single extracted sub-component or custom hook.

**Impact:** No part of these files is independently testable or reusable. Any state change re-renders the entire tree including all modals. Merge conflicts are near-guaranteed with more than one developer. Reading the drag-and-drop logic requires scrolling past 600 lines of unrelated form state.

**Fix:** Extract, in order of payoff:
- `TaskList` → `<CreateTaskModal/>`, `<EditTaskModal/>`, `<TaskCalendar/>`, `<TaskKanban/>`, `<TaskCard/>`, `<TaskComments/>`, `<ClientAutocomplete/>` (used twice today, copy-pasted).
- `EmailInbox` → `<EmailRow/>`, `<BulkAssignBar/>`, `<AccountManagerPanel/>`, `<ReplyComposer/>`, `<AiSummaryPanel/>`, and move the export builder to `utils/exportEmails.js`.
Target: no page file over 300 lines.

## H2. No state management — `localStorage` is the de-facto global store, read 12 times and never synchronised
**Severity: HIGH** · 12 sites, listed below

There is no Context, no store, no query cache. The current user is re-read and re-`JSON.parse`d from `localStorage` independently in **12 places**: `ProtectedLayout.jsx:16`, `AdminRoute.jsx:11`, `NotificationBell.jsx:16`, `Sidebar.jsx:8` and `:18`, `Navbar.jsx:18`, `Dashboard.jsx:45`, `ClientList.jsx:47`, `ManageUsers.jsx:37`, `EmailInbox.jsx:166`, `TaskList.jsx:120` and `:216`. Each has its own bespoke try/catch and its own default (`{ name: 'Guest', role: 'Employee' }` in three places, `{ role: 'Employee' }` in one, `null` in two).

Server data is cached ad-hoc under 7 hand-rolled localStorage keys with no TTL, no versioning, and no invalidation: `cached_tasks_data`, `cached_inbox_emails`, `cached_clients_data`, `cached_dashboard_stats`, `cached_dashboard_tasks`, `cached_reports_overall`, `cached_reports_timeline`.

**Concrete resulting bug — stale Navbar:** `Profile.jsx:113` and `ProtectedLayout.jsx:40` both do `window.dispatchEvent(new Event('storage'))` after updating the user. `Sidebar.jsx:28` listens for it and updates. **`Navbar.jsx` does not listen** — it reads `localStorage.getItem('user')` inline during render (`Navbar.jsx:18-26`) with no subscription. So after a user edits their own name in Profile, the sidebar card updates and the navbar avatar/name stays stale until a full page reload. Two components display the same data and disagree.

**Impact:** Role/identity truth is duplicated 12 ways, each with a different failure mode; cache invalidation is manual and already inconsistent; there's no way to add "refetch on window focus", request de-duplication, or a global 401 handler.

**Fix:** Introduce `AuthContext` (`useAuth()`) as the single source of truth for the current user, and adopt TanStack Query for all server state — it replaces all 7 cache keys, all the `fetchX` + `loading` + `error` triplets, and the manual `setLoading(prev => …)` hacks (see H8) with `useQuery`. If a library is off the table, at minimum build `useCurrentUser()` and `useApi()` custom hooks; there are currently **zero** custom hooks in the codebase.

## H3. Zero component reuse — every button, input, modal, badge and toast is re-implemented inline
**Severity: HIGH** · counted across all 22 `.jsx` files

There is no `components/ui/` directory. Measured duplication:

| Pattern | Count | Evidence |
|---|---|---|
| `<button>` elements written from scratch | **117** | — |
| Primary-gradient button class string `bg-gradient-to-r from-indigo-600 to-purple-600` | **16** verbatim copies | Landing, TaskList ×4, EmailInbox ×3, Profile ×2, ClientList, Reports … |
| Input class string `px-4 py-3 bg-white border border-slate-200 rounded-xl` | **37** verbatim copies | every form in the app |
| Label class string `block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1` | **28** verbatim copies | — |
| Card class string `bg-white border border-slate-200 rounded-2xl` | **15** verbatim copies | — |
| Cancel-button class string `w-1/2 py-3 px-4 border border-slate-200 hover:bg-slate-50` | **7** verbatim copies | — |
| Full modal overlay (`fixed inset-0 z-50 … bg-black/40 backdrop-blur`) | **11** hand-rolled | KeywordApprovalModal, TaskList ×2, ClientList ×3, ManageUsers ×5 |
| Toast/alert block (`fixed top-20 right-4 z-50` + success/error svg branch) | **6** near-identical ~18-line blocks | TaskList:658, EmailInbox:658, Dashboard:160, ManageUsers:313, ActivityLog:102, Reports:258, Profile:188 |
| Inline `<svg>` icons | **118** | the same X-close path `M6 18L18 6M6 6l12 12` appears **10 times** |
| Spinner svg `animate-spin h-5 w-5 text-white` | **6** identical 4-line copies | — |
| `<table>` built from scratch | **7** | ManageUsers ×2, ClientList, Reports ×3, ActivityLog |

Duplicated **logic** helpers, copy-pasted verbatim:

| Helper | Copies | Locations |
|---|---|---|
| `getInitials` | **6** | Navbar:34, Sidebar:39, Profile:157, ManageUsers:269, TaskList:563, ActivityLog:83 |
| `triggerAlert` | **7** | TaskList:184, EmailInbox:333, Dashboard:100, Profile:29, ManageUsers:49, ActivityLog:21, Reports:63 |
| `formatDate` | **4** | TaskList:515, EmailInbox:635, Profile:162, ActivityLog:43 |
| `renderEmailContent` | **2** (and they have **diverged**) | EmailInbox:6, TaskList:15 — TaskList's version strips `<script>` tags, EmailInbox's does not |
| `handleDownloadAttachment` | **2** identical | TaskList:411, EmailInbox:601 |

**Impact:** The `renderEmailContent` divergence is the clearest cost — a hardening fix was applied to one copy and not the other, so the two email renderers behave differently. Any design change (button radius, brand colour, focus style) requires 117 edits. This is also the direct cause of C5 and C6 spreading so widely: a broken class string got copy-pasted 40 times.

**Fix:** Build `components/ui/{Button,Input,Select,Textarea,Label,Modal,Badge,Card,Table,Toast,Spinner,Icon}.jsx` and `hooks/{useToast,useCurrentUser,useOutsideClick}.js`, plus `utils/format.js` for `getInitials`/`formatDate` and `utils/email.js` for the single `renderEmailContent`. This is a ~1-day change that removes several thousand duplicated lines.

## H4. 22 React Hooks rule violations that ESLint classifies as *errors*
**Severity: HIGH** · verified via `npx eslint .`

**`react-hooks/set-state-in-effect` — 9 errors** (synchronous `setState` inside an effect → guaranteed double render on every mount):
`NotificationBell.jsx:62`, `ClientList.jsx:79`, `Dashboard.jsx:96`, `EmailInbox.jsx:81` and `:170`, `TaskList.jsx:123`, `:138`, `:155`, `ManageUsers.jsx:40`.

`EmailInbox.jsx:80-82` is a pure waste — it exists only to reset pagination:
```jsx
useEffect(() => { setCurrentPage(1); }, [searchQuery, selectedAccount, activeTab]);
```
This should be derived, not an effect: `currentPage` can be reset in the same handlers that change `searchQuery`/`selectedAccount`/`activeTab`, avoiding a full extra render of a list of up to 100 email rows on every keystroke.

`TaskList.jsx:119-130` is the classic "effect that should be an initialiser":
```jsx
useEffect(() => {
  const userString = localStorage.getItem('user');
  if (userString) { try { setCurrentUser(JSON.parse(userString)); } catch … }
  fetchTasks(); fetchDropdownData();
}, []);
```
`currentUser` is available synchronously — it belongs in `useState(() => …)` like `tasks` already is at line 27. As written, the first render shows `{name:'Guest', role:'Employee'}`, which means Employees briefly see the Admin UI (the Create Task button is gated on `currentUser.role !== 'Employee'` at line 725) and Admins briefly see the Employee copy at line 679.

**`react-hooks/immutability` — 22 errors** ("Cannot access variable before it is declared"): every `useEffect` that calls a `fetchX` function declared *below* it. `TaskList.jsx:128, 129, 140`; `EmailInbox.jsx:173, 183, 188, 189, 190`; `Reports.jsx:55-60` (six in one effect); `ManageUsers.jsx:45, 46`; `Dashboard.jsx:70`; `Profile.jsx:26`; `ActivityLog.jsx:18`; `NotificationBell.jsx:29`; `KeywordApprovalModal.jsx:42`; `countUp.jsx:14`.

**`react-hooks/exhaustive-deps` — 15 warnings**, of which two are genuine bugs, not noise (see H5).

**`react-hooks/refs` — 1 error**, `Landing.jsx:12`:
```jsx
const featureCardRefs = useRef([]);
featureCardRefs.current = [];   // ← ref mutation during render
```
This wipes the ref array on **every** render. It survives only because `addToFeatureRefs` is a new function identity each render, so React detaches and re-attaches all six ref callbacks. When `setStats` lands from the API call (`Landing.jsx:40`), all six tilt handlers are re-registered — and the six `initTilt` cleanups captured in `cleanupsFeature` at line 62 now point at a stale array, so the original `mousemove`/`mouseleave` listeners are **never removed**.

**`react-hooks/error-boundaries` — 1 error**, `AdminRoute.jsx:22`: JSX (`<Navigate/>`) constructed inside a `try/catch`.

**Fix:** Hoist `fetchX` declarations above their effects (or wrap in `useCallback` and list them as deps); convert the three initialise-from-localStorage effects to lazy `useState` initialisers; convert `EmailInbox.jsx:80` to event-handler resets; move `featureCardRefs.current = []` out of the render body.

## H5. Two `useEffect` dependency bugs cause repeated network fetches and spurious modal opens
**Severity: HIGH**

**(a) `TaskList.jsx:148-168` — effect keyed on the wrong value**
```jsx
useEffect(() => {
  const params = new URLSearchParams(location.search);
  const linkEmail = params.get('linkEmail');
  …
  if (linkEmail) { setNewTask(…); setIsCreateOpen(true); navigate('/tasks', { replace: true }); }
}, [tasks]);            // ← reads location.search and navigate, depends on tasks
```
The effect reads `location.search` but is keyed on `tasks`. It therefore re-runs on **every** task list refetch (`fetchTasks` is called after create, edit, delete, mark-complete, and kanban drop — 5 code paths). ESLint flags exactly this: *"missing dependencies: 'location.search' and 'navigate'"*.

**(b) `TaskList.jsx:133-145` — same class of bug, one page over**
```jsx
}, [location.search, tasks, loading]);   // reads commentMap, navigate — not listed
```
`tasks` in the dep array means the expand-from-notification logic re-evaluates on every refetch.

**(c) `EmailInbox.jsx:188` + `:193-209` — duplicate initial fetch on every mount**
The mount effect calls `loadEmails('')`. A second effect keyed on `[searchQuery]` fires 400 ms later and calls `loadEmails('')` again with the same empty query. **Every visit to `/inbox` issues two identical `GET /gmail/emails` requests.**

Worse, that same effect re-creates a 5-minute `setInterval` on **every keystroke**:
```jsx
useEffect(() => {
  const timer = setTimeout(() => loadEmails(searchQuery), 400);
  const fiveMinInterval = setInterval(() => { … }, 5 * 60 * 1000);
  return () => { clearTimeout(timer); clearInterval(fiveMinInterval); };
}, [searchQuery]);
```
The auto-refresh timer resets to zero on each character typed, so a user who searches regularly never receives the 5-minute auto-refresh at all. The debounce and the polling interval have completely different lifetimes and must not share an effect.

**Fix:** Split the interval into its own `useEffect(…, [])` using a ref for the current query. Guard the mount fetch so the debounce effect skips its first run (`const isFirst = useRef(true)`). Key effect (a) on `location.search` only.

## H6. Filter/derive work is O(42n) per render on the two hottest pages, with zero memoisation
**Severity: HIGH** · `TaskList.jsx:860-861`, `EmailInbox.jsx:65-163`

`grep -rn "useMemo\|useCallback\|React.memo"` → **0 hits in the entire codebase.**

**EmailInbox** recomputes on *every* render — including on every keystroke in the search box, because `setSearchQuery` re-renders the whole 1,529-line component:
- `uniqueAccounts` (lines 65-74): 2 full `.map()` passes over `emails` + a `Set` build + `.filter(Boolean)`.
- `getFilteredEmails()` (line 158): 1 full pass.
- `getTabCount()` called **6 times** in the tab bar (lines 854, 870, 886, 902, 918, 934): 6 full passes.
- Accounts panel (lines 1014, 1051): 1 `.filter()` per connected account.

That is **≥9 complete traversals of the email array per render**. At 5,000 emails and a 20-character search query that is ~900,000 array iterations plus 9 intermediate arrays allocated — during typing, on the UI thread.

**TaskList calendar view** (line 860-861) is worse:
```jsx
{getDaysInMonth(currentDate).map(({ day, month, year, isCurrentMonth }, idx) => {
  const dayTasks = filteredTasks.filter((task) => isSameDay(task.deadline, year, month, day));
  const isToday   = isSameDay(new Date().toISOString(), year, month, day);
```
`getDaysInMonth` always returns **42** cells, and each cell runs a full `.filter()` over `filteredTasks`, and `isSameDay` allocates a `new Date()` per task per cell. That's **42 × n** filter iterations and **42 × n** `Date` allocations per render, plus 42 more `new Date().toISOString()` calls. With 500 tasks: 21,000 Date objects constructed every time the component re-renders — and it re-renders on every comment keystroke, because `commentInput` is a single top-level state shared across all task rows (`TaskList.jsx:54`, used at `:1239`).

Kanban view (line 935) is 3 × n. `taskCreators` (line 541) builds a `Map` from a full pass on every render.

**Impact:** Typing in the inbox search box or a task comment becomes visibly janky well before the data volumes an office inbox reaches. There is no virtualisation anywhere either (see H7).

**Fix:** Wrap `filteredEmails`, `uniqueAccounts`, `taskCreators`, `filteredTasks`, `filteredClients`, `filteredEditClients`, `actionTypes`, `activeUsers`, `filteredLogs` in `useMemo`. Replace the 6 `getTabCount` calls with **one** `useMemo` that produces a `{inbox, sent, promotions, social, updates, spam}` counts object in a single pass. Pre-bucket calendar tasks into a `Map<'YYYY-MM-DD', Task[]>` once per render instead of 42 filters. Move `commentInput` into an extracted `<TaskComments>` component so typing a comment doesn't re-render 500 task cards.

## H7. No list virtualisation — the inbox and task list render every row into the DOM
**Severity: HIGH** · `EmailInbox.jsx:1191`, `TaskList.jsx:1023`, `ManageUsers.jsx:382`, `ActivityLog.jsx:204`, `ClientList.jsx:334/431`

`EmailInbox` at least paginates (25/50/100 per page, `EmailInbox.jsx:76-78, 160-163`) — good. But:
- **`TaskList` has no pagination and no virtualisation.** `filteredTasks.map(...)` (line 1023) renders every task; each row is ~150 lines of JSX with an avatar, 4 badges, a chevron, and — when expanded — an `<iframe>` and a comments list. 1,000 tasks = 1,000 fully-materialised cards.
- **`ManageUsers`** renders every user row (line 382), **`ActivityLog`** every log row (line 204) — activity logs grow unbounded by definition, and `GET /users/activity-logs` fetches all of them with no `limit`.
- **`ClientList`** renders every client in both table (line 334) and card grid (line 431) modes.
- **Kanban** (`TaskList.jsx:966`) renders all three columns' full contents inside `max-h-[700px] overflow-y-auto` — scrolled, not virtualised.

**Impact:** `/admin/activities` will degrade to an unusable multi-second render as the audit trail accumulates — this is the page most likely to have tens of thousands of rows in a year of office use.

**Fix:** Add `@tanstack/react-virtual` (~4 kB) to `ActivityLog` and `TaskList` list mode, or add the same pagination bar `EmailInbox` already has to `TaskList`, `ClientList`, `ManageUsers`, and `ActivityLog`. Ask the API for server-side pagination on activity logs.

## H8. `setLoading(prev => …)` misused as a plain setter in 3 files
**Severity: HIGH (correctness smell)** · `TaskList.jsx:192`, `ClientList.jsx:59`, `Dashboard.jsx:57`

```jsx
setLoading(prev => tasks.length === 0 ? true : false);           // TaskList:192
setLoading(prev => clients.length === 0 ? true : false);          // ClientList:59
setStatsLoading(prev => !overallStats && tasks.length === 0 ? true : false);  // Dashboard:57
```
The `prev` parameter is declared and never read — ESLint flags all three as `no-unused-vars`. These are not functional updates; they are plain assignments dressed as one, and they close over `tasks`/`clients`/`overallStats` from the render scope, so they read **stale values** if the updater is deferred. `x ? true : false` is also just `x`.

**Impact:** Reads as though it handles concurrent updates when it does not. In `Dashboard` the closure over both `overallStats` and `tasks` inside a functional updater is exactly the stale-closure shape that breaks under React 18+ concurrent rendering.

**Fix:** `setLoading(tasks.length === 0)`.

## H9. Landing page runs a 10 Hz DOM-mutating `setInterval` forever
**Severity: HIGH (performance)** · `pages/Landing.jsx:92-100`

```jsx
const handleScrollReveal = () => {
  const activeEls = document.querySelectorAll('.reveal-on-scroll.active, .reveal-stagger-child > *.active');
  activeEls.forEach((el) => { el.style.opacity = '1'; el.style.transform = 'translateY(0px)'; });
};
const interval = setInterval(handleScrollReveal, 100);
```
Ten times per second, for as long as the page is open, this performs a document-wide `querySelectorAll` and writes inline styles to every matched element. The writes are unconditional — they set the same values over and over. Because inline `style` writes invalidate layout, and the same loop is running alongside the custom-cursor `requestAnimationFrame` loop (H10), this is continuous forced style recalculation on the app's public landing page.

Additionally, the IntersectionObserver at line 72 already adds `.active` and unobserves — the interval exists only because the CSS for `.reveal-on-scroll` was never written (it isn't in `index.css`; see C6), so the author patched around a missing stylesheet rule with a polling loop.

**Fix:** Delete the interval entirely and add the two missing CSS rules:
```css
.reveal-on-scroll { opacity:0; transform:translateY(24px); transition:opacity .8s, transform .8s; }
.reveal-on-scroll.active { opacity:1; transform:none; }
```
Also delete the JS that stamps inline `opacity/transform/transition` on every element at lines 84-89.

## H10. Cursor/tilt effect utilities cause continuous layout thrash and leak listeners
**Severity: HIGH (performance)** · `utils/cursorEffects.js` (247 lines), `utils/tiltEffect.js` (113 lines), `utils/scrollAnimations.js` (59)

**`cursorEffects.js`** (active on `/` Landing, `Landing.jsx:32`) registers **seven** global listeners — two of them separate `mousemove` handlers:
```js
window.addEventListener('mousemove', onMouseMove);          // line 72
window.addEventListener('mousemove', onMouseMoveMagnetic);  // line 196
```
`onMouseMoveMagnetic` (lines 162-194) calls `e.target.closest(...)` then **`getBoundingClientRect()`** and immediately writes `button.style.transform` — a read-then-write on every single mouse move event, which is the textbook forced synchronous layout. It also mutates arbitrary DOM elements' inline `transform`, directly fighting the Tailwind `hover:scale-[1.02]` / `hover:-translate-y-0.5` classes on those same buttons (`Landing.jsx:132, 175, 181`).

The `requestAnimationFrame` loop (lines 76-115) writes `style.transform` to **7 elements** (dot + ring + 5 trail dots) every frame, unconditionally, even when the mouse is idle — 60 fps × 7 style writes forever.

`index.css:11-19` sets `cursor: none !important` on body, buttons, links, selects, **inputs**, textareas and labels while active. If the rAF loop stalls or the cleanup path is missed, the user has no cursor at all.

**`tiltEffect.js`** (active on Landing ×7 elements and Dashboard on every stat card, `Dashboard.jsx:39`): `onMouseMove` (lines 33-63) calls `getBoundingClientRect()` and then writes `style.transform`, `style.transition`, and rebuilds a `radial-gradient` **string** for the glare on every mouse move. It also permanently mutates the host element: `element.style.overflow = 'hidden'` (line 27) and injects a `.tilt-glare` div (line 29).

**Leak, `Dashboard.jsx:35-42`:**
```jsx
useEffect(() => {
  let cleanups = [];
  if (!statsLoading && containerRef.current) {
    const cards = containerRef.current.querySelectorAll('.tilt-stat-card');
    cleanups = Array.from(cards).map(card => initTilt(card, 5, 800));
  }
  return () => cleanups.forEach(c => c());
}, [statsLoading, overallStats, tasks]);
```
`overallStats` and `tasks` are **new object/array identities on every fetch**, so this effect tears down and re-initialises tilt on all six cards on each poll. `initTilt` guards the glare div by `querySelector` so it isn't duplicated, but `element.style.overflow='hidden'` is re-applied and never reverted by the cleanup (line 83-88 removes listeners and the glare, but not `overflow`, `transition`, `transformStyle`, or `position`).

**`scrollAnimations.js`** (mounted app-wide from `App.jsx:22`) is **pure overhead**:
```js
const mutationObserver = new MutationObserver(() => { observeElements(); });
mutationObserver.observe(document.body, { childList: true, subtree: true });
```
A `MutationObserver` on the **entire document body with `subtree: true`**, whose callback runs `document.querySelectorAll('.reveal-element, .reveal-element-left, .reveal-element-right, .stagger-reveal, .count-up-trigger')` on every DOM mutation anywhere in the app. Verified: **none of those five class names appears in any `.jsx` file** — they exist only in `index.css` and in this selector string. So on every React commit in the whole application, a document-wide query runs and finds nothing.

**Fix:** (1) Delete `initScrollAnimations` from `App.jsx` — it does nothing but cost. (2) Merge the two `mousemove` handlers into one and move all `getBoundingClientRect`/style writes inside the existing `requestAnimationFrame` loop; cache rects on `mouseenter` instead of per-move. (3) Skip the rAF loop when the pointer hasn't moved. (4) Gate all three on `matchMedia('(prefers-reduced-motion: reduce)')` and on `(pointer: fine)` — see A9. (5) In `Dashboard`, key the tilt effect on `[statsLoading]` only. (6) Restore `overflow`/`position` in `initTilt`'s cleanup.

## H11. `CountUp` triggers ~90 re-renders per counter; Landing mounts 4, Dashboard mounts up to 6
**Severity: HIGH (performance)** · `utils/countUp.jsx:41-58`

```jsx
const step = (timestamp) => {
  …
  setCount(currentVal);                       // setState on EVERY animation frame
  if (progress < 1) window.requestAnimationFrame(step);
  else setCount(endVal);
};
```
`duration` defaults to 1.5 s → ~90 frames → **~90 `setState` calls and 90 React re-renders per counter instance**. `Landing.jsx:310, 319, 328, 337` mounts four; `Dashboard.jsx` mounts four (Employee) or six (Admin/Head) at lines 240, 254, 268, 282 / 298, 312, 326, 340, 354, 368. On the Dashboard that's **~540 re-render cycles** in 1.5 seconds, concurrent with the tilt-effect rAF loop from H10.

Two further defects in the same 74-line file:
- **Stale-closure guarantee, line 30:** deps are `[end, duration]`, but the effect calls `startCountAnimation` which is declared *below* it at line 32 and closes over `end`. ESLint reports both `react-hooks/immutability` (line 14, *"accessed before it is declared"*) and `exhaustive-deps` (line 30). When `end` changes from the cached `0`/placeholder to the real API value, the observer has already fired and `animationTriggered.current` is `true` — **the counter animates to the stale value and never updates.** On `Landing.jsx:14-21` the initial state is hardcoded fake numbers (`totalEmails: 1248`), so if the observer fires before the API responds, the landing page permanently displays invented statistics.
- **Cleanup bug, line 26:** `if (elementRef.current) observer.disconnect()` reads `elementRef.current` at teardown, when React has already nulled it — ESLint warns explicitly. The observer is then never disconnected.
- The `requestAnimationFrame` is never cancelled on unmount → `setState` on an unmounted component if the user navigates mid-animation.

**Fix:** Throttle to ~20 updates/sec, or better, animate with CSS/`ref.textContent` and keep the value out of React state entirely. Move `startCountAnimation` above the effect (or into it). Store the rAF id in a ref and `cancelAnimationFrame` in cleanup. Copy `elementRef.current` to a local before the cleanup closure. Reset `animationTriggered.current` when `end` changes.

## H12. `/auth/me` polled every 8 seconds for every logged-in user, forever
**Severity: HIGH** · `components/ProtectedLayout.jsx:55-59`

```jsx
checkUserRoleAndStatus();
const interval = setInterval(checkUserRoleAndStatus, 8000);   // "minimal server load"
```
**450 requests/hour/user**, 3,600 per 8-hour workday per seat, regardless of tab visibility. A 20-person office = 72,000 requests/day just to detect a role change. The comment claims "minimal server load."

Worse, the handler at line 33 calls `window.location.reload()` on any role change — a **full page reload** that discards all unsaved form state. If a user is mid-way through the Create Task modal (a 10-field form) when an admin flips their role, everything they typed is lost with no warning. Lines 25 and 49 similarly use `window.location.href = '/login'` — a hard navigation that throws away the SPA and re-downloads the whole 638 kB bundle, instead of `navigate('/login')`.

**Fix:** Move role/status invalidation onto the **existing socket connection** (`NotificationBell.jsx:33` already holds an authenticated socket to the same server) — push a `session:invalidated` event instead of polling. Failing that: back off to 60 s and pause on `document.hidden`. Replace `window.location.reload()` with router-level state refresh, and `window.location.href` with `navigate()`.

## H13. Every one of the 11 modals is inaccessible: no focus trap, no focus restore, no ESC, no ARIA
**Severity: HIGH (accessibility — this is enterprise software)** · 11 sites

Verified across the codebase: **`role="dialog"`: 0. `aria-modal`: 0. `Escape` key handling: 0 (`grep -rn "Escape" src/` → no matches). `tabIndex`: 0. Focus restore on close: 0.**

The 11 hand-rolled modals are: `KeywordApprovalModal.jsx:177`; `TaskList.jsx:1339` (Create Task), `:1543` (Edit Task); `ClientList.jsx:554` (Add), `:693` (Edit), `:823` (Delete); `ManageUsers.jsx:580` (Add User), `:673` (Edit User), `:849` (Delete User), `:885` (Add Client), `:949` (Edit Client).

Representative markup — `TaskList.jsx:1339-1341`:
```jsx
<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md p-4 overflow-y-auto">
  <div className="bg-white/95 … rounded-3xl max-w-lg w-full p-6 relative … select-none">
```
Two plain `div`s. Consequences for a keyboard or screen-reader user:
1. Focus stays on the button behind the modal; the first Tab goes to page content **behind** the overlay, which is still fully reachable.
2. Nothing announces that a dialog opened — a screen reader user has no idea the context changed.
3. **ESC does nothing.** The only way out is to visually locate and click the X.
4. On close, focus is lost to `<body>`; the next Tab restarts from the top of the page.
5. The `ClientList` and `ManageUsers` delete-confirmation dialogs don't autofocus Cancel, so a user pressing Enter after opening them has no safe default.
6. `select-none` on the modal body blocks text selection, so users cannot copy an error message or a client's email out of the dialog.

**Fix:** Build one `<Modal>` component that: renders through a portal; sets `role="dialog" aria-modal="true" aria-labelledby={titleId}`; traps Tab within the panel; closes on `Escape`; stores `document.activeElement` on open and restores it on close; autofocuses the first field (or Cancel for destructive dialogs); and applies `inert`/`aria-hidden` to `#root` while open. Replacing 11 copies with this component fixes every issue at once.

## H14. 64 of 70 form labels are not associated with their inputs
**Severity: HIGH (accessibility)** · app-wide

`<label>` appears **70** times; `htmlFor` appears **6** times — and all six are in the three auth pages (`Login.jsx:87, 103`, `Register.jsx:110, 126, 142`, `ForgotPassword.jsx:89`). Every label inside the application proper is orphaned. Example, `ManageUsers.jsx:609-617`:
```jsx
<label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Email Address</label>
<input type="email" required placeholder="john@example.com" … />
```
No `id`, no `htmlFor`, not wrapped, no `aria-label`, no `aria-labelledby`.

**Impact:** Screen readers announce these as "edit text, blank" with no field name — the Add User, Edit User, Create Task, Edit Task, Add Client, and Edit Client forms are effectively unusable non-visually. Clicking a label doesn't focus its input, which also hurts sighted mouse users. This is a WCAG 2.1 **Level A** failure (1.3.1 Info and Relationships, 4.1.2 Name Role Value) — for enterprise/government procurement this is typically a hard blocker.

**Fix:** Add matching `id`/`htmlFor` pairs. Easiest durable route: the shared `<Input label="…">` component from H3 generates a `useId()`-based pair automatically, fixing all 64 in one change.

## H15. Icon-only buttons have no accessible name
**Severity: HIGH (accessibility)** · ~20 sites

There is exactly **one** `aria-label` in 10,643 lines, and it's placed on the decorative `<svg>` rather than on the button that needs it (`NotificationBell.jsx:155`). The button wrapping it (line 149) has no name at all — a screen reader announces the entire notification centre as "button".

Unnamed icon-only buttons include: hamburger menu (`Navbar.jsx:55`), sidebar close X (`Sidebar.jsx:152`), 10 modal close X buttons (the `M6 18L18 6M6 6l12 12` path, 10 occurrences), calendar prev/next month (`TaskList.jsx:824, 838`), email delete (`EmailInbox.jsx:1262`), search clear × (`EmailInbox.jsx:829`), comment delete × (`TaskList.jsx:1222`), client edit/delete icon buttons (`ClientList.jsx:399, 409`), rule delete (`KeywordApprovalModal.jsx:448`).

A handful use `title=` (`ClientList.jsx:402, 412`, `TaskList.jsx:1225`, `EmailInbox.jsx:1272`) which gives a tooltip but is unreliable as an accessible name and invisible to touch users. Also: `alt=` appears **0** times and `sr-only` **0** times.

**Fix:** `aria-label` on every icon-only `<button>`, `aria-hidden="true"` + `focusable="false"` on every decorative `<svg>` (118 of them).

## H16. Interactive `div`s: not focusable, not keyboard-operable, wrong semantics
**Severity: HIGH (accessibility)** · 8 sites

`onClick` on non-interactive elements, with **0** `tabIndex` and only **1** `onKeyDown` in the whole app:
- `TaskList.jsx:1035` — the **task card header**, the primary expand/collapse control of the Tasks page.
- `TaskList.jsx:865` — each of 42 calendar day cells (opens Create Task).
- `TaskList.jsx:913` — each task chip inside a calendar cell (opens Edit Task).
- `TaskList.jsx:1400` and `:1616` — client autocomplete suggestion rows (both copies).
- `TaskList.jsx:971` — kanban cards.
- `EmailInbox.jsx:1203` — the **email row header**, the primary expand control of the Inbox.
- `NotificationBell.jsx:189` — each notification item (navigates on click).
- `Sidebar.jsx:128` — the mobile backdrop.

None can be reached by Tab; none respond to Enter or Space; screen readers announce them as plain text. **A keyboard-only user cannot open a task or read an email.** These are the two core interactions of the product.

The autocomplete dropdowns (`TaskList.jsx:1394`, `:1610`) additionally implement no combobox pattern — no `role="combobox"`, `aria-expanded`, `aria-activedescendant`, and no arrow-key navigation.

**Fix:** Convert to `<button type="button">` with the card styling (or add `role="button" tabIndex={0} onKeyDown={e => (e.key==='Enter'||e.key===' ') && handler()}`). For the accordions add `aria-expanded` and `aria-controls`. Implement the ARIA combobox pattern for the two autocompletes.

## H17. Focus indicator removed in 60 places, and the replacement ring is broken
**Severity: HIGH (accessibility)** · 60 sites

`focus:outline-none` appears **60** times; `focus-visible` appears **once**. Most sites pair it with `focus:ring-2 focus:ring-indigo-150` — but `ring-indigo-150` **does not exist** (C5), so the ring falls back to Tailwind's default blue. And several sites remove the outline with **no** replacement at all: `Navbar.jsx:57` (hamburger), `NotificationBell.jsx:151` (bell) and `:174` (Mark all as read), `ManageUsers.jsx:289` and `:299` (the Users/Clients sub-tabs).

**Impact:** Keyboard users lose the focus indicator entirely on those controls, and get an off-brand blue ring on the other 55. WCAG 2.1 **2.4.7 Focus Visible** (Level AA) failure.

**Fix:** Replace `focus:outline-none` with `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2` globally, and never strip the outline without a replacement.

## H18. `KeywordApprovalModal` is the only dark-mode-aware component in the app
**Severity: HIGH (styling correctness)** · `components/KeywordApprovalModal.jsx` — 32 lines with `dark:` classes

`tailwind.config.js` sets **no `darkMode` key**, so Tailwind 3 defaults to `darkMode: 'media'` — `dark:` variants activate automatically from the OS setting. I confirmed the built CSS contains exactly one `prefers-color-scheme` block, produced entirely by this file.

`KeywordApprovalModal.jsx:178`:
```jsx
<div className="… bg-white dark:bg-slate-800 … border-slate-200 dark:border-slate-700 …">
```

**Impact:** On any machine set to dark mode — the default on most modern OS installs — the Keyword Rules modal renders dark-on-dark while the entire rest of the application (11 other modals, every page, the navbar, the sidebar) stays hard-coded light. The result is a visibly broken, half-themed dialog on a large share of office machines. Nobody testing on a light-mode machine will ever see it.

**Fix:** Either strip all 32 `dark:` lines from this component (fastest, restores consistency), or set `darkMode: 'class'` in `tailwind.config.js` so the variants are inert until a theme toggle is built. Do not leave it on `media`.

## H19. Desktop layout: sidebar is 20 px wider than the space reserved for it
**Severity: HIGH (styling)** · `components/ProtectedLayout.jsx:68` vs `components/Sidebar.jsx:136`

```jsx
<div className="relative pt-16 lg:pl-60">        {/* ProtectedLayout — 15rem = 240px */}
```
```jsx
className="fixed top-16 left-0 bottom-0 w-[260px] …"   {/* Sidebar — 260px */}
```
`lg:pl-60` reserves **240 px**; the fixed sidebar occupies **260 px**.

**Impact:** At every viewport ≥1024 px the sidebar overlaps the left 20 px of the main content area. On a 1366 × 768 office laptop this clips the leading edge of page headings, the first table column, and the left border of cards on every authenticated page. It is subtle enough to read as "slightly off" rather than broken, which is why it has survived.

**Fix:** Change to `lg:pl-[260px]` (or set the sidebar to `w-60`). Better: define the width once as a CSS custom property or a Tailwind theme token so the two can't drift again.

---

# MEDIUM

## M1. 9 `window.confirm()` and 3 `alert()` calls for destructive operations
**Severity: MEDIUM (UX / professionalism)**

**`window.confirm()` — 9 calls, 7 files:**
| File:line | Action gated |
|---|---|
| `TaskList.jsx:350` | permanently delete a task |
| `EmailInbox.jsx:318` | disconnect a Gmail account (deletes all its emails) |
| `EmailInbox.jsx:550` | **clear ALL emails in the workspace** |
| `EmailInbox.jsx:571` | delete a single email |
| `Dashboard.jsx:121` | disconnect Gmail |
| `Profile.jsx:88` | disconnect Gmail sync |
| `ManageUsers.jsx:236` | permanently delete a client |
| `KeywordApprovalModal.jsx:108` | delete a keyword rule |
| `KeywordApprovalModal.jsx:152` | bulk-approve all pending emails |

**Bare `alert()` — 3 calls:**
- `ClientList.jsx:172` — `alert(err.response?.data?.message || 'Failed to delete client')`. A raw browser alert is the **only** error feedback in the entire client-delete path, even though this component already has a `formError` state and styled banner (line 566).
- `TaskList.jsx:639` and `:650` — inside a dead ternary: `triggerAlert ? triggerAlert(...) : alert(...)`. `triggerAlert` is a `const` declared at line 184 and is always truthy, so the `alert()` branch is unreachable. Dead code that looks like a live fallback.

**Impact:** Native dialogs are unstyled, block the entire browser tab, cannot be tested, cannot show rich content, and look like malware to non-technical office staff. Note the inconsistency: `ManageUsers` deletes a **user** through a nicely styled modal (line 849) but deletes a **client** via `window.confirm` (line 236) — two adjacent actions in the same file with completely different UX. And "Clear ALL Emails" — the single most destructive action in the product — is gated by a browser confirm.

**Fix:** One `<ConfirmDialog>` component (which `ManageUsers`/`ClientList` already prove the design for), used for all 9. Delete the dead ternary in `TaskList`. Route the `ClientList` delete error into the existing `formError` banner.

## M2. 80 `console.*` calls left in production code
**Severity: MEDIUM** · 18 files

| File | Count |
|---|---|
| `pages/EmailInbox.jsx` | 15 |
| `pages/TaskList.jsx` | 12 |
| `pages/admin/ManageUsers.jsx` | 10 |
| `pages/admin/Reports.jsx` | 6 |
| `pages/Profile.jsx` | 6 |
| `pages/Dashboard.jsx` | 6 |
| `components/NotificationBell.jsx` | 6 |
| `pages/ClientList.jsx` | 5 |
| `components/KeywordApprovalModal.jsx` | 5 |
| `pages/admin/ActivityLog.jsx`, `Register.jsx`, `Login.jsx`, `Landing.jsx`, `ForgotPassword.jsx`, `Sidebar.jsx`, `ProtectedLayout.jsx`, `Navbar.jsx`, `AdminRoute.jsx` | 1 each |
| **Total** | **80** |

Three are `console.log` — the noisiest kind:
- `NotificationBell.jsx:41` — `console.log('Connected to Socket.io server. ID:', socket.id)`
- `NotificationBell.jsx:46` — `console.log('Received real-time notification:', notification)` — **logs the full notification payload on every push**, so message content lands in the browser console indefinitely
- `EmailInbox.jsx:200` — `console.log('[AUTO-RELOAD 5M] Refreshing inbox emails...')`

**Impact:** Console noise makes real errors invisible during support calls; notification payloads persist in devtools; `vite build` does not strip them (there is no `esbuild.drop` config).

**Fix:** Add `esbuild: { drop: ['console', 'debugger'] }` to `vite.config.js` for production builds, or route everything through a `logger` util that no-ops when `import.meta.env.PROD`. Remove the three `console.log`s outright.

## M3. Blob URLs created 4 times, revoked 0 times
**Severity: MEDIUM (memory leak)** · `EmailInbox.jsx:504`, `EmailInbox.jsx:606`, `Reports.jsx:188`, `TaskList.jsx:416`

`grep -rn "createObjectURL"` → 4 hits. `grep -rn "revokeObjectURL"` → **0 hits.**

`EmailInbox.jsx:503-511` (the Excel export):
```jsx
const blob = new Blob([excelHtml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
const url = URL.createObjectURL(blob);
… link.click();
document.body.removeChild(link);
// no URL.revokeObjectURL(url)
```
`TaskList.jsx:416-422` and `EmailInbox.jsx:606-612` (attachment downloads) additionally use `link.parentNode.removeChild(link)`, which throws if `parentNode` is null.

**Impact:** Each blob is pinned in memory for the lifetime of the document. The inbox export serialises **every** email including body previews — with a few thousand emails that is several MB per click, and an admin exporting repeatedly (which the delete-lock UX actively encourages before each delete) accumulates unbounded memory in a long-lived tab. Attachment downloads pin the full file bytes each time.

**Fix:** `setTimeout(() => URL.revokeObjectURL(url), 0)` after `click()`, and use `link.remove()`.

## M4. Two email renderers have diverged; one no longer strips `<script>`
**Severity: MEDIUM (correctness — security aspects owned by another agent)** · `TaskList.jsx:15-24` vs `EmailInbox.jsx:6-13`

The same 8-line function exists twice. `TaskList`'s copy has a sanitisation step the `EmailInbox` copy lacks:
```jsx
// TaskList.jsx:18 — present
const cleanBody = body.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
// EmailInbox.jsx:8 — absent; uses `body` directly
```
The iframes also differ:
- `EmailInbox.jsx:1343`: `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"` — no `allow-scripts`.
- `TaskList.jsx:1156` and `:1742`: `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"` — **`allow-scripts` together with `allow-same-origin` voids the sandbox**.

So the copy that strips scripts is the one that permits scripts, and vice versa. From a pure code-quality standpoint this is the canonical argument for H3: a fix applied to one copy of a duplicated function never reached the other. Flagging for the security-owning agent.

**Fix:** Single `utils/renderEmailContent.js`; drop `allow-scripts` from the TaskList iframes; keep the strip.

## M5. Inbox tab counts disagree with the list they label
**Severity: MEDIUM (correctness)** · `EmailInbox.jsx:87-93` vs `EmailInbox.jsx:125-130`

The list filter matches an account against **two** fields:
```jsx
// getFilteredEmails, lines 87-93
const toAddr    = (email.toEmail || '').toLowerCase().trim();
const fetchAddr = (email.fetchedBy?.gmailEmail || '').toLowerCase().trim();
const selected  = selectedAccount.toLowerCase().trim();
if (toAddr !== selected && fetchAddr !== selected) return false;
```
The count function matches **one**, with no normalisation:
```jsx
// getTabCount, lines 125-130
const sourceEmail = email.fetchedBy?.gmailEmail;
if (sourceEmail !== selectedAccount) return false;
```

**Impact:** With an account filter active, the tab badges show different totals than the rows actually rendered — e.g. "Inbox 3" above a list of 11 emails. Any email whose `toEmail` matches but whose `fetchedBy.gmailEmail` differs (forwarded/aliased mail), and any address differing only in case or whitespace, is counted differently from how it's displayed. Users will read the badges as wrong and lose trust in the filtering.

**Fix:** Replace both with a single memoised pass that returns `{ filtered, counts }` from one shared predicate (also resolves half of H6).

## M6. Dead `{true && …}` conditional wrapping the filter bar
**Severity: MEDIUM (dead code)** · `EmailInbox.jsx:838`

```jsx
{/* Filters: Tab Bar + Account Selector */}
{true && (
  <div className="flex flex-col md:flex-row …">
```
ESLint flags it: `no-constant-binary-expression — Unexpected constant truthiness on the left-hand side of a && expression`. A real condition was removed and replaced with `true` and the 120-line JSX block was left indented inside it.

**Fix:** Delete `{true && (` and its closing `)}` at line 958.

## M7. Stale user-facing copy: dialog says "CSV backup" for an `.xls` export
**Severity: MEDIUM** · `EmailInbox.jsx:799`

> "You must export a **CSV backup** of the current emails by clicking **"Download Emails"**"

The export was upgraded to a formatted Excel/HTML `.xls` in commit `368704a`; the banner copy was not. The success toast at line 515 correctly says "Formatted Excel backup report". Two messages in the same file describe the same action differently.

**Fix:** Update line 799 to say "Excel backup".

## M8. Loading skeletons don't match the content they stand in for, and there's no skeleton system
**Severity: MEDIUM** · 11 sites

Every skeleton is an ad-hoc inline array with a hardcoded count and height, and all of them are invisible anyway because `skeleton-shimmer` doesn't exist (C6):
- `TaskList.jsx:807` — `[...Array(5)]`, `h-20`
- `EmailInbox.jsx:1079` — `[...Array(5)]`, `h-20`
- `ManageUsers.jsx:355` — `[...Array(4)]`, `h-16`
- `ActivityLog.jsx:178` — `[...Array(5)]`, `h-16`
- `Reports.jsx:298` — `[...Array(6)]`, `h-24`
- `Dashboard.jsx:226` — `[...Array(role === 'Employee' ? 4 : 6)]`, `h-28`
- `Profile.jsx:179-180` — two fixed `h-40`/`h-96` blocks
- `Reports.jsx:398, 483, 695` — three "Loading…" text placeholders
- `ClientList.jsx:291` — a spinner instead of a skeleton (inconsistent with all of the above)

**Impact:** Layout shift on load, and no visual signal of progress.

**Fix:** One `<Skeleton>` primitive plus per-page composed skeletons (`<TaskListSkeleton/>`, `<EmailListSkeleton/>`) that mirror real row heights. Fix the class name.

## M9. No 404 route — every unknown URL silently becomes a login redirect
**Severity: MEDIUM** · `App.jsx:81`

```jsx
<Route path="*" element={<Navigate to="/login" replace />} />
```
**Impact:** A logged-in user who mistypes a URL or follows a stale bookmark is bounced to a login screen despite having a valid session — it reads as "you've been logged out". A real 404 page is also the only signal that a link is broken rather than that auth failed.

**Fix:** Add a `<NotFound/>` page and route `*` to it; keep the login redirect only for genuinely unauthenticated access (which `ProtectedRoute` already handles).

## M10. Hardcoded `localhost` URLs — the app cannot be deployed
**Severity: MEDIUM** · `api/axios.js:5`, `NotificationBell.jsx:33`

```js
const api = axios.create({ baseURL: 'http://localhost:5015/api', … });   // axios.js:5
```
```js
const socket = io('http://localhost:5015', { auth: { token: localStorage.getItem('token') } });  // NotificationBell.jsx:33
```
There is **no `.env`, no `.env.example`**, and **zero** uses of `import.meta.env` anywhere in `src/`. The port `5015` is duplicated in two files.

**Impact:** A production build points at the developer's machine. This is a deploy-blocker.

**Fix:**
```js
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5015';
```
Commit a `.env.example` with `VITE_API_URL=`, and add a Vite dev proxy so local dev uses same-origin `/api` paths.

## M11. `vite.config.js` is essentially unconfigured
**Severity: MEDIUM** · `vite.config.js` (11 lines)

```js
export default defineConfig({ plugins: [react()], server: { port: 5174, strictPort: true } })
```
Missing: `build.sourcemap` (currently `false` — verified: no `.map` files emitted, so production stack traces are unreadable minified garbage with no error-reporting service to compensate); `resolve.alias` (so every import is a relative path — `ManageUsers.jsx:3` is `'../../api/axios'`); `build.rollupOptions.manualChunks` (C4); `server.proxy` (M10); no bundle analyser.

**Fix:** Add `build: { sourcemap: 'hidden' }`, `resolve: { alias: { '@': '/src' } }`, `server: { proxy: { '/api': 'http://localhost:5015' } }`, `esbuild: { drop: ['console'] }` (M2), and `manualChunks`.

## M12. ESLint config is missing every React-specific rule set
**Severity: MEDIUM** · `eslint.config.js`

Extends only `js.configs.recommended`, `reactHooks.configs.flat.recommended`, `reactRefresh.configs.vite`. Absent: `eslint-plugin-react` (no `react/jsx-key`, no `react/no-array-index-key`, no `react/prop-types`), `eslint-plugin-jsx-a11y` (which alone would have caught H14, H15, H16, and H17 — 90+ violations), `eslint-plugin-tailwindcss` (would have caught C5 and C6 — 139 violations), `eslint-plugin-import`. No Prettier. No `lint:fix`. No pre-commit hook, no CI workflow — verified `.github/` does not exist.

**Impact:** 85 lint errors sit in the tree unnoticed, including the hard crash in C1, because `npm run lint` isn't wired to anything.

**Fix:** Add `eslint-plugin-jsx-a11y` (`recommended`), `eslint-plugin-react` (`recommended` + `jsx-runtime`), `eslint-plugin-tailwindcss`, and Prettier. Add a `lint-staged` pre-commit hook and a GitHub Action that fails on any error.

## M13. Toast/alert state is a re-render engine and can't stack
**Severity: MEDIUM** · 7 copies

Every `triggerAlert` is:
```jsx
const triggerAlert = (type, message) => {
  setAlert({ type, message });
  setTimeout(() => setAlert({ type: '', message: '' }), 4500);   // 4000 in 2 of the 7 copies
};
```
Problems: (1) the timeout is never stored or cleared, so a second alert within 4.5 s has its timer overwritten and the first timer clears the *second* message early; (2) `setState` fires after unmount if the user navigates within the window; (3) only one alert can exist — a bulk operation reporting several results shows only the last; (4) the duration is inconsistent (4500 ms in five copies, 4000 ms in `ManageUsers.jsx:53` and `ActivityLog.jsx:25`); (5) the ~18-line render block is duplicated 6 times; (6) toasts are `<div>`s with no `role="status"`/`role="alert"`/`aria-live`, so **screen reader users are never told an operation succeeded or failed** — a WCAG 4.1.3 failure.

**Fix:** One `ToastProvider` + `useToast()` hook rendering a portal-based, stackable region with `role="status"` / `role="alert"` and `aria-live="polite"`, with timers held in refs and cleared on unmount.

## M14. `localStorage` caches have no size guard, no TTL, and no version key
**Severity: MEDIUM** · 7 keys

`EmailInbox.jsx:349-359` is the only careful one — it truncates to 50 emails with 300-char bodies and has a `catch` that clears the key on quota failure. The others write **full API payloads**:
- `TaskList.jsx:197` — `JSON.stringify(response.data)` for all tasks, **including every `linkedEmail.body` in full**. This is by far the largest payload in the app and is the most likely to blow the ~5 MB quota.
- `Dashboard.jsx:62, 66` — no `try/catch` around `setItem` at all. A `QuotaExceededError` propagates to `fetchDashboardData`'s outer catch (line 68) and surfaces as the misleading toast *"Failed to retrieve stats data."* — the data loaded fine; only the cache write failed.
- `ClientList.jsx:65`, `Reports.jsx:75, 88` — `catch (e) {}` **empty blocks** (ESLint `no-empty`, 3 errors) that swallow the failure silently.

None of the seven keys carries a schema version, so a shape change ships stale-shaped objects straight into `useState` initialisers and can crash render before the first fetch resolves — with no error boundary to catch it (C2). None is cleared on logout: `Navbar.jsx:29-31` and `Sidebar.jsx:33-35` remove only `token` and `user`, leaving the next user on a shared office machine looking at the **previous user's cached tasks, emails, clients, and reports** on first paint.

**Fix:** One `cache.js` with `{v: 1, t: Date.now(), data}` envelopes, a TTL check, a size cap, and a `clearAll()` called on logout. Or replace the whole thing with TanStack Query + a persister (H2).

## M15. `App.css` (184 lines) and `moduleCursor.js` (141 lines) are dead files
**Severity: MEDIUM (dead code)**

- **`src/App.css`** — verified: `grep -rn "App.css" src/` → **no matches**. `main.jsx` imports only `index.css`; `App.jsx` imports no CSS. All 184 lines are leftover Vite scaffold (`.hero`, `#next-steps`, `#docs`, `.ticks`, `.counter`) referencing CSS variables (`--accent`, `--border`, `--social-bg`) that are never defined.
- **`src/utils/moduleCursor.js`** — verified: `grep -rn "moduleCursor" src/` matches only its own declaration. 141 lines of spotlight-cursor implementation, never imported.
- **`src/assets/hero.png`, `react.svg`, `vite.svg`** — verified unreferenced.
- **`index.css` orphans:** `.glassmorphism` (line 116), `.link-underline` (275), `.animate-pulse-ring` (200), `.animate-shimmer` (194 — the correctly-implemented version of the class everyone misspells), `.reveal-element*` / `.stagger-reveal` (212-256, 45 lines) — none used by any `.jsx` file. `.email-body-rendered` and its 21 descendant rules (296-384) are dead too: the only usage is `className="email-body-rendered-**container**"` at `EmailInbox.jsx:1339`, a different class name, and the bodies actually render inside `<iframe srcDoc>` which cannot inherit parent-document CSS at all.

**Impact:** ~500 lines of dead code and roughly 30% of `index.css` shipped in the 64 kB CSS bundle. Also actively misleading — a developer editing `.email-body-rendered` to restyle email bodies will see no effect whatsoever.

**Fix:** Delete `App.css`, `moduleCursor.js`, the three unused assets, and the six dead `index.css` blocks.

## M16. 42 unused imports and variables
**Severity: MEDIUM (dead code)** · verified via ESLint `no-unused-vars`

- **`React` imported but unused — 15 files.** React 19 with the automatic JSX runtime doesn't need it: `App.jsx`, `AdminRoute.jsx`, `KeywordApprovalModal.jsx`, `Navbar.jsx`, `NotificationBell.jsx`, `ProtectedLayout.jsx`, `ProtectedRoute.jsx`, `Sidebar.jsx`, `ClientList.jsx`, `Dashboard.jsx`, `EmailInbox.jsx`, `ForgotPassword.jsx`, `Landing.jsx`, `Login.jsx`, `Profile.jsx`, `Register.jsx`, `TaskList.jsx`, `ActivityLog.jsx`, `ManageUsers.jsx`, `countUp.jsx`. (`Reports.jsx` legitimately uses `React.Fragment` at line 615.)
- **Unused router imports:** `Link` (`TaskList.jsx:2`), `NavLink` (`Navbar.jsx:2`), `useNavigate` (`ForgotPassword.jsx:2`).
- **Unused `navigate` consts:** `EmailInbox.jsx:62`, `Landing.jsx:9`, `ActivityLog.jsx:14`, `ManageUsers.jsx:34` — four `useNavigate()` calls whose results are never used.
- **Dead state setters:** `setUser` (`ClientList.jsx:45` — the user object is never updated, so the component won't react to a role change), `setRole` (`Register.jsx:9` — the role selector UI was removed at lines 156-158, leaving a hardcoded `'Employee'` and a blank gap in the form).
- **Dead function:** `handleLogout` (`Navbar.jsx:28-32`) — fully implemented, never wired to any control. Logout exists only in the Sidebar, so on mobile with the drawer closed there is no visible way to log out.
- **Unused catch bindings:** `err` in `TaskList.jsx:406, 526`, `EmailInbox.jsx:361, 646`, `Profile.jsx:171`, `ActivityLog.jsx:55`; `e` in `Reports.jsx:76, 89`; `index` in `cursorEffects.js:104`. Note `EmailInbox.jsx:361` swallows the error entirely — a failed email load logs nothing.
- **Unused `useState` import:** `ForgotPassword` imports `useNavigate` and never navigates after a successful reset request.

**Fix:** `npx eslint . --fix` handles most; the rest are one-line deletions. Then set `no-unused-vars` to `error` in CI.

## M17. `formatDate` swallows errors that can't occur, and duplicated try/catch theatre
**Severity: MEDIUM** · `TaskList.jsx:515-529`, `EmailInbox.jsx:635-649`, `Profile.jsx:162-174`, `ActivityLog.jsx:43-58`

All four copies:
```jsx
try {
  const d = new Date(dateString);
  return d.toLocaleString(undefined, {…});
} catch (err) { return dateString; }
```
`new Date(bad)` doesn't throw — it produces `Invalid Date`, and `toLocaleString` on it returns the literal string `"Invalid Date"`. So the catch is unreachable (ESLint confirms `err` unused in all four) and malformed dates render as **"Invalid Date"** to the user rather than the intended fallback.

Additionally the four copies use **three different formats**: `TaskList`/`EmailInbox` use `month/day/year/hour/minute`; `Profile` uses `month:'long'` date-only; `ActivityLog` adds `second`. Meanwhile `TaskList.jsx:996` and `:1219` use a fourth, hardcoded `'en-IN'` locale, and `EmailInbox.jsx:469` uses a fifth (bare `toLocaleString()`). Five date formats across one product.

**Fix:** One `utils/date.js` exporting `formatDateTime`, `formatDate`, `formatDateShort`, each guarding with `Number.isNaN(d.getTime())` and returning `'—'`. Pick one locale strategy.

## M18. 10 index-as-key usages, one of them on a mutable list
**Severity: MEDIUM** · 12 sites

Most are harmless (static skeleton arrays: `EmailInbox.jsx:1080`, `Dashboard.jsx:227`, `ManageUsers.jsx:356`, `Reports.jsx:298`, `ActivityLog.jsx:178`, `TaskList.jsx:808`; static SVG gridlines/points: `Reports.jsx:415, 432, 499, 512`). Two are real:
- **`ManageUsers.jsx:540-541`** — `client.associatedEmails.map((email, idx) => <span key={idx}>` on a **user-editable** list. Emails are added/removed/reordered via the comma-separated textarea, so index keys cause React to reuse the wrong DOM nodes on reorder. `key={email}` is available and stable.
- **`TaskList.jsx:866`** — `key={idx}` for the 42 calendar cells. Since `getDaysInMonth` regenerates a new array on every render (H6), month navigation reuses cells across different dates. `key={`${year}-${month}-${day}`}` is available from the destructured object on the very same line.

**Fix:** Use the stable values already in scope. Add `react/no-array-index-key` to ESLint.

## M19. `Reports` fires 6 requests on mount with no coordination
**Severity: MEDIUM** · `pages/admin/Reports.jsx:54-61`

```jsx
useEffect(() => {
  fetchOverallStats(); fetchTimeline(); fetchEmailTimeline(14);
  fetchEmployeesList(); generateReport('monthly', ''); fetchClientStats();
}, []);
```
Six independent fetches, six independent loading flags (`statsLoading`, `emailTimelineLoading`, `reportLoading`, `clientStatsLoading` — plus two with none at all), six independent error paths, all triggering `setState` at different times. Each resolution re-renders the whole 728-line component including both SVG charts. ESLint reports 6 `react-hooks/immutability` errors (lines 55-60) plus an `exhaustive-deps` warning listing all five functions.

Also, `fetchEmployeesList` (line 116) has **no** error toast — it only logs — so if it fails the employee dropdown is silently empty with no explanation.

**Fix:** `Promise.allSettled` with a single `loading` state, or six `useQuery` calls (H2). Add the missing error handling.

## M20. `hasDownloaded` delete-lock is derived from `localStorage` at construction and never re-synced
**Severity: MEDIUM** · `EmailInbox.jsx:41`

```jsx
const [hasDownloaded, setHasDownloaded] = useState(localStorage.getItem('emailsDownloaded') === 'true');
```
Two problems: (1) the initialiser expression runs on **every render** (not lazy — it should be `useState(() => …)`), so `localStorage` is read synchronously on every one of the many re-renders this component performs; (2) the flag is a plain localStorage boolean, so it's per-browser, not per-user — on a shared office machine, User A downloading a backup unlocks destructive deletes for User B, including "Clear All Emails".

The gate is also purely cosmetic client-side: `handleClearAllEmails` (line 545) and `handleDeleteEmail` (line 566) check it in JS only, and the button `disabled` at line 774 is trivially bypassed.

**Fix:** Make it lazy (`useState(() => …)`), namespace the key by user id, and — for a real guarantee — enforce the backup requirement server-side (flagging for the backend agent).

## M21. Two identical client-autocomplete widgets, copy-pasted with divergent behaviour
**Severity: MEDIUM** · `TaskList.jsx:1378-1415` (create) and `1594-1631` (edit)

Two full implementations, each with its own state pair (`clientSearchQuery`/`showClientSuggestions` vs `editClientSearchQuery`/`showEditClientSuggestions`), its own ref, its own filter (`filteredClients` line 532, `filteredEditClients` line 536 — identical logic), and its own dropdown JSX. The single shared outside-click effect (lines 171-182) handles both refs.

They have already diverged: the edit copy gates on `currentUser.role !== 'Employee'` (lines 1603, 1610); the create copy doesn't. Neither supports keyboard navigation (H16), neither memoises its filter (H6), and `filteredClients` recomputes a `.toLowerCase()` on every client name on every keystroke **and on every unrelated render**.

**Fix:** One `<ClientAutocomplete value onChange clients disabled/>` component with an internal `useMemo` filter and full combobox keyboard support.

## M22. Kanban optimistic update rolls back to a stale snapshot
**Severity: MEDIUM** · `TaskList.jsx:643-651`

```jsx
const prevTasks = tasks;
setTasks(prevTasks.map(t => t._id === task._id ? { ...t, status: targetStatus } : t));
try { await api.put(`/tasks/${task._id}`, { status: targetStatus }); }
catch (err) { setTasks(prevTasks); … }   // ← restores the pre-drag snapshot wholesale
```
`prevTasks` is captured from the render closure. If anything else mutates `tasks` while the PUT is in flight — the 5-minute-ish refetch, a comment post, another drag — the rollback **discards those newer updates** too, silently reverting unrelated changes.

**Fix:** Roll back functionally and narrowly: `setTasks(cur => cur.map(t => t._id === task._id ? { ...t, status: originalStatus } : t))`.

## M23. `handleDeleteTask` refetches twice and double-updates
**Severity: MEDIUM** · `TaskList.jsx:349-366`

```jsx
const response = await api.delete(`/tasks/${taskId}`);
setTasks((prev) => prev.filter((task) => task._id !== taskId));   // optimistic removal
setExpandedTaskId(…);
triggerAlert('success', …);
await fetchTasks();          // full refetch #1
fetchDropdownData();         // refetch #2 — itself 3 more requests
```
Three state updates plus **four** network requests (`fetchDropdownData` issues `/tasks/clients`, `/users`, `/gmail/emails`) for a single delete. The optimistic removal is immediately overwritten by `fetchTasks`, so it buys nothing.

**Fix:** Keep the optimistic removal, drop the `fetchTasks()`, and only refresh the unassigned-emails list (not all three dropdowns).

## M24. Kanban drop handler contains an always-false ternary
**Severity: MEDIUM** · `TaskList.jsx:639, 650`

```jsx
triggerAlert ? triggerAlert('error', 'You can only move…') : alert('You can only move…');
```
`triggerAlert` is a `const` arrow function declared at line 184 in the same scope — always truthy. The `alert()` branch is dead. Same shape at line 650. Reads like a defensive fallback; it's noise that also happens to be the only place `alert()` appears in `TaskList`.

The same anti-pattern appears at `EmailInbox.jsx:1520-1521`:
```jsx
fetchEmails ? fetchEmails() : Promise.resolve(),
fetchPendingApprovalsCount ? fetchPendingApprovalsCount() : Promise.resolve()
```
Both are `const`s declared at lines 369 and 224.

**Fix:** Call them directly.

---

# LOW

## L1. Emoji used as UI iconography, 20+ sites
`TaskList.jsx:1055` (`✉️`), `:1081` (`🔁`), `:1148`/`1734` (`🔗`), `EmailInbox.jsx:811` (`🔍` as the search icon), `:1193` (`✉️` as an avatar fallback), `:1306` (`✨`), `:1357` (`📎`), `:1422` (`↩`), `Dashboard.jsx:235, 249, 263, 277, 293, 307, 321, 335, 349, 363` (10 stat-card icons), `Profile.jsx:387` (`🔒`), `Landing.jsx:370, 389, 408, 427, 446, 465` (6 feature-card icons). Emoji render inconsistently across Windows/macOS/Linux, aren't styleable, and are announced verbosely by screen readers. Elsewhere the same app uses clean inline SVGs — so the treatment is inconsistent within single screens. **Fix:** replace with the SVG icon set already in use.

## L2. `select-none` applied to entire pages, blocking copy
`TaskList.jsx:656`, `EmailInbox.jsx:656`, `Dashboard.jsx:158`, `ManageUsers.jsx:284`, `ActivityLog.jsx:89`, `Reports.jsx:256`, `Profile.jsx:186`, `Login.jsx:36`, `Register.jsx:50`, `ForgotPassword.jsx:31`, plus all 11 modal panels. A few descendants re-enable it with `select-text` (`TaskList.jsx:1109, 1116, 1125`). **Impact:** users cannot copy a client's email, a task title, an error message, or an activity-log detail — routine operations in office software. **Fix:** remove `select-none` from page containers; apply it only to genuinely non-textual chrome.

## L3. Hardcoded `en-IN` locale in two places, `undefined` locale in four others
`TaskList.jsx:996` and `:1219` pass `'en-IN'` explicitly while the four `formatDate` helpers pass `undefined` (browser locale). Dates in the kanban card footer and comment timestamps therefore use a different format from dates everywhere else on the same screen. **Fix:** one locale constant.

## L4. Fake statistics and fake social proof shipped on the landing page
`Landing.jsx:14-21` seeds `{ totalEmails: 1248, totalTasks: 340, totalCompleted: 892, totalLate: 8, totalUsers: 5, totalPending: 280 }`. Real data is only fetched when a token exists (line 36), so **logged-out visitors always see the invented numbers**, animated by `<CountUp>` as if they were live. Combined with the `CountUp` stale-closure bug (H11), even logged-in users can be left on the fake values. `Landing.jsx:196` also hardcodes "Trusted by 500+ teams worldwide" above five fabricated avatar initials (lines 190-194), and the mockup at lines 239-254 shows invented deltas ("↑ 12% this week", "94% completion rate", "↓ 3 from yesterday"). **Fix:** for a private office tool this page is arguably unnecessary; at minimum, render `—` rather than fabricated figures when no data is available.

## L5. Two Google Fonts requests, one of them wasted
`index.html:9` loads Inter (weights 300-800). `index.css:1` `@import`s Inter **and** Outfit (300-900). `index.css:21-23` sets `font-family: 'Outfit', 'Inter', sans-serif`, so Outfit wins everywhere and the `index.html` Inter request is entirely redundant. The CSS `@import` is also render-blocking and defeats the `preconnect` hints at lines 7-8. **Fix:** drop the `@import`, move both families into the `index.html` `<link>` with `display=swap`, and load only the weights actually used.

## L6. `Reports.jsx` charts are inaccessible and unlabelled
Two hand-built SVG line charts (lines 403-439, 488-521) with no `<title>`, no `role="img"`, no `aria-label`, and no text alternative. Hover tooltips are `onMouseEnter`/`onMouseLeave` only — no keyboard equivalent, so the data is unreachable without a mouse. Positioning uses percentage arithmetic against `svgWidth`/`svgHeight` constants (lines 446-447, 527-528), which breaks once the SVG scales responsively. **Fix:** add a `<title>`/`aria-label`, expose the underlying numbers in a visually-hidden `<table>`, and make points focusable.

## L7. `Sidebar` role filtering is computed but the user object never updates
`Sidebar.jsx:122` — `navItems.filter(item => item.roles.includes(currentUser.role))`. `currentUser` only changes via the manual `storage` event (line 28). `ProtectedLayout.jsx:31-34` handles role changes with a full `window.location.reload()` instead, so the storage-event path for roles is dead. Meanwhile `ClientList.jsx:45` has the same pattern with `setUser` never called at all (M16), so its `isCanEdit`/`isAdmin` gates (lines 54-55) are frozen at mount.

## L8. `getDaysInMonth` always pads to 42 cells
`TaskList.jsx:479-487` unconditionally fills to 6 rows. Most months need 5, so roughly 7 extra cells render every month, each running its own O(n) task filter (H6). Cosmetically, a month starting on Sunday with 28 days shows two full trailing weeks of greyed-out cells.

## L9. `getPriorityStyle` returns inline style objects, defeating Tailwind entirely
`TaskList.jsx:5-13` defines four priority styles as raw hex objects and spreads them into `style={{…}}` at lines 1086, 1139, 1558. The identical semantic colours already exist as Tailwind classes used elsewhere in the same file (`bg-emerald-50 text-emerald-600` etc. at line 1068). Two parallel colour systems in one component. **Fix:** a `PRIORITY_CLASSES` map of Tailwind class strings, consumed by the shared `<Badge>` from H3.

## L10. `iframe` auto-height uses `onLoad` DOM measurement, once
`TaskList.jsx:1159-1168` and `:1745-1754` read `contentDocument.body.scrollHeight` in `onLoad` and write `e.target.style.height`. This runs once — images loading afterwards (common in HTML email) resize the content and the iframe stays too short, clipping the message. `EmailInbox.jsx:1345` sidesteps it with a fixed `height: 300px`, so the same content renders at two different heights in two places. Both are `resize: vertical` so users can drag, but there's no visual affordance. **Fix:** a `ResizeObserver` on the iframe document, or `postMessage`-based height reporting.

## L11. `postcss.config.js` has no `cssnano`
Vite's default build minifies CSS via esbuild, so this is minor, but with 64 kB of CSS (of which ~30% is dead per M15) an explicit `cssnano` pass plus dead-CSS removal would meaningfully cut it.

## L12. `README.md` is the untouched Vite template
No setup instructions, no env var documentation, no architecture notes, no scripts reference. Combined with M10 (hardcoded localhost, no `.env.example`) a new developer cannot start the project without reading source.

## L13. `.gitignore` does not exclude `.env`
`client/.gitignore` covers `node_modules` and `dist` but has no `.env*` entry. There is no `.env` today (M10), so the moment one is created it is a candidate for accidental commit. **Fix:** add `.env`, `.env.local`, `.env.*.local`.

## L14. Inconsistent styling paradigm: 57 inline `style` objects mixed into Tailwind
`TaskList.jsx` (26), `EmailInbox.jsx` (24), `Landing.jsx` (4), `Reports.jsx` (3). Some elements carry both, e.g. `TaskList.jsx:715-716`:
```jsx
style={{ padding: '7px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid #e2e8f0', background: 'white', cursor: 'pointer' }}
className="text-xs font-semibold text-slate-700"
```
The inline `fontSize: '13px'` silently overrides the `text-xs` (12px) class on the same element. Whole subsystems are inline-only — the entire comments UI (`TaskList.jsx:1198-1263`), the reply composer and AI summary panel (`EmailInbox.jsx:1303-1425`), the search bar (`EmailInbox.jsx:806-834`) — and they don't match the Tailwind-styled components around them (different radii: `6px`/`8px` inline vs `rounded-xl`=12px / `rounded-2xl`=16px; different borders: `#cbd5e1` vs `#e2e8f0` vs `border-slate-200`). **Fix:** convert inline styles to Tailwind; they're also the source of most of the 96 hardcoded hex values.

## L15. No design tokens; 36 distinct hex values hardcoded in JS
`#94a3b8` ×14, `#e2e8f0` ×9, `#4f46e5` ×7, `#334155` ×7, `#ffffff` ×5, `#cbd5e1` ×5, `#64748b` ×5, `#f8fafc` ×4, `#f1f5f9` ×4, and 27 more. All duplicate values that already exist in the Tailwind palette (`#4f46e5` = `indigo-600`, `#94a3b8` = `slate-400`, `#e2e8f0` = `slate-200`…). Two more are embedded in `index.css` (`#6366F1`, `#8B5CF6`) and one in `cursorEffects.js:36`. Rebranding requires touching 96 JS sites plus the CSS. **Fix:** define semantic tokens in `tailwind.config.js` (`brand`, `surface`, `border`, `text-muted`) and use classes.

## L16. Inconsistent spacing and typography scales
Buttons in the same product use `px-3 py-1.5`, `px-3.5 py-2`, `px-4 py-2`, `px-4 py-2.5`, `px-5 py-3`, `px-6 py-3`, and inline `7px 16px` / `8px 16px` / `4px 12px`. Text sizes span `text-[9px]`, `text-[10px]`, `text-[11px]`, `text-xs`, `text-sm`, plus inline `11px`/`12px`/`13px`/`15px`. Border radii: `rounded-lg`(8), `rounded-xl`(12), `rounded-2xl`(16), `rounded-3xl`(24), `rounded-[2.5rem]`(40), plus inline `5px`/`6px`/`8px`/`10px`/`12px`/`20px`. **Impact:** nothing lines up between screens; `text-[9px]` (`Navbar.jsx:90`, `Sidebar.jsx:166`, `Dashboard.jsx:236`+) is below any reasonable legibility floor for role badges that carry real meaning. **Fix:** constrain to Tailwind's default scale plus a small set of documented exceptions.

## L17. `Reports` KPI row cramps at laptop widths
`Reports.jsx:302` — `grid-cols-2 md:grid-cols-3 lg:grid-cols-6`. At the `lg` breakpoint (1024 px) minus the 260 px sidebar, six cards share ~740 px → ~123 px each, holding `p-4`, an uppercase label, and a `text-2xl` number. Labels like "Overdue / Late" wrap awkwardly. There is **no `xl:` or `2xl:` breakpoint anywhere in the codebase** (`xl:` count = 0, `2xl:` count = 0), so the layout never adapts upward either. **Fix:** `lg:grid-cols-3 xl:grid-cols-6`.

## L18. `KeywordApprovalModal` Approve button has a stray `mt-4`
`KeywordApprovalModal.jsx:335` — `className="mt-4 px-3 py-1.5 …"` inside a `flex items-center` row (line 315). The margin fights the flex alignment, pushing the Approve button below the baseline of the select beside it. Same file, line 242: `mb-2` on the "Approve All" button inside a `flex items-center justify-between` header.

## L19. `Register` has a blank gap where the role selector was removed
`Register.jsx:156-158` — three empty lines between the password field and the submit button, left by a removed role `<select>`. The `role` state (line 9) and `setRole` remain (M16), and `role` is still sent to the API at line 26 hardcoded to `'Employee'`.

## L20. No `prefers-reduced-motion` support anywhere
Zero occurrences. The app runs: a 60 fps custom-cursor rAF loop with 5 trailing dots, magnetic button pull, 3D tilt on cards, a 4 s infinite `animate-float`, three 25 s infinite `animate-blob` shapes, `animate-pulse` on 8+ status dots, `animate-bounce` on the notification bell, `animate-pulse` on the un-backed-up download button (`EmailInbox.jsx:700`), and ~90-frame count-up animations. For users with vestibular disorders this is genuinely hostile, and it's a WCAG 2.3.3 (AAA) / 2.2.2 concern. **Fix:** wrap all decorative motion in `@media (prefers-reduced-motion: no-preference)`, and bail out of `initCursorEffects`/`initTilt`/`CountUp` when reduction is requested. Also gate the cursor effects on `(pointer: fine)` — on a touch device the custom cursor and `cursor: none` are pure overhead.

## L21. Landing page tilt cleanups are captured from a stale ref array
`Landing.jsx:62-64` builds `cleanupsFeature` from `featureCardRefs.current`, which line 12 wipes on every render (H4). On the re-render triggered by `setStats` (line 40), the six `initTilt` handlers registered against the *first* render's elements are never cleaned up — their `mousemove`/`mouseleave` listeners and injected `.tilt-glare` divs leak for the page's lifetime.

## L22. `NotificationBell` dropdown is not a menu and silently truncates
`NotificationBell.jsx:188` renders `notifications.slice(0, 10)` with no "view all" affordance — notifications 11+ are unreachable from the UI. The dropdown has no `role="menu"`, no `aria-expanded` on the trigger, no keyboard navigation, no focus management, and the trigger's only accessible text is the unread count. It also closes on outside `mousedown` (line 75) but not on `Escape`.

## L23. `ClientList` and `TaskList` render the same "Clients" concept from different endpoints
`ClientList.jsx:61` reads `GET /clients`; `TaskList.jsx:212` and `ManageUsers.jsx:166` read `GET /tasks/clients`. Two client lists with different shapes (`{success, data}` vs a bare array) and different fields, surfaced in three places in the same product. Purely a frontend-modelling observation — endpoint semantics are the other agent's domain — but it means `ManageUsers`' "Manage Clients" tab and the `/clients` page can display different client sets, with no indication to the user which is authoritative.

---

# Prioritised remediation plan

**Ship this week (correctness — small diffs, high impact)**
1. **C1** — delete the 6 undefined-setter lines in `TaskList.jsx` (5-minute fix, removes a crash on the app's most-used control).
2. **C2** — add a root error boundary (~40 lines).
3. **M12** — wire `npm run lint` into CI as blocking; add `jsx-a11y` + `tailwindcss` plugins.
4. **C5 / C6** — add the missing Tailwind shades and the 6 missing CSS animations (~50 lines of config/CSS; fixes 139 broken styling sites).
5. **H19** — `lg:pl-60` → `lg:pl-[260px]`.
6. **M10** — move the API/socket base URL to `VITE_API_URL`; commit `.env.example`. (Deploy blocker.)
7. **M6, M7, M24, M15, M16** — delete dead code: `{true &&}`, stale copy, dead ternaries, `App.css`, `moduleCursor.js`, 42 unused vars.

**Next sprint (architecture)**
8. **H3** — build `components/ui/*` (Button, Input, Label, Modal, Badge, Card, Table, Toast, Spinner) + `utils/format.js`, `utils/date.js`, `utils/email.js`. Prerequisite for most a11y and styling fixes.
9. **H13 / H14 / H15 / H16 / H17** — the accessibility block. The shared `<Modal>` and `<Input>` from step 8 resolve ~80% of it mechanically.
10. **C4** — `React.lazy` on all routes + `manualChunks`.
11. **H2** — `AuthContext` + TanStack Query; retire the 7 localStorage cache keys and 12 duplicated user reads.

**Following sprint (performance & polish)**
12. **H6 / H7** — memoise all derived lists; single-pass tab counts; pre-bucketed calendar; virtualise `ActivityLog` and `TaskList`.
13. **H1** — decompose `TaskList` and `EmailInbox` into the sub-components listed.
14. **H9 / H10 / H11 / L20** — delete `initScrollAnimations`, merge the cursor `mousemove` handlers into the rAF loop, throttle `CountUp`, gate all motion on `prefers-reduced-motion` and `pointer: fine`.
15. **H12** — replace the 8-second `/auth/me` poll with a socket event.
16. **C3** — Vitest + RTL on the five riskiest flows; then incremental TypeScript.
