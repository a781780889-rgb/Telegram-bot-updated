require('dotenv').config();

const { Telegraf } = require('telegraf');
const logger = require('./utils/logger');
const errorHandler = require('./middlewares/errorHandler');
const textRouter = require('./middlewares/textRouter');

const { handleStart, handleMainMenu, handleHelp } = require('./handlers/menu');
const { handleAccountsMenu } = require('./handlers/accountsMenu');
const {
  handleAddAccountStart,
  handleCancelFlow,
  handleResendOtp,
} = require('./handlers/addAccount');
const {
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
} = require('./handlers/manageAccounts');

const {
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
  // Other
  handleLinksStatistics,
  handleLinksSettings,
  handleLinksToggleSetting,
  handleLinksHistory,
  handleLinksCleanFiles,
  handleLinksConfirmClean,
} = require('./handlers/linksMenu');

const {
  handleJoinMenu,
  handleJoinAccountsMenu,
  handleJoinAccountDetail,
  handleJoinAccountEnable,
  handleJoinAccountDisable,
  handleJoinAccountResetBan,
  handleJoinAccountsEnableAll,
  handleJoinAccountsDisableAll,
  handleJoinLinksOverview,
  handleJoinLinksFilter,
  handleJoinAddLinks,
  handleJoinStart,
  handleJoinStartConfirm,
  handleJoinStop,
  handleJoinStatistics,
  handleJoinNeedsApproval,
  handleJoinApproveLink,
  handleJoinRejectLink,
  handleJoinCleanup,
  handleJoinCleanupConfirm,
  handleJoinBannedAccounts,
  handleJoinLogs,
  handleJoinLogsClearConfirm,
  handleJoinLogsClear,
  handleJoinSettings,
  handleJoinSettingsSection,
  handleJoinToggleSetting,
  handleJoinEditSetting,
  handleJoinLinksFileInput,
  isAwaitingLinksFile,
} = require('./handlers/joinMenu');

const {
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
} = require('./handlers/foldersMenu');

const {
  handlePublishMenu,
  handleAdsLibrary,
  handleAdAddStart,
  handleAdView,
  handleDashboard,
  handlePublishLogs,
} = require('./handlers/publishMenu');
const { startPublishScheduler } = require('./services/publishService');

const { restoreAllAccounts } = require('./services/sessionRestoreService');

// ─── Validate required environment variables ──────────────────────────────────

const requiredEnvVars = ['BOT_TOKEN', 'API_ID', 'API_HASH', 'ENCRYPTION_KEY'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);

if (missingVars.length > 0) {
  logger.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  logger.error('Please copy .env.example to .env and fill in all required values.');
  process.exit(1);
}

if (process.env.ENCRYPTION_KEY.length < 32) {
  logger.error('ENCRYPTION_KEY must be at least 32 characters long');
  process.exit(1);
}

// ─── Initialize Bot ───────────────────────────────────────────────────────────

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  const type = ctx.updateType;
  const text = ctx.message?.text || ctx.callbackQuery?.data || 'N/A';
  logger.info(`[UPDATE] type=${type} user=${userId} data=${text}`);
  return await next();
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

bot.catch(errorHandler);

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command('start', handleStart);
bot.command('debug', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.reply(`🔍 *معلومات التصحيح:*\n\n🆔 معرفك: \`${userId}\`\n⚙️ الحالة: متصل ويعمل`, { parse_mode: 'Markdown' });
});
bot.command('menu', async (ctx) => {
  await ctx.reply('القائمة الرئيسية:', require('./utils/keyboards').mainMenuKeyboard());
});

// ─── Navigation Callbacks ─────────────────────────────────────────────────────

bot.action('main_menu', handleMainMenu);
bot.action('help', handleHelp);
bot.action('accounts_menu', handleAccountsMenu);

// ─── Links Section Callbacks ──────────────────────────────────────────────────

bot.action('links_menu', handleLinksMenu);
bot.action('links_start_search', handleLinksStartSearch);

// Step 1 — account selection
bot.action('links_accounts_all', handleLinksAccountsAll);
bot.action('links_accounts_one', handleLinksAccountsOne);
bot.action('links_accounts_two', handleLinksAccountsTwo);
bot.action('links_accounts_multiple', handleLinksAccountsMultiple);
bot.action('links_confirm_accounts', handleLinksConfirmAccounts);

// Step 2 — link type
bot.action('links_type_both', handleLinksTypeBoth);
bot.action('links_type_telegram', handleLinksTypeTelegram);
bot.action('links_type_whatsapp', handleLinksTypeWhatsapp);

// Step 3a — Telegram sub-type (toggle + confirm)
bot.action(/^links_tgsub_(public_group|channel|private_group|all)$/, async (ctx) => {
  await handleLinksTgSubToggle(ctx, ctx.match[1]);
});
bot.action('links_tgsub_confirm', handleLinksTgSubConfirm);

// Step 3b — WhatsApp sub-type (toggle + confirm)
bot.action(/^links_wasub_(group|channel|all)$/, async (ctx) => {
  await handleLinksWaSubToggle(ctx, ctx.match[1]);
});
bot.action('links_wasub_confirm', handleLinksWaSubConfirm);

// Step 4 — period
bot.action('links_period_day', handleLinksPeriodDay);
bot.action('links_period_week', handleLinksPeriodWeek);
bot.action('links_period_month', handleLinksPeriodMonth);
bot.action('links_period_3months', handleLinksPeriod3Months);
bot.action('links_period_year', handleLinksPeriodYear);
bot.action('links_period_custom', handleLinksPeriodCustom);

// Step 5 — depth
bot.action('links_depth_fast', handleLinksDepthFast);
bot.action('links_depth_medium', handleLinksDepthMedium);
bot.action('links_depth_deep', handleLinksDepthDeep);

// Execute
bot.action('links_execute_search', handleLinksExecuteSearch);

// Search controls
bot.action('links_pause_search', handleLinksPauseSearch);
bot.action('links_resume_search', handleLinksResumeSearch);
bot.action('links_stop_search', handleLinksStopSearch);

// Back navigation
bot.action('links_back_to_step1', handleLinksBackToStep1);
bot.action('links_back_to_step2', handleLinksBackToStep2);
bot.action('links_back_to_step3a', handleLinksBackToStep3a);
bot.action('links_back_to_step3', handleLinksBackToStep3);
bot.action('links_back_to_step4', handleLinksBackToStep4);
bot.action('links_back_to_step5', handleLinksBackToStep5);

// Extracted files
bot.action('links_extracted_files', handleLinksExtractedFiles);
bot.action('links_clean_files', handleLinksCleanFiles);
bot.action('links_confirm_clean', handleLinksConfirmClean);

// Statistics & settings & history
bot.action('links_statistics', handleLinksStatistics);
bot.action('links_settings', handleLinksSettings);
bot.action('links_history', handleLinksHistory);

// Dynamic links callbacks
bot.action(/^links_toggle_account_(\d+)$/, async (ctx) => {
  const accountId = parseInt(ctx.match[1], 10);
  await handleLinksToggleAccount(ctx, accountId);
});

bot.action(/^links_view_op_(\d+)$/, async (ctx) => {
  await handleLinksViewOperation(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/^links_op_view_(\d+)$/, async (ctx) => {
  await handleLinksViewOperation(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/^links_op_download_(\d+)$/, async (ctx) => {
  await handleLinksDownloadOperation(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/^links_op_rename_(\d+)$/, async (ctx) => {
  await handleLinksRenameOperation(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/^links_op_delete_(\d+)$/, async (ctx) => {
  await handleLinksDeleteOperationPrompt(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/^links_op_confirm_delete_(\d+)$/, async (ctx) => {
  await handleLinksConfirmDeleteOperation(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/^links_op_export_(\d+)$/, async (ctx) => {
  await handleLinksExportOperation(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/^links_toggle_setting_(.+)$/, async (ctx) => {
  await handleLinksToggleSetting(ctx, ctx.match[1]);
});

// ─── Join-to-Links Callbacks ───────────────────────────────────────────────────

// Main navigation
bot.action('join_menu',         handleJoinMenu);
bot.action('join_add_links',    handleJoinAddLinks);
bot.action('join_start',        handleJoinStart);
bot.action('join_start_confirm', handleJoinStartConfirm);
bot.action('join_stop',         handleJoinStop);
bot.action('join_statistics',   handleJoinStatistics);
bot.action('join_needs_approval', handleJoinNeedsApproval);
bot.action('join_cleanup',      handleJoinCleanup);
bot.action('join_cleanup_confirm', handleJoinCleanupConfirm);
bot.action('join_banned_accounts', handleJoinBannedAccounts);
bot.action('join_settings',     handleJoinSettings);

// Accounts
bot.action('join_accounts_menu',       handleJoinAccountsMenu);
bot.action('join_accounts_enable_all', handleJoinAccountsEnableAll);
bot.action('join_accounts_disable_all', handleJoinAccountsDisableAll);
bot.action(/^join_account_detail_(\d+)$/, async (ctx) => {
  await handleJoinAccountDetail(ctx, parseInt(ctx.match[1], 10));
});
bot.action(/^join_account_enable_(\d+)$/, async (ctx) => {
  await handleJoinAccountEnable(ctx, parseInt(ctx.match[1], 10));
});
bot.action(/^join_account_disable_(\d+)$/, async (ctx) => {
  await handleJoinAccountDisable(ctx, parseInt(ctx.match[1], 10));
});
bot.action(/^join_account_reset_ban_(\d+)$/, async (ctx) => {
  await handleJoinAccountResetBan(ctx, parseInt(ctx.match[1], 10));
});

// Links overview & filters
bot.action('join_links_overview', handleJoinLinksOverview);
bot.action(/^join_links_filter_(.+)$/, async (ctx) => {
  await handleJoinLinksFilter(ctx, ctx.match[1]);
});

// Approval decisions
bot.action(/^join_approve_link_(\d+)$/, async (ctx) => {
  await handleJoinApproveLink(ctx, parseInt(ctx.match[1], 10));
});
bot.action(/^join_reject_link_(\d+)$/, async (ctx) => {
  await handleJoinRejectLink(ctx, parseInt(ctx.match[1], 10));
});

// Logs (paginated + clear)
bot.action('join_logs',              (ctx) => handleJoinLogs(ctx, 0));
bot.action(/^join_logs_page_(\d+)$/, async (ctx) => {
  await handleJoinLogs(ctx, parseInt(ctx.match[1], 10));
});
bot.action('join_logs_clear_confirm', handleJoinLogsClearConfirm);
bot.action('join_logs_clear',         handleJoinLogsClear);

// Settings sections
bot.action('join_settings_timing',     async (ctx) => handleJoinSettingsSection(ctx, 'timing'));
bot.action('join_settings_breaks',     async (ctx) => handleJoinSettingsSection(ctx, 'breaks'));
bot.action('join_settings_limits',     async (ctx) => handleJoinSettingsSection(ctx, 'limits'));
bot.action('join_settings_retry',      async (ctx) => handleJoinSettingsSection(ctx, 'retry'));
bot.action('join_settings_protection', async (ctx) => handleJoinSettingsSection(ctx, 'protection'));
bot.action('join_settings_summary',    async (ctx) => handleJoinSettingsSection(ctx, 'summary'));

// Settings edit & toggle (catch-all regex — must come after specific patterns above)
bot.action(/^join_edit_(.+)$/,   async (ctx) => handleJoinEditSetting(ctx, ctx.match[1]));
bot.action(/^join_toggle_(.+)$/, async (ctx) => handleJoinToggleSetting(ctx, ctx.match[1]));

// ─── Central Groups DB + Telegram Folders Callbacks ───────────────────────────

bot.action('folders_menu', handleFoldersMenu);
bot.action('folders_stats', handleFoldersStats);
bot.action('folders_organize', handleFoldersOrganize);
bot.action('folders_list', handleFoldersList);
bot.action('folders_settings', handleFoldersSettings);
bot.action('folders_edit_groups_per_folder', handleFoldersEditGroupsPerFolder);

// ─── Publish Engine Callbacks ────────────────────────────────────────────────
bot.action('publish_menu', handlePublishMenu);
bot.action('publish_ads_library', handleAdsLibrary);
bot.action('publish_ad_add', handleAdAddStart);
bot.action('publish_dashboard', handleDashboard);
bot.action('publish_dashboard_refresh', handleDashboard);
bot.action('publish_logs', handlePublishLogs);

bot.action(/^publish_ad_view_(\d+)$/, async (ctx) => {
  await handleAdView(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/^folder_detail_(\d+)$/, async (ctx) => {
  await handleFolderDetail(ctx, parseInt(ctx.match[1], 10));
});
bot.action(/^folder_push_(\d+)$/, async (ctx) => {
  await handleFolderPush(ctx, parseInt(ctx.match[1], 10));
});
bot.action(/^folder_delete_confirm_(\d+)$/, async (ctx) => {
  await handleFolderDeleteConfirm(ctx, parseInt(ctx.match[1], 10));
});
bot.action(/^folder_delete_yes_(\d+)$/, async (ctx) => {
  await handleFolderDeleteYes(ctx, parseInt(ctx.match[1], 10));
});

// ─── Add Account Callbacks ────────────────────────────────────────────────────

bot.action('add_account', handleAddAccountStart);
bot.action('cancel_flow', handleCancelFlow);
bot.action('resend_otp', handleResendOtp);

// ─── Account Management Callbacks ────────────────────────────────────────────

bot.action('list_accounts', handleListAccounts);
bot.action('edit_account_list', handleEditAccountList);
bot.action('delete_account_list', handleDeleteAccountList);
bot.action('refresh_all_status', handleRefreshAllStatus);
bot.action('accounts_stats', handleAccountsStats);

// ─── Dynamic Account Callbacks ────────────────────────────────────────────────

bot.action(/^account_detail_(\d+)$/, async (ctx) => {
  const accountId = parseInt(ctx.match[1], 10);
  await handleAccountDetail(ctx, accountId);
});

bot.action(/^edit_account_(\d+)$/, async (ctx) => {
  const accountId = parseInt(ctx.match[1], 10);
  await handleEditAccount(ctx, accountId);
});

bot.action(/^check_status_(\d+)$/, async (ctx) => {
  const accountId = parseInt(ctx.match[1], 10);
  await handleCheckStatus(ctx, accountId);
});

bot.action(/^delete_confirm_(\d+)$/, async (ctx) => {
  const accountId = parseInt(ctx.match[1], 10);
  await handleDeleteConfirm(ctx, accountId);
});

bot.action(/^delete_yes_(\d+)$/, async (ctx) => {
  const accountId = parseInt(ctx.match[1], 10);
  await handleDeleteAccount(ctx, accountId);
});

bot.action(/^relogin_(\d+)$/, async (ctx) => {
  const accountId = parseInt(ctx.match[1], 10);
  await handleRelogin(ctx, accountId);
});

// ─── Text Message Router ──────────────────────────────────────────────────────

bot.on('text', textRouter);

// ─── Document Upload Router (links file for join-to-links feature) ────────────

bot.on('document', async (ctx) => {
  if (ctx.chat?.type !== 'private') return;
  const uid = String(ctx.from.id);
  if (isAwaitingLinksFile(uid)) {
    await handleJoinLinksFileInput(ctx);
  }
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
    const { activeClients, disconnectClient } = require('./services/telegramClient');
    const clientIds = [...activeClients.keys()];
    await Promise.allSettled(clientIds.map((id) => disconnectClient(id)));
    logger.info(`Disconnected ${clientIds.length} active client(s)`);
  } catch (error) {
    logger.error('Error during shutdown:', error);
  }

  bot.stop(signal);
  logger.info('Bot stopped');
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start Bot ────────────────────────────────────────────────────────────────

const startBot = async () => {
  try {
    logger.info('Starting Telegram Account Manager Bot...');

    // ── معالجة خطأ 409 Conflict ──────────────────────────────────────────────
    // يحدث هذا الخطأ حين تُطلق Railway نسخة جديدة قبل أن تتوقف النسخة القديمة
    // تمامًا (Rolling Deploy). بدلاً من تعطيل البوت بالكامل، ننتظر ونعيد المحاولة.
    const MAX_LAUNCH_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
      try {
        await bot.launch({ dropPendingUpdates: true });
        break; // نجح الإطلاق — نخرج من الحلقة
      } catch (launchErr) {
        const is409 =
          String(launchErr?.message ?? launchErr).includes('409');
        if (is409 && attempt < MAX_LAUNCH_ATTEMPTS) {
          const waitSec = attempt * 5; // 5 s, 10 s, 15 s
          logger.warn(
            `409 Conflict (attempt ${attempt}/${MAX_LAUNCH_ATTEMPTS}). ` +
            `Waiting ${waitSec}s for the old instance to stop...`
          );
          await new Promise((r) => setTimeout(r, waitSec * 1000));
        } else {
          throw launchErr; // خطأ آخر أو استنفدنا المحاولات
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const botInfo = await bot.telegram.getMe();
    logger.info(`Bot started successfully: @${botInfo.username} (ID: ${botInfo.id})`);
    logger.info('Bot is ready to receive messages.');

    // Restore all saved accounts after the bot is fully online.
    // Running in setImmediate ensures the bot's polling loop has started
    // before we attempt to send notification messages to users.
    setImmediate(() => {
      restoreAllAccounts(bot).catch((err) => {
        logger.error('Session Restore: unexpected error during startup restoration:', err);
      });
    });

    // Start the publish engine's background scheduler.
    startPublishScheduler();
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
};

startBot();
