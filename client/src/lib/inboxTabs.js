/*
 * The category tabs.
 *
 * `?category=` used to be sent and never read, so Sent, Promotions, Social,
 * Updates and Spam all showed the Inbox — byte-identical rows, still labelled
 * "Received", still counting 1,397. Five of the six tabs lied.
 *
 * The endpoint honours the parameter now, which exposes the second half of the
 * problem: this workspace's ingestion never captured Gmail's category labels,
 * so promotions/social/updates/spam are genuinely empty. Rendering four tabs
 * that can only ever be empty is its own kind of lie, so the strip is built
 * from `GET /api/gmail/categories` — real totals, and a category is only shown
 * when it holds something (or is the one being looked at, so a bookmarked
 * `?tab=spam` still resolves).
 */
export const TABS = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'sent', label: 'Sent' },
  { value: 'promotions', label: 'Promotions' },
  { value: 'social', label: 'Social' },
  { value: 'updates', label: 'Updates' },
  { value: 'spam', label: 'Spam' },
]
export const TAB_VALUES = TABS.map((t) => t.value)

/** Always offered, whatever their count: they are how mail is read and sent. */
const CORE_TABS = ['inbox', 'sent']

/**
 * @param {Array<{name: string, label?: string, total?: number}>|null} categories
 *   the server's list, or null while it is unknown
 * @param {string} active the tab on screen
 * @returns {Array<{value: string, label: string, total: number|null}>}
 */
export function visibleTabs(categories, active) {
  if (!Array.isArray(categories) || categories.length === 0) {
    // Unknown: fall back to the full strip rather than hiding tabs that may
    // well have mail in them.
    return TABS.map((t) => ({ ...t, total: null }))
  }
  const known = new Map(TABS.map((t) => [t.value, t.label]))
  return categories
    .filter((c) => c && known.has(c.name))
    .map((c) => ({
      value: c.name,
      label: c.label || known.get(c.name),
      total: Number.isFinite(c.total) ? c.total : null,
    }))
    .filter((t) => CORE_TABS.includes(t.value) || t.value === active || (t.total ?? 0) > 0)
}
