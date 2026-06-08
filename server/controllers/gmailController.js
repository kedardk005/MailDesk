const { google } = require('googleapis');
const User = require('../models/User');
const Email = require('../models/Email');
const { logActivity } = require('../utils/activityLogger');

// Helper to get OAuth2 Client
const getOAuth2Client = () => {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectURI = process.env.GOOGLE_REDIRECT_URI;

  if (!clientID || !clientSecret || !redirectURI) {
    throw new Error('Google OAuth credentials missing in server configuration.');
  }

  return new google.auth.OAuth2(clientID, clientSecret, redirectURI);
};

// Recursive helper to traverse email parts and extract body
const getBodyText = (payload) => {
  const findPart = (parts, mimeType) => {
    for (const part of parts) {
      if (part.mimeType === mimeType && part.body && part.body.data) {
        return part.body.data;
      }
      if (part.parts) {
        const found = findPart(part.parts, mimeType);
        if (found) return found;
      }
    }
    return null;
  };

  // If the body is direct (not multipart)
  if (payload.body && payload.body.data) {
    return payload.body.data;
  }

  if (payload.parts) {
    // 1. Try to find text/plain
    let data = findPart(payload.parts, 'text/plain');
    if (data) return data;

    // 2. Fallback to text/html
    data = findPart(payload.parts, 'text/html');
    if (data) return data;
  }

  return '';
};

// Helper to search for header names in a case-insensitive manner
const getHeader = (headers, name) => {
  if (!headers) return '';
  const found = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
};

// @desc    Generate Google OAuth2 authorization URL
// @route   GET /api/gmail/auth-url
// @access  Private
exports.getAuthUrl = async (req, res) => {
  try {
    const oauth2Client = getOAuth2Client();
    
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify'
    ];

    // Generate authorization URL
    // State stores the user ID to associate tokens correctly in the public callback
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline', // Request refresh token
      prompt: 'consent',      // Force consent screen to guarantee refresh token is returned
      scope: scopes,
      state: req.user._id.toString()
    });

    return res.status(200).json({ authUrl });
  } catch (error) {
    console.error('Error generating Google auth URL:', error);
    return res.status(500).json({ message: error.message || 'Server error. Failed to generate auth URL.' });
  }
};

// @desc    Handle Google OAuth callback
// @route   GET /api/gmail/oauth/callback
// @access  Public
exports.handleOAuthCallback = async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send('Authorization code or state parameter is missing.');
    }

    const oauth2Client = getOAuth2Client();

    // Exchange code for access and refresh tokens
    const { tokens } = await oauth2Client.getToken(code);
    
    // Find user using Mongoose ID passed via OAuth 'state'
    const user = await User.findById(state);
    if (!user) {
      return res.status(404).send('User associated with OAuth session not found.');
    }

    // Block Employees from connecting Gmail
    if (user.role === 'Employee') {
      return res.status(403).send('Access denied. Employees are not authorized to connect Gmail.');
    }

    // Save tokens to MongoDB
    user.gmailAccessToken = tokens.access_token;
    if (tokens.refresh_token) {
      user.gmailRefreshToken = tokens.refresh_token;
    }
    await user.save();

    console.log(`Successfully saved Google credentials for user: ${user.email}`);

    await logActivity(user._id, 'Gmail Connection', `Connected Gmail account: ${user.email}`);

    // Redirect to dashboard page
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.redirect(`${frontendUrl}/dashboard?gmail=connected`);
  } catch (error) {
    console.error('OAuth callback exchange error:', error);
    return res.status(500).send('Failed to complete Google authentication. Please try again.');
  }
};

// @desc    Manually fetch the last 20 emails
// @route   POST /api/gmail/fetch
// @access  Private
exports.fetchEmails = async (req, res) => {
  try {
    // Retrieve user from DB to access fresh tokens
    const user = await User.findById(req.user._id);
    if (!user || !user.gmailAccessToken) {
      console.log('Fetch abort: user or gmailAccessToken missing in DB.');
      return res.status(400).json({ message: 'Gmail account not connected. Please authenticate first.' });
    }

    console.log('Fetching emails for user:', user.email);

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: user.gmailAccessToken,
      refresh_token: user.gmailRefreshToken
    });

    // Handle token refresh events automatically
    oauth2Client.on('tokens', async (tokens) => {
      console.log('Google OAuth2 tokens refreshed.');
      if (tokens.access_token) {
        user.gmailAccessToken = tokens.access_token;
      }
      if (tokens.refresh_token) {
        user.gmailRefreshToken = tokens.refresh_token;
      }
      await user.save();
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Fetch list of last 20 messages
    let listRes;
    try {
      listRes = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 20
      });
    } catch (apiError) {
      console.error('Gmail List API Error:', apiError);
      return res.status(500).json({ message: 'Failed to access Gmail inbox. Access token might be invalid.' });
    }

    const messages = listRes.data.messages || [];
    console.log(`Gmail API returned ${messages.length} messages from mailbox.`);

    let newEmailsCount = 0;

    for (const message of messages) {
      // Check if messageId already exists in DB
      const exists = await Email.findOne({ messageId: message.id });
      if (exists) {
        console.log(`Skipping duplicate message: ${message.id} (Subject: ${exists.subject})`);
        continue;
      }

      // Fetch detailed message payload
      console.log(`Fetching details for message ID: ${message.id}`);
      const msgDetails = await gmail.users.messages.get({
        userId: 'me',
        id: message.id
      });

      const payload = msgDetails.data.payload;
      const headers = payload.headers;

      // Extract subject, from, and date headers
      const subject = getHeader(headers, 'subject') || '(No Subject)';
      const from = getHeader(headers, 'from') || 'Unknown Sender';
      const dateStr = getHeader(headers, 'date');
      const date = dateStr ? new Date(dateStr) : new Date();

      // Extract and decode text body
      const rawBody = getBodyText(payload);
      let decodedBody = '';
      if (rawBody) {
        // Base64url decoding
        const base64Body = rawBody.replace(/-/g, '+').replace(/_/g, '/');
        decodedBody = Buffer.from(base64Body, 'base64').toString('utf-8');
      }

      // Save email to DB
      const emailRecord = new Email({
        messageId: message.id,
        subject,
        from,
        date,
        body: decodedBody,
        status: 'unassigned',
        assignedTo: null
      });

      await emailRecord.save();
      console.log(`Saved new email: "${subject}" from ${from}`);
      newEmailsCount++;
    }

    console.log(`Fetch finished. Added ${newEmailsCount} new emails.`);

    await logActivity(req.user._id, 'Gmail Fetch', `Manually fetched Gmail emails (Found ${newEmailsCount} new emails)`);

    return res.status(200).json({
      message: 'Emails fetched successfully',
      count: newEmailsCount
    });
  } catch (error) {
    console.error('Error in fetchEmails:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve emails.' });
  }
};

// @desc    Get emails from database
// @route   GET /api/gmail/emails
// @access  Private
exports.getEmails = async (req, res) => {
  try {
    let query = {};

    // Role checks
    // Employee: see only emails assigned to them
    // Admin/Head: see all emails
    if (req.user.role === 'Employee') {
      query = { assignedTo: req.user._id };
    }

    const emails = await Email.find(query)
      .populate('assignedTo', 'name email')
      .sort({ date: -1 });

    return res.status(200).json(emails);
  } catch (error) {
    console.error('Error in getEmails:', error);
    return res.status(500).json({ message: 'Server error. Failed to query emails.' });
  }
};
