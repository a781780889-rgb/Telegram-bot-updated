const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-subscription-preservation-'));
const dbPath = path.join(root, 'accounts.db');
const env = { ...process.env, DB_PATH: dbPath };
const bootstrap = `
  const { botUserQueries, accountQueries } = require('./src/database/db');
  botUserQueries.upsert('subscription-user-1', 'subscriber', 'Subscriber');
  botUserQueries.activate('subscription-user-1', 77, new Date(Date.now() + 30 * 86400000).toISOString());
  const accountId = accountQueries.insert('subscription-user-1', '+966500000001');
  accountQueries.updateStatus(accountId, 'connected', {
    session_file: '/persistent/sessions/966500000001_1.enc',
    encrypted_session: 'encrypted-session-regression-fixture',
    first_name: 'Saved',
    last_name: 'Account',
  });
  console.log('bootstrap: PASS');
`;
const restart = `
  const { botUserQueries, accountQueries } = require('./src/database/db');
  const status = botUserQueries.getActivationStatus('subscription-user-1');
  if (!status.activated) throw new Error('active subscription was lost after restart');
  if (status.row.activation_code_id !== 77) throw new Error('activation code changed after restart');
  const account = accountQueries.getByUserIdAndPhone('subscription-user-1', '+966500000001');
  if (!account) throw new Error('Telegram account was lost after restart');
  if (account.status !== 'connected') throw new Error('Telegram account status changed after restart');
  if (account.encrypted_session !== 'encrypted-session-regression-fixture') throw new Error('encrypted Telegram session was lost after restart');
  console.log('restart: PASS');
`;

const first = spawnSync(process.execPath, ['-e', bootstrap], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
assert.equal(first.status, 0, first.stderr || first.stdout);
const second = spawnSync(process.execPath, ['-e', restart], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
assert.equal(second.status, 0, second.stderr || second.stdout);
console.log('subscription-preservation: PASS');
