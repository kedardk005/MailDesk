# Frontend Foundation — Implementation Contract

**Branch:** `feat/production-hardening`
**Scope delivered:** design tokens, UI primitive library, app shell, routing, auth/session layer, env config, safe email renderer.
**Audience:** the page agents rebuilding `client/src/pages/**` on top of this.

> **This file is the contract.** Everything in `client/src/components/ui/`, `client/src/lib/` and `client/src/api/` is stable API. Do not hand-roll a control, a toast, a modal, a table or a confirm dialog — they all exist here.

---

## 0. Quick start for a page rewrite

```jsx
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import api, { getErrorMessage } from '../api/axios'
import { useAuth } from '../components/AuthProvider'
import {
  Alert, Badge, Button, DataTable, EmptyState, PageBody, PageHeader,
  Toolbar, toast, useConfirm,
} from '../components/ui'
import { formatNumber } from '../lib/utils'

export default function Clients() {
  const { isAdmin } = useAuth()
  const confirm = useConfirm()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const ctrl = new AbortController()
    api.get('/clients', { signal: ctrl.signal })
      .then((r) => setRows(r.data.data))
      .catch((e) => e.code !== 'ERR_CANCELED' && setError(getErrorMessage(e)))
      .finally(() => setLoading(false))
    return () => ctrl.abort()
  }, [])

  const remove = async (row) => {
    const ok = await confirm({
      title: `Delete “${row.name}”?`,
      description: 'The client and its links to existing tasks are removed permanently.',
      confirmLabel: 'Delete client',
      tone: 'danger',
    })
    if (!ok) return
    await api.delete(`/clients/${row._id}`)
    toast.success('Client deleted')
  }

  return (
    <>
      <PageHeader
        title="Clients"
        actions={isAdmin && <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />}>New client</Button>}
      />
      <Toolbar left={/* filters */} right={/* search */} />
      <PageBody>
        {error && <Alert variant="danger" title="Could not load clients">{error}</Alert>}
        <DataTable
          ariaLabel="Clients"
          data={rows}
          columns={columns}
          loading={loading}
          enableSelection
          pagination
          emptyState={{ title: 'No clients yet', description: 'Add your first client to start routing mail.' }}
        />
      </PageBody>
    </>
  )
}
```

**Hard rules for page code**

| Rule | Why |
|---|---|
| Max font weight **600**. No `font-bold` / `font-extrabold` / `font-black`. | 513 of 542 weight declarations were ≥600; nothing had hierarchy. |
| No `text-[Npx]`. Use the scale (`text-2xs` … `text-2xl`). | 162 arbitrary sizes, some at 9px. |
| No emoji as iconography. Use `lucide-react`. | 26 emoji instances. |
| No gradients on controls, no coloured shadows, no `backdrop-blur`. | Glow/neon was the main "childish" signal. |
| No `select-none` on containers. | Staff must be able to copy email addresses and GSTINs. |
| Every icon-only button needs `aria-label`; every input needs a label. | The app had 1 `aria-label` and 60 `focus:outline-none`. |
| Never `focus:outline-none` without a `focus-visible` replacement. | A global `:focus-visible` ring now exists as a backstop, but don't rely on it. |
| Numeric table columns: right-aligned + `tabular` class (or `meta.numeric`). | Numbers jittered column-to-column. |
| Filter/sort/page/tab state belongs in the URL query string. | No view could be bookmarked or shared. |
| Destructive actions: `danger-ghost` in the row, promoted to `danger` only inside `ConfirmDialog`. | `Delete Task` was the loudest control on the screen. |
| `window.confirm` / `alert` are banned. Use `useConfirm()`. | 12 call sites, including "clear ALL emails". |
| Do not copy a toast block. Use `toast` from `../components/ui`. | The same 18 lines were pasted into 7 files. |

---

## 1. Design tokens

Defined in `client/tailwind.config.js` (Tailwind names) backed by CSS variables in `client/src/index.css`. `darkMode: 'class'` is explicit — light **and** dark work with the same class names.

### Surfaces & text

| Tailwind class | Light | Dark | Use |
|---|---|---|---|
| `bg-canvas` | `#F8FAFC` | `#0B1220` | app background, page body |
| `bg-surface` | `#FFFFFF` | `#111827` | panels, tables, cards, modals |
| `bg-subtle` | `#F1F5F9` | `#1B2432` | table header, hovered row, input fill |
| `bg-muted` | `#E2E8F0` | `#273244` | disabled fill |
| `border-line` | `#E2E8F0` | `#273244` | **the only border you need** |
| `border-line-strong` | `#CBD5E1` | `#3A465A` | inputs, focused containers |
| `text-fg` | `#0F172A` | `#F1F5F9` | headings, primary cell |
| `text-fg-2` | `#475569` | `#CBD5E1` | body, labels, secondary cell |
| `text-fg-3` | `#64748B` | `#94A3B8` | meta, captions (4.76:1 — passes AA) |
| `text-fg-off` | `#94A3B8` | `#64748B` | **disabled only** — 2.85:1, never a label |
| `text-fg-inverse` | `#FFFFFF` | `#0F172A` | text on a dark solid |

Opacity modifiers work: `bg-surface/80`, `border-line/50`.

### Primary (blue) — replaces indigo→purple entirely

`primary-50 100 200 500 600 700 800`, plus `primary` (= 600), `primary-fg` (text on primary), `primary-subtle`, `primary-border`, `primary-text`.

`bg-primary-600` `#2563EB` · hover `bg-primary-700` `#1D4ED8` · active `bg-primary-800` `#1E40AF` · ring `primary-500` `#3B82F6`.

### Semantic

Each of `success` `warning` `danger` `info` `neutral` exposes four tokens:

```
bg-success           solid fill        #16A34A
bg-success-subtle    tinted background #F0FDF4
border-success-border                  #BBF7D0
text-success-text    accessible text   #15803D
```

`warning` `#D97706` · `danger` `#DC2626` · `info` `#0284C7` · `neutral` `#64748B`. Dark-mode variants are already wired.

**Convention:** role badges use `neutral` (Employee), `info` (Head), `warning` (Admin). `danger` is reserved for destructive/error — never for a role. Priority: Low `neutral`, Medium `info`, High `warning`, Urgent `danger`.

### Charts

`chart-1 … chart-6` — the colourblind-tested categorical set. **CSS-variable driven since Wave 2 (U-7)**, like every other token, so the palette is tunable per theme. The class names are unchanged — `text-chart-3`, `bg-chart-3`, `fill-chart-3`, `stroke-chart-3` all still work exactly as before, and opacity modifiers (`bg-chart-3/20`) now work too.

| Token | Light | Dark |
|---|---|---|
| `chart-1` | `#2563EB` blue | `#3B82F6` |
| `chart-2` | `#0D9488` teal | `#2DD4BF` |
| `chart-3` | `#D97706` amber | `#F59E0B` |
| `chart-4` | `#7C3AED` violet | `#A78BFA` |
| `chart-5` | `#DB2777` pink | `#F472B6` |
| `chart-6` | `#0891B2` cyan | `#22D3EE` |

Values live in `src/index.css` (`--chart-1 … --chart-6`, in both `:root` and `.dark`); `tailwind.config.js` only maps the names. The hue order is identical across themes, so a legend swatch and its series still agree after a theme switch. `fill="currentColor"` + a `text-chart-N` class (what Reports does) remains the recommended pattern for SVG charts.

### Type scale (fixed line heights)

| Class | Size/LH | Use |
|---|---|---|
| `text-2xs` | 11/16 | table headers (uppercase, 600), count chips |
| `text-xs` | 12/16 | **form labels**, meta, timestamps, badges |
| `text-sm` | 13/18 | **table cells, buttons, inputs** — the density workhorse |
| `text-base` | 14/20 | default UI text, form values |
| `text-md` | 16/24 | card title, modal title (`text-md` now emits CSS) |
| `text-lg` | 18/26 | |
| `text-xl` | 20/28 | page `<h1>` |
| `text-2xl` | 24/32 | KPI value |
| `text-3xl` / `text-4xl` | 28/36, 32/40 | rare |

Body default is 14/20. Font is **Inter, self-hosted** (`@fontsource/inter`, weights 400/500/600 only). `font-mono` for IDs/hashes/emails in tables only.

Add `tabular` to any element with numbers. `<th>` and `td.numeric` get it automatically.

### Radius / shadow / motion

| Class | px | Applies to |
|---|---|---|
| `rounded-xs` | 2 | checkbox |
| `rounded-sm` | 4 | badge, chip |
| `rounded` / `rounded-md` | 6 | **button, input, select, menu item** |
| `rounded-lg` | 8 | card, panel, table container, popover |
| `rounded-xl` | 10 | modal, drawer |
| `rounded-full` | ∞ | avatar and status dot only |
| `rounded-2xl` / `rounded-3xl` | 12 / 14 | **legacy aliases only** — do not use in new code |

Shadows `shadow-2xs xs sm md lg` — all neutral. `shadow-xl` / `shadow-2xl` are aliased to `lg`; don't use them. **Zero coloured shadows.** Elevation comes from `border-line` on `bg-surface`.

Transitions default to 150ms. Animations available: `animate-fade-in`, `animate-slide-in`, `animate-slide-in-right`, `animate-shake`, `animate-dialog-in/out`, `animate-overlay-in/out`. A global `prefers-reduced-motion` block disables everything.

Layout tokens: `h-topbar` (48px), `w-sidebar` (240px), `w-sidebar-collapsed` (56px). Z-index: `z-dropdown 40 · z-sticky 30 · z-sidebar 20 · z-drawer 50 · z-modal 60 · z-toast 70 · z-tooltip 80`.

### Utility classes that now exist (previously defined nowhere)

`skeleton` / `skeleton-shimmer` / `animate-shimmer` (real 1.4s shimmer) · `hover-glow-card` (subtle neutral hover, deliberately **not** a glow) · `custom-scrollbar` · `tabular` · `focus-ring`.

### ⚠️ Legacy shades

`indigo-150`, `slate-805`, `indigo-550`, `indigo-505`, `slate-850`, `slate-150`, `slate-550`, `red-650`, `emerald-250`, `amber-950`, `purple-650` … all **33** previously-nonexistent shades are now defined in `tailwind.config.js` under a `LEGACY SHADES` banner, so the un-migrated pages keep rendering.

**Delete every use of them as you rewrite a page.** They will be removed from the config once no page references them. `grep -nE '\-(slate|indigo|red|emerald|purple|amber)-(55|105|150|250|350|405|450|455|505|550|605|650|655|750|755|805|850|855|950)\b' src/pages` finds them.

---

## 2. UI primitive library — `client/src/components/ui/`

Import from the barrel:

```js
import { Button, Input, DataTable, toast, useConfirm } from '../components/ui'
```

### Button

```jsx
<Button variant="primary" size="md" leftIcon={<Plus className="h-4 w-4"/>} loading={saving}>
  Create task
</Button>
<Button variant="danger-ghost" size="sm" iconOnly aria-label="Delete task"><Trash2 className="h-4 w-4"/></Button>
<Button as={Link} to="/tasks" variant="link">All tasks</Button>
```

| Prop | Type | Default | Notes |
|---|---|---|---|
| `variant` | `primary` \| `secondary` \| `ghost` \| `danger` \| `danger-ghost` \| `link` | `secondary` | |
| `size` | `sm` \| `md` \| `lg` | `md` | heights 28 / 32 / 36 |
| `loading` | bool | `false` | spinner replaces `leftIcon`, **label stays** (no width jump), sets `aria-busy`, disables |
| `disabled` | bool | `false` | |
| `leftIcon` / `rightIcon` | node | | 14–16px lucide |
| `iconOnly` | bool | `false` | square; pass the icon as `children`; **`aria-label` required** (dev warning if missing) |
| `fullWidth` | bool | `false` | |
| `as` | element type | `'button'` | e.g. `Link` |

`buttonVariants(...)` is exported for the rare case you need the classes without the component.

### Input / Textarea

```jsx
<Input size="md" invalid={!!error} leadingIcon={<Search />} placeholder="Search…" />
<Textarea rows={4} invalid={!!error} />
```

`Input`: `size` (`sm|md|lg` → 28/32/36), `invalid`, `leadingIcon`, `trailingIcon`, plus all `<input>` props. Focus = `border-primary-600` + a 3px tinted ring. Error = danger border + ring + `aria-invalid`.
`Textarea`: `invalid`, `rows`; min-height 72, vertical resize only.
`controlVariants` is exported so custom controls can match.

### Select / SelectMenu

```jsx
<Select value={v} onChange={e => setV(e.target.value)} placeholder="All statuses"
        options={[{value:'open',label:'Open'},{value:'done',label:'Done'}]} />

<SelectMenu value={v} onValueChange={setV} ariaLabel="Assignee"
            options={[{value:'1',label:'Asha',group:'Heads'}]} />
```

`Select` is a styled **native** `<select>` (use for ≤10 flat options). `SelectMenu` is Radix — use for grouped/long lists. Both take `size`, `invalid`, `disabled`.

### Checkbox

```jsx
<Checkbox id="auto" label="Assign without approval" description="Skips the approval queue"
          checked={v} onCheckedChange={setV} />
<Checkbox size="sm" aria-label="Select row 3" checked={sel} onCheckedChange={...} />
```

Supports `checked="indeterminate"` (renders a dash) — required for table select-all.

### Label / FormField

`FormField` is the preferred way to build a field: it generates the `id`, wires `htmlFor`, `aria-describedby` and `aria-invalid`, and renders hint + error.

```jsx
<FormField label="Deadline" required hint="Working days only" error={errors.deadline}>
  {(field) => <Input {...field} type="date" value={v} onChange={...} />}
</FormField>
```

The render-prop receives `{ id, required, invalid, 'aria-invalid', 'aria-describedby' }` — spread it onto the control. Props: `label`, `required`, `error`, `hint`, `optionalText`, `id`, `className`.

`Label` standalone: `htmlFor`, `required`, `optionalText`. Rendered 12/16 weight 500 `text-fg-2` — sentence case, **not** uppercase, **not** 10px.

### Badge / CountBadge

```jsx
<Badge variant="warning" icon={<Clock className="h-3 w-3"/>}>Overdue</Badge>
<CountBadge count={128} max={99} variant="danger" />
```

`Badge`: `variant` (`neutral|info|success|warning|danger|primary|outline`), `size` (`sm|md|lg` → h16/20/24), `icon`, `dot`. **Always render text** — colour alone fails WCAG 1.4.1. `dot` is permitted only alongside a label.
`CountBadge`: `count`, `max`, `variant` (`primary|danger|neutral`). Renders nothing when count ≤ 0. Tabular figures.

### Card / StatTile

```jsx
<Card>
  <CardHeader title="Connections" description="Gmail accounts" actions={<Button size="sm">Add</Button>} />
  <CardBody>…</CardBody>
  <CardFooter><Button variant="primary">Save</Button></CardFooter>
</Card>

<StatTile label="Overdue" value={formatNumber(12)} tone="danger"
          delta={{ value: '3 more than last week', direction: 'up', tone: 'danger' }} />

{/* a tile that navigates — one focusable control, no <Link> wrapper */}
<StatTile as={Link} to="/tasks?status=Late" icon={AlertTriangle}
          label="Overdue" value={formatNumber(12)} tone="danger" />
```

`StatTile` is deliberately flat: no icon *tile*, no accent border, no hover lift, **no count-up animation** — the number must be correct the instant it paints.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `label` | node | | plain text is expected; you no longer need to smuggle an icon in here |
| `value` | node | | already formatted (`formatNumber`) |
| `delta` / `hint` / `tone` | | | unchanged |
| `icon` | lucide **component** or element | | added in Wave 2 (U-6). `icon={Inbox}` renders it at 14px inline beside the label. Without `icon` the label element is byte-identical to before |
| `as` | element type | `'div'` | e.g. `Link` or `'a'`. The `ui/` layer stays router-free, so pass the component in — same convention as `Button` |
| `to` / `href` | string | | forwarded only when set |

When `as` is anything other than `'div'` the tile gets `block`, a hover border/fill and a `focus-visible` ring, so the **whole tile** is the single tab stop. Do not wrap a `StatTile` in a `<Link>` any more.

### Dialog

```jsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent size="md" title="New task" description="Assign work to a team member"
                 footer={<>
                   <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
                   <Button variant="primary" loading={saving} onClick={save}>Create task</Button>
                 </>}>
    …fields…
  </DialogContent>
</Dialog>
```

Radix-backed: focus trap, ESC, `aria-modal`, `aria-labelledby`/`describedby`, body scroll lock, focus restore.
`DialogContent` props: `size` (`sm 400 | md 520 | lg 720 | xl 960`), `title` (**required**), `description`, `showClose`, `headerActions`, `footer`, `dismissable` (set `false` for a dirty form — blocks ESC and scrim click), `bodyClassName`.
Footer actions are auto-width and right-aligned: `[Cancel: secondary] [Confirm: primary]`. **Never `w-1/2`.**

### ConfirmDialog + `useConfirm()`

This replaces all 12 `window.confirm()` / `alert()` calls.

```jsx
const confirm = useConfirm()

const ok = await confirm({
  title: 'Delete task “Q3 GST filing”?',
  description: 'The task and its 4 comments are removed permanently.',
  confirmLabel: 'Delete task',
  cancelLabel: 'Keep task',
  tone: 'danger',            // 'danger' | 'warning' | 'info'
})
if (!ok) return
```

`ConfirmProvider` is already mounted in `App.jsx`. A declarative `<ConfirmDialog open … onConfirm />` also exists if you need it inline. Title states the object; description states the consequence.

**Typed confirmation (Wave 2, U-1).** For an irreversible bulk action, add `requireTyped` instead of hand-rolling a second dialog:

```jsx
const ok = await confirm({
  title: 'Clear the entire inbox?',
  description: 'All 1,284 stored emails are deleted permanently.',
  confirmLabel: 'Clear inbox',
  requireTyped: { value: 'DELETE' },
})
```

`requireTyped: { value, label?, placeholder?, hint? }`

| Key | Notes |
|---|---|
| `value` | the string the user must type. Comparison is trimmed and **case-sensitive** |
| `label` | node above the field. Defaults to `Type <value> to confirm` |
| `placeholder` | defaults to `value` |
| `hint` | small text under the field, wired to `aria-describedby` |

The confirm button is `disabled` until the field matches; Enter in the field confirms once it does; focus lands on the field rather than the confirm button; the field is cleared every time the dialog reopens. Omit `requireTyped` and the dialog is exactly the simple one it always was.

### Drawer

```jsx
<Drawer open={o} onOpenChange={setO}>
  <DrawerContent size="md" title={email.subject} description={`From ${email.from}`}
                 headerActions={<Button size="sm" variant="primary">Create task</Button>}>
    <EmailBody html={email.body} />
  </DrawerContent>
</Drawer>
```

`size`: `sm 480 | md 640 | lg 880`. Right-side by default (`side="left"` available). Use for the email reading pane, task detail, activity-log detail.

### DropdownMenu

```jsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button iconOnly aria-label="More actions"><MoreHorizontal className="h-4 w-4"/></Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuLabel>Account</DropdownMenuLabel>
    <DropdownMenuItem onSelect={sync}><RefreshCw className="h-4 w-4"/>Sync now</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem destructive onSelect={disconnect}><Unlink className="h-4 w-4"/>Disconnect</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

Also exported: `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup/RadioItem`, `DropdownMenuSub/SubTrigger/SubContent`, `DropdownMenuShortcut`, `DropdownMenuGroup`.
**Destructive top-level buttons belong in this menu** — e.g. "Clear all inbox" must not be a red button in the toolbar.

### Popover

`Popover` / `PopoverTrigger` / `PopoverContent` / `PopoverAnchor` / `PopoverClose`. Use for filter panels and column-visibility menus; use `DropdownMenu` for lists of actions.

### Tooltip

`TooltipProvider` is mounted in `App.jsx`. `<Tooltip content="Sync now" side="top"><Button …/></Tooltip>`. Passing a falsy `content` returns the child untouched. **Never carry essential information in a tooltip.**

### Tabs / SegmentedControl

```jsx
<Tabs value={tab} onValueChange={setTab}>
  <TabsList>
    <TabsTrigger value="inbox" count={128}>Inbox</TabsTrigger>
    <TabsTrigger value="spam" count={4}>Spam</TabsTrigger>
  </TabsList>
  <TabsContent value="inbox">…</TabsContent>
</Tabs>

<SegmentedControl ariaLabel="View mode" value={view} onValueChange={setView}
  options={[{value:'table',label:'Table',icon:<Table2/>},{value:'board',label:'Board',icon:<Columns/>}]} />
```

Underline tabs, 38px, roving tabindex + arrow keys from Radix. Put the active tab in the URL (`?tab=spam`). `SegmentedControl` is for view switching, not navigation.

### Table primitives

`TableContainer` · `Table` · `THead` (sticky by default) · `TBody` · `TFoot` · `TR` · `TH` · `TD` · `TDActions` · `TableMessageRow`.

- `TR`: `density` (`compact 32 | default 40 | relaxed 48`), `selected` (primary tint + 2px inset bar), `interactive`.
- `TH`: `numeric`, `sorted` (`'asc'|'desc'|false` → sets `aria-sort`), `onSort` (makes it a button + chevron), `width`. `sorted` behaves identically whether the state is local or server-owned — `DataTable` feeds it from its `sorting` state — so a **server-sorted** table announces `aria-sort` correctly with no `sr-only` text and no stateful `aria-label`. The chevrons are `aria-hidden`.
- `TD`: `numeric` (right-align + tabular), `primary` (weight 500, `text-fg`), `truncate` (default `true`).
- `TDActions`: sticky-right 88px actions cell.

### DataTable (TanStack v8)

```jsx
const columns = [
  { accessorKey: 'subject', header: 'Subject', meta: { primary: true } },
  { accessorKey: 'client',  header: 'Client',  meta: { width: '160px' } },
  { accessorKey: 'open',    header: 'Open',    meta: { numeric: true } },
  { id: 'actions', header: '', enableSorting: false,
    cell: ({ row }) => <RowMenu row={row.original} />, meta: { width: '88px', truncate: false } },
]

<DataTable
  ariaLabel="Tasks"
  data={tasks}
  columns={columns}
  loading={loading}
  enableSelection
  rowSelection={selection} onRowSelectionChange={setSelection}
  getRowId={(r) => r._id}
  onRowClick={(row) => openDrawer(row)}
  density="default"
  initialSorting={[{ id: 'deadline', desc: false }]}
  pagination={{ page, pageSize, total, onPageChange, onPageSizeChange }}   // server-side
  emptyState={{ title: 'No tasks match these filters', secondaryAction: { label: 'Clear filters', onClick: clear } }}
/>
```

| Prop | Notes |
|---|---|
| `data`, `columns` | TanStack v8 column defs |
| `loading` | renders skeleton **rows** at the real row height, never a spinner |
| `enableSelection` | prepends a checkbox column with a real indeterminate header state |
| `rowSelection` / `onRowSelectionChange` | controlled; omit both to let the table own it |
| `getRowId` | use `(r) => r._id` so selection survives refetch |
| `onRowClick` | row becomes interactive; the checkbox cell stops propagation |
| `rowActivation` | `'none'` (default) \| `'row'` \| `'cell'` — the **keyboard** path. See below |
| `density` | `compact` 32 / `default` 40 / `relaxed` 48 |
| `pagination` | `true` = client-side, or an object = server-side (`page` is 1-based) |
| `initialSorting` | uncontrolled seed, unchanged |
| `sorting` / `onSortingChange` | **controlled/server sorting.** See below |
| `manualSorting` | explicit override; defaults to `true` when `sorting` is passed |
| `emptyState` | forwarded to `EmptyState` |
| `ariaLabel` | **required** when there is no visible caption |

Column `meta`: `numeric`, `primary`, `width`, `truncate`, `rowOpener`.

#### Controlled sorting — server-paginated tables (Wave 2, U-2)

Previously `sorting` was internal `useState` and `getSortedRowModel` was always installed, so on a server-paginated set a header click reordered **only the visible 25 rows** — silently wrong. Three pages worked around it with `enableSorting: false` on every column plus their own toolbar sort control.

Pass `sorting` and the table becomes server-sorted:

```jsx
const [params, setParams] = useSearchParams()
const sorting = [{ id: params.get('sort') || 'createdAt', desc: params.get('dir') !== 'asc' }]

<DataTable
  data={rows}                       // already ordered by the server
  columns={columns}                 // leave enableSorting alone — real headers work now
  sorting={sorting}
  onSortingChange={(next) => {
    const [s] = next
    setParams((p) => { p.set('sort', s?.id ?? ''); p.set('dir', s?.desc ? 'desc' : 'asc'); return p })
  }}
  pagination={{ page, pageSize, total, onPageChange, onPageSizeChange }}
/>
```

- `getSortedRowModel` is **not installed** and `manualSorting` is on, so the visible page is never re-ordered locally.
- `onSortingChange` receives the **resolved array**, never a TanStack updater function.
- `aria-sort` is still driven off `sorting`, so headers announce correctly.
- Omit `sorting` and behaviour is byte-identical to before: internal state, `initialSorting` seed, client-side `getSortedRowModel`. (If you pass `onSortingChange` *without* `sorting`, internal state still updates and you also get notified.)

#### Keyboard-operable rows (Wave 2, U-3)

`onRowClick` on its own is mouse-only. `rowActivation` adds the keyboard path and is **opt-in** because EmailInbox and TaskList already render their own `<button data-row-open>` inside a cell and drive `j`/`k` by moving DOM focus to it — turning row activation on by default would give two tab stops per row and double-activate on Enter.

| Value | Behaviour |
|---|---|
| `'none'` (default) | historical: mouse click only. Correct when the page supplies its own focusable control in a cell |
| `'cell'` | **preferred for new code.** The opener column's cell content is wrapped in a real `<button data-row-open={rowId}>` — a correct `button` role, one tab stop, and `[data-row-open]` for `j`/`k`. The opener is the column with `meta.rowOpener`, else the first `meta.primary` column |
| `'row'` | the `<tr>` becomes `tabIndex={0}` with `data-row-open` and Enter/Space activate it. The keydown handler ignores events whose target is not the row itself, so a button inside a cell cannot activate twice. Use when no single cell is the natural opener |

The row keeps its implicit `row` role in `'row'` mode — `role="button"` on a `<tr>` would break the table's required structure. The focus ring comes from `TR`'s existing `focus-within` outline.

### Pagination

`<Pagination page={1} pageSize={25} total={1284} onPageChange={} onPageSizeChange={} itemLabel="emails" />` — 44px bar, "Showing 1–25 of 1,284 emails", first/prev/next/last, rows-per-page select. Mirror the state into the URL.

The rows-per-page select id is generated with `useId()` (Wave 2, U-4). It used to be the literal `id="rows-per-page"`, which duplicated the moment two tables shared a screen and broke the `<label for>` association for both. Pass `rowsPerPageId` only if you need a stable, known id (e.g. to point a `aria-controls` at it).

### EmptyState

```jsx
<EmptyState icon={Inbox} title="No emails in this tab"
            description="New mail appears here after the next sync."
            action={{ label: 'Sync now', onClick: sync }}
            secondaryAction={{ label: 'Clear filters', onClick: clear }} />
```

`icon` is a lucide **component** (not an element, never an emoji), 32px, no tile background. Write **distinct copy** for "no data yet" versus "no results for this filter" — the latter must offer "Clear filters".

### Skeleton

`Skeleton` (set height/width via className) · `SkeletonText({lines})` · `SkeletonTable({rows, columns})` · `SkeletonTiles({count})`. Skeletons must mirror the real layout.

### Avatar

`<Avatar name="Asha Rao" id={user._id} size="md" src={url} />` — sizes `xs 20 / sm 24 / md 32 / lg 40`, deterministic muted tint hashed from `id ?? name`. **No gradients, no gradient rings.**
`<AvatarGroup users={[…]} max={4} size="sm" />` — overlap with a `+N` chip.

### Spinner

`<Spinner size="md" label="Loading" />` (pass `label=""` inside a button that already has a name) · `<SpinnerBlock label="Loading clients" />`.

### Alert

```jsx
<Alert variant="danger" title="Could not load tasks" action={<Button size="sm" onClick={retry}>Retry</Button>}>
  {errorMessage}
</Alert>
```

Use for anything that must stay on screen — form-level auth failure, a failed data load with a retry. `variant`: `info|success|warning|danger`. `danger` gets `role="alert"`.

### PageHeader / Toolbar / PageBody

```jsx
<PageHeader title="Inbox" description="…" breadcrumb={…}
            actions={<Button variant="primary">Sync now</Button>} />
<Toolbar left={<Tabs …/>} right={<><Input leadingIcon={<Search/>} /><Button>Filters</Button></>} />
<PageBody>{content}</PageBody>
```

`PageHeader` is 56px and sticky by default (`sticky={false}` to opt out) and holds the screen's single `<h1>`. `Toolbar` is 44px. `PageBody` is `px-6 py-5`.
**Do not add `max-w-7xl` to data screens** — tables and lists are fluid. Forms/settings may cap at `max-w-[720px]`.

### Toaster / toast

Mounted once in `App.jsx`. Import `toast` from the barrel:

```js
toast.success('Task created')
toast.error('Could not save', { description: getErrorMessage(err) })
toast.warning('Rate limited')
toast.promise(save(), { loading: 'Saving…', success: 'Saved', error: 'Failed' })
```

Bottom-right, max 3, 360px, 4s default, semantic left accent bar, close button. **Delete every copy-pasted toast block and its state as you rewrite a page.**

---

## 3. Shared components outside `ui/`

### `EmailBody` — `components/EmailBody.jsx`

The **only** permitted renderer of untrusted email HTML. Replaces the two diverged `renderEmailContent` copies in `EmailInbox.jsx` and `TaskList.jsx` (one stripped `<script>`, one did not — the stored-XSS root cause).

```jsx
import EmailBody, { emailSnippet } from '../components/EmailBody'

<EmailBody html={email.body} minHeight={240} maxHeight={800} allowRemoteImages={showImages} />
<span>{emailSnippet(email.body, 120)}</span>
```

| Prop | Default | Notes |
|---|---|---|
| `html` | | raw body, HTML or plain text |
| `minHeight` / `maxHeight` | 200 / 800 | |
| `autoHeight` | `true` | measures content + `ResizeObserver` |
| `allowRemoteImages` | `false` | the "Show images" / tracking-pixel gate. Caller-owned |
| `imageGate` | `false` | **Wave 2.** Opt in to the *shared* gate — see below |
| `title` | `'Email content'` | iframe accessible name |

Defence in depth: DOMPurify sanitises; the iframe sandbox is `allow-popups allow-popups-to-escape-sandbox` (**never** `allow-scripts`, and never `allow-scripts` paired with `allow-same-origin`); an inline CSP sets `script-src 'none'` and gates `img-src`; every anchor is rewritten to `target="_blank" rel="noopener noreferrer nofollow"`.
`emailSnippet(body, length)` returns sanitised plain text for list rows and previews.
**Do not reintroduce a local `renderEmailContent`.**

**Shared remote-image gate.** EmailInbox built its own "Show remote images" button in the drawer header; TaskList renders `EmailBody` with no gate at all, so its remote images are blocked with no way to reveal them. `imageGate` moves that control into the component:

```jsx
<EmailBody html={email.body} imageGate />
```

- Default `false` — the component renders a **bare `<iframe>`**, byte-identical to before, so both existing callers are untouched.
- `allowRemoteImages` still wins: a caller that owns the toggle (EmailInbox) never sees the internal bar.
- The bar only appears when the body actually references a remote image — `hasRemoteImages(html)` is exported for the same check.
- Consent is per-message: it resets when `html` changes, so opening email B never inherits email A's opt-in.

### `AuthProvider` / `useAuth()`

```js
const { user, setUser, login, logout, isAuthenticated, role,
        isAdmin, isHead, isEmployee, hasRole, displayName } = useAuth()
```

- `user` is `null` when signed out — there is no `{ name: 'Guest' }` placeholder. Use `displayName` for rendering.
- `hasRole('Admin')` or `hasRole(['Admin','Head'])`.
- `login({ token, user })` after a successful sign-in.
- `logout()` clears the token, the user **and all 7 `cached_*` keys**.

**Never read `localStorage.getItem('user')` in a page again.** If you need it outside React, use `client/src/lib/auth.js`.

### `ErrorBoundary`

Wraps the router and every route already. Use `<ErrorBoundary compact>` around a risky panel (e.g. a chart) if you want finer isolation. Props: `title`, `description`, `compact`, `fallback`, `resetKey`, `onError`.

### `CommandPalette` + `CommandRegistry` (Wave 2, U-5)

⌘K / Ctrl+K. There is exactly **one** palette in the app, mounted by `ProtectedLayout`. Do **not** render a second one: every instance binds ⌘K on `document`, so two would open two dialogs and fight over focus. That is why the previous advice ("render your own instance with `extraCommands`") was unusable, and why no page shipped a single command.

Pages now contribute through the registry:

```jsx
import { useRegisterCommands } from '../components/CommandRegistry'

useRegisterCommands(
  [
    { id: 'inbox-sync',  label: 'Sync inbox now', icon: <RefreshCw className="h-4 w-4" />, onSelect: sync },
    { id: 'inbox-clear', label: 'Clear all emails', group: 'Inbox', onSelect: clearAll },
  ],
  [sync, clearAll],   // deps, exactly like useEffect
)
```

| Command key | Notes |
|---|---|
| `id` | required and unique; a duplicate id is dropped |
| `label` | required, what the user searches and sees |
| `onSelect` | required; runs after the dialog closes, so focus restore behaves |
| `icon` | optional **element** (not a component) |
| `group` | optional group heading; defaults to `Actions` |
| `keywords` | optional extra search terms |

- Commands **unregister on unmount**, so leaving a page removes its commands.
- The second argument is a dependency array. The `commands` array literal is a new object every render and is deliberately *not* a dependency — list the values the commands close over.
- `CommandRegistryProvider` wraps the shell in `ProtectedLayout`. It is optional: outside a provider the hook is a no-op and the palette works standalone.
- `extraCommands` on `<CommandPalette>` still works and is merged with the registry (registry first).
- For a permanent navigation target, still prefer adding it to `NAV_COMMANDS` in `CommandPalette.jsx`.

### `ThemeProvider` / `useTheme()`

`{ theme, preference, resolvedTheme, setTheme, toggleTheme }`. `theme` is the resolved `'light' | 'dark'`; `setTheme` accepts `'light' | 'dark' | 'system'`. Persisted under `maildesk_theme`. Toggling adds/removes `.dark` on `<html>`.

### `KeywordApprovalModal`

Unchanged public API — `{ isOpen, onClose, onRuleUpdated }` — rebuilt on the shared `Dialog` with semantic tokens. `EmailInbox` can keep using it as-is.

---

## 4. API client — `client/src/api/axios.js`

```js
import api, { getErrorMessage, isCanceled, abortable, ignoreCancel } from '../api/axios'
```

- Base URL from `VITE_API_URL`. Bearer token attached automatically.
- **Response interceptor** handles: `401` → clear session + redirect to `/login?next=…` **once** (no loop; login/register requests are exempt); `403` → permission toast; `429` → rate-limit toast with retry-after; network/timeout/offline → a clear message. Every rejection carries `err.userMessage`.
- `getErrorMessage(err, fallback)` — render this, don't dig through `err.response.data.message`.
- Cancellation: pass `{ signal: controller.signal }`; use `isCanceled(err)` or `.catch(ignoreCancel)`.
- `abortable((signal) => api.get('/tasks', { signal }))` → `{ promise, abort, signal }`.

**Pages must not toast a 401/403/429 themselves** — the interceptor already did.

## 5. Environment — `client/src/lib/config.js`

`client/.env` and `client/.env.example`:

```
VITE_API_URL=http://localhost:5015/api
VITE_SOCKET_URL=http://localhost:5015
```

`config.js` exports `API_URL`, `SOCKET_URL`, `API_ORIGIN`, `IS_DEV`, `IS_PROD`. It **throws at boot in a production build** if a variable is missing, and warns + falls back in dev. Both must be absolute http(s) URLs; trailing slashes are stripped.
The repo `.gitignore` now ignores `.env*` and un-ignores `.env.example` (it previously missed `.env.production`).

**No file may hard-code `http://localhost:5015` again.**

## 6. Sockets — `client/src/lib/socket.js`

One shared connection: `getSocket()` (returns `null` without a token), `reconnectSocket()`, `closeSocket()`, `isAuthHandshakeError(err)`.
It reconnects automatically when the token changes (re-login, `tokenVersion` bump), caps retries at 5, and every consumer must handle `connect_error`.

## 7. Auth storage — `client/src/lib/auth.js`

`getToken` · `setToken` · `getUser` · `setUser` · `setSession` · `clearSession` · `clearCaches` · `isAuthenticated` · `getRole` · `hasRole` · `isAdmin/isHead/isEmployee` · `subscribe` · `CACHE_KEYS` · `ROLES`.

`CACHE_KEYS` lists all 7 per-user caches: `cached_dashboard_tasks`, `cached_dashboard_stats`, `cached_inbox_emails`, `cached_clients_data`, `cached_reports_overall`, `cached_reports_timeline`, `cached_tasks_data`.
**If a page adds a new `cached_*` key, add it to `CACHE_KEYS`** — otherwise the next user on a shared machine inherits it.

## 8. Shell & routing

`App.jsx` — provider order `ErrorBoundary → ThemeProvider → AuthProvider → TooltipProvider → ConfirmProvider → BrowserRouter`, with `<Toaster/>` mounted once. All 12 routes plus the shell are `React.lazy` with a layout-shaped skeleton fallback and a per-route `ErrorBoundary`. A real 404 renders inside the shell.

`ProtectedLayout.jsx` — fixed shell:

```
h-screen flex-col overflow-hidden
├── Navbar            h 48, border-b, bg-surface
└── flex flex-1 min-h-0
    ├── Sidebar       240 / 56 (flex sibling on desktop — the old 20px clip is now impossible)
    └── <main>        the ONLY scroll container in the app
```

The 8-second `/auth/me` poll is gone. Session freshness now comes from the Socket.io handshake (the server rejects a stale `tokenVersion` with a `connect_error`), plus a **5-minute** fallback poll. A role change updates context state and toasts — it never calls `window.location.reload()`.

**Because `<main>` is the scroller:** do not add `min-h-screen`, `h-screen` or `overflow-hidden` to a page root, and do not attach `window.scroll` listeners. For a sticky element inside a page, `sticky top-0` works against `<main>`.

Helpers you can rely on: `PageHeader` is already `sticky top-0 z-sticky`.

---

## 9. What was deleted

| Deleted | Was |
|---|---|
| `utils/cursorEffects.js` | custom cursor, 5 trailing violet dots, magnetic buttons, click ripples |
| `utils/moduleCursor.js` | 320px violet spotlight (already dead code) |
| `utils/tiltEffect.js` | ±6° 3D tilt + cursor-tracking glare on KPI cards |
| `utils/countUp.jsx` | 1.5s slot-machine numbers → replaced with `formatNumber()` |
| `utils/scrollAnimations.js` | scroll-reveal + a `MutationObserver` on `document.body` with `subtree:true` |
| `App.css` | 184 lines of unmodified, never-imported Vite template |
| `index.css` cruft | `cursor: none !important`, blob/float/pulse-ring/gradientShift keyframes, `.glassmorphism`, `.dot-grid`, `.perspective-1200`, `.link-underline`, `.reveal-element`, `.stagger-reveal`, `scroll-behavior: smooth` |
| `select-none` | 28 occurrences stripped from every page root |
| Google Fonts `@import` + `<link>` | Outfit at 14 weights, render-blocking → self-hosted Inter 400/500/600 |

`formatNumber`, `timeAgo`, `initials`, `hashIndex` and `cn` live in `client/src/lib/utils.js`.

---

## 10. Build & lint status

### Current — after Wave 2 consolidation (U-1 … U-7)

`npx eslint .` → **0 errors, 1 warning**. The one warning is the unavoidable `react-hooks/incompatible-library` on `useReactTable` in `DataTable.jsx`. Pages included.

`npx vite build` → passes, no 500 kB warning.

| Chunk | raw | gzip |
|---|---|---|
| `Reports` | 397.2 kB | 113.7 kB |
| `vendor-react` | 211.5 kB | 67.7 kB |
| `Tooltip` (Radix popper, shared) | 122.1 kB | 38.9 kB |
| `vendor-table` | 50.1 kB | 13.1 kB |
| `ui` | 47.0 kB | 14.6 kB |
| `axios` | 44.9 kB | 17.4 kB |
| `EmailInbox` | 43.5 kB | 13.4 kB |
| `vendor-router` | 42.1 kB | 15.1 kB |
| `TaskList` | 41.9 kB | 12.9 kB |
| `vendor-socket` (lazy) | 41.2 kB | 12.9 kB |
| `DropdownMenu` | 39.8 kB | 12.1 kB |
| `EmailBody` (incl. DOMPurify) | 31.9 kB | 12.8 kB |
| `ProtectedLayout` | 29.7 kB | 10.5 kB |
| `ManageUsers` | 27.2 kB | 8.5 kB |
| `index` | 16.8 kB | 5.7 kB |
| `Dashboard` / `ClientList` / `Profile` / `ActivityLog` | 16.8 / 16.3 / 16.3 / 15.9 kB | 5.4 / 5.4 / 5.2 / 5.5 kB |
| `ForgotPassword` / `Register` / `Login` / `Landing` | 7.4 / 6.2 / 4.5 / 2.2 kB | 2.5 / 2.3 / 1.8 / 1.0 kB |
| CSS | 52.4 kB | 10.4 kB |

`Reports` is the one outlier — it carries the charting code. Worth a look but out of scope for the foundation.

The Wave 2 changes are all additive: every new prop is optional and every default reproduces the previous behaviour, so the five rebuilt pages were not edited.

`client/eslint.config.js` — the `react-refresh/only-export-components` override now also covers `src/components/CommandRegistry.jsx` (it exports the provider plus two hooks, same category as `EmailBody.jsx` and `ErrorBoundary.jsx`).

### Historical — at foundation handoff

**Bundle — before:** one chunk, `637.96 kB` (`160.95 kB` gzip) + `64.16 kB` CSS (`11.29 kB` gzip). `/login` downloaded TaskList, EmailInbox, Reports and socket.io.

**After:** 22 chunks. `/login` loads ≈ **136 kB gzip** (react 67.7 + router 14.7 + axios 17.4 + app index 33.9 + Login 2.2). The 500 kB warning is gone.

| Chunk | raw | gzip |
|---|---|---|
| `vendor-react` | 211.5 kB | 67.7 kB |
| `index` (shell + providers + ui) | 101.1 kB | 33.9 kB |
| `EmailInbox` | 95.0 kB | 28.1 kB |
| `TaskList` | 55.8 kB | 11.4 kB |
| `axios` | 44.8 kB | 17.4 kB |
| `vendor-router` | 41.3 kB | 14.7 kB |
| `vendor-socket` (lazy) | 41.2 kB | 12.9 kB |
| `ManageUsers` / `ClientList` / `ProtectedLayout` | 34.4 / 30.1 / 30.3 kB | 6.1 / 5.2 / 10.5 kB |
| `Landing` / `Reports` / `Dashboard` / `Profile` | 26.2 / 25.3 / 21.4 / 13.8 kB | 5.2 / 5.9 / 3.9 / 3.6 kB |
| `ActivityLog` / `Register` / `Login` / `ForgotPassword` | 8.6 / 7.4 / 6.3 / 5.9 kB | 2.7 / 2.3 / 2.2 / 2.2 kB |
| CSS | 87.2 kB | 15.2 kB |

CSS grew because the token set **and** the 33 legacy shades are both compiled. It shrinks once the legacy block is deleted.

**Lint at handoff (`npx eslint .`): 68 errors + 12 warnings, ALL pre-existing and ALL in `src/pages/**`.** All of them were cleared by the page rebuilds — see the current status above.

Known page defects for the page agents (all since fixed by the page rebuilds):

- **`TaskList.jsx` — live crash.** `setSelectedTaskIds` and `setSelectAll` are called at lines 692/712/747 but never declared. Changing the Creator, Priority or Status filter throws `ReferenceError`. It now renders an inline error instead of a white screen (thanks to the route ErrorBoundary), but the bug is real.
- `Reports.jsx` — `generateReport` / `fetchClientStats` accessed before declaration (`react-hooks/immutability`).
- `EmailInbox.jsx` (13), `ManageUsers.jsx` (5), `ClientList.jsx` (4), `ActivityLog.jsx` (4), `Profile.jsx` (3) — unused vars, empty catch blocks, missing effect deps.
- `import React` is unused in every page under the modern JSX transform.

`client/eslint.config.js` gained one scoped override: `react-refresh/only-export-components` is off for `src/components/ui/**`, `*Provider.jsx`, `CommandRegistry.jsx`, `EmailBody.jsx` and `ErrorBoundary.jsx`, which legitimately export cva factories, re-exported Radix primitives and context hooks alongside components. **Everything else still errors** — the rule is untouched for `pages/`.
