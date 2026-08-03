import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Conditional className joiner with Tailwind conflict resolution.
 * `cn('px-2 py-1', condition && 'px-4')` -> 'py-1 px-4'
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

/** Initials for an avatar fallback. Always returns 1–2 uppercase characters. */
export function initials(name) {
  if (!name || typeof name !== 'string') return 'U'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'U'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Locale-formatted integer with grouping. Replaces the count-up animation. */
export function formatNumber(value, options) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat(undefined, options).format(n)
}

/** Short relative time ("Just now", "12m ago", "3h ago", "5d ago"). */
export function timeAgo(input) {
  if (!input) return ''
  const past = new Date(input)
  if (Number.isNaN(past.getTime())) return ''
  const secs = Math.floor((Date.now() - past.getTime()) / 1000)
  if (secs < 60) return 'Just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return past.toLocaleDateString()
}

/** Deterministic index into an n-length palette, from any string key. */
export function hashIndex(key, buckets) {
  const s = String(key || '')
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h) % Math.max(1, buckets)
}

/**
 * Humanise a duration given in MINUTES, e.g. 130 -> "2h 10m".
 *
 * Returns `null` — not "0m" — for null/undefined/negative/non-finite input.
 * The SLA endpoints deliberately distinguish "no conversations measured"
 * (`median: null`) from "answered instantly" (`median: 0`), and collapsing the
 * two would report a team with no data as perfectly responsive.
 *
 * Callers render the null case themselves ("No reply sent yet", "—").
 *
 * @param {Number|null|undefined} value Duration in minutes
 * @returns {String|null}
 */
export function formatDurationMinutes(value) {
  if (value === null || value === undefined) return null
  const total = Number(value)
  if (!Number.isFinite(total) || total < 0) return null
  const whole = Math.round(total)
  const days = Math.floor(whole / 1440)
  const hours = Math.floor((whole % 1440) / 60)
  const minutes = whole % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}
