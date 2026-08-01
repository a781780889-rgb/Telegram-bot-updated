const sessionState = require('../services/sessionState');
const { STATES } = require('../services/sessionState');
const telegramClient = require('../services/telegramClient');
const linksWizardState = require('../services/linksWizardState');
const joinWizardState = require('../services/joinWizardState');
const foldersWizardState = require('../services/foldersWizardState');
const publishWizardState = require('../services/publishWizardState');
const {
  handlePhoneInput,
  handleOtpInput,
  handlePasswordInput,
} = require('../handlers/addAccount');
const { handleLinksTextInput } = require('../handlers/linksMenu');
const { handleJoinTextInput } = require('../handlers/joinMenu');
const { handleFoldersTextInput } = require('../handlers/foldersMenu');
const { handlePublishTextInput } = require('../handlers/publishMenu');
const { mainMenuKeyboard } = require('../utils/keyboards');
const logger = require('../utils/logger');

/**
 * Route incoming text messages to the appropriate handler
 * based on the user's current conversation state.
 */
const textRouter = async (ctx, next) => {
  // Only handle private text messages
  if (!ctx.message?.text || ctx.chat?.type !== 'private') {
    return next();
  }

  // Ignore commands
  if (ctx.message.text.startsWith('/')) {
    return next();
  }

  const userId = String(ctx.from.id);
  const stateResult = sessionState.getState(userId);
  const { state, timedOut, phone: timedOutPhone } = stateResult;

  if (timedOut) {
    // TIMEOUT CLEANUP FIX: close the dangling MTProto socket that was left
    // open in pendingSessions when the user's 10-minute window expired.
    if (timedOutPhone) {
      telegramClient.cleanupPending(userId, timedOutPhone).catch((err) => {
        logger.warn(`textRouter: timeout cleanup error for user=${userId}: ${err.message}`);
      });
    }
    await ctx.reply(
      '⏱ انتهت مهلة الجلسة. ابدأ من جديد.',
      mainMenuKeyboard()
    );
    return;
  }

  // ─── Links wizard takes priority when user is in a text-input step ──────────
  if (linksWizardState.isAwaitingTextInput(userId)) {
    await handleLinksTextInput(ctx);
    return;
  }

  // ─── Join-to-links wizard takes priority when user is in a text-input step ──
  if (joinWizardState.isAwaitingTextInput(userId)) {
    await handleJoinTextInput(ctx);
    return;
  }

  // ─── Folders wizard takes priority when user is in a text-input step ───────
  if (foldersWizardState.isAwaitingTextInput(userId)) {
    await handleFoldersTextInput(ctx);
    return;
  }

  // ─── Publish engine wizard takes priority when user is in a text-input step ──
  if (publishWizardState.isAwaitingTextInput(userId)) {
    await handlePublishTextInput(ctx);
    return;
  }

  switch (state) {
    case STATES.AWAITING_PHONE:
      await handlePhoneInput(ctx);
      break;

    case STATES.AWAITING_OTP:
      await handleOtpInput(ctx);
      break;

    case STATES.AWAITING_PASSWORD:
      await handlePasswordInput(ctx);
      break;

    case STATES.IDLE:
    default:
      // Unexpected text while idle
      await ctx.reply(
        'استخدم القائمة للتنقل بين الخيارات.',
        mainMenuKeyboard()
      );
      break;
  }
};

module.exports = textRouter;
