const { botUserQueries } = require('../database/db');
const sessionState = require('../services/sessionState');
const { mainMenuKeyboard, backToMenuKeyboard } = require('../utils/keyboards');
const { welcomeMessage, helpMessage } = require('../utils/messages');
const logger = require('../utils/logger');
const { Markup } = require('telegraf');

const handleStart = async (ctx) => {
  logger.info(`handleStart triggered for user ${ctx.from.id}`);
  try {
    const { id, username, first_name } = ctx.from;
    botUserQueries.upsert(id, username, first_name);
    sessionState.resetState(String(id));
    await ctx.reply(welcomeMessage(first_name), {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard(id),
    }).catch(async (err) => {
      logger.error('handleStart reply error (Markdown):', err);
      await ctx.reply(`مرحبًا ${first_name || ''} 👋\n\nأنا بوت إدارة حسابات تيليجرام. اختر أحد الخيارات أدناه:`, mainMenuKeyboard(id));
    });
  } catch (error) {
    logger.error('handleStart fatal error:', error);
    await ctx.reply('مرحبًا! اضغط /start لبدء البوت.', mainMenuKeyboard(ctx.from?.id));
  }
};

const handleMainMenu = async (ctx) => {
  try {
    const { id, first_name } = ctx.from;
    await ctx.editMessageText(welcomeMessage(first_name), {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard(id),
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error('handleMainMenu error:', error);
    await ctx.reply(welcomeMessage(ctx.from.first_name), {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard(ctx.from?.id),
    });
  }
};

const handleHelp = async (ctx) => {
  try {
    await ctx.editMessageText(helpMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 القائمة الرئيسية', 'main_menu')],
      ]),
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error('handleHelp error:', error);
    await ctx.reply(helpMessage, {
      parse_mode: 'Markdown',
      ...backToMenuKeyboard(),
    });
  }
};

module.exports = { handleStart, handleMainMenu, handleHelp };
