const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join('/tmp', `links-pagination-${process.pid}.db`);
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.LINKS_PAGE_SIZE = '2';
process.env.LINKS_MAX_RETRIES = '3';

const { getDb, botUserQueries } = require('../src/database/db');
const { linksOperationQueries, linksSettingsQueries, linksCheckpointQueries } = require('../src/database/linksDb');
const { paginateDialog } = require('../src/services/linksService');

(async () => {
  getDb();
  const userId = 'pagination-user';
  botUserQueries.upsert(userId, 'tester', 'Tester');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-pagination-output-'));
  linksSettingsQueries.upsert(userId, 'output_dir', outputDir);
  linksSettingsQueries.upsert(userId, 'remove_duplicates', 1);
  const wizard = { linkType: 'both', searchDepth: 'deep' };
  const operationId = linksOperationQueries.create(userId, { ...wizard, period: 'month', accountMode: 'all' });
  const now = Math.floor(Date.now() / 1000);
  const pageByOffset = {
    0: [
      { id: 5, date: now, message: 'https://t.me/alpha https://chat.whatsapp.com/ABCDEFGHIJKL' },
      { id: 4, date: now, message: 'https://t.me/beta' },
    ],
    4: [
      { id: 3, date: now, message: 'https://t.me/beta https://t.me/gamma' },
      { id: 2, date: now, message: 'https://t.me/delta' },
    ],
    2: [{ id: 1, date: now, message: 'https://t.me/epsilon' }],
  };
  let transientFailure = true;
  const calls = [];
  const client = {
    async getMessages(_entity, params) {
      const offset = Number(params.offsetId || 0);
      calls.push(offset);
      if (offset === 4 && transientFailure) {
        transientFailure = false;
        throw new Error('ETIMEDOUT');
      }
      return pageByOffset[offset] || [];
    },
  };
  const progress = {
    scannedMessages: 0, linksExtracted: 0, linksValidated: 0, savedLinks: 0,
    duplicatesRemoved: 0, newLinks: 0, totalLinks: 0, telegramLinks: 0,
    whatsappLinks: 0, collectedTelegram: new Set(), collectedWhatsapp: new Set(),
    isPaused: false,
  };
  const state = {
    stopped: false, paused: false, startTime: Date.now(), retryCount: 0,
    floodWaitCount: 0, progress, fromDate: new Date(now * 1000 - 86400000),
    toDate: new Date(now * 1000 + 86400000), onProgress: async () => {},
  };
  const result = await paginateDialog({
    userId, operationId, account: { id: 7 }, dialog: { id: 'chat-1', entity: 'chat-1' },
    client, wizard, settings: { remove_duplicates: 1 },
    fromDate: state.fromDate, toDate: state.toDate, progress, state,
  });

  assert.equal(result.reason, 'END_OF_MESSAGES');
  assert.deepEqual(calls, [0, 4, 4, 2, 1]);
  assert.equal(progress.scannedMessages, 5);
  assert.equal(progress.savedLinks, 6);
  assert.equal(progress.duplicatesRemoved, 1);
  assert.equal(state.retryCount, 1);

  const checkpoint = linksCheckpointQueries.get(operationId, 7, 'chat-1');
  assert.equal(Number(checkpoint.current_cursor), 1);
  assert.equal(checkpoint.pages_processed, 3);
  assert.equal(checkpoint.status, 'running');

  const resumedProgress = {
    ...progress, scannedMessages: 0, linksExtracted: 0, linksValidated: 0,
    savedLinks: 0, newLinks: 0, totalLinks: 0, telegramLinks: 0, whatsappLinks: 0,
    duplicatesRemoved: 0, collectedTelegram: new Set(), collectedWhatsapp: new Set(),
  };
  const resumedState = { ...state, progress: resumedProgress, retryCount: 0, onProgress: async () => {} };
  const resumeCalls = [];
  const resumedClient = { async getMessages(_entity, params) { resumeCalls.push(Number(params.offsetId || 0)); return []; } };
  const resumed = await paginateDialog({
    userId, operationId, account: { id: 7 }, dialog: { id: 'chat-1', entity: 'chat-1' },
    client: resumedClient, wizard, settings: { remove_duplicates: 1 },
    fromDate: state.fromDate, toDate: state.toDate, progress: resumedProgress, state: resumedState,
  });
  assert.equal(resumed.reason, 'END_OF_MESSAGES');
  assert.deepEqual(resumeCalls, [1]);
  assert.equal(resumedProgress.savedLinks, 0);
  console.log('links.pagination-resume: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
