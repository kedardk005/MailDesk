const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  associatedEmails: {
    type: [String],
    default: []
  },
  contactPerson: {
    type: String,
    default: ''
  },
  email: {
    type: String,
    default: ''
  },
  phone: {
    type: String,
    default: ''
  },
  /* The practice's own client code (e.g. "138B"). It is the natural key in the
   * office's existing records, so the Excel importer matches on it: re-running
   * an import updates the same client instead of creating a second one with a
   * slightly different spelling of the name. Optional — clients added by hand
   * in the UI need not have one. */
  code: {
    type: String,
    default: '',
    trim: true
  },
  address: {
    type: String,
    default: '',
    trim: true
  },
  /* The status code exactly as it appeared in the imported sheet ("01", "05",
   * "03", "08", "14"). Their meanings are the practice's business rules, not
   * ours, so we keep the original rather than guessing a mapping onto
   * Active/Inactive and silently hiding clients. `status` stays Active for
   * everything on import; this field is what a later bulk rule can key on. */
  sourceStatus: {
    type: String,
    default: '',
    trim: true
  },
  notes: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['Active', 'Inactive'],
    default: 'Active'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

ClientSchema.index({ createdAt: -1 });
ClientSchema.index({ status: 1, name: 1 });
// The sender -> client matcher looks up by address; keeping it indexed means a
// future direct lookup does not need the whole collection in memory.
ClientSchema.index({ associatedEmails: 1 });
ClientSchema.index({ email: 1 });
/* Unique, but only over clients that actually have a code. A plain unique
 * index would treat every hand-created client's empty string as a duplicate
 * and reject all but the first. */
ClientSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string', $gt: '' } } }
);

module.exports = mongoose.model('Client', ClientSchema);
