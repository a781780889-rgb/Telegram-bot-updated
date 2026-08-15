const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-persistence-'));
process.env.SESSIONS_DIR = path.join(root, 'sessions');
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-characters-long-123';
const { encrypt } = require('../src/utils/encryption');
const telegramClient = require('../src/services/telegramClient');

const account = {
  id: 44,
  phone: '+966500000000',
  encrypted_session: encrypt('persisted-string-session'),
};
const restoredPath = telegramClient.restoreSessionFile(account);
assert(restoredPath && fs.existsSync(restoredPath));
assert.equal(fs.readFileSync(restoredPath, 'utf8'), account.encrypted_session);
fs.rmSync(restoredPath);
const restoredAgain = telegramClient.restoreSessionFile(account);
assert(restoredAgain && fs.existsSync(restoredAgain));
assert.equal(fs.readFileSync(restoredAgain, 'utf8'), account.encrypted_session);
console.log('persistence.integration: PASS');
