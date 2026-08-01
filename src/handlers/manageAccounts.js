const logger = require('../utils/logger');
const { accountQueries } = require('../database/db');
const telegramClient = require('../services/telegramClient');
const sessionState = require('../services/sessionState');
const { maskPhone } = require('../utils/encryption');
const { Markup } = require('telegraf');

const {
  mainMenuKeyboard,
  accountActionsKeyboard,
  confirmDeleteKeyboard,
  backToMenuKeyboard,
  backToListKeyboard,
  cancelKeyboard,
  otpKeyboard,
  editAccountKeyboard,
  afterRefreshKeyboard,
  statsKeyboard,
} = require('../utils/keyboards');

const {
  accountCardMessage,
  accountDetailMessage,
  noAccountsMessage,
  refreshStartMessage,
  refreshResultMessage,
  statsMessage,
  editAccountMessage,
  statusEmoji,
  statusText,
  otpRequestMessage,
} = require('../utils/messages');

// ─── Helper: safe edit/reply ──────────────────────────────────────────────────

/**
 * Attempt editMessageText; fall back to reply on failure.
 */
const safeEdit = async (ctx, text, extra = {}) => {
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, extra);
    } else {
      await ctx.reply(text, extra);
    }
  } catch (_) {
    await ctx.reply(text, extra);
  }
};

// ─── List Accounts ────────────────────────────────────────────────────────────

/**
 * Show all accounts for the current bot user
 */
const handleListAccounts = async (ctx) => {
  const userId = String(ctx.from.id);

  try {
    const accounts = accountQueries.getAllByUserId(userId);

    if (!accounts.length) {
      await safeEdit(ctx, noAccountsMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ إضافة حساب', 'add_account')],
          [Markup.button.callback('🏠 القائمة الرئيسية', 'main_menu')],
        ]),
      });

      if (ctx.callbackQuery) await ctx.answerCbQuery();
      return;
    }

    let headerText =
      `📋 *قائمة الحسابات* — (${accounts.length})\n` +
      `${'─'.repeat(28)}\n\n`;

    headerText += accounts
      .map((acc, i) => accountCardMessage(acc, i + 1))
      .join('\n\n');

    headerText += '\n\n*اختر حسابًا لعرض تفاصيله وإدارته:*';

    const accountButtons = accounts.map((acc, i) => {
      const emoji = statusEmoji[acc.status] || '⚪️';
      const name =
        [acc.first_name, acc.last_name].filter(Boolean).join(' ') ||
        maskPhone(acc.phone);
      return [
        Markup.button.callback(
          `${emoji} ${i + 1}. ${name.slice(0, 22)}`,
          `account_detail_${acc.id}`
        ),
      ];
    });

    accountButtons.push([
      Markup.button.callback('➕ إضافة حساب', 'add_account'),
      Markup.button.callback('📊 إحصائيات', 'accounts_stats'),
    ]);
    accountButtons.push([
      Markup.button.callback('🔄 تحديث الكل', 'refresh_all_status'),
      Markup.button.callback('🏠 الرئيسية', 'main_menu'),
    ]);

    await safeEdit(ctx, headerText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(accountButtons),
    });

    if (ctx.callbackQuery) await ctx.answerCbQuery();
  } catch (error) {
    logger.error('handleListAccounts error:', error);
    if (ctx.callbackQuery) await ctx.answerCbQuery('حدث خطأ').catch(() => {});
    await ctx.reply('حدث خطأ أثناء تحميل الحسابات.', backToMenuKeyboard());
  }
};

// ─── Account Detail ───────────────────────────────────────────────────────────

/**
 * Show full account detail and action buttons
 * @param {object} ctx
 * @param {number} accountId
 */
const handleAccountDetail = async (ctx, accountId) => {
  const userId = String(ctx.from.id);

  try {
    const account = accountQueries.getById(accountId);

    if (!account || String(account.user_id) !== userId) {
      await ctx.answerCbQuery('⚠️ الحساب غير موجود أو غير مصرح لك');
      return;
    }

    const text = accountDetailMessage(account);

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...accountActionsKeyboard(account.id, account.status),
    });
  } catch (error) {
    logger.error('handleAccountDetail error:', error);
    await ctx.answerCbQuery('حدث خطأ، حاول مرة أخرى').catch(() => {});
  }
};

// ─── Edit Account (select account) ───────────────────────────────────────────

/**
 * Show list of accounts to choose one for editing
 */
const handleEditAccountList = async (ctx) => {
  const userId = String(ctx.from.id);

  try {
    const accounts = accountQueries.getAllByUserId(userId);

    if (!accounts.length) {
      await safeEdit(ctx, noAccountsMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ إضافة حساب', 'add_account')],
          [Markup.button.callback('🏠 القائمة الرئيسية', 'main_menu')],
        ]),
      });
      if (ctx.callbackQuery) await ctx.answerCbQuery();
      return;
    }

    const accountButtons = accounts.map((acc, i) => {
      const emoji = statusEmoji[acc.status] || '⚪️';
      const name =
        [acc.first_name, acc.last_name].filter(Boolean).join(' ') ||
        maskPhone(acc.phone);
      return [
        Markup.button.callback(
          `${emoji} ${i + 1}. ${name.slice(0, 22)}`,
          `edit_account_${acc.id}`
        ),
      ];
    });

    accountButtons.push([
      Markup.button.callback('🔙 رجوع', 'list_accounts'),
    ]);

    await safeEdit(ctx, `✏️ *تعديل حساب*\n\nاختر الحساب الذي تريد تعديله:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(accountButtons),
    });

    if (ctx.callbackQuery) await ctx.answerCbQuery();
  } catch (error) {
    logger.error('handleEditAccountList error:', error);
    if (ctx.callbackQuery) await ctx.answerCbQuery('حدث خطأ').catch(() => {});
    await ctx.reply('حدث خطأ.', backToMenuKeyboard());
  }
};

/**
 * Show edit options for a specific account
 * @param {object} ctx
 * @param {number} accountId
 */
const handleEditAccount = async (ctx, accountId) => {
  const userId = String(ctx.from.id);

  try {
    const account = accountQueries.getById(accountId);

    if (!account || String(account.user_id) !== userId) {
      await ctx.answerCbQuery('⚠️ الحساب غير موجود');
      return;
    }

    const text = editAccountMessage(account);

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...editAccountKeyboard(account.id),
    });

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error('handleEditAccount error:', error);
    await ctx.answerCbQuery('حدث خطأ').catch(() => {});
  }
};

// ─── Check / Refresh Status ───────────────────────────────────────────────────

/**
 * Check live status of a single account
 * @param {object} ctx
 * @param {number} accountId
 */
const handleCheckStatus = async (ctx, accountId) => {
  const userId = String(ctx.from.id);

  try {
    await ctx.answerCbQuery('⏳ جارٍ فحص الحالة...');

    const account = accountQueries.getById(accountId);
    if (!account || String(account.user_id) !== userId) return;

    let isAlive = false;

    if (account.session_file) {
      try {
        const client = await telegramClient.loadSession(account.session_file);
        isAlive = true;
        telegramClient.registerActiveClient(accountId, client, account.phone);
        accountQueries.updateStatus(accountId, 'connected', { error_message: null });
      } catch (sessionError) {
        logger.warn(`Session check failed for account ${accountId}:`, sessionError);
        accountQueries.updateStatus(accountId, 'disconnected', {
          error_message: sessionError.message,
        });
      }
    }

    const freshAccount = accountQueries.getById(accountId);
    const statusMsg = isAlive
      ? `🟢 *الحساب متصل وفعّال*\n\nآخر فحص: الآن ✓`
      : `🔴 *الجلسة منتهية أو غير متصلة*\n\nيُنصح بإعادة تسجيل الدخول.`;

    await safeEdit(ctx, statusMsg, {
      parse_mode: 'Markdown',
      ...accountActionsKeyboard(accountId, isAlive ? 'connected' : 'disconnected'),
    });
  } catch (error) {
    logger.error('handleCheckStatus error:', error);
    await ctx.reply('حدث خطأ أثناء فحص الحالة.', backToMenuKeyboard());
  }
};

/**
 * Refresh status for ALL accounts belonging to the current bot user
 */
const handleRefreshAllStatus = async (ctx) => {
  const userId = String(ctx.from.id);

  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery('⏳ جارٍ التحديث...');

    const accounts = accountQueries.getAllByUserId(userId);

    if (!accounts.length) {
      await safeEdit(ctx, noAccountsMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ إضافة حساب', 'add_account')],
          [Markup.button.callback('🏠 القائمة الرئيسية', 'main_menu')],
        ]),
      });
      return;
    }

    // Show progress message
    await safeEdit(ctx, refreshStartMessage(accounts.length), {
      parse_mode: 'Markdown',
    });

    // Check each account
    const results = [];

    for (const account of accounts) {
      let isAlive = false;
      let errorMsg = null;

      if (account.session_file) {
        try {
          const client = await telegramClient.loadSession(account.session_file);
          isAlive = true;
          telegramClient.registerActiveClient(account.id, client, account.phone);
          accountQueries.updateStatus(account.id, 'connected', { error_message: null });
        } catch (err) {
          errorMsg = err.message;
          accountQueries.updateStatus(account.id, 'disconnected', {
            error_message: err.message,
          });
          logger.warn(`Refresh: account ${account.id} disconnected:`, err.message);
        }
      } else {
        // No session file → mark as disconnected if status was connected
        if (account.status === 'connected') {
          accountQueries.updateStatus(account.id, 'disconnected', {
            error_message: 'لا يوجد ملف جلسة',
          });
        }
        errorMsg = 'لا يوجد ملف جلسة';
      }

      results.push({ account, isAlive, error: errorMsg });
    }

    const resultText = refreshResultMessage(results);

    await ctx.reply(resultText, {
      parse_mode: 'Markdown',
      ...afterRefreshKeyboard(),
    });
  } catch (error) {
    logger.error('handleRefreshAllStatus error:', error);
    await ctx.reply('حدث خطأ أثناء تحديث الحالات.', backToMenuKeyboard());
  }
};

// ─── Delete Account ───────────────────────────────────────────────────────────

/**
 * Show list of accounts to pick one for deletion
 */
const handleDeleteAccountList = async (ctx) => {
  const userId = String(ctx.from.id);

  try {
    const accounts = accountQueries.getAllByUserId(userId);

    if (!accounts.length) {
      await safeEdit(ctx, noAccountsMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ إضافة حساب', 'add_account')],
          [Markup.button.callback('🏠 القائمة الرئيسية', 'main_menu')],
        ]),
      });
      if (ctx.callbackQuery) await ctx.answerCbQuery();
      return;
    }

    const accountButtons = accounts.map((acc, i) => {
      const emoji = statusEmoji[acc.status] || '⚪️';
      const name =
        [acc.first_name, acc.last_name].filter(Boolean).join(' ') ||
        maskPhone(acc.phone);
      return [
        Markup.button.callback(
          `${emoji} ${i + 1}. ${name.slice(0, 22)}`,
          `delete_confirm_${acc.id}`
        ),
      ];
    });

    accountButtons.push([
      Markup.button.callback('🔙 رجوع', 'list_accounts'),
    ]);

    await safeEdit(
      ctx,
      `🗑 *حذف حساب*\n\nاختر الحساب الذي تريد حذفه:\n\n⚠️ لا يمكن التراجع عن الحذف.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(accountButtons),
      }
    );

    if (ctx.callbackQuery) await ctx.answerCbQuery();
  } catch (error) {
    logger.error('handleDeleteAccountList error:', error);
    if (ctx.callbackQuery) await ctx.answerCbQuery('حدث خطأ').catch(() => {});
    await ctx.reply('حدث خطأ.', backToMenuKeyboard());
  }
};

/**
 * Show delete confirmation for a specific account
 * @param {object} ctx
 * @param {number} accountId
 */
const handleDeleteConfirm = async (ctx, accountId) => {
  const userId = String(ctx.from.id);

  try {
    const account = accountQueries.getById(accountId);

    if (!account || String(account.user_id) !== userId) {
      await ctx.answerCbQuery('⚠️ الحساب غير موجود');
      return;
    }

    const name =
      [account.first_name, account.last_name].filter(Boolean).join(' ') ||
      maskPhone(account.phone);

    const emoji = statusEmoji[account.status] || '⚪️';
    const statusLabel = statusText[account.status] || account.status;

    const text =
      `🗑️ *تأكيد الحذف*\n` +
      `${'─'.repeat(25)}\n\n` +
      `*الحساب:* ${name}\n` +
      `*الهاتف:* \`${maskPhone(account.phone)}\`\n` +
      `*الحالة:* ${emoji} ${statusLabel}\n\n` +
      `⚠️ هل أنت متأكد من حذف هذا الحساب؟\n` +
      `*لا يمكن التراجع عن هذا الإجراء.*`;

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...confirmDeleteKeyboard(accountId),
    });

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error('handleDeleteConfirm error:', error);
    await ctx.answerCbQuery('حدث خطأ').catch(() => {});
  }
};

/**
 * Execute account deletion
 * @param {object} ctx
 * @param {number} accountId
 */
const handleDeleteAccount = async (ctx, accountId) => {
  const userId = String(ctx.from.id);

  try {
    const account = accountQueries.getById(accountId);

    if (!account || String(account.user_id) !== userId) {
      await ctx.answerCbQuery('⚠️ الحساب غير موجود');
      return;
    }

    const name =
      [account.first_name, account.last_name].filter(Boolean).join(' ') ||
      maskPhone(account.phone);

    // Disconnect active client
    await telegramClient.disconnectClient(accountId).catch((err) => {
      logger.warn(`Disconnect before delete failed for ${accountId}:`, err.message);
    });

    // Delete session file
    if (account.session_file) {
      telegramClient.deleteSessionFile(account.session_file);
    }

    // Remove from DB
    accountQueries.deleteById(accountId, userId);

    logger.info(`Account ${accountId} (${account.phone}) deleted by user ${userId}`);

    await ctx.editMessageText(
      `✅ *تم حذف الحساب بنجاح*\n\n` +
        `*الحساب المحذوف:* ${name}\n` +
        `*الهاتف:* \`${maskPhone(account.phone)}\``,
      {
        parse_mode: 'Markdown',
        ...backToListKeyboard(),
      }
    );

    await ctx.answerCbQuery('✅ تم الحذف');
  } catch (error) {
    logger.error('handleDeleteAccount error:', error);
    await ctx.reply('حدث خطأ أثناء الحذف.', backToMenuKeyboard());
  }
};

// ─── Re-Login ─────────────────────────────────────────────────────────────────

/**
 * Initiate re-login for an existing account
 * @param {object} ctx
 * @param {number} accountId
 */
const handleRelogin = async (ctx, accountId) => {
  const userId = String(ctx.from.id);

  try {
    const account = accountQueries.getById(accountId);

    if (!account || String(account.user_id) !== userId) {
      await ctx.answerCbQuery('⚠️ الحساب غير موجود');
      return;
    }

    // Disconnect if active
    await telegramClient.disconnectClient(accountId).catch(() => {});

    accountQueries.updateStatus(accountId, 'connecting', { error_message: null });

    await ctx.editMessageText(
      `🔄 *إعادة تسجيل الدخول*\n\n⏳ جارٍ إرسال رمز التحقق إلى:\n\`${maskPhone(account.phone)}\``,
      {
        parse_mode: 'Markdown',
        ...cancelKeyboard(),
      }
    );

    await ctx.answerCbQuery();

    try {
      // KEY FIX: pass userId + accountId so pendingSessions uses composite key.
      const { isCodeViaApp } = await telegramClient.sendOtp(userId, account.phone, accountId);
      accountQueries.updateStatus(accountId, 'otp_sent');
      sessionState.setAwaitingOtp(userId, account.phone, accountId);

      // FIX: use otpKeyboard() (includes "لم يصلني الرمز") instead of cancelKeyboard().
      await ctx.reply(otpRequestMessage(account.phone, isCodeViaApp), {
        parse_mode: 'Markdown',
        ...otpKeyboard(),
      });
    } catch (sendError) {
      logger.error('Relogin sendOtp error:', sendError);
      accountQueries.updateStatus(accountId, 'error', {
        error_message: sendError.message,
      });
      const friendlyError = telegramClient.translateTelegramError(sendError);
      await ctx.reply(
        `❌ *فشل إرسال رمز التحقق*\n\n${friendlyError}`,
        {
          parse_mode: 'Markdown',
          ...backToListKeyboard(),
        }
      );
    }
  } catch (error) {
    logger.error('handleRelogin error:', error);
    await ctx.reply('حدث خطأ. حاول مرة أخرى.', backToMenuKeyboard());
  }
};

// ─── Statistics ───────────────────────────────────────────────────────────────

/**
 * Show account statistics for the current bot user
 */
const handleAccountsStats = async (ctx) => {
  const userId = String(ctx.from.id);

  try {
    const stats = accountQueries.getStatsByUserId(userId);
    const text = statsMessage(stats);

    await safeEdit(ctx, text, {
      parse_mode: 'Markdown',
      ...statsKeyboard(),
    });

    if (ctx.callbackQuery) await ctx.answerCbQuery();
  } catch (error) {
    logger.error('handleAccountsStats error:', error);
    if (ctx.callbackQuery) await ctx.answerCbQuery('حدث خطأ').catch(() => {});
    await ctx.reply('حدث خطأ أثناء تحميل الإحصائيات.', backToMenuKeyboard());
  }
};

module.exports = {
  handleListAccounts,
  handleAccountDetail,
  handleEditAccountList,
  handleEditAccount,
  handleCheckStatus,
  handleRefreshAllStatus,
  handleDeleteAccountList,
  handleDeleteConfirm,
  handleDeleteAccount,
  handleRelogin,
  handleAccountsStats,
};
