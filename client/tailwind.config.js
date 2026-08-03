import forms from '@tailwindcss/forms'

/** @type {import('tailwindcss').Config} */

/*
 * MailDesk / K M KOTHARI — enterprise design tokens.
 *
 * Two groups of colours live here:
 *
 *  1. SEMANTIC TOKENS (canvas / surface / subtle / muted / line / fg / primary /
 *     success / warning / danger / info).  These are CSS-variable driven so the
 *     same class works in light and dark mode.  New code MUST use these.
 *
 *  2. LEGACY SHADES.  The pre-refactor pages reference ~33 Tailwind shades that
 *     never existed (`indigo-150`, `slate-805`, ...) across ~128 call sites.
 *     They are defined here so those pages keep rendering while the page agents
 *     rebuild them.  DO NOT use them in new code — they will be deleted once
 *     every page has been migrated.
 */

/* Semantic colour helper: enables `bg-surface/80` opacity modifiers. */
const v = (name) => `rgb(var(${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* ---------- semantic surfaces ---------- */
        canvas: v('--bg-canvas'),
        surface: v('--bg-surface'),
        subtle: v('--bg-subtle'),
        muted: v('--bg-muted'),
        /* Floating panels ONLY (dialog/drawer/dropdown/popover/toast).
         * Light: same as surface. Dark: lighter than surface — elevation is
         * expressed as lightness there, not shadow. See index.css.       */
        elevated: {
          DEFAULT: v('--bg-elevated'),
          subtle: v('--bg-elevated-subtle'),
        },
        line: {
          DEFAULT: v('--border-default'),
          strong: v('--border-strong'),
          /* edge + internal dividers of floating panels — dark
           * --border-default is invisible (1.04:1) on --bg-elevated */
          overlay: v('--border-overlay'),
        },

        /* ---------- semantic text ---------- */
        fg: {
          DEFAULT: v('--text-primary'),
          2: v('--text-secondary'),
          3: v('--text-tertiary'),
          off: v('--text-disabled'),
          inverse: v('--text-inverse'),
        },

        /* ---------- brand ---------- */
        primary: {
          50: v('--primary-50'),
          100: v('--primary-100'),
          200: v('--primary-200'),
          500: v('--primary-500'),
          600: v('--primary-600'),
          700: v('--primary-700'),
          800: v('--primary-800'),
          DEFAULT: v('--primary-600'),
          fg: v('--primary-fg'),
          subtle: v('--primary-subtle'),
          border: v('--primary-border'),
          text: v('--primary-text'),
        },

        /* ---------- semantic status ---------- */
        success: {
          DEFAULT: v('--success'),
          subtle: v('--success-bg'),
          border: v('--success-border'),
          text: v('--success-text'),
        },
        warning: {
          DEFAULT: v('--warning'),
          subtle: v('--warning-bg'),
          border: v('--warning-border'),
          text: v('--warning-text'),
        },
        danger: {
          DEFAULT: v('--danger'),
          subtle: v('--danger-bg'),
          border: v('--danger-border'),
          text: v('--danger-text'),
        },
        info: {
          DEFAULT: v('--info'),
          subtle: v('--info-bg'),
          border: v('--info-border'),
          text: v('--info-text'),
        },
        neutral: {
          DEFAULT: v('--neutral'),
          subtle: v('--neutral-bg'),
          border: v('--neutral-border'),
          text: v('--neutral-text'),
        },

        /* ---------- categorical chart palette ----------
         * CSS-variable driven like every other token, so the set can be tuned
         * per theme (dark mode lifts each hue off the #0B1220 canvas). The
         * class names are unchanged — `text-chart-3`, `bg-chart-3`,
         * `fill-chart-3`, `stroke-chart-3` — and opacity modifiers such as
         * `bg-chart-3/20` now work too. Values live in src/index.css. */
        chart: {
          1: v('--chart-1'),
          2: v('--chart-2'),
          3: v('--chart-3'),
          4: v('--chart-4'),
          5: v('--chart-5'),
          6: v('--chart-6'),
        },

        /* =========================================================
         * LEGACY SHADES — transitional only. See header note.
         * ======================================================= */
        slate: {
          55: '#f6f9fb',
          105: '#eef3f8',
          150: '#eaeff5',
          250: '#d7dfe8',
          350: '#b0bcca',
          405: '#8fa0b3',
          450: '#8494a7',
          455: '#8290a3',
          550: '#566379',
          605: '#445265',
          650: '#3d4a5c',
          655: '#3b4859',
          750: '#293548',
          755: '#273244',
          805: '#1c2738',
          850: '#172033',
          855: '#151e30',
        },
        indigo: {
          150: '#dbe2fe',
          505: '#6262f0',
          550: '#5a56ea',
          650: '#4338ca',
        },
        red: {
          150: '#fed6d6',
          550: '#e63535',
          650: '#ca2121',
          655: '#c72020',
        },
        emerald: {
          55: '#ecfdf5',
          150: '#bcf6da',
          250: '#8bedc4',
          650: '#058760',
        },
        amber: {
          150: '#fdedaa',
          250: '#fddc6c',
          950: '#451a03',
        },
        purple: {
          650: '#892bdc',
        },
      },

      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Helvetica Neue', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },

      /* 11 / 12 / 13 / 14 / 16 / 18 / 20 / 24 with fixed line heights.
       * `md` is added deliberately — `text-md` is used 5x in legacy pages and
       * emits nothing in stock Tailwind. */
      fontSize: {
        '2xs': ['11px', { lineHeight: '16px' }],
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['13px', { lineHeight: '18px' }],
        base: ['14px', { lineHeight: '20px' }],
        md: ['16px', { lineHeight: '24px' }],
        lg: ['18px', { lineHeight: '26px' }],
        xl: ['20px', { lineHeight: '28px' }],
        '2xl': ['24px', { lineHeight: '32px' }],
        '3xl': ['28px', { lineHeight: '36px' }],
        '4xl': ['32px', { lineHeight: '40px' }],
      },

      /* Controls 6 - cards 8 - modals 10.  2xl/3xl are toned-down aliases kept
       * only so legacy pages do not render with square corners mid-migration. */
      borderRadius: {
        xs: '2px',
        sm: '4px',
        DEFAULT: '6px',
        md: '6px',
        lg: '8px',
        xl: '10px',
        '2xl': '12px',
        '3xl': '14px',
      },

      /* Neutral only. No colored shadows, no glow. */
      boxShadow: {
        '2xs': '0 1px 1px 0 rgb(15 23 42 / 0.03)',
        xs: '0 1px 2px 0 rgb(15 23 42 / 0.04)',
        sm: '0 1px 3px 0 rgb(15 23 42 / 0.06), 0 1px 2px -1px rgb(15 23 42 / 0.04)',
        DEFAULT: '0 1px 3px 0 rgb(15 23 42 / 0.06), 0 1px 2px -1px rgb(15 23 42 / 0.04)',
        md: '0 4px 12px -2px rgb(15 23 42 / 0.10), 0 2px 4px -2px rgb(15 23 42 / 0.06)',
        lg: '0 16px 40px -8px rgb(15 23 42 / 0.18)',
        /* legacy aliases — flattened onto the neutral scale */
        xl: '0 16px 40px -8px rgb(15 23 42 / 0.18)',
        '2xl': '0 16px 40px -8px rgb(15 23 42 / 0.18)',
        none: 'none',
      },

      spacing: {
        topbar: '48px',
        sidebar: '240px',
        'sidebar-collapsed': '56px',
      },

      zIndex: {
        // Dropdown/popover/select content portals to <body>, so when its
        // trigger lives inside a Dialog or Drawer (z-modal 60) it must paint
        // ABOVE the modal — at 40 it painted behind it (EmailInbox's dialog
        // SelectMenu, TaskList's drawer overflow menu were invisible). Radix
        // closes these on any outside interaction, so a page-level menu never
        // outlives a modal opening beneath it.
        dropdown: '65',
        sticky: '30',
        sidebar: '20',
        drawer: '50',
        // The scrim behind a modal/drawer. MUST sit below `modal`, which every
        // Dialog and Drawer content uses. Previously the overlay used `modal`
        // (60) while Drawer content used `drawer` (50), so the scrim painted on
        // top of its own drawer: the panel was visible but dimmed and every
        // click was swallowed. Dialog only escaped it because its overlay and
        // content shared a z-index and DOM order broke the tie — correct by
        // accident. Making the two layers explicitly different removes the
        // dependence on paint order.
        overlay: '55',
        modal: '60',
        toast: '70',
        tooltip: '80',
        45: '45',
      },

      transitionDuration: {
        DEFAULT: '150ms',
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-4px)' },
          '40%, 80%': { transform: 'translateX(4px)' },
        },
        'dialog-in': {
          from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.98)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'dialog-out': {
          from: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
          to: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.98)' },
        },
        'overlay-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'overlay-out': { from: { opacity: '1' }, to: { opacity: '0' } },
      },
      animation: {
        'fade-in': 'fade-in 150ms cubic-bezier(0.16,1,0.3,1)',
        'slide-in': 'slide-in 150ms cubic-bezier(0.16,1,0.3,1)',
        'slide-in-right': 'slide-in-right 200ms cubic-bezier(0.16,1,0.3,1)',
        shake: 'shake 300ms ease-in-out',
        'dialog-in': 'dialog-in 150ms cubic-bezier(0.16,1,0.3,1)',
        'dialog-out': 'dialog-out 120ms ease-in',
        'overlay-in': 'overlay-in 150ms ease-out',
        'overlay-out': 'overlay-out 120ms ease-in',
      },
    },
  },
  plugins: [forms({ strategy: 'class' })],
}
