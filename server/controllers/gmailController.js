const { google } = require('googleapis');
const pLimit = require('p-limit');
const User = require('../models/User');
const Email = require('../models/Email');
const Task = require('../models/Task');
const { logActivity } = require('../utils/activityLogger');
const { encrypt, decrypt, tryDecrypt } = require('../utils/tokenCrypto');
const { escapeRegex } = require('../utils/regexHelper');
const KeywordRule = require('../models/KeywordRule');
const { ensureTasksForEmails, getClientMatcher, resolveClientForSender } = require('../utils/taskHelper');
const { sanitizeEmailHtml, sanitizeEmailDoc } = require('../utils/sanitizeEmailHtml');
const { makeSnippet } = require('../utils/snippet');
const cache = require('../utils/cache');
// `firstString` is aliased because getEmails already destructures a local
// `firstString` inside its own block; a same-name top-level import would sit in
// that block's temporal dead zone.
const {
  parseListParams,
  paginate,
  listResponse,
  buildPagination,
  firstString: firstStringOf
} = require('../utils/paginate');
const {
  parseReferences,
  resyncThreadPositions,
  threadScopeFilter,
  threadGroupStage,
  projectThreadStage,
  THREAD_SORT_FIELDS,
  THREAD_MESSAGE_CAP
} = require('../utils/threadHelper');
const { callResilient } = require('../utils/resilience');
const queue = require('../utils/queue');
// One definition of "may this user read this email", shared with F-3 (AI
// extraction) and F-4 (socket presence).
const emailAccess = require('../utils/emailAccess');
const { log } = require('../utils/logger');

const logger = log('gmail');

// Every read path must exclude soft-deleted emails.
const NOT_DELETED = { deletedAt: null };

// Projection for every LIST response. `body` and `bodyRaw` are `select: false`
// on the schema, but the projection is spelled out so a future edit cannot
// reintroduce them by accident. `snippet` replaces the body in list views.
const EMAIL_LIST_FIELDS = [
  'messageId',
  'subject',
  'snippet',
  'from',
  'date',
  'status',
  'assignedTo',
  'fetchedBy',
  'fetchedAt',
  'toEmail',
  'labelIds',
  'attachments',
  'matchedKeyword',
  'suggestedAssignedTo',
  'approvalStatus',
  'clientId',
  // S-16: needed to derive `isRead` for the requesting user. It is user ids and
  // timestamps only — no secrets — and is returned as-is.
  'readBy',
  // F-1. Purely ADDITIVE: every field the inbox already read is untouched, so
  // the finished client page keeps working unchanged.
  'threadId',
  'direction',
  'threadPosition',
  'rfcMessageId',
  'inReplyTo',
  'sentBy',
  'sentAt'
].join(' ');

// Sortable fields for GET /api/gmail/emails (API-LIST-CONTRACT.md).
const EMAIL_SORT_FIELDS = ['date', 'fetchedAt', 'subject', 'from', 'status', 'approvalStatus'];

// Bulk operation ceiling, matching bulkAssignEmailsSchema's 200.
const EMAIL_BULK_MAX = Number(process.env.EMAIL_BULK_MAX || 200);

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Attach `isRead` for the REQUESTING user (WAVE2 gap S-16).
 *
 * Read state is per-user because this is a shared mailbox: an email fetched by
 * a Head and assigned to an Employee is read independently by each of them. The
 * inbox previously faked "unread emphasis" from `status === 'unassigned'`,
 * which meant assigning an email marked it read for everyone.
 *
 * @param {Object} email - a LEAN email object
 * @param {String} userId
 * @returns {Object} the same object plus `isRead` and `readAt`
 */
const deriveIsRead = (email, userId) => {
  if (!email) return email;
  const id = String(userId);
  const entry = (email.readBy || []).find((r) => String(r?.user) === id);
  return { ...email, isRead: Boolean(entry), readAt: entry?.readAt || null };
};

/**
 * Validate and de-duplicate a caller-supplied array of email ids.
 * @param {*} raw
 * @returns {{ids: String[], error: String|null}}
 */
const parseEmailIds = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ids: [], error: 'An "ids" array with at least one email ID is required.' };
  }
  if (raw.length > EMAIL_BULK_MAX) {
    return { ids: [], error: `Cannot act on more than ${EMAIL_BULK_MAX} emails at once.` };
  }
  const ids = [...new Set(raw.map((v) => String(v)))];
  const invalid = ids.filter((id) => !OBJECT_ID_RE.test(id));
  if (invalid.length > 0) {
    return { ids: [], error: `Invalid email ID: ${invalid[0]}.` };
  }
  return { ids, error: null };
};

const GMAIL_TIMEOUT_MS = Number(process.env.GMAIL_TIMEOUT_MS || 20000);
const GMAIL_MESSAGE_CONCURRENCY = Number(process.env.GMAIL_SYNC_CONCURRENCY || 10);
const GMAIL_ATTACHMENT_CONCURRENCY = Number(process.env.GMAIL_ATTACHMENT_CONCURRENCY || 5);
const GMAIL_MAX_RESULTS = Number(process.env.GMAIL_MAX_RESULTS || 150);

/**
 * Every outbound Gmail call goes through here: a hard timeout (gaxios has NONE
 * by default and will wait on a hung socket forever), bounded retries with
 * exponential backoff for 429/5xx, and a circuit breaker so a Gmail outage
 * fails in microseconds instead of piling up 20-second hangs.
 *
 * @param {Function} fn - async () => gaxios response
 * @param {String} [label]
 * @returns {Promise<*>}
 */
const gmailCall = (fn, label = 'gmail') =>
  callResilient('gmail', fn, {
    timeoutMs: GMAIL_TIMEOUT_MS,
    attempts: Number(process.env.GMAIL_RETRY_ATTEMPTS || 3),
    baseDelayMs: 1000,
    failureThreshold: 8,
    resetTimeoutMs: 30000,
    label
  });

// Per-request options handed to googleapis so the SOCKET is released too, not
// just the caller's promise.
const GMAIL_REQUEST_OPTIONS = { timeout: GMAIL_TIMEOUT_MS };

/**
 * Active keyword rules, hoisted out of the per-message loop and cached.
 *
 * `KeywordRule.find({ isActive: true })` used to run once PER GMAIL MESSAGE:
 * 150 messages x N accounts every 10 minutes, plus 150 `new RegExp()`
 * compilations per sync, against an unindexed field.
 *
 * @returns {Promise<Array<{keyword: String, assignedTo: *, autoApprove: Boolean, re: RegExp}>>}
 */
const getActiveKeywordRules = async () => {
  const rules = await cache.wrap(cache.KEYS.activeRules(), cache.TTL.activeRules, () =>
    KeywordRule.find({ isActive: true }).select('keyword assignedTo autoApprove').lean()
  );

  return (rules || []).map((rule) => ({
    keyword: rule.keyword,
    assignedTo: rule.assignedTo,
    autoApprove: rule.autoApprove,
    re: new RegExp(`\\b${escapeRegex(rule.keyword)}\\b`, 'i')
  }));
};

/**
 * Resolve the Gmail credentials for `inboxEmail` from a SINGLE user document.
 *
 * There is deliberately no cross-user fallback. The previous implementation, on
 * failing to find the inbox on the calling user, searched every Admin and
 * borrowed their OAuth tokens — which let any Head send mail from the Admin's
 * real mailbox.
 *
 * @param {Object} user - User document selected with token fields
 * @param {String} inboxEmail
 * @returns {{ accessToken: String|null, refreshToken: String|null }}
 */
const resolveInboxCredentials = (user, inboxEmail) => {
  if (!user || !inboxEmail) return { accessToken: null, refreshToken: null };

  if (user.gmailEmail === inboxEmail) {
    return { accessToken: user.gmailAccessToken, refreshToken: user.gmailRefreshToken };
  }

  const linked = (user.linkedGmailAccounts || []).find((a) => a.gmailEmail === inboxEmail);
  if (linked) {
    return { accessToken: linked.gmailAccessToken, refreshToken: linked.gmailRefreshToken };
  }

  return { accessToken: null, refreshToken: null };
};

/**
 * Object-level authorization for a single Email.
 *
 * Admin may act on any email. Everyone else must own the mailbox it arrived on
 * (they fetched it). Employees additionally qualify when it is assigned to them.
 *
 * Behaviour is unchanged; the implementation moved to `utils/emailAccess.js` so
 * that F-3 (AI extraction) and F-4 (socket presence) enforce the SAME rule
 * rather than a second, separately maintained copy of it.
 *
 * `fetchedBy` / `assignedTo` may arrive as an ObjectId, as a string, or — since
 * the read paths now populate them — as a hydrated user object; the shared
 * helper resolves all three.
 *
 * @param {Object} email - Email document
 * @param {Object} user - req.user
 * @returns {Boolean}
 */
const canAccessEmail = (email, user) => emailAccess.canAccessEmail(email, user);

/**
 * Strip CR/LF from a value before it is interpolated into an RFC-2822 header,
 * so an attacker-controlled subject or address cannot inject extra headers.
 * @param {String} value
 * @returns {String}
 */
const sanitizeHeaderValue = (value) => String(value || '').replace(/[\r\n]+/g, ' ').trim();




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

/**
 * Find the data of the first part with `mimeType`. Used to pull the text/plain
 * alternative, which is what the snippet is generated from where available —
 * the HTML alternative is the one carrying megabytes of inlined base64.
 *
 * @param {Object} payload - Gmail message payload
 * @param {String} mimeType
 * @returns {String} base64url data, or ''
 */
const findPartData = (payload, mimeType) => {
  if (!payload) return '';
  if (payload.mimeType === mimeType && payload.body && payload.body.data) return payload.body.data;
  for (const part of payload.parts || []) {
    const found = findPartData(part, mimeType);
    if (found) return found;
  }
  return '';
};

/**
 * Decode a Gmail base64url payload.
 * @param {String} data
 * @returns {String}
 */
const decodeBase64Url = (data) => {
  if (!data) return '';
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
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

// Recursive helper to find all attachment parts (excluding inline images)
const getAttachmentsList = (payload) => {
  const attachments = [];

  const traverse = (part) => {
    // Regular attachments have a filename and an attachmentId
    if (part.filename && part.body && part.body.attachmentId) {
      const hasContentId = part.headers && part.headers.some(h => h.name.toLowerCase() === 'content-id');
      const isInlineImage = hasContentId && part.mimeType && part.mimeType.startsWith('image/');
      
      if (!isInlineImage) {
        attachments.push({
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType || '',
          size: part.body.size || 0
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
  return attachments;
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
    let mode = req.query.mode === 'extra' ? 'extra' : 'primary';
    if (req.user.role === 'Head') {
      mode = 'primary';
    }
    
    const jwt = require('jsonwebtoken');
    const statePayload = jwt.sign(
      { userId: req.user._id.toString(), mode },
      process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state: statePayload
    });

    return res.status(200).json({ authUrl });
  } catch (error) {
    logger.error({ err: error.message }, 'failed to generate Google auth URL');
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

    // Decode and verify state JWT
    let userId;
    let mode;
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(state, process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET);
      userId = decoded.userId;
      mode = decoded.mode;
    } catch (err) {
      logger.warn({ err: err.message }, 'OAuth callback state validation failed');
      return res.status(400).send('Authorization failed. Invalid or expired state parameter.');
    }

    let isExtra = mode === 'extra';

    const oauth2Client = getOAuth2Client();

    // Exchange code for access and refresh tokens. Wrapped so a hung Google
    // token endpoint cannot pin the callback request indefinitely.
    const { tokens } = await gmailCall(() => oauth2Client.getToken(code), 'oauth.getToken');
    oauth2Client.setCredentials(tokens);
    
    // Find user using Mongoose ID passed via OAuth 'state'
    const user = await User.findById(userId).select('+gmailAccessToken +gmailRefreshToken +linkedGmailAccounts');
    if (!user) {
      return res.status(404).send('User associated with OAuth session not found.');
    }

    // Admins and Heads can connect Gmail accounts
    if (user.role !== 'Admin' && user.role !== 'Head') {
      return res.status(403).send('Access denied. Only Admin and Head users are authorized to connect Gmail accounts.');
    }

    // Force primary mode for Head role
    if (user.role === 'Head') {
      isExtra = false;
    }

    // Call Gmail API to fetch the user's profile and actual Gmail email address
    let gmailAddress = "";
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const profile = await gmailCall(
        () => gmail.users.getProfile({ userId: 'me' }, GMAIL_REQUEST_OPTIONS),
        'users.getProfile'
      );
      gmailAddress = profile.data.emailAddress || "";
    } catch (apiErr) {
      logger.error({ err: apiErr.message }, 'failed to fetch Gmail profile during OAuth');
    }

    if (!gmailAddress) {
      return res.status(400).send('Failed to fetch Gmail profile email address. Please make sure Gmail access is enabled.');
    }

    // Check Head role access restrictions
    if (user.role === 'Head') {
      const allowedList = (user.allowedGmailAccounts || []).map(e => e.toLowerCase().trim()).filter(Boolean);
      if (allowedList.length > 0 && !allowedList.includes(gmailAddress.toLowerCase().trim())) {
        return res.status(403).send(`Access denied. Admin has not authorized the Gmail account (${gmailAddress}) for your Head user profile.`);
      }

      const isExistingAccount = user.gmailEmail === gmailAddress || (user.linkedGmailAccounts || []).some(a => a.gmailEmail === gmailAddress);
      const currentAccountCount = (user.gmailEmail ? 1 : 0) + (user.linkedGmailAccounts ? user.linkedGmailAccounts.length : 0);
      const maxLimit = user.maxConnectedAccounts !== undefined ? user.maxConnectedAccounts : 5;

      if (!isExistingAccount && currentAccountCount >= maxLimit) {
        return res.status(403).send(`Account limit reached. Admin has restricted your Head account to a maximum of ${maxLimit} connected Gmail account(s).`);
      }
    }

    // Enforce uniqueness AT THE SOURCE rather than destroying tokens later.
    // Two users connecting the same shared mailbox is what made the old
    // deduplicateConnections() sweep silently disconnect one of them.
    const claimedByOther = await User.findOne({
      _id: { $ne: user._id },
      deletedAt: null,
      $or: [{ gmailEmail: gmailAddress }, { 'linkedGmailAccounts.gmailEmail': gmailAddress }]
    }).select('name email');

    if (claimedByOther) {
      return res
        .status(409)
        .send(
          `This Gmail account (${gmailAddress}) is already connected by another user (${claimedByOther.name}). ` +
            `Ask an administrator to disconnect it there first.`
        );
    }

    if (isExtra) {
      // Store as a linked (extra) account — do not overwrite primary tokens
      const alreadyLinked = user.linkedGmailAccounts.some(a => a.gmailEmail === gmailAddress);
      if (!alreadyLinked) {
        user.linkedGmailAccounts.push({
          gmailEmail: gmailAddress,
          gmailAccessToken: encrypt(tokens.access_token),
          gmailRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null
        });
        user.markModified('linkedGmailAccounts');
        await user.save();
        logger.info({ gmailAddress, userId: String(user._id) }, 'linked extra Gmail account');
        // Only the ADDRESS is recorded. The OAuth tokens that were just written
        // to the document must never reach the audit trail — the logger would
        // redact them, but they are not passed in the first place.
        await logActivity(user._id, 'Gmail Link Extra', `Linked extra Gmail account: ${gmailAddress}`, {
          req,
          targetType: 'User',
          targetId: user._id,
          targetLabel: gmailAddress
        });
      } else {
        // Update tokens if account already exists
        const acct = user.linkedGmailAccounts.find(a => a.gmailEmail === gmailAddress);
        if (acct) {
          acct.gmailAccessToken = encrypt(tokens.access_token);
          if (tokens.refresh_token) acct.gmailRefreshToken = encrypt(tokens.refresh_token);
        }
        user.markModified('linkedGmailAccounts');
        await user.save();
        logger.info({ gmailAddress }, 'refreshed tokens for linked account');
      }
    } else {
      // Save as primary Gmail account
      const previousPrimary = user.gmailEmail || null;
      user.gmailAccessToken = encrypt(tokens.access_token);
      if (tokens.refresh_token) {
        user.gmailRefreshToken = encrypt(tokens.refresh_token);
      }
      user.gmailEmail = gmailAddress;
      await user.save();
      logger.info({ userId: String(user._id) }, 'saved primary Google credentials');
      // ADDRESSES ONLY — the token fields written above are never passed here.
      await logActivity(user._id, 'Gmail Connection', `Connected Gmail account: ${gmailAddress}`, {
        req,
        targetType: 'User',
        targetId: user._id,
        targetLabel: gmailAddress,
        before: { gmailEmail: previousPrimary },
        after: { gmailEmail: gmailAddress }
      });
    }

    // No workspace-wide de-duplication sweep here: the uniqueness check above
    // prevents the duplicate from being created in the first place, and the
    // sweep is now an explicit Admin action (POST /api/gmail/deduplicate).

    // Redirect to inbox so user sees the new account immediately
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.redirect(`${frontendUrl}/inbox?gmail=connected`);
  } catch (error) {
    logger.error({ err: error.message }, 'OAuth callback exchange failed');
    return res.status(500).send('Failed to complete Google authentication. Please try again.');
  }
};

/**
 * Persist tokens produced by a silent refresh, ATOMICALLY.
 *
 * The old `oauth2Client.on('tokens')` handler mutated the shared `user`
 * document and called `await user.save()` from inside an async event listener.
 * The listener was registered once per account inside a loop over that same
 * document, so N listeners accumulated and concurrent refreshes raced into
 * Mongoose's `ParallelSaveError` — and each save rewrote the ENTIRE user
 * document including every linked account.
 *
 * A targeted `updateOne` touches exactly the one field that changed.
 *
 * @param {String} userId
 * @param {String} inboxEmail
 * @param {Boolean} isPrimary
 * @param {Object} newTokens
 * @returns {Promise<void>}
 */
const persistRefreshedTokens = async (userId, inboxEmail, isPrimary, newTokens) => {
  if (!newTokens || !newTokens.access_token) return;

  const set = {};
  if (isPrimary) {
    set.gmailAccessToken = encrypt(newTokens.access_token);
    if (newTokens.refresh_token) set.gmailRefreshToken = encrypt(newTokens.refresh_token);
    await User.updateOne({ _id: userId }, { $set: set });
  } else {
    set['linkedGmailAccounts.$.gmailAccessToken'] = encrypt(newTokens.access_token);
    if (newTokens.refresh_token) {
      set['linkedGmailAccounts.$.gmailRefreshToken'] = encrypt(newTokens.refresh_token);
    }
    await User.updateOne({ _id: userId, 'linkedGmailAccounts.gmailEmail': inboxEmail }, { $set: set });
  }

  // Cache the live access token until just before it expires, so repeated syncs
  // in the same window skip the database entirely. Stored ENCRYPTED: a cache is
  // not a place to keep a bearer token in the clear.
  const expiry = Number(newTokens.expiry_date || 0);
  const ttlSeconds = expiry ? Math.floor((expiry - Date.now()) / 1000) - 60 : 0;
  if (ttlSeconds > 30) {
    await cache.set(
      cache.KEYS.gmailToken(String(userId), inboxEmail),
      { accessToken: encrypt(newTokens.access_token), expiry },
      ttlSeconds
    );
  }
};

/**
 * Build an authenticated Gmail client for one mailbox.
 * @param {Object} params
 * @returns {{gmail: Object, oauth2Client: Object}}
 */
const buildGmailClient = ({ userId, accessToken, refreshToken, inboxEmail, isPrimary }) => {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

  // Listener registered once per client (not once per account on a shared
  // document) and never awaited inside the event handler.
  oauth2Client.on('tokens', (newTokens) => {
    persistRefreshedTokens(userId, inboxEmail, isPrimary, newTokens).catch((err) =>
      logger.warn({ err: err.message, inboxEmail }, 'failed to persist refreshed Gmail tokens')
    );
  });

  return { oauth2Client, gmail: google.gmail({ version: 'v1', auth: oauth2Client }) };
};

/**
 * Turn one Gmail message into an Email document body.
 *
 * Pure apart from the inline-image fetches, which are bounded by their own
 * concurrency limiter.
 *
 * @param {Object} args
 * @returns {Promise<Object>} an Email document body
 */
const buildEmailDocument = async ({ gmail, message, inboxEmail, userId, rules, clientMatcher, attachmentLimit }) => {
  const msgDetails = await gmailCall(
    () => gmail.users.messages.get({ userId: 'me', id: message.id }, GMAIL_REQUEST_OPTIONS),
    'messages.get'
  );

  const payload = msgDetails.data.payload || {};
  const headers = payload.headers;
  const labelIds = msgDetails.data.labelIds || [];

  const subject = getHeader(headers, 'subject') || '(No Subject)';
  const from = getHeader(headers, 'from') || 'Unknown Sender';
  const dateStr = getHeader(headers, 'date');
  const date = dateStr ? new Date(dateStr) : new Date();

  // F-1: the threading headers. `threadId` in particular was already available
  // on every message and was simply discarded, which is why a conversation
  // rendered as N unrelated rows.
  const threadId = msgDetails.data.threadId || message.threadId || null;
  const rfcMessageId = getHeader(headers, 'message-id') || null;
  const inReplyTo = getHeader(headers, 'in-reply-to') || null;
  const references = parseReferences(getHeader(headers, 'references'));

  let decodedBody = decodeBase64Url(getBodyText(payload));
  // The text/plain alternative is the cheap, image-free source for the snippet.
  const plainText = decodeBase64Url(findPartData(payload, 'text/plain'));

  // Inline images: fetched in parallel (bounded) rather than one blocking round
  // trip after another.
  const inlineImages = getInlineImages(payload);
  if (inlineImages.length > 0 && decodedBody) {
    const fetched = await Promise.all(
      inlineImages.map((img) =>
        attachmentLimit(async () => {
          if (img.data) return { img, data: img.data };
          if (!img.attachmentId) return { img, data: '' };
          try {
            const attachRes = await gmailCall(
              () =>
                gmail.users.messages.attachments.get(
                  { userId: 'me', messageId: message.id, id: img.attachmentId },
                  GMAIL_REQUEST_OPTIONS
                ),
              'attachments.get'
            );
            return { img, data: attachRes.data.data || '' };
          } catch (err) {
            logger.warn({ err: err.message, contentId: img.contentId }, 'failed to fetch inline image');
            return { img, data: '' };
          }
        })
      )
    );

    for (const { img, data } of fetched) {
      if (!data) continue;
      const dataUrl = `data:${img.mimeType};base64,${String(data).replace(/-/g, '+').replace(/_/g, '/')}`;
      const escapedCid = img.contentId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      decodedBody = decodedBody.replace(new RegExp(`cid:<?${escapedCid}>?`, 'gi'), dataUrl);
    }
  }

  const attachments = getAttachmentsList(payload);

  // Keyword rules: pre-compiled and hoisted; no query, no RegExp construction
  // inside the loop.
  let matchedKeyword = null;
  let suggestedAssignedTo = null;
  let approvalStatus = 'none';
  let assignedTo = null;
  let status = 'unassigned';

  if (rules.length > 0) {
    const textToSearch = `${subject} ${decodedBody}`;
    for (const rule of rules) {
      if (!rule.re.test(textToSearch)) continue;
      matchedKeyword = rule.keyword;
      suggestedAssignedTo = rule.assignedTo;
      if (rule.autoApprove) {
        assignedTo = rule.assignedTo;
        status = 'assigned';
        approvalStatus = 'approved';
      } else {
        approvalStatus = 'pending';
      }
      break;
    }
  }

  // Inbound Gmail HTML is fully attacker controlled and was previously stored
  // and served verbatim, giving anyone on the internet a stored-XSS primitive
  // against every Admin/Head/Employee who opened the mail. Sanitize BEFORE it
  // is persisted; keep the original only in `bodyRaw`, which is `select:false`
  // and therefore never returned by any query that does not ask for it.
  const safeBody = sanitizeEmailHtml(decodedBody);
  const { clientId } = await resolveClientForSender(from, clientMatcher);

  return {
    messageId: message.id,
    threadId,
    rfcMessageId,
    inReplyTo,
    references,
    // Everything the sync ingests arrived in one of our mailboxes. Outbound
    // rows are written only by replyToEmail.
    direction: 'inbound',
    subject,
    from,
    date,
    body: safeBody,
    bodyRaw: decodedBody,
    // Generated once, here, so no list response ever needs the body.
    snippet: makeSnippet(safeBody, plainText),
    status,
    assignedTo,
    fetchedBy: userId,
    labelIds,
    toEmail: inboxEmail,
    attachments,
    matchedKeyword,
    suggestedAssignedTo,
    approvalStatus,
    clientId,
    fetchedAt: new Date()
  };
};

/**
 * Sync one mailbox.
 *
 * Was: 150 SEQUENTIAL `messages.get` calls at ~200 ms each (about 30 s per
 * account), one `KeywordRule.find` per message, one `Client.find({})` per
 * assigned message, and one `save()` per email — with no per-message try/catch,
 * so a single poisoned message aborted the rest of the account.
 *
 * Now: bounded-concurrency fetches, hoisted rules and client matcher, one
 * `insertMany({ ordered: false })`, one bulk task upsert, and per-message
 * isolation.
 *
 * @param {Object} params
 * @returns {Promise<{inbox: String, newCount: Number, failed: Number, scanned: Number}>}
 */
const syncAccountEmails = async ({ userId, accessToken, refreshToken, inboxEmail, isPrimary, onProgress }) => {
  const { gmail } = buildGmailClient({ userId, accessToken, refreshToken, inboxEmail, isPrimary });

  const listRes = await gmailCall(
    () =>
      gmail.users.messages.list(
        { userId: 'me', maxResults: GMAIL_MAX_RESULTS, includeSpamTrash: true },
        GMAIL_REQUEST_OPTIONS
      ),
    'messages.list'
  );

  const messages = listRes.data.messages || [];
  if (messages.length === 0) return { inbox: inboxEmail, newCount: 0, failed: 0, scanned: 0 };

  // One indexed query instead of a per-message existence check.
  const messageIds = messages.map((m) => m.id);
  const existingIds = new Set(await Email.distinct('messageId', { messageId: { $in: messageIds } }));
  const pending = messages.filter((m) => !existingIds.has(m.id));

  logger.info({ inbox: inboxEmail, listed: messages.length, new: pending.length }, 'gmail sync starting');
  if (pending.length === 0) return { inbox: inboxEmail, newCount: 0, failed: 0, scanned: messages.length };

  const [rules, clientMatcher] = await Promise.all([getActiveKeywordRules(), getClientMatcher()]);

  const messageLimit = pLimit(GMAIL_MESSAGE_CONCURRENCY);
  const attachmentLimit = pLimit(GMAIL_ATTACHMENT_CONCURRENCY);

  let processed = 0;
  let failed = 0;

  const settled = await Promise.all(
    pending.map((message) =>
      messageLimit(async () => {
        try {
          const doc = await buildEmailDocument({
            gmail,
            message,
            inboxEmail,
            userId,
            rules,
            clientMatcher,
            attachmentLimit
          });
          return doc;
        } catch (err) {
          // Per-message isolation: one bad message must not kill the batch.
          failed += 1;
          logger.warn({ err: err.message, messageId: message.id, inbox: inboxEmail }, 'skipping message');
          return null;
        } finally {
          processed += 1;
          if (onProgress && processed % 10 === 0) {
            onProgress({ inbox: inboxEmail, processed, total: pending.length });
          }
        }
      })
    )
  );

  const docs = settled.filter(Boolean);
  if (docs.length === 0) return { inbox: inboxEmail, newCount: 0, failed, scanned: messages.length };

  // `ordered: false` makes a duplicate messageId (two syncs racing, or two
  // replicas on the same cron tick) SKIP rather than abort the whole batch.
  let inserted = 0;
  try {
    const result = await Email.insertMany(docs, { ordered: false, rawResult: true });
    inserted = result.insertedCount ?? docs.length;
  } catch (err) {
    inserted = err.result?.insertedCount ?? err.insertedDocs?.length ?? 0;
    if (err.code !== 11000 && !err.writeErrors) {
      logger.error({ err: err.message, inbox: inboxEmail }, 'insertMany failed');
    }
  }

  // F-1: `threadPosition` cannot be assigned inside the batch (Gmail does not
  // hand us a conversation in date order, and two replicas can insert into the
  // same thread at once), so it is derived from `date` immediately after the
  // write. Idempotent, and bounded to the threads this batch actually touched.
  try {
    await resyncThreadPositions(docs.map((d) => d.threadId));
  } catch (err) {
    logger.warn({ err: err.message, inbox: inboxEmail }, 'thread position resync failed');
  }

  // Tasks for auto-approved assignments, in ONE bulkWrite. Re-queried so the
  // ids are correct even when part of the insert was skipped as a duplicate.
  const assignedMessageIds = docs.filter((d) => d.status === 'assigned' && d.assignedTo).map((d) => d.messageId);
  if (assignedMessageIds.length > 0) {
    const saved = await Email.find({ messageId: { $in: assignedMessageIds } })
      .select('_id from subject snippet matchedKeyword fetchedBy assignedTo')
      .lean();
    await ensureTasksForEmails(
      saved
        .filter((e) => e.assignedTo)
        .map((e) => ({ email: e, assignedUserId: e.assignedTo, createdById: userId }))
    );
  }

  logger.info({ inbox: inboxEmail, inserted, failed }, 'gmail sync finished');
  return { inbox: inboxEmail, newCount: inserted, failed, scanned: messages.length };
};

/**
 * Resolve the credential set for every mailbox on a user document.
 * @param {Object} user - selected with token fields
 * @returns {Array<{inboxEmail: String, accessToken: String, refreshToken: String, isPrimary: Boolean}>}
 */
const collectMailboxes = (user) => {
  const mailboxes = [];

  if (user.gmailAccessToken && user.gmailEmail) {
    // tryDecrypt, not decrypt: one unreadable token must not abort every other
    // mailbox in the workspace.
    const accessToken = tryDecrypt(user.gmailAccessToken);
    if (accessToken) {
      mailboxes.push({
        inboxEmail: user.gmailEmail,
        accessToken,
        refreshToken: tryDecrypt(user.gmailRefreshToken),
        isPrimary: true
      });
    } else {
      logger.error({ userId: String(user._id), inbox: user.gmailEmail }, 'primary Gmail token could not be decrypted');
    }
  }

  for (const acct of user.linkedGmailAccounts || []) {
    if (!acct.gmailAccessToken) continue;
    const accessToken = tryDecrypt(acct.gmailAccessToken);
    if (!accessToken) {
      logger.error({ userId: String(user._id), inbox: acct.gmailEmail }, 'linked Gmail token could not be decrypted');
      continue;
    }
    mailboxes.push({
      inboxEmail: acct.gmailEmail,
      accessToken,
      refreshToken: tryDecrypt(acct.gmailRefreshToken),
      isPrimary: false
    });
  }

  return mailboxes;
};

/**
 * Classify a mailbox sync failure into something a user can act on.
 *
 * `invalid_grant` in production means the refresh token was revoked, the Google
 * password changed, or consent expired — all routine in a real office, and all
 * of them require a human to reconnect the mailbox. Retrying will never fix it,
 * so it must not be reported like a transient network blip.
 *
 * @param {String} message
 * @returns {{code: String, retryable: Boolean, hint: String}}
 */
const classifySyncError = (message) => {
  const text = String(message || '');
  if (/invalid_grant|invalid_client|unauthorized_client|invalid_token|Token has been expired or revoked/i.test(text)) {
    return {
      code: 'REAUTH_REQUIRED',
      retryable: false,
      hint: 'Google rejected the stored credentials. Reconnect this mailbox from Profile → Connected Gmail.'
    };
  }
  if (/insufficient|forbidden|403/i.test(text)) {
    return { code: 'PERMISSION_DENIED', retryable: false, hint: 'Google refused access to this mailbox.' };
  }
  if (/rate|quota|429|userRateLimitExceeded/i.test(text)) {
    return { code: 'RATE_LIMITED', retryable: true, hint: 'Google is rate limiting this mailbox. It will be retried.' };
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|socket hang up/i.test(text)) {
    return { code: 'NETWORK', retryable: true, hint: 'Could not reach Google. It will be retried.' };
  }
  return { code: 'SYNC_FAILED', retryable: true, hint: 'The mailbox could not be synced.' };
};

/**
 * One line of prose describing a sync outcome, for the toast and the audit
 * trail. Deliberately distinguishes the three cases the old code collapsed into
 * "Found 0 new emails":
 *
 *   nothing new          — every mailbox answered, none had new mail
 *   partial failure      — some mailboxes answered, some did not
 *   total failure        — no mailbox could be reached at all
 *
 * @param {Object} summary
 * @returns {String}
 */
const describeSyncSummary = (summary) => {
  const { syncStatus, attempted, succeeded, failed, newCount, accounts } = summary;
  const failedNames = accounts.filter((a) => !a.ok).map((a) => a.inbox).filter(Boolean).join(', ');

  if (syncStatus === 'no_accounts') return 'No Gmail mailbox is connected, so nothing was synced.';
  if (syncStatus === 'failed') {
    return attempted === 1
      ? `Could not sync ${failedNames || 'the mailbox'} — reconnect the mailbox.`
      : `Could not reach any of the ${attempted} connected mailboxes (${failedNames}).`;
  }
  if (syncStatus === 'partial') {
    return `${newCount} new email(s) from ${succeeded} of ${attempted} mailboxes. ${failed} failed: ${failedNames}.`;
  }
  return newCount > 0 ? `Found ${newCount} new email(s).` : 'No new mail; every mailbox is up to date.';
};

/**
 * Sync every mailbox for one user. Runs inside a queue worker, never inside an
 * HTTP request.
 *
 * H-1 — this used to return a bare `Number` and throw the per-account errors
 * away. With all four seeded mailboxes answering `invalid_grant`, the worker
 * logged four failures, returned 0, and the product told the user
 * "Inbox is already up to date" with a green tick while the Activity Log
 * recorded an ordinary "Gmail Fetch Auto". Mail silently stopped arriving and
 * the audit trail agreed that it had not. The failure is expected on dead demo
 * tokens; the LIE is the defect.
 *
 * It now returns a summary that distinguishes "nothing new" from "could not
 * reach any mailbox", carries the per-account outcome so one dead account among
 * four is visible, logs at error level when everything failed, and writes an
 * activity row that says so.
 *
 * @param {Object} user - user document selected with token fields
 * @param {Boolean} [isManual]
 * @param {Function} [onProgress]
 * @returns {Promise<{newCount: Number, syncStatus: String, ok: Boolean,
 *   attempted: Number, succeeded: Number, failed: Number, message: String,
 *   accounts: Array<Object>}>}
 */
const syncUserEmails = async (user, isManual = false, onProgress = null) => {
  if (!user) throw new Error('Invalid user.');

  const mailboxes = collectMailboxes(user);

  if (mailboxes.length === 0) {
    const summary = {
      newCount: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      syncStatus: 'no_accounts',
      ok: true,
      accounts: []
    };
    summary.message = describeSyncSummary(summary);
    return summary;
  }

  // Accounts are independent, so they run concurrently — but bounded, because
  // each one is already issuing up to GMAIL_SYNC_CONCURRENCY requests.
  const accountLimit = pLimit(Number(process.env.GMAIL_ACCOUNT_CONCURRENCY || 2));

  const results = await Promise.all(
    mailboxes.map((mailbox) =>
      accountLimit(async () => {
        try {
          const result = await syncAccountEmails({ userId: user._id, ...mailbox, onProgress });
          return { ...result, ok: true, error: null, errorCode: null, hint: null };
        } catch (err) {
          const classified = classifySyncError(err.message);
          logger.error(
            { err: err.message, code: classified.code, inbox: mailbox.inboxEmail, userId: String(user._id) },
            'mailbox sync failed'
          );
          return {
            inbox: mailbox.inboxEmail,
            newCount: 0,
            failed: 0,
            scanned: 0,
            ok: false,
            error: err.message,
            errorCode: classified.code,
            hint: classified.hint
          };
        }
      })
    )
  );

  const accounts = results.map((r) => ({
    inbox: r.inbox,
    ok: r.ok,
    newCount: r.newCount || 0,
    scanned: r.scanned || 0,
    // Messages that could not be persisted, distinct from a whole-mailbox failure.
    skipped: r.failed || 0,
    error: r.error || null,
    errorCode: r.errorCode || null,
    hint: r.hint || null
  }));

  const succeeded = accounts.filter((a) => a.ok).length;
  const failed = accounts.length - succeeded;
  const totalNew = accounts.reduce((sum, a) => sum + a.newCount, 0);

  const summary = {
    newCount: totalNew,
    attempted: accounts.length,
    succeeded,
    failed,
    // 'ok' | 'partial' | 'failed'. A sync where EVERY mailbox failed is a
    // failure, whatever the transport said.
    syncStatus: succeeded === 0 ? 'failed' : failed > 0 ? 'partial' : 'ok',
    ok: succeeded > 0,
    accounts
  };
  summary.message = describeSyncSummary(summary);

  if (totalNew > 0) {
    // New mail invalidates every dashboard and report aggregate.
    await cache.invalidateStats();
  }

  // Record the outcome on the user so GET /api/gmail/status can stop claiming
  // "Connected" for a mailbox Google is refusing. Best effort: a health write
  // must never be the reason a sync is reported as failed.
  try {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          gmailSyncHealth: accounts.map((a) => ({
            gmailEmail: a.inbox,
            ok: a.ok,
            errorCode: a.errorCode,
            error: a.ok ? null : String(a.error || '').slice(0, 300),
            at: new Date()
          })),
          lastGmailSyncAt: new Date(),
          lastGmailSyncStatus: summary.syncStatus
        }
      }
    );
  } catch (err) {
    logger.warn({ err: err.message, userId: String(user._id) }, 'could not record gmail sync health');
  }

  if (summary.syncStatus === 'failed') {
    logger.error(
      {
        userId: String(user._id),
        attempted: summary.attempted,
        inboxes: accounts.map((a) => a.inbox),
        codes: [...new Set(accounts.map((a) => a.errorCode).filter(Boolean))]
      },
      'gmail sync failed for EVERY connected mailbox'
    );
  } else if (summary.syncStatus === 'partial') {
    logger.warn(
      { userId: String(user._id), failed: summary.failed, attempted: summary.attempted },
      'gmail sync failed for some mailboxes'
    );
  }

  // NO `req`: this runs inside the gmail-sync queue worker (and the cron job),
  // so there genuinely is no client IP or user agent to record. Leaving them
  // null is the accurate answer; the actor's last request address would be a
  // fabrication. The target is the mailbox set that was synced.
  //
  // The action string now carries the outcome, so the Activity Log's own filter
  // can separate a failed sync from a successful one instead of showing four
  // dead mailboxes as an ordinary "Gmail Fetch Auto".
  const baseAction = isManual ? 'Gmail Fetch' : 'Gmail Fetch Auto';
  await logActivity(
    user._id,
    summary.syncStatus === 'failed' ? `${baseAction} Failed` : baseAction,
    `${isManual ? 'Manual' : 'Automatic'} Gmail sync — ${summary.message}`,
    {
      targetType: 'User',
      targetId: user._id,
      targetLabel: mailboxes.map((m) => m.inboxEmail).filter(Boolean).join(', '),
      after: {
        syncStatus: summary.syncStatus,
        attempted: summary.attempted,
        succeeded: summary.succeeded,
        failed: summary.failed,
        newCount: summary.newCount,
        failedInboxes: accounts.filter((a) => !a.ok).map((a) => a.inbox)
      }
    }
  );

  return summary;
};

// Export for the queue worker and the cron job.
exports.syncUserEmails = syncUserEmails;
exports.classifySyncError = classifySyncError;

/**
 * The unit of work the `gmail-sync` queue processes.
 *
 * H-1: the job result now carries the whole outcome, not just a count. It
 * deliberately does NOT throw when every mailbox failed — throwing would lose
 * the per-account detail the UI needs to say WHICH mailbox to reconnect, and
 * would burn three BullMQ retries on an `invalid_grant` that no retry can fix.
 * The truth is transported in the result instead: `ok: false`,
 * `syncStatus: 'failed'`, and a populated `error`.
 *
 * @param {{userId: String, isManual: Boolean}} data
 * @param {Object} [context] - queue job context
 * @returns {Promise<Object>} the sync summary
 */
exports.runGmailSyncJob = async (data, context) => {
  const user = await User.findOne({ _id: data.userId, deletedAt: null }).select(
    '+gmailAccessToken +gmailRefreshToken +linkedGmailAccounts'
  );
  if (!user) throw new Error(`User ${data.userId} not found for Gmail sync.`);

  const onProgress = context?.updateProgress
    ? ({ processed, total }) => {
        context.updateProgress(total > 0 ? Math.round((processed / total) * 100) : 0);
      }
    : null;

  const summary = await syncUserEmails(user, Boolean(data.isManual), onProgress);
  return { userId: String(user._id), email: user.email, ...summary };
};

// @desc    Queue a Gmail sync for the caller's connected accounts
// @route   POST /api/gmail/fetch
// @access  Private (Admin, Head)
// @returns 202 { message, jobId, jobIds, accepted, status }
exports.fetchEmails = async (req, res) => {
  try {
    // The sync no longer runs inline. Sequentially syncing an Admin's ten
    // connected accounts took four to six minutes inside one HTTP request —
    // long past every reverse-proxy read timeout (nginx 60s, ALB 60s, Heroku
    // 30s), so the client saw a 502 while the work carried on server-side.
    let targets = [];

    if (req.user.role === 'Admin') {
      targets = await User.find({
        deletedAt: null,
        $or: [
          { gmailAccessToken: { $exists: true, $nin: [null, ''] } },
          { 'linkedGmailAccounts.0': { $exists: true } }
        ]
      })
        .select('_id email')
        .lean();
    } else {
      const user = await User.findOne({ _id: req.user._id, deletedAt: null })
        .select('_id email gmailAccessToken +linkedGmailAccounts')
        .lean();
      if (!user || (!user.gmailAccessToken && !(user.linkedGmailAccounts || []).length)) {
        return res.status(400).json({ message: 'Gmail account not connected. Please authenticate first.' });
      }
      targets = [user];
    }

    if (targets.length === 0) {
      return res.status(400).json({ message: 'No connected Gmail accounts found to synchronise.' });
    }

    // enqueueUnique makes a double-clicked "Fetch" idempotent: the second click
    // gets the id of the job the first one started instead of racing it.
    const jobs = [];
    for (const target of targets) {
      jobs.push(
        await queue.enqueueUnique(
          queue.QUEUES.GMAIL_SYNC,
          String(target._id),
          { userId: String(target._id), isManual: true, requestedBy: String(req.user._id) },
          { attempts: Number(process.env.GMAIL_JOB_ATTEMPTS || 3), backoffMs: 10000 }
        )
      );
    }

    /*
     * H-1 — give the caller the OUTCOME, not just a receipt.
     *
     * The endpoint used to 202 the instant the job was enqueued and nothing
     * ever propagated the worker's terminal failure back, so the UI showed a
     * green "Inbox is already up to date" while all four mailboxes were
     * answering `invalid_grant`. A sync that finishes inside
     * GMAIL_INLINE_WAIT_MS (the overwhelmingly common case — the audit's failing
     * sync took ~450 ms) now returns its real result in this same response.
     *
     * The HTTP status stays 202 and every pre-existing field keeps its meaning,
     * so this is purely additive: a caller that still only polls
     * GET /api/gmail/sync/:jobId is unaffected.
     */
    const inlineWaitMs = Number(process.env.GMAIL_INLINE_WAIT_MS || 8000);
    const settled = await Promise.all(
      jobs.map(async (job) => {
        try {
          return await queue.waitForJob(job.jobId, inlineWaitMs);
        } catch {
          return null;
        }
      })
    );

    const finished = settled.filter((s) => s && (s.state === queue.STATES.COMPLETED || s.state === queue.STATES.FAILED));
    const complete = finished.length === jobs.length;

    const accounts = finished.flatMap((s) => s.result?.accounts || []);
    const newEmails = finished.reduce((sum, s) => sum + (s.result?.newCount || 0), 0);
    const jobFailed = finished.some((s) => s.state === queue.STATES.FAILED);
    const attempted = finished.reduce((sum, s) => sum + (s.result?.attempted || 0), 0);
    const succeeded = finished.reduce((sum, s) => sum + (s.result?.succeeded || 0), 0);

    let syncStatus = null;
    if (complete) {
      if (jobFailed) syncStatus = 'failed';
      else if (attempted === 0) syncStatus = 'no_accounts';
      else if (succeeded === 0) syncStatus = 'failed';
      else syncStatus = succeeded < attempted ? 'partial' : 'ok';
    }

    const failedInboxes = accounts.filter((a) => !a.ok).map((a) => a.inbox).filter(Boolean);
    const outcomeMessage = !complete
      ? null
      : syncStatus === 'failed'
      ? attempted <= 1
        ? `Could not sync ${failedInboxes[0] || 'the mailbox'} — reconnect the mailbox.`
        : `Could not reach any of the ${attempted} connected mailboxes (${failedInboxes.join(', ')}).`
      : syncStatus === 'partial'
      ? `${newEmails} new email(s). ${failedInboxes.length} mailbox(es) failed: ${failedInboxes.join(', ')}.`
      : syncStatus === 'no_accounts'
      ? 'No Gmail mailbox is connected, so nothing was synced.'
      : newEmails > 0
      ? `Found ${newEmails} new email(s).`
      : 'No new mail; every mailbox is up to date.';

    /*
     * A sync we KNOW failed for every mailbox is not "Accepted". 502 is the
     * accurate code — the upstream (Gmail) refused — and it is what makes this
     * fix self-sufficient: the existing client already renders a failed POST as
     * `toast.error('Sync failed', { description: <message> })`, so the green
     * "Inbox is already up to date" cannot survive this change even before the
     * UI is updated to read `accounts[]`.
     *
     * A PARTIAL failure stays 202: some mail really did arrive, and the detail
     * is in `accounts[]` and `failedAccounts`.
     */
    const totalFailure = complete && syncStatus === 'failed';
    const httpStatus = totalFailure ? 502 : 202;

    return res.status(httpStatus).json({
      message: complete
        ? outcomeMessage
        : `Gmail sync queued for ${jobs.length} account holder(s). Poll GET /api/gmail/sync/:jobId for progress.`,
      status: complete ? (totalFailure ? 'failed' : 'completed') : 'queued',
      accepted: jobs.length,
      jobId: jobs[0].jobId,
      jobIds: jobs.map((j) => j.jobId),
      deduped: jobs.every((j) => j.deduped),
      // --- H-1 additions. Null while the outcome is still unknown. ---------
      ok: complete ? !totalFailure : null,
      syncStatus,
      // `count` is the field the inbox toast reads. It is null — NEVER 0 —
      // whenever the outcome is unknown or bad, so "no new mail" cannot be
      // rendered for a sync that did not succeed.
      count: complete && !totalFailure ? newEmails : null,
      newEmails: complete && !totalFailure ? newEmails : null,
      attemptedAccounts: complete ? attempted : null,
      succeededAccounts: complete ? succeeded : null,
      failedAccounts: complete ? attempted - succeeded : null,
      // Per-mailbox outcome: [{ inbox, ok, newCount, scanned, skipped, error,
      // errorCode, hint }]. One dead account among four is visible here.
      accounts: complete ? accounts : null,
      error: totalFailure ? outcomeMessage : null
    });
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'failed to queue Gmail sync');
    return res.status(500).json({ message: 'Server error. Failed to queue the email sync.' });
  }
};

// @desc    Poll the status of a queued Gmail sync
// @route   GET /api/gmail/sync/:jobId
// @access  Private (Admin, Head)
exports.getSyncJobStatus = async (req, res) => {
  try {
    const status = await queue.getJobStatus(req.params.jobId);
    if (!status) {
      return res.status(404).json({ message: 'Sync job not found or expired.' });
    }

    const result = status.result || null;
    const finished = status.state === 'completed' || status.state === 'failed';

    /*
     * H-1. The old body carried `newEmails: 0, error: null` for a sync in which
     * every mailbox had answered `invalid_grant`, so the client rendered a
     * green "Inbox is already up to date". The three cases are now distinct:
     *
     *   syncStatus 'ok'          every mailbox answered (newEmails may be 0)
     *   syncStatus 'partial'     some mailboxes failed — `accounts` says which
     *   syncStatus 'failed'      no mailbox could be reached at all
     *   syncStatus 'no_accounts' nothing is connected
     *
     * `ok` is false for 'failed', and `error` is populated, so a client that
     * only reads `error` still surfaces the failure. Every field is additive:
     * `status`, `newEmails`, `progress`, `attempts` and `error` keep their
     * previous meanings.
     */
    const jobFailed = status.state === 'failed';
    const syncStatus = jobFailed ? 'failed' : result?.syncStatus ?? (finished ? 'ok' : null);
    const ok = jobFailed ? false : result?.ok ?? null;
    const message = jobFailed
      ? 'The sync job did not complete. Please try again.'
      : result?.message ?? null;

    return res.status(200).json({
      jobId: status.jobId,
      // 'queued' | 'active' | 'completed' | 'failed'
      status: status.state,
      progress: status.progress || 0,
      attempts: status.attemptsMade,
      // Present only once state === 'completed'.
      newEmails: result?.newCount ?? null,
      // --- H-1 additions -------------------------------------------------
      // Null until the job finishes.
      ok,
      syncStatus,
      message,
      attemptedAccounts: result?.attempted ?? null,
      succeededAccounts: result?.succeeded ?? null,
      failedAccounts: result?.failed ?? null,
      // Per-mailbox outcome, so one dead account among four is visible:
      // [{ inbox, ok, newCount, scanned, skipped, error, errorCode, hint }]
      accounts: result?.accounts ?? null,
      // A total failure is reported through `error` as well, so a client that
      // only checks this field cannot read the sync as a success.
      error: status.error || (ok === false ? message : null),
      createdAt: status.createdAt,
      finishedAt: status.finishedAt
    });
  } catch (error) {
    logger.error({ err: error.message }, 'failed to read sync job status');
    return res.status(500).json({ message: 'Server error. Failed to read sync status.' });
  }
};

/*
 * ---------------------------------------------------------------------------
 * H-3 — inbox category tabs
 * ---------------------------------------------------------------------------
 *
 * The client has always sent `?category=<tab>` and `getEmails` never read it
 * (`grep -c category gmailController.js` returned 0), so Sent, Promotions,
 * Social, Updates and Spam all returned the same 1,397 inbound rows as Inbox —
 * five of six tabs showed the Inbox, and "Sent" presented RECEIVED mail under a
 * "Received" timestamp column.
 *
 * The data model does support this. `Email.direction` distinguishes the 599
 * outbound replies F-1 began persisting, and `Email.labelIds` holds the Gmail
 * label set captured at ingest, which is where Gmail's own category membership
 * lives (`CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, `CATEGORY_UPDATES`, `SPAM`).
 *
 * Two honesty notes, because "the filter now works" is not the same as "the
 * tabs are now full":
 *
 *  1. `sent` is not a category question at all — it is `direction: 'outbound'`,
 *     which the default filter (`direction: { $ne: 'outbound' }`) was actively
 *     excluding.
 *  2. In a workspace whose mail was ingested without Gmail's category labels,
 *     the four category tabs correctly return ZERO rows. That is the truthful
 *     answer, and `GET /api/gmail/categories` reports it up front so the UI can
 *     show a real count (or hide the tab) instead of promising 1,397 rows it
 *     will not deliver. An unknown category is a 400, never a silent fallback
 *     to the Inbox — silently ignoring this parameter is the whole defect.
 */
const EMAIL_CATEGORIES = {
  // Everything received that is not spam. No positive `INBOX` label
  // requirement: a message ingested before label capture would otherwise
  // vanish from the default view.
  inbox: { label: 'Inbox', direction: 'inbound', filter: { labelIds: { $ne: 'SPAM' } } },
  // Replies we sent, persisted as Email rows since F-1.
  sent: { label: 'Sent', direction: 'outbound', filter: {} },
  spam: { label: 'Spam', direction: 'inbound', filter: { labelIds: 'SPAM' } },
  promotions: { label: 'Promotions', direction: 'inbound', filter: { labelIds: 'CATEGORY_PROMOTIONS' } },
  social: { label: 'Social', direction: 'inbound', filter: { labelIds: 'CATEGORY_SOCIAL' } },
  updates: { label: 'Updates', direction: 'inbound', filter: { labelIds: 'CATEGORY_UPDATES' } },
  // Explicit "everything", inbound and outbound.
  all: { label: 'All mail', direction: 'all', filter: {} }
};

const CATEGORY_NAMES = Object.keys(EMAIL_CATEGORIES);

/**
 * Resolve `?category=`.
 *
 * @param {Object} req
 * @returns {{name: String|null, spec: Object|null, invalid: Boolean}}
 */
const resolveCategory = (req) => {
  const raw = firstStringOf(req.query.category, 30).toLowerCase().trim();
  if (!raw) return { name: null, spec: null, invalid: false };
  const spec = EMAIL_CATEGORIES[raw];
  if (!spec) return { name: raw, spec: null, invalid: true };
  return { name: raw, spec, invalid: false };
};

/** The 400 body for an unsupported category. */
const unsupportedCategory = (res, name) =>
  res.status(400).json({
    message: `Unsupported category "${name}". Supported categories: ${CATEGORY_NAMES.join(', ')}.`,
    code: 'UNSUPPORTED_CATEGORY',
    supported: CATEGORY_NAMES
  });

// @desc    List emails (paginated per docs/audits/API-LIST-CONTRACT.md)
// @route   GET /api/gmail/emails
// @access  Private (Admin, Head)
exports.getEmails = async (req, res) => {
  try {
    // F-1: conversation mode is OPT-IN. `?group=thread` delegates to the thread
    // list; anything else keeps the exact message-level response the rebuilt
    // inbox already consumes.
    if (firstStringOf(req.query.group, 20).toLowerCase() === 'thread') {
      return exports.getThreads(req, res);
    }

    const params = parseListParams(req, {
      sortWhitelist: EMAIL_SORT_FIELDS,
      defaultSort: '-date',
      tiebreaker: '_id'
    });

    const filter = { ...NOT_DELETED };

    // H-3: the tab. An unknown value is refused rather than silently ignored.
    const category = resolveCategory(req);
    if (category.invalid) return unsupportedCategory(res, category.name);
    if (category.spec) Object.assign(filter, category.spec.filter);

    // F-1: replies we sent are now persisted as Email rows. They must NOT
    // appear in the message list by default — before F-1 the collection held
    // inbound mail only, and the inbox is finished work. `?direction=outbound`
    // or `?direction=all` opts in.
    //
    // H-3: a category implies a direction (Sent IS `direction: outbound`), but
    // an explicit `?direction=` still wins, so `?category=sent&direction=all`
    // remains expressible.
    const direction =
      firstStringOf(req.query.direction, 20).toLowerCase() || (category.spec ? category.spec.direction : '');
    if (direction === 'inbound' || direction === 'outbound') filter.direction = direction;
    else if (direction !== 'all') filter.direction = { $ne: 'outbound' };

    if (req.user.role === 'Employee') {
      filter.assignedTo = req.user._id;
    } else if (req.user.role === 'Head') {
      filter.fetchedBy = req.user._id;
    }

    // Additive, endpoint-specific filters.
    const { firstString } = require('../utils/paginate');
    const status = firstString(req.query.status, 20);
    if (status === 'assigned' || status === 'unassigned') filter.status = status;

    const approvalStatus = firstString(req.query.approvalStatus, 20);
    if (['none', 'pending', 'approved', 'rejected'].includes(approvalStatus)) {
      filter.approvalStatus = approvalStatus;
    }

    const accountEmail = firstString(req.query.accountEmail, 254);
    if (accountEmail) filter.toEmail = accountEmail;

    // S-16: real read/unread filter. `?read=false` is the unread inbox.
    // Served by the {deletedAt, 'readBy.user', date} compound index.
    const read = firstString(req.query.read, 10).toLowerCase();
    if (read === 'true') filter['readBy.user'] = req.user._id;
    else if (read === 'false') filter['readBy.user'] = { $ne: req.user._id };

    // Date range. `dateFrom`/`dateTo` is the contract (API-LIST-CONTRACT.md):
    // on THIS endpoint `from` means the SENDER, so it cannot also mean a date.
    // The legacy `from`/`to` date spelling is still accepted as a fallback, but
    // only when it parses as a date and no `dateFrom`/`dateTo` was supplied.
    const dateFrom = firstString(req.query.dateFrom, 40);
    const dateTo = firstString(req.query.dateTo, 40);
    const legacyFrom = firstString(req.query.from, 60);
    const legacyTo = firstString(req.query.to, 60);

    const range = {};
    const lower = dateFrom || (legacyFrom && !Number.isNaN(Date.parse(legacyFrom)) ? legacyFrom : '');
    const upper = dateTo || (legacyTo && !Number.isNaN(Date.parse(legacyTo)) ? legacyTo : '');
    if (lower && !Number.isNaN(Date.parse(lower))) range.$gte = new Date(lower);
    if (upper && !Number.isNaN(Date.parse(upper))) range.$lte = new Date(upper);
    if (Object.keys(range).length > 0) filter.date = range;

    // `from` as SENDER — the contract's meaning on this endpoint. Only applied
    // when it is not a date, so the legacy spelling above keeps working.
    if (legacyFrom && Number.isNaN(Date.parse(legacyFrom))) {
      filter.from = new RegExp(escapeRegex(legacyFrom), 'i');
    }

    // Free-text search over subject and sender. Deliberately still a regex
    // rather than a $text index: `$text` matches whole words only, and the
    // current UI contract is substring search. The cost is now bounded because
    // the projection no longer drags every multi-megabyte body along.
    if (params.q) {
      const searchRegex = new RegExp(escapeRegex(params.q), 'i');
      filter.$and = [{ $or: [{ subject: searchRegex }, { from: searchRegex }] }];
    }

    const { data, pagination } = await paginate(Email, filter, params, {
      // NEVER `body`. See API-LIST-CONTRACT.md rule 1.
      select: EMAIL_LIST_FIELDS,
      populate: [
        { path: 'assignedTo', select: 'name email' },
        { path: 'fetchedBy', select: 'name email gmailEmail' },
        { path: 'suggestedAssignedTo', select: 'name email role' }
      ]
    });

    // S-16: `isRead` is derived per-request for the CALLER, never stored as a
    // flat flag on the document.
    return listResponse(res, {
      params,
      data: data.map((email) => deriveIsRead(email, req.user._id)),
      pagination
    });
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getEmails failed');
    return res.status(500).json({ message: 'Server error. Failed to query emails.' });
  }
};

// @desc    Row count for every inbox category, scoped to the caller
// @route   GET /api/gmail/categories
// @access  Private (Admin, Head — same gate as GET /api/gmail/emails)
//
// H-3. The tab strip used to render "1,397" on all six tabs because every tab
// issued the same unfiltered query. This gives the UI the real number for each
// tab in ONE request, so a category the workspace has no mail for can be shown
// as 0 (or hidden) instead of advertising rows it cannot produce.
exports.getEmailCategories = async (req, res) => {
  try {
    const scope = { ...NOT_DELETED };
    if (req.user.role === 'Employee') scope.assignedTo = req.user._id;
    else if (req.user.role === 'Head') scope.fetchedBy = req.user._id;

    const counts = await Promise.all(
      CATEGORY_NAMES.map(async (name) => {
        const spec = EMAIL_CATEGORIES[name];
        const filter = { ...scope, ...spec.filter };
        if (spec.direction === 'inbound' || spec.direction === 'outbound') filter.direction = spec.direction;
        return { name, label: spec.label, total: await Email.countDocuments(filter) };
      })
    );

    res.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
    return res.status(200).json({ categories: counts });
  } catch (error) {
    logger.error({ err: error.message }, 'getEmailCategories failed');
    return res.status(500).json({ message: 'Server error. Failed to count email categories.' });
  }
};

// Ceiling on the thread-id set resolved by a message-level narrowing filter
// (`q` / date range). Beyond this the count is reported as the cap; the
// alternative is an unbounded `$in`.
const THREAD_MATCH_CAP = Number(process.env.THREAD_MATCH_CAP || 2000);

/**
 * Resolve the thread ids whose MESSAGES match a narrowing filter.
 *
 * `q` and the date range select messages, but the response is one row per
 * THREAD. Applying them straight into the grouping pipeline would silently
 * redefine `messageCount` as "messages that matched your search", so they are
 * resolved to a thread-id set first and the counters are then computed over the
 * whole conversation.
 *
 * @param {Object} baseMatch
 * @param {Object} narrowing
 * @returns {Promise<String[]>}
 */
const resolveMatchingThreadIds = async (baseMatch, narrowing) => {
  const rows = await Email.aggregate([
    { $match: { ...baseMatch, ...narrowing } },
    { $group: { _id: '$threadId' } },
    { $limit: THREAD_MATCH_CAP }
  ]);
  return rows.map((r) => r._id).filter(Boolean);
};

// @desc    List conversations, one row per thread
// @route   GET /api/gmail/threads   (also GET /api/gmail/emails?group=thread)
// @access  Private (Admin, Head — same gate as GET /api/gmail/emails)
//
// F-1. Follows docs/audits/API-LIST-CONTRACT.md exactly: `page`/`limit`/`sort`/
// `q`, the `{data, pagination}` envelope when `page` is present, and the bare
// array capped at LIST_LEGACY_CAP when it is not.
exports.getThreads = async (req, res) => {
  try {
    const params = parseListParams(req, {
      sortWhitelist: THREAD_SORT_FIELDS,
      defaultSort: '-lastMessageAt',
      // `_id` does not survive the projection; the thread id is the stable
      // tiebreaker for a page boundary.
      tiebreaker: 'threadId'
    });

    // Ownership scoping is applied INSIDE the pipeline, exactly as on
    // GET /emails/:id. A Head can never observe a thread on a mailbox they do
    // not own, not even transiently.
    const baseMatch = {
      ...NOT_DELETED,
      ...threadScopeFilter(req.user),
      threadId: { $nin: [null, ''] }
    };

    const accountEmail = firstStringOf(req.query.accountEmail, 254);
    if (accountEmail) baseMatch.toEmail = accountEmail;

    // Message-level narrowing filters, resolved to a thread-id set first.
    const narrowing = {};

    // H-3. A conversation spans both directions, so the category selects the
    // threads that CONTAIN a message in it — "Sent" is the conversations you
    // have replied to, not a separate list of replies.
    const category = resolveCategory(req);
    if (category.invalid) return unsupportedCategory(res, category.name);
    if (category.spec) {
      Object.assign(narrowing, category.spec.filter);
      if (category.spec.direction !== 'all') narrowing.direction = category.spec.direction;
    }

    const dateFrom = firstStringOf(req.query.dateFrom, 40);
    const dateTo = firstStringOf(req.query.dateTo, 40);
    const range = {};
    if (dateFrom && !Number.isNaN(Date.parse(dateFrom))) range.$gte = new Date(dateFrom);
    if (dateTo && !Number.isNaN(Date.parse(dateTo))) range.$lte = new Date(dateTo);
    if (Object.keys(range).length > 0) narrowing.date = range;

    if (params.q) {
      const searchRegex = new RegExp(escapeRegex(params.q), 'i');
      narrowing.$or = [{ subject: searchRegex }, { from: searchRegex }];
    }

    if (Object.keys(narrowing).length > 0) {
      const ids = await resolveMatchingThreadIds(baseMatch, narrowing);
      if (ids.length === 0) {
        return listResponse(res, {
          params,
          data: [],
          pagination: params.paginated ? buildPagination(params, 0) : null
        });
      }
      baseMatch.threadId = { $in: ids };
    }

    const postGroup = [];
    // Backlog / "needs an answer" view, and what the SLA breach list links to.
    if (firstStringOf(req.query.unanswered, 10).toLowerCase() === 'true') {
      postGroup.push({ $match: { hasUnansweredInbound: true } });
    }
    if (firstStringOf(req.query.unread, 10).toLowerCase() === 'true') {
      postGroup.push({ $match: { unreadCount: { $gt: 0 } } });
    }

    const pipeline = [
      { $match: baseMatch },
      threadGroupStage(req.user._id),
      projectThreadStage(),
      ...postGroup,
      {
        $facet: {
          rows: [{ $sort: params.sort }, { $skip: params.skip }, { $limit: params.limit }],
          total: [{ $count: 'value' }]
        }
      }
    ];

    const [result] = await Email.aggregate(pipeline).allowDiskUse(true);
    const data = result?.rows || [];
    const total = result?.total?.[0]?.value || 0;

    res.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');

    return listResponse(res, {
      params,
      data,
      pagination: params.paginated ? buildPagination(params, total) : null
    });
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getThreads failed');
    return res.status(500).json({ message: 'Server error. Failed to query conversations.' });
  }
};

// @desc    One conversation, ordered oldest-first, INCLUDING message bodies
// @route   GET /api/gmail/threads/:threadId
// @access  Private (all roles, subject to the same object-level authorization
//          as GET /api/gmail/emails/:id)
exports.getThreadById = async (req, res) => {
  try {
    const threadId = String(req.params.threadId || '').slice(0, 200);
    if (!threadId) return res.status(400).json({ message: 'A thread id is required.' });

    const messages = await Email.find({ threadId, ...NOT_DELETED })
      // The ONLY thread route that opts into bodies. The list above carries a
      // snippet, per API-LIST-CONTRACT.md rule 1.
      .select(`${EMAIL_LIST_FIELDS} +body`)
      .populate('assignedTo', 'name email')
      .populate('fetchedBy', 'name email gmailEmail')
      .populate('sentBy', 'name email')
      .sort({ date: 1, _id: 1 })
      .limit(THREAD_MESSAGE_CAP)
      .lean();

    if (messages.length === 0) return res.status(404).json({ message: 'Conversation not found.' });

    // Identical rule to GET /emails/:id, applied per message: a Head must not
    // read a thread on an inbox they do not own.
    const visible = messages.filter((m) => canAccessEmail(m, req.user));
    if (visible.length === 0) {
      return res.status(403).json({ message: 'Access denied. This conversation is not in your mailbox.' });
    }

    const inbound = visible.filter((m) => m.direction !== 'outbound');
    const outbound = visible.filter((m) => m.direction === 'outbound');
    const at = (list, pick) => (list.length === 0 ? null : pick(list.map((m) => m.date).filter(Boolean)));
    const minDate = (dates) => (dates.length ? new Date(Math.min(...dates.map((d) => new Date(d)))) : null);
    const maxDate = (dates) => (dates.length ? new Date(Math.max(...dates.map((d) => new Date(d)))) : null);

    const firstInboundAt = at(inbound, minDate);
    const lastInboundAt = at(inbound, maxDate);
    const firstOutboundAt = at(outbound, minDate);
    const lastOutboundAt = at(outbound, maxDate);
    const latest = visible[visible.length - 1];

    return res.status(200).json({
      threadId,
      subject: latest.subject || '',
      participants: [...new Set(visible.map((m) => m.from).filter(Boolean))],
      accountEmail: latest.toEmail || '',
      clientId: visible.find((m) => m.clientId)?.clientId || null,
      messageCount: visible.length,
      inboundCount: inbound.length,
      outboundCount: outbound.length,
      unreadCount: visible.filter((m) => !deriveIsRead(m, req.user._id).isRead).length,
      firstMessageAt: visible[0]?.date || null,
      lastMessageAt: latest.date || null,
      firstInboundAt,
      lastInboundAt,
      firstOutboundAt,
      lastOutboundAt,
      lastDirection: latest.direction || 'inbound',
      // Same derivation as the list row, so the two surfaces cannot disagree.
      hasUnansweredInbound: Boolean(
        lastInboundAt && (!lastOutboundAt || new Date(lastOutboundAt) < new Date(lastInboundAt))
      ),
      firstResponseAt: firstOutboundAt,
      firstResponseMinutes:
        firstInboundAt && firstOutboundAt && new Date(firstOutboundAt) >= new Date(firstInboundAt)
          ? Math.round(((new Date(firstOutboundAt) - new Date(firstInboundAt)) / 60000) * 10) / 10
          : null,
      truncated: messages.length >= THREAD_MESSAGE_CAP,
      // Oldest first, so the reading pane renders newest last.
      messages: visible.map((m) => deriveIsRead(sanitizeEmailDoc(m), req.user._id))
    });
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getThreadById failed');
    return res.status(500).json({ message: 'Server error. Failed to load the conversation.' });
  }
};

// @desc    Get a single email INCLUDING its body
// @route   GET /api/gmail/emails/:id
// @access  Private (all roles, subject to object-level authorization)
exports.getEmailById = async (req, res) => {
  try {
    // `+body` is the only opt-in to the (potentially multi-megabyte) body in the
    // whole codebase's read path.
    const email = await Email.findOne({ _id: req.params.id, ...NOT_DELETED })
      .select(`${EMAIL_LIST_FIELDS} +body`)
      .populate('assignedTo', 'name email')
      .populate('fetchedBy', 'name email gmailEmail')
      .populate('suggestedAssignedTo', 'name email role')
      .lean();

    if (!email) {
      return res.status(404).json({ message: 'Email not found.' });
    }

    if (!canAccessEmail(email, req.user)) {
      return res.status(403).json({ message: 'Access denied. This email is not in your mailbox.' });
    }

    // Defence in depth: bodies stored before ingest-time sanitization existed
    // are cleaned on the way out too.
    //
    // NOTE: opening an email does NOT implicitly mark it read. Marking is an
    // explicit PATCH, so a prefetch or a bot cannot silently clear the badge.
    return res.status(200).json(deriveIsRead(sanitizeEmailDoc(email), req.user._id));
  } catch (error) {
    logger.error({ err: error.message }, 'getEmailById failed');
    return res.status(500).json({ message: 'Server error. Failed to load the email.' });
  }
};

/**
 * Apply a read/unread change to a set of emails the caller is allowed to touch.
 *
 * Shared by the single and bulk endpoints so the ownership rule cannot drift
 * between them. Authorization is `canAccessEmail`, exactly as for read and
 * delete: an id the caller cannot see is reported as `forbidden`, never acted
 * on, and never silently skipped.
 *
 * @param {String[]} ids
 * @param {Object} user - req.user
 * @param {Boolean} read
 * @returns {Promise<{results: Array, updated: Number}>}
 */
const applyReadState = async (ids, user, read) => {
  // Only the fields the authorization check and the response need.
  const emails = await Email.find({ _id: { $in: ids }, ...NOT_DELETED })
    .select('_id subject fetchedBy assignedTo readBy')
    .lean();

  const byId = new Map(emails.map((e) => [String(e._id), e]));
  const actionable = [];
  const results = [];

  for (const id of ids) {
    const email = byId.get(id);
    if (!email) {
      results.push({ id, ok: false, status: 404, message: 'Email not found.' });
      continue;
    }
    if (!canAccessEmail(email, user)) {
      results.push({ id, ok: false, status: 403, message: 'This email is not in your mailbox.' });
      continue;
    }
    actionable.push(email);
    results.push({ id, ok: true, status: 200, isRead: read });
  }

  if (actionable.length > 0) {
    const actionableIds = actionable.map((e) => e._id);
    if (read) {
      // `$ne` in the filter makes this idempotent: re-marking an already-read
      // email is a no-op rather than a duplicate array entry.
      await Email.updateMany(
        { _id: { $in: actionableIds }, 'readBy.user': { $ne: user._id } },
        { $push: { readBy: { user: user._id, readAt: new Date() } } }
      );
    } else {
      await Email.updateMany(
        { _id: { $in: actionableIds } },
        { $pull: { readBy: { user: user._id } } }
      );
    }
  }

  return { results, updated: actionable.length };
};

// @desc    Mark a single email read/unread for the calling user
// @route   PATCH /api/gmail/emails/:id/read
// @access  Private (all roles, subject to object-level authorization)
//
// WAVE2 gap S-16. Body: { "read": true }  (defaults to true when omitted).
exports.markEmailRead = async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!OBJECT_ID_RE.test(id)) {
      return res.status(400).json({ message: 'Invalid email ID.' });
    }

    const read = req.body?.read === undefined ? true : Boolean(req.body.read);
    const { results } = await applyReadState([id], req.user, read);
    const result = results[0];

    if (!result.ok) {
      return res.status(result.status).json({ message: result.message });
    }

    return res.status(200).json({ message: read ? 'Email marked as read.' : 'Email marked as unread.', _id: id, isRead: read });
  } catch (error) {
    logger.error({ err: error.message }, 'markEmailRead failed');
    return res.status(500).json({ message: 'Server error. Failed to update read state.' });
  }
};

// @desc    Mark many emails read/unread for the calling user
// @route   PATCH /api/gmail/emails/read
// @access  Private (all roles, subject to object-level authorization)
//
// WAVE2 gap S-16. Body: { "ids": ["..."], "read": true }
// Returns PER-ID results so a partial failure is reportable, rather than one
// status for the whole batch.
exports.bulkMarkEmailsRead = async (req, res) => {
  try {
    const { ids, error } = parseEmailIds(req.body?.ids);
    if (error) return res.status(400).json({ message: error });

    const read = req.body?.read === undefined ? true : Boolean(req.body.read);
    const { results, updated } = await applyReadState(ids, req.user, read);

    return res.status(200).json({
      message: `${updated} of ${ids.length} email(s) marked as ${read ? 'read' : 'unread'}.`,
      read,
      updated,
      failed: ids.length - updated,
      results
    });
  } catch (error) {
    logger.error({ err: error.message }, 'bulkMarkEmailsRead failed');
    return res.status(500).json({ message: 'Server error. Failed to update read state.' });
  }
};

// @desc    Bulk soft-delete emails by id
// @route   DELETE /api/gmail/emails   (body: { "ids": [...] })
// @access  Private (Admin, Head — same ownership scoping as the single delete)
//
// WAVE2 gap S-15. The client previously fanned out N x DELETE
// /api/gmail/emails/:id via Promise.allSettled. Per-id results are returned so
// that partial-failure reporting survives the collapse into one request.
exports.bulkDeleteEmails = async (req, res) => {
  try {
    const { ids, error } = parseEmailIds(req.body?.ids);
    if (error) return res.status(400).json({ message: error });

    const emails = await Email.find({ _id: { $in: ids }, ...NOT_DELETED })
      .select('_id subject fetchedBy assignedTo status')
      .lean();

    const byId = new Map(emails.map((e) => [String(e._id), e]));
    const deletable = [];
    const results = [];

    for (const id of ids) {
      const email = byId.get(id);
      if (!email) {
        results.push({ id, ok: false, status: 404, message: 'Email not found.' });
        continue;
      }
      // Identical object-level check to deleteSingleEmail — a Head must not be
      // able to destroy the Admin's or another Head's mail by enumerating ids.
      if (!canAccessEmail(email, req.user)) {
        results.push({ id, ok: false, status: 403, message: 'This email is not in your mailbox.' });
        continue;
      }
      deletable.push(email);
      results.push({ id, ok: true, status: 200 });
    }

    if (deletable.length > 0) {
      const deletableIds = deletable.map((e) => e._id);
      // Soft delete, consistent with the single-email path.
      await Email.updateMany(
        { _id: { $in: deletableIds } },
        { $set: { deletedAt: new Date(), deletedBy: req.user._id, status: 'unassigned', assignedTo: null } }
      );
      await Task.updateMany({ linkedEmail: { $in: deletableIds } }, { $set: { linkedEmail: null } });
      await cache.invalidateStats();

      await logActivity(
        req.user._id,
        'Gmail Bulk Delete',
        `Deleted ${deletable.length} of ${ids.length} email(s)`,
        {
          req,
          targetType: 'Email',
          targetId: deletableIds.length === 1 ? deletableIds[0] : null,
          targetLabel: `${deletable.length} email(s)`,
          before: { requested: ids.length },
          after: { deleted: deletable.length, failed: ids.length - deletable.length }
        }
      );
    }

    return res.status(200).json({
      message: `${deletable.length} of ${ids.length} email(s) deleted.`,
      deleted: deletable.length,
      failed: ids.length - deletable.length,
      results
    });
  } catch (error) {
    logger.error({ err: error.message }, 'bulkDeleteEmails failed');
    return res.status(500).json({ message: 'Server error. Failed to delete emails.' });
  }
};

// @desc    DELETE /api/gmail/emails dispatcher
// @route   DELETE /api/gmail/emails
// @access  Private (Admin always; Head only for the id-scoped bulk form)
//
// One path, two behaviours, because the "clear all" route already owned this
// URL and the client still calls it:
//
//   body { ids: [...] }  -> bulk soft-delete, ownership-scoped   (Admin, Head)
//   body absent/empty    -> clear the whole workspace inbox      (Admin only)
exports.deleteEmailsDispatch = async (req, res) => {
  const ids = req.body?.ids;
  if (Array.isArray(ids)) {
    return exports.bulkDeleteEmails(req, res);
  }
  if (req.user.role !== 'Admin') {
    return res.status(403).json({
      message: 'Access denied. Clearing the entire inbox is an Admin action. Send { "ids": [...] } to delete specific emails.'
    });
  }
  return exports.deleteAllEmails(req, res);
};

// @desc    Delete all emails (Admin only)
// @route   DELETE /api/gmail/emails
// @access  Private (Admin only)
exports.deleteAllEmails = async (req, res) => {
  try {
    // Soft delete, consistent with deleteSingleEmail — a single Admin click must
    // not be able to irrecoverably destroy the entire mail corpus.
    const result = await Email.updateMany(
      { ...NOT_DELETED },
      { $set: { deletedAt: new Date(), deletedBy: req.user._id, status: 'unassigned', assignedTo: null } }
    );
    await Task.updateMany({ linkedEmail: { $ne: null } }, { $set: { linkedEmail: null } });
    await cache.invalidateStats();

    // Workspace-wide sweep: no single target document exists, so `targetId`
    // stays null rather than being invented.
    await logActivity(req.user._id, 'Gmail Delete All', `Cleared all emails (${result.modifiedCount} emails deleted)`, {
      req,
      targetType: 'Email',
      targetLabel: `${result.modifiedCount} email(s) (entire workspace inbox)`
    });

    return res.status(200).json({
      message: "All emails cleared",
      // Response shape preserved: the client reads `count`.
      count: result.modifiedCount
    });
  } catch (error) {
    logger.error({ err: error.message }, 'deleteAllEmails failed');
    return res.status(500).json({ message: 'Server error. Failed to clear emails.' });
  }
};

// @desc    Delete single email (Admin, Head only)
// @route   DELETE /api/gmail/emails/:id
// @access  Private (Admin, Head only)
exports.deleteSingleEmail = async (req, res) => {
  try {
    const emailId = req.params.id;
    // Projection: the authorization check and the audit line need five fields,
    // not a multi-megabyte body.
    const email = await Email.findOne({ _id: emailId, ...NOT_DELETED }).select(
      '_id subject fetchedBy assignedTo status'
    );
    if (!email) {
      return res.status(404).json({ message: "Email not found" });
    }

    // Object-level authorization: a Head could previously enumerate ids and
    // permanently destroy the Admin's or another Head's mail.
    if (!canAccessEmail(email, req.user)) {
      return res.status(403).json({ message: 'Access denied. This email is not in your mailbox.' });
    }

    // Soft delete, so the record and its body remain recoverable and linked
    // Tasks do not silently lose their evidence.
    email.deletedAt = new Date();
    email.deletedBy = req.user._id;
    email.status = 'unassigned';
    email.assignedTo = null;
    await email.save();

    await Task.updateMany({ linkedEmail: emailId }, { $set: { linkedEmail: null } });
    await cache.invalidateStats();

    await logActivity(req.user._id, 'Gmail Delete Single', `Deleted email: "${email.subject}"`, {
      req,
      targetType: 'Email',
      targetId: emailId,
      targetLabel: email.subject || '(no subject)',
      before: { status: 'active' },
      after: { deletedAt: email.deletedAt }
    });

    return res.status(200).json({ message: "Email deleted" });
  } catch (error) {
    logger.error({ err: error.message }, 'deleteSingleEmail failed');
    return res.status(500).json({ message: 'Server error. Failed to delete email.' });
  }
};

// @desc    Get Gmail connection status
// @route   GET /api/gmail/status
// @access  Private
exports.getConnectedStatus = async (req, res) => {
  try {
    // NOTE: deduplicateConnections() used to run here. A GET must never mutate:
    // it hard-deleted OAuth tokens for whichever user MongoDB happened to
    // return second, on every dashboard poll, with no audit trail. It is now an
    // explicit Admin action (POST /api/gmail/deduplicate).
    const currentUser = await User.findById(req.user._id)
      .select(
        '_id name role gmailEmail gmailSyncHealth lastGmailSyncAt lastGmailSyncStatus ' +
          '+gmailAccessToken +linkedGmailAccounts'
      )
      .lean();
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }
    const isConnected = !!currentUser.gmailAccessToken && currentUser.gmailAccessToken !== "";

    /*
     * H-1 — "a token is stored" and "the mailbox works" are different facts.
     * `connected` has always meant the former, and it kept saying Connected for
     * four mailboxes Google had been refusing for days. It is left alone (the
     * Profile page's Disconnect control depends on it) and the sync outcome is
     * reported ALONGSIDE it, per mailbox, so the UI can show
     * "Connected — needs reconnecting" instead of a healthy green tick.
     */
    const healthByInbox = new Map(
      (currentUser.gmailSyncHealth || []).map((h) => [String(h.gmailEmail || '').toLowerCase(), h])
    );
    const healthOf = (inbox) => {
      const h = healthByInbox.get(String(inbox || '').toLowerCase());
      if (!h) return { syncOk: null, syncErrorCode: null, syncError: null, lastSyncAt: null, needsReconnect: false };
      return {
        syncOk: h.ok === true,
        syncErrorCode: h.errorCode || null,
        syncError: h.ok ? null : h.error || null,
        lastSyncAt: h.at || null,
        needsReconnect: h.ok === false && h.errorCode === 'REAUTH_REQUIRED'
      };
    };

    // Non-Admin users only see their own primary account status (if connected) and no linked accounts
    let linkedAccounts = [];

    if (currentUser.role === 'Admin' || currentUser.role === 'Head') {
      linkedAccounts = (currentUser.linkedGmailAccounts || []).map(a => ({
        gmailEmail: a.gmailEmail,
        connected: !!a.gmailAccessToken,
        ownerName: 'Me',
        isOtherUser: false,
        userId: currentUser._id.toString(),
        ...healthOf(a.gmailEmail)
      }));
    }

    if (currentUser.role === 'Admin') {

      // Find other users with connected accounts
      const otherUsers = await User.find({
        _id: { $ne: currentUser._id },
        deletedAt: null,
        gmailAccessToken: { $nin: [null, ''] }
      })
        .select('_id name gmailEmail gmailSyncHealth +gmailAccessToken +linkedGmailAccounts')
        .lean();

      for (const u of otherUsers) {
        const otherHealth = new Map(
          (u.gmailSyncHealth || []).map((h) => [String(h.gmailEmail || '').toLowerCase(), h])
        );
        const otherHealthOf = (inbox) => {
          const h = otherHealth.get(String(inbox || '').toLowerCase());
          if (!h) return { syncOk: null, syncErrorCode: null, syncError: null, lastSyncAt: null, needsReconnect: false };
          return {
            syncOk: h.ok === true,
            syncErrorCode: h.errorCode || null,
            syncError: h.ok ? null : h.error || null,
            lastSyncAt: h.at || null,
            needsReconnect: h.ok === false && h.errorCode === 'REAUTH_REQUIRED'
          };
        };

        // Add their primary account
        linkedAccounts.push({
          gmailEmail: u.gmailEmail,
          connected: true,
          ownerName: u.name,
          isOtherUser: true,
          userId: u._id.toString(),
          ...otherHealthOf(u.gmailEmail)
        });

        // Add their linked accounts
        for (const la of (u.linkedGmailAccounts || [])) {
          linkedAccounts.push({
            gmailEmail: la.gmailEmail,
            connected: !!la.gmailAccessToken,
            ownerName: u.name,
            isOtherUser: true,
            userId: u._id.toString(),
            ...otherHealthOf(la.gmailEmail)
          });
        }
      }
    }

    const primaryHealth = isConnected
      ? healthOf(currentUser.gmailEmail)
      : { syncOk: null, syncErrorCode: null, syncError: null, lastSyncAt: null, needsReconnect: false };

    return res.status(200).json({
      connected: isConnected,
      gmailEmail: currentUser.gmailEmail || "",
      // The Profile page reads `.email`; both keys are returned so the
      // "Inbox Address" field is no longer blank regardless of which is used.
      email: currentUser.gmailEmail || "",
      linkedAccounts,
      // --- H-1 additions -------------------------------------------------
      // The primary mailbox's last sync outcome, and a workspace-level roll-up
      // so a banner can be shown without walking `linkedAccounts`.
      ...primaryHealth,
      lastSyncAt: currentUser.lastGmailSyncAt || primaryHealth.lastSyncAt || null,
      lastSyncStatus: currentUser.lastGmailSyncStatus || null,
      // Every mailbox on this response that the sync has reported as broken.
      failingAccounts: [
        ...(isConnected && primaryHealth.syncOk === false ? [currentUser.gmailEmail] : []),
        ...linkedAccounts.filter((a) => a.syncOk === false).map((a) => a.gmailEmail)
      ].filter(Boolean)
    });
  } catch (error) {
    logger.error({ err: error.message }, 'getConnectedStatus failed');
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

    const user = await User.findById(targetUserId).select('+gmailAccessToken +gmailRefreshToken +linkedGmailAccounts');
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
      await logActivity(req.user._id, 'Gmail Clean Blank Accounts', `Cleared blank Gmail connections for user ${user.email}`, {
        req,
        targetType: 'User',
        targetId: targetUserId,
        targetLabel: user.email
      });
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

    // Soft-delete all emails fetched from this account (identified by toEmail or
    // fetchedBy), consistent with deleteSingleEmail — disconnecting an account
    // must not irrecoverably destroy its mail history.
    //
    // `.distinct('_id')` instead of loading full documents: the previous
    // `Email.find(...)` pulled every body (base64 images included) into memory
    // purely to map over `_id`.
    const scope = { toEmail: gmailEmail, fetchedBy: targetUserId, ...NOT_DELETED };
    const emailIds = await Email.distinct('_id', scope);

    await Email.updateMany(scope, {
      $set: { deletedAt: new Date(), deletedBy: req.user._id, status: 'unassigned', assignedTo: null }
    });
    if (emailIds.length > 0) {
      await Task.updateMany({ linkedEmail: { $in: emailIds } }, { $set: { linkedEmail: null } });
    }
    await cache.del(cache.KEYS.gmailToken(String(targetUserId), gmailEmail));
    await cache.invalidateStats();

    await logActivity(
      req.user._id,
      'Gmail Unlink Account',
      `Unlinked Gmail account ${gmailEmail} of user ${user.email}`,
      {
        req,
        targetType: 'User',
        targetId: targetUserId,
        targetLabel: user.email,
        before: { gmailAccount: gmailEmail, isPrimary },
        after: { gmailAccount: null, emailsSoftDeleted: emailIds.length }
      }
    );

    return res.status(200).json({ message: `${gmailEmail} disconnected successfully.` });
  } catch (error) {
    logger.error({ err: error.message }, 'disconnectLinkedAccount failed');
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
    const user = await User.findById(userId).select('+gmailAccessToken +gmailRefreshToken +linkedGmailAccounts');
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    const previousGmailEmail = user.gmailEmail || null;
    user.gmailAccessToken = "";
    user.gmailRefreshToken = "";
    user.gmailEmail = "";
    await user.save();

    // 2. Collect the affected ids WITHOUT materialising the documents.
    const scope = { fetchedBy: userId, ...NOT_DELETED };
    const emailIds = await Email.distinct('_id', scope);

    // 3. Soft-delete the emails (recoverable, consistent with deleteSingleEmail)
    await Email.updateMany(scope, {
      $set: { deletedAt: new Date(), deletedBy: userId, status: 'unassigned', assignedTo: null }
    });

    // 4. Update tasks that had linkedEmail in those emailIds
    if (emailIds.length > 0) {
      await Task.updateMany(
        { linkedEmail: { $in: emailIds } },
        { $set: { linkedEmail: null } }
      );
    }

    await cache.delPrefix(`gtok:${String(userId)}:`);
    await cache.invalidateStats();

    // Addresses and counts only — the token fields cleared above are never
    // passed into the audit payload.
    await logActivity(userId, 'Gmail Disconnect', `Disconnected Gmail account for user ${user.email}`, {
      req,
      targetType: 'User',
      targetId: userId,
      targetLabel: user.email,
      before: { gmailEmail: previousGmailEmail },
      after: { gmailEmail: null, emailsSoftDeleted: emailIds.length }
    });

    return res.status(200).json({ message: "Gmail disconnected successfully" });
  } catch (error) {
    logger.error({ err: error.message }, 'disconnectGmail failed');
    return res.status(500).json({ message: 'Server error. Failed to disconnect Gmail.' });
  }
};

/**
 * Workspace-wide Gmail connection de-duplication.
 *
 * Rewritten to be safe. The previous version ran on every `GET /api/gmail/status`
 * with `User.find({})` and no `.sort()`, so which user lost their tokens was
 * decided by MongoDB's natural order and could flip between requests, producing
 * an oscillating connected/disconnected state with no notification and no audit
 * entry.
 *
 * Guarantees now:
 *  - Deterministic ordering (createdAt, then _id). The EARLIEST connector of an
 *    address is its legitimate owner and is never touched.
 *  - Only blank entries and genuine duplicates held by a LATER claimant are
 *    removed.
 *  - Every single change writes an ActivityLog entry.
 *  - Supports a dry run so conflicts can be reported without mutating anything.
 *
 * @param {{ dryRun?: Boolean, actorId?: String, req?: Object }} options - `req`
 *   is optional and used only to stamp the audit entries with the caller's IP
 *   and user agent; omit it when the sweep is not driven by a request.
 * @returns {Promise<{ changes: Array, scannedUsers: Number, dryRun: Boolean }>}
 */
const deduplicateConnections = async (options = {}) => {
  const { dryRun = false, actorId = null, req = null } = options;
  const changes = [];

  const users = await User.find({ deletedAt: null })
    // Deterministic: the first user to have connected an address keeps it.
    .sort({ createdAt: 1, _id: 1 })
    .select('_id email gmailEmail +gmailAccessToken +gmailRefreshToken +linkedGmailAccounts')
    .lean();

  // address -> { userId, userEmail } of the legitimate owner
  const owners = new Map();
  // One bulkWrite at the end instead of an unbounded number of per-user save()
  // round-trips.
  const operations = [];

  for (const u of users) {
    const updates = {};
    let modified = false;

    // 1. Primary connection
    const primaryAddress = (u.gmailEmail || '').toLowerCase().trim();
    const hasPrimary = !!u.gmailAccessToken || !!u.gmailEmail;

    if (hasPrimary) {
      if (!primaryAddress) {
        // Blank primary with a dangling token: safe to clear, owns nothing.
        changes.push({
          userId: u._id.toString(),
          userEmail: u.email,
          type: 'primary',
          gmailEmail: '',
          reason: 'blank'
        });
        if (!dryRun) {
          Object.assign(updates, { gmailAccessToken: null, gmailRefreshToken: null, gmailEmail: '' });
          modified = true;
        }
      } else if (owners.has(primaryAddress)) {
        // Someone earlier legitimately owns this inbox — this is the duplicate.
        const owner = owners.get(primaryAddress);
        changes.push({
          userId: u._id.toString(),
          userEmail: u.email,
          type: 'primary',
          gmailEmail: u.gmailEmail,
          reason: 'duplicate',
          ownedBy: owner.userEmail
        });
        if (!dryRun) {
          Object.assign(updates, { gmailAccessToken: null, gmailRefreshToken: null, gmailEmail: '' });
          modified = true;
        }
      } else {
        // Legitimate owner: never nulled out.
        owners.set(primaryAddress, { userId: u._id.toString(), userEmail: u.email });
      }
    }

    // 2. Linked (extra) accounts
    if (u.linkedGmailAccounts && u.linkedGmailAccounts.length > 0) {
      const kept = [];
      for (const acct of u.linkedGmailAccounts) {
        const address = (acct.gmailEmail || '').toLowerCase().trim();

        if (!address) {
          changes.push({
            userId: u._id.toString(),
            userEmail: u.email,
            type: 'linked',
            gmailEmail: '',
            reason: 'blank'
          });
          continue;
        }

        if (owners.has(address)) {
          const owner = owners.get(address);
          // Only a LATER claimant is pruned; the owner's own entry is retained.
          if (owner.userId !== u._id.toString()) {
            changes.push({
              userId: u._id.toString(),
              userEmail: u.email,
              type: 'linked',
              gmailEmail: acct.gmailEmail,
              reason: 'duplicate',
              ownedBy: owner.userEmail
            });
            continue;
          }
          // Same user holds it both as primary and linked — drop the redundant
          // linked copy but keep the primary intact.
          changes.push({
            userId: u._id.toString(),
            userEmail: u.email,
            type: 'linked',
            gmailEmail: acct.gmailEmail,
            reason: 'duplicate-of-own-primary',
            ownedBy: owner.userEmail
          });
          continue;
        }

        owners.set(address, { userId: u._id.toString(), userEmail: u.email });
        kept.push(acct);
      }

      if (!dryRun && kept.length !== u.linkedGmailAccounts.length) {
        updates.linkedGmailAccounts = kept;
        modified = true;
      }
    }

    if (modified) {
      operations.push({ updateOne: { filter: { _id: u._id }, update: { $set: updates } } });
    }
  }

  // One round-trip for the whole sweep.
  if (operations.length > 0) {
    await User.bulkWrite(operations, { ordered: false });
  }

  // Audit every change, not just a console line.
  if (!dryRun && changes.length > 0 && actorId) {
    for (const change of changes) {
      // The target is the user whose connection was removed, NOT the admin who
      // triggered the sweep (that is the actor, `userId`).
      await logActivity(
        actorId,
        'Gmail Deduplicate',
        `Removed ${change.reason} ${change.type} Gmail connection ${change.gmailEmail || '(blank)'} from user ${change.userEmail}` +
          (change.ownedBy ? ` (owned by ${change.ownedBy})` : ''),
        {
          req,
          targetType: 'User',
          targetId: change.userId,
          targetLabel: change.userEmail,
          before: { connectionType: change.type, gmailEmail: change.gmailEmail || null },
          after: { connectionType: change.type, gmailEmail: null, reason: change.reason }
        }
      );
    }
  }

  return { changes, scannedUsers: users.length, dryRun };
};

// @desc    Explicitly de-duplicate workspace Gmail connections
// @route   POST /api/gmail/deduplicate
// @access  Private (Admin only)
exports.deduplicateGmailConnections = async (req, res) => {
  try {
    // Defaults to a dry run: pass { "apply": true } to actually write.
    const apply = req.body && req.body.apply === true;

    const result = await deduplicateConnections({ dryRun: !apply, actorId: req.user._id, req });

    return res.status(200).json({
      message: apply
        ? `De-duplication applied. ${result.changes.length} connection(s) removed.`
        : `Dry run complete. ${result.changes.length} conflicting connection(s) found.`,
      applied: apply,
      count: result.changes.length,
      scannedUsers: result.scannedUsers,
      changes: result.changes
    });
  } catch (error) {
    logger.error({ err: error.message }, 'deduplicateGmailConnections failed');
    return res.status(500).json({ message: 'Server error. Failed to de-duplicate Gmail connections.' });
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
    const email = await Email.findOne({ _id: emailId, ...NOT_DELETED })
      .select('_id messageId threadId rfcMessageId references subject from toEmail fetchedBy assignedTo clientId')
      .lean();
    if (!email) return res.status(404).json({ message: 'Email not found.' });

    // Object-level authorization. Previously absent entirely: any Head could
    // reply to an email belonging to the Admin's mailbox.
    if (!canAccessEmail(email, req.user)) {
      return res.status(403).json({ message: 'Access denied. This email does not belong to your mailbox.' });
    }

    const user = await User.findById(req.user._id)
      .select('_id gmailEmail +gmailAccessToken +gmailRefreshToken +linkedGmailAccounts')
      .lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const targetInbox = email.toEmail;

    // The sending identity is resolved ONLY from the authenticated user. The
    // previous "borrow an Admin's OAuth tokens" fallback is deleted: it let a
    // Head send mail from the Admin's real Gmail account to any address, an
    // ideal business-email-compromise primitive.
    const { accessToken, refreshToken } = resolveInboxCredentials(user, targetInbox);

    if (!accessToken) {
      return res.status(403).json({
        message: 'Access denied. You do not have a connected Gmail account for this inbox.'
      });
    }

    // decrypt() now THROWS rather than returning the ciphertext as if it were a
    // token, so an unreadable credential is reported honestly instead of
    // producing an opaque 401 from Google.
    let plainAccessToken;
    let plainRefreshToken;
    try {
      plainAccessToken = decrypt(accessToken);
      plainRefreshToken = decrypt(refreshToken);
    } catch (err) {
      logger.error({ err: err.message, inbox: targetInbox }, 'stored Gmail token could not be decrypted');
      return res.status(409).json({
        message: 'The stored Gmail credential for this inbox could not be read. Please reconnect the account.'
      });
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ access_token: plainAccessToken, refresh_token: plainRefreshToken });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Fetch original message from Gmail to get proper headers (Message-ID, References, thread)
    let originalMessageId = '';
    let references = '';
    let threadId = '';
    try {
      const original = await gmailCall(
        () =>
          gmail.users.messages.get(
            {
              userId: 'me',
              id: email.messageId,
              format: 'metadata',
              metadataHeaders: ['Message-ID', 'References', 'In-Reply-To']
            },
            GMAIL_REQUEST_OPTIONS
          ),
        'messages.get(metadata)'
      );
      threadId = original.data.threadId || '';
      const headers = original.data.payload?.headers || [];
      const msgIdHeader = headers.find(h => h.name.toLowerCase() === 'message-id');
      const refsHeader = headers.find(h => h.name.toLowerCase() === 'references');
      originalMessageId = msgIdHeader ? msgIdHeader.value : '';
      references = refsHeader ? `${refsHeader.value} ${originalMessageId}` : originalMessageId;
    } catch (e) {
      logger.warn({ err: e.message }, 'could not fetch original reply headers');
    }

    // F-1: fall back to what we already persisted when the metadata fetch above
    // failed. The whole defect was that `threadId` was read and then dropped —
    // losing it a second time to a transient Gmail error would be the same bug.
    if (!threadId) threadId = email.threadId || '';
    if (!originalMessageId) originalMessageId = email.rfcMessageId || '';
    if (!references) references = (email.references || []).concat(originalMessageId).filter(Boolean).join(' ');

    // Extract plain sender address from "Name <email@domain.com>" format.
    // `subject` and `from` come from attacker-controlled inbound headers, so
    // every interpolated value has CR/LF stripped — otherwise a header value
    // containing a newline injects arbitrary headers (e.g. Bcc:) into the reply.
    const fromMatch = email.from.match(/<(.+?)>/);
    const toAddress = sanitizeHeaderValue(fromMatch ? fromMatch[1] : email.from);
    const rawSubject = sanitizeHeaderValue(email.subject);
    const replySubject = rawSubject.startsWith('Re:') ? rawSubject : `Re: ${rawSubject}`;

    // Build RFC 2822 raw email
    const rawLines = [
      `From: ${sanitizeHeaderValue(targetInbox)}`,
      `To: ${toAddress}`,
      `Subject: ${replySubject}`,
      `In-Reply-To: ${sanitizeHeaderValue(originalMessageId)}`,
      `References: ${sanitizeHeaderValue(references)}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      replyBody.trim()
    ];

    const rawEmail = rawLines.join('\r\n');
    const encodedEmail = Buffer.from(rawEmail).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const sendResult = await gmailCall(
      () =>
        gmail.users.messages.send(
          {
            userId: 'me',
            requestBody: {
              raw: encodedEmail,
              ...(threadId ? { threadId } : {})
            }
          },
          GMAIL_REQUEST_OPTIONS
        ),
      'messages.send'
    );

    // -------------------------------------------------------------------
    // F-1: PERSIST the outbound message.
    //
    // This handler previously stored nothing at all after a successful send,
    // so the app could not show that a client had been answered and no
    // response-time metric was computable. Everything in F-2 depends on this
    // row existing.
    //
    // Persistence failure must NOT turn a delivered reply into a 500 — the mail
    // has already left. It is logged and the request still succeeds.
    // -------------------------------------------------------------------
    const sentAt = new Date();
    const effectiveThreadId = sendResult?.data?.threadId || threadId || email.threadId || null;
    let outboundId = null;

    try {
      const replyText = replyBody.trim();
      const outbound = await Email.create({
        // Gmail's id for the message we just sent, so the unique index holds and
        // a later sync of the Sent label cannot duplicate this row.
        messageId: sendResult?.data?.id || `outbound-${email.messageId}-${sentAt.getTime()}`,
        threadId: effectiveThreadId,
        // Gmail assigns the RFC Message-ID after the fact; we do not learn it
        // from the send response, so it stays null rather than being invented.
        rfcMessageId: null,
        inReplyTo: originalMessageId || null,
        references: parseReferences(references),
        direction: 'outbound',
        subject: replySubject,
        // The sending mailbox is the author of an outbound message.
        from: targetInbox,
        toEmail: targetInbox,
        date: sentAt,
        sentBy: req.user._id,
        sentAt,
        // Ownership: the reply belongs to the same mailbox as the message it
        // answers, which is what keeps thread scoping consistent for a Head.
        fetchedBy: email.fetchedBy || req.user._id,
        fetchedAt: sentAt,
        // Our own outbound text is not attacker-controlled, but it goes through
        // the same sanitizer as everything else that can be rendered.
        body: sanitizeEmailHtml(replyText),
        bodyRaw: replyText,
        snippet: makeSnippet('', replyText),
        clientId: email.clientId || null,
        // A message we wrote is, by definition, read by its author.
        readBy: [{ user: req.user._id, readAt: sentAt }],
        labelIds: ['SENT']
      });
      outboundId = outbound._id;

      if (effectiveThreadId) await resyncThreadPositions([effectiveThreadId]);

      // F-2: stamp `firstResponseAt` on any task linked to this conversation.
      // `firstResponseAt: null` in the filter makes it first-write-wins, so a
      // second reply cannot move the first-response instant.
      const threadEmailIds = effectiveThreadId
        ? await Email.distinct('_id', { threadId: effectiveThreadId })
        : [email._id];
      await Task.updateMany(
        { linkedEmail: { $in: threadEmailIds }, firstResponseAt: null },
        { $set: { firstResponseAt: sentAt } }
      );

      // Reply is a write that moves SLA and dashboard aggregates.
      await cache.invalidateStats();
    } catch (err) {
      logger.error(
        { err: err.message, emailId: String(email._id), threadId: effectiveThreadId },
        'reply was SENT but could not be persisted'
      );
    }

    // Target is the email that was REPLIED TO. No before/after: sending a reply
    // creates a new outbound message rather than transitioning this one, and
    // the reply body is deliberately not copied into the audit trail.
    await logActivity(req.user._id, 'Email Reply', `Replied to email "${email.subject}" from ${email.from}`, {
      req,
      targetType: 'Email',
      targetId: email._id,
      targetLabel: email.subject
    });

    // Additive only: the pre-existing `message` field is unchanged.
    return res.status(200).json({
      message: 'Reply sent successfully.',
      threadId: effectiveThreadId,
      emailId: outboundId,
      sentAt
    });
  } catch (error) {
    logger.error({ err: error.message }, 'replyToEmail failed');
    return res.status(500).json({ message: 'Server error. Failed to send reply.' });
  }
};

// @desc    Bulk assign multiple emails to an employee (converts them to Tasks)
// @route   POST /api/gmail/emails/bulk-assign
// @access  Private (Admin, Head only)
exports.bulkAssignEmails = async (req, res) => {
  try {
    const { emailIds, assignedTo, deadline, priority } = req.body;

    if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
      return res.status(400).json({ message: 'emailIds array is required.' });
    }
    if (!assignedTo) {
      return res.status(400).json({ message: 'assignedTo user ID is required.' });
    }

    const assignee = await User.findById(assignedTo);
    if (!assignee) {
      return res.status(404).json({ message: 'Assignee not found.' });
    }

    // `deadline` is already normalized to a UTC Date by the Zod schema.
    const taskDeadline = deadline || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const taskPriority = priority || 'Medium';

    // Ownership scope. Without this a Head could assign — and read back the
    // full body of — any email in the workspace, including the Admin's.
    const scope = { _id: { $in: emailIds }, ...NOT_DELETED };
    if (req.user.role !== 'Admin') {
      scope.fetchedBy = req.user._id;
    }

    // Projection: only the fields the task body needs. This used to load every
    // full document including the base64-laden body.
    // `status` is additionally selected so the audit entry can record the state
    // this assignment replaced. `emails` is not echoed in the response, so the
    // response shape is untouched.
    const emails = await Email.find(scope).select('_id subject from status').lean();
    if (emails.length === 0) {
      return res.status(404).json({ message: 'No matching emails found.' });
    }

    // Fail closed when any requested id was outside the caller's mailbox,
    // rather than silently acting on the subset they do own.
    const uniqueRequested = new Set(emailIds.map(String));
    if (emails.length !== uniqueRequested.size) {
      return res.status(403).json({ message: 'One or more emails are outside your mailbox.' });
    }

    const { createNotification } = require('../utils/notificationHelper');
    const io = req.app.get('io');

    // 2N sequential writes (one task save + one email save PER EMAIL, up to 200
    // of each) collapse into two round-trips.
    //
    // `bulkWrite` with an upsert on `linkedEmail` rather than `insertMany`,
    // because the unique partial index on `Task.linkedEmail` would otherwise
    // reject an email that already has a task.
    const now = new Date();
    // Resolve the client the SAME way the sync path does (taskHelper's
    // `resolveClientForSender`): an exact sender-address match against the
    // cached client table, falling back to the shared UNASSIGNED sentinel.
    // This used to store the raw From header ("Name <addr@example>") verbatim,
    // which escaped every per-client counter (they group by client name) and
    // rendered a mangled header in the Tasks UI client column.
    const clientMatcher = await getClientMatcher();
    const operations = [];
    for (const email of emails) {
      const { clientName } = await resolveClientForSender(email.from, clientMatcher);
      operations.push({
        updateOne: {
          filter: { linkedEmail: email._id },
          update: {
            $set: { assignedTo: assignee._id, status: 'Pending', deadline: taskDeadline, priority: taskPriority },
            $setOnInsert: {
              title: email.subject || 'Assigned Email',
              // The full email body is NOT copied into the task description. The
              // task links to the email; the body is served only through an
              // authorized email read path.
              description: '',
              linkedEmail: email._id,
              clientName,
              createdBy: req.user._id,
              createdAt: now
            }
          },
          upsert: true
        }
      });
    }

    await Task.bulkWrite(operations, { ordered: false });
    await Email.updateMany(
      { _id: { $in: emails.map((e) => e._id) } },
      { $set: { assignedTo: assignee._id, status: 'assigned' } }
    );
    await cache.invalidateStats();

    const createdTasks = await Task.find({ linkedEmail: { $in: emails.map((e) => e._id) } })
      .select('_id title linkedEmail assignedTo clientName deadline priority status createdBy createdAt')
      .lean();

    await createNotification(
      assignee._id,
      `You have been assigned ${emails.length} new tasks from the Inbox.`,
      io,
      null,
      'email_assigned'
    );

    await logActivity(
      req.user._id,
      'Bulk Email Assignment',
      `Assigned ${emails.length} emails to ${assignee.name}`,
      {
        req,
        targetType: 'Email',
        // N emails: a single id would be arbitrary, so only the count is named.
        targetId: emails.length === 1 ? emails[0]._id : null,
        targetLabel: emails.length === 1 ? emails[0].subject : `${emails.length} email(s)`,
        // Real prior statuses, summarised — the scope does not require the
        // emails to have been unassigned, so it must not be assumed.
        before: {
          statusCounts: emails.reduce((acc, e) => {
            const key = e.status || 'Unknown';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {}),
          emailCount: emails.length
        },
        after: {
          status: 'assigned',
          assignedTo: String(assignee._id),
          assignedToName: assignee.name,
          emailCount: emails.length
        }
      }
    );

    return res.status(200).json({
      message: `Successfully assigned ${emails.length} emails to ${assignee.name}.`,
      // Only non-sensitive task metadata is echoed back — never email bodies.
      tasks: createdTasks.map((t) => ({
        _id: t._id,
        title: t.title,
        linkedEmail: t.linkedEmail,
        assignedTo: t.assignedTo,
        clientName: t.clientName,
        deadline: t.deadline,
        priority: t.priority,
        status: t.status,
        createdBy: t.createdBy,
        createdAt: t.createdAt
      }))
    });
  } catch (error) {
    logger.error({ err: error.message }, 'bulkAssignEmails failed');
    return res.status(500).json({ message: 'Server error. Failed to bulk assign emails.' });
  }
};

// @desc    Download email attachment
// @route   GET /api/gmail/emails/:id/attachments/:attachmentId
// @access  Private (All roles with access)
exports.downloadAttachment = async (req, res) => {
  try {
    const { id, attachmentId } = req.params;
    
    // Find the email
    const email = await Email.findOne({ _id: id, ...NOT_DELETED })
      .select('_id messageId toEmail attachments fetchedBy assignedTo')
      .lean();
    if (!email) {
      return res.status(404).json({ message: 'Email not found.' });
    }

    // Object-level authorization (Admin: any; otherwise own mailbox, or
    // assigned to the caller for an Employee).
    if (!canAccessEmail(email, req.user)) {
      return res.status(403).json({ message: 'Access denied. This email is not in your mailbox.' });
    }

    // Find attachment info
    const attachmentInfo = email.attachments.find(a => a.attachmentId === attachmentId);
    if (!attachmentInfo) {
      return res.status(404).json({ message: 'Attachment metadata not found on email.' });
    }

    const targetInbox = email.toEmail;

    // Credentials come from the mailbox OWNER, resolved from a single user
    // document. The previous "fall back to any Admin's tokens" block is deleted.
    //
    // An Employee legitimately reads an attachment on a task assigned to them
    // but never holds Gmail credentials, so for them the fetcher's credentials
    // are used — but only after canAccessEmail() has confirmed the assignment.
    const credentialOwnerId =
      req.user.role === 'Employee' ? email.fetchedBy : req.user._id;

    const credentialOwner = await User.findById(credentialOwnerId)
      .select('_id gmailEmail +gmailAccessToken +gmailRefreshToken +linkedGmailAccounts')
      .lean();
    if (!credentialOwner) {
      return res.status(404).json({ message: 'Mailbox owner context not found.' });
    }

    const { accessToken, refreshToken } = resolveInboxCredentials(credentialOwner, targetInbox);

    if (!accessToken) {
      return res.status(403).json({ message: 'No authenticated Gmail credentials found for this inbox.' });
    }

    let plainAccessToken;
    let plainRefreshToken;
    try {
      plainAccessToken = decrypt(accessToken);
      plainRefreshToken = decrypt(refreshToken);
    } catch (err) {
      logger.error({ err: err.message, inbox: targetInbox }, 'stored Gmail token could not be decrypted');
      return res.status(409).json({
        message: 'The stored Gmail credential for this inbox could not be read. Please reconnect the account.'
      });
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ access_token: plainAccessToken, refresh_token: plainRefreshToken });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const attachRes = await gmailCall(
      () =>
        gmail.users.messages.attachments.get(
          { userId: 'me', messageId: email.messageId, id: attachmentId },
          GMAIL_REQUEST_OPTIONS
        ),
      'attachments.get'
    );

    const base64Data = attachRes.data.data;
    if (!base64Data) {
      return res.status(404).json({ message: 'Attachment content empty.' });
    }

    const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
    const fileBuffer = Buffer.from(standardBase64, 'base64');

    res.setHeader('Content-Type', attachmentInfo.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachmentInfo.filename)}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    return res.send(fileBuffer);

  } catch (error) {
    logger.error({ err: error.message }, 'downloadAttachment failed');
    return res.status(500).json({ message: 'Server error. Failed to download attachment.' });
  }
};


