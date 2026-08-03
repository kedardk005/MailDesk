# MailDesk / K M KOTHARI — Enterprise UI/UX Design Audit

**Scope:** `client/src/**` (10 pages, 7 components, 5 animation utils, `index.css`, `App.css`, `tailwind.config.js`)
**Stack:** React 19.2 · Vite 8 · react-router 7 · Tailwind 3.4 · plain JS (no TS) · **zero UI library, zero component primitives**
**Verdict:** The app is a marketing landing page's visual language stretched over an internal operations tool. Every screen is built from bespoke one-off markup — there is not a single reusable `Button`, `Input`, `Table`, `Badge`, or `Modal` component in the codebase. The "childish" perception is real and traceable to ~15 specific, removable decisions.

---

# A. INVENTORY — What Makes It Look Unprofessional

## A1. Custom cursor with trailing particle dots and magnetic buttons

`client/src/utils/cursorEffects.js` — 247 lines that replace the OS cursor.

- `client/src/index.css:11-19` — `body.custom-cursor-active { cursor: none !important; }` applied to `button, a, select, input, textarea, label`. **The native text I-beam and pointer are destroyed.**
- `cursorEffects.js:26-46` — creates **5 trailing dots** (`.cursor-trail`) that lag behind the pointer with `#8B5CF6` violet fill.
- `index.css:27-41` — `.custom-cursor-dot`: 8px `#6366F1` circle, `z-index: 9999`.
- `index.css:43-58` — `.custom-cursor-ring`: 36px ring, `#6366F1`, lerped at `0.12` (`cursorEffects.js:96-98`).
- `cursorEffects.js:85-91` — on mousedown the dot squishes: `scaleX(1.6) scaleY(0.4)`. On hover it inflates `scale(3)`.
- `cursorEffects.js:159-196` — **magnetic pull**: every `button, a` within 60px of the cursor is physically translated up to 8px toward it via inline `style.transform`. Buttons run away from the pointer.
- `cursorEffects.js:198-229` + `index.css:88-107` — Material-style **ripple** injected into every button click, `rgba(255,255,255,0.45)`, `scale(4)`.

This is a portfolio-site effect. In an app staff use for 8 hours it causes measurable mis-clicks and is a WCAG 2.1 SC 2.4.7 / pointer-target problem.

**`client/src/utils/moduleCursor.js`** is the same idea for the app shell — a **320px radial violet spotlight** (`moduleCursor.js:31-45`, `rgba(99,102,241,0.08)`) chasing the cursor at `z-index 9999`, growing/shrinking on hover (`:82-95`). Its own docstring calls it *"highly professional, distraction-free"* (`moduleCursor.js:1-6`). It is neither. **Note: it is currently dead code — nothing imports it.** `initCursorEffects` IS live, imported and run on `Landing.jsx:5,32`.

## A2. 3D tilt + glare on cards

`client/src/utils/tiltEffect.js` (113 lines).

- `tiltEffect.js:53` — `perspective(800px) rotateX(±6deg) rotateY(±6deg)` follows the mouse.
- `tiltEffect.js:17,49` — injects a `.tilt-glare` overlay: `radial-gradient(... rgba(255,255,255,0.2) ...)` that tracks the cursor position across the card.
- `tiltEffect.js:16` — falls back to a `24px` border radius for the glare.
- **Live on the Dashboard KPI cards**: `Dashboard.jsx:4,37-42` runs `initTilt(card, 5, 800)` over every `.tilt-stat-card`.
- **Live on the Landing hero mockup and all 6 feature cards**: `Landing.jsx:58,62-64`.

Enterprise dashboards do not tilt. This alone reads as a student project.

## A3. Animated morphing blobs

`index.css:135-148` — `@keyframes blob` morphs `border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%` → `30% 60% 70% 40%...` while translating and scaling, on a **25s infinite loop** (`index.css:190-192`).

- `Landing.jsx:141-143` — three blobs, 400/450/500px, `bg-indigo-500/10`, `bg-purple-500/10`, `bg-pink-500/10`, `blur-[100px]`/`blur-[120px]`, staggered `animationDelay: '5s' / '10s'`.
- `Login.jsx:40-42` and `Register.jsx:54-56` — **the login screen has animated pulsing blobs**: `h-72 w-72 bg-white/10 blur-2xl animate-pulse`, `h-96 w-96 bg-white/5 blur-3xl animate-pulse delay-1000`. This is the first screen every employee sees each morning.

## A4. Floating / bouncing / pulsing elements

| Effect | Evidence |
|---|---|
| Hero mockup **floats up and down forever** | `Landing.jsx:204` `animate-float` → `index.css:130-133,186-188` `translateY(-12px)` 4s infinite |
| Notification bell **bounces** | `NotificationBell.jsx:11,60-66,152` — `setBounce(true)` for 600ms → `animate-bounce` |
| Unread badge **pulses forever** | `NotificationBell.jsx:159` `animate-pulse` on the red count chip |
| "Secure Session" dot pulses | `Dashboard.jsx:212` `h-2 w-2 bg-emerald-500 rounded-full animate-pulse` |
| Gmail-connected dot pulses | `Dashboard.jsx:393`, `Profile.jsx:366`, `EmailInbox.jsx:1009,1040` |
| **Pending user status badge pulses** | `ManageUsers.jsx:397` `animate-pulse` on a table cell badge — a whole table column throbs |
| **The "Download Emails" button pulses until clicked** | `EmailInbox.jsx:700` `animate-pulse` — a primary toolbar control blinks at the user |
| Bulk-selection dot pulses | `EmailInbox.jsx:1119` |
| 16 `animate-pulse` + 1 `animate-bounce` + 1 `animate-float` + 3 `animate-blob` total | grep across `src/**/*.jsx` |

## A5. Count-up number animations on operational data

`client/src/utils/countUp.jsx` — animates numbers from 0 to target over **1.5s** with `outQuad` easing (`countUp.jsx:41-58`), rendered `font-black` (`countUp.jsx:66`).

- **`Dashboard.jsx:240,254,268,282,298,312,326,340,354,368`** — every single KPI (Assigned Tasks, Pending, Completed, Overdue, Users, Emails…) spins up like a slot machine on each page load.
- `Landing.jsx:310,319,328,337`.

For an ops tool this is actively harmful: the number is *wrong* for 1.5 seconds every time the page loads, and staff will read a mid-animation value.

## A6. Emoji used as UI iconography — complete list

| File:line | Emoji | Used as |
|---|---|---|
| `Dashboard.jsx:235` | 📋 | "My Tasks" KPI icon |
| `Dashboard.jsx:249` | ⏳ | "Pending" KPI icon |
| `Dashboard.jsx:263` | ✓ | "Completed" KPI icon |
| `Dashboard.jsx:277` | ⚠️ | "Late" KPI icon |
| `Dashboard.jsx:293` | 👥 | "Total Users" KPI icon |
| `Dashboard.jsx:307` | ✉️ | "Total Emails" KPI icon |
| `Dashboard.jsx:321` | 📋 | "Total Tasks" KPI icon |
| `Dashboard.jsx:335` | ⏳ | "Pending" KPI icon |
| `Dashboard.jsx:349` | ✓ | "Completed" KPI icon |
| `Dashboard.jsx:363` | ⚠️ | "Late" KPI icon |
| `EmailInbox.jsx:811` | 🔍 | **Search field icon** (inline-styled, absolutely positioned) |
| `EmailInbox.jsx:832` | × | Clear-search button glyph |
| `EmailInbox.jsx:1193` | ✉️ | **Avatar fallback** when sender name is empty |
| `EmailInbox.jsx:1306` | ✨ | "AI Summary" section header |
| `EmailInbox.jsx:1357` | 📎 | "Attachments" section header |
| `EmailInbox.jsx:1422` | ↩ | **Reply button icon** |
| `TaskList.jsx:1055` | ✉️ | "Linked Email" indicator |
| `TaskList.jsx:1081` | 🔁 | Recurrence badge icon |
| `TaskList.jsx:1148` | 🔗 | "Linked Email Payload" header |
| `TaskList.jsx:1226` | × | Delete-comment button |
| `TaskList.jsx:1734` | 🔗 | "Linked Email Payload" header (modal) |
| `Profile.jsx:387` | 🔒 | "Workspace Restricted" state |
| `Landing.jsx:150` | ✦ | Hero badge |
| `Landing.jsx:370,389,408,427,446,465` | 📧 ✅ 🔔 🛡️ ⏱️ 📊 | All 6 feature-card icons, rendered at `text-2xl` in a `h-14 w-14 rounded-2xl` tile |
| `Landing.jsx:177,378,397,416,435,454,473` | → | CTA arrows |
| `Landing.jsx:239,244,254` | ↑ ↑ ↓ | Fake trend indicators |

**26 distinct emoji instances.** Emoji render differently on Windows/macOS/Android, cannot inherit `currentColor`, cannot be sized on the icon grid, and are the single strongest "childish" signal. Meanwhile the codebase already hand-inlines ~80 Heroicons SVG paths — so it's inconsistent *and* emoji.

## A7. Gradient text, gradient buttons, gradient chrome

**37 `bg-gradient-*` usages.** The gradient is applied to functional controls, not decoration:

- `from-indigo-600 to-purple-600` × **29** — the primary button style everywhere: `Login.jsx:128`, `Register.jsx:163`, `TaskList.jsx:728,752,1525,1802`, `EmailInbox.jsx:713,976,1162,1443`, `Profile.jsx:292,348,411`, `Navbar.jsx:65`, `Sidebar.jsx:144,160`, `ClientList.jsx:338`, `Reports.jsx:281`.
- `Landing.jsx:161` — **gradient clipped text**: `bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500 bg-clip-text text-transparent` on an `text-8xl font-black` headline.
- `Navbar.jsx:83` — the user avatar is wrapped in a **three-stop indigo→purple→pink gradient ring**: `p-[2px] bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 rounded-full` (Instagram-story styling on an internal tool).
- `Sidebar.jsx:160` — the user block is a **gradient card**: `bg-gradient-to-br from-indigo-600 to-purple-600 rounded-2xl text-white`.
- `KeywordApprovalModal.jsx:181` — the modal header is `bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700`.
- `Landing.jsx:533` — the CTA banner is a full-bleed 3-stop gradient.

Enterprise convention: a single flat brand color for primary actions. Gradients are reserved for data-viz fills, if at all.

## A8. Glow / neon shadows

Every large shadow in the codebase is **colored indigo**, not neutral:

| Value | Where |
|---|---|
| `shadow-[0_0_40px_rgba(99,102,241,0.4)]` → hover `0_0_50px..0.5` | `Landing.jsx:175` — literal neon glow on the CTA |
| `shadow-[0_40px_100px_rgba(99,102,241,0.22)]` | `Landing.jsx:204` — hero mockup |
| `shadow-[0_20px_60px_rgba(99,102,241,0.12)]` × 6 | `Landing.jsx:366,385,404,423,442,461` — feature cards |
| `shadow-[0_20px_40px_rgba(99,102,241,0.08)]` × 10 | `Dashboard.jsx:233,247,261,275,291,305,319,333,347,361` — **every KPI card** |
| `shadow-[0_25px_80px_rgba(99,102,241,0.2)]` | `TaskList.jsx:1341,1545` — Create/Edit Task modals; also `index.css:121` `.glassmorphism` |
| `shadow-[0_4px_15px_rgba(99,102,241,0.3)]` → `0_6px_20px..0.4` | `Login.jsx:128`, `Register.jsx:163` — the Sign In button glows |
| `shadow-[0_4px_20px_rgba(99,102,241,0.05)]` | `Navbar.jsx:47` — top bar glows on scroll |
| `shadow-md shadow-indigo-600/10` etc. | ~20 more instances |
| `shadow-2xl` × 19 | every toast/alert: `Dashboard.jsx:161`, `TaskList.jsx:659`, `Reports.jsx:260`, `Profile.jsx:189`, `ActivityLog.jsx:102`, `EmailInbox.jsx:659` |

**Total: 85 `shadow-sm` + 50 `shadow-md` + 19 `shadow-2xl` + 7 `shadow-xl` + 6 `shadow-lg` + 16 arbitrary colored shadows.** No scale, no rationale.

## A9. Glassmorphism / backdrop-blur

- `index.css:116-122` — `.glassmorphism`: `rgba(255,255,255,0.9)` + `backdrop-filter: blur(20px)` + indigo border + indigo 80px shadow.
- `Navbar.jsx:46` — `bg-white/95 backdrop-blur-xl`.
- `NotificationBell.jsx:167` — dropdown is `bg-white/95 backdrop-blur-xl ... rounded-2xl shadow-xl`.
- `TaskList.jsx:1340-1341,1544-1545` — modals: `backdrop-blur-md` scrim + `bg-white/95 backdrop-blur-2xl` panel.
- `Sidebar.jsx:130` — mobile scrim `backdrop-blur-sm`.
- `Sidebar.jsx:161` — avatar tile `bg-white/10 backdrop-blur-md border border-white/25`.
- `Reports.jsx:444` — chart tooltip `bg-slate-900/90 backdrop-blur-md`.

`backdrop-filter` on scroll containers is also a real GPU cost on the 4-year-old office hardware this will run on.

## A10. Oversized border radii

| Radius | Count | Notable |
|---|---|---|
| `rounded-[2.5rem]` (**40px**) | 8 | `Landing.jsx:366,385,404,423,442,461` feature cards; `Landing.jsx:481` section; `Landing.jsx:533` CTA |
| `rounded-3xl` (**24px**) | 20 | `Login.jsx:60` / `Register.jsx:74` login card; `Profile.jsx:206,227,301,358` every settings card; `Reports.jsx:336,467,541,688` every analytics panel; `TaskList.jsx:1341,1545` modals; `EmailInbox.jsx:963,1084` |
| `rounded-2xl` (**16px**) | 91 | every stat card, alert, table wrapper |
| `rounded-xl` (**12px**) | **208** | **every input, every button, every badge** |
| `rounded-full` | 93 | status badges rendered as pills |
| `rounded-lg` | 52 | |
| `rounded-md` | 11 | |

Enterprise UIs sit at **4–8px**. `rounded-xl` on a 36px-tall input makes it read as a chat bubble. `rounded-[2.5rem]` is consumer-app territory.

## A11. Typography — no scale, extreme weights, marketing font

**Font family** — `index.css:22`:
```css
body { font-family: 'Outfit', 'Inter', sans-serif; }
```
**Outfit is a geometric display font** designed for marketing headlines — wide, rounded, low x-height, poor at 11–13px, no true tabular figures. It is the *primary* face for the entire application.

- `index.css:1` `@import url('...family=Inter:wght@300..900&family=Outfit:wght@300..900')` — a **render-blocking `@import` inside CSS** loading **14 font weights** across two families.
- `index.html:9` separately `<link>`s Inter with 6 weights — so Inter is fetched twice and Outfit is fetched render-blocking.

**Weight distribution (grep across `*.jsx`):**
```
font-bold        274
font-semibold    143
font-extrabold    49
font-black        47
font-medium       27
font-mono         26
font-normal        2
```
**513 of 542 weight declarations are ≥600.** There are **two** `font-normal` in the entire app. When everything is bold, nothing has hierarchy — this is the single biggest reason the UI reads as loud/childish. `font-black` (900) is used on `Login.jsx:68` "Welcome back", `Profile.jsx:211` the user's name, `ClientList.jsx:195` the page title, and every `CountUp` number.

**Size distribution:**
```
text-xs (12px)   320      text-[10px]      121      text-[9px]        24
text-sm (14px)   122      text-[11px]       17      text-lg            23
text-3xl          21      text-2xl          19      text-xl            17
text-4xl          10      text-base         10      text-5xl            7
text-md (INVALID — not a Tailwind class)     5      text-8xl/7xl        2
```
There is **no type scale**. `text-[9px]`, `text-[10px]`, `text-[11px]` are arbitrary escapes used 162 times. `text-md` (`EmailInbox.jsx:1090`, `TaskList.jsx:1014`, `ActivityLog.jsx:188`, `ManageUsers.jsx:366,518`) **is not a Tailwind class and emits nothing** — those headings silently fall back to inherited size.

**`font-mono` used as a decorative treatment**, not for data: role badges (`Navbar.jsx:90`, `Sidebar.jsx:166`, `Dashboard.jsx:179,207,236,250,264,278,294,308,322,336,350,364`), timestamps (`NotificationBell.jsx:201`). Monospace on a role name is cosplay; monospace on *numbers in a table* — where it actually matters — is absent.

## A12. Color palette — extracted, in full

### Tailwind classes actually in use
**Brand/primary:** `indigo-50` `indigo-100` `indigo-500` `indigo-600` `indigo-700` `purple-50` `purple-100` `purple-500` `purple-600` `purple-700` `pink-500`
**Neutral:** `slate-50 100 200 300 400 500 600 700 800 900` + `white` + `black/40`
**Semantic:** `emerald-50/100/500/600/700`, `amber-50/100/500/600/800/900`, `red-50/100/200/500/600/700`, `rose-50/200/500/700`, `blue-50/100/600/700`

### Raw hex in JSX/CSS
| Hex | Count | Role |
|---|---|---|
| `#6366F1` indigo-500 | cursor dot, ring, dot-grid, link underline, chart gradient (`index.css:34,50,111,120,121,286`, `moduleCursor.js:38,84,95`, `Reports.jsx:406,407`) |
| `#8B5CF6` violet-500 | cursor trail + hover state (`index.css:68,79,84`, `cursorEffects.js:36`) |
| `#4f46e5` indigo-600 | 7× — reply button, comment Post button, chart stroke, email links (`TaskList.jsx:1255`, `EmailInbox.jsx:1405,414,419,422`, `Reports.jsx:428,433`, `index.css:313`) |
| `#94a3b8` slate-400 | 14× |
| `#e2e8f0` slate-200 | 9× |
| `#334155` slate-700 | 7× |
| `#a855f7` / `#9333ea` purple | 4× — task-timeline chart |
| `#2563eb` blue-600 | 2× — bell icon stroke, hardcoded (`NotificationBell.jsx:155,156`) |
| `#10B981` emerald-500 | `index.css:208` pulse-ring |
| `#166534 #bbf7d0 #f0fdf4` | priority "Low" (`TaskList.jsx:7`) |
| `#854d0e #fde68a #fefce8` | priority "Medium" (`TaskList.jsx:8`) |
| `#9a3412 #fed7aa #fff7ed` | priority "High" (`TaskList.jsx:9`) |
| `#991b1b #fecaca #fef2f2` | priority "Urgent" (`TaskList.jsx:10`) |
| `#c7d2fe #eef2ff #e0e7ff #4338ca` | AI-summary panel (`EmailInbox.jsx:1313,1314`) |
| `#dc2626 #64748b #cbd5e1 #f8fafc #f1f5f9 #475569 #1e293b #0f172a #ffffff #3730a3 #dcfce7` | scattered |

**Saturation judgement:** the accent axis is **indigo-500 → violet-500 → pink-500** — a saturated, high-chroma consumer palette. `#6366F1` at `rgba(...,0.4)` glow, `#8B5CF6` trailing dots and `#EC4899` pink in the avatar ring are the colors of a crypto landing page, not a chartered-accountant back office. **There is no info/blue semantic token** — `blue-600` appears exactly once, hardcoded on the notification bell, clashing with the indigo everything else.

### Contrast failures (WCAG AA, 4.5:1 for body text)
- `text-slate-400` (`#94A3B8`) on white = **2.85:1 — FAIL.** Used ~90× including all `text-[10px]` field labels: `Login.jsx:87,103`, `Register.jsx:110,126,142`, `Profile.jsx:233,244,256,266,278,307,320,332`, `Dashboard.jsx:198,202,206,210`.
- `text-slate-400` at **9px/10px** compounds it — 10px + 2.85:1 is unreadable for anyone over 40.
- `text-slate-350`, `text-slate-405`, `text-slate-450`, `text-slate-455` — **these shades don't exist** (see A14), so those elements inherit whatever color is ambient.

## A13. Landing-page patterns leaking into the app shell

`Landing.jsx` (566 lines) is a full SaaS marketing site — and it is the **root route `/`** (`App.jsx:32`) of an internal tool:
- Fake social proof: `Landing.jsx:189-196` — five hardcoded fake avatars (`JD AS MK TL RH`) and **"Trusted by 500+ teams worldwide"**.
- Fake metrics: `Landing.jsx:14-21` — hardcoded `totalEmails: 1248, totalTasks: 340, totalCompleted: 892`.
- Fake trend arrows: `Landing.jsx:239,244,249,254` — "↑ 12% this week", "↓ 3 from yesterday", "94% completion rate", all invented.
- `Landing.jsx:177` "Start for Free →", `:183` "See a Demo", `:547` "Create Your Account" — **there is no free tier and no demo.**
- `Landing.jsx:100` — `setInterval(handleScrollReveal, 100)` — a **10Hz polling loop** re-querying the DOM forever, alongside an IntersectionObserver doing the same job (`:72-89`).

The same DNA is inside the app:
- `Navbar.jsx:7-15,46-48` — the app top bar listens to `window.scroll` and grows an indigo shadow past 10px. That's a marketing-header behavior in a fixed app chrome.
- `index.css:9` — `html { scroll-behavior: smooth; }` globally, so every anchor/programmatic jump in the app animates.
- `index.css:212-256` — `.reveal-element`, `.stagger-reveal` with `0.8s` cubic-bezier entrance and nth-child delays up to `0.6s`, wired globally in `App.jsx:22` via `initScrollAnimations()` — which also attaches a **`MutationObserver` on `document.body` with `subtree: true`** (`scrollAnimations.js:45-52`) that re-runs `querySelectorAll` on *every DOM mutation in the app*. This is a permanent performance tax for a decorative effect.

## A14. Broken/no-op classes — the "cheap" look is partly literal breakage

**131 uses of Tailwind color shades that do not exist.** `tailwind.config.js:6-16` defines only three custom shades (`slate-450`, `indigo-650`, `emerald-55`). Everything below emits **no CSS at all**:

```
indigo-150  41×      indigo-650  31× (defined)   slate-805  18×
indigo-550  11×      slate-450    9× (defined)   indigo-505  8×
slate-850    4×      slate-55     4×             slate-150   4×
red-650      4×      slate-750    3×             slate-550   3×
slate-455    3×      slate-755    2×             slate-655   2×
slate-405    2×      slate-250    2×             red-550     2×
purple-650   2×      emerald-55   2× (defined)   emerald-250 2×
slate-855 slate-650 slate-605 slate-350 slate-105 red-655 red-150
emerald-650 emerald-150 amber-950 amber-250 amber-150   1× each
```

Concretely: **`focus:ring-indigo-150` appears 41 times** — meaning *every form field in the Create Task modal, Edit Task modal, Profile, and Activity Log filters has no visible focus ring at all.* Combined with `focus:outline-none` (60 occurrences across 11 files) and **zero `focus-visible` usage**, the app is unkeyboard-navigable.

**Undefined utility classes referenced in JSX but never defined in `index.css` or the Tailwind config:**

| Class | Uses | Intended |
|---|---|---|
| `animate-fade-in` | 27 | page/panel entrance — **does nothing** |
| `animate-slide-in` | 7 | toast entrance — **toasts appear with a hard cut** |
| `animate-shake` | 3 | error shake (`Login.jsx:77`, `Register.jsx:91`) — **does nothing** |
| `skeleton-shimmer` | ~10 | loading skeletons (`Dashboard.jsx:227`, `EmailInbox.jsx:1080`, `TaskList.jsx:808`, `Reports.jsx:298,398,483,695`, `ManageUsers.jsx:356`, `ActivityLog.jsx:178`, `Profile.jsx:179-180`) — **all "skeletons" are plain blank white boxes; no shimmer, no pulse** |
| `hover-glow-card` | ~8 | card hover (`ActivityLog.jsx:174`, `ManageUsers.jsx:352,510`, `EmailInbox.jsx:999,1025,1198`, `TaskList.jsx:1032`) — does nothing |
| `custom-scrollbar` | 2 | `TaskList.jsx:903,962` — does nothing |
| `shadow-2xs` / `shadow-xs` | 3 | not in Tailwind 3 (`Reports.jsx:655`, `KeywordApprovalModal.jsx:210,228`) |
| `z-45` | 1 | `Sidebar.jsx:136` — **invalid; the sidebar has no stacking context** |
| `text-md` | 5 | invalid |
| `active:scale-98` | 2 | invalid (`TaskList.jsx:1525,1802`); `active:scale-[0.98]` is used elsewhere — inconsistent |
| `border-emerald-250` etc. | — | invalid |

**`client/src/App.css` (184 lines) is dead code** — never imported by `main.jsx` or any JSX. It is the untouched Vite React template (`.hero`, `#next-steps`, `#docs`, `.ticks`) referencing undefined vars `--accent`, `--border`, `--social-bg`.

**Dark mode leak:** `tailwind.config.js` has no `darkMode` key → Tailwind 3 defaults to `'media'`. `KeywordApprovalModal.jsx` is the **only** file using `dark:` (32 occurrences, lines 178–471). On any machine with OS dark mode enabled, that one modal renders dark-on-dark while the entire rest of the app stays white. There is no theme toggle and no dark support anywhere else.

## A15. Inline `style={{}}` mixed with Tailwind, in the same component

**57 inline style objects** — `TaskList.jsx` 26, `EmailInbox.jsx` 24, `Landing.jsx` 4, `Reports.jsx` 3. Not one-offs; whole subsystems are styled this way:

- `EmailInbox.jsx:806-835` — the **entire search bar** is inline-styled with hardcoded `#e2e8f0`, `#f8fafc`, `#94a3b8`, `borderRadius: '8px'`, `padding: '9px 12px 9px 36px'` — a *different* radius (8px) and *different* padding rhythm from every Tailwind control on the same screen (`rounded-xl` = 12px, `px-5 py-3`).
- `EmailInbox.jsx:1303-1334` — the AI Summary panel.
- `EmailInbox.jsx:1378-1425` — the entire Reply composer (button `background: '#4f46e5'`, `borderRadius: '6px'`).
- `TaskList.jsx:5-13` — `getPriorityStyle()` returns raw hex objects.
- `TaskList.jsx:1198-1262` — the whole comment thread.
- `TaskList.jsx:715` — the Priority filter `<select>` inline-styled `borderRadius: '6px'` next to a sibling `<select>` at `rounded-xl`.

**Result:** on the Inbox screen alone there are **four different border radii** on controls that sit side by side — 6px, 8px, 12px, 16px.

## A16. Everything is `select-none` — you cannot copy your own data

`select-none` on the root `<main>` of: `EmailInbox.jsx:656`, `TaskList.jsx:656`, `Dashboard.jsx:158`, `Profile.jsx:178,186`, `Reports.jsx:256`, `ManageUsers.jsx:284`, `ActivityLog.jsx:89`, `Login.jsx:36`, `Register.jsx:50`, `ForgotPassword.jsx`. **31 occurrences.**

In an email→task tool, staff copy sender addresses, invoice numbers, GSTINs, client names constantly. This blocks all of it. `select-text` has to be re-added as a patch in 4 places (`TaskList.jsx:1109,1116`, `EmailInbox.jsx:1349`) — proof the blanket rule is wrong.

---

# B. INFORMATION DENSITY & WORKFLOW ASSESSMENT

## B1. The inbox is airy cards, not a scannable list — ~3× density loss

`EmailInbox.jsx:1190-1461`:
```jsx
<div className="space-y-3.5">          // 14px gap between rows
  <div className="bg-white border border-slate-200 rounded-2xl shadow-sm ...">
    <div className="p-5 flex items-center ...">   // 20px padding
      <div className="h-9 w-9 rounded-full ...">  // 36px avatar
```
**Row pitch ≈ 20 + 36 + 20 + 14 = 90px.** On a 1080p screen the content area is ~940px tall → **~10 emails visible.** A correctly built enterprise row (36–40px) shows **24–26**. Staff triaging 300 emails/day scroll ~2.5× more than necessary, all day.

Compounding it:
- Each row is a **separate bordered, shadowed, 16px-radius card**, so there is no continuous vertical rhythm and no shared column grid — sender, subject, date, and status don't align between rows.
- `EmailInbox.jsx:1224` — sender is `truncate max-w-[180px] sm:max-w-[260px]`; `:1242` subject is `truncate max-w-[240px] sm:max-w-[480px]`. **Hardcoded pixel widths instead of a table grid** — on a 2560px monitor the subject still truncates at 480px while 1500px of whitespace sits to the right.
- `EmailInbox.jsx:1253-1259` — the status pill shows the **raw database value**: `{email.status}` renders lowercase `"unassigned"` / `"assigned"`.
- `EmailInbox.jsx:1294` — clicking a row expands an **inline accordion** containing a 300px `<iframe>` (`:1340-1346`), the AI panel, attachments, and a reply composer. Reading one email destroys the scroll position of the list. There is no reading pane.

## B2. Tables: real `<table>` exists but has none of the table affordances

Real `<table>` elements: `ManageUsers.jsx:371` (users), `ManageUsers.jsx:523` (clients), `ActivityLog.jsx:193`, `Reports.jsx:594`, `ClientList.jsx:321`. Card-lists instead of tables: **EmailInbox** and **TaskList** — the two highest-volume screens.

| Affordance | Status | Evidence |
|---|---|---|
| Sortable headers | **Absent** — grep for `onClick` on `<th>`, `sortBy`, `sortDirection` returns **zero** | — |
| Sticky headers | **Absent** — grep for `sticky` returns **zero across the whole `src/`** | `ManageUsers.jsx:372` `<thead className="bg-slate-50/50 ...">` |
| Zebra striping | Absent (only in the *exported Excel*, `EmailInbox.jsx:424`) | |
| Row hover | Present | `ManageUsers.jsx:403`, `ActivityLog.jsx:224` |
| Column alignment | **Broken** — numeric columns are `text-center`, not right-aligned; `Reports.jsx:598-602,621-624` centers Assigned/Completed/Pending/Late |
| Tabular figures | **Absent everywhere** except `countUp.jsx:66` (which uses it on an animated number) — numbers in tables jitter column-to-column |
| Resizable columns | Absent |
| Column visibility / density toggle | Absent |
| Row selection in tables | Absent (only in the Inbox card list) |
| Pagination | **Only in EmailInbox** (`:1464-1510`). `ManageUsers`, `ActivityLog`, `ClientList`, `Reports`, `TaskList` render **every row unbounded** — the Activity Log will render tens of thousands of `<tr>` and lock the browser |
| Virtualization | Absent |
| Row height | `px-6 py-4` = **~57px** (`ManageUsers.jsx:404`, `ActivityLog.jsx:225`) — should be 36–40px |
| Table container | `rounded-2xl` + `shadow-sm` + `hover-glow-card` (`ManageUsers.jsx:352`) — a table wrapped in a 16px-radius floating card |

## B3. Bulk actions, keyboard, command palette, saved views

- **Multi-select:** exists in exactly one place — `EmailInbox.jsx:1177-1188` (Select All) + `:1209-1215` (per-row checkbox), driving a bulk-assign bar (`:1116-1175`). The checkboxes are **raw unstyled `<input type="checkbox">` with inline `style={{width:'15px',height:'15px'}}`** — no indeterminate state, no label association, no shift-click range select. "Select All" only selects the **current page** (`:259`) but the label doesn't say so.
- **TaskList has selection state referenced but never defined:** `TaskList.jsx:692,712,747` call `setSelectedTaskIds(new Set())` and `setSelectAll(false)`. **Neither `selectedTaskIds`/`setSelectedTaskIds` nor `selectAll`/`setSelectAll` is declared anywhere in the file.** Changing the Creator, Priority, or Status filter throws `ReferenceError: setSelectedTaskIds is not defined` and blanks the page. This is a live crash, not just a design issue.
- **Keyboard shortcuts:** **one** in the entire application — `TaskList.jsx:1241`, Enter-to-post a comment. No `j/k` navigation, no `e` to archive, no `/` to search, no `Esc` to close modals (`TaskList.jsx:1339`, `KeywordApprovalModal.jsx:177` have no key handler and no focus trap).
- **Command palette:** none.
- **Saved views / saved filters:** none. Filters are component-local `useState` (`EmailInbox.jsx:37-38,45`, `TaskList.jsx:44-46`) — **not in the URL**, so a filtered view can't be bookmarked, shared, or survive a refresh.
- **Density toggle:** none.

## B4. App shell — it is a scrolling marketing page, not an app shell

`ProtectedLayout.jsx:62-79`:
```jsx
<div className="min-h-screen bg-slate-50 text-slate-800 font-sans">
  <Navbar />                              // fixed h-16
  <div className="relative pt-16 lg:pl-60">
    <Sidebar />                           // fixed w-[260px]
    <div className="min-w-0"><Outlet /></div>
  </div>
</div>
```
Problems:
1. **The document body scrolls, not a content pane.** There is no `h-screen overflow-hidden` shell. Consequence: the fixed Navbar's scroll-shadow listener (`Navbar.jsx:9-15`), the global `scroll-behavior: smooth` (`index.css:9`), and `initScrollAnimations`'s body MutationObserver all key off page scroll.
2. **The sidebar and the content offset don't match.** Sidebar is `w-[260px]` (`Sidebar.jsx:136`); content is offset `lg:pl-60` = **240px** (`ProtectedLayout.jsx:68`). **20px of content sits underneath the sidebar** at every viewport ≥1024px.
3. **Every page re-declares its own container**, so nothing lines up between screens: `max-w-7xl px-4 sm:px-6 lg:px-8 py-8` (Dashboard, Inbox, Tasks, Reports, Users, Activity), `max-w-4xl px-4 sm:px-6 lg:px-8 py-8` (Profile), and `p-6 max-w-7xl` (ClientList — different padding, no responsive steps).
4. **`max-w-7xl` (1280px) caps the data area.** On a 2560px monitor a 300-row table renders in the middle 1280px with 640px of grey on each side. Data screens should be fluid.
5. **The app polls `/auth/me` every 8 seconds forever** (`ProtectedLayout.jsx:58`) and the Inbox reloads every 5 minutes (`EmailInbox.jsx:199-203`), both without any visible sync indicator.

## B5. Empty / loading / error states

| State | Assessment |
|---|---|
| **Empty** | Present and reasonable in shape — `EmailInbox.jsx:1084-1108`, `TaskList.jsx:1008-1018`, `ManageUsers.jsx:360-368,512-520`, `ActivityLog.jsx:182-190`, `ClientList.jsx:307-316`. But all use `py-20` + `rounded-3xl` + a `w-14 h-14 rounded-2xl` icon tile, and most lack a primary CTA. `TaskList.jsx:1015` says "create a new record" but shows no button. |
| **Loading** | "Skeletons" exist structurally but `skeleton-shimmer` **is undefined** → they're blank white rectangles (`Dashboard.jsx:227`, `EmailInbox.jsx:1080`, `TaskList.jsx:808`, `Reports.jsx:298`, `ManageUsers.jsx:356`, `ActivityLog.jsx:178`, `Profile.jsx:179`). `ClientList.jsx:290-295` uses a completely different pattern — a spinning ring + "Loading clients data...". Three different loading languages. |
| **Error** | No error state on any page except `ClientList.jsx:298-302`. Every other failure becomes a 4.5s toast that disappears — `Dashboard.jsx:70`, `EmailInbox.jsx:362`, `TaskList.jsx:203`, `Reports.jsx:79`. **A failed data load leaves an empty page with no retry.** |
| **Confirmation dialogs** | **`window.confirm()` — 8 times**: `TaskList.jsx:350` (delete task), `EmailInbox.jsx:318,550,571` (disconnect account, clear ALL emails, delete email), `Dashboard.jsx:121` (disconnect Gmail), `Profile.jsx:88`, `ManageUsers.jsx:236` (delete client), `KeywordApprovalModal.jsx:108,152`. Destructive, irreversible operations gated by a native OS dialog. |
| **`alert()`** | **3 times**: `ClientList.jsx:172` (delete failure — the *only* feedback), `TaskList.jsx:639,650`. |
| **Toasts** | Not a system — the same 18-line JSX block is **copy-pasted into 7 files**: `Dashboard.jsx:160-175`, `TaskList.jsx:658-673`, `Reports.jsx:258-275`, `Profile.jsx:188-203`, `ActivityLog.jsx:101-116`, `EmailInbox.jsx:658-673`, `ManageUsers.jsx:313-328`. Single toast only (a second overwrites the first), fixed `top-20 right-4`, `animate-slide-in` (undefined → no animation), 4000/4500ms inconsistently, no dismiss button, no `role="status"`/`aria-live`, `shadow-2xl`. |
| **Modals** | No `<dialog>`, no portal, no focus trap, no Esc, no scroll lock, no `aria-modal`. `TaskList.jsx:1339`, `KeywordApprovalModal.jsx:177`, `ManageUsers` add/edit/delete. `ManageUsers` renders a **custom delete-confirm modal for users** but uses `window.confirm` for clients (`:236`) — inconsistent within one file. |

## B6. Status & priority representation

- **Priority** — `TaskList.jsx:5-13`, rendered `TaskList.jsx:1084-1089`: colored pill, `borderRadius: '20px'`, text label present. **Text + color, colorblind-safe.** This is the best thing in the app. But it's inline-styled raw hex, and Medium (`#fefce8`/`#854d0e` amber) vs High (`#fff7ed`/`#9a3412` orange) are nearly indistinguishable.
- **Status** — `TaskList.jsx:1066-1074` pill (text + color, OK) **plus a redundant left border stripe** (`getStatusBorder`, `:587-594`) **plus a separate deadline pill** (`:568-585`) — three encodings of overlapping information, all `rounded-full`, competing for the same row.
- **Email status** — `EmailInbox.jsx:1253-1259` renders the raw lowercase DB value, plus a left border stripe (`:1199`).
- **Bare colored dots with no label** — `Dashboard.jsx:212` (green pulse = "Secure Session"), `Landing.jsx:226`, `EmailInbox.jsx:1009,1040`, `Profile.jsx:366`. Color-only encoding, **fails WCAG 1.4.1 (Use of Color)**.
- **Role badges** are colored by role with no icon — `ManageUsers.jsx:387-392` / `ActivityLog.jsx:208-213`: Admin=red, Head=purple, Employee=indigo. **Red for "Admin" is a semantic error** — red means danger/error everywhere else in the same table (`ManageUsers.jsx:399` Rejected = red). Two meanings, one color, same screen.
- No badge component: the ~10-line `inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${cls}` string is duplicated ~40 times.

## B7. Form design

| Criterion | Finding |
|---|---|
| Label placement | Top-aligned — correct. But styled as `text-[10px] font-bold text-slate-400 uppercase tracking-wider` (`Login.jsx:87`, `Profile.jsx:233`, `Register.jsx:110`) — **10px, 2.85:1 contrast, all-caps**. Labels are the least readable text on the form. |
| `htmlFor`/`id` | Present in `Login.jsx`/`Register.jsx` only. **Absent in `Profile.jsx` (7 fields), `TaskList.jsx` create+edit modals (~16 fields), `ManageUsers.jsx`, `ClientList.jsx`, `KeywordApprovalModal.jsx`.** Clicking a label doesn't focus its input; screen readers get nothing. |
| Required markers | Inconsistent: `TaskList.jsx:1356,1380,1419,1453` use `<span className="text-red-500">*</span>`; `Profile.jsx`, `ManageUsers.jsx`, `Login.jsx` use bare HTML `required` with no visual marker. |
| Inline validation | **None.** All validation is post-submit and surfaced as a transient toast: `TaskList.jsx:240-250` ("Title, Client Name, Assignee, and Deadline are required") — the user must map a prose sentence back onto 4 fields, with **no field-level error state, no `aria-invalid`, no red border**. Same in `Profile.jsx:126-137` (password rules only revealed after failure), `ManageUsers.jsx:72-75`. |
| Help text | Rare. `Profile.jsx:285` "Roles are managed by your administrator" is the only good one. |
| Tab order / focus | `focus:outline-none` × 60 with the replacement ring specified as the **non-existent** `focus:ring-indigo-150` (41×). Zero `focus-visible`. **Keyboard users get no focus indicator on most of the app.** |
| Button hierarchy | Inverted. Cancel and Submit are **equal 50/50 width** (`TaskList.jsx:1514-1536`, `:1761-1837` — `w-1/2` each). Destructive `Delete Task` is a **solid red filled button** sitting next to `Edit Task` (`TaskList.jsx:1288,1298`) — the most dangerous action is the most visually prominent. |
| Disabled state | `disabled:opacity-50` only — no cursor, no aria, and opacity-50 on already-low-contrast text is invisible. |
| Autofocus in modals | None. Opening Create Task leaves focus on `<body>`. |
| Password | `Register.jsx:145-155` — no strength meter, no show/hide toggle, no stated rules; the 6-char minimum is only enforced in `Profile.jsx:134`, not at registration. |

## B8. Reports / Analytics

`Reports.jsx` (728 lines) — the most substantial data screen.

**What exists:** two hand-rolled SVG area charts (`:403-439` email volume, `:488-521` task creation) with Bezier smoothing (`:216-229`), gradient fills (`#6366f1`, `#a855f7`), gridlines, y-ticks, hover tooltips.

**Problems:**
- **Only two chart types, both the same** (smoothed area). There is no bar chart, no stacked bar (assigned vs completed), no distribution, no per-employee comparison chart. The employee performance data — the point of the page — is **numbers in a table only** (`:594-684`), with a 64px CSS progress bar as the sole visual (`:627-629`).
- **Bezier smoothing on daily count data is a lie** — it draws values between discrete days that never existed. Daily counts must be a bar or step chart.
- `viewBox="0 0 800 220"` fixed with `className="w-full h-auto"` (`:403`) — the chart **scales the text with the container**, so axis labels shrink on narrow screens and balloon on wide ones.
- `:433,513` — `className="group-hover:r-7"` — **Tailwind cannot set the SVG `r` attribute; this does nothing.**
- Tooltip positioned by percentage arithmetic (`:446-448`) with `transform: translate(-50%,-100%)` — clips outside the container at the chart edges.
- No legend, no axis titles, no units, no empty-data state, no date-range picker beyond the 7/14/30 pill group (`:353-365`).
- Client Analytics (`:699-721`) is a **grid of cards**, not a sortable table — you cannot rank clients by volume.
- Six KPI cards (`:302-332`) each with a different `border-l-4` accent color (`slate-400`, `indigo-500`, `purple-500`, `amber-400`, `emerald-500`, `red-500`) and `text-2xl font-black` in six different colors — a rainbow, not a dashboard.
- Export is **CSV only** (`:168-198`), and only for the employee table. The Inbox export (`EmailInbox.jsx:394-501`) writes an `.xls` file that is actually an HTML document — it will trigger a security warning in modern Excel.

---

# C. THE PROFESSIONAL DESIGN SYSTEM TO ADOPT

## C1. Color tokens

Drop indigo/violet/pink entirely. Move to a **neutral-dominant surface with a single restrained blue accent** — the standard for Linear, Vercel, Stripe Dashboard, Jira, Notion.

### Neutrals — Light
| Token | Hex | Use |
|---|---|---|
| `bg-canvas` | `#F8FAFC` | app background behind panels |
| `bg-surface` | `#FFFFFF` | panels, tables, cards, modals |
| `bg-subtle` | `#F1F5F9` | table header, hovered row, input fill |
| `bg-muted` | `#E2E8F0` | disabled fill, dividers block |
| `border-default` | `#E2E8F0` | **the only border you need** |
| `border-strong` | `#CBD5E1` | inputs, focused containers |
| `text-primary` | `#0F172A` | headings, table primary cell |
| `text-secondary` | `#475569` | body, table secondary cell |
| `text-tertiary` | `#64748B` | labels, captions, meta (**4.76:1 — passes AA**) |
| `text-disabled` | `#94A3B8` | disabled only — **never for labels** |

### Neutrals — Dark
| Token | Hex |
|---|---|
| `bg-canvas` | `#0B1220` |
| `bg-surface` | `#111827` |
| `bg-subtle` | `#1B2432` |
| `bg-muted` | `#273244` |
| `border-default` | `#273244` |
| `border-strong` | `#3A465A` |
| `text-primary` | `#F1F5F9` |
| `text-secondary` | `#CBD5E1` |
| `text-tertiary` | `#94A3B8` |
| `text-disabled` | `#64748B` |

### Primary — Blue (replaces indigo→purple gradient)
| Step | Hex | Use |
|---|---|---|
| 50 | `#EFF6FF` | selected-row tint, subtle button bg |
| 100 | `#DBEAFE` | badge bg |
| 200 | `#BFDBFE` | badge border |
| 500 | `#3B82F6` | focus ring, dark-mode primary |
| **600** | **`#2563EB`** | **primary button, active nav, links** |
| 700 | `#1D4ED8` | primary hover |
| 800 | `#1E40AF` | primary active/pressed |
Dark mode: primary = `#3B82F6`, hover `#60A5FA`, subtle bg `rgba(59,130,246,0.14)`, border `rgba(59,130,246,0.32)`.

### Semantic (light / dark-subtle-bg)
| Role | Solid | Text | Bg | Border | Dark bg |
|---|---|---|---|---|---|
| Success | `#16A34A` | `#15803D` | `#F0FDF4` | `#BBF7D0` | `rgba(22,163,74,.16)` |
| Warning | `#D97706` | `#B45309` | `#FFFBEB` | `#FDE68A` | `rgba(217,119,6,.16)` |
| Danger | `#DC2626` | `#B91C1C` | `#FEF2F2` | `#FECACA` | `rgba(220,38,38,.16)` |
| Info | `#0284C7` | `#0369A1` | `#F0F9FF` | `#BAE6FD` | `rgba(2,132,199,.16)` |
| Neutral | `#64748B` | `#475569` | `#F1F5F9` | `#E2E8F0` | `rgba(148,163,184,.14)` |

**Rules:** ≤2 accent hues on any screen. Role badges use **Neutral** (Employee), **Info** (Head), **Warning** (Admin) — never Danger, which is reserved for destructive/error. Priority uses Neutral/Info/Warning/Danger for Low/Medium/High/Urgent.

### Charts (categorical, colorblind-tested)
`#2563EB` `#0D9488` `#D97706` `#7C3AED` `#DB2777` `#0891B2` — sequential single-hue for volume: `#DBEAFE → #2563EB`.

### `tailwind.config.js`
```js
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  darkMode: 'class',              // explicit — kills the current 'media' leak
  theme: {
    extend: {
      colors: {
        canvas:'var(--bg-canvas)', surface:'var(--bg-surface)',
        subtle:'var(--bg-subtle)', muted:'var(--bg-muted)',
        line:'var(--border-default)', 'line-strong':'var(--border-strong)',
        fg:'var(--text-primary)', 'fg-2':'var(--text-secondary)',
        'fg-3':'var(--text-tertiary)', 'fg-off':'var(--text-disabled)',
        primary:{50:'#EFF6FF',100:'#DBEAFE',200:'#BFDBFE',500:'#3B82F6',
                 600:'#2563EB',700:'#1D4ED8',800:'#1E40AF'},
        success:'#16A34A', warning:'#D97706', danger:'#DC2626', info:'#0284C7',
      },
      fontFamily:{ sans:['Inter var','Inter','system-ui','-apple-system','Segoe UI','sans-serif'],
                   mono:['ui-monospace','SFMono-Regular','Menlo','monospace'] },
      fontSize:{
        '2xs':['11px',{lineHeight:'16px'}], xs:['12px',{lineHeight:'16px'}],
        sm:['13px',{lineHeight:'18px'}],   base:['14px',{lineHeight:'20px'}],
        md:['16px',{lineHeight:'24px'}],   lg:['18px',{lineHeight:'26px'}],
        xl:['20px',{lineHeight:'28px'}],  '2xl':['24px',{lineHeight:'32px'}],
      },
      borderRadius:{ none:'0', xs:'2px', sm:'4px', DEFAULT:'6px', md:'6px', lg:'8px', xl:'10px' },
      boxShadow:{
        xs:'0 1px 2px 0 rgb(15 23 42 / 0.04)',
        sm:'0 1px 3px 0 rgb(15 23 42 / 0.06), 0 1px 2px -1px rgb(15 23 42 / 0.04)',
        md:'0 4px 12px -2px rgb(15 23 42 / 0.10), 0 2px 4px -2px rgb(15 23 42 / 0.06)',
        lg:'0 16px 40px -8px rgb(15 23 42 / 0.18)',
        none:'none',
      },
      transitionDuration:{ DEFAULT:'150ms' },
    },
  },
  plugins:[require('@tailwindcss/forms')({strategy:'class'})],
}
```
Ban `rounded-2xl`/`rounded-3xl`/`shadow-xl`/`shadow-2xl` by simply not defining them (the config above overrides, not extends, the radius and shadow scales).

## C2. Typography

**Family:** **Inter** (or **IBM Plex Sans** if you want more institutional character). Self-host `Inter var` as woff2, weights 400/500/600 only, `font-display: swap`. Delete Outfit. Delete the `@import` in `index.css:1`; keep a single `<link rel="preload">` in `index.html`.

```css
:root{ font-feature-settings:'cv05' 1,'ss01' 1; }
.tabular{ font-variant-numeric: tabular-nums; }   /* required on every numeric cell */
```

| Token | Size/LH | Weight | Use |
|---|---|---|---|
| `display` | 24/32 | 600 | page title (`<h1>`), one per screen |
| `heading` | 20/28 | 600 | section/panel title |
| `subheading` | 16/24 | 600 | card title, modal title |
| `body-lg` | 16/24 | 400 | long-form prose only |
| `body` | 14/20 | 400 | **default UI text, form values, buttons** |
| `body-strong` | 14/20 | 500 | table primary cell, emphasized value |
| `body-sm` | 13/18 | 400 | **table cells — the density workhorse** |
| `caption` | 12/16 | 400 | meta, timestamps, helper text |
| `label` | 12/16 | 500 | form labels — **sentence case, `text-fg-2`, NOT uppercase, NOT 10px** |
| `overline` | 11/16 | 600, `tracking-wide`, uppercase | table headers **only** |

**Hard rules:** max weight **600**. No `font-black`/`font-extrabold`/`font-bold` anywhere. No font sizes below **11px**. No arbitrary `text-[Npx]`. Monospace only for IDs, hashes, and email addresses in tables — never for role names or badges.

## C3. Spacing, radius, border, shadow

**Spacing (4px base):** `0 · 2 · 4 · 6 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64`. Component internal padding uses 6/8/12; layout gaps use 16/24; section gaps use 24/32.

**Radius:**
| Token | px | Applies to |
|---|---|---|
| `xs` | 2 | checkbox, tag |
| `sm` | 4 | badge, chip, small button, table cell highlight |
| `DEFAULT` | 6 | **button, input, select, dropdown item** |
| `lg` | 8 | card, panel, table container, popover |
| `xl` | 10 | modal, drawer |
| `full` | ∞ | **avatar and status dot only** |

**Borders:** `1px solid var(--border-default)`. That is the entire border system. Elevation comes from borders + `bg-surface`, not shadow.

**Shadows:** `xs` (raised row), `sm` (card), `md` (dropdown/popover/tooltip), `lg` (modal/drawer). **Zero colored shadows. Zero glow.**

**Focus ring (one definition, applied to every interactive element):**
```css
.focus-ring:focus-visible{
  outline:2px solid #2563EB; outline-offset:2px; border-radius:inherit;
}
```
Never `focus:outline-none` without a `focus-visible` replacement.

## C4. Component specs

All heights in px. `sm` = dense/table-inline, `md` = default, `lg` = page-level primary only.

### Button
| Size | H | Padding-X | Font | Icon | Gap |
|---|---|---|---|---|---|
| sm | 28 | 8 | 12/16 500 | 14 | 6 |
| md | 32 | 12 | 13/18 500 | 16 | 6 |
| lg | 36 | 16 | 14/20 500 | 16 | 8 |
Radius 6. Icon-only: square (28/32/36).

| Variant | Rest | Hover | Active | Disabled |
|---|---|---|---|---|
| `primary` | bg `#2563EB`, text `#FFF`, no border | `#1D4ED8` | `#1E40AF` | `#93C5FD`, `cursor-not-allowed` |
| `secondary` | bg `#FFF`, border `#CBD5E1`, text `#334155` | bg `#F8FAFC` | bg `#F1F5F9` | text `#94A3B8`, border `#E2E8F0` |
| `ghost` | transparent, text `#475569` | bg `#F1F5F9` | bg `#E2E8F0` | text `#94A3B8` |
| `danger` | bg `#DC2626`, text `#FFF` | `#B91C1C` | `#991B1B` | `#FCA5A5` |
| `danger-ghost` | transparent, text `#B91C1C` | bg `#FEF2F2` | bg `#FEE2E2` | — |
| `link` | text `#2563EB`, underline on hover | `#1D4ED8` | — | — |
Loading: replace leading icon with a 14px spinner, keep the label, keep the width, set `aria-busy`. **Never** change the label to "Saving…" (causes width jump — current behavior at `Login.jsx:130`, `Profile.jsx:294`).
**Destructive actions are `danger-ghost`, promoted to `danger` only inside a confirm dialog.**

### Input / Textarea / Select
- Height **32** (dense) / **36** (default). Textarea min-height 72, `resize: vertical`.
- Padding `8px 10px`; with leading icon `padding-left: 32`, icon 16px at `left: 10`.
- `bg #FFF`, `border 1px #CBD5E1`, radius 6, font 13/18 (dense) or 14/20, text `#0F172A`, placeholder `#94A3B8`.
- Hover `border #94A3B8`. Focus `border #2563EB` + `box-shadow: 0 0 0 3px rgb(37 99 235 / 0.12)`.
- Error `border #DC2626` + `0 0 0 3px rgb(220 38 38 / 0.12)`, message 12/16 `#B91C1C` below with a 14px alert icon, `aria-invalid="true"` + `aria-describedby`.
- Disabled `bg #F1F5F9`, text `#94A3B8`, `cursor-not-allowed`.
- **Every field:** `<label htmlFor>` 12/16 500 `#475569`, 6px above; optional 12/16 `#64748B` help text below; required marked with `<span aria-hidden>*</span>` in `#DC2626` **or** — better for forms where most fields are required — mark the *optional* ones "(optional)".
- Select: native `<select>` for ≤10 options; Radix `<Select>` for anything searchable/grouped. Chevron 16px `#64748B` at `right: 10`.

### Table (the most important component)
```
Container:  bg-surface, border 1px #E2E8F0, radius 8, overflow hidden. No shadow.
Header:     height 36, bg #F8FAFC, border-bottom 1px #E2E8F0, position sticky, top 0, z 2
Header cell: 11/16 600 uppercase tracking-[0.04em] #475569, padding 0 12
             sortable → cursor-pointer + 14px chevron, aria-sort="ascending|descending|none"
Row:        height 40 (comfortable) / 32 (compact) / 48 (relaxed) — user-toggleable
            border-bottom 1px #F1F5F9
            hover bg #F8FAFC
            selected bg #EFF6FF + left 2px #2563EB inset
            focus-within outline 2px #2563EB inset
Cell:       padding 0 12, font 13/18, vertical-align middle, single-line + truncate by default
            numeric → text-align right + .tabular
            actions column → sticky right, bg inherit, width 88, ghost icon buttons revealed on
                             row hover but always present in the a11y tree
Selection:  header checkbox with indeterminate state; shift-click range select
Zebra:      OFF by default (borders are enough); optional toggle
Empty:      full-width cell, 48px vertical padding, EmptyState component
Loading:    5 skeleton rows matching real row height — never a spinner
Footer:     Pagination bar, height 44, bg #F8FAFC, border-top 1px #E2E8F0
```
Use **TanStack Table v8** (headless, ~14kB, works with plain JS) for sorting, column sizing, visibility, row selection, and pagination state. Wire the state into the URL query string so views are shareable.

### Badge
Height 20, padding `0 6`, radius 4, font 11/16 600, border 1px, `inline-flex items-center gap-1`, optional 12px leading icon.
Variants: `neutral` `info` `success` `warning` `danger` (bg/text/border from C1 semantic table).
**Always text + color.** Dot-only variant permitted **only** with an adjacent text label.
Count badge: `min-width 18, height 18, radius 9, font 11/16 600, padding 0 5, tabular`.

### Card / Panel
`bg-surface`, `border 1px #E2E8F0`, `radius 8`, `shadow-none`.
Header: 44px, `padding 0 16`, title 14/20 600, optional actions right, `border-bottom 1px #F1F5F9`.
Body `padding 16`. Footer 48px `bg #F8FAFC` `border-top`.
**KPI/stat tile:** `padding 12 16`, label 11/16 600 uppercase `#64748B`, value 24/32 600 `#0F172A` `.tabular`, delta 12/16 500 with a 12px arrow in success/danger. **No icon tile, no accent border, no hover lift, no animation.**

### Modal / Drawer
**Modal** — for focused create/edit ≤2 columns.
Scrim `rgba(15,23,42,0.45)`, **no blur**. Panel `bg-surface`, radius 10, `shadow-lg`, width `sm 400 / md 520 / lg 720`, `max-height calc(100vh - 96px)`.
Header 56px `padding 0 20`, title 16/24 600, 28px ghost close button, `border-bottom`.
Body `padding 20`, scrolls independently.
Footer 64px `padding 0 20`, `border-top`, `bg #F8FAFC`, **actions right-aligned, `[Cancel: secondary md] [Confirm: primary md]`** — auto-width, never `w-1/2`.
Behavior: focus trap, autofocus first field, `Esc` closes, click-scrim closes (**unless the form is dirty → confirm discard**), `aria-modal="true"` + `aria-labelledby`, body scroll lock, return focus to trigger.
**Destructive confirm:** modal `sm`, 20px danger icon, title states the object ("Delete task 'Q3 GST filing'?"), body states consequences, footer `[Cancel: secondary] [Delete: danger]`. **This replaces all 8 `window.confirm()` calls.**

**Drawer** — right-side, width 480 / 640 / 880, full height, radius 0, `shadow-lg`, `border-left`. Use for: email reading pane, task detail, activity-log entry detail.

### Toast
Bottom-right stack, max 3, `gap 8`, `offset 16`. Width 360, `min-height 44`, radius 8, `bg-surface`, `border 1px`, `shadow-md`, `padding 12 14`. 16px leading semantic icon, title 13/18 500, optional description 12/16 `#64748B`, optional action link, 20px ghost close.
Left 2px accent bar in the semantic color. Duration: success 4s, info 5s, **error = persistent until dismissed**. `role="status"` / `role="alert"`. Enter `opacity 0→1 + translateY 8px→0` over 150ms; exit 120ms.
Use **sonner** (2kB) or Radix Toast. **Delete the 7 copy-pasted blocks.**

### Tabs
Underline style. Container `border-bottom 1px #E2E8F0`. Tab height 38, `padding 0 12`, font 13/18 500 `#64748B`; active 600 `#0F172A` + `border-bottom 2px #2563EB` (`margin-bottom -1px`). Optional count badge right. Roving tabindex, ←/→ arrow keys, `role="tablist"`. **Active tab state belongs in the URL** (`?tab=sent`).

### Tooltip
`bg #0F172A`, text `#FFF` 12/16, radius 4, `padding 4 8`, `max-width 280`, `shadow-md`, 6px arrow, offset 6, delay-in 400ms / delay-out 0. Radix Tooltip. **Never for essential information.**

### Pagination
Height 44 bar. Left: `Showing 1–25 of 1,284` (12/16 `#64748B`, `.tabular`). Right: `Rows per page [25 ▾]` · `[‹] Page 1 of 52 [›]` with sm secondary buttons; jump-to-page input on >20 pages. Preserve state in the URL.

### EmptyState
Centered, `padding 48 24`, `max-width 380`. 32px icon `#94A3B8` (**stroke SVG, never emoji, no tile background**), title 14/20 600 `#0F172A`, body 13/18 `#64748B`, primary `md` CTA 16px below. Distinct copy for *no data yet* vs *no results for this filter* (the latter offers "Clear filters" as a secondary action).

### Skeleton
`bg #F1F5F9`, radius 4, height matching the real element (`text-sm` → 14px bar, avatar → circle). Shimmer:
```css
@keyframes skeleton{100%{background-position:-100% 0}}
.skeleton{background:linear-gradient(90deg,#F1F5F9 40%,#E9EEF5 50%,#F1F5F9 60%) 0 0/200% 100%;
          animation:skeleton 1.4s linear infinite}
@media (prefers-reduced-motion:reduce){.skeleton{animation:none}}
```
Skeletons must mirror the real layout — table skeletons are rows, not one grey block.

### Avatar
Sizes `xs 20 / sm 24 / md 32 / lg 40`, `rounded-full`, `bg #E2E8F0`, initials 11/12/13/14 at weight 500 `#475569`.
**Deterministic tint from a hash of the user id**, drawn from a 6-swatch muted set: `#E2E8F0 #DBEAFE #DCFCE7 #FEF3C7 #FCE7F3 #E0E7FF`. **No gradients, no gradient rings.**
Group: `-8px` overlap, 2px `bg-surface` ring, `+N` overflow chip.

## C5. Layout spec

```
Shell (fixed, does not scroll):
  html,body,#root { height:100%; overflow:hidden }
  <div class="h-screen flex flex-col">
    <TopBar   h=48  border-bottom 1px, bg-surface, z=30 />
    <div class="flex-1 flex min-h-0">
      <Sidebar w=240 (collapsed 56) border-right 1px, bg-canvas, z=20, own overflow-y />
      <main class="flex-1 min-w-0 overflow-y-auto bg-canvas">
        <PageHeader h=56 sticky top-0 bg-canvas/95 border-bottom 1px />
        <div class="px-6 py-5">  {content}  </div>
      </main>
    </div>
  </div>
```
| Token | Value |
|---|---|
| TopBar height | **48** (currently 64 — reclaim 16px of vertical data space) |
| Sidebar width | **240** expanded / **56** collapsed, persisted to `localStorage` |
| PageHeader | 56, sticky, holds `<h1>` + primary action + breadcrumb |
| Content padding | `24px` horizontal, `20px` top |
| Content max-width | **none** for tables/lists (fluid, `min-width 720`); **`720px`** for forms/settings; **`1440px`** for dashboards |
| Grid | 12 col, `gutter 16`, `column-gap 24` |
| Breakpoints | `sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536`; sidebar becomes an overlay drawer `< lg` |
| Z-index | dropdown 40 · sticky header 30 · sidebar 20 · drawer 50 · modal 60 · toast 70 · tooltip 80 |

Right rail (optional, 320px) for the email reading pane / task detail on `≥ 1440px`; below that it becomes a Drawer.

## C6. Library recommendation — **shadcn/ui + Radix UI + Tailwind**

**Pick: shadcn/ui.** Reject Mantine and Ant Design.

**Why it fits this codebase specifically:**
1. **Tailwind 3 is already installed and every one of the ~10,600 lines of JSX is Tailwind-classed.** shadcn *is* Tailwind — components are copied into `src/components/ui/` as source you own and restyle. Mantine (emotion/CSS-in-JS) and AntD (Less + its own reset) each add a **second, competing styling system** that would fight the existing markup for the entire migration window.
2. **Incremental adoption is possible.** shadcn has no provider, no theme context, no global reset. You can convert `ManageUsers.jsx` to `<Table>` while `TaskList.jsx` stays untouched. Mantine requires a `MantineProvider` at the root and AntD a `ConfigProvider` + reset — both are big-bang changes on a 10.6k-line app with no tests.
3. **JS, not TS, is fine.** `npx shadcn@latest init` supports `"tsx": false` and emits `.jsx`. Mantine and AntD ship TS types you can't leverage without a TS migration; their DX advantage evaporates in plain JS.
4. **Radix gives exactly what is missing here.** The audit found: no focus trap, no `Esc` handling, no `aria-modal`, no roving tabindex, no `aria-sort`, no `aria-live`, one `aria-label` in the whole app. Radix Dialog/Dropdown/Select/Tabs/Tooltip/Popover/Toast solve all of that as unstyled, accessible primitives.
5. **Bundle.** Radix primitives are tree-shaken per-component (~3–8kB each); you ship only what you import. AntD's baseline is >800kB min (>200kB gz) plus its own icon font — real cost on office broadband and low-end hardware. Mantine core is ~120kB gz.
6. **AntD would fight the requirement.** Its visual identity (`#1677FF`, 6px radius, dense Chinese-enterprise conventions) is strong and hard to override without `!important` warfare — and it would *replace* one opinionated look with another rather than establishing your own tokens.

**Install alongside:**
| Package | Purpose | ~gz |
|---|---|---|
| `shadcn` CLI + Radix primitives | Dialog, DropdownMenu, Select, Tabs, Tooltip, Popover, Checkbox, Toast | ~40kB total for the set used |
| `@tanstack/react-table` v8 | headless sorting / selection / column sizing / pagination for all 7 tables | 14kB |
| `lucide-react` | **the icon system — replaces all 26 emoji and the ~80 hand-inlined SVG paths** | tree-shaken, ~0.5kB/icon |
| `sonner` | toast stack — replaces 7 copy-pasted blocks + 3 `alert()` | 2kB |
| `cmdk` | ⌘K command palette | 5kB |
| `recharts` | Reports charts — replaces the hand-rolled SVG | 40kB (lazy-load the route) |
| `@tailwindcss/forms` | native form-control reset | 0 (build-time) |
| `class-variance-authority` + `tailwind-merge` | variant API for Button/Badge/Input | 3kB |

Total added runtime ≈ **65kB gz** (excluding the lazily-loaded chart route) — against removing `cursorEffects.js`, `moduleCursor.js`, `tiltEffect.js`, `scrollAnimations.js`, `countUp.jsx`, `App.css`, and ~2/3 of `index.css`.

## C7. Motion policy

**Allowed — 150ms, `ease-out` (`cubic-bezier(0.16,1,0.3,1)`), `opacity` and `transform` only:**
| Interaction | Spec |
|---|---|
| Hover/active on buttons, rows, nav | `background-color 100ms linear` (color only — **no transform, no lift, no scale**) |
| Focus ring | instant, no transition |
| Dropdown / popover / tooltip | `opacity 0→1` + `translateY 4px→0`, **120ms** in / 80ms out |
| Modal | scrim `opacity` 150ms; panel `opacity` + `scale(0.98→1)` 150ms |
| Drawer | `translateX(100%→0)` 200ms |
| Toast | `opacity` + `translateY(8px→0)` 150ms in, 120ms out |
| Accordion / disclosure | `height` 180ms `ease-out` |
| Skeleton shimmer | 1.4s linear infinite (the only infinite animation permitted) |
| Spinner | on in-flight requests only, appearing after a **250ms** delay to avoid flashing |
| Tab underline | `transform` 150ms |

**Global requirement:**
```css
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{ animation-duration:.01ms!important; animation-iteration-count:1!important;
                        transition-duration:.01ms!important; scroll-behavior:auto!important }
}
```

**Delete outright:**
| Delete | File |
|---|---|
| Custom cursor, trail dots, magnetic pull, ripple | `utils/cursorEffects.js` (whole file) + `index.css:11-19,26-107` |
| Cursor spotlight | `utils/moduleCursor.js` (whole file — already dead) |
| 3D tilt + glare | `utils/tiltEffect.js` (whole file) + `Dashboard.jsx:4,36-42`, `Landing.jsx:4,55-64` |
| Scroll-reveal + body MutationObserver | `utils/scrollAnimations.js` + `App.jsx:18,21-26` + `index.css:212-256` |
| Count-up numbers | `utils/countUp.jsx` + all 14 call sites |
| Blob morph / float / pulse-ring / gradientShift / shimmer-as-decoration | `index.css:130-210` |
| `animate-pulse` on badges, dots, buttons | 16 sites (A4 table) |
| `animate-bounce` on the bell | `NotificationBell.jsx:11,60-66,152` |
| `scroll-behavior: smooth` | `index.css:9` |
| Navbar scroll-shadow listener | `Navbar.jsx:7-15,46-48` |
| `hover:-translate-y-*`, `hover:scale-*`, `active:scale-*` | ~35 sites |
| `backdrop-blur-*` | 8 sites |
| `.glassmorphism`, `.dot-grid`, `.perspective-1200`, `.link-underline` | `index.css:110-128,274-293` |
| Dead `App.css` | whole file |

---

# D. SCREEN-BY-SCREEN REDESIGN BRIEF

---
## D1. Login (`pages/Login.jsx`) — and Register / ForgotPassword

**Wrong now**
- `:38-42` — left half is a `from-indigo-600 via-indigo-500 to-purple-600` gradient with **three animated pulsing blobs** (`h-72 w-72 bg-white/10 blur-2xl animate-pulse`, `h-96 w-96 blur-3xl animate-pulse delay-1000`).
- `:60` — card `rounded-3xl shadow-xl`; `:62` logo tile `rounded-2xl` gradient.
- `:68` — `text-3xl font-black`; `:72` tagline *"Manage Mails. Assign Tasks. Stay Ahead."*
- `:87,103` — labels `text-[10px] font-bold text-slate-400 uppercase` (2.85:1 contrast at 10px).
- `:95,111` — inputs `py-3 rounded-xl bg-slate-50/50 text-xs font-semibold` + `focus:ring-indigo-100`.
- `:128` — submit is a gradient with a **glow shadow** `shadow-[0_4px_15px_rgba(99,102,241,0.3)]` and `active:scale-[0.98]`; label swaps to "Signing In..." causing width jump.
- `:77` — error uses `animate-shake`, **undefined → no animation**; error is generic, not field-level.
- `:36` — `select-none` blocks copying an error/support message.
- No "remember me", no Caps-Lock hint, no password show/hide, no rate-limit messaging.

**Replace with**
Single centered column on `bg-canvas`, no split panel, no imagery.
```
[ 32px wordmark + "K M KOTHARI Operations" 14/20 500 #475569 ]      centered, 48px above card
[ Card: 400px, bg-surface, border 1px, radius 8, shadow-sm, padding 32 ]
   h1  "Sign in"                    20/28 600
   p   "Use your workspace account" 13/18 #64748B, margin-bottom 24
   [ Alert (danger, inline, persistent, role="alert") — only on failure ]
   Label "Email"     12/16 500 #475569
   Input  h36, autofocus, autocomplete="username"
   Label "Password"  + "Forgot password?" link right-aligned on the same baseline
   Input  h36, autocomplete="current-password", trailing eye toggle (ghost sm icon button)
   Checkbox "Keep me signed in on this device"   13/18
   Button primary lg, full-width, "Sign in"  → spinner replaces nothing; label constant
   ——— hr ———
   "Don't have an account? Request access"  13/18 #64748B
[ Footer: "© K M KOTHARI · Internal use only"  12/16 #94A3B8 ]
```
Field-level errors under each input; a single summary Alert for auth failure. Apply identically to `Register.jsx` (delete `:52-56` blobs) and `ForgotPassword.jsx`.

---
## D2. Dashboard (`pages/Dashboard.jsx`)

**Wrong now**
- `:4,36-42` — **3D tilt** applied to every `.tilt-stat-card`.
- `:235,249,263,277,293,307,321,335,349,363` — **10 emoji** as KPI icons in `h-8 w-8 rounded-lg` tiles.
- `:240,254,268,282,298,312,326,340,354,368` — **`<CountUp>` on every KPI**; values animate from 0 for 1.5s on load.
- `:233` etc. — cards `p-6 rounded-2xl shadow-sm hover:shadow-[0_20px_40px_rgba(99,102,241,0.08)] hover:-translate-y-1 transition-all duration-300` — they lift and glow on hover.
- `:239` — value `text-3xl font-black`; `:236` category chip `text-[9px] font-mono uppercase` ("Active", "Sync", "Workload" — meaningless).
- `:179` — the page title is preceded by a `font-mono uppercase` pill "DASHBOARD OVERVIEW".
- `:186` — *"one unified command center"* — marketing voice.
- `:194-217` — an "Account Credentials" card showing the user their own name/email/role — **duplicates the Profile page and consumes the top third of the primary screen**.
- `:211-214` — "Secure Session" with a **pulsing green dot** and no meaning.
- `:121` — `window.confirm` for Gmail disconnect.
- `:227` — skeleton uses undefined `skeleton-shimmer`.
- **There is no actual work on the dashboard** — no task list, no overdue queue, no unassigned inbox count with a link. It is 10 numbers and a settings card.

**Replace with — a work-starting screen**
```
PageHeader: "Dashboard"  ·  right: [Date range ▾ Last 30 days] [Sync now (secondary md)]

Row 1 — KPI strip (6 tiles, grid-cols-6 @xl / 3 @md / 2 @sm, gap 16, no hover effect):
  each: label 11/16 600 uppercase #64748B · value 24/32 600 .tabular · delta 12/16 500 (↑/↓ 12px icon,
        success/danger) vs previous period. No emoji, no icon tile, no accent border, no animation.
  Overdue tile: value in danger #B91C1C, entire tile is a link to /tasks?status=Late

Row 2 — two columns (2fr / 1fr, gap 24):
  LEFT  Card "Needs attention"  — a real 8-row Table, not cards:
        [Type][Subject / Task][Client][Assignee][Due][Status] — sortable, row → drawer
        default filter: overdue + due-today + unassigned-emails, footer link "View all"
  RIGHT Card "Task throughput (30d)" — Recharts stacked bar, created vs completed per day
        Card "Connections" — Gmail accounts as a compact list:
              [16px avatar][address][Badge success "Connected" / warning "Token expired"][⋯ menu]
              ⋯ menu → Sync, Reauthorize, Disconnect (Disconnect opens a danger confirm Modal)
```
Delete the "Account Credentials" card entirely (it lives in Profile). Delete `CountUp`, `initTilt`, all emoji.

---
## D3. EmailInbox (`pages/EmailInbox.jsx`) — **highest priority**

**Wrong now**
- `:1190-1201` — list is `space-y-3.5` of `rounded-2xl border shadow-sm` cards; **~90px per row, ~10 visible**.
- `:1224,1242` — hardcoded `max-w-[180px]/[260px]/[240px]/[480px]` truncation instead of a column grid.
- `:1294-1457` — inline accordion holding a **300px iframe** (`:1345`), AI panel, attachments, and reply composer; opening one email pushes the entire list.
- `:806-835` — the **search bar is fully inline-styled** with `🔍` as the icon (`:811`), `borderRadius: '8px'`, `background: '#f8fafc'` — a different radius and fill from every other control on the page.
- `:1303-1334` — AI Summary panel inline-styled with `#c7d2fe`/`#eef2ff`/`#4338ca`, `borderRadius: '5px'/'8px'`.
- `:1378-1425` — reply composer inline-styled, send button `background:'#4f46e5'`, `borderRadius:'6px'`, `↩ Reply` emoji button.
- `:693-788` — the toolbar is **five competing buttons**, each a different color: gradient Sync, indigo Keyword Rules, indigo/emerald Download, indigo-650 Manage Accounts, red Clear All. `:700` — the Download button **`animate-pulse`s** until clicked.
- `:963` — the Accounts panel is `bg-indigo-50/15 border-2 border-indigo-500/20 rounded-3xl shadow-lg shadow-indigo-500/5 ring-4 ring-indigo-500/[0.02]` — a purple glowing box with a `blur-2xl` decorative circle (`:964`).
- `:841-937` — 6 tab buttons, **~100 lines of duplicated JSX**, `rounded-lg` pills inside a `rounded-xl` tray.
- `:1179-1188` — "Select All" is an unstyled native checkbox with inline sizing; selects the current page only but is labelled "Select All".
- `:1253-1259` — status shows the raw lowercase DB value.
- `:318,550,571` — three `window.confirm()` on destructive actions including **"clear ALL emails"**.
- `:37-38,45,77-78` — tab, account filter, search and page are **all component state, none in the URL**.
- `:345` — fetches **every email with full bodies** into memory, then filters and paginates client-side.
- `:199-203` — silent 5-minute auto-reload with no indicator.

**Replace with — a three-pane mail client**
```
PageHeader "Inbox"  ·  right: [Sync now (secondary, shows relative last-sync time)]
                              [⋯ menu: Export backup · Keyword rules · Manage accounts · Clear all inbox]
      (the destructive "Clear all" lives inside the overflow menu, never as a top-level red button)

Toolbar (h 44, sticky, border-bottom):
  left : Tabs (underline) Inbox · Sent · Promotions · Social · Updates · Spam   each with a count Badge
  right: [Search  h32 w280, 16px lucide Search icon, ⌘K / "/" focuses]
         [Account ▾ h32]  [Status ▾ h32]  [Assignee ▾ h32]  [Clear filters (ghost, only when active)]
  ALL filter state lives in the URL query string.

Selection bar (replaces the toolbar in place when n>0 — does not push content):
  "12 selected"  ·  [Assign to ▾] [Due date] [Priority ▾] [Create tasks (primary sm)] [Clear]
  Plus "Select all 1,284 matching this filter" when the page selection is complete.

LIST PANE (fluid width, or 480px fixed when the reading pane is open):
  Real <table>, sticky header h36, row h40, columns:
  [ 32 checkbox ][ 24 attachment/unread indicator ][ 200 From ][ 1fr Subject — subject 13/18 500
    + 13/18 400 #64748B snippet on the same line ][ 160 Account ][ 120 Status Badge ][ 88 Received
    (relative <24h, absolute after; .tabular) ][ 40 ⋯ sticky-right ]
  Row hover → bg #F8FAFC. Row click → opens reading pane (does NOT expand inline).
  Keyboard: ↑/↓ move · Enter open · x select · a assign · e archive · / search · ⌘K palette
  Row height ~40px → 22–24 emails per screen (2.4× current).

READING PANE (right rail 640px ≥1440px, Drawer below):
  Header: subject 16/24 600 · from/to/date 12/16 #64748B · Badge status · [Assign task (primary sm)]
          [Reply (secondary sm)] [⋯]
  Body: sandboxed iframe, fills the pane, "Show images" gate for remote content
  Attachments: horizontal strip of file chips (12px type icon, name, size)
  AI summary: collapsible Card at the top, "Summarize" as a secondary sm button, result in a
              subtle bg-subtle block — not a lavender inline-styled panel
  Reply: inline composer at the bottom of the pane, [Cancel secondary][Send primary]

Footer: Pagination bar (server-side — move filtering/paging to the API).
Empty:  EmptyState per tab + a distinct "No results for '<query>'" with [Clear filters].
```
All destructive actions → danger confirm Modal, never `window.confirm`.

---
## D4. TaskList (`pages/TaskList.jsx`)

**Wrong now**
- **Live crash:** `:692,712,747` call `setSelectedTaskIds` / `setSelectAll`, **neither of which is declared in the file**. Changing the Creator, Priority, or Status filter throws `ReferenceError`.
- `:1020-1032` — list is `space-y-3.5` cards, `p-5`, `rounded-2xl`, `hover-glow-card` (undefined), `border-l-4` status stripe. Same ~90px pitch as the inbox.
- `:1063-1089` — a single row carries **four pills**: deadline pill, status pill, recurrence pill (`🔁`), priority pill — three of which encode overlapping state, all `rounded-full`, none aligned to a column.
- `:1055` `✉️`, `:1081` `🔁`, `:1148` `🔗`, `:1734` `🔗`, `:1226` `×` — emoji as UI.
- `:5-13` — `getPriorityStyle` returns inline hex objects; `:715` the Priority `<select>` is inline-styled `borderRadius:'6px'` beside a Tailwind `rounded-xl` sibling.
- `:1198-1262` — the **entire comment thread is inline-styled** (`#f8fafc`, `#e2e8f0`, `#4f46e5`, `borderRadius:'8px'`), with a bare `×` delete and no confirm.
- `:742-758` — status filters are gradient-filled pills (`from-indigo-600 to-purple-600`) — filters should never look like primary buttons.
- `:1339-1341,1544-1545` — modals: `backdrop-blur-md` scrim, `bg-white/95 backdrop-blur-2xl rounded-3xl shadow-[0_25px_80px_rgba(99,102,241,0.2)]`, no focus trap, no Esc, no autofocus, footer buttons `w-1/2` each.
- `:1288,1298` — `Edit Task` (outlined indigo) sits beside `Delete Task` (**solid red fill**) — the destructive action is the loudest thing in the row.
- `:350` — `window.confirm` for delete; `:639,650` — `alert()` fallbacks.
- `:1240-1249` — comment textarea; `:1241` Enter-to-send is the **only keyboard shortcut in the app**.
- Filters (`:44-46`) and view mode (`:58`) are local state, **not in the URL**.
- No pagination — every task renders.
- Kanban (`:932-1006`) columns are `border-2 border-dashed` — permanent dashed borders read as an unfinished wireframe.
- Calendar (`:812-931`) cells are `rounded-2xl` at `gap-2` — a calendar grid should be a continuous 1px-ruled grid.

**Replace with**
```
PageHeader "Tasks"  ·  right: [New task (primary md)]
Toolbar h44 sticky:
  left : Segmented control [Table] [Board] [Calendar]   (icon+label, 28px, one active)
  right: [Status ▾][Priority ▾][Assignee ▾][Client ▾][Due ▾][Search h32][Clear filters]
         [Saved views ▾: My open · Overdue · Due this week · Unassigned  + "Save current view"]
  All state in the URL.

Selection bar when n>0: "8 selected" [Assign ▾][Set due][Set priority ▾][Mark complete][Delete (danger-ghost)]

TABLE view (default):
  sticky header h36, row h40, columns:
  [32 ☑][1fr Title — 13/18 500 + client 12/16 #64748B beneath][120 Assignee: 20px avatar + name]
  [96 Priority Badge][96 Status Badge][110 Due — .tabular, danger when overdue, warning <24h]
  [64 Comments — 14px icon + count][40 ⋯ sticky-right]
  Recurrence: a 14px repeat icon with a Tooltip ("Repeats weekly") — not a pill.
  Row click → Task Drawer (640px). No inline accordion.

TASK DRAWER:
  Header: title 16/24 600 · Badges (status, priority) · [Mark complete (primary sm)] [⋯]
  Tabs: Details · Linked email · Comments (n) · Activity
  Details = a read-only definition list with inline edit-on-click; Comments = proper thread
  (24px avatar, name 13/18 500, relative time 12/16 #64748B, body 13/18 400, hover ⋯ → Delete
  with a confirm), composer pinned to the drawer bottom.

BOARD: columns bg #F8FAFC, border 1px solid (not dashed), radius 8, header h40 with a count Badge.
       Cards: bg-surface, border 1px, radius 6, padding 10, title 13/18 500, meta row 12/16.
       Drop target = a 2px #2563EB inset outline, not a background wash.
CALENDAR: continuous 1px #E2E8F0 grid, day cells radius 0, today = 2px #2563EB top border +
       #EFF6FF fill, events = 20px bars with a 3px leading priority stripe, "+3 more" overflow.
Footer: Pagination.
```
**Fix the `setSelectedTaskIds` crash as part of this work** (or immediately, as a hotfix — see Phase 0).

---
## D5. ClientList (`pages/ClientList.jsx`)

**Wrong now**
- `:191` — `<div className="p-6 max-w-7xl mx-auto space-y-6">` — **a different container from every other page** (which use `<main className="max-w-7xl px-4 sm:px-6 lg:px-8 py-8">`). Content shifts horizontally when navigating.
- `:195` — `text-2xl font-black` + a `w-9 h-9 rounded-xl bg-indigo-600/10` icon tile beside the `<h1>` (a pattern also in `Reports.jsx:281` but not on other pages).
- `:338` — the client avatar is a **`bg-gradient-to-tr from-indigo-600 to-purple-600` tile**.
- `:222` — the filter bar is a `rounded-2xl shadow-sm` card floating above the table; `:246` status filters are solid indigo buttons.
- `:172` — **`alert()` is the only feedback on a failed delete.**
- `:290-295` — loading is a spinning ring with "Loading clients data..." — a **third** loading pattern (vs skeletons elsewhere).
- `:327-328` — numeric column headers read "Work Given" / "Mails Recv." (abbreviated jargon), values are `text-center` inside `rounded-lg` colored chips with icons (`:367,376`) instead of right-aligned tabular numbers.
- No pagination, no sorting, no bulk actions.

**Replace with**
```
Standard PageHeader "Clients" · [New client (primary md)]
Toolbar h44 (no card wrapper, just a border-bottom):
  [Search h32 w280] [Status ▾] [Clear filters]   ·   right: [Density ▾] [Columns ▾] [Export]
Table (single view — delete the Board/List toggle at :256-285; a client directory has no board use case):
  [1fr Client — 24px avatar (neutral tint) + name 13/18 500 + associated emails 12/16 mono #64748B truncated]
  [160 Contact][200 Email][120 Phone][90 Tasks — right, .tabular][90 Emails — right, .tabular]
  [96 Status Badge][40 ⋯]
  Sortable on every column. Row click → Client Drawer (details · tasks · emails · notes).
Footer: Pagination. Delete → danger confirm Modal. Failures → persistent error Toast, never alert().
```
Consolidate with `ManageUsers.jsx`'s "Manage Clients" sub-tab (`:484-560`) — **the app currently has two separate client management screens** with different columns and different behavior.

---
## D6. ManageUsers (`pages/admin/ManageUsers.jsx`)

**Wrong now**
- `:352` — table wrapper `rounded-2xl shadow-sm hover-glow-card` (undefined class).
- `:372` — `<thead>` is **not sticky**; `:374-378` headers are not sortable.
- `:404` — rows `px-6 py-4` ≈ **57px**; no pagination — every user renders.
- `:397` — **`animate-pulse` on the "Pending" status badge** — the status column throbs.
- `:387-392` — role colors: **Admin = red**, Head = purple, Employee = indigo. Red already means Rejected in the adjacent Status column (`:399`).
- `:435-472` — actions are **bare text links** ("Approve" "Reject" "Edit" "Delete") in `space-x-3`, with Delete in red. No overflow menu, no icons, 4 links competing at 14px.
- `:236` — client delete uses **`window.confirm`** while user delete uses a **custom modal** (`:15,264-267`) — two confirmation patterns in one file.
- `:286-310` — the "admin sub-nav" mixes two `<button>`s and one `<Link>`, styled to look identical but behaving differently (state vs navigation). Users/Clients are not routable.
- `:314-328` — the copy-pasted toast block, with `red-550` (**non-existent shade**) at `:317`.
- `:412` — `bg-slate-105` — non-existent shade.

**Replace with**
```
Route the sub-navigation: /admin/users · /admin/clients · /admin/activity  (real Tabs, URL-driven).

PageHeader "Users"  ·  right: [Invite user (primary md)]
Toolbar h44: [Search h32] [Role ▾] [Status ▾]  ·  right: [Density ▾] [Export]
Alert strip (info) when pending>0: "3 users are awaiting approval  [Review]"

Table, sticky header, row h40, sortable:
  [32 ☑][1fr User — 24px avatar + name 13/18 500 + email 12/16 #64748B][110 Role Badge
   (Admin=warning, Head=info, Employee=neutral)][110 Status Badge (Approved=success,
   Pending=warning, Rejected=danger — NO pulse)][130 Last active .tabular][110 Gmail accounts —
   "2 of 5" .tabular][40 ⋯ sticky-right]
  ⋯ menu: Edit · Reset password · Manage Gmail access · ─── · Approve / Reject (when pending)
          · Deactivate · Delete (danger item)
  Pending rows get an inline [Approve (primary sm)] [Reject (secondary sm)] pair in the actions
  column — the only case where actions are surfaced outside the menu.
Bulk bar when n>0: [Approve][Reject][Change role ▾][Deactivate]
Footer: Pagination.
Add/Edit user → Modal md. Delete → danger confirm Modal naming the user. Never window.confirm.
```

---
## D7. Reports (`pages/admin/Reports.jsx`)

**Wrong now**
- `:281` — `<h1>` wraps a `w-10 h-10 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/20` icon tile.
- `:302-332` — 6 KPI cards, each with a **different `border-l-4` accent** and value in a **different color** at `text-2xl font-black`.
- `:336,467,541,688` — every panel is `rounded-3xl p-6 shadow-sm`.
- `:216-229,403-439,488-521` — **hand-rolled SVG with Bezier smoothing on discrete daily counts** — the curve draws values that never existed. Should be bars.
- `:433,513` — `className="group-hover:r-7"` — **Tailwind cannot set the SVG `r` attribute; dead code.**
- `:443-461,523-535` — tooltips positioned by percentage math; clip at chart edges; `bg-slate-900/90 backdrop-blur-md rounded-xl shadow-xl`.
- `:403,488` — fixed `viewBox` with `w-full h-auto` scales axis text with the container.
- No legend, no axis labels, no units, no empty-data state.
- `:594-684` — the employee table centers numeric columns (`:598-602`), has no sorting, no sticky header, no pagination; expand-row (`:643-678`) renders task cards in a nested grid rather than a sub-table.
- `:699-721` — Client Analytics is a **card grid**, so clients cannot be ranked.
- `:168-198` — export is CSV, employee table only.

**Replace with**
```
PageHeader "Reports"  ·  right: [Date range ▾ (presets + custom)] [Export ▾ (CSV · XLSX · PDF)]
Tabs (URL-driven): Overview · Email volume · Employee performance · Clients

KPI strip: 6 tiles, identical treatment, value 24/32 600 .tabular, one delta each. No accent borders.

Charts — Recharts, lazy-loaded route:
  "Email volume"      → stacked BarChart (received vs converted-to-task) by day/week
  "Task throughput"   → grouped BarChart (created vs completed) + a LineChart for open backlog
  "Completion rate"   → LineChart with a target reference line
  Every chart: axis titles + units, legend top-right, gridlines #F1F5F9 horizontal only,
  crosshair + a single tooltip Card (bg-surface, border, shadow-md — not a dark blur pill),
  fixed 320px height, responsive width, series colors from the C1 categorical palette,
  explicit empty state ("No data in this range").

"Employee performance" tab → sortable, paginated Table:
  [1fr Employee][80 Assigned ▸][80 Completed ▸][80 Pending ▸][80 Late ▸]
  [140 Completion rate — 64px bar + "%" right-aligned .tabular][40 ⋯]
  all numeric right-aligned + tabular; row click → Drawer with that employee's task table.
"Clients" tab → the same table pattern, sortable by mails / tasks / completion.
```

---
## D8. ActivityLog (`pages/admin/ActivityLog.jsx`)

**Wrong now**
- `:139-171` — the two filters sit in a `rounded-2xl shadow-sm` card above the table, each `<select>` `px-4 py-3 rounded-xl` with `focus:ring-indigo-150` (**non-existent**).
- `:129` — Refresh button `border-2 border-indigo-650` — a 2px indigo outline on a secondary action.
- `:174` — table wrapper `rounded-2xl shadow-sm hover-glow-card`.
- `:193-201` — header **not sticky, not sortable**; `:225` rows `px-6 py-4` ≈ 57px.
- **No pagination, no date range, no free-text search** — `:31` fetches `/users/activity-logs` unbounded and renders every row. An audit log will grow to tens of thousands of entries and hang the browser.
- `:208-221` — role and action badge colors assigned by `if` chains (`log.action.includes('Task')`) — fragile string matching.
- `:104` — `bg-emerald-55` (custom shade defined in config, but the only one of its kind).
- `:91-98` — sub-nav is a `<Link>` styled to look like a tab.
- Filters are local state, not in the URL.

**Replace with — a proper audit log**
```
Real Tabs at /admin/activity.
PageHeader "Activity log" · right: [Export CSV]
Toolbar h44: [Search h32 w320 "Search actions, users, details…"] [User ▾] [Action ▾]
             [Date range ▾] [Clear filters]     — all URL-driven, server-side filtered
Table, sticky header, sortable, row h36 (compact default — this is a scanning surface):
  [150 Timestamp — .tabular mono, absolute, Tooltip with relative][180 User — 20px avatar + name]
  [90 Role Badge][150 Action Badge (colored from an explicit action→variant MAP, not
   string.includes)][1fr Details — truncate 1 line, expand-on-click][110 IP / source]
Row click → Drawer with the full event payload as a definition list.
Footer: server-side Pagination (default 50/page) + "Load newer" when live.
```

---
## D9. Profile (`pages/Profile.jsx`)

**Wrong now**
- `:186` — `max-w-4xl` while every other page is `max-w-7xl` — the layout jumps on navigation.
- `:206,227,301,358` — four `rounded-3xl p-6 shadow-sm` cards.
- `:207` — avatar is a **`rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 shadow-lg shadow-indigo-600/10`** tile at `h-20 w-20`; `:211` name at `text-2xl font-black`.
- `:233,244,256,266,278,307,320,332` — **8 labels** at `text-[10px] font-bold text-slate-400 uppercase` with **no `htmlFor`**.
- `:237,248,259,270,312,325,337` — inputs `py-3 rounded-xl` with `focus:ring-indigo-150` (**non-existent → no focus ring on any field**).
- `:292,348,411` — three gradient submit buttons; labels swap to "Saving changes..."/"Updating password..." (width jump).
- `:366` — connection status is a **pulsing dot**; `:387` — **`🔒` emoji** for the restricted state.
- `:88` — `window.confirm` for Gmail disconnect.
- `:126-137` — password rules (match, ≥6 chars) revealed **only after submit**, as a transient toast.
- `:178-181` — loading is two blank `rounded-3xl` boxes (`skeleton-shimmer` undefined).
- `:186` — `select-none` prevents copying your own email address.

**Replace with**
```
Standard PageHeader "Settings", max-width 720 for the form column.
Left rail Tabs (vertical, 180px) — URL-driven: Profile · Security · Connections · Notifications
  Profile:
    Card "Profile" — 40px neutral avatar + [Change] · Full name · Email · Phone · Birthdate
                     Role (disabled input + help "Managed by your administrator")
                     Footer: [Save changes (primary md)] right-aligned, disabled until dirty
  Security:
    Card "Password" — Current · New (live strength meter + inline rules that turn green as
                      satisfied: ≥8 chars, 1 number, 1 symbol) · Confirm (inline mismatch error)
                      Footer: [Update password]
    Card "Sessions" — table of active sessions with [Sign out] per row
  Connections:
    Card "Google Workspace" — list of accounts:
      [24px avatar][address 13/18 500][Badge success "Connected" / warning "Token expired"]
      [last sync 12/16 #64748B][⋯ → Sync now · Reauthorize · Disconnect (danger item)]
      [Connect account (secondary md)] below the list
      Disconnect → danger confirm Modal stating "N emails will be removed" with the real count.
Remove select-none. Add htmlFor to every label. Inline validation on every field.
```

---
## D10. Landing (`pages/Landing.jsx`)

**Wrong now** — the whole file (566 lines). It is the app's **root route** (`App.jsx:32`).
- `:5,32` — initializes the **custom cursor with trailing dots and magnetic buttons**.
- `:58,62-64` — **3D tilt** on the hero mockup and all 6 feature cards.
- `:141-143` — three animated morphing blobs; `:139` `dot-grid` background.
- `:154,161` — `text-8xl font-black` headline with a **pink→purple gradient-clipped** third line.
- `:175` — CTA with a literal neon glow `shadow-[0_0_40px_rgba(99,102,241,0.4)]`.
- `:189-196` — **fabricated social proof**: five fake avatars + "Trusted by 500+ teams worldwide".
- `:14-21,236-255` — **fabricated metrics** (1248 emails, 892 completed) and **fabricated trends** ("↑ 12% this week", "↓ 3 from yesterday").
- `:370,389,408,427,446,465` — six **emoji** as feature icons at `text-2xl`.
- `:366` etc. — feature cards `rounded-[2.5rem]` (**40px**) with `hover:-translate-y-2`.
- `:204-205` — the mockup is permanently `rotateX(12deg)` and `animate-float`s.
- `:177,183,547` — "Start for Free →", "See a Demo", "Create Your Account" — **none of which exist**.
- `:100` — `setInterval(handleScrollReveal, 100)` — a 10Hz DOM-polling loop that never stops.

**Replace with — delete the marketing site**
This is an internal tool. The right answer is:
1. **`/` redirects to `/dashboard` when authenticated, `/login` when not.** Change `App.jsx:32` to a redirect.
2. Delete `Landing.jsx`, `utils/cursorEffects.js`, `utils/tiltEffect.js`, `utils/countUp.jsx`, `utils/scrollAnimations.js`, `utils/moduleCursor.js`.
3. If a public front door is genuinely required for external users, it should be **one screen**: wordmark, one sentence ("K M KOTHARI Operations — internal workspace"), a `[Sign in]` primary button, a `[Request access]` link, and a support contact. Static, no animation, no fake statistics — the current fabricated "500+ teams" and invented percentages are a factual misrepresentation that should not ship regardless of styling.

---

# E. PRIORITIZED MIGRATION PLAN

Estimates assume one competent frontend engineer. Phases 0–3 are strictly ordered; 4–7 can be reordered by business priority.

---
### Phase 0 — Stop the bleeding (0.5 day) · **do today**
| Task | Files |
|---|---|
| Fix the `setSelectedTaskIds` / `setSelectAll` `ReferenceError` — remove the 3 dead calls or declare the state | `TaskList.jsx:692,712,747` |
| Delete `initCursorEffects` import + call | `Landing.jsx:5,32` |
| Delete `initTilt` import + effect | `Dashboard.jsx:4,36-42`; `Landing.jsx:4,55-64` |
| Delete `initScrollAnimations` (kills the body-wide MutationObserver) | `App.jsx:18,21-26` |
| Delete `utils/cursorEffects.js`, `moduleCursor.js`, `tiltEffect.js`, `scrollAnimations.js`, `App.css` | 5 files |
| Strip cursor/blob/float/glassmorphism/dot-grid/reveal CSS | `index.css:9,11-19,26-128,130-256,274-293` |
| Remove `animate-pulse` from the 16 badge/dot/button sites; remove `animate-bounce` | listed in A4 |
| Replace `CountUp` with the plain value | `Dashboard.jsx` ×10, `Landing.jsx` ×4 |
| Remove `select-none` from all 11 page roots | listed in A16 |
| Add `prefers-reduced-motion` global block | `index.css` |
| Fix `lg:pl-60` → `lg:pl-[260px]`, `z-45` → `z-20` | `ProtectedLayout.jsx:68`, `Sidebar.jsx:136` |
| Add `darkMode: 'class'` (stops the dark-mode leak in `KeywordApprovalModal`) | `tailwind.config.js` |

**Ships:** ~60% of the "childish" perception disappears in half a day with near-zero regression risk.

---
### Phase 1 — Design tokens & foundations (2 days)
- Rewrite `tailwind.config.js` per C1 (colors, `fontSize`, `borderRadius`, `boxShadow`, `darkMode:'class'`, `@tailwindcss/forms`).
- Define CSS custom properties for light + dark in `index.css`; add a `ThemeProvider` reading `localStorage` + `prefers-color-scheme`, toggle in the top bar.
- Self-host Inter (400/500/600 woff2); delete the `@import` (`index.css:1`) and the Outfit reference (`index.css:22`); single `<link rel="preload">` in `index.html:9`.
- Add the real `.skeleton` shimmer and `.focus-ring` utilities.
- **Codemod sweep** — mechanical find/replace across all JSX:
  - all 131 non-existent shades → nearest valid token
  - `font-black|font-extrabold|font-bold` → `font-semibold|font-medium|font-normal` by role
  - `rounded-3xl|rounded-[2.5rem]|rounded-2xl` → `rounded-lg`; `rounded-xl` → `rounded` (6px)
  - all 16 colored `shadow-[...]` + `shadow-2xl|xl` → `shadow-sm|md|lg`
  - all 37 `bg-gradient-*` → `bg-primary-600`
  - `text-[9px]|text-[10px]|text-[11px]` → `text-2xs|text-xs`; `text-md` → `text-base`
  - every `focus:outline-none` → `focus-ring`
- Install shadcn CLI (`tsx:false`), Radix, lucide-react, sonner, cva, tailwind-merge.

**Ships:** the app is visually enterprise-grade before a single component is rewritten.

---
### Phase 2 — Primitive component library (4 days)
Build/generate into `src/components/ui/`: `Button` `IconButton` `Input` `Textarea` `Select` `Checkbox` `Radio` `Switch` `Label` `FormField` `Badge` `Avatar` `Card` `Modal` `Drawer` `Dropdown` `Tooltip` `Tabs` `Toast` (sonner) `Pagination` `EmptyState` `Skeleton` `Alert` `SegmentedControl` `Table` primitives — each to the C4 spec, each with a props-only variant API via cva.
- Replace the **26 emoji** with lucide icons (a single `Icon` wrapper enforcing 14/16/20 sizes and `currentColor`).
- Replace all **11 `window.confirm`/`alert`** with `ConfirmDialog` + persistent error Toast.
- Delete the **7 copy-pasted toast blocks**; mount `<Toaster>` once in `ProtectedLayout`.

---
### Phase 3 — App shell (1.5 days)
- Rewrite `ProtectedLayout.jsx` to the C5 fixed shell (`h-screen`, independently scrolling panes).
- `TopBar` 48px: breadcrumb, global search (⌘K), sync status, notifications (Radix Popover), theme toggle, user menu.
- `Sidebar` 240/56px collapsible with persistence, `aria-current` on the active item, no gradient user card.
- `PageHeader` component (56px sticky) adopted by all pages — kills the 3 divergent page containers.
- Remove the Navbar scroll listener. Add a `cmdk` command palette (navigate, search, create task, sync).
- Route `/` → redirect; delete `Landing.jsx`.

---
### Phase 4 — DataTable + the two hot screens (5 days)
- Build a `DataTable` on TanStack Table v8: sticky sortable headers, row selection with indeterminate + shift-range, density toggle, column visibility, sticky actions column, URL-synced state, keyboard nav, skeleton/empty/error states, server pagination.
- **Rebuild `EmailInbox.jsx`** to D3 (table + reading-pane Drawer, real toolbar, URL filters, bulk bar). Move filtering/search/pagination to the API — stop shipping every email body to the client (`EmailInbox.jsx:345`).
- **Rebuild `TaskList.jsx`** to D4 (table + Task Drawer; keep Board and Calendar as secondary views, restyled).
- Add the keyboard model (`↑↓ Enter x a e /` + `⌘K`).

**This phase delivers the actual productivity win — ~2.4× rows on screen and bulk/keyboard workflows.**

---
### Phase 5 — Admin & directory screens (3 days)
`ManageUsers` · `ActivityLog` · `ClientList` on the shared `DataTable`. Route the admin sub-nav (`/admin/users` · `/admin/clients` · `/admin/activity`). **Merge the duplicate client-management surfaces** (`ClientList.jsx` vs `ManageUsers.jsx:484-560`). Add server pagination to the activity log.

---
### Phase 6 — Dashboard & Reports (3 days)
Rebuild `Dashboard.jsx` to D2 (KPI strip + "Needs attention" table + throughput chart + connections). Rebuild `Reports.jsx` to D7 on Recharts (lazy route), with URL-driven tabs and date range, and XLSX/PDF export. Delete the hand-rolled SVG chart code.

---
### Phase 7 — Auth, forms & accessibility hardening (2.5 days)
`Login` / `Register` / `ForgotPassword` / `Profile` / `KeywordApprovalModal` to D1 and D9. `htmlFor` + `aria-describedby` + `aria-invalid` on every field; inline validation everywhere. Full keyboard + screen-reader pass: focus traps, `aria-live` on toasts, `aria-sort` on headers, `aria-current` on nav, visible focus on 100% of interactive elements. Verify AA contrast on every token pair (`text-slate-400` on white is currently used ~90× and fails).

---

## Effort summary

| Phase | Scope | Effort |
|---|---|---|
| 0 | Kill the effects, fix the crash | **0.5 d** |
| 1 | Tokens, fonts, codemod sweep | **2 d** |
| 2 | Primitive component library | **4 d** |
| 3 | App shell | **1.5 d** |
| 4 | DataTable + Inbox + Tasks | **5 d** |
| 5 | Admin & directory screens | **3 d** |
| 6 | Dashboard & Reports | **3 d** |
| 7 | Auth, forms, a11y | **2.5 d** |
| | **Total** | **~21.5 working days (≈4.5 weeks)** |

**Fastest path to "this looks professional":** Phase 0 + Phase 1 = **2.5 days** and it removes the custom cursor, the 3D tilt, the blobs, the glow, the gradients, the count-ups, the emoji-adjacent chrome, the 900-weight type, the 40px radii, and the 131 broken color classes. Everything after that is structural quality — density, keyboard, bulk actions, accessibility — which is where the daily productivity actually lives.
