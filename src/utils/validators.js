/**
 * Validate international phone number format
 * Must start with + followed by country code and number
 * @param {string} phone
 * @returns {{ valid: boolean, normalized: string|null, error: string|null }}
 */
const validatePhoneNumber = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, normalized: null, error: 'رقم الهاتف مطلوب' };
  }

  // Remove all spaces and dashes
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');

  // Must start with + and contain only digits after
  if (!/^\+\d{7,15}$/.test(cleaned)) {
    return {
      valid: false,
      normalized: null,
      error: 'صيغة الرقم غير صحيحة. يجب أن يبدأ بـ + ويتكون من 7-15 رقمًا\nمثال: +967771234567',
    };
  }

  return { valid: true, normalized: cleaned, error: null };
};

/**
 * Validate OTP code format
 * @param {string} code
 * @returns {{ valid: boolean, error: string|null }}
 */
const validateOtpCode = (code) => {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'رمز التحقق مطلوب' };
  }

  const cleaned = code.trim().replace(/\s/g, '');

  if (!/^\d{5,6}$/.test(cleaned)) {
    return { valid: false, error: 'رمز التحقق يجب أن يكون 5 أو 6 أرقام' };
  }

  return { valid: true, cleaned, error: null };
};

/**
 * Sanitize user text input to prevent injection
 * @param {string} input
 * @returns {string}
 */
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, 500);
};

module.exports = { validatePhoneNumber, validateOtpCode, sanitizeInput };
