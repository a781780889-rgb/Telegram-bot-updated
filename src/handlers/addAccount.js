/**
 * Add Account Flow Handler
 *
 * CHANGES (OTP fix):
 *  - All telegramClient calls now pass (userId, phone, accountId) instead of
 *    just phone, matching the new composite-key API in telegramClient.js.
 *  - cleanupPending() called as cleanupPending(userId, phone).
 *  - handleResendOtp passes userId from ctx.from.id to resendOtp().
 *  - otpKeyboard() is now shown on the relogin path as well (was cancelKeyboard).
 *  - Timeout handler in textRouter now calls cleanupPending to close dangling sockets.
 */

const logger = require('../utils/logger');
const { validatePhoneNumber, validateOtpCode, sanitizeInput } = require('../utils/validators');
const { accountQueries } = require('../database/db');
const telegramClient = require('../services/telegramClient');
const sessionState = require('../services/sessionState');
const {
  mainMenuKeyboard,
  cancelKeyboard,
  otpKeyboard,
  backToMenuKeyboard,
  retryKeyboard,
} = require('../utils/keyboards');
const {
  phoneRequestMessage,
  otpRequestMessage,
  passwordRequestMessage,
  successMessage,
  errorOtpExpired,
  errorTooManyAttempts,
} = require('../utils/messages');

const MAX_OTP_ATTEMPTS = 3;

/**
 * Handle "add_account" button press
 */
const handleAddAccountStart = async (ctx) => {
  try {
    const userId = String(ctx.from.id);

    sessionState.setAwaitingPhone(userId);

    await ctx.editMessageText(phoneRequestMessage, {
      parse_mode: 'Markdown',
      ...cancelKeyboard(),
    });
  } catch (error) {
    logger.error('handleAddAccountStart error:', error);
    await ctx.reply('حدث خطأ. حاول مرة أخرى.', backToMenuKeyboard());
  }
};

/**
 * Handle phone number input
 */
const handlePhoneInput = async (ctx) => {
  const userId = String(ctx.from.id);
  const rawPhone = sanitizeInput(ctx.message.text);

  const { valid, normalized, error } = validatePhoneNumber(rawPhone);

  if (!valid) {
    await ctx.reply(`❌ ${error}`, cancelKeyboard());
    return;
  }

  // Check if phone already added for this user
  const existing = accountQueries.getByUserIdAndPhone(userId, normalized);
  if (existing && existing.status === 'connected') {
    await ctx.reply(
      `⚠️ هذا الرقم مضاف بالفعل وحالته: متصل.\n\nلإعادة تسجيل الدخول اذهب إلى قائمة الحسابات.`,
      backToMenuKeyboard()
    );
    sessionState.resetState(userId);
    return;
  }

  // Create/update account record in DB
  const accountId = accountQueries.insert(userId, normalized);

  try {
    const sendingMsg = await ctx.reply('⏳ جارٍ إرسال رمز التحقق...', cancelKeyboard());

    // KEY FIX: pass userId + accountId so pendingSessions uses composite key.
    const { isCodeViaApp } = await telegramClient.sendOtp(userId, normalized, accountId);

    // Update status in DB
    accountQueries.updateStatus(accountId, 'otp_sent');

    // Transition state
    sessionState.setAwaitingOtp(userId, normalized, accountId);

    await ctx.reply(otpRequestMessage(normalized, isCodeViaApp), {
      parse_mode: 'Markdown',
      ...otpKeyboard(),
    });

    // Delete the "sending..." message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, sendingMsg.message_id);
    } catch (_) {}
  } catch (error) {
    logger.error('sendOtp error:', error);
    accountQueries.updateStatus(accountId, 'error', {
      error_message: error.message,
    });
    sessionState.resetState(userId);

    const friendlyError = telegramClient.translateTelegramError(error);
    await ctx.reply(`❌ فشل إرسال رمز التحقق\n\n${friendlyError}`, retryKeyboard());
  }
};

/**
 * Handle OTP code input
 */
const handleOtpInput = async (ctx) => {
  const userId = String(ctx.from.id);
  const state = sessionState.getState(userId);
  const rawCode = sanitizeInput(ctx.message.text);

  const { valid, cleaned, error } = validateOtpCode(rawCode);

  if (!valid) {
    await ctx.reply(`❌ ${error}\n\nأدخل الرمز المكون من 5 أرقام:`, cancelKeyboard());
    return;
  }

  // Attempt increment
  sessionState.incrementAttempts(userId);
  const attempts = sessionState.getAttempts(userId);

  if (attempts > MAX_OTP_ATTEMPTS) {
    sessionState.resetState(userId);
    await telegramClient.cleanupPending(userId, state.phone);
    accountQueries.updateStatus(state.accountId, 'error', {
      error_message: 'Max OTP attempts exceeded',
    });
    await ctx.reply(errorTooManyAttempts, retryKeyboard());
    return;
  }

  try {
    const verifyingMsg = await ctx.reply('⏳ جارٍ التحقق من الرمز...');
    // KEY FIX: pass userId so verifyOtp finds the right composite-key entry.
    const result = await telegramClient.verifyOtp(userId, state.phone, cleaned);

    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, verifyingMsg.message_id);
    } catch (_) {}

    if (result.needsPassword) {
      sessionState.setAwaitingPassword(userId, state.phone, state.accountId);
      accountQueries.updateStatus(state.accountId, 'needs_password');
      await ctx.reply(passwordRequestMessage, {
        parse_mode: 'Markdown',
        ...cancelKeyboard(),
      });
      return;
    }

    // Success — save session
    await finalizeLogin(ctx, userId, state.accountId, state.phone, result);
  } catch (error) {
    logger.error('verifyOtp error:', error);

    // ── جلسة OTP مفقودة (مثلاً بعد إعادة تشغيل البوت) ───────────────────────
    if (error.message?.includes('NO_PENDING_SESSION')) {
      logger.warn(`NO_PENDING_SESSION for user=${userId} phone=${state.phone}: session lost, auto-resending OTP`);
      sessionState.resetState(userId);
      await ctx.reply(
        '⚠️ انتهت جلسة التحقق (أُعيد تشغيل البوت). جارٍ إرسال رمز تحقق جديد تلقائيًا...'
      );
      try {
        const { isCodeViaApp } = await telegramClient.sendOtp(userId, state.phone, state.accountId);
        sessionState.setAwaitingOtp(userId, state.phone, state.accountId);
        await ctx.reply(otpRequestMessage(state.phone, isCodeViaApp), {
          parse_mode: 'Markdown',
          ...otpKeyboard(),
        });
      } catch (resendError) {
        logger.error('Resend OTP after session loss:', resendError);
        await ctx.reply(
          `❌ فشل إرسال رمز جديد\n\n${telegramClient.translateTelegramError(resendError)}`,
          retryKeyboard()
        );
      }
      return;
    }

    const friendlyError = telegramClient.translateTelegramError(error);

    if (
      error.message?.includes('PHONE_CODE_EXPIRED') ||
      error.errorMessage === 'PHONE_CODE_EXPIRED'
    ) {
      // Auto-resend
      sessionState.resetState(userId);
      await telegramClient.cleanupPending(userId, state.phone);
      await ctx.reply(errorOtpExpired);

      try {
        const { isCodeViaApp } = await telegramClient.sendOtp(userId, state.phone, state.accountId);
        sessionState.setAwaitingOtp(userId, state.phone, state.accountId);
        await ctx.reply(otpRequestMessage(state.phone, isCodeViaApp), {
          parse_mode: 'Markdown',
          ...otpKeyboard(),
        });
      } catch (resendError) {
        logger.error('Resend OTP error:', resendError);
        await ctx.reply(
          `❌ فشل إرسال رمز جديد\n\n${telegramClient.translateTelegramError(resendError)}`,
          retryKeyboard()
        );
      }
      return;
    }

    await ctx.reply(
      `❌ رمز التحقق غير صحيح (المحاولة ${attempts}/${MAX_OTP_ATTEMPTS})\n\n${friendlyError}\n\nأعد إدخال الرمز:`,
      cancelKeyboard()
    );
  }
};

/**
 * Handle "لم يصلني الرمز" (didn't receive code) button press during the
 * OTP step. Uses Telegram's official auth.resendCode call.
 */
const handleResendOtp = async (ctx) => {
  const userId = String(ctx.from.id);
  const state = sessionState.getState(userId);

  if (!state.phone) {
    await ctx.answerCbQuery('لا توجد عملية إضافة حساب قيد الانتظار.', { show_alert: true }).catch(() => {});
    return;
  }

  try {
    await ctx.answerCbQuery('⏳ جارٍ إعادة إرسال الرمز...').catch(() => {});

    // KEY FIX: pass userId so resendOtp finds the right composite-key entry.
    const { isCodeViaApp } = await telegramClient.resendOtp(userId, state.phone);

    await ctx.reply(otpRequestMessage(state.phone, isCodeViaApp), {
      parse_mode: 'Markdown',
      ...otpKeyboard(),
    });
  } catch (error) {
    logger.error('resendOtp error:', error);

    if (error.message?.includes('NO_PENDING_SESSION')) {
      sessionState.resetState(userId);
      await ctx.reply(
        '⚠️ انتهت جلسة التحقق. الرجاء البدء من جديد بإضافة الحساب.',
        retryKeyboard()
      );
      return;
    }

    const friendlyError = telegramClient.translateTelegramError(error);
    await ctx.reply(`❌ تعذّر إعادة إرسال الرمز\n\n${friendlyError}`, otpKeyboard());
  }
};

/**
 * Handle 2FA password input
 */
const handlePasswordInput = async (ctx) => {
  const userId = String(ctx.from.id);
  const state = sessionState.getState(userId);
  const password = sanitizeInput(ctx.message.text);

  if (!password) {
    await ctx.reply('❌ كلمة المرور لا يمكن أن تكون فارغة. أدخل كلمة المرور:', cancelKeyboard());
    return;
  }

  // Delete the password message immediately for security
  try {
    await ctx.deleteMessage();
  } catch (_) {}

  sessionState.incrementAttempts(userId);
  const attempts = sessionState.getAttempts(userId);

  if (attempts > MAX_OTP_ATTEMPTS) {
    sessionState.resetState(userId);
    await telegramClient.cleanupPending(userId, state.phone);
    accountQueries.updateStatus(state.accountId, 'error', {
      error_message: 'Max password attempts exceeded',
    });
    await ctx.reply(errorTooManyAttempts, retryKeyboard());
    return;
  }

  try {
    const checkingMsg = await ctx.reply('⏳ جارٍ التحقق من كلمة المرور...');
    // KEY FIX: pass userId to verifyPassword.
    const result = await telegramClient.verifyPassword(userId, state.phone, password);

    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, checkingMsg.message_id);
    } catch (_) {}

    await finalizeLogin(ctx, userId, state.accountId, state.phone, result);
  } catch (error) {
    logger.error('verifyPassword error:', error);
    const friendlyError = telegramClient.translateTelegramError(error);

    await ctx.reply(
      `❌ كلمة المرور غير صحيحة (المحاولة ${attempts}/${MAX_OTP_ATTEMPTS})\n\n${friendlyError}\n\nأعد إدخال كلمة المرور:`,
      cancelKeyboard()
    );
  }
};

/**
 * Finalize login: save session, update DB, show success
 */
const finalizeLogin = async (ctx, userId, accountId, phone, result) => {
  const { userInfo, sessionString, client } = result;

  // Save session encrypted
  const { sessionFile, encryptedSession } = telegramClient.saveSession(
    accountId,
    phone,
    sessionString
  );

  // Update DB with full user info
  accountQueries.updateStatus(accountId, 'connected', {
    first_name: userInfo.firstName,
    last_name: userInfo.lastName,
    username: userInfo.username,
    telegram_id: userInfo.telegramId,
    session_file: sessionFile,
    encrypted_session: encryptedSession,
    error_message: null,
  });

  // Register active client
  telegramClient.registerActiveClient(accountId, client, phone);

  // Reset conversation state
  sessionState.resetState(userId);

  // Fetch fresh account data for display
  const account = accountQueries.getById(accountId);

  await ctx.reply(successMessage(account), {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(),
  });

  logger.info(`[AUTH] step=LOGIN_COMPLETED userId=${userId} accountId=${accountId}`);
};

/**
 * Handle cancel button during flow
 */
const handleCancelFlow = async (ctx) => {
  const userId = String(ctx.from.id);
  const state = sessionState.getState(userId);

  if (state.phone) {
    // KEY FIX: pass userId so cleanupPending finds the right composite-key entry.
    await telegramClient.cleanupPending(userId, state.phone);

    if (state.accountId) {
      accountQueries.updateStatus(state.accountId, 'error', {
        error_message: 'Cancelled by user',
      });
    }
  }

  sessionState.resetState(userId);

  const cancelText = '❌ تم الإلغاء.\n\nاختر أحد الخيارات:';
  try {
    await ctx.editMessageText(cancelText, {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard(),
    });
  } catch (_) {
    // Message may be too old to edit (e.g. user pressed Cancel on a text reply
    // instead of an inline button) — fall back to sending a new message.
    await ctx.reply(cancelText, { parse_mode: 'Markdown', ...mainMenuKeyboard() }).catch(() => {});
  }
};

module.exports = {
  handleAddAccountStart,
  handlePhoneInput,
  handleOtpInput,
  handlePasswordInput,
  handleCancelFlow,
  handleResendOtp,
};
