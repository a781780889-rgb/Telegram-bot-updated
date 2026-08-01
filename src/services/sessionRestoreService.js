/**
 * Session Restore Service
 *
 * Runs automatically on every bot startup to:
 *  1. Query all accounts that have a saved encrypted_session in the DB.
 *  2. Recreate missing session files from the DB backup when needed
 *     (handles container restarts, fresh deployments, volume remounts).
 *  3. Attempt to reconnect each account to Telegram and verify it is
 *     still authorised.
 *  4. Update account statuses in the database accordingly.
 *  5. Send a detailed startup report to every known bot user so they
 *     can see which accounts were restored and which need attention.
 *
 * Design principles:
 *  - Never throws — all errors are caught, logged, and reflected in the
 *    report, so a single bad account cannot block the rest.
 *  - Accounts are processed in small parallel batches (CONCURRENCY_LIMIT)
 *    to avoid Telegram flood-wait errors when there are many accounts.
 *  - Bot startup is NOT blocked: the restore runs in a deferred task
 *    (setImmediate) after bot.launch() returns.
 */

const logger = require('../utils/logger');
const {
  accountQueries,
  getAllAccountsWithSession,
  getBotUserIds,
} = require('../database/db');
const {
  loadSession,
  registerActiveClient,
  restoreSessionFile,
} = require('./telegramClient');

// Maximum number of accounts to reconnect simultaneously.
const CONCURRENCY_LIMIT = 3;

// Delay between concurrency batches (ms) — reduces flood-wait risk.
const BATCH_DELAY_MS = 1500;

// ─── Core restore logic ───────────────────────────────────────────────────────

/**
 * Attempt to restore a single account:
 *  - Ensure the session file exists (recreate from DB if missing).
 *  - Connect and verify authorisation.
 *  - Update DB status.
 *
 * @param {object} account  Full row from the accounts table.
 * @returns {Promise<{ success: boolean, account: object, error?: string }>}
 */
const restoreAccount = async (account) => {
  // Step 1: ensure the session file is on disk.
  const sessionFilePath = restoreSessionFile(account);

  if (!sessionFilePath) {
    const msg = 'لا يوجد ملف جلسة محفوظ';
    accountQueries.updateStatus(account.id, 'disconnected', {
      error_message: msg,
    });
    return { success: false, account, error: msg };
  }

  // Step 2: connect and verify.
  // longLived:true → buildClient(sessionString, forSearch=false)
  // → connectionRetries:5, autoReconnect:true, TCP transport.
  // Restored accounts need stable long-lived connections; without this they
  // get autoReconnect:false and the update-loop hammers TIMEOUT endlessly.
  const client = await loadSession(sessionFilePath, { longLived: true });

  // Step 3: register in the active-clients map.
  registerActiveClient(account.id, client, account.phone);

  // Step 4: persist the canonical session-file path and mark as connected.
  accountQueries.updateStatus(account.id, 'connected', {
    error_message:    null,
    session_file:     sessionFilePath,
    last_restored_at: new Date().toISOString(),
  });

  return { success: true, account };
};

// ─── Batch runner ─────────────────────────────────────────────────────────────

/**
 * Process accounts in parallel batches to respect Telegram rate limits.
 *
 * @param {object[]} accounts
 * @returns {Promise<{
 *   restored: object[],
 *   failed:   Array<{ account: object, error: string }>,
 *   skipped:  object[]
 * }>}
 */
const processBatches = async (accounts) => {
  const restored = [];
  const failed   = [];
  const skipped  = [];

  for (let i = 0; i < accounts.length; i += CONCURRENCY_LIMIT) {
    const batch    = accounts.slice(i, i + CONCURRENCY_LIMIT);
    const outcomes = await Promise.allSettled(batch.map(restoreAccount));

    for (let j = 0; j < batch.length; j++) {
      const outcome = outcomes[j];
      const account = batch[j];

      if (outcome.status === 'fulfilled') {
        const { success, error } = outcome.value;
        if (success) {
          restored.push(account);
          logger.info(
            `Session Restore ✅ account ${account.id} (${account.phone}) restored.`
          );
        } else {
          skipped.push(account);
          logger.warn(
            `Session Restore ⏭ account ${account.id} (${account.phone}) skipped: ${error}`
          );
        }
      } else {
        const errorMsg = outcome.reason?.message ?? String(outcome.reason);
        failed.push({ account, error: errorMsg });
        accountQueries.updateStatus(account.id, 'disconnected', {
          error_message: errorMsg,
        });
        logger.warn(
          `Session Restore ❌ account ${account.id} (${account.phone}) failed: ${errorMsg}`
        );
      }
    }

    // Delay between batches (not after the last one).
    if (i + CONCURRENCY_LIMIT < accounts.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return { restored, failed, skipped };
};

// ─── User notification ────────────────────────────────────────────────────────

/**
 * Build the startup report message text.
 *
 * @param {{ restored: object[], failed: Array<{account,error}>, skipped: object[] }} results
 * @param {number} total
 * @returns {string}
 */
const buildReportMessage = (results, total) => {
  const { restored, failed, skipped } = results;

  const lines = [
    `🔄 *تم تشغيل البوت — استعادة الحسابات*`,
    `${'─'.repeat(32)}`,
    ``,
    `📦 *إجمالي الحسابات المحفوظة:* ${total}`,
    `✅ *تمت استعادتها بنجاح:*      ${restored.length}`,
    `❌ *فشلت الاستعادة:*           ${failed.length}`,
    `⏭️ *بدون جلسة صالحة:*         ${skipped.length}`,
  ];

  // List restored accounts (cap at 15 to avoid message-too-long errors).
  if (restored.length > 0) {
    lines.push(``, `✅ *الحسابات المتصلة:*`);
    const displayList = restored.slice(0, 15);
    for (const acc of displayList) {
      const name =
        [acc.first_name, acc.last_name].filter(Boolean).join(' ') || acc.phone;
      lines.push(`  • ${name}`);
    }
    if (restored.length > 15) {
      lines.push(`  … و${restored.length - 15} آخرين`);
    }
  }

  // List accounts that need re-login (cap at 10).
  if (failed.length > 0) {
    lines.push(``, `⚠️ *تحتاج إعادة تسجيل دخول:*`);
    const displayList = failed.slice(0, 10);
    for (const { account } of displayList) {
      const name =
        [account.first_name, account.last_name].filter(Boolean).join(' ') ||
        account.phone;
      lines.push(`  • ${name}`);
    }
    if (failed.length > 10) {
      lines.push(`  … و${failed.length - 10} آخرين`);
    }
  }

  // Final status line.
  lines.push(``);
  if (total === 0) {
    lines.push(`ℹ️ لا توجد حسابات محفوظة بعد.`);
  } else if (restored.length === total) {
    lines.push(`🎉 *جميع الحسابات تعمل بشكل طبيعي.*`);
  } else if (restored.length === 0) {
    lines.push(
      `⚠️ *لم يتم استعادة أي حساب.*\n` +
      `استخدم "إعادة تسجيل الدخول" من قائمة الحسابات.`
    );
  } else {
    lines.push(
      `⚠️ *بعض الحسابات تحتاج إعادة تسجيل دخول.*`
    );
  }

  return lines.join('\n');
};

/**
 * Send the startup report to all known bot users.
 *
 * @param {import('telegraf').Telegraf} bot
 * @param {{ restored: object[], failed: object[], skipped: object[] }} results
 * @param {number} total
 */
const notifyAllUsers = async (bot, results, total) => {
  let userIds;
  try {
    userIds = getBotUserIds();
  } catch (error) {
    logger.error('Session Restore: failed to load bot user IDs:', error);
    return;
  }

  if (!userIds.length) {
    logger.info('Session Restore: no known bot users to notify.');
    return;
  }

  const message = buildReportMessage(results, total);

  for (const userId of userIds) {
    try {
      await bot.telegram.sendMessage(userId, message, {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      // User may have blocked the bot — log and continue.
      logger.warn(
        `Session Restore: could not notify user ${userId}: ${error.message}`
      );
    }
  }
};

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Restore all saved accounts on bot startup.
 *
 * This is the sole public export.  Call it once, right after bot.launch(),
 * inside a setImmediate/setTimeout so it does not delay the bot's readiness.
 *
 * @param {import('telegraf').Telegraf} bot
 */
const restoreAllAccounts = async (bot) => {
  logger.info('=== Session Restore: starting startup restoration ===');

  // 1. Load candidate accounts from DB.
  let accounts;
  try {
    accounts = getAllAccountsWithSession();
  } catch (error) {
    logger.error('Session Restore: failed to query accounts:', error);
    return;
  }

  const total = accounts.length;

  if (total === 0) {
    logger.info('Session Restore: no saved accounts found — skipping.');
    // Still notify users so they know the bot restarted cleanly.
    await notifyAllUsers(bot, { restored: [], failed: [], skipped: [] }, 0);
    return;
  }

  logger.info(`Session Restore: found ${total} account(s) to restore.`);

  // 2. Process accounts in batches.
  const results = await processBatches(accounts);

  // 3. Log summary.
  logger.info(
    `Session Restore: complete — ` +
    `✅ ${results.restored.length} restored, ` +
    `❌ ${results.failed.length} failed, ` +
    `⏭️ ${results.skipped.length} skipped.`
  );

  // 4. Notify all known bot users.
  await notifyAllUsers(bot, results, total);
};

module.exports = { restoreAllAccounts };
