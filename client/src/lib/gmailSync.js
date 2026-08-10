/**
 * How to report the outcome of `POST /api/gmail/fetch`.
 *
 * This is the client half of the worst defect in the pre-deployment audit
 * (H-1). The endpoint used to answer 202 the moment the job was enqueued, and
 * the inbox rendered that as a green tick and **"Inbox is already up to
 * date"** — while every one of the four seeded mailboxes was answering
 * `invalid_grant` about 450 ms later. Mail silently stopped arriving and the
 * app actively reassured the user it had not.
 *
 * The server now reports the real outcome inline: `syncStatus`
 * (`ok` | `partial` | `failed` | `no_accounts`), a per-mailbox `accounts[]`,
 * and a `count` that is **null, never 0**, whenever the outcome is unknown or
 * bad. A total failure comes back as 502, so it throws before reaching here.
 *
 * The rule this module exists to enforce: **a success toast requires evidence
 * of success.** An absent or null `syncStatus` is not evidence — it means the
 * job outran the inline wait and nobody knows yet.
 */

/**
 * @param {object|null|undefined} data - the response body
 * @returns {{tone: 'success'|'warning'|'info', title: string, description?: string}}
 */
export function describeSyncResult(data) {
  const status = data?.syncStatus ?? null
  const count = Number.isFinite(data?.count) ? data.count : null
  const failing = failedInboxes(data)

  if (status === 'failed') {
    return {
      tone: 'warning',
      title: 'Mail did not sync',
      description:
        data?.message ||
        (failing.length > 0
          ? `Reconnect ${failing.join(', ')} on your profile.`
          : 'Reconnect the mailbox on your profile.'),
    }
  }

  if (status === 'partial') {
    return {
      tone: 'warning',
      title:
        failing.length === 1
          ? `${failing[0]} did not sync`
          : `${failing.length} mailboxes did not sync`,
      description:
        count && count > 0
          ? `${count} new email${count === 1 ? '' : 's'} arrived from the rest. Reconnect the others on your profile.`
          : 'Reconnect them on your profile.',
    }
  }

  if (status === 'no_accounts') {
    return {
      tone: 'info',
      title: 'No mailbox is connected',
      description: 'Connect a Gmail account before syncing.',
    }
  }

  if (status === 'ok') {
    return count && count > 0
      ? { tone: 'success', title: `Synced ${count} new email${count === 1 ? '' : 's'}` }
      : { tone: 'success', title: 'Inbox is already up to date' }
  }

  /* No status at all: the job is still running (it outran the inline wait), or
   * this is a server that predates the outcome fields. Either way nothing here
   * knows whether any mail arrived, and "up to date" would be a guess. */
  return {
    tone: 'info',
    title: 'Sync started',
    description: 'Checking the connected mailboxes — this page will update itself.',
  }
}

/** Mailboxes the server reported as failing, if it reported any. */
export function failedInboxes(data) {
  const accounts = Array.isArray(data?.accounts) ? data.accounts : []
  return accounts.filter((a) => a && a.ok === false).map((a) => a.inbox).filter(Boolean)
}

/** True only when the server said mail actually arrived. */
export function syncAddedMail(data) {
  return data?.syncStatus === 'ok' || data?.syncStatus === 'partial'
    ? Number.isFinite(data?.count) && data.count > 0
    : false
}
