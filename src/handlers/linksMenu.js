/**
 * Links Handler
 * Handles all callbacks and text inputs for the 🔗 الروابط section
 *
 * Wizard flow (7 logical steps):
 *  1. SELECT_ACCOUNTS / PICK_ACCOUNTS
 *  2. SELECT_LINK_TYPE         (telegram | whatsapp | both)
 *  3a. SELECT_TELEGRAM_SUBTYPE  (إذا كان telegram أو both)
 *  3b. SELECT_WHATSAPP_SUBTYPE  (إذا كان whatsapp أو both)
 *  4.  SELECT_PERIOD
 *  5.  SELECT_DEPTH
 *  6.  REVIEW
 */

const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { accountQueries } = require('../database/db');
const {
  linksOperationQueries,
  linksFoundQueries,
  linksStatsQueries,
  linksSettingsQueries,
} = require('../database/linksDb');
const linksService = require('../services/linksService');
const wizardState  = require('../services/linksWizardState');
const {
  WIZARD_STEPS,
  nextStepAfterType,
  nextStepAfterTelegramSubtype,
} = require('../services/linksWizardState');

const {
  linksMenuKeyboard,
  linksSelectAccountsKeyboard,
  linksPickAccountsKeyboard,
  linksSelectTypeKeyboard,
  linksTelegramSubtypeKeyboard,
  linksWhatsappSubtypeKeyboard,
  linksSelectPeriodKeyboard,
  linksSelectDepthKeyboard,
  linksReviewKeyboard,
  linksSearchControlsKeyboard,
  linksResultsKeyboard,
  linksOperationActionsKeyboard,
  linksConfirmDeleteOpKeyboard,
  linksSettingsKeyboard,
  linksHistoryKeyboard,
  linksConfirmCleanKeyboard,
  linksBackKeyboard,
} = require('../utils/linksKeyboards');

const {
  linksMenuMessage,
  linksStep1Message,
  linksStep2Message,
  linksStepTelegramSubtypeMessage,
  linksStepWhatsappSubtypeMessage,
  linksStep3Message,
  linksStep3CustomDateMessage,
  linksStep3CustomEndMessage,
  linksStep4Message,
  linksStep5ReviewMessage,
  linksLiveProgressMessage,
  linksFinalResultsMessage,
  linksNoFilesMessage,
  linksFilesListMessage,
  linksOperationDetailMessage,
  linksStatisticsMessage,
  linksSettingsMessage,
  linksNoHistoryMessage,
  linksHistoryMessage,
} = require('../utils/linksMessages');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const safeEdit = async (ctx, text, extra = {}) => {
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, extra);
    } else {
      await ctx.reply(text, extra);
    }
  } catch (_) {
    try {
      await ctx.reply(text, extra);
    } catch (err) {
      logger.error('safeEdit fallback error:', err);
    }
  }
};

const ack = async (ctx) => {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
  } catch (_) {}
};

const userId = (ctx) => String(ctx.from.id);

// ─── Main Menu ────────────────────────────────────────────────────────────────

const handleLinksMenu = async (ctx) => {
  try {
    wizardState.resetWizard(userId(ctx));
    await safeEdit(ctx, linksMenuMessage, {
      parse_mode: 'Markdown',
      ...linksMenuKeyboard(),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksMenu error:', error);
  }
};

// ─── Step 1: Start Search Wizard ──────────────────────────────────────────────

const handleLinksStartSearch = async (ctx) => {
  try {
    const uid = userId(ctx);

    if (linksService.hasActiveSearch(uid)) {
      await safeEdit(
        ctx,
        '⚠️ *يوجد بحث جارٍ بالفعل*\n\nيرجى انتظار انتهاء البحث الحالي أو إيقافه أولًا.',
        { parse_mode: 'Markdown', ...linksBackKeyboard() }
      );
      await ack(ctx);
      return;
    }

    const connectedAccounts = accountQueries
      .getAllByUserId(uid)
      .filter((a) => a.status === 'connected');

    if (!connectedAccounts.length) {
      await safeEdit(
        ctx,
        '⚠️ *لا توجد حسابات متصلة*\n\nيجب إضافة حساب تيليجرام متصل أولًا قبل بدء البحث.',
        { parse_mode: 'Markdown', ...linksBackKeyboard() }
      );
      await ack(ctx);
      return;
    }

    wizardState.startWizard(uid);
    await safeEdit(ctx, linksStep1Message, {
      parse_mode: 'Markdown',
      ...linksSelectAccountsKeyboard(),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksStartSearch error:', error);
  }
};

// ─── Step 1 Handlers ──────────────────────────────────────────────────────────

const handleLinksAccountsAll = async (ctx) => {
  const uid = userId(ctx);
  wizardState.setWizardState(uid, {
    accountMode: 'all',
    selectedAccountIds: [],
    step: WIZARD_STEPS.SELECT_LINK_TYPE,
  });
  await safeEdit(ctx, linksStep2Message, { parse_mode: 'Markdown', ...linksSelectTypeKeyboard() });
  await ack(ctx);
};

const handleLinksAccountsOne      = async (ctx) => _showAccountPicker(ctx, 'one');
const handleLinksAccountsTwo      = async (ctx) => _showAccountPicker(ctx, 'two');
const handleLinksAccountsMultiple = async (ctx) => _showAccountPicker(ctx, 'multiple');

const _showAccountPicker = async (ctx, mode) => {
  const uid      = userId(ctx);
  const accounts = accountQueries.getAllByUserId(uid).filter((a) => a.status === 'connected');
  wizardState.setWizardState(uid, { accountMode: mode, selectedAccountIds: [], step: WIZARD_STEPS.PICK_ACCOUNTS });
  await safeEdit(
    ctx,
    `🔍 *اختر الحسابات*\n\nاضغط على الحساب لتحديده أو إلغاء تحديده:`,
    { parse_mode: 'Markdown', ...linksPickAccountsKeyboard(accounts, []) }
  );
  await ack(ctx);
};

const handleLinksToggleAccount = async (ctx, accountId) => {
  const uid      = userId(ctx);
  const wiz      = wizardState.getWizardState(uid);
  const selected = wiz.selectedAccountIds || [];
  const idx      = selected.indexOf(accountId);
  if (idx === -1) {
    selected.push(accountId);
  } else {
    selected.splice(idx, 1);
  }
  wizardState.setWizardState(uid, { selectedAccountIds: selected });

  const accounts = accountQueries.getAllByUserId(uid).filter((a) => a.status === 'connected');
  await safeEdit(
    ctx,
    `🔍 *اختر الحسابات*\n\nاضغط على الحساب لتحديده أو إلغاء تحديده:`,
    { parse_mode: 'Markdown', ...linksPickAccountsKeyboard(accounts, selected) }
  );
  await ack(ctx);
};

const handleLinksConfirmAccounts = async (ctx) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);

  if (!wiz.selectedAccountIds || !wiz.selectedAccountIds.length) {
    await ctx.answerCbQuery('⚠️ لم تحدد أي حساب', { show_alert: true });
    return;
  }

  wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_LINK_TYPE });
  await safeEdit(ctx, linksStep2Message, { parse_mode: 'Markdown', ...linksSelectTypeKeyboard() });
  await ack(ctx);
};

// ─── Step 2: Link Type ────────────────────────────────────────────────────────

const _setLinkType = async (ctx, type) => {
  const uid      = userId(ctx);
  const nextStep = nextStepAfterType(type);
  wizardState.setWizardState(uid, {
    linkType: type,
    telegramSubTypes: [],
    whatsappSubTypes: [],
    step: nextStep,
  });

  if (nextStep === WIZARD_STEPS.SELECT_TELEGRAM_SUBTYPE) {
    await safeEdit(ctx, linksStepTelegramSubtypeMessage, {
      parse_mode: 'Markdown',
      ...linksTelegramSubtypeKeyboard([]),
    });
  } else {
    // whatsapp only
    await safeEdit(ctx, linksStepWhatsappSubtypeMessage, {
      parse_mode: 'Markdown',
      ...linksWhatsappSubtypeKeyboard([]),
    });
  }
  await ack(ctx);
};

const handleLinksTypeBoth     = (ctx) => _setLinkType(ctx, 'both');
const handleLinksTypeTelegram = (ctx) => _setLinkType(ctx, 'telegram');
const handleLinksTypeWhatsapp = (ctx) => _setLinkType(ctx, 'whatsapp');

// ─── Step 3a: Telegram Sub-type ───────────────────────────────────────────────

/**
 * Toggle a Telegram sub-type value in the wizard state
 * @param {string} value  'public_group' | 'channel' | 'private_group' | 'all'
 */
const handleLinksTgSubToggle = async (ctx, value) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);
  let selected = [...(wiz.telegramSubTypes || [])];

  if (value === 'all') {
    // Selecting 'all' clears other choices
    selected = selected.includes('all') ? [] : ['all'];
  } else {
    // Remove 'all' if a specific type is chosen
    selected = selected.filter((v) => v !== 'all');
    const idx = selected.indexOf(value);
    if (idx === -1) {
      selected.push(value);
    } else {
      selected.splice(idx, 1);
    }
  }

  wizardState.setWizardState(uid, { telegramSubTypes: selected });
  await safeEdit(ctx, linksStepTelegramSubtypeMessage, {
    parse_mode: 'Markdown',
    ...linksTelegramSubtypeKeyboard(selected),
  });
  await ack(ctx);
};

/**
 * Confirm Telegram sub-type selection and advance
 */
const handleLinksTgSubConfirm = async (ctx) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);

  if (!wiz.telegramSubTypes || !wiz.telegramSubTypes.length) {
    await ctx.answerCbQuery('⚠️ يرجى اختيار نوع واحد على الأقل', { show_alert: true });
    return;
  }

  const nextStep = nextStepAfterTelegramSubtype(wiz.linkType);
  wizardState.setWizardState(uid, { step: nextStep });

  if (nextStep === WIZARD_STEPS.SELECT_WHATSAPP_SUBTYPE) {
    await safeEdit(ctx, linksStepWhatsappSubtypeMessage, {
      parse_mode: 'Markdown',
      ...linksWhatsappSubtypeKeyboard(wiz.whatsappSubTypes || []),
    });
  } else {
    // Go to period
    await safeEdit(ctx, linksStep3Message, {
      parse_mode: 'Markdown',
      ...linksSelectPeriodKeyboard(),
    });
  }
  await ack(ctx);
};

// ─── Step 3b: WhatsApp Sub-type ───────────────────────────────────────────────

const handleLinksWaSubToggle = async (ctx, value) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);
  let selected = [...(wiz.whatsappSubTypes || [])];

  if (value === 'all') {
    selected = selected.includes('all') ? [] : ['all'];
  } else {
    selected = selected.filter((v) => v !== 'all');
    const idx = selected.indexOf(value);
    if (idx === -1) {
      selected.push(value);
    } else {
      selected.splice(idx, 1);
    }
  }

  wizardState.setWizardState(uid, { whatsappSubTypes: selected });
  await safeEdit(ctx, linksStepWhatsappSubtypeMessage, {
    parse_mode: 'Markdown',
    ...linksWhatsappSubtypeKeyboard(selected),
  });
  await ack(ctx);
};

const handleLinksWaSubConfirm = async (ctx) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);

  if (!wiz.whatsappSubTypes || !wiz.whatsappSubTypes.length) {
    await ctx.answerCbQuery('⚠️ يرجى اختيار نوع واحد على الأقل', { show_alert: true });
    return;
  }

  wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_PERIOD });
  await safeEdit(ctx, linksStep3Message, {
    parse_mode: 'Markdown',
    ...linksSelectPeriodKeyboard(),
  });
  await ack(ctx);
};

// ─── Step 4: Period ───────────────────────────────────────────────────────────

const _setPeriod = async (ctx, period) => {
  const uid = userId(ctx);
  wizardState.setWizardState(uid, { period, step: WIZARD_STEPS.SELECT_DEPTH });
  await safeEdit(ctx, linksStep4Message, { parse_mode: 'Markdown', ...linksSelectDepthKeyboard() });
  await ack(ctx);
};

const handleLinksPeriodDay     = (ctx) => _setPeriod(ctx, 'day');
const handleLinksPeriodWeek    = (ctx) => _setPeriod(ctx, 'week');
const handleLinksPeriodMonth   = (ctx) => _setPeriod(ctx, 'month');
const handleLinksPeriod3Months = (ctx) => _setPeriod(ctx, '3months');
const handleLinksPeriodYear    = (ctx) => _setPeriod(ctx, 'year');

const handleLinksPeriodCustom = async (ctx) => {
  const uid = userId(ctx);
  wizardState.setWizardState(uid, { period: 'custom', step: WIZARD_STEPS.AWAITING_CUSTOM_START });
  await safeEdit(ctx, linksStep3CustomDateMessage, {
    parse_mode: 'Markdown',
    ...linksBackKeyboard(),
  });
  await ack(ctx);
};

// ─── Step 5: Depth ────────────────────────────────────────────────────────────

const _setDepth = async (ctx, depth) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);
  wizardState.setWizardState(uid, { searchDepth: depth, step: WIZARD_STEPS.REVIEW });

  const accountIds =
    wiz.accountMode === 'all'
      ? accountQueries.getAllByUserId(uid).filter((a) => a.status === 'connected').map((a) => a.id)
      : (wiz.selectedAccountIds || []);
  const accounts = accountIds.map((id) => accountQueries.getById(id)).filter(Boolean);

  const updatedWiz = wizardState.getWizardState(uid);
  await safeEdit(ctx, linksStep5ReviewMessage(updatedWiz, accounts), {
    parse_mode: 'Markdown',
    ...linksReviewKeyboard(),
  });
  await ack(ctx);
};

const handleLinksDepthFast   = (ctx) => _setDepth(ctx, 'fast');
const handleLinksDepthMedium = (ctx) => _setDepth(ctx, 'medium');
const handleLinksDepthDeep   = (ctx) => _setDepth(ctx, 'deep');

// ─── Execute Search ───────────────────────────────────────────────────────────

const handleLinksExecuteSearch = async (ctx) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);

  if (!wiz.linkType || !wiz.period || !wiz.searchDepth) {
    await ctx.answerCbQuery('⚠️ الإعدادات غير مكتملة، ابدأ من جديد.', { show_alert: true });
    wizardState.resetWizard(uid);
    return;
  }

  // Create operation record
  const operationId = linksOperationQueries.create(uid, wiz);
  wizardState.setWizardState(uid, { step: WIZARD_STEPS.SEARCHING, operationId });

  // Send initial live screen
  const initialMsg = linksLiveProgressMessage({
    currentAccount: '—',
    doneAccounts: 0,
    remainingAccounts: 0,
    scannedMessages: 0,
    scannedChats: 0,
    totalLinks: 0,
    telegramLinks: 0,
    whatsappLinks: 0,
    duplicatesRemoved: 0,
    newLinks: 0,
    savedLinks: 0,
    speed: 0,
    elapsedSeconds: 0,
    etaSeconds: null,
    percent: 0,
    lastAction: 'جارٍ التهيئة...',
    lastLink: '',
  });

  let liveMessageId = null;
  try {
    const sent = await ctx.editMessageText(initialMsg, {
      parse_mode: 'Markdown',
      ...linksSearchControlsKeyboard(false),
    });
    liveMessageId = sent?.message_id || ctx.callbackQuery?.message?.message_id;
  } catch (_) {
    const sent = await ctx.reply(initialMsg, {
      parse_mode: 'Markdown',
      ...linksSearchControlsKeyboard(false),
    });
    liveMessageId = sent?.message_id;
  }

  await ack(ctx);

  // Progress update throttle
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL_MS = 2000;

  const onProgress = async (progress) => {
    const now = Date.now();
    if (now - lastUpdateTime < UPDATE_INTERVAL_MS && progress.percent < 100) return;
    lastUpdateTime = now;
    try {
      if (liveMessageId) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          liveMessageId,
          undefined,
          linksLiveProgressMessage(progress),
          {
            parse_mode: 'Markdown',
            ...linksSearchControlsKeyboard(progress.isPaused),
          }
        );
      }
    } catch (_) {}
  };

  // Run search in background
  linksService.runSearch(uid, operationId, wiz, onProgress)
    .then(async (results) => {
      wizardState.resetWizard(uid);
      const finalText = linksFinalResultsMessage(results);
      try {
        if (liveMessageId) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            liveMessageId,
            undefined,
            finalText,
            { parse_mode: 'Markdown', ...linksResultsKeyboard(operationId) }
          );
        } else {
          await ctx.reply(finalText, { parse_mode: 'Markdown', ...linksResultsKeyboard(operationId) });
        }
      } catch (_) {
        await ctx.reply(finalText, { parse_mode: 'Markdown', ...linksResultsKeyboard(operationId) });
      }
    })
    .catch(async (error) => {
      logger.error('Search failed:', error);
      wizardState.resetWizard(uid);
      try {
        await ctx.reply(
          `❌ *حدث خطأ أثناء البحث*\n\n${error.message?.slice(0, 200) || 'خطأ غير متوقع'}`,
          { parse_mode: 'Markdown', ...linksBackKeyboard() }
        );
      } catch (_) {}
    });
};

// ─── Search Controls ──────────────────────────────────────────────────────────

const handleLinksPauseSearch = async (ctx) => {
  linksService.pauseSearch(userId(ctx));
  await ctx.answerCbQuery('⏸ تم إيقاف البحث مؤقتًا');
  try {
    await ctx.editMessageReplyMarkup(linksSearchControlsKeyboard(true).reply_markup);
  } catch (_) {}
};

const handleLinksResumeSearch = async (ctx) => {
  linksService.resumeSearch(userId(ctx));
  await ctx.answerCbQuery('▶️ تم استكمال البحث');
  try {
    await ctx.editMessageReplyMarkup(linksSearchControlsKeyboard(false).reply_markup);
  } catch (_) {}
};

const handleLinksStopSearch = async (ctx) => {
  linksService.stopSearch(userId(ctx));
  await ctx.answerCbQuery('⏹ جارٍ إيقاف البحث...');
};

// ─── Back Navigation ──────────────────────────────────────────────────────────

const handleLinksBackToStep1 = async (ctx) => {
  const uid = userId(ctx);
  wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_ACCOUNTS });
  await safeEdit(ctx, linksStep1Message, { parse_mode: 'Markdown', ...linksSelectAccountsKeyboard() });
  await ack(ctx);
};

const handleLinksBackToStep2 = async (ctx) => {
  const uid = userId(ctx);
  wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_LINK_TYPE });
  await safeEdit(ctx, linksStep2Message, { parse_mode: 'Markdown', ...linksSelectTypeKeyboard() });
  await ack(ctx);
};

/**
 * Back to Telegram sub-type (from WhatsApp sub-type in 'both' mode,
 * or back to Telegram sub-type from period)
 */
const handleLinksBackToStep3a = async (ctx) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);
  wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_TELEGRAM_SUBTYPE });
  await safeEdit(ctx, linksStepTelegramSubtypeMessage, {
    parse_mode: 'Markdown',
    ...linksTelegramSubtypeKeyboard(wiz.telegramSubTypes || []),
  });
  await ack(ctx);
};

/**
 * Back to the last sub-type step before period:
 * - 'whatsapp' only → WhatsApp sub-type
 * - 'telegram' or 'both' → Telegram sub-type
 * Called from period screen's back button (links_back_to_step3)
 */
const handleLinksBackToStep3 = async (ctx) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);

  if (wiz.linkType === 'whatsapp') {
    wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_WHATSAPP_SUBTYPE });
    await safeEdit(ctx, linksStepWhatsappSubtypeMessage, {
      parse_mode: 'Markdown',
      ...linksWhatsappSubtypeKeyboard(wiz.whatsappSubTypes || []),
    });
  } else if (wiz.linkType === 'both') {
    wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_WHATSAPP_SUBTYPE });
    await safeEdit(ctx, linksStepWhatsappSubtypeMessage, {
      parse_mode: 'Markdown',
      ...linksWhatsappSubtypeKeyboard(wiz.whatsappSubTypes || []),
    });
  } else {
    // telegram only
    wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_TELEGRAM_SUBTYPE });
    await safeEdit(ctx, linksStepTelegramSubtypeMessage, {
      parse_mode: 'Markdown',
      ...linksTelegramSubtypeKeyboard(wiz.telegramSubTypes || []),
    });
  }
  await ack(ctx);
};

const handleLinksBackToStep4 = async (ctx) => {
  const uid = userId(ctx);
  wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_PERIOD });
  await safeEdit(ctx, linksStep3Message, { parse_mode: 'Markdown', ...linksSelectPeriodKeyboard() });
  await ack(ctx);
};

const handleLinksBackToStep5 = async (ctx) => {
  const uid = userId(ctx);
  wizardState.setWizardState(uid, { step: WIZARD_STEPS.SELECT_DEPTH });
  await safeEdit(ctx, linksStep4Message, { parse_mode: 'Markdown', ...linksSelectDepthKeyboard() });
  await ack(ctx);
};

// ─── Extracted Files ──────────────────────────────────────────────────────────

const handleLinksExtractedFiles = async (ctx) => {
  const uid = userId(ctx);
  try {
    const operations = linksOperationQueries.getCompletedByUserId(uid);
    if (!operations.length) {
      await safeEdit(ctx, linksNoFilesMessage, { parse_mode: 'Markdown', ...linksBackKeyboard() });
    } else {
      const text = linksFilesListMessage(operations);
      const rows = operations.slice(0, 10).map((op, i) => [
        require('telegraf').Markup.button.callback(
          `📁 ${i + 1}. ${op.name.slice(0, 30)}`,
          `links_view_op_${op.id}`
        ),
      ]);
      rows.push([require('telegraf').Markup.button.callback('⬅️ رجوع', 'links_menu')]);
      await safeEdit(ctx, text, {
        parse_mode: 'Markdown',
        ...require('telegraf').Markup.inlineKeyboard(rows),
      });
    }
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksExtractedFiles error:', error);
  }
};

const handleLinksViewOperation = async (ctx, operationId) => {
  try {
    const op = linksOperationQueries.getById(operationId);
    if (!op || op.user_id !== userId(ctx)) {
      await ctx.answerCbQuery('⚠️ العملية غير موجودة', { show_alert: true });
      return;
    }
    await safeEdit(ctx, linksOperationDetailMessage(op), {
      parse_mode: 'Markdown',
      ...linksOperationActionsKeyboard(operationId),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksViewOperation error:', error);
  }
};

const handleLinksDownloadOperation = async (ctx, operationId) => {
  const uid = userId(ctx);
  try {
    const op = linksOperationQueries.getById(operationId);
    if (!op || op.user_id !== uid) {
      await ctx.answerCbQuery('⚠️ العملية غير موجودة', { show_alert: true });
      return;
    }
    await ack(ctx);

    if (!op.output_dir || !fs.existsSync(op.output_dir)) {
      await ctx.reply('⚠️ لم يتم العثور على ملفات لهذه العملية.');
      return;
    }

    const files = fs.readdirSync(op.output_dir);
    for (const file of files) {
      const filePath = path.join(op.output_dir, file);
      try {
        await ctx.replyWithDocument({ source: filePath, filename: file });
      } catch (sendErr) {
        logger.warn(`Failed to send file ${file}:`, sendErr.message);
      }
    }
  } catch (error) {
    logger.error('handleLinksDownloadOperation error:', error);
  }
};

const handleLinksRenameOperation = async (ctx, operationId) => {
  const uid = userId(ctx);
  wizardState.setWizardState(uid, {
    step: WIZARD_STEPS.AWAITING_RENAME,
    renameTargetId: operationId,
  });
  await safeEdit(
    ctx,
    `✏️ *إعادة تسمية العملية*\n\nأدخل الاسم الجديد للعملية:`,
    { parse_mode: 'Markdown', ...linksBackKeyboard() }
  );
  await ack(ctx);
};

const handleLinksDeleteOperationPrompt = async (ctx, operationId) => {
  const op = linksOperationQueries.getById(operationId);
  if (!op || op.user_id !== userId(ctx)) {
    await ctx.answerCbQuery('⚠️ العملية غير موجودة', { show_alert: true });
    return;
  }
  await safeEdit(
    ctx,
    `🗑 *حذف العملية*\n\nهل تريد حذف *${op.name}* وجميع ملفاتها؟\nلا يمكن التراجع عن هذا الإجراء.`,
    { parse_mode: 'Markdown', ...linksConfirmDeleteOpKeyboard(operationId) }
  );
  await ack(ctx);
};

const handleLinksConfirmDeleteOperation = async (ctx, operationId) => {
  const uid = userId(ctx);
  try {
    const op = linksOperationQueries.getById(operationId);
    if (op && op.output_dir && fs.existsSync(op.output_dir)) {
      fs.rmSync(op.output_dir, { recursive: true, force: true });
    }
    linksOperationQueries.deleteById(operationId, uid);
    await safeEdit(ctx, '✅ تم حذف العملية وملفاتها بنجاح.', {
      parse_mode: 'Markdown',
      ...linksBackKeyboard(),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksConfirmDeleteOperation error:', error);
  }
};

const handleLinksExportOperation = async (ctx, operationId) => {
  return handleLinksDownloadOperation(ctx, operationId);
};

// ─── Statistics ───────────────────────────────────────────────────────────────

const handleLinksStatistics = async (ctx) => {
  try {
    const stats = linksStatsQueries.getByUserId(userId(ctx));
    await safeEdit(ctx, linksStatisticsMessage(stats), {
      parse_mode: 'Markdown',
      ...linksBackKeyboard(),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksStatistics error:', error);
  }
};

// ─── Settings ─────────────────────────────────────────────────────────────────

const handleLinksSettings = async (ctx) => {
  try {
    const settings = linksSettingsQueries.get(userId(ctx));
    await safeEdit(ctx, linksSettingsMessage, {
      parse_mode: 'Markdown',
      ...linksSettingsKeyboard(settings),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksSettings error:', error);
  }
};

const handleLinksToggleSetting = async (ctx, key) => {
  const uid = userId(ctx);
  try {
    const settings = linksSettingsQueries.get(uid);
    const boolKeys = ['remove_duplicates', 'save_history', 'auto_stop_on_error', 'retry_on_fail'];
    if (boolKeys.includes(key)) {
      const newVal = settings[key] ? 0 : 1;
      linksSettingsQueries.upsert(uid, key, newVal);
    }
    const updated = linksSettingsQueries.get(uid);
    await safeEdit(ctx, linksSettingsMessage, {
      parse_mode: 'Markdown',
      ...linksSettingsKeyboard(updated),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksToggleSetting error:', error);
  }
};

// ─── History ──────────────────────────────────────────────────────────────────

const handleLinksHistory = async (ctx) => {
  try {
    const ops = linksOperationQueries.getAllByUserId(userId(ctx));
    if (!ops.length) {
      await safeEdit(ctx, linksNoHistoryMessage, {
        parse_mode: 'Markdown',
        ...linksBackKeyboard(),
      });
    } else {
      await safeEdit(ctx, linksHistoryMessage(ops.slice(0, 20)), {
        parse_mode: 'Markdown',
        ...linksHistoryKeyboard(),
      });
    }
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksHistory error:', error);
  }
};

// ─── Clean Files ──────────────────────────────────────────────────────────────

const handleLinksCleanFiles = async (ctx) => {
  try {
    const ops = linksOperationQueries.getCompletedByUserId(userId(ctx));
    if (!ops.length) {
      await safeEdit(ctx, '🗑 *لا توجد ملفات للحذف.*', {
        parse_mode: 'Markdown',
        ...linksBackKeyboard(),
      });
    } else {
      await safeEdit(
        ctx,
        `🗑 *تنظيف الملفات*\n\nسيتم حذف جميع الملفات المستخرجة (${ops.length} عملية).\nهل أنت متأكد؟`,
        { parse_mode: 'Markdown', ...linksConfirmCleanKeyboard() }
      );
    }
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksCleanFiles error:', error);
  }
};

const handleLinksConfirmClean = async (ctx) => {
  const uid = userId(ctx);
  try {
    const ops = linksOperationQueries.getCompletedByUserId(uid);
    let deletedFiles = 0;
    for (const op of ops) {
      if (op.output_dir && fs.existsSync(op.output_dir)) {
        fs.rmSync(op.output_dir, { recursive: true, force: true });
        deletedFiles++;
      }
    }
    linksOperationQueries.deleteAllByUserId(uid);
    await safeEdit(
      ctx,
      `✅ *تم تنظيف الملفات*\n\nتم حذف ${ops.length} عملية و ${deletedFiles} مجلد من الملفات.`,
      { parse_mode: 'Markdown', ...linksBackKeyboard() }
    );
    await ack(ctx);
  } catch (error) {
    logger.error('handleLinksConfirmClean error:', error);
  }
};

// ─── Text Input Handler ───────────────────────────────────────────────────────

const handleLinksTextInput = async (ctx) => {
  const uid  = userId(ctx);
  const wiz  = wizardState.getWizardState(uid);
  const text = ctx.message?.text?.trim() || '';

  switch (wiz.step) {
    case WIZARD_STEPS.AWAITING_CUSTOM_START: {
      if (!_isValidDate(text)) {
        await ctx.reply('⚠️ صيغة التاريخ غير صحيحة. استخدم الصيغة: `YYYY-MM-DD`\nمثال: `2024-01-01`', {
          parse_mode: 'Markdown',
        });
        return;
      }
      wizardState.setWizardState(uid, {
        customStart: text,
        step: WIZARD_STEPS.AWAITING_CUSTOM_END,
      });
      await ctx.reply(linksStep3CustomEndMessage, {
        parse_mode: 'Markdown',
        ...linksBackKeyboard(),
      });
      break;
    }

    case WIZARD_STEPS.AWAITING_CUSTOM_END: {
      if (!_isValidDate(text)) {
        await ctx.reply('⚠️ صيغة التاريخ غير صحيحة. استخدم الصيغة: `YYYY-MM-DD`', {
          parse_mode: 'Markdown',
        });
        return;
      }

      const startDate = new Date(wiz.customStart);
      const endDate   = new Date(text);
      if (endDate < startDate) {
        await ctx.reply('⚠️ تاريخ النهاية يجب أن يكون بعد تاريخ البداية.', {
          parse_mode: 'Markdown',
        });
        return;
      }

      wizardState.setWizardState(uid, {
        customEnd: text,
        step: WIZARD_STEPS.SELECT_DEPTH,
      });
      await ctx.reply(linksStep4Message, {
        parse_mode: 'Markdown',
        ...linksSelectDepthKeyboard(),
      });
      break;
    }

    case WIZARD_STEPS.AWAITING_RENAME: {
      const targetId = wiz.renameTargetId;
      if (!targetId) {
        wizardState.resetWizard(uid);
        return;
      }
      if (text.length < 1 || text.length > 80) {
        await ctx.reply('⚠️ الاسم يجب أن يكون بين 1 و 80 حرفًا.');
        return;
      }
      linksOperationQueries.rename(targetId, uid, text);
      wizardState.resetWizard(uid);
      await ctx.reply(`✅ تم تغيير الاسم إلى: *${text}*`, {
        parse_mode: 'Markdown',
        ...linksBackKeyboard(),
      });
      break;
    }

    default:
      break;
  }
};

// ─── Date Validator ───────────────────────────────────────────────────────────

const _isValidDate = (str) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  handleLinksMenu,
  handleLinksStartSearch,
  // Step 1
  handleLinksAccountsAll,
  handleLinksAccountsOne,
  handleLinksAccountsTwo,
  handleLinksAccountsMultiple,
  handleLinksToggleAccount,
  handleLinksConfirmAccounts,
  // Step 2
  handleLinksTypeBoth,
  handleLinksTypeTelegram,
  handleLinksTypeWhatsapp,
  // Step 3a — Telegram sub-type
  handleLinksTgSubToggle,
  handleLinksTgSubConfirm,
  // Step 3b — WhatsApp sub-type
  handleLinksWaSubToggle,
  handleLinksWaSubConfirm,
  // Step 4 — Period
  handleLinksPeriodDay,
  handleLinksPeriodWeek,
  handleLinksPeriodMonth,
  handleLinksPeriod3Months,
  handleLinksPeriodYear,
  handleLinksPeriodCustom,
  // Step 5 — Depth
  handleLinksDepthFast,
  handleLinksDepthMedium,
  handleLinksDepthDeep,
  // Execute
  handleLinksExecuteSearch,
  // Controls
  handleLinksPauseSearch,
  handleLinksResumeSearch,
  handleLinksStopSearch,
  // Back navigation
  handleLinksBackToStep1,
  handleLinksBackToStep2,
  handleLinksBackToStep3a,
  handleLinksBackToStep3,
  handleLinksBackToStep4,
  handleLinksBackToStep5,
  // Files
  handleLinksExtractedFiles,
  handleLinksViewOperation,
  handleLinksDownloadOperation,
  handleLinksRenameOperation,
  handleLinksDeleteOperationPrompt,
  handleLinksConfirmDeleteOperation,
  handleLinksExportOperation,
  // Other sections
  handleLinksStatistics,
  handleLinksSettings,
  handleLinksToggleSetting,
  handleLinksHistory,
  handleLinksCleanFiles,
  handleLinksConfirmClean,
  // Text router
  handleLinksTextInput,
};
