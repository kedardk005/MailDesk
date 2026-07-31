const Client = require('../models/Client');
const Task = require('../models/Task');
const Email = require('../models/Email');
const { escapeRegex } = require('../utils/regexHelper');


// @desc    Get all clients with mail and work (task) counts
// @route   GET /api/clients
// @access  Private (Admin, Head, Employee)
const getClients = async (req, res) => {
  try {
    const clients = await Client.find().sort({ createdAt: -1 });
    const tasks = await Task.find({}, 'clientName status');
    const emails = await Email.find({}, 'from');

    const result = clients.map((client) => {
      const clientObj = client.toObject();

      // Count tasks associated with client name
      const taskCount = tasks.filter((t) => t.clientName && t.clientName.toLowerCase() === client.name.toLowerCase()).length;

      // Count emails associated with client email or associatedEmails
      const allClientEmails = [client.email, ...(client.associatedEmails || [])]
        .filter(Boolean)
        .map((e) => e.toLowerCase().trim());

      const mailCount = emails.filter((e) => {
        if (!e.from) return false;
        const sender = e.from.toLowerCase();
        return allClientEmails.some((ce) => sender.includes(ce));
      }).length;

      return {
        ...clientObj,
        taskCount,
        mailCount
      };
    });

    res.json({ success: true, count: result.length, data: result });
  } catch (err) {
    console.error('Error fetching clients:', err);
    res.status(500).json({ success: false, message: 'Server error fetching clients' });
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

    res.status(201).json({
      success: true,
      message: 'Client created successfully',
      data: { ...newClient.toObject(), taskCount: 0, mailCount: 0 }
    });
  } catch (err) {
    console.error('Error creating client:', err);
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

    res.json({
      success: true,
      message: 'Client updated successfully',
      data: client
    });
  } catch (err) {
    console.error('Error updating client:', err);
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

    res.json({ success: true, message: 'Client deleted successfully' });
  } catch (err) {
    console.error('Error deleting client:', err);
    res.status(500).json({ success: false, message: 'Server error deleting client' });
  }
};

module.exports = {
  getClients,
  createClient,
  updateClient,
  deleteClient
};
