const CryptoJS = require('crypto-js');
const logger = require('./logger');

const getEncryptionKey = () => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be set and at least 32 characters long');
  }
  return key;
};

/**
 * Encrypt a string value
 * @param {string} plaintext
 * @returns {string} encrypted ciphertext
 */
const encrypt = (plaintext) => {
  try {
    const key = getEncryptionKey();
    const encrypted = CryptoJS.AES.encrypt(plaintext, key).toString();
    return encrypted;
  } catch (error) {
    logger.error('Encryption failed:', error);
    throw new Error('Failed to encrypt data');
  }
};

/**
 * Decrypt an encrypted string
 * @param {string} ciphertext
 * @returns {string} decrypted plaintext
 */
const decrypt = (ciphertext) => {
  try {
    const key = getEncryptionKey();
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    if (!decrypted) {
      throw new Error('Decryption returned empty result');
    }
    return decrypted;
  } catch (error) {
    logger.error('Decryption failed:', error);
    throw new Error('Failed to decrypt data');
  }
};

/**
 * Mask a phone number for display (e.g., +967XXXXXX789)
 * @param {string} phone
 * @returns {string}
 */
const maskPhone = (phone) => {
  if (!phone || phone.length < 6) return phone;
  const cleaned = phone.replace(/\s/g, '');
  const visible_start = cleaned.slice(0, 4);
  const visible_end = cleaned.slice(-3);
  const masked = 'X'.repeat(Math.max(0, cleaned.length - 7));
  return `${visible_start}${masked}${visible_end}`;
};

module.exports = { encrypt, decrypt, maskPhone };
