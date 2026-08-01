const { botUserQueries } = require('../database/db');
const sessionState = require('../services/sessionState');
const { mainMenuKeyboard, backToMenuKeyboard } = require('../utils/keyboards');
const { welcomeMessage, helpMessage } = require('../utils/messages');
const logger = require('../utils/logger');
const { Markup } = require('telegraf');

/**
 * /start command handler
 */
const handleStart = async (ctx) => {
  logger.info(`handleStart triggered for user ${ctx.from.id}`);
  try {
    const { id, username, first_name } = ctx.from;

    // Register/update user in DB
    botUserQueries.upsert(id, username, first_name);

    // Reset any pending state
    sessionState.resetState(String(id));

    await ctx.reply(welcomeMessage(first_name), {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard(),
    }).catch(async (err) => {
      logger.error('handleStart reply error (Markdown):', err);
      // Fallback to plain text if Markdown fails
      await ctx.reply(`مرحبًا ${first_name || ''} 👋\n\nأنا بوت إدارة حسابات تيليجرام. اختر أحد الخيارات أدناه:`, mainMenuKeyboard());
    });
  } catch (error) {
    logger.error('handleStart fatal error:', error);
    await ctx.reply('مرحبًا! اضغط /start لبدء البوت.', mainMenuKeyboard());
  }
};

/**
 * Main menu callback handler
 */
const handleMainMenu = async (ctx) => {
  try {
    const { first_name } = ctx.from;
    await ctx.editMessageText(welcomeMessage(first_name), {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard(),
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error('handleMainMenu error:', error);
    await ctx.reply(welcomeMessage(ctx.from.first_name), {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard(),
    });
  }
};

/**
 * Help callback handler
 */
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
