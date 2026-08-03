/**
 * Default MSW handlers — a plausible, empty-but-valid API.
 *
 * The shapes come from `docs/audits/API-LIST-CONTRACT.md`: a list endpoint
 * answers `{ data, pagination }` whenever `page` is present, and pagination is
 * `{ page, limit, total, totalPages, hasMore }`.
 *
 * These are deliberately boring. A test that cares about a payload overrides
 * the one route it cares about with `server.use(...)`; everything else stays
 * mocked so that `onUnhandledRequest: 'error'` can catch a real network escape.
 */
import { http, HttpResponse } from 'msw'

export const API = 'http://localhost:5015/api'

/** Build the paginated envelope the pages read. */
export function listResponse(rows, { page = 1, limit = 25, total } = {}) {
  const count = total ?? rows.length
  return {
    data: rows,
    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
      hasMore: page * limit < count,
    },
  }
}

export const TEST_USER = {
  _id: 'u-admin',
  name: 'Asha Rao',
  email: 'asha@example.com',
  role: 'Admin',
  status: 'Approved',
}

export const TEST_TOKEN = 'test.jwt.token'

const emptyList = () => HttpResponse.json(listResponse([]))

export const handlers = [
  /* ---- auth ------------------------------------------------------------ */
  http.post(`${API}/auth/login`, () =>
    HttpResponse.json({ token: TEST_TOKEN, user: TEST_USER })
  ),
  http.post(`${API}/auth/register`, () =>
    HttpResponse.json(
      { message: 'Registration submitted for approval.', user: TEST_USER },
      { status: 201 }
    )
  ),
  http.post(`${API}/auth/forgot-password`, () =>
    HttpResponse.json({ message: 'If an account with this email exists, a link has been sent.' })
  ),
  http.post(`${API}/auth/reset-password`, () =>
    HttpResponse.json({ message: 'Password reset successfully.' })
  ),
  http.get(`${API}/auth/me`, () => HttpResponse.json({ user: TEST_USER })),

  /* ---- tasks ----------------------------------------------------------- */
  http.get(`${API}/tasks/clients`, () => HttpResponse.json({ success: true, data: [] })),
  http.get(`${API}/tasks/:id/comments`, () => emptyList()),
  http.get(`${API}/tasks/:id`, ({ params }) =>
    HttpResponse.json({ data: { _id: params.id, title: 'A task', status: 'Pending' } })
  ),
  http.get(`${API}/tasks`, () => emptyList()),
  http.post(`${API}/tasks/bulk`, () => HttpResponse.json({ success: true, modified: 0 })),
  http.post(`${API}/tasks`, () => HttpResponse.json({ success: true, data: {} }, { status: 201 })),
  http.put(`${API}/tasks/:id`, () => HttpResponse.json({ success: true, data: {} })),
  http.delete(`${API}/tasks/:id`, () => HttpResponse.json({ success: true })),

  /* ---- gmail ----------------------------------------------------------- */
  http.get(`${API}/gmail/status`, () =>
    HttpResponse.json({ connected: true, gmailEmail: 'office@example.com', linkedAccounts: [] })
  ),
  http.get(`${API}/gmail/auth-url`, () => HttpResponse.json({ url: 'https://accounts.example/oauth' })),
  http.get(`${API}/gmail/emails/:id/attachments/:attachmentId`, () =>
    HttpResponse.json({ data: '', filename: 'a.pdf', mimeType: 'application/pdf' })
  ),
  http.get(`${API}/gmail/emails/:id`, ({ params }) =>
    HttpResponse.json({ data: { _id: params.id, subject: 'Hello', body: '<p>Hi</p>' } })
  ),
  http.get(`${API}/gmail/emails`, () => emptyList()),
  http.post(`${API}/gmail/fetch`, () => HttpResponse.json({ count: 0 })),
  http.post(`${API}/gmail/emails/bulk-assign`, () => HttpResponse.json({ taskIds: [] })),
  http.post(`${API}/gmail/emails/:id/reply`, () => HttpResponse.json({ success: true })),
  http.delete(`${API}/gmail/emails/:id`, () => HttpResponse.json({ success: true })),
  http.delete(`${API}/gmail/emails`, () => HttpResponse.json({ deleted: 0, results: [] })),

  /* Gap S-16: read state is a per-user relation, so responses echo the derived
   * `isRead`/`readAt` for the caller rather than a flat flag. */
  http.patch(`${API}/gmail/emails/read`, async ({ request }) => {
    const { ids = [], read = true } = await request.json()
    return HttpResponse.json({
      updated: ids.length,
      results: ids.map((id) => ({ id, ok: true, isRead: read })),
    })
  }),
  http.patch(`${API}/gmail/emails/:id/read`, async ({ params, request }) => {
    const { read = true } = await request.json().catch(() => ({}))
    return HttpResponse.json({ _id: params.id, isRead: read, readAt: read ? new Date(0).toISOString() : null })
  }),
  http.delete(`${API}/gmail/linked-account`, () => HttpResponse.json({ success: true })),
  http.delete(`${API}/gmail/disconnect`, () => HttpResponse.json({ success: true })),

  /* ---- F-1 threads ------------------------------------------------------
   * ORDER MATTERS: MSW matches in registration order, so `/threads/:threadId`
   * must precede `/threads` or the list handler swallows the detail request. */
  http.get(`${API}/gmail/threads/:threadId`, ({ params }) =>
    HttpResponse.json({
      threadId: params.threadId,
      subject: 'A conversation',
      participants: [],
      accountEmail: 'office@example.com',
      clientId: null,
      messageCount: 0,
      inboundCount: 0,
      outboundCount: 0,
      unreadCount: 0,
      firstMessageAt: null,
      lastMessageAt: null,
      firstInboundAt: null,
      lastInboundAt: null,
      firstOutboundAt: null,
      lastOutboundAt: null,
      lastDirection: 'inbound',
      hasUnansweredInbound: false,
      firstResponseAt: null,
      firstResponseMinutes: null,
      truncated: false,
      messages: [],
    })
  ),
  http.get(`${API}/gmail/threads`, () => emptyList()),

  /* ---- users ----------------------------------------------------------- */
  http.get(`${API}/users/activity-logs`, () => emptyList()),
  http.get(`${API}/users`, () => emptyList()),
  http.post(`${API}/users`, () => HttpResponse.json({ success: true }, { status: 201 })),
  /* Gap S-7: this endpoint returns the user document DIRECTLY (the GET
   * /auth/me shape), not `{ user }`. The page used to carry a defensive merge
   * that hid the mismatch; it was removed when S-7 landed, so the mock has to
   * be accurate now. */
  http.put(`${API}/users/profile`, () => HttpResponse.json(TEST_USER)),

  /* Gap S-6: returns a replacement token so changing your own password no
   * longer signs you out. Other sessions stay revoked. */
  http.put(`${API}/users/change-password`, () =>
    HttpResponse.json({ message: 'Password updated.', token: TEST_TOKEN, user: TEST_USER })
  ),

  /* Gap S-12: notification preferences. `events` is served by the API rather
   * than hard-coded in the page, so the fixture must supply it. */
  http.get(`${API}/users/notification-preferences`, () =>
    HttpResponse.json({
      inApp: true,
      email: true,
      events: [
        { type: 'task_assigned', label: 'Task assigned', inApp: true, email: true },
        { type: 'task_completed', label: 'Task completed', inApp: true, email: true },
        { type: 'task_overdue', label: 'Task overdue', inApp: true, email: true },
        { type: 'system', label: 'System', inApp: true, email: true },
      ],
      quietHours: { enabled: false, start: '20:00', end: '08:00', timezone: 'Asia/Kolkata' },
    })
  ),
  http.put(`${API}/users/notification-preferences`, async ({ request }) =>
    HttpResponse.json(await request.json())
  ),
  http.put(`${API}/users/:id`, () => HttpResponse.json({ success: true })),
  http.delete(`${API}/users/:id`, () => HttpResponse.json({ success: true })),

  /* ---- clients --------------------------------------------------------- */
  http.get(`${API}/clients`, () => emptyList()),
  /* Gap S-10: per-client timeline the detail drawer now consumes. */
  http.get(`${API}/clients/:id/timeline`, () => HttpResponse.json({ data: [] })),
  http.post(`${API}/clients`, () => HttpResponse.json({ success: true }, { status: 201 })),
  http.put(`${API}/clients/:id`, () => HttpResponse.json({ success: true })),
  http.delete(`${API}/clients/:id`, () => HttpResponse.json({ success: true })),

  /* ---- notifications --------------------------------------------------- */
  http.get(`${API}/notifications`, () => emptyList()),
  http.put(`${API}/notifications/read-all`, () => HttpResponse.json({ success: true })),
  http.put(`${API}/notifications/:id/read`, () => HttpResponse.json({ success: true })),

  /* ---- keyword rules --------------------------------------------------- */
  http.get(`${API}/keyword-rules/pending-approvals`, () => emptyList()),
  http.get(`${API}/keyword-rules/pending-emails`, () => emptyList()),
  http.get(`${API}/keyword-rules`, () => emptyList()),
  http.post(`${API}/keyword-rules/bulk-approve`, () => HttpResponse.json({ approved: 0 })),
  http.post(`${API}/keyword-rules/approve-email/:id`, () => HttpResponse.json({ success: true })),
  http.post(`${API}/keyword-rules`, () => HttpResponse.json({ success: true }, { status: 201 })),
  http.delete(`${API}/keyword-rules/:id`, () => HttpResponse.json({ success: true })),

  /* ---- reports / ai ---------------------------------------------------- */
  http.get(`${API}/reports/overall`, () =>
    HttpResponse.json({
      totalTasks: 0,
      completedTasks: 0,
      pendingTasks: 0,
      lateTasks: 0,
      totalEmails: 0,
      totalClients: 0,
      totalUsers: 0,
      employeeStats: [],
    })
  ),
  http.get(`${API}/reports/timeline`, () => HttpResponse.json({ data: [] })),
  http.get(`${API}/reports/email-timeline`, () => HttpResponse.json({ data: [] })),
  http.get(`${API}/reports/employee`, () => HttpResponse.json({ data: [] })),
  http.get(`${API}/reports/client-stats`, () => HttpResponse.json({ data: [] })),
  http.post(`${API}/ai/summarize-email`, () => HttpResponse.json({ summary: 'A summary.' })),

  /* ---- F-3 action extraction --------------------------------------------
   * ORDER MATTERS, same rule as the thread and SLA routes: the `:jobId` poll
   * route is registered before the bare `/ai/extract-actions` sibling.
   *
   * The default POST answers 200 with an EMPTY action list rather than a
   * plausible one. A fixture that always produced suggestions would let a page
   * that never renders the "nothing was found" branch pass; a test that cares
   * about the panel overrides this one route with `server.use(...)`.
   *
   * The 202 -> poll path is deliberately NOT the default. It is a real branch
   * of the contract, so a test that exercises it overrides both routes and
   * asserts the polling itself. */
  http.get(`${API}/ai/extract-actions/:jobId`, ({ params }) =>
    HttpResponse.json({
      jobId: params.jobId,
      status: 'completed',
      actions: [],
      suggestedClient: null,
      model: 'gemini-2.5-flash',
      cached: false,
      error: null,
    })
  ),
  /* `confidence` defaults to 0 — never 1 — when the model omits it, so a
   * fixture must never imply certainty the server would not have produced. */
  http.post(`${API}/ai/extract-actions`, () =>
    HttpResponse.json({
      actions: [],
      suggestedClient: null,
      model: 'gemini-2.5-flash',
      cached: false,
    })
  ),

  /* ---- F-2 SLA ----------------------------------------------------------
   * Again order-sensitive: the two `/reports/sla/*` routes must precede the
   * bare `/reports/sla` one.
   *
   * Note `median`/`p90` are null rather than 0 in the empty case — the server
   * distinguishes "no conversations measured" from "answered instantly", and a
   * fixture that returned 0 would let a page that conflates them pass. */
  http.get(`${API}/reports/sla/timeseries`, () =>
    HttpResponse.json({ range: {}, scope: 'all', unit: 'minutes', buckets: [], generatedAt: '' })
  ),
  http.get(`${API}/reports/sla/policy`, () =>
    HttpResponse.json({
      default: {
        scope: 'global',
        client: null,
        firstResponseMinutes: 240,
        resolutionMinutes: 1440,
        businessHours: {
          enabled: false,
          startHour: 9,
          endHour: 18,
          workingDays: [1, 2, 3, 4, 5],
          timezone: null,
        },
      },
      clientOverrides: [],
    })
  ),
  http.put(`${API}/reports/sla/policy`, () =>
    HttpResponse.json({ message: 'SLA policy updated.', policy: {} })
  ),
  http.get(`${API}/reports/sla`, () =>
    HttpResponse.json({
      range: { dateFrom: '', dateTo: '', days: 30, timezone: 'Asia/Kolkata' },
      scope: 'all',
      unit: 'minutes',
      policy: {
        source: 'default',
        firstResponseMinutes: 240,
        resolutionMinutes: 1440,
        businessHours: {
          enabled: false,
          startHour: 9,
          endHour: 18,
          workingDays: [1, 2, 3, 4, 5],
          timezone: null,
        },
        clientOverrides: 0,
      },
      firstResponse: { median: null, p90: null, max: null, count: 0, breachCount: 0, breachRate: 0, pendingCount: 0 },
      resolution: { median: null, p90: null, max: null, count: 0, breachCount: 0, breachRate: 0 },
      backlog: { median: null, p90: null, max: null, count: 0, breachCount: 0, breachRate: 0 },
      generatedAt: '',
    })
  ),
]
