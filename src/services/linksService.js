/**
 * Links Search Service
 * Core engine for scanning Telegram accounts and extracting links
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { accountQueries } = require('../database/db');
const { linksOperationQueries, linksFoundQueries, linksSettingsQueries } = require('../database/linksDb');

// ─── Link Patterns ────────────────────────────────────────────────────────────

const TELEGRAM_PATTERN = /(?:https?:\/\/)?(?:t(?:elegram)?\.me|telegram\.org)\/[^\s<>"']+/gi;
const WHATSAPP_PATTERN = /(?:https?:\/\/)?(?:wa\.me|chat\.whatsapp\.com|api\.whatsapp\.com\/send)\/[^\s<>"']*/gi;

/**
 * Extract links from text
 * @param {string} text
 * @param {'both'|'telegram'|'whatsapp'} linkType
 * @returns {Array<{url: string, type: 'telegram'|'whatsapp'}>}
 */
const extractLinks = (text, linkType = 'both') => {
  if (!text) return [];
  const found = [];

  if (linkType === 'both' || linkType === 'telegram') {
    const telegramMatches = text.match(TELEGRAM_PATTERN) || [];
    telegramMatches.forEach((url) => {
      const clean = url.replace(/[.,;!?)]+$/, '').trim();
      if (clean.length > 5) found.push({ url: clean, type: 'telegram' });
    });
  }

  if (linkType === 'both' || linkType === 'whatsapp') {
    const waMatches = text.match(WHATSAPP_PATTERN) || [];
    waMatches.forEach((url) => {
      const clean = url.replace(/[.,;!?)]+$/, '').trim();
      if (clean.length > 5) found.push({ url: clean, type: 'whatsapp' });
    });
  }

  return found;
};

/**
 * Compute SHA-256 hash of a URL for deduplication
 * @param {string} url
 * @returns {string}
 */
const hashUrl = (url) => crypto.createHash('sha256').update(url.toLowerCase().trim()).digest('hex');

// ─── Period → Date ────────────────────────────────────────────────────────────

/**
 * @param {string} period
 * @param {string|null} customStart
 * @param {string|null} customEnd
 * @returns {{ fromDate: Date, toDate: Date }}
 */
const resolvePeriod = (period, customStart, customEnd) => {
  const toDate = new Date();
  let fromDate;

  switch (period) {
    case 'week':
      fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '3months':
      fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      break;
    case 'year':
      fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      break;
    case 'custom':
      fromDate = customStart ? new Date(customStart) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      return { fromDate, toDate: customEnd ? new Date(customEnd) : toDate };
    default:
      fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }

  return { fromDate, toDate };
};

// ─── Search Depth → Message Limit ────────────────────────────────────────────

const depthToLimit = (depth) => {
  const map = { fast: 100, medium: 500, deep: 0 }; // 0 = unlimited
  return map[depth] ?? 500;
};

// ─── Active Search State ──────────────────────────────────────────────────────

// userId -> { operationId, paused, stopped, progress }
const activeSearches = new Map();

/**
 * Mark search as paused
 * @param {string} userId
 */
const pauseSearch = (userId) => {
  const state = activeSearches.get(userId);
  if (state) state.paused = true;
};

/**
 * Mark search as resumed
 * @param {string} userId
 */
const resumeSearch = (userId) => {
  const state = activeSearches.get(userId);
  if (state) state.paused = false;
};

/**
 * Stop search gracefully
 * @param {string} userId
 */
const stopSearch = (userId) => {
  const state = activeSearches.get(userId);
  if (state) state.stopped = true;
};

/**
 * Get current progress snapshot
 * @param {string} userId
 */
const getProgress = (userId) => {
  return activeSearches.get(userId)?.progress || null;
};

/**
 * Check if user has active search
 * @param {string} userId
 */
const hasActiveSearch = (userId) => activeSearches.has(userId);

// ─── Core Search Engine ───────────────────────────────────────────────────────

/**
 * Run the link search for a given operation
 * @param {string} userId
 * @param {number} operationId
 * @param {object} wizard - wizard config
 * @param {Function} onProgress - callback(progress) called periodically
 */
const runSearch = async (userId, operationId, wizard, onProgress) => {
  const startTime = Date.now();

  const progress = {
    currentAccount: '',
    doneAccounts: 0,
    remainingAccounts: 0,
    scannedMessages: 0,
    scannedChats: 0,
    totalLinks: 0,
    telegramLinks: 0,
    whatsappLinks: 0,
    duplicatesRemoved: 0,
    newLinks: 0,
    savedLinks: 0,
    speed: 0,
    elapsedSeconds: 0,
    etaSeconds: null,
    percent: 0,
    lastAction: '',
    lastLink: '',
    isPaused: false,
  };

  const state = { operationId, paused: false, stopped: false, progress };
  activeSearches.set(userId, state);

  try {
    const settings = linksSettingsQueries.get(userId);
    const { fromDate, toDate } = resolvePeriod(wizard.period, wizard.customStart, wizard.customEnd);
    const msgLimit = depthToLimit(wizard.searchDepth);

    // Resolve accounts to search
    let accounts = [];
    if (wizard.accountMode === 'all') {
      accounts = accountQueries.getAllByUserId(userId).filter((a) => a.status === 'connected');
    } else {
      const ids = wizard.selectedAccountIds || [];
      accounts = ids
        .map((id) => accountQueries.getById(id))
        .filter((a) => a && a.user_id === userId && a.status === 'connected');
    }

    progress.remainingAccounts = accounts.length;

    const outputDir = path.join(
      settings.output_dir,
      userId,
      `op_${operationId}_${Date.now()}`
    );
    fs.mkdirSync(outputDir, { recursive: true });

    const collectedTelegram = new Set();
    const collectedWhatsapp = new Set();

    // ── Iterate accounts ──────────────────────────────────────────────────────
    for (let ai = 0; ai < accounts.length; ai++) {
      if (state.stopped) break;

      const account = accounts[ai];
      progress.currentAccount =
        [account.first_name, account.last_name].filter(Boolean).join(' ') || account.phone;
      progress.remainingAccounts = accounts.length - ai;
      progress.lastAction = `جارٍ تحميل حساب ${progress.currentAccount}`;
      progress.percent = Math.round((ai / accounts.length) * 80);
      _updateElapsed(progress, startTime);
      await onProgress({ ...progress });

      let client = null;
      try {
        const { loadSession } = require('./telegramClient');
        if (!account.session_file) {
          progress.lastAction = `⚠️ لا توجد جلسة محفوظة لـ ${progress.currentAccount}`;
          await onProgress({ ...progress });
          continue;
        }
        client = await loadSession(account.session_file);
      } catch (sessionErr) {
        logger.warn(`Cannot load session for account ${account.id}:`, sessionErr.message);
        progress.lastAction = `⚠️ فشل تحميل جلسة ${progress.currentAccount}`;
        await onProgress({ ...progress });
        continue;
      }

      try {
        // Get all dialogs
        const dialogs = await client.getDialogs({ limit: 500 });
        const totalDialogs = dialogs.length;

        for (let di = 0; di < dialogs.length; di++) {
          if (state.stopped) break;

          // Pause support
          while (state.paused && !state.stopped) {
            progress.isPaused = true;
            await _sleep(500);
          }
          progress.isPaused = false;

          const dialog = dialogs[di];
          progress.scannedChats++;
          progress.lastAction = `فحص محادثة: ${(dialog.name || 'محادثة').slice(0, 30)}`;

          // Sub-progress within account
          const accountPct = ((di / totalDialogs) * 80) / accounts.length;
          progress.percent = Math.round((ai / accounts.length) * 80 + accountPct);
          _updateElapsed(progress, startTime);

          if (di % 10 === 0) {
            await onProgress({ ...progress });
          }

          try {
            const iterParams = { limit: msgLimit || undefined };
            const messages = await client.getMessages(dialog.entity, iterParams);

            const chatSeenHashes = new Set();

            for (const msg of messages) {
              if (state.stopped) break;

              const msgDate = new Date(msg.date * 1000);
              if (msgDate < fromDate || msgDate > toDate) continue;

              const text = msg.message || '';
              progress.scannedMessages++;

              const links = extractLinks(text, wizard.linkType);

              for (const { url, type } of links) {
                const hash = hashUrl(url);

                // Check dedup: within chat
                if (chatSeenHashes.has(hash)) {
                  progress.duplicatesRemoved++;
                  continue;
                }

                // Check dedup: across all sessions for this user
                if (settings.remove_duplicates) {
                  if (linksFoundQueries.existsForUser(userId, hash)) {
                    progress.duplicatesRemoved++;
                    chatSeenHashes.add(hash);
                    continue;
                  }
                }

                chatSeenHashes.add(hash);

                // Save to DB
                linksFoundQueries.insert(
                  userId,
                  operationId,
                  url,
                  hash,
                  type,
                  account.id,
                  String(dialog.id),
                  String(msg.id)
                );

                progress.totalLinks++;
                progress.newLinks++;
                progress.savedLinks++;
                progress.lastLink = url;

                if (type === 'telegram') {
                  progress.telegramLinks++;
                  collectedTelegram.add(url);
                } else {
                  progress.whatsappLinks++;
                  collectedWhatsapp.add(url);
                }

                if (progress.scannedMessages % 50 === 0) {
                  await onProgress({ ...progress });
                }
              }
            }
          } catch (msgErr) {
            logger.warn(`Error reading dialog ${dialog.id}:`, msgErr.message);
          }
        }
      } catch (dialogErr) {
        logger.error(`Error getting dialogs for account ${account.id}:`, dialogErr.message);
      } finally {
        try {
          await client.disconnect();
        } catch (_) {}
      }

      progress.doneAccounts++;
      progress.remainingAccounts = accounts.length - ai - 1;
    }

    // ── Write output files ────────────────────────────────────────────────────
    progress.lastAction = 'جارٍ حفظ الملفات...';
    progress.percent = 90;
    await onProgress({ ...progress });

    const allUrls = [...collectedTelegram, ...collectedWhatsapp];
    const telegramContent = [...collectedTelegram].join('\n');
    const whatsappContent = [...collectedWhatsapp].join('\n');
    const allContent = allUrls.join('\n');

    const reportContent = _buildReport(progress, wizard, accounts, startTime);
    const statsJson = JSON.stringify(
      {
        operationId,
        telegramLinks: progress.telegramLinks,
        whatsappLinks: progress.whatsappLinks,
        totalLinks: progress.totalLinks,
        duplicatesRemoved: progress.duplicatesRemoved,
        savedLinks: progress.savedLinks,
        scannedMessages: progress.scannedMessages,
        scannedChats: progress.scannedChats,
        durationSeconds: Math.round((Date.now() - startTime) / 1000),
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
      },
      null,
      2
    );

    fs.writeFileSync(path.join(outputDir, 'Telegram_Links.txt'), telegramContent, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'Whatsapp_Links.txt'), whatsappContent, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'All_Links.txt'), allContent, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'Search_Report.txt'), reportContent, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'Statistics.json'), statsJson, 'utf-8');

    // Calculate total file size
    const fileSize = _dirSize(outputDir);

    // Update operation in DB
    const finalStatus = state.stopped ? 'stopped' : 'completed';
    linksOperationQueries.updateProgress(operationId, {
      status: finalStatus,
      accounts_used: progress.doneAccounts,
      chats_scanned: progress.scannedChats,
      messages_scanned: progress.scannedMessages,
      telegram_links: progress.telegramLinks,
      whatsapp_links: progress.whatsappLinks,
      total_links: progress.totalLinks,
      duplicates_removed: progress.duplicatesRemoved,
      saved_links: progress.savedLinks,
      file_size_bytes: fileSize,
      output_dir: outputDir,
    });
    linksOperationQueries.finish(operationId, finalStatus);

    progress.percent = 100;
    _updateElapsed(progress, startTime);
    progress.etaSeconds = 0;
    await onProgress({ ...progress });

    return {
      operationId,
      accountsSearched: progress.doneAccounts,
      chatsScanned: progress.scannedChats,
      messagesScanned: progress.scannedMessages,
      telegramLinks: progress.telegramLinks,
      whatsappLinks: progress.whatsappLinks,
      totalLinks: progress.totalLinks,
      duplicatesRemoved: progress.duplicatesRemoved,
      savedLinks: progress.savedLinks,
      durationSeconds: Math.round((Date.now() - startTime) / 1000),
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      outputDir,
    };
  } catch (error) {
    logger.error('runSearch error:', error);
    linksOperationQueries.updateProgress(operationId, {
      status: 'error',
      error_message: error.message?.slice(0, 500),
    });
    linksOperationQueries.finish(operationId, 'error');
    throw error;
  } finally {
    activeSearches.delete(userId);
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const _updateElapsed = (progress, startTime) => {
  progress.elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
  if (progress.scannedMessages > 0 && progress.elapsedSeconds > 0) {
    progress.speed = Math.round(progress.scannedMessages / progress.elapsedSeconds);
  }
};

const _dirSize = (dir) => {
  try {
    return fs
      .readdirSync(dir)
      .reduce((sum, f) => sum + (fs.statSync(path.join(dir, f)).size || 0), 0);
  } catch (_) {
    return 0;
  }
};

const _buildReport = (progress, wizard, accounts, startTime) => {
  const now = new Date();
  const duration = Math.round((now - startTime) / 1000);
  const lines = [
    '══════════════════════════════════════',
    '         تقرير عملية البحث عن الروابط',
    '══════════════════════════════════════',
    `وقت البداية : ${new Date(startTime).toLocaleString('ar-SA')}`,
    `وقت الانتهاء: ${now.toLocaleString('ar-SA')}`,
    `مدة البحث   : ${duration} ثانية`,
    '',
    '── الإعدادات ──────────────────────────',
    `نوع الروابط  : ${wizard.linkType}`,
    `الفترة       : ${wizard.period}`,
    `مستوى البحث  : ${wizard.searchDepth}`,
    `عدد الحسابات : ${accounts.length}`,
    '',
    '── النتائج ────────────────────────────',
    `المحادثات المفحوصة : ${progress.scannedChats}`,
    `الرسائل المفحوصة   : ${progress.scannedMessages}`,
    `روابط تيليجرام     : ${progress.telegramLinks}`,
    `روابط واتساب       : ${progress.whatsappLinks}`,
    `إجمالي الروابط     : ${progress.totalLinks}`,
    `مكررة محذوفة       : ${progress.duplicatesRemoved}`,
    `الروابط المحفوظة   : ${progress.savedLinks}`,
    '══════════════════════════════════════',
  ];
  return lines.join('\n');
};

module.exports = {
  runSearch,
  pauseSearch,
  resumeSearch,
  stopSearch,
  getProgress,
  hasActiveSearch,
  extractLinks,
  hashUrl,
  resolvePeriod,
};
