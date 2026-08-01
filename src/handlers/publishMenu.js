/**
 * Publishing Engine Handlers
 */

const logger = require('../utils/logger');
const messages = require('../utils/publishMessages');
const keyboards = require('../utils/publishKeyboards');
const { adQueries, taskQueries, logQueries } = require('../database/publishDb');
const publishWizardState = require('../services/publishWizardState');
const { WIZARD_STEPS } = publishWizardState;

/**
 * Utility: safely edit message or send new one
 */
const safeEdit = async (ctx, text, keyboard) => {
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  } catch (e) {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  }
};

const handlePublishMenu = async (ctx) => {
  await safeEdit(ctx, messages.publishMenu(), keyboards.publishMenuKeyboard());
};

const handleAdsLibrary = async (ctx) => {
  const userId = String(ctx.from.id);
  const ads = adQueries.getAll(userId);
  await safeEdit(ctx, messages.adsLibraryMenu(ads.length), keyboards.adsLibraryKeyboard(ads));
};

const handleAdAddStart = async (ctx) => {
  const userId = String(ctx.from.id);
  publishWizardState.setWizardState(userId, WIZARD_STEPS.AWAITING_AD_CONTENT);
  await ctx.answerCbQuery();
  await ctx.reply(messages.addAdPrompt());
};

const handleAdView = async (ctx, adId) => {
  const userId = String(ctx.from.id);
  const ad = adQueries.getById(adId, userId);
  if (!ad) return ctx.answerCbQuery('الإعلان غير موجود');

  let text = `*تفاصيل الإعلان:*\n\n` +
             `النوع: ${ad.type}\n` +
             `المحتوى: ${ad.text_content || 'لا يوجد'}\n` +
             `التاريخ: ${ad.created_at}`;

  await safeEdit(ctx, text, keyboards.adViewKeyboard(adId));
};

const handleDashboard = async (ctx) => {
  const userId = String(ctx.from.id);
  // Aggregate stats from logs and tasks
  const stats = {
    success: 0,
    failed: 0,
    running: 0
  };
  
  // Real implementation would query DB for these counts
  await safeEdit(ctx, messages.dashboard(stats), keyboards.dashboardKeyboard());
};

const handlePublishLogs = async (ctx) => {
  const userId = String(ctx.from.id);
  const logs = logQueries.getRecent(userId, 10);
  
  let text = `📜 *سجل العمليات الأخير:*\n\n`;
  if (logs.length === 0) {
    text += `لا توجد عمليات مسجلة حالياً.`;
  } else {
    logs.forEach(log => {
      const icon = log.result === 'success' ? '✅' : '❌';
      text += `${icon} [${log.created_at}] ${log.target_id}\n`;
    });
  }

  await safeEdit(ctx, text, {
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ رجوع', callback_data: 'publish_menu' }]]
    }
  });
};

const handlePublishTextInput = async (ctx) => {
  const userId = String(ctx.from.id);
  const state = publishWizardState.getWizardState(userId);
  if (!state) return;

  const text = ctx.message.text;

  if (state.step === WIZARD_STEPS.AWAITING_AD_CONTENT) {
    let type = 'text';
    let mediaFile = null;
    
    if (ctx.message.photo) {
      type = 'image';
      mediaFile = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (ctx.message.document) {
      type = 'file';
      mediaFile = ctx.message.document.file_id;
    }

    adQueries.create(userId, type, text || ctx.message.caption, mediaFile);
    publishWizardState.resetWizard(userId);
    await ctx.reply(messages.adSaved());
    return handleAdsLibrary(ctx);
  }

  // Handle other steps...
};

module.exports = {
  handlePublishMenu,
  handleAdsLibrary,
  handleAdAddStart,
  handleAdView,
  handleDashboard,
  handlePublishLogs,
  handlePublishTextInput
};
