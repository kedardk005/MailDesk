# IMPL — Light theme legibility + semantic colour

Branch: `feat/light-theme-legibility`. Scope: `client/src/index.css`,
`client/src/components/ui/Card.jsx`, `client/src/pages/Dashboard.jsx`,
`client/src/pages/TaskList.jsx`. `tailwind.config.js` needed no change — every
token is CSS-variable driven, so the class names are untouched.

All contrast ratios below were **computed** (WCAG 2.x relative-luminance
formula, run in Node), not estimated. The two owner complaints addressed:

1. *"in light mode it was make pain in eyes all are white"* — canvas, surface
   and cards were within 1.05:1 of each other; the whole app read as one white
   sheet.
2. *"add some colour for text where need to automatically understand"* — almost
   every value was one of three neutrals; problem numbers looked identical to
   informational numbers.

---

## 1. Light-theme token changes (before → after, computed ratios)

### Surfaces and borders

| Token | Before | After | Separation before | Separation after |
|---|---|---|---|---|
| `--bg-canvas` | `#F8FAFC` | `#EAEFF5` | surface on canvas **1.05:1** (invisible) | surface on canvas **1.16:1** (visible, calm) |
| `--bg-surface` | `#FFFFFF` | unchanged | — | — |
| `--bg-subtle` | `#F1F5F9` | `#EEF2F7` | 1.10:1 on surface | **1.12:1** on surface (hover/header rows) |
| `--bg-muted` | `#E2E8F0` | unchanged | 1.23:1 on surface | unchanged |
| `--border-default` | `#E2E8F0` | `#CBD5E1` | **1.23:1** on surface | **1.48:1** on surface |
| `--border-strong` | `#CBD5E1` | `#94A3B8` | 1.48:1 on surface | **2.56:1** on surface |

The step ladder is now: surface `#FFFFFF` → subtle `#EEF2F7` → canvas
`#EAEFF5` → muted `#E2E8F0`, with borders promoted one notch so card and
table edges carry real separation.

### Text (ratios: on surface `#FFFFFF` / on canvas `#EAEFF5`)

| Token | Before | After | Ratio after (surface / canvas) | Requirement |
|---|---|---|---|---|
| `--text-primary` (body) | `#0F172A` | unchanged | **17.85:1 / 15.44:1** | ≥ 7:1 AAA — passes |
| `--text-secondary` | `#475569` | unchanged | **7.58:1 / 6.55:1** | ≥ 4.5:1 AA — passes (AAA on surface) |
| `--text-tertiary` | `#64748B` | `#546274` | **6.22:1 / 5.38:1** (also 5.68:1 on subtle) | ≥ 4.5:1 AA — passes. Old value was **4.12:1 on the new canvas** — would have failed |
| `--text-disabled` | `#94A3B8` | unchanged | 2.56:1 | exempt — audited below |

### Semantic `-text` shades (ratios: on surface / on canvas / on own tinted bg)

| Token | Before | After | Ratios after |
|---|---|---|---|
| `--success-text` | `#15803D` (5.02 / **4.34 fail** / 4.79) | `#166534` | **7.13 / 6.17 / 6.81** |
| `--warning-text` | `#B45309` (5.02 / **4.34 fail** / 4.84) | `#92400E` | **7.09 / 6.13 / 6.84** |
| `--danger-text` | `#B91C1C` (6.47 / 5.60 / 5.91) | `#991B1B` | **8.31 / 7.19 / 7.60** |
| `--info-text` | `#0369A1` (5.93 / 5.13 / 5.57) | `#075985` | **7.56 / 6.54 / 7.09** |
| `--primary-text` | `#1D4ED8` | unchanged | 6.70 / 5.80 / 6.16 (AA everywhere) |

("fail" above = would have dropped below 4.5:1 on the new darker canvas; each
was darkened one Tailwind stop so semantic text is AA+ on any surface it can
land on.)

### `#94A3B8` audit (was used as a label colour at ~2.56:1 on white)

All 26 remaining `fg-off` sites were reviewed. They are placeholders, disabled
control states, decorative icons (aria-hidden), empty-value em-dashes, and
out-of-month calendar days — all WCAG-exempt (inactive/decorative). One real
failure remained: **TaskList `AssigneeCell` rendered "Unassigned" (real
information) in `fg-off`** — changed to `fg-3` (`#546274`, 6.22:1).

### Dark theme

Unchanged, and re-verified by computation: `--text-tertiary` `#94A3B8` on
surface `#111827` = **6.92:1**; semantic text-on-tinted-bg pairs range
**8.94–11.90:1**. Verified visually in the browser after the light changes
(dashboard + tasks table screenshots).

---

## 2. Semantic-colour rules established

Colour marks the exception; the default is neutral. The rules, now encoded in
the `StatTile` JSDoc and applied on the Dashboard:

- **danger** — overdue counts, SLA breaches, "Late" status. (`My overdue`,
  office `Overdue`, `Awaiting reply` when past target.)
- **warning** — due-today counts and "due today" deadlines.
- **success** — completed/healthy counts. (`Completed`, "Completed" badges.)
- **primary** — counts awaiting the *user's* action. (`Unassigned mail`,
  `Awaiting approval`.)
- **A zero is never coloured.** Every tile passes `default` when its count is
  0, so a clean dashboard is an all-neutral dashboard and a coloured number
  always means "look here".
- **Only the value is coloured** — tile labels, hints and table prose stay
  neutral, so colour density stays low even on a bad day.
- **Never hue alone.** Badges always carry text (existing convention), and
  deadline colour always co-occurs with distinct text: "Overdue 3h" (danger)
  vs "in 2h" (warning, today) vs "in 4d" (neutral). Colour-blind users get the
  same information from the words.
- Deliberately **not** coloured: Reports' descriptive KPI strip keeps its
  identical-treatment design (only `Overdue` gets danger); `Open tasks` counts
  are workload, not problems — neutral; role badges keep the existing
  Employee=neutral / Head=info / Admin=warning convention.

## 3. Code changes

- `index.css` — token values above (light block only; dark block untouched).
- `components/ui/Card.jsx` — `StatTile` `tone` extended from
  `'default'|'danger'` to also accept `'warning'|'success'|'primary'`
  (value-text colour only; no layout change).
- `pages/Dashboard.jsx` — tile tones per the rules above (manager strip: due
  today→warning, unassigned mail/awaiting approval→primary; employee strip:
  due today→warning, completed→success).
- `pages/TaskList.jsx` — `DueCell` now has three states (overdue→danger,
  due-today→warning, future→neutral; completed always neutral);
  `AssigneeCell` "Unassigned" moved off the disabled colour.
- `EmailInbox.jsx`, `ClientList.jsx`, `admin/ManageUsers.jsx`,
  `admin/Reports.jsx` — reviewed; already fully token-driven with
  colourblind-safe badges, no changes needed. (The `#f8fafc` literals in
  EmailInbox are inside the generated Excel-export markup, not app UI.)

## 4. Verification

- `npx eslint . --max-warnings=0` — 0 errors.
- `npm run test -- --run` — 185/185 pass.
- `npx vite build` — passes.
- Browser (localhost:5174), light **and** dark: Dashboard (employee as
  emp@demo.test, admin as admin@demo.test), Tasks, Clients, Users, Reports,
  Inbox. Token values confirmed via computed styles
  (`--bg-canvas: 234 239 245` etc. live in the running app).

## 5. Not verified / known limitations

- **Head account view**: not signed in separately. Verified by code instead —
  `canManageMail = isAdmin || isHead` selects the identical tile array the
  admin sees.
- **Warning tone on a real tile**: both demo accounts had `Due today = 0`
  during verification, so the warning-toned value was never rendered with live
  data (the zero correctly stayed neutral). The code path is symmetrical to
  the verified danger/success paths.
- **Inbox rows with data**: the demo mailbox was empty, so row-level styling
  in the email table was reviewed in code and only the shell/empty states were
  seen in the browser.
- **Input borders at 2.56:1**: `--border-strong` (`#94A3B8`) is below the 3:1
  WCAG 1.4.11 non-text target if a border were a control's *only* identifier.
  Inputs here also have labels, placeholder text and a focus ring, and 2.56:1
  is a step up from the previous 1.48:1 — but a fully 1.4.11-clean pass would
  need ~`#8494A7` or darker, which starts to read heavy. Left as a documented
  trade-off.
- **Dark-mode surface separation** is still border-carried (`#111827` on
  `#0B1220` = 1.06:1). The owner's complaint was about light mode; dark was
  deliberately left as designed.
