/**
 * Publishing Engine Service
 * 
 * Handles:
 * - Sending ads to Telegram groups
 * - Managing background publishing tasks
 * - Task scheduling and rotation
 */

const { Api } = require('telegram');
const logger = require('../utils/logger');
const { accountQueries } = require('../database/db');
const { adQueries, taskQueries, logQueries } = require('../database/publishDb');
const { loadSession, restoreSessionFile, translateTelegramError } = require('./telegramClient');

/**
 * Get a Telegram client for an account
 */
const getClientForAccount = async (account) => {
  const sessionFile = restoreSessionFile(account) || account.session_file;
  if (!sessionFile) throw new Error('NO_SESSION_FILE');
  return loadSession(sessionFile);
};

/**
 * Send an ad to a target
 */
const sendAd = async (client, target, ad) => {
  try {
    let entity;
    if (target.startsWith('https://t.me/')) {
      const username = target.split('/').pop();
      entity = await client.getEntity(username);
    } else {
      entity = await client.getEntity(target);
    }

    if (ad.type === 'text') {
      await client.sendMessage(entity, { message: ad.text_content });
    } else if (ad.type === 'image' || ad.type === 'text_image') {
      // For simplicity in this environment, we assume media_file is a file path or ID
      // Real implementation would handle buffers/streams
      await client.sendFile(entity, {
        file: ad.media_file,
        caption: ad.text_content
      });
    } else if (ad.type === 'link') {
      await client.sendMessage(entity, { message: ad.text_content });
    } else if (ad.type === 'file') {
      await client.sendFile(entity, {
        file: ad.media_file,
        caption: ad.text_content
      });
    }
    return { success: true };
  } catch (error) {
    logger.error(`Failed to send ad to ${target}:`, error);
    return { success: false, error: translateTelegramError(error) };
  }
};

/**
 * Execute a single step of a publishing task
 */
const executeTaskStep = async (task) => {
  const accountIds = JSON.parse(task.account_ids);
  const targetIds = JSON.parse(task.target_ids || '[]');
  const adIds = JSON.parse(task.ad_ids);

  // Logic for rotation and selection
  // This is a simplified version
  const accountId = accountIds[Math.floor(Math.random() * accountIds.length)];
  const adId = adIds[Math.floor(Math.random() * adIds.length)];
  const target = targetIds[Math.floor(Math.random() * targetIds.length)];

  if (!target) return;

  const account = accountQueries.getById(accountId);
  const ad = adQueries.getById(adId, task.user_id);

  if (!account || account.status !== 'connected' || !ad) {
    logQueries.add(task.user_id, task.id, accountId, target, adId, 'failed', 'Account or Ad not ready');
    return;
  }

  let client;
  try {
    client = await getClientForAccount(account);
    const result = await sendAd(client, target, ad);
    
    if (result.success) {
      logQueries.add(task.user_id, task.id, accountId, target, adId, 'success', 'Published successfully');
      accountQueries.updateStatus(accountId, 'connected', { 
        last_publish_at: new Date().toISOString(),
        publish_count: (account.publish_count || 0) + 1
      });
    } else {
      logQueries.add(task.user_id, task.id, accountId, target, adId, 'failed', result.error);
    }
  } catch (error) {
    logQueries.add(task.user_id, task.id, accountId, target, adId, 'failed', error.message);
  } finally {
    if (client) await client.disconnect().catch(() => {});
  }
};

/**
 * Background scheduler for publishing tasks
 */
let schedulerInterval = null;

const startPublishScheduler = () => {
  if (schedulerInterval) return;

  logger.info('Starting Publish Engine Scheduler...');
  schedulerInterval = setInterval(async () => {
    const activeTasks = taskQueries.getActive();
    for (const task of activeTasks) {
      // Check if it's time to run
      const now = new Date();
      if (task.next_run_at && new Date(task.next_run_at) > now) continue;

      // Check days of week
      if (task.days_of_week) {
        const days = JSON.parse(task.days_of_week);
        if (!days.includes(now.getDay())) continue;
      }

      // Check hours
      if (task.start_time && task.end_time) {
        const [startH, startM] = task.start_time.split(':').map(Number);
        const [endH, endM] = task.end_time.split(':').map(Number);
        const currentH = now.getHours();
        const currentM = now.getMinutes();
        
        const currentTotal = currentH * 60 + currentM;
        const startTotal = startH * 60 + startM;
        const endTotal = endH * 60 + endM;

        if (currentTotal < startTotal || currentTotal > endTotal) continue;
      }

      // Execute step
      await executeTaskStep(task);

      // Update next run time
      const nextRun = new Date(now.getTime() + (task.interval_seconds || 60) * 1000);
      taskQueries.update(task.id, task.user_id, { 
        last_run_at: now.toISOString(),
        next_run_at: nextRun.toISOString()
      });
    }
  }, 10000); // Check every 10 seconds
};

module.exports = {
  sendAd,
  executeTaskStep,
  startPublishScheduler
};
