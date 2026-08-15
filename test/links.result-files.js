const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbFile = path.join('/tmp', `links-result-files-${process.pid}.db`);
try { fs.unlinkSync(dbFile); } catch (_) {}
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-output-'));
const adminDir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-admin-'));
process.env.DB_PATH = dbFile;
process.env.ADMIN_RESULT_FILES_DIR = adminDir;
const { getDb, botUserQueries } = require('../src/database/db');
const { linksOperationQueries, linksSettingsQueries, linksResultFilesQueries } = require('../src/database/linksDb');
const { runSearch } = require('../src/services/linksService');

(async () => {
  getDb();
  const userId = '777';
  botUserQueries.upsert(userId, 'tester', 'Tester');
  linksSettingsQueries.upsert(userId, 'output_dir', outputDir);
  const wizard = { accountMode: 'all', linkType: 'telegram', period: 'month', searchDepth: 'deep' };
  const firstOperation = linksOperationQueries.create(userId, wizard);
  await runSearch(userId, firstOperation, wizard, async () => {});
  const firstRows = linksResultFilesQueries.list({ limit: 20 });
  assert.equal(firstRows.length, 4);
  assert(firstRows.every((row) => row.user_id === userId));
  assert(firstRows.every((row) => row.operation_id === firstOperation));
  assert(firstRows.every((row) => row.status === 'available'));
  assert(firstRows.every((row) => fs.existsSync(row.file_path)));
  assert(firstRows.every((row) => row.file_name.startsWith('search_telegram_777_')));

  const secondOperation = linksOperationQueries.create(userId, wizard);
  await runSearch(userId, secondOperation, wizard, async () => {});
  const allRows = linksResultFilesQueries.list({ limit: 20 });
  assert.equal(allRows.length, 8);
  assert.equal(new Set(allRows.map((row) => row.file_id)).size, 8);
  assert.equal(new Set(allRows.map((row) => row.file_path)).size, 8);

  const first = linksResultFilesQueries.getById(firstRows[0].file_id);
  assert.equal(first.operation_id, firstOperation);
  linksResultFilesQueries.markDeleted(first.file_id);
  assert.equal(linksResultFilesQueries.getById(first.file_id).status, 'deleted');
  console.log('links.result-files: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
