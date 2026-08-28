const Client = require('../models/Client');
const Task = require('../models/Task');
const Email = require('../models/Email');
const cache = require('../utils/cache');
const { escapeRegex } = require('../utils/regexHelper');
const { parseListParams, listResponse, firstString } = require('../utils/paginate');
const { listClients, CLIENT_SORT_FIELDS, getUnattributedCounts } = require('../utils/clientService');
const { logActivity } = require('../utils/activityLogger');
const { log } = require('../utils/logger');
// M-13: one error envelope, `{ message, errors: [{ path, message }] }`.
const { fieldError, duplicateKeyPaths, isDuplicateKeyError } = require('../utils/apiError');

const logger = log('clients');

const TIMELINE_DEFAULT_LIMIT = 20;
const TIMELINE_MAX_LIMIT = 100;

// @desc    Get all clients with mail and work (task) counts
// @route   GET /api/clients
// @access  Private (Admin, Head, Employee)
//
// Backed by utils/clientService, the single implementation shared with
// GET /api/tasks/clients. See that module for what this replaced.
const getClients = async (req, res) => {
  try {
    const params = parseListParams(req, {
      sortWhitelist: CLIENT_SORT_FIELDS,
      defaultSort: '-createdAt'
    });

    // Counters are scoped to the caller (audit D5): a Head sees the counts for
    // the mail/tasks THEY can open, not workspace-wide volumes.
    const [{ data, pagination }, unattributed] = await Promise.all([
      listClients(params, { user: req.user }),
      getUnattributedCounts(req.user)
    ]);

    // Client lists change rarely; let the browser revalidate instead of
    // re-running the aggregation on every dashboard mount.
    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');

    /*
     * H-5 — the Clients table's own columns summed to 353 tasks and 1,185
     * emails against a workspace holding 427 and 1,397. A client LIST must not
     * grow a fake client row (it would corrupt `pagination.total` and the sort
     * order), so the residual is reported alongside the page instead, and the
     * UI can render it as a footer line that makes the columns add up.
     *
     *   unattributed: { taskCount, completedTaskCount, openTaskCount,
     *                   emailCount, totals: {...}, matched: {...},
     *                   orphanClientNames: [...] }
     */
    return listResponse(res, {
      params,
      data,
      pagination,
      extra: { unattributed },
      // Legacy shape preserved exactly: { success, count, data } — plus the
      // additive `unattributed` key.
      legacy: (rows) => ({ success: true, count: rows.length, data: rows })
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'getClients failed');
    res.status(500).json({ success: false, message: 'Server error fetching clients' });
  }
};

// @desc    Recent activity (tasks + emails) for one client
// @route   GET /api/clients/:id/timeline
// @access  Private (Admin, Head, Employee)
//
// WAVE2 gap S-10. The detail drawer already renders `client.timeline[]` when it
// is supplied and says so explicitly when it is not; this makes it real.
//
// Entry shape, matching what the drawer reads:
//   { at: ISO-8601, label: String, type: 'task'|'email', id, status?, meta? }
//
// Tasks are matched by `clientName` (case-insensitive, the same rule the task
// counters use) and emails by the denormalised `Email.clientId` written at
// ingest — an indexed equality, not a regex scan.
const getClientTimeline = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(String(id))) {
      return fieldError(res, 400, 'Invalid client ID', ['id'], { success: false });
    }

    const client = await Client.findById(id).select('name createdAt').lean();
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const requested = parseInt(firstString(req.query.limit, 10), 10);
    const limit = Number.isFinite(requested) && requested >= 1
      ? Math.min(requested, TIMELINE_MAX_LIMIT)
      : TIMELINE_DEFAULT_LIMIT;

    // Scope by role, exactly as the task and email list endpoints do, so this
    // endpoint cannot become a side channel onto another user's work.
    const taskFilter = { clientName: new RegExp(`^${escapeRegex(client.name || '')}$`, 'i') };
    // F-1: outbound replies are persisted as Email rows now. This timeline has
    // always meant "mail received from the client", so they are excluded here
    // and the entry list keeps its existing meaning.
    const emailFilter = { clientId: client._id, deletedAt: null, direction: { $ne: 'outbound' } };
    if (req.user.role === 'Employee') {
      taskFilter.assignedTo = req.user._id;
      emailFilter.assignedTo = req.user._id;
    } else if (req.user.role === 'Head') {
      taskFilter.createdBy = req.user._id;
      emailFilter.fetchedBy = req.user._id;
    }

    /*
     * M-9 — `counts` used to be `{ tasks: tasks.length, emails: emails.length }`
     * computed AFTER each side had been `.limit(limit)`-ed, so it tracked
     * whatever `limit` the caller happened to send:
     *
     *   .../timeline            -> counts {tasks: 20, emails: 20}
     *   .../timeline?limit=100  -> counts {tasks: 24, emails: 55}
     *   Mongo truth             ->        {tasks: 24, emails: 77}
     *
     * — a number named like a total that was never the total and, at the
     * default limit, was not even the right shape of wrong. `counts` is now two
     * real `countDocuments` over the SAME role-scoped filters the entries come
     * from, and what the payload actually carries is reported separately under
     * `returned`.
     */
    // Each side is over-fetched to `limit` and the merge trims back to `limit`,
    // so a client with only emails still fills the timeline.
    const [tasks, emails, taskTotal, emailTotal] = await Promise.all([
      Task.find(taskFilter)
        .select('_id title status priority deadline createdAt')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      // NEVER `body` — API-LIST-CONTRACT.md rule 1.
      Email.find(emailFilter)
        .select('_id subject from date fetchedAt status')
        .sort({ date: -1 })
        .limit(limit)
        .lean(),
      Task.countDocuments(taskFilter),
      Email.countDocuments(emailFilter)
    ]);

    const entries = [
      ...tasks.map((t) => ({
        type: 'task',
        id: String(t._id),
        at: t.createdAt,
        label: `Task created: ${t.title || 'Untitled task'}`,
        status: t.status,
        meta: { priority: t.priority, deadline: t.deadline }
      })),
      ...emails.map((e) => ({
        type: 'email',
        id: String(e._id),
        at: e.date || e.fetchedAt,
        label: `Email received: ${e.subject || '(no subject)'}`,
        status: e.status,
        meta: { from: e.from }
      }))
    ]
      .filter((entry) => entry.at)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, limit);

    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');

    const returnedTasks = entries.filter((e) => e.type === 'task').length;
    const returnedEmails = entries.filter((e) => e.type === 'email').length;

    return res.json({
      success: true,
      data: {
        _id: client._id,
        name: client.name,
        createdAt: client.createdAt,
        timeline: entries,
        // M-9: real totals for this client, in the caller's scope. Independent
        // of `limit`, and NOT the length of `timeline` below.
        counts: { tasks: taskTotal, emails: emailTotal },
        // What this payload actually carries, after the merge and the trim.
        returned: { tasks: returnedTasks, emails: returnedEmails, entries: entries.length },
        limit,
        // True when the timeline is a window onto more activity than it shows.
        truncated: entries.length < taskTotal + emailTotal
      }
    });
  } catch (err) {
    logger.error({ err: err.message }, 'getClientTimeline failed');
    return res.status(500).json({ success: false, message: 'Server error fetching client timeline' });
  }
};

// @desc    Create a new client
// @route   POST /api/clients
// @access  Private (Admin, Head)
const createClient = async (req, res) => {
  try {
    const { name, associatedEmails, contactPerson, email, phone, notes, status } = req.body;

    if (!name) {
      // M-13: `success: false` is preserved — this endpoint has always sent it
      // and the client reads it — and `errors[]` is added alongside.
      return fieldError(res, 400, 'Client name is required', ['name'], { success: false });
    }

    const existingClient = await Client.findOne({ name: { $regex: new RegExp(`^${escapeRegex(name.trim())}$`, 'i') } });
    if (existingClient) {
      return fieldError(res, 400, 'Client with this name already exists', ['name'], { success: false });
    }

    const formattedEmails = Array.isArray(associatedEmails)
      ? associatedEmails.map((e) => e.trim()).filter(Boolean)
      : typeof associatedEmails === 'string'
      ? associatedEmails.split(',').map((e) => e.trim()).filter(Boolean)
      : [];

    const newClient = new Client({
      name: name.trim(),
      associatedEmails: formattedEmails,
      contactPerson: contactPerson || '',
      email: email || '',
      phone: phone || '',
      notes: notes || '',
      status: status || 'Active'
    });

    await newClient.save();
    await cache.invalidateClients();

    /*
     * Client mutations are reachable through TWO documented-duplicate URLs:
     * /api/clients (here) and /api/tasks/clients (taskController). Only the
     * latter was audited, so the same action was on the record through one URL
     * and invisible through the other — the worse half of an audit gap,
     * because the log looked complete.
     *
     * Same action strings as taskController on purpose: the Activity Log
     * filters and the CSV export key off them, and a second spelling would
     * split one action into two filter entries.
     */
    await logActivity(req.user._id, 'Client Creation', `Created client "${newClient.name}"`, {
      req,
      targetType: 'Client',
      targetId: newClient._id,
      targetLabel: newClient.name,
      after: { name: newClient.name, associatedEmails: [...(newClient.associatedEmails || [])] }
    });

    res.status(201).json({
      success: true,
      message: 'Client created successfully',
      data: { ...newClient.toObject(), taskCount: 0, completedTaskCount: 0, openTaskCount: 0, mailCount: 0 }
    });
  } catch (err) {
    /*
     * M-13 — `Client.name` carries a unique index, so two simultaneous creates
     * race past the `findOne` above and the loser arrived here as a 500 with no
     * field on it. A duplicate key names its own field; report it as the same
     * 400 the non-racing path already returns.
     */
    if (isDuplicateKeyError(err)) {
      return fieldError(
        res,
        400,
        'Client with this name already exists',
        duplicateKeyPaths(err).map((path) => ({ path, message: 'This value is already taken.' })),
        { success: false }
      );
    }
    logger.error({ err: err.message }, 'createClient failed');
    // H-9: never echo the raw driver/JS message back. It is how
    // `{"name":[]}` answered 500 "name.trim is not a function"; the shape is
    // now a 400 from `createClientSchema` and this path is a genuine 500.
    res.status(500).json({ success: false, message: 'Server error creating client' });
  }
};

// @desc    Update an existing client
// @route   PUT /api/clients/:id
// @access  Private (Admin, Head)
const updateClient = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, associatedEmails, contactPerson, email, phone, notes, status } = req.body;

    const client = await Client.findById(id);
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    // Snapshot BEFORE the in-place mutations below. Taking it afterwards would
    // record the new values as the old ones and make the diff read as a no-op.
    const beforeClient = {
      name: client.name,
      associatedEmails: [...(client.associatedEmails || [])]
    };

    if (name && name.trim().toLowerCase() !== client.name.toLowerCase()) {
      const existing = await Client.findOne({ name: { $regex: new RegExp(`^${escapeRegex(name.trim())}$`, 'i') } });
      if (existing) {
        return fieldError(res, 400, 'Client with this name already exists', ['name'], { success: false });
      }
      client.name = name.trim();
    }

    if (associatedEmails !== undefined) {
      client.associatedEmails = Array.isArray(associatedEmails)
        ? associatedEmails.map((e) => e.trim()).filter(Boolean)
        : typeof associatedEmails === 'string'
        ? associatedEmails.split(',').map((e) => e.trim()).filter(Boolean)
        : [];
    }

    if (contactPerson !== undefined) client.contactPerson = contactPerson;
    if (email !== undefined) client.email = email;
    if (phone !== undefined) client.phone = phone;
    if (notes !== undefined) client.notes = notes;
    if (status !== undefined) client.status = status;

    await client.save();
    await cache.invalidateClients();

    await logActivity(req.user._id, 'Client Update', `Updated client "${client.name}"`, {
      req,
      targetType: 'Client',
      targetId: client._id,
      targetLabel: client.name,
      before: beforeClient,
      after: { name: client.name, associatedEmails: [...(client.associatedEmails || [])] }
    });

    res.json({
      success: true,
      message: 'Client updated successfully',
      data: client
    });
  } catch (err) {
    logger.error({ err: err.message }, 'updateClient failed');
    res.status(500).json({ success: false, message: 'Server error updating client' });
  }
};

// @desc    Delete a client
// @route   DELETE /api/clients/:id
// @access  Private (Admin only)
const deleteClient = async (req, res) => {
  try {
    const { id } = req.params;
    const client = await Client.findByIdAndDelete(id);
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }
    await cache.invalidateClients();

    // `before` only: after a delete there is no "after" state, and recording an
    // empty object would read as "the fields were cleared" rather than "the
    // record is gone". The returned doc is the pre-delete state.
    await logActivity(req.user._id, 'Client Deletion', `Deleted client "${client.name}"`, {
      req,
      targetType: 'Client',
      targetId: client._id,
      targetLabel: client.name,
      before: { name: client.name, associatedEmails: [...(client.associatedEmails || [])] }
    });

    res.json({ success: true, message: 'Client deleted successfully' });
  } catch (err) {
    logger.error({ err: err.message }, 'deleteClient failed');
    res.status(500).json({ success: false, message: 'Server error deleting client' });
  }
};


/**
 * POST /api/clients/import — bulk create/update clients from a spreadsheet.
 *
 * The browser parses the workbook and posts rows, so nothing here handles
 * multipart or trusts a file. Rows are validated by `importClientsSchema`
 * before arriving.
 *
 * Matching, in order:
 *   1. `code` — the practice's own client code, and the natural key. Re-running
 *      the same sheet UPDATES those clients instead of creating duplicates.
 *   2. `name`, case-insensitively, when a row has no code.
 *
 * That ordering matters: names in the source sheet carry trailing spaces and
 * inconsistent casing, so name-matching alone would create near-duplicates on
 * the second run. Matching on code makes the import idempotent.
 *
 * `status` is always Active. The sheet's own status codes ("01", "05", …) are
 * the practice's business rules, not ours, so the original is preserved in
 * `sourceStatus` rather than being guessed into Active/Inactive — a wrong
 * guess would silently hide live clients from every picker.
 *
 * Never destructive: a field absent from the sheet is left as it is, so an
 * import cannot wipe an email address or note added by hand in the UI.
 */
const importClients = async (req, res) => {
  try {
    const { rows } = req.body;

    const summary = { received: rows.length, created: 0, updated: 0, skipped: 0, errors: [] };

    // One query for everything this batch might touch, rather than 2 lookups
    // per row. 500 rows would otherwise be 1,000 sequential round-trips.
    const codes = rows.map((r) => (r.code || '').trim()).filter(Boolean);
    const names = rows.map((r) => r.name.trim()).filter(Boolean);

    const existing = await Client.find({
      $or: [
        ...(codes.length ? [{ code: { $in: codes } }] : []),
        ...(names.length ? [{ name: { $in: names } }] : [])
      ]
    })
      .select('_id name code')
      .lean();

    const byCode = new Map(existing.filter((c) => c.code).map((c) => [c.code.toLowerCase(), c]));
    const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));

    const ops = [];
    // Guards against a sheet that repeats a code or name within one batch:
    // two upserts on the same key in a single bulkWrite is a duplicate-key
    // error, and the whole batch would fail for one bad pair of rows.
    const seenCode = new Set();
    const seenName = new Set();

    for (const row of rows) {
      const code = (row.code || '').trim();
      const name = row.name.trim();
      const key = code ? `c:${code.toLowerCase()}` : `n:${name.toLowerCase()}`;
      const seen = code ? seenCode : seenName;

      if (seen.has(key)) {
        summary.skipped += 1;
        summary.errors.push({ name, code, reason: 'Repeated in this file' });
        continue;
      }
      seen.add(key);

      const match = code ? byCode.get(code.toLowerCase()) : byName.get(name.toLowerCase());

      // Only fields the sheet actually carries are written.
      const fields = { name, code };
      if (row.address !== undefined) fields.address = row.address.trim();
      if (row.phone !== undefined) fields.phone = row.phone.trim();
      if (row.sourceStatus !== undefined) fields.sourceStatus = row.sourceStatus.trim();

      if (match) {
        summary.updated += 1;
        ops.push({ updateOne: { filter: { _id: match._id }, update: { $set: fields } } });
      } else {
        summary.created += 1;
        ops.push({
          insertOne: {
            document: { ...fields, status: 'Active', associatedEmails: [], createdAt: new Date() }
          }
        });
      }
    }

    if (ops.length) {
      try {
        await Client.bulkWrite(ops, { ordered: false });
      } catch (bulkErr) {
        // `ordered: false` means the good rows still landed. Report the ones
        // that did not instead of failing the whole batch, so a single bad row
        // in a 1,000-row sheet does not cost the other 999.
        const writeErrors = bulkErr?.writeErrors || bulkErr?.result?.writeErrors || [];
        for (const we of writeErrors) {
          const doc = we?.err?.op?.document || we?.op?.document || {};
          summary.errors.push({
            name: doc.name || '(unknown)',
            code: doc.code || '',
            reason: we?.err?.code === 11000 || we?.code === 11000 ? 'Already exists' : 'Could not be saved'
          });
        }
        const failed = writeErrors.length;
        summary.skipped += failed;
        // The created/updated counters were optimistic; correct them.
        summary.created = Math.max(0, summary.created - failed);
      }
    }

    await cache.invalidateClients();

    await logActivity(
      req.user._id,
      'Client Import',
      `Imported ${summary.created} new and updated ${summary.updated} clients from a spreadsheet`,
      {
        req,
        targetType: 'Client',
        targetId: null,
        targetLabel: `${summary.received} row(s)`,
        after: { created: summary.created, updated: summary.updated, skipped: summary.skipped }
      }
    );

    res.json({ success: true, message: 'Import complete', data: summary });
  } catch (err) {
    logger.error({ err: err.message }, 'importClients failed');
    res.status(500).json({ success: false, message: 'Server error importing clients' });
  }
};

module.exports = {
  getClients,
  getClientTimeline,
  createClient,
  importClients,
  updateClient,
  deleteClient
};
