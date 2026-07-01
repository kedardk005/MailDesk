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

const decrypt = (ciphertext) => {
  if (!ciphertext) return ciphertext;
  
  const parts = ciphertext.split(':');
  // If it doesn't look like iv:encrypted:authTag, it is probably plaintext (e.g. legacy token)
  if (parts.length !== 3) {
    return ciphertext;
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
    console.error('[CRYPTO ERROR] Decryption failed:', err.message);
    // Return original ciphertext to support fallback / debug, or throw error depending on strictness
    return ciphertext;
  }
};

module.exports = { encrypt, decrypt };
