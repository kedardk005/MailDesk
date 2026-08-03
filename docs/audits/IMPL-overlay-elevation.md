# IMPL — Overlay & elevation separation

Owner complaint: *"when open any action module it was blend with ui … make background
blur or black because here all are in dark mode looks same"*. When a dialog/drawer
opened, it did not read as a separate layer — in dark mode it was measurably
indistinguishable (1.02:1 scrim effect, 1.03:1 panel-vs-page).

All ratios below are WCAG contrast ratios computed from the token values
(alpha-composited where a scrim is involved), then confirmed in the running app by
reading computed styles on the open surfaces in both themes.

## Why "darker scrim" could not fix dark mode

The dark canvas is `#0B1220` — near black. Pure black at 0.8 alpha moves the page
only **1.10:1** from its undimmed self (measured); there is no luminance headroom
below the page. So the fix works the other way in dark mode: **the elevated surface
gets lighter** (how Material/GitHub/Linear express dark-mode elevation), the scrim
goes near-black at high alpha to mute page content, and a backdrop **blur**
separates by focus, which works independently of luminance. A 1px border makes the
edge unambiguous regardless of fill.

## Tokens introduced (`client/src/index.css`, consumed via `client/tailwind.config.js`)

| Token | Light | Dark | Tailwind class |
|---|---|---|---|
| `--bg-elevated` | `#FFFFFF` | `#232F42` | `bg-elevated` |
| `--bg-elevated-subtle` | `#EEF2F7` | `#2A3850` | `bg-elevated-subtle` |
| `--border-overlay` | `#CBD5E1` | `#43526B` | `border-line-overlay` / `bg-line-overlay` |
| `--overlay-scrim` (tint) | `15 23 42` | `0 0 0` | via `.overlay-scrim` class |
| `--overlay-scrim-alpha` | `0.55` | `0.70` | " |
| `--overlay-scrim-alpha-strong` | `0.65` | `0.80` | " (no-backdrop-filter fallback) |

`.overlay-scrim` (component class in index.css) =
`background: rgb(var(--overlay-scrim) / var(--overlay-scrim-alpha))` +
`backdrop-filter: blur(3px) saturate(0.85)`; inside
`@supports not (backdrop-filter: blur(1px))` the background switches to the
`-strong` alpha. No component carries a hardcoded scrim/hex any more (the old
inline `rgb(15_23_42/0.45)` in `Dialog.jsx` and `Sidebar.jsx` is gone).

Key text ratios on the dark elevated fill `#232F42` (verified by computation):
`--text-primary` #F1F5F9 = **12.31:1**, `--text-secondary` #CBD5E1 = **9.09:1**
(both ≥ 7:1), `--primary-text` #93C5FD = 7.48:1, `--danger-text` #FCA5A5 = 7.11:1.
`--text-tertiary` #94A3B8 = 5.26:1 — AA, used only for captions/labels, unchanged
policy. On `--bg-elevated-subtle` #2A3850: text-secondary = 7.95:1.

## Before / after, every overlay surface

"Sep." = contrast of the panel fill against what sits directly behind it
(the scrim-dimmed page for modal surfaces, the undimmed page for popup surfaces).
"Edge" = contrast of the 1px border against the panel fill.

### Modal surfaces (scrim behind: Dialog, ConfirmDialog, Drawer, CommandPalette)

| Measure | Light before | Light after | Dark before | Dark after |
|---|---|---|---|---|
| Scrim effect on page | 2.86 | **3.83** + blur 3px | **1.02 (invisible)** | 1.09 + blur 3px |
| Panel vs dimmed page | 3.30 | **4.42** | **1.03 (indistinguishable)** | **1.51** |
| Edge border vs panel | 1.48 (#CBD5E1) | 1.48 (unchanged) | 1.37 (#273244 on #111827) | **1.71** (#43526B on #232F42) |
| Edge border vs dimmed page | 2.98 | 2.98 | ~1.4 | **2.14** |
| Header/footer strip vs panel | 1.16 (bg-canvas) | 1.12 (elevated-subtle) | inverted (darker #0B1220) | **1.14 lighter** (#2A3850) |
| Internal dividers | 1.48 | 1.48 | **1.04 on panel (invisible)** | **1.71** |

Dark separation is deliberately delivered by three stacked cues, not one number:
lightness step (1.51) + 1px edge (1.71/2.14) + background blur. The blur is the
cue the owner asked for and is unaffected by the missing luminance headroom.

### Popup surfaces (no scrim: DropdownMenu, Popover, SelectMenu, NotificationBell)

| Measure | Light before | Light after | Dark before | Dark after |
|---|---|---|---|---|
| Panel vs page surface | 1.00 (white on white) | 1.00 + border | **1.00 (#111827 on #111827)** | **1.32** (#232F42) |
| Panel vs page canvas | 1.16 | 1.16 | 1.06 | **1.39** |
| Edge border vs page surface | 1.48 | 1.48 | 1.45 | **2.25** |
| Row highlight vs panel | 1.12 (bg-subtle) | 1.12 (elevated-subtle, same hex) | inverted (darker) | **1.14 lighter** |

### Toaster (sonner toasts)

| | Light | Dark before | Dark after |
|---|---|---|---|
| Toast fill vs canvas | 1.16 (unchanged) | **1.06** | **1.39** (#232F42) |
| Edge border vs fill | 1.48 (unchanged) | 1.37 | **1.71** |

### Tooltip — already correct, unchanged

Inverse fill (`bg-fg`): 17.85:1 vs light page, 16.19:1 vs dark page. No change.

### Mobile Sidebar (scrim + sliding panel)

| Measure | Light before | Light after | Dark before | Dark after |
|---|---|---|---|---|
| Panel vs dimmed page | 2.86 (canvas fill) | **4.42** (elevated) | **1.02 (invisible)** | **1.51** (elevated) |
| Scrim | flat 0.45, no blur | token scrim + blur | flat 0.45 — invisible | black 0.70 + blur |

Desktop (`lg:`) sidebar keeps `bg-canvas` / `border-line` — it is part of the page,
not a floating layer.

## Z-order audit

Scale after this change: `sidebar 20 < sticky 30 < 45 (mobile-nav scrim) <
drawer 50 (mobile nav panel) < overlay 55 (modal scrim) < modal 60 < dropdown 65 <
toast 70 < tooltip 80`.

Two defects found and fixed:

1. **Tied pair — mobile Sidebar scrim vs its own panel**: both were `z-drawer` (50),
   relying on DOM order. Scrim moved to `z-45` so it is explicitly below the panel
   (and still above sticky headers/page dropdowns' old slot).
2. **Inverted pair — `dropdown (40) < modal (60)`**: Radix portals dropdown/select/
   popover content to `<body>`, so a menu whose trigger lives *inside* a Dialog or
   Drawer painted **behind** the modal. Real occurrences: the SelectMenu in
   EmailInbox's convert-to-task dialog, the overflow DropdownMenu in TaskList's
   task drawer. `dropdown` raised to **65** (the shadcn/Radix convention —
   popup content above modal content). Safe because Radix dismisses open popups on
   any outside interaction, so a page-level menu cannot outlive a modal opening.

Confirmed clean: `overlay 55 < modal 60` (the previously-fixed drawer bug),
`toast 70` above modals, `tooltip 80` above everything, Table's internal sticky
header (`z-[2]`) scoped to its scroll container.

## Files changed

- `client/src/index.css` — elevation + scrim tokens, `.overlay-scrim` class
- `client/tailwind.config.js` — `elevated`/`elevated-subtle`/`line-overlay` colors, `zIndex.dropdown` 40→65
- `client/src/components/ui/Dialog.jsx` — scrim class; panel/header/footer on elevated tokens
- `client/src/components/ui/Drawer.jsx` — same
- `client/src/components/ui/DropdownMenu.jsx` — content, sub-content, separator, highlight
- `client/src/components/ui/Popover.jsx` — content
- `client/src/components/ui/Select.jsx` — SelectMenu content + highlight (native `<select>` untouched)
- `client/src/components/ui/Toaster.jsx` — toast, close button, cancel button
- `client/src/components/CommandPalette.jsx` — panel, input divider, kbd chip, selected row
- `client/src/components/Sidebar.jsx` — token scrim at `z-45`; panel elevated on mobile, canvas on `lg:`

ConfirmDialog, KeywordApprovalModal, NotificationBell, ActionExtraction and all
pages inherit through these primitives — no page-level overlay bypasses them
(grepped: no remaining `fixed inset-0` scrims or hardcoded overlay rgba).

## Runtime verification (dev build, both themes)

Signed in as `head@demo.test`; opened the Tasks drawer, the New-task dialog, the
command palette, the notification popover, the drawer's overflow menu, and the
mobile sidebar. Computed styles confirmed the tokens landed exactly:

- light overlay `rgba(15,23,42,0.55)` + `blur(3px) saturate(0.85)`, panel `#FFFFFF`,
  border `#CBD5E1`, footer `#EEF2F7`
- dark overlay `rgba(0,0,0,0.7)` + `blur(3px) saturate(0.85)`, panel `rgb(35,47,66)`,
  border `rgb(67,82,107)`, footer `rgb(42,56,80)`, header divider `rgb(67,82,107)`
- drawer overflow menu paints at z 65 above the drawer (z 60) — previously hidden
- mobile scrim z 45 under panel z 50, panel elevated in dark
- popover wrapper z 65, `bg-elevated` + `border-line-overlay` classes present

Motion policy untouched: scrim still animates opacity-only through the existing
150ms `overlay-in/out` keyframes; `prefers-reduced-motion` block unchanged and
still zeroes all durations (blur is a static filter, not an animation).

## Gates

- `npx eslint . --max-warnings=0` — 0 errors
- `npm run test -- --run` — 191/191 pass
- `npx vite build` — passes; built CSS contains `.overlay-scrim`, the
  `@supports not (…backdrop-filter…)` fallback, and both token sets

## Not verified / known limits

- The `@supports` no-blur fallback was verified in the compiled CSS but not
  exercised in a browser without backdrop-filter support (all evergreen browsers
  ship it; the fallback raises scrim alpha to 0.65/0.80).
- Toast styling verified against the code and token math, not by triggering a live
  toast during the session (same `bg-elevated`/`border-line-overlay` classes as the
  browser-verified panels).
- Dark popup-surface separation (1.32–1.39 fill step) is intentionally softer than
  the modal stack — popups sit next to their trigger and get the 2.25:1 border +
  shadow; pushing the fill lighter would cost body-text contrast on the panel.
- Page-level content *inside* drawers/dialogs still uses `border-line` for its own
  internal cards/dividers; those sit within the panel and were out of scope
  (changing every in-panel `border-line` call site would touch most pages).
