const { Markup } = require('telegraf');
const { botUserQueries } = require('../database/db');
const wizard = require('../services/userCodesWizardState');
const logger = require('../utils/logger');

const activationKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('🎟️ إدخال كود التفعيل', 'use_code')],
]);

const activationMessage = (reason) => {
  const suffix = reason === 'expired' ? '\n\n⏰ انتهت صلاحية تفعيل حسابك.' : '';
  return `🔐 *تفعيل الحساب*\n\nللوصول إلى البوت، يجب أولاً الحصول على كود تفعيل من الإدارة.${suffix}`;
};

const sendActivationScreen = async (ctx, reason) => {
  const extra = { parse_mode: 'Markdown', ...activationKeyboard() };
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('يجب تفعيل الحساب أولاً.', { show_alert: true }).catch(() => {});
      await ctx.editMessageText(activationMessage(reason), extra).catch(() => ctx.reply(activationMessage(reason), extra));
    } else {
      await ctx.reply(activationMessage(reason), extra);
    }
  } catch (error) {
    logger.warn(`Activation screen failed: ${error.message}`);
  }
};

const isAdmin = (ctx) => new Set(String(process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)).has(String(ctx.from?.id));
const isStartCommand = (ctx) => Boolean(ctx.message?.text && /^\/start(?:@\w+)?(?:\s|$)/i.test(ctx.message.text));
const isAllowedActivationCallback = (ctx) => ctx.callbackQuery?.data === 'use_code';

const activationGuard = async (ctx, next) => {
  if (!ctx.from?.id || ctx.chat?.type && ctx.chat.type !== 'private') return next();
  const status = botUserQueries.getActivationStatus(ctx.from.id);
  if (isAdmin(ctx) || status.activated || isStartCommand(ctx) || isAllowedActivationCallback(ctx)) return next();

  // The only non-callback message permitted before activation is the code
  // entered after the activation button has established the redeem state.
  const awaitingRedeem = ctx.message?.text && wizard.get(ctx.from.id)?.state === 'redeem';
  if (awaitingRedeem) return next();

  await sendActivationScreen(ctx, status.reason);
};

module.exports = { activationGuard, activationKeyboard, activationMessage, sendActivationScreen };
