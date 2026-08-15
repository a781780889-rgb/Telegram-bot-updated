const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dbFile = path.join('/tmp', `activation-guard-${process.pid}.db`);
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.ADMIN_TELEGRAM_IDS = '999';
const { getDb, botUserQueries } = require('../src/database/db');
const { activationGuard } = require('../src/middlewares/activationGuard');
const wizard = require('../src/services/userCodesWizardState');
getDb();

const run = async (ctx) => {
  let nextCalled = false;
  await activationGuard(ctx, async () => { nextCalled = true; });
  return nextCalled;
};
const base = (text, extra = {}) => ({ from: { id: 123 }, chat: { type: 'private' }, message: text ? { text } : undefined, ...extra });
(async () => {
  assert.equal(await run(base('hello')), false);
  assert.equal(await run(base('/start')), true);
  assert.equal(await run({ ...base(), callbackQuery: { data: 'old_callback' }, answerCbQuery: async () => {}, editMessageText: async () => {} }), false);
  assert.equal(await run({ ...base(), callbackQuery: { data: 'use_code' } }), true);
  wizard.set('123', 'redeem');
  assert.equal(await run(base('TG-XXXX-XXXX-XXXX')), true);
  wizard.reset('123');
  botUserQueries.upsert('123', 'tester', 'Tester');
  botUserQueries.activate('123', 1, new Date(Date.now() + 86400000).toISOString());
  assert.equal(await run(base('hello')), true);
  assert.equal(await run({ ...base(), callbackQuery: { data: 'old_callback' } }), true);
  assert.equal(await run(base('/menu')), true);
  assert.equal(await run(base('anything', { from: { id: 999 } })), true);
  console.log('activationGuard.integration: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
