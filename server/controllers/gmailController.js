const { google } = require('googleapis');
const User = require('../models/User');
const Email = require('../models/Email');
const Task = require('../models/Task');
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
    // 1. Try to find text/html first to get formatting and inline images
    let data = findPart(payload.parts, 'text/html');
    if (data) return data;

    // 2. Fallback to text/plain
    data = findPart(payload.parts, 'text/plain');
    if (data) return data;
  }

  return '';
};

// Recursive helper to find all inline image parts within message payload
const getInlineImages = (payload) => {
  const images = [];

  const traverse = (part) => {
    if (part.mimeType && part.mimeType.startsWith('image/') && part.headers) {
      const contentIdHeader = part.headers.find(h => h.name.toLowerCase() === 'content-id');
      if (contentIdHeader) {
        let contentId = contentIdHeader.value;
        // Strip angle brackets often present in Content-ID values (e.g. <image001.png@...>)
        contentId = contentId.replace(/^<|>$/g, '');
        images.push({
          contentId,
          mimeType: part.mimeType,
          attachmentId: part.body ? part.body.attachmentId : null,
          data: part.body ? part.body.data : null
        });
      }
    }

    if (part.parts) {
      for (const p of part.parts) {
        traverse(p);
      }
    }
  };

  traverse(payload);
  return images;
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
// Query param: ?mode=extra  → stores tokens in linkedGmailAccounts instead of primary slot
exports.getAuthUrl = async (req, res) => {
  try {
    const oauth2Client = getOAuth2Client();
    
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify'
    ];

    // Encode userId + mode into state so callback knows where to save tokens
    const mode = req.query.mode === 'extra' ? 'extra' : 'primary';
    const statePayload = `${req.user._id.toString()}:${mode}`;

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state: statePayload
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

    // Decode state: "userId:mode" (mode = 'primary' | 'extra')
    const [userId, mode] = state.split(':');
    const isExtra = mode === 'extra';

    const oauth2Client = getOAuth2Client();

    // Exchange code for access and refresh tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Find user using Mongoose ID passed via OAuth 'state'
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send('User associated with OAuth session not found.');
    }

    // Only Admins can connect Gmail accounts
    if (user.role !== 'Admin') {
      return res.status(403).send('Access denied. Only Admin users are authorized to connect Gmail accounts.');
    }

    // Call Gmail API to fetch the user's profile and actual Gmail email address
    let gmailAddress = "";
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      gmailAddress = profile.data.emailAddress || "";
    } catch (apiErr) {
      console.error('Error fetching Gmail profile during OAuth:', apiErr);
    }

    if (!gmailAddress) {
      return res.status(400).send('Failed to fetch Gmail profile email address. Please make sure Gmail access is enabled.');
    }

    if (isExtra) {
      // Store as a linked (extra) account — do not overwrite primary tokens
      const alreadyLinked = user.linkedGmailAccounts.some(a => a.gmailEmail === gmailAddress);
      if (!alreadyLinked) {
        user.linkedGmailAccounts.push({
          gmailEmail: gmailAddress,
          gmailAccessToken: tokens.access_token,
          gmailRefreshToken: tokens.refresh_token || null
        });
        await user.save();
        console.log(`[GMAIL] Linked extra account ${gmailAddress} to user ${user.email}`);
        await logActivity(user._id, 'Gmail Link Extra', `Linked extra Gmail account: ${gmailAddress}`);
      } else {
        // Update tokens if account already exists
        const acct = user.linkedGmailAccounts.find(a => a.gmailEmail === gmailAddress);
        if (acct) {
          acct.gmailAccessToken = tokens.access_token;
          if (tokens.refresh_token) acct.gmailRefreshToken = tokens.refresh_token;
        }
        await user.save();
        console.log(`[GMAIL] Refreshed tokens for linked account ${gmailAddress}`);
      }
    } else {
      // Save as primary Gmail account
      user.gmailAccessToken = tokens.access_token;
      if (tokens.refresh_token) {
        user.gmailRefreshToken = tokens.refresh_token;
      }
      user.gmailEmail = gmailAddress;
      await user.save();
      console.log(`Successfully saved primary Google credentials for user: ${user.email}`);
      await logActivity(user._id, 'Gmail Connection', `Connected Gmail account: ${gmailAddress}`);
    }

    // Run deduplication to clean up duplicates workspace-wide
    await deduplicateConnections();

    // Redirect to inbox so user sees the new account immediately
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.redirect(`${frontendUrl}/inbox?gmail=connected`);
  } catch (error) {
    console.error('OAuth callback exchange error:', error);
    return res.status(500).send('Failed to complete Google authentication. Please try again.');
  }
};

// Low-level helper: sync a single Gmail credential set (access/refresh tokens + inboxEmail)
const syncAccountEmails = async (user, accessToken, refreshToken, inboxEmail, isManual = false) => {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

  // Auto-save refreshed tokens
  oauth2Client.on('tokens', async (newTokens) => {
    if (inboxEmail === user.gmailEmail) {
      // Primary account
      if (newTokens.access_token) user.gmailAccessToken = newTokens.access_token;
      if (newTokens.refresh_token) user.gmailRefreshToken = newTokens.refresh_token;
    } else {
      // Linked account
      const acct = user.linkedGmailAccounts.find(a => a.gmailEmail === inboxEmail);
      if (acct) {
        if (newTokens.access_token) acct.gmailAccessToken = newTokens.access_token;
        if (newTokens.refresh_token) acct.gmailRefreshToken = newTokens.refresh_token;
      }
    }
    await user.save();
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 50,
    includeSpamTrash: true
  });

  const messages = listRes.data.messages || [];
  console.log(`[GMAIL SYNC] ${inboxEmail}: ${messages.length} messages found.`);

  let newCount = 0;

  for (const message of messages) {
    const exists = await Email.findOne({ messageId: message.id });
    if (exists) continue;

    const msgDetails = await gmail.users.messages.get({ userId: 'me', id: message.id });
    const payload = msgDetails.data.payload;
    const headers = payload.headers;
    const labelIds = msgDetails.data.labelIds || [];

    const subject = getHeader(headers, 'subject') || '(No Subject)';
    const from = getHeader(headers, 'from') || 'Unknown Sender';
    const dateStr = getHeader(headers, 'date');
    const date = dateStr ? new Date(dateStr) : new Date();

    const rawBody = getBodyText(payload);
    let decodedBody = '';
    if (rawBody) {
      const base64Body = rawBody.replace(/-/g, '+').replace(/_/g, '/');
      decodedBody = Buffer.from(base64Body, 'base64').toString('utf-8');
    }

    const inlineImages = getInlineImages(payload);
    if (inlineImages.length > 0 && decodedBody) {
      for (const img of inlineImages) {
        let base64Data = '';
        if (img.data) {
          base64Data = img.data;
        } else if (img.attachmentId) {
          try {
            const attachRes = await gmail.users.messages.attachments.get({
              userId: 'me',
              messageId: message.id,
              id: img.attachmentId
            });
            base64Data = attachRes.data.data || '';
          } catch (attachErr) {
            console.error(`[GMAIL SYNC] Failed to fetch attachment ${img.contentId}:`, attachErr);
          }
        }
        if (base64Data) {
          const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
          const dataUrl = `data:${img.mimeType};base64,${standardBase64}`;
          const escapedCid = img.contentId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          const regex = new RegExp(`cid:<?${escapedCid}>?`, 'gi');
          decodedBody = decodedBody.replace(regex, dataUrl);
        }
      }
    }

    const emailRecord = new Email({
      messageId: message.id,
      subject,
      from,
      date,
      body: decodedBody,
      status: 'unassigned',
      assignedTo: null,
      fetchedBy: user._id,
      labelIds,
      toEmail: inboxEmail
    });

    await emailRecord.save();
    console.log(`[GMAIL SYNC] Saved: "${subject}" to ${inboxEmail}`);
    newCount++;
  }

  return newCount;
};

// High-level helper: sync ALL accounts (primary + linked) for a user
const syncUserEmails = async (user, isManual = false) => {
  if (!user) throw new Error('Invalid user.');

  let totalNew = 0;

  // 1. Sync primary account (if connected)
  if (user.gmailAccessToken) {
    console.log(`[GMAIL SYNC] Syncing primary account: ${user.gmailEmail}`);
    const count = await syncAccountEmails(
      user, user.gmailAccessToken, user.gmailRefreshToken, user.gmailEmail, isManual
    );
    totalNew += count;
  }

  // 2. Sync all linked (extra) accounts
  for (const acct of (user.linkedGmailAccounts || [])) {
    if (acct.gmailAccessToken) {
      console.log(`[GMAIL SYNC] Syncing linked account: ${acct.gmailEmail}`);
      try {
        const count = await syncAccountEmails(
          user, acct.gmailAccessToken, acct.gmailRefreshToken, acct.gmailEmail, isManual
        );
        totalNew += count;
      } catch (err) {
        console.error(`[GMAIL SYNC] Failed for linked account ${acct.gmailEmail}:`, err.message);
      }
    }
  }

  console.log(`[GMAIL SYNC] Total new emails this sync: ${totalNew}`);

  const activityType = isManual ? 'Gmail Fetch' : 'Gmail Fetch Auto';
  const activityDesc = isManual
    ? `Manually fetched Gmail emails (Found ${totalNew} new emails)`
    : `Automatically fetched Gmail emails (Found ${totalNew} new emails)`;
  await logActivity(user._id, activityType, activityDesc);

  return totalNew;
};

// Export syncUserEmails for cron job usage
exports.syncUserEmails = syncUserEmails;

// @desc    Manually fetch emails from all connected accounts
// @route   POST /api/gmail/fetch
// @access  Private
exports.fetchEmails = async (req, res) => {
  try {
    let totalCount = 0;

    if (req.user.role === 'Admin' || req.user.role === 'Head') {
      // Find all users who have a connected Gmail account
      const users = await User.find({
        gmailAccessToken: { $ne: null, $ne: "" }
      });

      if (users.length > 0) {
        for (const u of users) {
          try {
            console.log(`[MANUAL SYNC] Syncing emails for user: ${u.email}`);
            const count = await syncUserEmails(u, true);
            totalCount += count;
          } catch (syncError) {
            console.error(`[MANUAL SYNC ERROR] Failed to sync for user ${u.email}:`, syncError);
          }
        }
      }
    } else {
      const user = await User.findById(req.user._id);
      if (!user || !user.gmailAccessToken) {
        console.log('Fetch abort: user or gmailAccessToken missing in DB.');
        return res.status(400).json({ message: 'Gmail account not connected. Please authenticate first.' });
      }
      totalCount = await syncUserEmails(user, true);
    }

    return res.status(200).json({
      message: 'Emails fetched successfully from all connected accounts',
      count: totalCount
    });
  } catch (error) {
    console.error('Error in fetchEmails:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve emails.' });
  }
};

exports.getEmails = async (req, res) => {
  try {
    const { q } = req.query;
    let query = {};

    if (req.user.role === 'Employee') {
      query.assignedTo = req.user._id;
    }

    // If search query provided, add text search across subject and from fields
    if (q && q.trim()) {
      const searchRegex = new RegExp(q.trim(), 'i');
      const searchConditions = [
        { subject: searchRegex },
        { from: searchRegex }
      ];
      // Merge with existing role filter
      if (query.assignedTo) {
        query = { assignedTo: query.assignedTo, $or: searchConditions };
      } else {
        query.$or = searchConditions;
      }
    }

    const emails = await Email.find(query)
      .populate('assignedTo', 'name email')
      .populate('fetchedBy', 'name email gmailEmail')
      .sort({ date: -1 });

    return res.status(200).json(emails);
  } catch (error) {
    console.error('Error in getEmails:', error);
    return res.status(500).json({ message: 'Server error. Failed to query emails.' });
  }
};

// @desc    Delete all emails (Admin only)
// @route   DELETE /api/gmail/emails
// @access  Private (Admin only)
exports.deleteAllEmails = async (req, res) => {
  try {
    const result = await Email.deleteMany({});
    await Task.updateMany({ linkedEmail: { $ne: null } }, { $set: { linkedEmail: null } });
    
    await logActivity(req.user._id, 'Gmail Delete All', `Cleared all emails (${result.deletedCount} emails deleted)`);

    return res.status(200).json({
      message: "All emails cleared",
      count: result.deletedCount
    });
  } catch (error) {
    console.error('Error in deleteAllEmails:', error);
    return res.status(500).json({ message: 'Server error. Failed to clear emails.' });
  }
};

// @desc    Delete single email (Admin, Head only)
// @route   DELETE /api/gmail/emails/:id
// @access  Private (Admin, Head only)
exports.deleteSingleEmail = async (req, res) => {
  try {
    const emailId = req.params.id;
    const email = await Email.findById(emailId);
    if (!email) {
      return res.status(404).json({ message: "Email not found" });
    }
    
    await Email.findByIdAndDelete(emailId);
    await Task.updateMany({ linkedEmail: emailId }, { $set: { linkedEmail: null } });
    
    await logActivity(req.user._id, 'Gmail Delete Single', `Deleted email: "${email.subject}"`);

    return res.status(200).json({ message: "Email deleted" });
  } catch (error) {
    console.error('Error in deleteSingleEmail:', error);
    return res.status(500).json({ message: 'Server error. Failed to delete email.' });
  }
};

// @desc    Get Gmail connection status
// @route   GET /api/gmail/status
// @access  Private
exports.getConnectedStatus = async (req, res) => {
  try {
    // Clean up duplicates and blanks first
    await deduplicateConnections();

    const currentUser = await User.findById(req.user._id);
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }
    const isConnected = !!currentUser.gmailAccessToken && currentUser.gmailAccessToken !== "";
    
    // Admin and Head can see all connected accounts in the workspace
    let linkedAccounts = (currentUser.linkedGmailAccounts || []).map(a => ({
      gmailEmail: a.gmailEmail,
      connected: !!a.gmailAccessToken,
      ownerName: 'Me',
      isOtherUser: false,
      userId: currentUser._id.toString()
    }));

    if (currentUser.role === 'Admin' || currentUser.role === 'Head') {
      // Find other users with connected accounts
      const otherUsers = await User.find({
        _id: { $ne: currentUser._id },
        gmailAccessToken: { $ne: null, $ne: "" }
      });

      for (const u of otherUsers) {
        // Add their primary account
        linkedAccounts.push({
          gmailEmail: u.gmailEmail,
          connected: true,
          ownerName: u.name,
          isOtherUser: true,
          userId: u._id.toString()
        });

        // Add their linked accounts
        for (const la of (u.linkedGmailAccounts || [])) {
          linkedAccounts.push({
            gmailEmail: la.gmailEmail,
            connected: !!la.gmailAccessToken,
            ownerName: u.name,
            isOtherUser: true,
            userId: u._id.toString()
          });
        }
      }
    }

    return res.status(200).json({
      connected: isConnected,
      gmailEmail: currentUser.gmailEmail || "",
      linkedAccounts
    });
  } catch (error) {
    console.error('Error in getConnectedStatus:', error);
    return res.status(500).json({ message: 'Server error. Failed to check connected status.' });
  }
};

// @desc    Disconnect a specific linked (extra) Gmail account
// @route   DELETE /api/gmail/linked-account
// @access  Private (Admin, Head only)
exports.disconnectLinkedAccount = async (req, res) => {
  try {
    const { gmailEmail, userId } = req.body;
    if (!gmailEmail && !userId) {
      return res.status(400).json({ message: 'Either gmailEmail or userId is required.' });
    }

    // Determine target user
    let targetUserId = req.user._id;
    if (userId && req.user.role === 'Admin') {
      targetUserId = userId;
    }

    const user = await User.findById(targetUserId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // If gmailEmail is empty or blank, clear blank connections for this user
    if (!gmailEmail) {
      // Clear blank primary account
      if (!user.gmailEmail) {
        user.gmailAccessToken = "";
        user.gmailRefreshToken = "";
        user.gmailEmail = "";
      }
      // Remove blank linked accounts
      user.linkedGmailAccounts = user.linkedGmailAccounts.filter(a => !!a.gmailEmail);
      await user.save();
      await logActivity(req.user._id, 'Gmail Clean Blank Accounts', `Cleared blank Gmail connections for user ${user.email}`);
      return res.status(200).json({ message: 'Blank connection cleared successfully.' });
    }

    let isPrimary = false;
    let before = 0;
    let after = 0;

    if (user.gmailEmail === gmailEmail) {
      isPrimary = true;
      user.gmailAccessToken = "";
      user.gmailRefreshToken = "";
      user.gmailEmail = "";
      await user.save();
    } else {
      before = user.linkedGmailAccounts.length;
      user.linkedGmailAccounts = user.linkedGmailAccounts.filter(
        a => a.gmailEmail !== gmailEmail
      );
      after = user.linkedGmailAccounts.length;
      await user.save();
    }

    if (!isPrimary && before === after) {
      return res.status(404).json({ message: 'Linked account not found.' });
    }

    // Delete all emails fetched from this account (identified by toEmail or fetchedBy)
    const emailsToDelete = await Email.find({ toEmail: gmailEmail, fetchedBy: targetUserId });
    const emailIds = emailsToDelete.map(e => e._id);
    await Email.deleteMany({ toEmail: gmailEmail, fetchedBy: targetUserId });
    if (emailIds.length > 0) {
      await Task.updateMany({ linkedEmail: { $in: emailIds } }, { $set: { linkedEmail: null } });
    }

    await logActivity(req.user._id, 'Gmail Unlink Account', `Unlinked Gmail account ${gmailEmail} of user ${user.email}`);

    return res.status(200).json({ message: `${gmailEmail} disconnected successfully.` });
  } catch (error) {
    console.error('Error in disconnectLinkedAccount:', error);
    return res.status(500).json({ message: 'Server error. Failed to disconnect linked account.' });
  }
};

// @desc    Disconnect Gmail account
// @route   DELETE /api/gmail/disconnect
// @access  Private
exports.disconnectGmail = async (req, res) => {
  try {
    const userId = req.user._id;

    // 1. Clear user tokens in DB
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    user.gmailAccessToken = "";
    user.gmailRefreshToken = "";
    user.gmailEmail = "";
    await user.save();

    // 2. Find all emails fetched by this user
    const emailsToDelete = await Email.find({ fetchedBy: userId });
    const emailIds = emailsToDelete.map(e => e._id);

    // 3. Delete the emails from collection
    await Email.deleteMany({ fetchedBy: userId });

    // 4. Update tasks that had linkedEmail in those emailIds
    if (emailIds.length > 0) {
      await Task.updateMany(
        { linkedEmail: { $in: emailIds } },
        { $set: { linkedEmail: null } }
      );
    }

    await logActivity(userId, 'Gmail Disconnect', `Disconnected Gmail account for user ${user.email}`);

    return res.status(200).json({ message: "Gmail disconnected successfully" });
  } catch (error) {
    console.error('Error in disconnectGmail:', error);
    return res.status(500).json({ message: 'Server error. Failed to disconnect Gmail.' });
  }
};

// Workspace-wide deduplication and cleanup helper
const deduplicateConnections = async () => {
  try {
    const users = await User.find({});
    const seenEmails = new Set();

    for (const u of users) {
      let modified = false;

      // 1. Check and clean primary connection
      const hasPrimary = !!u.gmailAccessToken || !!u.gmailEmail;
      if (hasPrimary) {
        const emailLower = (u.gmailEmail || "").toLowerCase().trim();
        // If the email is blank or it has already been registered elsewhere, clear it
        if (!emailLower || seenEmails.has(emailLower)) {
          u.gmailAccessToken = null;
          u.gmailRefreshToken = null;
          u.gmailEmail = "";
          modified = true;
          console.log(`[DEDUPLICATE] Cleared duplicate/invalid primary account for user: ${u.email}`);
        } else {
          seenEmails.add(emailLower);
        }
      }

      // 2. Check and clean linked extra accounts
      if (u.linkedGmailAccounts && u.linkedGmailAccounts.length > 0) {
        const originalLength = u.linkedGmailAccounts.length;
        u.linkedGmailAccounts = u.linkedGmailAccounts.filter(acct => {
          const emailLower = (acct.gmailEmail || "").toLowerCase().trim();
          // If the email is blank or has already been registered elsewhere, remove it
          if (!emailLower || seenEmails.has(emailLower)) {
            console.log(`[DEDUPLICATE] Removed duplicate/invalid linked account ${acct.gmailEmail || "(blank)"} from user: ${u.email}`);
            return false;
          }
          seenEmails.add(emailLower);
          return true;
        });

        if (u.linkedGmailAccounts.length !== originalLength) {
          modified = true;
        }
      }

      if (modified) {
        await u.save();
      }
    }
  } catch (err) {
    console.error('[DEDUPLICATE ERROR] Failed to clean duplicates:', err);
  }
};


// @desc    Send a reply to an email via Gmail API
// @route   POST /api/gmail/emails/:id/reply
// @access  Private (Admin, Head only)
exports.replyToEmail = async (req, res) => {
  try {
    const { replyBody } = req.body;
    const emailId = req.params.id;

    if (!replyBody || !replyBody.trim()) {
      return res.status(400).json({ message: 'Reply body is required.' });
    }

    // Load the original email from DB
    const email = await Email.findById(emailId);
    if (!email) return res.status(404).json({ message: 'Email not found.' });

    // Find the user who owns the account this email arrived on (toEmail)
    // It could be their primary or a linked account
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    let accessToken = null;
    let refreshToken = null;
    const targetInbox = email.toEmail;

    if (user.gmailEmail === targetInbox) {
      accessToken = user.gmailAccessToken;
      refreshToken = user.gmailRefreshToken;
    } else {
      const linked = (user.linkedGmailAccounts || []).find(a => a.gmailEmail === targetInbox);
      if (linked) {
        accessToken = linked.gmailAccessToken;
        refreshToken = linked.gmailRefreshToken;
      }
    }

    // If this user doesn't own the inbox, find the Admin who does
    if (!accessToken) {
      const allAdmins = await User.find({ role: 'Admin' });
      for (const admin of allAdmins) {
        if (admin.gmailEmail === targetInbox) {
          accessToken = admin.gmailAccessToken;
          refreshToken = admin.gmailRefreshToken;
          break;
        }
        const linked = (admin.linkedGmailAccounts || []).find(a => a.gmailEmail === targetInbox);
        if (linked) {
          accessToken = linked.gmailAccessToken;
          refreshToken = linked.gmailRefreshToken;
          break;
        }
      }
    }

    if (!accessToken) {
      return res.status(400).json({ message: 'No connected Gmail account found for this inbox. Please reconnect.' });
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Fetch original message from Gmail to get proper headers (Message-ID, References, thread)
    let originalMessageId = '';
    let references = '';
    let threadId = '';
    try {
      const original = await gmail.users.messages.get({ userId: 'me', id: email.messageId, format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'In-Reply-To'] });
      threadId = original.data.threadId || '';
      const headers = original.data.payload?.headers || [];
      const msgIdHeader = headers.find(h => h.name.toLowerCase() === 'message-id');
      const refsHeader = headers.find(h => h.name.toLowerCase() === 'references');
      originalMessageId = msgIdHeader ? msgIdHeader.value : '';
      references = refsHeader ? `${refsHeader.value} ${originalMessageId}` : originalMessageId;
    } catch (e) {
      console.warn('[REPLY] Could not fetch original headers:', e.message);
    }

    // Extract plain sender address from "Name <email@domain.com>" format
    const toAddress = email.from.match(/<(.+?)>/) ? email.from.match(/<(.+?)>/)[1] : email.from;
    const replySubject = email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`;

    // Build RFC 2822 raw email
    const rawLines = [
      `From: ${targetInbox}`,
      `To: ${toAddress}`,
      `Subject: ${replySubject}`,
      `In-Reply-To: ${originalMessageId}`,
      `References: ${references}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      replyBody.trim()
    ];

    const rawEmail = rawLines.join('\r\n');
    const encodedEmail = Buffer.from(rawEmail).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail,
        ...(threadId ? { threadId } : {})
      }
    });

    await logActivity(req.user._id, 'Email Reply', `Replied to email "${email.subject}" from ${email.from}`);

    return res.status(200).json({ message: 'Reply sent successfully.' });
  } catch (error) {
    console.error('Error in replyToEmail:', error);
    return res.status(500).json({ message: 'Server error. Failed to send reply.' });
  }
};


