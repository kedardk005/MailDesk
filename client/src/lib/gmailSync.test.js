/**
 * The sync toast and the category strip — the two places the inbox told the
 * user something that was not true.
 *
 * H-1: "Sync now" showed a green tick and "Inbox is already up to date" while
 * every mailbox was answering `invalid_grant`. H-3: five of the six category
 * tabs showed the Inbox and its count.
 */
import { describe, expect, it } from 'vitest'

import { describeSyncResult, failedInboxes, syncAddedMail } from './gmailSync'
import { visibleTabs } from './inboxTabs'

describe('describeSyncResult', () => {
  it('never reports success for a sync that failed', () => {
    const out = describeSyncResult({
      syncStatus: 'failed',
      count: null,
      message: 'Could not sync ops@kmk-demo.test — reconnect the mailbox.',
      accounts: [{ inbox: 'ops@kmk-demo.test', ok: false, errorCode: 'REAUTH_REQUIRED' }],
    })

    expect(out.tone).not.toBe('success')
    expect(out.title).not.toMatch(/up to date/i)
    expect(out.description).toMatch(/reconnect/i)
  })

  it('names the mailboxes that failed on a partial sync', () => {
    const out = describeSyncResult({
      syncStatus: 'partial',
      count: 4,
      accounts: [
        { inbox: 'sales@kmk-demo.test', ok: true },
        { inbox: 'billing@kmk-demo.test', ok: false },
      ],
    })

    expect(out.tone).toBe('warning')
    expect(out.title).toContain('billing@kmk-demo.test')
    expect(out.description).toContain('4 new emails')
  })

  it('says nothing about freshness while the outcome is still unknown', () => {
    /* The 202-and-forget case: the job outran the inline wait. This is exactly
     * the state the old toast rendered as a green "already up to date". */
    const out = describeSyncResult({ status: 'queued', syncStatus: null, count: null })

    expect(out.tone).toBe('info')
    expect(out.title).not.toMatch(/up to date/i)
  })

  it('only says "up to date" when the server confirmed every mailbox synced', () => {
    expect(describeSyncResult({ syncStatus: 'ok', count: 0 })).toMatchObject({
      tone: 'success',
      title: 'Inbox is already up to date',
    })
    expect(describeSyncResult({ syncStatus: 'ok', count: 12 })).toMatchObject({
      tone: 'success',
      title: 'Synced 12 new emails',
    })
  })

  it('distinguishes "nothing connected" from "nothing new"', () => {
    expect(describeSyncResult({ syncStatus: 'no_accounts', count: null }).title).toMatch(
      /no mailbox is connected/i
    )
  })

  it('treats a missing body as unknown, not as success', () => {
    expect(describeSyncResult(undefined).tone).toBe('info')
    expect(describeSyncResult(null).title).not.toMatch(/up to date/i)
  })
})

describe('failedInboxes / syncAddedMail', () => {
  it('lists only the accounts the server marked failed', () => {
    expect(
      failedInboxes({ accounts: [{ inbox: 'a', ok: true }, { inbox: 'b', ok: false }] })
    ).toEqual(['b'])
    expect(failedInboxes({})).toEqual([])
  })

  it('reports new mail only on a confirmed outcome', () => {
    expect(syncAddedMail({ syncStatus: 'ok', count: 3 })).toBe(true)
    expect(syncAddedMail({ syncStatus: 'ok', count: 0 })).toBe(false)
    expect(syncAddedMail({ syncStatus: 'failed', count: null })).toBe(false)
    expect(syncAddedMail({ count: 3 })).toBe(false)
  })
})

describe('visibleTabs', () => {
  const cats = [
    { name: 'inbox', label: 'Inbox', total: 1397 },
    { name: 'sent', label: 'Sent', total: 599 },
    { name: 'promotions', label: 'Promotions', total: 0 },
    { name: 'social', label: 'Social', total: 0 },
    { name: 'updates', label: 'Updates', total: 0 },
    { name: 'spam', label: 'Spam', total: 0 },
  ]

  it('shows real totals instead of repeating the inbox count on every tab', () => {
    const tabs = visibleTabs(cats, 'inbox')
    expect(tabs.find((t) => t.value === 'sent')).toMatchObject({ total: 599 })
    expect(tabs.find((t) => t.value === 'inbox')).toMatchObject({ total: 1397 })
  })

  it('drops categories that hold nothing, so no tab can look broken', () => {
    expect(visibleTabs(cats, 'inbox').map((t) => t.value)).toEqual(['inbox', 'sent'])
  })

  it('keeps a bookmarked empty category reachable', () => {
    expect(visibleTabs(cats, 'spam').map((t) => t.value)).toEqual(['inbox', 'sent', 'spam'])
  })

  it('shows a category as soon as it holds anything', () => {
    const withPromos = cats.map((c) => (c.name === 'promotions' ? { ...c, total: 12 } : c))
    expect(visibleTabs(withPromos, 'inbox').map((t) => t.value)).toEqual([
      'inbox',
      'sent',
      'promotions',
    ])
  })

  it('falls back to the full strip when the server did not answer', () => {
    /* Hiding a tab because a request failed would lose mail from the UI. */
    const tabs = visibleTabs(null, 'inbox')
    expect(tabs).toHaveLength(6)
    expect(tabs.every((t) => t.total === null)).toBe(true)
  })
})
