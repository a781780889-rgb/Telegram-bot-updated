const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.env.TEST_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-persistence-restart-'));
const dbFile = path.join(root, 'accounts.db');
const sessionsDir = path.join(root, 'sessions');
const childEnv = { ...process.env, TEST_ROOT: root, DB_PATH: dbFile, SESSIONS_DIR: sessionsDir, ENCRYPTION_KEY: 'test-encryption-key-32-characters-long-123' };

if (!process.argv[2]) {
  const first = spawnSync(process.execPath, [__filename, 'write'], { env: childEnv, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const second = spawnSync(process.execPath, [__filename, 'verify'], { env: childEnv, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /persistence\.restart: PASS/);
  console.log('persistence.restart: PASS');
  process.exit(0);
}

if (process.argv[2] === 'write') {
  process.env.DB_PATH = dbFile;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.ENCRYPTION_KEY = childEnv.ENCRYPTION_KEY;
  const { encrypt } = require('../src/utils/encryption');
  const { getDb, botUserQueries, accountQueries } = require('../src/database/db');
  const { createCode, redeemCode } = require('../src/database/userCodesDb');
  const db = getDb();
  const userId = 'restart-user-1';
  botUserQueries.upsert(userId, 'persistent_user', 'Persistent');
  const code = createCode({ activationType: 'open' }, 'admin-1');
  const redeemed = redeemCode(code.code, { telegramUserId: userId, username: 'persistent_user', firstName: 'Persistent' });
  assert.equal(redeemed.ok, true);
  const accountId = accountQueries.insert(userId, '+966500000001');
  const encrypted = encrypt('persistent-session-string');
  accountQueries.updateStatus(accountId, 'connected', {
    first_name: 'Telegram', last_name: 'User', username: 'telegram_user', telegram_id: '99887766',
    session_file: path.join(sessionsDir, '966500000001_1.enc'), encrypted_session: encrypted,
  });
  assert.equal(accountQueries.insert(userId, '+966500000001'), accountId);
  const snapshot = {
    users: db.prepare('SELECT COUNT(*) AS count FROM bot_users').get().count,
    accounts: db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count,
    activeRedemptions: db.prepare("SELECT COUNT(*) AS count FROM code_redemptions WHERE subscription_status='active'").get().count,
    sessions: db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE encrypted_session IS NOT NULL AND encrypted_session != ''").get().count,
  };
  fs.writeFileSync(path.join(root, 'snapshot.json'), JSON.stringify(snapshot));
  process.exit(0);
}

if (process.argv[2] === 'verify') {
  process.env.DB_PATH = dbFile;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.ENCRYPTION_KEY = childEnv.ENCRYPTION_KEY;
  const { getDb, botUserQueries, accountQueries, auditQueries } = require('../src/database/db');
  const { getUserRedemptions } = require('../src/database/userCodesDb');
  const { restoreSessionFile } = require('../src/services/telegramClient');
  const db = getDb();
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'snapshot.json'), 'utf8'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bot_users').get().count, expected.users);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, expected.accounts);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM code_redemptions WHERE subscription_status='active'").get().count, expected.activeRedemptions);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE encrypted_session IS NOT NULL AND encrypted_session != ''").get().count, expected.sessions);
  assert.equal(botUserQueries.getActivationStatus('restart-user-1').activated, true);
  assert.equal(getUserRedemptions('restart-user-1').length, 1);
  const account = accountQueries.getByUserIdAndPhone('restart-user-1', '+966500000001');
  assert(account && account.id === 1);
  assert.equal(account.telegram_id, '99887766');
  const restored = restoreSessionFile(account);
  assert(restored && fs.existsSync(restored));
  assert.equal(fs.readFileSync(restored, 'utf8'), account.encrypted_session);
  assert(auditQueries.list({ userId: 'restart-user-1' }).length >= 3);
  console.log('persistence.restart: PASS');
  process.exit(0);
}
