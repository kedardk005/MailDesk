const mongoose = require('mongoose');

const EmailSchema = new mongoose.Schema({
  // GMAIL's message id (`users.messages.get -> id`). NOT the RFC-822
  // `Message-ID` header — that is `rfcMessageId` below.
  //
  // F-1 NOTE / deviation from FEATURE-SPEC.md: the spec's field table asks for
  // `messageId` to hold the RFC-822 header. This field already existed, already
  // held the Gmail id, and is `unique` — the whole sync de-duplication (and the
  // `insertMany({ordered:false})` skip-on-duplicate path) depends on it. Its
  // meaning was therefore left alone and the RFC header got a new name.
  messageId: {
    type: String,
    required: true,
    unique: true
  },
  // ---------------------------------------------------------------------
  // F-1 threading
  // ---------------------------------------------------------------------
  // Gmail's conversation id. Populated at ingest and on every persisted
  // outbound reply; backfilled for historical rows by
  // scripts/backfillEmailThreads.js. Null only for rows that predate the
  // backfill.
  threadId: {
    type: String,
    default: null
  },
  // RFC-822 `Message-ID` header of THIS message. Unknown for a reply we send
  // (Gmail assigns it after the fact), so it is nullable.
  rfcMessageId: {
    type: String,
    default: null
  },
  // RFC-822 `In-Reply-To`.
  inReplyTo: {
    type: String,
    default: null
  },
  // RFC-822 `References`, split on whitespace.
  references: {
    type: [String],
    default: []
  },
  // `inbound`  - received on one of our mailboxes.
  // `outbound` - a reply WE sent, persisted by replyToEmail. Before F-1 nothing
  //              was stored after a send, so the app could not show that a
  //              client had already been answered — and no response-time metric
  //              was computable at all.
  direction: {
    type: String,
    enum: ['inbound', 'outbound'],
    default: 'inbound'
  },
  // 0-based position within the thread, ordered by `date`. Maintained on insert
  // by utils/threadHelper.js `resyncThreadPositions`.
  threadPosition: {
    type: Number,
    default: 0
  },
  // Who sent an outbound message, and when. Null on inbound mail.
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  sentAt: {
    type: Date,
    default: null
  },
  subject: {
    type: String,
    default: ''
  },
  // Sanitized HTML. This is the ONLY body that is ever sent to a client.
  //
  // `select: false` because the sync pipeline inlines every image as a base64
  // `data:` URI, so a stored body runs 60 KB - 2 MB. Returning one per row in a
  // list response is what made GET /api/gmail/emails able to OOM the process.
  // The body is now opted into explicitly (`.select('+body')`) by the detail
  // route and by the few internal paths that genuinely need it.
  body: {
    type: String,
    default: '',
    select: false
  },
  // Original, unsanitized Gmail HTML. Retained for forensics/debugging only and
  // gated behind `select: false` so it can never be returned by accident.
  bodyRaw: {
    type: String,
    default: '',
    select: false
  },
  // ~200 character plain-text preview generated at ingest. This is what list
  // responses carry in place of `body`. Backfill existing rows with
  // scripts/backfillEmailSnippets.js.
  snippet: {
    type: String,
    default: ''
  },
  from: {
    type: String,
    required: true
  },
  date: {
    type: Date
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  status: {
    type: String,
    enum: ['unassigned', 'assigned'],
    default: 'unassigned'
  },
  fetchedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  fetchedAt: {
    type: Date,
    default: Date.now
  },
  labelIds: {
    type: [String],
    default: []
  },
  toEmail: {
    type: String,
    default: ''
  },
  attachments: [
    {
      attachmentId: { type: String, required: true },
      filename: { type: String, required: true },
      mimeType: { type: String, default: '' },
      size: { type: Number, default: 0 }
    }
  ],
  matchedKeyword: {
    type: String,
    default: null
  },
  suggestedAssignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  approvalStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected'],
    default: 'none'
  },
  // Denormalised client attribution, resolved from the sender address at ingest
  // against the (cached) client list. Without it, per-client mail counts needed
  // a regex scan of the whole Email collection per client; with it they are a
  // single indexed `$group`. Backfill with scripts/backfillEmailSnippets.js.
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    default: null
  },
  // WAVE2 gap S-16 — real per-user read state.
  //
  // A boolean would be wrong: this is a SHARED mailbox. An email fetched by a
  // Head and assigned to an Employee is read independently by each of them, so
  // "read" is a relation between a user and a message, not a property of the
  // message. `isRead` in an API response is always derived for the REQUESTING
  // user (see deriveIsRead in gmailController).
  //
  // The array is bounded in practice by the number of users in the workspace.
  readBy: {
    type: [
      {
        _id: false,
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        readAt: { type: Date, default: Date.now }
      }
    ],
    default: []
  },
  // Soft delete. Every read path filters on `deletedAt: null` so a deletion is
  // recoverable and the audit trail survives.
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
});

// Single-field indexes, for queries that do not carry the soft-delete filter.
EmailSchema.index({ fetchedBy: 1 });
EmailSchema.index({ assignedTo: 1 });
EmailSchema.index({ status: 1 });
EmailSchema.index({ toEmail: 1 });
EmailSchema.index({ date: -1 });
EmailSchema.index({ approvalStatus: 1 });
EmailSchema.index({ deletedAt: 1 });
EmailSchema.index({ matchedKeyword: 1 });
EmailSchema.index({ clientId: 1 });

// Compound (filter + sort) indexes.
//
// Every read path filters on `deletedAt: null`, so it leads each compound as an
// equality prefix. Without the trailing sort key MongoDB has to materialise the
// whole match and sort it in memory — which fails outright past the 32 MB
// in-memory sort limit, i.e. exactly when the workspace gets big.
EmailSchema.index({ deletedAt: 1, date: -1 });
EmailSchema.index({ deletedAt: 1, fetchedBy: 1, date: -1 });
EmailSchema.index({ deletedAt: 1, assignedTo: 1, date: -1 });
EmailSchema.index({ deletedAt: 1, status: 1, date: -1 });
EmailSchema.index({ deletedAt: 1, approvalStatus: 1, date: -1 });
EmailSchema.index({ deletedAt: 1, fetchedBy: 1, approvalStatus: 1, date: -1 });
EmailSchema.index({ deletedAt: 1, matchedKeyword: 1, approvalStatus: 1 });
EmailSchema.index({ deletedAt: 1, clientId: 1 });
// disconnectLinkedAccount / disconnectGmail scope by mailbox + owner.
EmailSchema.index({ fetchedBy: 1, toEmail: 1, deletedAt: 1 });
// getEmailTimeline buckets by date within one mailbox.
EmailSchema.index({ fetchedBy: 1, date: -1 });

// S-16: the unread filter is `readBy.user != <me>`, i.e. a multikey lookup. The
// compound leads with the soft-delete equality prefix and carries the sort key,
// so `?read=false&sort=-date` is served from the index.
EmailSchema.index({ deletedAt: 1, 'readBy.user': 1, date: -1 });
EmailSchema.index({ 'readBy.user': 1 });

// ---------------------------------------------------------------------------
// F-1 threading indexes
// ---------------------------------------------------------------------------
// Ordered thread reads (GET /api/gmail/threads/:threadId) and the SLA
// first-response grouping, which groups Email by threadId.
EmailSchema.index({ threadId: 1, date: 1 });
// Scoped thread listing: a Head only ever sees threads on a mailbox they own.
EmailSchema.index({ fetchedBy: 1, threadId: 1 });
// Every thread/SLA read carries the soft-delete equality prefix.
EmailSchema.index({ deletedAt: 1, threadId: 1, date: 1 });
// `GET /api/gmail/emails` now filters out outbound rows by default, and the SLA
// pipelines match on direction inside a thread.
EmailSchema.index({ deletedAt: 1, direction: 1, date: -1 });
EmailSchema.index({ threadId: 1, direction: 1, date: 1 });
// Reply persistence and the backfill both look a message up by its RFC header.
EmailSchema.index({ rfcMessageId: 1 });

module.exports = mongoose.model('Email', EmailSchema);
