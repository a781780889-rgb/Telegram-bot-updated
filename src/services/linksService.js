
/**
 * Reliable Telegram link-search service.
 *
 * The search contract is deliberately page-oriented: fetch one page, parse and
 * persist the entire page, then advance the checkpoint. A cursor is never
 * advanced before persistence succeeds, which makes retries and restarts safe.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { accountQueries, botUserQueries } = require('../database/db');
const {
  linksOperationQueries,
  linksCheckpointQueries,
  linksSearchErrorQueries,
  linksFoundQueries,
  linksSettingsQueries,
  linksResultFilesQueries,
} = require('../database/linksDb');

const TELEGRAM_PATTERN = /(?:https?:\/\/)?(?:t(?:elegram)?\.me|telegram\.org)\/[^^\s<>'"\])]+/gi;
const WHATSAPP_GROUP_PATTERN = /(?:https?:\/\/)?chat\.whatsapp\.com\/[A-Za-z0-9_-]{10,}/gi;
const TRAILING_PUNCTUATION = /[.,;!?،؛\)\]}>'"،]+$/u;
const DEEP_MESSAGE_LIMIT = Math.max(1000, Number(process.env.LINKS_DEEP_MESSAGE_LIMIT || 5000));
const PAGE_SIZE = Math.max(50, Math.min(1000, Number(process.env.LINKS_PAGE_SIZE || 500)));
const SEARCH_REQUEST_TIMEOUT_MS = Math.max(15000, Number(process.env.LINKS_REQUEST_TIMEOUT_MS || 90000));
const MAX_RETRIES = Math.max(1, Number(process.env.LINKS_MAX_RETRIES || 4));
const activeSearches = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeFilePart = (value) => String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
const progressCount = (linksCount, type) => (typeof linksCount === 'object' ? Number(linksCount[type] || 0) : Number(linksCount) || 0);

const resolvePeriod = (period, customStart, customEnd) => {
  const toDate = customEnd ? new Date(customEnd) : new Date();
  const fromDate = period === 'week' ? new Date(Date.now() - 7 * 86400000)
    : period === 'month' ? new Date(Date.now() - 30 * 86400000)
      : period === '3months' ? new Date(Date.now() - 90 * 86400000)
        : period === 'year' ? new Date(Date.now() - 365 * 86400000)
          : period === 'custom' ? (customStart ? new Date(customStart) : new Date(Date.now() - 30 * 86400000))
            : new Date(Date.now() - 30 * 86400000);
  return { fromDate, toDate };
};

const depthToLimit = (depth) => ({ fast: 100, medium: 500, deep: DEEP_MESSAGE_LIMIT }[depth] ?? 500);
const depthPageLimit = (depth) => depth === 'fast' ? 1 : Number.POSITIVE_INFINITY;

const cleanUrl = (value) => String(value || '').trim().replace(TRAILING_PUNCTUATION, '');
const classifyUrl = (value) => {
  const url = cleanUrl(value);
  const candidate = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 't.me' || host === 'telegram.me' || host === 'telegram.org') return 'telegram';
    if (host === 'chat.whatsapp.com') return 'whatsapp';
  } catch (_) {}
  return null;
};

const normalizeUrl = (value) => {
  const raw = cleanUrl(value);
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    parsed.protocol = 'https:';
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return null;
  }
};

const hashUrl = (url) => crypto.createHash('sha256').update(String(url).toLowerCase().trim()).digest('hex');

const extractLinks = (text, linkType = 'both', entities = []) => {
  const source = String(text || '');
  const values = [];
  values.push(...(linkType === 'both' || linkType === 'telegram' ? (source.match(TELEGRAM_PATTERN) || []) : []));
  values.push(...(linkType === 'both' || linkType === 'whatsapp' ? (source.match(WHATSAPP_GROUP_PATTERN) || []) : []));
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (entity?.url) values.push(entity.url);
  }
  const seen = new Set();
  return values.flatMap((raw) => {
    const type = classifyUrl(raw);
    const normalized = normalizeUrl(raw);
    if (!type || !normalized || (linkType !== 'both' && linkType !== type) || seen.has(`${type}:${normalized}`)) return [];
    seen.add(`${type}:${normalized}`);
    return [{ url: normalized, rawUrl: cleanUrl(raw), type }];
  });
};

const getMessageDate = (message) => {
  if (!message?.date) return null;
  const date = message.date instanceof Date ? message.date : new Date(Number(message.date) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
};
const getMessageText = (message) => message?.message || message?.text || '';
const getMessageEntities = (message) => message?.entities || message?.message?.entities || [];

const errorCategory = (error) => {
  const message = String(error?.message || error || '').toUpperCase();
  if (message.includes('FLOOD_WAIT') || message.includes('FLOODWAIT')) return 'rate_limit';
  if (message.includes('TIMEOUT') || message.includes('ETIMEDOUT') || message.includes('NETWORK') || message.includes('ECONN')) return 'network';
  if (message.includes('AUTH') || message.includes('SESSION')) return 'authentication';
  if (message.includes('SQLITE') || message.includes('DATABASE')) return 'database';
  return 'telegram_api';
};
const floodWaitSeconds = (error) => {
  const match = String(error?.message || error || '').match(/(?:FLOOD_WAIT|FLOODWAIT)[_ ]?(\d+)/i);
  return match ? Math.max(1, Number(match[1])) : 0;
};

const withTimeout = (promise, timeoutMs, message) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
]);

const updateOperation = (operationId, updates) => {
  try { linksOperationQueries.updateProgress(operationId, updates); } catch (error) { logger.error(`Unable to update link operation ${operationId}:`, error); }
};

const retry = async (operationId, operationContext, fn, state) => {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      const category = errorCategory(error);
      const waitSeconds = floodWaitSeconds(error);
      linksSearchErrorQueries.add(operationId, { ...operationContext, category, message: error.message, retryCount: attempt });
      updateOperation(operationId, {
        retry_count: (state.retryCount || 0) + 1,
        flood_wait_count: (state.floodWaitCount || 0) + (waitSeconds ? 1 : 0),
        status: waitSeconds ? 'paused_rate_limit' : 'running',
        last_error: error.message,
      });
      state.retryCount = (state.retryCount || 0) + 1;
      if (waitSeconds) {
        state.progress.isPaused = true;
        await state.onProgress({ ...state.progress });
        await sleep(waitSeconds * 1000);
        state.progress.isPaused = false;
        updateOperation(operationId, { status: 'resuming', last_resume_at: new Date().toISOString(), resume_count: 1 });
      } else if (attempt < MAX_RETRIES) {
        await sleep(Math.min(30000, 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250)));
      }
    }
  }
  throw lastError;
};

const buildEntities = (message) => {
  const entities = getMessageEntities(message);
  return entities.map((entity) => entity?.url || entity?.text_url).filter(Boolean);
};

const registerAdminResultFiles = ({ operationId, userId, wizard, outputDir, files, linksCount }) => {
  try {
    const settings = linksSettingsQueries.get(userId);
    const adminRoot = path.resolve(process.env.ADMIN_RESULT_FILES_DIR || path.join(settings.output_dir, 'admin_results'));
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const userDir = path.join(adminRoot, safeFilePart(userId));
    fs.mkdirSync(userDir, { recursive: true });
    const botUser = botUserQueries.getByTelegramUserId(userId);
    const records = [];
    for (const sourceName of files) {
      if (!sourceName.endsWith('.txt')) continue;
      const sourcePath = path.join(outputDir, sourceName);
      if (!fs.existsSync(sourcePath)) continue;
      const uniqueId = `rf_${operationId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const fileName = `search_${safeFilePart(wizard.linkType || 'links')}_${safeFilePart(userId)}_${timestamp}_${operationId}_${safeFilePart(sourceName)}`;
      const targetPath = path.join(userDir, `${uniqueId}_${fileName}`);
      fs.copyFileSync(sourcePath, targetPath);
      records.push(linksResultFilesQueries.create({ fileId: uniqueId, operationId, userId, username: botUser?.username || null, searchQuery: wizard.searchQuery || `${wizard.linkType || 'both'} | ${wizard.period || 'unknown'}`, fileName, filePath: targetPath, linksCount: sourceName === 'Telegram_Links.txt' ? progressCount(linksCount, 'telegram') : sourceName === 'Whatsapp_Links.txt' ? progressCount(linksCount, 'whatsapp') : linksCount, fileSize: fs.statSync(targetPath).size }));
    }
    return records;
  } catch (error) { logger.error(`Admin result-file copy failed for operation ${operationId}:`, error); return []; }
};

const updateElapsed = (progress, startedAt) => {
  progress.elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  progress.speed = progress.elapsedSeconds ? Math.round(progress.scannedMessages / progress.elapsedSeconds) : 0;
};
const dirSize = (dir) => { try { return fs.readdirSync(dir).reduce((sum, file) => sum + (fs.statSync(path.join(dir, file)).size || 0), 0); } catch (_) { return 0; } };
const buildReport = (progress, wizard, accounts, startTime, completionReason) => [
  '══════════════════════════════════════', '         تقرير عملية البحث عن الروابط', '══════════════════════════════════════',
  `وقت البداية : ${new Date(startTime).toLocaleString('ar-SA')}`, `وقت الانتهاء: ${new Date().toLocaleString('ar-SA')}`,
  `مستوى البحث  : ${wizard.searchDepth}`, `الفترة       : ${wizard.period}`, `سبب الانتهاء : ${completionReason || 'غير مكتمل'}`, `عدد الحسابات : ${accounts.length}`, '',
  `المحادثات المفحوصة : ${progress.scannedChats}`, `الرسائل المفحوصة   : ${progress.scannedMessages}`, `روابط تيليجرام     : ${progress.telegramLinks}`, `روابط واتساب       : ${progress.whatsappLinks}`, `إجمالي الروابط     : ${progress.totalLinks}`, `المكررة المتخطاة   : ${progress.duplicatesRemoved}`, `الروابط المحفوظة   : ${progress.savedLinks}`, '══════════════════════════════════════',
].join('\n');

const pauseSearch = (userId) => { const state = activeSearches.get(String(userId)); if (state) { state.paused = true; state.progress.isPaused = true; updateOperation(state.operationId, { status: 'paused' }); } };
const resumeSearch = (userId) => { const state = activeSearches.get(String(userId)); if (state) { state.paused = false; state.progress.isPaused = false; updateOperation(state.operationId, { status: 'resuming', last_resume_at: new Date().toISOString() }); } };
const stopSearch = (userId) => { const state = activeSearches.get(String(userId)); if (state) { state.stopped = true; updateOperation(state.operationId, { status: 'stopping' }); } };
const getProgress = (userId) => activeSearches.get(String(userId))?.progress || null;
const hasActiveSearch = (userId) => activeSearches.has(String(userId));

const waitIfPaused = async (state) => {
  while (state.paused && !state.stopped) { state.progress.isPaused = true; await state.onProgress({ ...state.progress }); await sleep(500); }
  state.progress.isPaused = false;
};

const processPage = async ({ userId, operationId, account, dialog, messages, wizard, settings, progress, state }) => {
  const records = [];
  const pageSeen = new Set();
  for (const message of messages) {
    if (state.stopped) break;
    const date = getMessageDate(message);
    if (date && (date > state.toDate || date < state.fromDate)) continue;
    progress.scannedMessages++;
    const links = extractLinks(getMessageText(message), wizard.linkType, buildEntities(message));
    for (const link of links) {
      progress.linksExtracted++;
      const key = link.type + ':' + hashUrl(link.url);
      if (pageSeen.has(key)) { progress.duplicatesRemoved++; continue; }
      pageSeen.add(key);
      records.push({ url: link.url, urlHash: hashUrl(link.url), linkType: link.type, accountId: account.id, dialogId: dialog.id, messageId: message.id });
    }
  }
  progress.linksValidated += records.length;
  const result = linksFoundQueries.insertMany(userId, operationId, records, { deduplicateAcrossUser: Boolean(settings.remove_duplicates) });
  progress.duplicatesRemoved += result.duplicateSkipped;
  progress.savedLinks += result.inserted;
  progress.newLinks += result.inserted;
  for (const record of result.insertedRecords || []) {
    if (record.linkType === 'telegram') { progress.telegramLinks++; progress.collectedTelegram.add(record.url); }
    else { progress.whatsappLinks++; progress.collectedWhatsapp.add(record.url); }
  }
  progress.totalLinks = progress.telegramLinks + progress.whatsappLinks;
  return { records, ...result };
};

const paginateDialog = async ({ userId, operationId, account, dialog, client, wizard, settings, fromDate, toDate, progress, state }) => {
  const checkpoint = linksCheckpointQueries.get(operationId, account.id, dialog.id);
  let cursor = checkpoint?.current_cursor ? Number(checkpoint.current_cursor) : 0;
  let pages = Number(checkpoint?.pages_processed || 0);
  let messagesProcessed = Number(checkpoint?.messages_processed || 0);
  let linksFound = Number(checkpoint?.links_found || 0);
  let linksSaved = Number(checkpoint?.links_saved || 0);
  let reason = null;
  const maxPages = depthPageLimit(wizard.searchDepth);

  while (!state.stopped && pages < maxPages) {
    await waitIfPaused(state);
    const page = await retry(operationId, { accountId: account.id, dialogId: dialog.id, cursor }, () => withTimeout(client.getMessages(dialog.entity, { limit: PAGE_SIZE, offsetId: cursor || undefined }), SEARCH_REQUEST_TIMEOUT_MS, 'انتهت مهلة قراءة صفحة الرسائل'), state);
    const messages = Array.isArray(page) ? page : [];
    if (!messages.length) { reason = 'END_OF_MESSAGES'; break; }
    const oldest = messages.reduce((current, item) => (!current || Number(item.id) < Number(current.id) ? item : current), null);
    const oldestDate = getMessageDate(oldest);
    await processPage({ userId, operationId, account, dialog, messages, wizard, settings, progress, state });
    pages++;
    messagesProcessed += messages.length;
    linksFound = progress.linksExtracted;
    linksSaved = progress.savedLinks;
    const nextCursor = Number(oldest?.id || 0);
    if (!nextCursor || nextCursor === cursor) {
      linksCheckpointQueries.save(operationId, account.id, dialog.id, { currentCursor: cursor, lastMessageId: oldest?.id, oldestMessageTimestamp: oldestDate?.toISOString(), messagesProcessed, pagesProcessed: pages, linksFound, linksSaved, status: 'failed', lastError: 'CURSOR_STALLED' });
      linksSearchErrorQueries.add(operationId, { accountId: account.id, dialogId: dialog.id, cursor, category: 'pagination', message: 'Cursor did not advance', retryCount: 0 });
      throw new Error(`Pagination cursor stalled for dialog ${dialog.id}`);
    }
    cursor = nextCursor;
    const reachedDate = oldestDate && oldestDate < fromDate;
    linksCheckpointQueries.save(operationId, account.id, dialog.id, { currentCursor: cursor, lastMessageId: oldest?.id, oldestMessageTimestamp: oldestDate?.toISOString(), messagesProcessed, pagesProcessed: pages, linksFound, linksSaved, status: reachedDate ? 'completed' : 'running' });
    updateOperation(operationId, { status: 'running', current_cursor: String(cursor), last_message_id: String(oldest?.id || ''), pages_completed: pages, messages_scanned: progress.scannedMessages, links_extracted: progress.linksExtracted, links_validated: progress.linksValidated, links_saved: progress.savedLinks, duplicates_skipped: progress.duplicatesRemoved, telegram_links: progress.telegramLinks, whatsapp_links: progress.whatsappLinks, total_links: progress.totalLinks, saved_links: progress.savedLinks, chats_scanned: progress.scannedChats });
    updateElapsed(progress, state.startTime);
    await state.onProgress({ ...progress });
    if (reachedDate) { reason = 'DATE_RANGE_REACHED'; break; }
  }
  if (!reason && pages >= maxPages) reason = wizard.searchDepth === 'fast' ? 'DEPTH_LIMIT_REACHED' : 'TARGET_MESSAGE_REACHED';
  return { reason, pages, messagesProcessed };
};

const runSearch = async (userId, operationId, wizard, onProgress = async () => {}) => {
  const uid = String(userId);
  if (activeSearches.has(uid)) throw new Error('يوجد بحث نشط لهذا المستخدم بالفعل');
  const existing = linksOperationQueries.getById(operationId);
  if (!existing || String(existing.user_id) !== uid) throw new Error('عملية البحث غير صالحة');
  const startTime = Date.now();
  const { fromDate, toDate } = resolvePeriod(wizard.period, wizard.customStart, wizard.customEnd);
  const progress = { currentAccount: '', doneAccounts: 0, remainingAccounts: 0, scannedMessages: 0, scannedChats: 0, totalLinks: 0, telegramLinks: 0, whatsappLinks: 0, duplicatesRemoved: 0, newLinks: 0, savedLinks: 0, linksExtracted: 0, linksValidated: 0, speed: 0, elapsedSeconds: 0, etaSeconds: null, percent: 0, lastAction: '', lastLink: '', isPaused: false, pages: 0, collectedTelegram: new Set(), collectedWhatsapp: new Set() };
  const state = { operationId, paused: false, stopped: false, progress, startTime, fromDate, toDate, retryCount: 0, floodWaitCount: 0, onProgress };
  activeSearches.set(uid, state);
  try {
    const settings = linksSettingsQueries.get(uid);
    const accounts = (wizard.accountMode === 'all' ? accountQueries.getAllByUserId(uid) : (wizard.selectedAccountIds || []).map((id) => accountQueries.getById(id))).filter((account) => account && account.user_id === uid && account.status === 'connected');
    progress.remainingAccounts = accounts.length;
    const outputDir = path.join(settings.output_dir, uid, `op_${operationId}_${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });
    updateOperation(operationId, { status: 'running', resume_count: Number(existing.resume_count || 0) + (existing.status !== 'pending' ? 1 : 0), last_resume_at: existing.status !== 'pending' ? new Date().toISOString() : null });
    await onProgress({ ...progress });
    for (let ai = 0; ai < accounts.length && !state.stopped; ai++) {
      const account = accounts[ai];
      progress.currentAccount = [account.first_name, account.last_name].filter(Boolean).join(' ') || account.phone;
      progress.remainingAccounts = accounts.length - ai;
      progress.lastAction = `جارٍ تحميل حساب ${progress.currentAccount}`;
      let client;
      try {
        const { loadSession, restoreSessionFile } = require('./telegramClient');
        const sessionFile = restoreSessionFile(account) || account.session_file;
        if (!sessionFile) throw new Error('لا توجد جلسة محفوظة');
        client = await retry(operationId, { accountId: account.id, category: 'session' }, () => withTimeout(loadSession(sessionFile), SEARCH_REQUEST_TIMEOUT_MS, 'انتهت مهلة تحميل الجلسة'), state);
        const dialogs = await retry(operationId, { accountId: account.id, category: 'dialogs' }, () => withTimeout(client.getDialogs({ limit: 500 }), SEARCH_REQUEST_TIMEOUT_MS, 'انتهت مهلة تحميل المحادثات'), state);
        for (let di = 0; di < dialogs.length && !state.stopped; di++) {
          const dialog = dialogs[di];
          progress.scannedChats++;
          progress.lastAction = `فحص محادثة: ${(dialog.name || 'محادثة').slice(0, 30)}`;
          await paginateDialog({ userId: uid, operationId, account, dialog, client, wizard, settings, fromDate, toDate, progress, state });
          progress.pages++;
          progress.percent = Math.min(95, Math.round(((ai + (di + 1) / Math.max(1, dialogs.length)) / Math.max(1, accounts.length)) * 90));
          await onProgress({ ...progress });
        }
      } catch (error) {
        updateOperation(operationId, { status: 'error', last_error: error.message, pages_failed: 1 });
        linksSearchErrorQueries.add(operationId, { accountId: account.id, category: errorCategory(error), message: error.message, retryCount: state.retryCount });
        throw error;
      } finally {
        if (client) { try { await client.disconnect(); } catch (_) {} }
      }
      progress.doneAccounts++;
      progress.remainingAccounts = accounts.length - ai - 1;
    }
    const completionReason = state.stopped ? 'USER_CANCELLED' : 'DATE_RANGE_REACHED';
    progress.lastAction = 'جارٍ حفظ الملفات...';
    progress.percent = 90;
    const telegramContent = [...progress.collectedTelegram].join('\n');
    const whatsappContent = [...progress.collectedWhatsapp].join('\n');
    const allContent = [...progress.collectedTelegram, ...progress.collectedWhatsapp].join('\n');
    fs.writeFileSync(path.join(outputDir, 'Telegram_Links.txt'), telegramContent, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'Whatsapp_Links.txt'), whatsappContent, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'All_Links.txt'), allContent, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'Search_Report.txt'), buildReport(progress, wizard, accounts, startTime, completionReason), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'Statistics.json'), JSON.stringify({ operationId, completionReason, telegramLinks: progress.telegramLinks, whatsappLinks: progress.whatsappLinks, totalLinks: progress.totalLinks, duplicatesRemoved: progress.duplicatesRemoved, savedLinks: progress.savedLinks, scannedMessages: progress.scannedMessages, scannedChats: progress.scannedChats, pages: progress.pages, retryCount: state.retryCount, floodWaitCount: state.floodWaitCount, startedAt: new Date(startTime).toISOString(), finishedAt: new Date().toISOString() }, null, 2), 'utf8');
    const adminResultFiles = registerAdminResultFiles({ operationId, userId: uid, wizard, outputDir, files: ['Telegram_Links.txt', 'Whatsapp_Links.txt', 'All_Links.txt', 'Search_Report.txt'], linksCount: { telegram: progress.telegramLinks, whatsapp: progress.whatsappLinks, total: progress.totalLinks } });
    updateOperation(operationId, { status: state.stopped ? 'cancelled' : 'completed', completion_reason: completionReason, accounts_used: progress.doneAccounts, chats_scanned: progress.scannedChats, messages_scanned: progress.scannedMessages, telegram_links: progress.telegramLinks, whatsapp_links: progress.whatsappLinks, total_links: progress.totalLinks, duplicates_removed: progress.duplicatesRemoved, saved_links: progress.savedLinks, links_extracted: progress.linksExtracted, links_validated: progress.linksValidated, retry_count: state.retryCount, flood_wait_count: state.floodWaitCount, pages_completed: progress.pages, file_size_bytes: dirSize(outputDir), output_dir: outputDir });
    linksOperationQueries.finish(operationId, state.stopped ? 'cancelled' : 'completed', completionReason);
    progress.percent = 100;
    updateElapsed(progress, startTime);
    await onProgress({ ...progress });
    return { operationId, accountsSearched: progress.doneAccounts, chatsScanned: progress.scannedChats, messagesScanned: progress.scannedMessages, telegramLinks: progress.telegramLinks, whatsappLinks: progress.whatsappLinks, totalLinks: progress.totalLinks, duplicatesRemoved: progress.duplicatesRemoved, savedLinks: progress.savedLinks, durationSeconds: Math.round((Date.now() - startTime) / 1000), startedAt: new Date(startTime).toISOString(), finishedAt: new Date().toISOString(), outputDir, adminResultFiles: adminResultFiles.length, completionReason };
  } catch (error) {
    updateOperation(operationId, { status: 'error', error_message: error.message, last_error: error.message });
    linksOperationQueries.finish(operationId, 'error', 'FAILED');
    throw error;
  } finally { activeSearches.delete(uid); }
};

const resumeIncompleteSearches = async () => {
  for (const operation of linksOperationQueries.listResumable()) {
    if (activeSearches.has(String(operation.user_id))) continue;
    const wizard = { accountMode: operation.account_mode || 'all', selectedAccountIds: JSON.parse(operation.selected_account_ids || '[]'), linkType: operation.link_type || 'both', period: operation.period || 'month', customStart: operation.custom_start, customEnd: operation.custom_end, searchDepth: operation.search_depth || 'medium', searchQuery: operation.search_query };
    runSearch(operation.user_id, operation.id, wizard, async () => {}).catch((error) => logger.error(`Failed to resume link operation ${operation.id}:`, error));
  }
};

module.exports = { runSearch, resumeIncompleteSearches, pauseSearch, resumeSearch, stopSearch, getProgress, hasActiveSearch, extractLinks, normalizeUrl, hashUrl, resolvePeriod, depthToLimit, paginateDialog };

module.exports.__test = { errorCategory, floodWaitSeconds, depthPageLimit };
