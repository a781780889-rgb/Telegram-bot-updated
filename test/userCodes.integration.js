const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dbFile = path.join('/tmp', `user-codes-${process.pid}.db`);
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
const { getDb, botUserQueries } = require('../src/database/db');
const codes = require('../src/database/userCodesDb');

getDb();
const monthly = codes.createCode({ activationType: 'month' }, '1');
assert.match(monthly.code, /^TG-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
assert.equal(monthly.activation_type, 'month');
assert.equal(codes.redeemCode('not-a-code', { telegramUserId: '10' }).reason, 'invalid');
const monthlyRedemption = codes.redeemCode(monthly.code, { telegramUserId: '10', username: 'u' });
assert.equal(monthlyRedemption.ok, true);
assert.equal(monthlyRedemption.activationType, 'month');
assert.equal(botUserQueries.getActivationStatus('10').activated, true);
assert.equal(Boolean(botUserQueries.getActivationStatus('10').row.activation_expires_at), true);
assert.equal(codes.redeemCode(monthly.code, { telegramUserId: '11' }).reason, 'used');

const yearly = codes.createCode({ activationType: 'year' }, '1');
const yearlyRedemption = codes.redeemCode(yearly.code, { telegramUserId: '20' });
assert.equal(yearlyRedemption.ok, true);
assert.equal(yearlyRedemption.activationType, 'year');
assert.equal(Math.round((yearlyRedemption.end - yearlyRedemption.start) / 86400000), 365);

const open = codes.createCode({ activationType: 'open' }, '1');
const openRedemption = codes.redeemCode(open.code, { telegramUserId: '21' });
assert.equal(openRedemption.ok, true);
assert.equal(openRedemption.end, null);
assert.equal(botUserQueries.getActivationStatus('21').row.activation_expires_at, null);

const assigned = codes.createCode({ activationType: 'month', assignedTelegramUserId: '30' }, '1');
assert.equal(codes.redeemCode(assigned.code, { telegramUserId: '31' }).reason, 'assigned');
const disabled = codes.createCode({ activationType: 'year' }, '1');
codes.setStatus(disabled.id, 'disabled', '1');
assert.equal(codes.redeemCode(disabled.code, { telegramUserId: '32' }).reason, 'disabled');

const expiredUser = '33';
botUserQueries.upsert(expiredUser, 'expired', 'Expired');
botUserQueries.activate(expiredUser, 99, '2000-01-01T00:00:00.000Z');
assert.equal(botUserQueries.getActivationStatus(expiredUser).reason, 'expired');

const batch = codes.createBatch({ count: 1, activationType: 'month' }, '1');
assert.equal(batch.length, 1);
const many = codes.createBatch({ count: 1000, activationType: 'open' }, '1');
assert.equal(many.length, 1000);
assert.equal(new Set(many.map((item) => item.code)).size, 1000);
const concurrent = codes.createCode({ activationType: 'open' }, '1');
const first = codes.redeemCode(concurrent.code, { telegramUserId: '40' });
const second = codes.redeemCode(concurrent.code, { telegramUserId: '41' });
assert.equal(first.ok, true);
assert.equal(second.ok, false);
assert.equal(getDb().prepare('SELECT COUNT(*) count FROM code_redemptions').get().count, 4);
console.log('userCodes.integration: PASS');
