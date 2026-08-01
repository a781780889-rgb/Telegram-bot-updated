/**
 * Telegram Client Service (Updated for OTP Fix)
 *
 * Handles all low-level MTProto interactions with enhanced reliability:
 *  - SOCKS5 Proxy support for cloud environments (Railway).
 *  - Intelligent retry logic for sendCode and connection.
 *  - Detailed professional logging for debugging.
 *  - Robust session management and cleanup.
 */

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }            = require('telegram');
const path               = require('path');
const fs                 = require('fs');
const logger             = require('../utils/logger');
const { encrypt, decrypt, maskPhone } = require('../utils/encryption');

// ─── Directory bootstrap ──────────────────────────────────────────────────────

const sessionsDir = process.env.SESSIONS_DIR || './sessions';
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

// ─── In-memory state maps ─────────────────────────────────────────────────────

/** accountId → { client, phone, connectedAt } */
const activeClients = new Map();

/**
 * Composite key `${userId}:${phone}` → pending login session.
 */
const pendingSessions = new Map();

/**
 * Composite key → timestamp of last sendOtp() call.
 */
const lastSendAt = new Map();
const MIN_RESEND_GAP_MS = 60 * 1000;

/**
 * Composite key → timestamp of last resendOtp() call (button press).
 */
const lastResendAt = new Map();
const MIN_RESEND_BUTTON_GAP_MS = 30 * 1000;

// ─── Composite key helper ─────────────────────────────────────────────────────

const pendingKey = (userId, phone) => `${userId}:${phone}`;

// ─── Auth logging helpers ─────────────────────────────────────────────────────

/**
 * Professional structured logging for auth flow.
 */
const authLog = (step, userId, phone, extra = {}) => {
  const masked = maskPhone(phone);
  const ts     = new Date().toISOString();
  const base   = `[AUTH] step=${step} userId=${userId} phone=${masked} ts=${ts}`;
  
  // Filter out sensitive data
  const extras = Object.entries(extra)
    .filter(([k]) => !['hash', 'password', 'code', 'session', 'token'].includes(k.toLowerCase()))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
    
  const logMessage = extras ? `${base} ${extras}` : base;
  
  if (extra.error || step.includes('FAILED')) {
    logger.error(logMessage);
    if (extra.stack) {
      logger.error(`[STACK TRACE] ${extra.stack}`);
    }
  } else if (step.includes('WARN')) {
    logger.warn(logMessage);
  } else {
    logger.info(logMessage);
  }
};

// ─── Error translation ────────────────────────────────────────────────────────

const translateTelegramError = (error) => {
  const msg = error?.message ?? error?.toString() ?? '';

  if (msg.includes('PHONE_NUMBER_INVALID'))    return 'رقم الهاتف غير صالح. تحقق من الصيغة الدولية.';
  if (msg.includes('PHONE_NUMBER_BANNED'))     return 'هذا الرقم محظور من تيليجرام.';
  if (msg.includes('PHONE_CODE_INVALID'))      return 'رمز التحقق غير صحيح. حاول مرة أخرى.';
  if (msg.includes('PHONE_CODE_EXPIRED'))      return 'انتهت صلاحية رمز التحقق. أعد طلب رمز جديد.';
  if (msg.includes('PASSWORD_HASH_INVALID'))   return 'كلمة المرور غير صحيحة. حاول مرة أخرى.';
  if (msg.includes('SESSION_PASSWORD_NEEDED')) return 'يحتاج الحساب إلى كلمة مرور التحقق بخطوتين.';
  if (msg.includes('FLOOD_WAIT')) {
    const secs = msg.match(/\d+/)?.[0] ?? 'بضع';
    return `⏱ تجاوزت حد الطلبات. انتظر ${secs} ثانية ثم حاول مرة أخرى.`;
  }
  if (msg.includes('AUTH_KEY_UNREGISTERED'))   return 'انتهت صلاحية الجلسة. أعد تسجيل الدخول.';
  if (msg.includes('USER_DEACTIVATED'))        return 'هذا الحساب معطل أو محذوف.';
  if (msg.includes('NETWORK') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
    return 'خطأ في الاتصال بتيليجرام. قد يكون بسبب حظر IP الخادم، يرجى تفعيل البروكسي في الإعدادات.';
  }
  if (msg.includes('TOO_MANY_REQUESTS'))       return 'طلبات كثيرة جدًا. انتظر قليلًا ثم حاول.';
  if (msg.includes('TIMEOUT'))                 return 'انتهت مهلة الاتصال بتيليجرام. حاول مرة أخرى.';
  if (msg.includes('LOCAL_RESEND_THROTTLED')) {
    const sec = msg.split(':')[1] || 'بضع';
    return `⏱ الرجاء الانتظار ${sec} ثانية قبل طلب رمز جديد لنفس الرقم.`;
  }
  if (msg.includes('SEND_CODE_UNAVAILABLE')) {
    return 'تيليجرام لا يتيح إرسال الرمز لهذا الرقم حاليًا. تأكد من أنك تستخدم تطبيق تيليجرام الرسمي على هاتفك.';
  }
  if (msg.includes('API_ID_INVALID')) {
    return 'API_ID أو API_HASH غير صحيح. يرجى التحقق من ملف .env';
  }

  logger.warn('Unmapped Telegram error:', msg);
  return `خطأ غير متوقع: ${msg.slice(0, 100)}`;
};

// ─── Client factory ───────────────────────────────────────────────────────────

const buildClient = (sessionString = '', forSearch = false) => {
  const apiId   = parseInt(process.env.API_ID, 10);
  const apiHash = process.env.API_HASH;

  if (!apiId || !apiHash) {
    throw new Error('API_ID and API_HASH must be set in environment variables');
  }

  const session = new StringSession(sessionString);

  // Proxy Configuration (SOCKS5)
  let proxy = undefined;
  if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
    proxy = {
      ip: process.env.PROXY_HOST,
      port: parseInt(process.env.PROXY_PORT, 10),
      socksType: 5,
      timeout: 15,
    };
    if (process.env.PROXY_USER && process.env.PROXY_PASS) {
      proxy.username = process.env.PROXY_USER;
      proxy.password = process.env.PROXY_PASS;
    }
    logger.info(`Using SOCKS5 proxy: ${proxy.ip}:${proxy.port}`);
  }

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries:   forSearch ? 2 : 10,
    retryDelay:          forSearch ? 1000 : 3000,
    autoReconnect:       !forSearch,
    floodSleepThreshold: 60,
    requestRetries:      3,
    // Realistic device info to avoid being flagged
    deviceModel:         'Android 13',
    systemVersion:       'SDK 33',
    appVersion:          '10.3.2',
    langCode:            'ar',
    systemLangCode:      'en',
    proxy:               proxy,
  });

  return { client, session };
};

// ─── OTP Flow ─────────────────────────────────────────────────────────────────

/**
 * Initiate a login by sending an OTP.
 * Includes automatic retry and detailed logging.
 */
const sendOtp = async (userId, phone, accountId, { skipThrottle = false } = {}) => {
  const key = pendingKey(userId, phone);
  const startTime = Date.now();

  authLog('AUTH_START', userId, phone, { accountId });

  // Throttle check
  if (!skipThrottle) {
    const lastAt = lastSendAt.get(key);
    if (lastAt && Date.now() - lastAt < MIN_RESEND_GAP_MS) {
      const waitSec = Math.ceil((MIN_RESEND_GAP_MS - (Date.now() - lastAt)) / 1000);
      throw new Error(`LOCAL_RESEND_THROTTLED:${waitSec}`);
    }
  }

  // Cleanup old pending session for this user/phone
  if (pendingSessions.has(key)) {
    const old = pendingSessions.get(key);
    try { await old.client.disconnect(); } catch (_) {}
    pendingSessions.delete(key);
    authLog('PREV_SESSION_CLEANED', userId, phone, {});
  }

  const { client, session } = buildClient();

  try {
    authLog('CONNECTING_TO_TELEGRAM', userId, phone, { proxy: !!process.env.PROXY_HOST });
    await client.connect();
    authLog('CLIENT_CONNECTED', userId, phone, { responseTime: Date.now() - startTime });
  } catch (connErr) {
    try { await client.disconnect(); } catch (_) {}
    authLog('CONNECTION_FAILED', userId, phone, { 
      error: connErr.message, 
      stack: connErr.stack,
      responseTime: Date.now() - startTime 
    });
    throw connErr;
  }

  let result;
  let retryCount = 0;
  const maxRetries = 2;

  while (retryCount <= maxRetries) {
    try {
      authLog('SENDING_CODE_REQUEST', userId, phone, { attempt: retryCount + 1 });
      
      // We use sendCode which is the high-level method in GramJS
      result = await client.sendCode(
        { apiId: parseInt(process.env.API_ID, 10), apiHash: process.env.API_HASH },
        phone,
        false // forceSMS = false by default to allow app delivery
      );
      
      break; // Success
    } catch (error) {
      authLog('SEND_CODE_ATTEMPT_FAILED', userId, phone, { 
        attempt: retryCount + 1, 
        error: error.message,
        type: error.constructor.name
      });

      if (retryCount === maxRetries || error.message.includes('PHONE_NUMBER_INVALID') || error.message.includes('FLOOD_WAIT')) {
        try { await client.disconnect(); } catch (_) {}
        authLog('OTP_REQUEST_FINAL_FAILURE', userId, phone, { 
          error: error.message, 
          stack: error.stack,
          attempts: retryCount + 1
        });
        throw error;
      }
      
      retryCount++;
      await new Promise(r => setTimeout(r, 2000 * retryCount)); // Exponential backoff
    }
  }

  const channel = result.isCodeViaApp ? 'telegram-app' : 'sms/call';
  // Handle both gramjs result structures
  const phoneCodeHash = result.phoneCodeHash || result?.phoneCode?.phoneCodeHash;
  logger.info(`[AUTH] sendCode hash=${phoneCodeHash?.slice(0,8)}... channel=${channel}`);
  
  authLog('OTP_REQUESTED_SUCCESS', userId, phone, { 
    channel, 
    accountId, 
    responseTime: Date.now() - startTime,
    attempts: retryCount + 1
  });

  pendingSessions.set(key, {
    client,
    session,
    phoneCodeHash:      phoneCodeHash,
    isCodeViaApp:       result.isCodeViaApp,
    isPasswordRequired: false,
    phone,
    userId,
    accountId,
    createdAt:          Date.now(),
  });

  lastSendAt.set(key, Date.now());
  return { isCodeViaApp: result.isCodeViaApp };
};

/**
 * Re-send OTP using auth.ResendCode.
 */
const resendOtp = async (userId, phone) => {
  const key = pendingKey(userId, phone);
  const startTime = Date.now();

  const lastAt = lastResendAt.get(key);
  if (lastAt && Date.now() - lastAt < MIN_RESEND_BUTTON_GAP_MS) {
    const waitSec = Math.ceil((MIN_RESEND_BUTTON_GAP_MS - (Date.now() - lastAt)) / 1000);
    throw new Error(`LOCAL_RESEND_THROTTLED:${waitSec}`);
  }

  const pending = pendingSessions.get(key);
  if (!pending) throw new Error('NO_PENDING_SESSION');

  const { client, phoneCodeHash, accountId } = pending;
  authLog('OTP_RESEND_START', userId, phone, { accountId });

  try {
    const result = await client.invoke(
      new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash })
    );

    pending.phoneCodeHash = result.phoneCodeHash;
    pending.isCodeViaApp  = result.isCodeViaApp;
    pendingSessions.set(key, pending);
    lastResendAt.set(key, Date.now());

    const channel = result.isCodeViaApp ? 'telegram-app' : 'sms/call';
    authLog('OTP_RESEND_SUCCESS', userId, phone, { channel, responseTime: Date.now() - startTime });

    return { isCodeViaApp: result.isCodeViaApp };
  } catch (error) {
    authLog('OTP_RESEND_FAILED', userId, phone, { error: error.message, type: error.constructor.name });
    
    // Fallback to fresh sendOtp if ResendCode is unavailable
    if (error.message.includes('SEND_CODE_UNAVAILABLE')) {
      authLog('OTP_RESEND_FALLBACK', userId, phone, {});
      return await sendOtp(userId, phone, accountId, { skipThrottle: true });
    }
    
    throw error;
  }
};

/**
 * Verify OTP code.
 */
const verifyOtp = async (userId, phone, code) => {
  const key = pendingKey(userId, phone);
  const startTime = Date.now();
  const pending = pendingSessions.get(key);
  
  if (!pending) throw new Error('NO_PENDING_SESSION');

  const { client, session, phoneCodeHash, accountId } = pending;
  authLog('OTP_VERIFICATION_START', userId, phone, { accountId });

  try {
    // Use low-level API call - SignIn with phoneCodeHash from sendCode result
    const cleanCode = String(code).replace(/\s+/g, '').trim();
    logger.info(`[AUTH] verifyOtp using hash=${phoneCodeHash?.slice(0,8)}... code_len=${cleanCode.length}`);
    
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash: phoneCodeHash,
        phoneCode: cleanCode,
      })
    );

    const me = await client.getMe();
    const sessionString = session.save();

    // Success - Cleanup
    pendingSessions.delete(key);
    lastSendAt.delete(key);
    lastResendAt.delete(key);

    authLog('OTP_VERIFIED_SUCCESS', userId, phone, { accountId, responseTime: Date.now() - startTime });

    return {
      needsPassword: false,
      userInfo: {
        firstName:  me.firstName  ?? '',
        lastName:   me.lastName   ?? '',
        username:   me.username   ?? '',
        telegramId: String(me.id),
      },
      sessionString,
      client,
    };
  } catch (error) {
    if (error.message.includes('SESSION_PASSWORD_NEEDED')) {
      pending.isPasswordRequired = true;
      pendingSessions.set(key, pending);
      authLog('2FA_REQUIRED', userId, phone, { accountId });
      return { needsPassword: true };
    }
    
    authLog('OTP_VERIFICATION_FAILED', userId, phone, { 
      error: error.message, 
      stack: error.stack,
      responseTime: Date.now() - startTime 
    });
    throw error;
  }
};

/**
 * Verify 2FA password.
 */
const verifyPassword = async (userId, phone, password) => {
  const key = pendingKey(userId, phone);
  const startTime = Date.now();
  const pending = pendingSessions.get(key);
  
  if (!pending) throw new Error('NO_PENDING_SESSION');

  const { client, session, accountId } = pending;
  authLog('2FA_VERIFICATION_START', userId, phone, { accountId });

  try {
    // Use low-level 2FA password check
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    const { computeCheck } = require('telegram/Password');
    const passwordCheck = await computeCheck(passwordInfo, password);
    await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));

    const me = await client.getMe();
    const sessionString = session.save();

    pendingSessions.delete(key);
    lastSendAt.delete(key);
    lastResendAt.delete(key);

    authLog('2FA_VERIFIED_SUCCESS', userId, phone, { accountId, responseTime: Date.now() - startTime });

    return {
      userInfo: {
        firstName:  me.firstName  ?? '',
        lastName:   me.lastName   ?? '',
        username:   me.username   ?? '',
        telegramId: String(me.id),
      },
      sessionString,
      client,
    };
  } catch (error) {
    authLog('2FA_VERIFICATION_FAILED', userId, phone, { 
      error: error.message, 
      stack: error.stack,
      responseTime: Date.now() - startTime 
    });
    throw error;
  }
};

// ─── Session persistence ──────────────────────────────────────────────────────

const saveSession = (accountId, phone, sessionString) => {
  const encryptedSession = encrypt(sessionString);
  const safePhone        = phone.replace(/[^0-9]/g, '');
  const sessionFile      = path.join(sessionsDir, `${safePhone}_${accountId}.enc`);

  fs.writeFileSync(sessionFile, encryptedSession, 'utf-8');
  logger.info(`Session saved for account ${accountId} → ${sessionFile}`);

  return { sessionFile, encryptedSession };
};

const restoreSessionFile = (account) => {
  if (!account.encrypted_session) return null;

  const safePhone     = account.phone.replace(/[^0-9]/g, '');
  const canonicalPath = path.join(sessionsDir, `${safePhone}_${account.id}.enc`);

  if (fs.existsSync(canonicalPath)) return canonicalPath;

  try {
    fs.writeFileSync(canonicalPath, account.encrypted_session, 'utf-8');
    logger.info(`Session Restore: file recreated for account ${account.id}`);
    return canonicalPath;
  } catch (error) {
    logger.error(`Session Restore: failed for account ${account.id}:`, error);
    return null;
  }
};

const loadSession = async (sessionFile, options = {}) => {
  const { longLived = false } = options;

  if (!fs.existsSync(sessionFile)) {
    throw new Error('Session file not found');
  }

  const encryptedData = fs.readFileSync(sessionFile, 'utf-8');
  const sessionString = decrypt(encryptedData);
  const { client }    = buildClient(sessionString, !longLived);

  await client.connect();

  const isAuthorized = await client.isUserAuthorized();
  if (!isAuthorized) {
    await client.disconnect().catch(() => {});
    throw new Error('Session expired or unauthorized');
  }

  return client;
};

// ─── Active client registry ───────────────────────────────────────────────────

const registerActiveClient = (accountId, client, phone) => {
  activeClients.set(accountId, { client, phone, connectedAt: new Date() });
};

const disconnectClient = async (accountId) => {
  const entry = activeClients.get(accountId);
  if (entry) {
    try { await entry.client.disconnect(); } catch (_) {}
    activeClients.delete(accountId);
    logger.info(`Client ${accountId} disconnected`);
  }
};

const cleanupPending = async (userIdOrKey, phone) => {
  const keys = [];

  if (phone !== undefined) {
    keys.push(pendingKey(userIdOrKey, phone));
  } else if (userIdOrKey.includes(':')) {
    keys.push(userIdOrKey);
  } else {
    for (const k of pendingSessions.keys()) {
      if (k.endsWith(`:${userIdOrKey}`)) keys.push(k);
    }
  }

  for (const k of keys) {
    const pending = pendingSessions.get(k);
    if (pending) {
      try { await pending.client.disconnect(); } catch (_) {}
      pendingSessions.delete(k);
      logger.info(`[AUTH] step=CLEANUP key=${k}`);
    }
    lastSendAt.delete(k);
    lastResendAt.delete(k);
  }
};

const deleteSessionFile = (sessionFile) => {
  try {
    if (sessionFile && fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
      logger.info(`Session file deleted: ${sessionFile}`);
    }
  } catch (error) {
    logger.error('Failed to delete session file:', error);
  }
};

module.exports = {
  sendOtp,
  resendOtp,
  verifyOtp,
  verifyPassword,
  saveSession,
  loadSession,
  restoreSessionFile,
  registerActiveClient,
  disconnectClient,
  cleanupPending,
  deleteSessionFile,
  translateTelegramError,
  activeClients,
  pendingKey,
};
