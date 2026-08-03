const sanitizeHtml = require('sanitize-html');
const { log } = require('./logger');

const logger = log('sanitize');

/**
 * Hardened HTML sanitizer for inbound email bodies.
 *
 * Inbound Gmail HTML is fully attacker controlled. This module is the single
 * place where that HTML is made safe. It is applied twice:
 *   1. At ingest time, before the body is persisted (gmailController).
 *   2. At read time, before a body is returned to any client (defence in depth,
 *      so that documents stored before this fix are also neutralised).
 *
 * Removed: <script>, <iframe>, <object>, <embed>, <form> (and all form
 * controls), <base>, <link>, <meta>, <svg>, <math>, every on* event handler
 * attribute, javascript:/vbscript:/data:text/html URLs, and any <style> block
 * containing a CSS expression()/behavior()/@import construct.
 *
 * Preserved: ordinary formatting, headings, lists, tables, links, and images
 * (including the inline base64 data: URIs the sync pipeline builds).
 */

// Ordinary formatting / structural / table tags an email may legitimately use.
const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br',
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main',
  'mark', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section',
  'small', 'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr'
];

// Presentational attributes that legacy email HTML depends on.
const GLOBAL_ATTRS = [
  'style', 'class', 'id', 'title', 'dir', 'lang', 'align', 'valign', 'width', 'height',
  'bgcolor', 'color', 'face', 'size', 'border', 'cellpadding', 'cellspacing', 'colspan',
  'rowspan', 'span', 'nowrap'
];

// Constructs that turn CSS into a script execution sink.
const DANGEROUS_CSS_SOURCE = '(?:expression\\s*\\(|javascript\\s*:|vbscript\\s*:|behavior\\s*:|-moz-binding|@import)';

const hasDangerousCss = (value) => new RegExp(DANGEROUS_CSS_SOURCE, 'i').test(String(value || ''));

// Only image payloads may travel as a data: URI. data:text/html is a script sink.
const isSafeImageSrc = (value) => {
  const src = String(value || '').trim();
  if (!src) return false;
  // eslint-disable-next-line no-control-regex
  const normalized = src.replace(/[\u0000-\u0020]/g, '').toLowerCase();
  if (normalized.startsWith('data:')) return /^data:image\/[a-z0-9.+-]+;/.test(normalized);
  if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) return false;
  return true;
};

/**
 * Drop whole <style> blocks that contain a dangerous CSS construct. Done before
 * sanitize-html runs because sanitize-html preserves the text of allowed tags
 * verbatim and cannot inspect stylesheet contents itself.
 */
const stripDangerousStyleBlocks = (html) =>
  html.replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, (block) => (hasDangerousCss(block) ? '' : block));

const SANITIZE_OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    '*': GLOBAL_ATTRS,
    a: [...GLOBAL_ATTRS, 'href', 'name', 'target', 'rel'],
    img: [...GLOBAL_ATTRS, 'src', 'alt', 'srcset', 'loading'],
    td: [...GLOBAL_ATTRS],
    th: [...GLOBAL_ATTRS, 'scope']
  },
  // javascript:, vbscript: and data: are absent here, so hrefs cannot execute.
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'ftp'],
  allowedSchemesByTag: {
    // Inline images are stored as base64 data: URIs by the Gmail sync pipeline.
    img: ['http', 'https', 'data', 'cid']
  },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'action', 'srcset'],
  allowProtocolRelative: true,
  // <style> is kept deliberately: real business email relies on it for layout and
  // dropping it is a visible regression. sanitize-html warns about it on every
  // call, so the warning is acknowledged here. Compensating controls:
  // stripDangerousStyleBlocks() removes any block containing expression()/
  // behavior()/@import/javascript:, and the parser terminates style text at the
  // first </style>, so a breakout attempt is re-parsed and stripped as markup.
  allowVulnerableTags: true,
  // Discard the *contents* of these, not just the tags themselves.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
  transformTags: {
    '*': (tagName, attribs) => {
      const safeAttribs = {};
      for (const [key, value] of Object.entries(attribs || {})) {
        const lowerKey = key.toLowerCase();
        // Belt-and-braces: allowedAttributes already drops these.
        if (lowerKey.startsWith('on')) continue;
        if (lowerKey === 'style' && hasDangerousCss(value)) continue;
        if ((lowerKey === 'src' || lowerKey === 'srcset') && !isSafeImageSrc(value)) continue;
        safeAttribs[key] = value;
      }
      // Never let a sanitized link open the opener's window context.
      if (tagName === 'a' && safeAttribs.target) {
        safeAttribs.rel = 'noopener noreferrer';
      }
      return { tagName, attribs: safeAttribs };
    }
  }
};

/**
 * Sanitize an email HTML body. Safe to call repeatedly (idempotent) and safe to
 * call on plain-text bodies, which pass through with entities encoded.
 * @param {String} html
 * @returns {String}
 */
const sanitizeEmailHtml = (html) => {
  if (!html || typeof html !== 'string') return '';
  try {
    return sanitizeHtml(stripDangerousStyleBlocks(html), SANITIZE_OPTIONS);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to sanitize email body');
    // Fail closed: an unsanitizable body is never returned raw.
    return '';
  }
};

/**
 * Defence in depth for read paths: sanitize the `body` of an Email document (or
 * of a populated `linkedEmail`) in place-ish, returning a plain object.
 * @param {Object} doc - Mongoose document or plain object
 * @returns {Object|null}
 */
const sanitizeEmailDoc = (doc) => {
  if (!doc) return doc;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  if (typeof plain.body === 'string') {
    plain.body = sanitizeEmailHtml(plain.body);
  }
  return plain;
};

/**
 * Sanitize the populated `linkedEmail.body` of a Task document.
 * @param {Object} task - Mongoose document or plain object
 * @returns {Object|null}
 */
const sanitizeTaskLinkedEmail = (task) => {
  if (!task) return task;
  const plain = typeof task.toObject === 'function' ? task.toObject() : task;
  if (plain.linkedEmail && typeof plain.linkedEmail.body === 'string') {
    plain.linkedEmail.body = sanitizeEmailHtml(plain.linkedEmail.body);
  }
  return plain;
};

module.exports = { sanitizeEmailHtml, sanitizeEmailDoc, sanitizeTaskLinkedEmail };
