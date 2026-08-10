# List-endpoint contract (pagination / sort / filter)

Authored by the orchestrator before Wave 2 so the server and the page rewrites,
which are built concurrently by different agents, converge on one shape.

**This document is normative. Both sides implement exactly this.**

## Request

All list endpoints accept:

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | int ≥ 1 | `1` | 1-indexed |
| `limit` | int 1–100 | `25` | Clamp server-side. Values above 100 clamp to 100, never error |
| `sort` | string | per-endpoint | Field name, `-` prefix for descending (e.g. `-createdAt`). Whitelist server-side; an unknown field falls back to the default rather than erroring |
| `q` | string | — | Free-text search, endpoint-defined fields |

Endpoint-specific filters (`status`, `priority`, `role`, `assignedTo`,
`clientName`, `accountEmail`, …) are additive.

### Actor filter on `/api/users/activity-logs` — SETTLED (gap S-3)

The parameter name was unspecified, so the Admin page sends **both** `userId`
and `actor`. Resolved server-side:

| Param | Status |
|---|---|
| `userId` | **Canonical.** A 24-hex ObjectId. Anything else is ignored, not an error |
| `actor` | **Accepted alias**, identical semantics. Used only when `userId` is absent or malformed |

Sending both is safe and is what the client does today; `userId` wins. New
clients should send `userId` only.

`/api/users/activity-logs` also accepts `targetType`, `targetId`, `action`, and
`dateFrom`/`dateTo`, all indexed. `q` searches `action`, `details`,
`targetLabel` and `ip`.

### Read filter on `/api/gmail/emails` (gap S-16)

| Param | Values | Meaning |
|---|---|---|
| `read` | `true` \| `false` | Read state **for the requesting user**. Omit for all |

Every email in a list or detail response carries a derived **`isRead`** boolean
(and `readAt`) computed for the caller — read state is a per-user relation on a
shared mailbox, never a flat flag on the document.

### Date range — `dateFrom` / `dateTo` (CORRECTED)

Earlier revisions of this document listed the range as `from`/`to`. That was
ambiguous: on `/api/gmail/emails`, `from` is also the *sender* field. The date
range is therefore **`dateFrom` and `dateTo`** (inclusive, ISO-8601) on every
endpoint, and `from` on the email endpoint means sender only.

Both the EmailInbox page and the server must use `dateFrom`/`dateTo`.

**Implemented.** `/api/gmail/emails` now reads `dateFrom`/`dateTo` for the range
and treats **`from` as the sender** (case-insensitive substring). For
compatibility with anything still sending the old spelling, a `from`/`to` value
that *parses as a date* is still accepted as a range bound when no
`dateFrom`/`dateTo` was supplied; a `from` that is not a date is a sender
filter. Send `dateFrom`/`dateTo` and the ambiguity never arises.

## Response — paginated form

Returned **when `page` is present in the query string**:

```json
{
  "data": [ /* array of resources */ ],
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 1284,
    "totalPages": 52,
    "hasMore": true
  }
}
```

## Response — legacy form

Returned when `page` is **absent**, so any not-yet-migrated caller keeps working:

- the endpoint's existing legacy shape (bare array, or `{success, data}` where
  that is already the contract), and
- **a hard server-side cap of 200 documents**, because the real defect is that
  these endpoints were unbounded — not that they lacked a page parameter.

Legacy mode is a migration shim. Once every caller sends `page`, delete it.

## Rules

1. **Never return `Email.body` in a list response.** `body` is `select: false`;
   list responses carry a `snippet` only. Bodies come from the detail endpoint.
2. Counts (`total`) use `countDocuments` with the same filter, run in parallel
   with the page query via `Promise.all`.
3. Every sortable/filterable field must be indexed, including the compound
   (filter + sort) pairs — otherwise sorting forces an in-memory sort.
4. All list reads use `.lean()`.
5. Cursor pagination is preferable for the inbox at very large N, but offset is
   what this contract specifies; the client only reads `pagination`, so a later
   swap to cursors is not a client-visible change.

## Error responses — normative (audit M-13)

Every 4xx the API produces carries the same envelope, whether or not the route
is Zod-validated:

```json
{
  "message": "Check these fields: title, client name, assigned to, deadline.",
  "errors": [
    { "path": "title",      "message": "Invalid input: expected string, received undefined" },
    { "path": "clientName", "message": "Invalid input: expected string, received undefined" }
  ]
}
```

- `message` is the headline, and is what a toast should show. For a **single**
  field error it is that field's own message. For **several** it names the
  fields ("Check these fields: …") instead of leading with Zod's wire-format
  complaint, which named none of them.
- `errors[]` is `{ path, message }` per field, `path` being the dotted body
  path. It is present on validation failures, on duplicate-key conflicts
  (`email`, `name`), and on the hand-rolled 400s in the controllers. It may be
  empty, never absent, on a 4xx that is genuinely not about a field.
- Endpoints that already sent `success: false` still send it. Nothing was
  removed from any error body; `errors[]` is additive.
- 5xx bodies are `{ message }` only, and the message is always generic — a 5xx
  must never carry a driver or JS error string (audit H-9).

Client contract: attach `errors[i].message` to the input named by
`errors[i].path`, and fall back to `message` when there is no match.
`client/src/api/axios.js` already passes a 400 payload through untouched.

## Endpoints in scope

`/api/gmail/emails` · `/api/tasks` · `/api/clients` · `/api/users` ·
`/api/users/activity-logs` · `/api/notifications` · `/api/keyword-rules` ·
`/api/keyword-rules/pending-emails` · task comments
