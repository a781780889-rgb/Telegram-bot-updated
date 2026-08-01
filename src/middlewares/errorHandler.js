const logger = require('../utils/logger');
const { mainMenuKeyboard } = require('../utils/keyboards');

/**
 * Global error handler for the Telegraf bot
 * Catches unhandled errors from handlers and middlewares
 */
const errorHandler = (err, ctx) => {
  logger.error('Unhandled bot error:', {
    error: err.message,
    stack: err.stack,
    updateType: ctx?.updateType,
    userId: ctx?.from?.id,
  });

  const errorMessage = '⚠️ حدث خطأ غير متوقع. الرجاء المحاولة لاحقًا.';

  try {
    if (ctx?.callbackQuery) {
      ctx.answerCbQuery('حدث خطأ').catch(() => {});
      ctx
        .reply(errorMessage, mainMenuKeyboard())
        .catch(() => {});
    } else if (ctx?.message) {
      ctx.reply(errorMessage, mainMenuKeyboard()).catch(() => {});
    }
  } catch (_) {
    // Suppress secondary errors in error handler
  }
};

module.exports = errorHandler;
