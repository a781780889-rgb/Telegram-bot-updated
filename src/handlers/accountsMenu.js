const logger = require('../utils/logger');
const { accountsMenuKeyboard, backToMenuKeyboard } = require('../utils/keyboards');
const { accountsMenuMessage } = require('../utils/messages');

/**
 * Handle "accounts_menu" callback — shows the accounts management sub-menu
 */
const handleAccountsMenu = async (ctx) => {
  try {
    const text = accountsMenuMessage;
    const keyboard = accountsMenuKeyboard();

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...keyboard,
      });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery();
    }
  } catch (error) {
    logger.error('handleAccountsMenu error:', error);
    try {
      await ctx.reply('📂 إدارة الحسابات:', backToMenuKeyboard());
    } catch (_) {}
  }
};

module.exports = { handleAccountsMenu };
