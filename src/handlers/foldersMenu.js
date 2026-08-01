/**
 * Central Groups DB + Telegram Folders Handler
 * Handles all callbacks and text inputs for the 📁 قسم المجلدات section.
 */

const logger = require('../utils/logger');
const {
  joinGroupQueries,
  folderQueries,
  folderGroupQueries,
  folderSettingsQueries,
} = require('../database/joinDb');
const foldersService = require('../services/foldersService');
const wizardState = require('../services/foldersWizardState');
const { WIZARD_STEPS } = require('../services/foldersWizardState');

const {
  foldersMenuKeyboard,
  foldersBackKeyboard,
  foldersStatsKeyboard,
  foldersListKeyboard,
  folderDetailKeyboard,
  folderDeleteConfirmKeyboard,
  foldersSettingsKeyboard,
  foldersSettingsBackKeyboard,
} = require('../utils/foldersKeyboards');

const {
  foldersMenuMessage,
  foldersStatsMessage,
  foldersNoFoldersMessage,
  foldersListMessage,
  folderDetailMessage,
  foldersOrganizeNoGroupsMessage,
  foldersOrganizeResultMessage,
  foldersSettingsMessage,
  foldersEditPromptMessages,
} = require('../utils/foldersMessages');

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
      logger.error('foldersMenu safeEdit fallback error:', err);
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

const handleFoldersMenu = async (ctx) => {
  try {
    wizardState.resetWizard(userId(ctx));
    await safeEdit(ctx, foldersMenuMessage, { parse_mode: 'Markdown', ...foldersMenuKeyboard() });
    await ack(ctx);
  } catch (error) {
    logger.error('handleFoldersMenu error:', error);
  }
};

// ─── Central Stats ────────────────────────────────────────────────────────────

const handleFoldersStats = async (ctx) => {
  try {
    const uid = userId(ctx);
    const stats = joinGroupQueries.getCentralStats(uid);
    await safeEdit(ctx, foldersStatsMessage(stats), {
      parse_mode: 'Markdown',
      ...foldersStatsKeyboard(),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleFoldersStats error:', error);
  }
};

// ─── Organize pipeline ────────────────────────────────────────────────────────

const handleFoldersOrganize = async (ctx) => {
  try {
    const uid = userId(ctx);
    const unfolderedCount = joinGroupQueries.countUnfolderedByUserId(uid);

    if (!unfolderedCount) {
      await safeEdit(ctx, foldersOrganizeNoGroupsMessage, {
        parse_mode: 'Markdown',
        ...foldersBackKeyboard(),
      });
      await ack(ctx);
      return;
    }

    await ack(ctx);
    await safeEdit(ctx, '⏳ جاري تنظيم المجموعات وإنشاء المجلدات على تيليجرام…', {
      parse_mode: 'Markdown',
    });

    const result = await foldersService.runFolderPipeline(uid);

    await ctx.reply(foldersOrganizeResultMessage(result), {
      parse_mode: 'Markdown',
      ...foldersBackKeyboard(),
    });
  } catch (error) {
    logger.error('handleFoldersOrganize error:', error);
    await ctx.reply('⚠️ حدث خطأ أثناء تنظيم المجموعات. حاول مرة أخرى.', {
      ...foldersBackKeyboard(),
    });
  }
};

// ─── Folder List / Detail ─────────────────────────────────────────────────────

const handleFoldersList = async (ctx) => {
  try {
    const uid = userId(ctx);
    const folders = folderQueries.getAllByUserId(uid);

    if (!folders.length) {
      await safeEdit(ctx, foldersNoFoldersMessage, { parse_mode: 'Markdown', ...foldersBackKeyboard() });
      await ack(ctx);
      return;
    }

    await safeEdit(ctx, foldersListMessage, {
      parse_mode: 'Markdown',
      ...foldersListKeyboard(folders),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleFoldersList error:', error);
  }
};

const handleFolderDetail = async (ctx, folderId) => {
  try {
    const folder = folderQueries.getById(folderId);
    if (!folder || folder.user_id !== userId(ctx)) {
      await safeEdit(ctx, '⚠️ المجلد غير موجود.', { parse_mode: 'Markdown', ...foldersBackKeyboard() });
      await ack(ctx);
      return;
    }

    const groupRows = folderGroupQueries.getByFolderId(folderId);

    await safeEdit(ctx, folderDetailMessage(folder, groupRows), {
      parse_mode: 'Markdown',
      ...folderDetailKeyboard(folder),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleFolderDetail error:', error);
  }
};

const handleFolderPush = async (ctx, folderId) => {
  try {
    const uid = userId(ctx);
    const folder = folderQueries.getById(folderId);
    if (!folder || folder.user_id !== uid) {
      await ack(ctx);
      return;
    }

    await ack(ctx);
    await safeEdit(ctx, '⏳ جاري إنشاء المجلد على تيليجرام…', { parse_mode: 'Markdown' });

    await foldersService.createTelegramFolder(uid, folderId);
    await handleFolderDetail(ctx, folderId);
  } catch (error) {
    logger.error('handleFolderPush error:', error);
  }
};

const handleFolderDeleteConfirm = async (ctx, folderId) => {
  try {
    const folder = folderQueries.getById(folderId);
    if (!folder || folder.user_id !== userId(ctx)) {
      await ack(ctx);
      return;
    }
    await safeEdit(ctx, `⚠️ هل تريد حذف *${folder.name}*؟\n\nستعود مجموعاته إلى قائمة الانتظار لتنظيمها لاحقًا ضمن مجلد جديد.`, {
      parse_mode: 'Markdown',
      ...folderDeleteConfirmKeyboard(folderId),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleFolderDeleteConfirm error:', error);
  }
};

const handleFolderDeleteYes = async (ctx, folderId) => {
  try {
    const uid = userId(ctx);
    folderQueries.deleteById(folderId, uid);
    await handleFoldersList(ctx);
  } catch (error) {
    logger.error('handleFolderDeleteYes error:', error);
  }
};

// ─── Settings ─────────────────────────────────────────────────────────────────

const handleFoldersSettings = async (ctx) => {
  try {
    const uid = userId(ctx);
    const settings = folderSettingsQueries.get(uid);
    await safeEdit(ctx, foldersSettingsMessage(settings), {
      parse_mode: 'Markdown',
      ...foldersSettingsKeyboard(),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleFoldersSettings error:', error);
  }
};

const handleFoldersEditGroupsPerFolder = async (ctx) => {
  try {
    const uid = userId(ctx);
    wizardState.setWizardState(uid, { step: WIZARD_STEPS.AWAITING_GROUPS_PER_FOLDER });
    await safeEdit(ctx, foldersEditPromptMessages.groups_per_folder, {
      parse_mode: 'Markdown',
      ...foldersSettingsBackKeyboard(),
    });
    await ack(ctx);
  } catch (error) {
    logger.error('handleFoldersEditGroupsPerFolder error:', error);
  }
};

const handleFoldersSettingsTextInput = async (ctx) => {
  const uid = userId(ctx);
  const text = (ctx.message?.text || '').trim();
  const value = parseInt(text, 10);

  if (isNaN(value) || value <= 0) {
    await ctx.reply('⚠️ يرجى إدخال رقم صحيح أكبر من صفر.');
    return;
  }

  folderSettingsQueries.update(uid, { groups_per_folder: value });
  wizardState.resetWizard(uid);

  const settings = folderSettingsQueries.get(uid);
  await ctx.reply(foldersSettingsMessage(settings), {
    parse_mode: 'Markdown',
    ...foldersSettingsKeyboard(),
  });
};

// ─── Text Input Router ────────────────────────────────────────────────────────

const handleFoldersTextInput = async (ctx) => {
  const uid = userId(ctx);
  const wiz = wizardState.getWizardState(uid);

  switch (wiz.step) {
    case WIZARD_STEPS.AWAITING_GROUPS_PER_FOLDER:
      return handleFoldersSettingsTextInput(ctx);
    default:
      break;
  }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  handleFoldersMenu,
  handleFoldersStats,
  handleFoldersOrganize,
  handleFoldersList,
  handleFolderDetail,
  handleFolderPush,
  handleFolderDeleteConfirm,
  handleFolderDeleteYes,
  handleFoldersSettings,
  handleFoldersEditGroupsPerFolder,
  handleFoldersTextInput,
};
