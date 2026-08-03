const Client = require('../models/Client');
const Task = require('../models/Task');
const Email = require('../models/Email');
const cache = require('../utils/cache');
const { escapeRegex } = require('../utils/regexHelper');
const { parseListParams, listResponse, firstString } = require('../utils/paginate');
const { listClients, CLIENT_SORT_FIELDS } = require('../utils/clientService');
const { logActivity } = require('../utils/activityLogger');
const { log } = require('../utils/logger');

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
    const { data, pagination } = await listClients(params, { user: req.user });

    // Client lists change rarely; let the browser revalidate instead of
    // re-running the aggregation on every dashboard mount.
    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');

    return listResponse(res, {
      params,
      data,
      pagination,
      // Legacy shape preserved exactly: { success, count, data }.
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
      return res.status(400).json({ success: false, message: 'Invalid client ID' });
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

    // Each side is over-fetched to `limit` and the merge trims back to `limit`,
    // so a client with only emails still fills the timeline.
    const [tasks, emails] = await Promise.all([
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
        .lean()
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

    return res.json({
      success: true,
      data: {
        _id: client._id,
        name: client.name,
        createdAt: client.createdAt,
        timeline: entries,
        counts: { tasks: tasks.length, emails: emails.length }
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
      return res.status(400).json({ success: false, message: 'Client name is required' });
    }

    const existingClient = await Client.findOne({ name: { $regex: new RegExp(`^${escapeRegex(name.trim())}$`, 'i') } });
    if (existingClient) {
      return res.status(400).json({ success: false, message: 'Client with this name already exists' });
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
    logger.error({ err: err.message }, 'createClient failed');
    res.status(500).json({ success: false, message: err.message || 'Server error creating client' });
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
        return res.status(400).json({ success: false, message: 'Client with this name already exists' });
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
    res.status(500).json({ success: false, message: err.message || 'Server error updating client' });
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

module.exports = {
  getClients,
  getClientTimeline,
  createClient,
  updateClient,
  deleteClient
};
