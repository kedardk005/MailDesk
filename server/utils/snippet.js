/**
 * Plain-text preview generation for email list responses.
 *
 * `Email.body` is not a normal body: the sync pipeline splices every inline
 * image into the HTML as a base64 `data:` URI, so a single 200 KB logo becomes
 * ~267 KB of text. Shipping those bodies in a list response is what made
 * `GET /api/gmail/emails` a multi-hundred-megabyte, OOM-capable endpoint.
 *
 * Lists now carry `snippet` instead, and the body is served only by the detail
 * route.
 */

const SNIPPET_LENGTH = 200;

// Bound the regex work. `.replace(/<[^>]*>/g, ...)` over a 2 MB base64-laden
// body is 10-200 ms of blocked event loop; over a 64 KB window it is sub-ms.
const SCAN_WINDOW = 64 * 1024;

// A single inlined image can be a megabyte of base64 inside ONE tag. Naively
// windowing first would then produce an empty snippet for a message whose real
// text sits after the logo, so long `data:` URIs are dropped in one linear pass
// (bounded below) before the window is taken.
const PRESCAN_LIMIT = 2 * 1024 * 1024;
const LONG_DATA_URI = /data:[^"'\s>)]{200,}/gi;

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'"
};

/**
 * Build a ~200 character plain-text preview from an email body.
 *
 * @param {String} html - the (sanitized) HTML body
 * @param {String} [plainText] - the text/plain MIME part when the message had
 *   one; strongly preferred, because it contains no base64 image payloads
 * @param {Number} [length]
 * @returns {String}
 */
const makeSnippet = (html, plainText = '', length = SNIPPET_LENGTH) => {
  const source = typeof plainText === 'string' && plainText.trim() ? plainText : html;
  if (!source || typeof source !== 'string') return '';

  // Drop inlined image payloads first, then window what is left.
  let text = source.slice(0, PRESCAN_LIMIT).replace(LONG_DATA_URI, '').slice(0, SCAN_WINDOW);

  // Drop non-content elements together with their contents first, otherwise a
  // preview is a page of CSS.
  text = text.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // An unterminated tag at the window boundary would otherwise leak raw base64.
  text = text.replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/, ' ');

  for (const [entity, replacement] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(replacement);
  }
  text = text.replace(/&#(\d{1,5});/g, (_, code) => {
    const n = Number(code);
    return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
  });

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= length) return text;

  // Prefer a word boundary, but never lose more than 20% of the preview to it.
  const clipped = text.slice(0, length);
  const lastSpace = clipped.lastIndexOf(' ');
  const cut = lastSpace > length * 0.8 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.trimEnd()}…`;
};

module.exports = { makeSnippet, SNIPPET_LENGTH };
