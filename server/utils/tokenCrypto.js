const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const getEncryptionKey = () => {
  const keyStr = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyStr) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is not defined.');
  }

  let key;
  // Try to decode as hex if it matches hex length (64 chars for 32 bytes)
  if (keyStr.length === 64 && /^[0-9a-fA-F]+$/.test(keyStr)) {
    key = Buffer.from(keyStr, 'hex');
  } else {
    // Try base64
    key = Buffer.from(keyStr, 'base64');
  }

  if (key.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must be exactly 32 bytes. Decoded key length is ${key.length} bytes.`);
  }

  return key;
};

const encrypt = (text) => {
  if (!text) return text;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  // Format: iv:encrypted:authTag
  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
};

/**
 * Thrown when a stored token cannot be recovered. Callers must treat this as
 * "this mailbox is not usable", not as "here is a token".
 */
class TokenDecryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenDecryptionError';
    this.code = 'ETOKENDECRYPT';
  }
}

// Migration guard. A workspace that predates scripts/encryptExistingTokens.js
// still holds raw Google tokens (which contain no ':' and therefore cannot be
// confused with the iv:ciphertext:tag format). Those pass through with a
// warning while this is 'true'. Set it to 'false' once the migration script has
// been run so an unencrypted token becomes a hard error.
const allowLegacyPlaintext = () => process.env.ALLOW_LEGACY_PLAINTEXT_TOKENS !== 'false';

/**
 * Decrypt a stored OAuth token.
 *
 * This function used to FAIL OPEN: on any decryption error it returned the
 * ciphertext, which was then handed to Google as an access token. That turned a
 * key rotation, a truncated field or a tampered record into a stream of opaque
 * 401s from the Gmail API, and it silently defeated encryption at rest — the
 * caller could not tell a real token from a ciphertext. It now throws.
 *
 * @param {String|null} ciphertext
 * @returns {String|null}
 * @throws {TokenDecryptionError}
 */
const decrypt = (ciphertext) => {
  if (!ciphertext) return ciphertext;

  if (typeof ciphertext !== 'string') {
    throw new TokenDecryptionError('Stored token is not a string.');
  }

  const parts = ciphertext.split(':');
  // Not in iv:encrypted:authTag form — this is a legacy plaintext token.
  if (parts.length !== 3) {
    if (allowLegacyPlaintext()) {
      console.warn(
        '[CRYPTO] Encountered an unencrypted legacy token. Run scripts/encryptExistingTokens.js, ' +
          'then set ALLOW_LEGACY_PLAINTEXT_TOKENS=false.'
      );
      return ciphertext;
    }
    throw new TokenDecryptionError('Stored token is not encrypted and legacy plaintext is disabled.');
  }

  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    // Deliberately does NOT include the ciphertext in the message.
    throw new TokenDecryptionError(`Failed to decrypt stored token: ${err.message}`);
  }
};

/**
 * Non-throwing variant for paths that must survive one bad record — a bulk sync
 * over many mailboxes, for instance, should skip the broken one rather than
 * abort every remaining account.
 * @param {String|null} ciphertext
 * @returns {String|null} null when the token cannot be recovered
 */
const tryDecrypt = (ciphertext) => {
  try {
    return decrypt(ciphertext);
  } catch (err) {
    return null;
  }
};

module.exports = { encrypt, decrypt, tryDecrypt, TokenDecryptionError };
