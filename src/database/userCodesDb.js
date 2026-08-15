const crypto = require('crypto');
const { getDb } = require('./db');
const logger = require('../utils/logger');

const ACTIVATION_TYPES = Object.freeze({
  month: { label: 'شهر', durationDays: 30 },
  year: { label: 'سنة', durationDays: 365 },
  open: { label: 'مفتوح', durationDays: null },
});
const OPEN_END = '9999-12-31T23:59:59.999Z';

const ensureColumn = (db, table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

const initUserCodesSchema = () => {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      code TEXT NOT NULL UNIQUE,
      code_type TEXT NOT NULL DEFAULT 'subscription',
      activation_type TEXT NOT NULL DEFAULT 'month',
      package_id INTEGER NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 30 CHECK (duration_days > 0),
      expires_at DATETIME,
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
      uses_count INTEGER NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
      single_use INTEGER NOT NULL DEFAULT 1 CHECK (single_use IN (0,1)),
      assigned_telegram_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','disabled')),
      created_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE RESTRICT,
      CHECK (uses_count <= max_uses)
    );
    CREATE TABLE IF NOT EXISTS code_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_id INTEGER NOT NULL,
      telegram_user_id TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      package_id INTEGER NOT NULL,
      redeemed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      subscription_start DATETIME NOT NULL,
      subscription_end DATETIME NOT NULL,
      subscription_status TEXT NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active','expired','revoked')),
      FOREIGN KEY (code_id) REFERENCES user_codes(id) ON DELETE RESTRICT,
      FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE RESTRICT,
      UNIQUE(code_id, telegram_user_id)
    );
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      package_id INTEGER NOT NULL,
      source_code_id INTEGER,
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE RESTRICT,
      FOREIGN KEY (source_code_id) REFERENCES user_codes(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS code_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor_telegram_user_id TEXT,
      target_telegram_user_id TEXT,
      code_id INTEGER,
      result TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (code_id) REFERENCES user_codes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_codes_status ON user_codes(status);
    CREATE INDEX IF NOT EXISTS idx_user_codes_activation_type ON user_codes(activation_type);
    CREATE INDEX IF NOT EXISTS idx_user_codes_assigned ON user_codes(assigned_telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_redemptions_user ON code_redemptions(telegram_user_id);
  `);

  const defaults = [['free', 'Free'], ['basic', 'Basic'], ['premium', 'Premium'], ['vip', 'VIP'], ['enterprise', 'Enterprise']];
  const insertPackage = db.prepare('INSERT OR IGNORE INTO packages (slug, name) VALUES (?, ?)');
  db.transaction(() => defaults.forEach(([slug, name]) => insertPackage.run(slug, name)))();

  // Add the new type to installations created by the previous system without dropping data.
  ensureColumn(db, 'user_codes', 'activation_type', "TEXT NOT NULL DEFAULT 'month'");
  db.exec("UPDATE user_codes SET activation_type = CASE WHEN duration_days >= 365 THEN 'year' ELSE 'month' END WHERE activation_type IS NULL OR activation_type = ''");
};

const normalizeCode = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');
const typeLabel = (type) => ACTIVATION_TYPES[type]?.label || 'غير معروف';
const validateType = (type) => {
  if (!Object.prototype.hasOwnProperty.call(ACTIVATION_TYPES, type)) throw new Error('نوع الكود غير صحيح. اختر شهر أو سنة أو مفتوح.');
  return ACTIVATION_TYPES[type];
};
const generateCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (length) => Array.from(crypto.randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join('');
  return `TG-${part(4)}-${part(4)}`;
};
const audit = (db, action, actorId, targetId, codeId, result, metadata = {}) => db.prepare(`INSERT INTO code_audit_logs (action, actor_telegram_user_id, target_telegram_user_id, code_id, result, metadata) VALUES (?, ?, ?, ?, ?, ?)`).run(action, actorId ? String(actorId) : null, targetId ? String(targetId) : null, codeId || null, result, JSON.stringify(metadata));
const getDefaultPackage = (db) => db.prepare("SELECT * FROM packages WHERE slug='premium' AND is_active=1 LIMIT 1").get() || db.prepare('SELECT * FROM packages WHERE is_active=1 ORDER BY id LIMIT 1').get();
const hydrateCode = (db, id) => db.prepare('SELECT uc.*, p.slug AS package_slug, p.name AS package_name FROM user_codes uc JOIN packages p ON p.id=uc.package_id WHERE uc.id=?').get(id);

const createCode = (input, actorId) => {
  const db = getDb();
  const type = input.activationType || input.type;
  const definition = validateType(type);
  const code = normalizeCode(input.code) || generateCode();
  if (!/^TG-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw new Error('الكود يجب أن يطابق الصيغة TG-XXXX-XXXX.');
  const pkg = getDefaultPackage(db);
  const durationDays = definition.durationDays || 1;
  const row = db.prepare(`INSERT INTO user_codes (name, code, code_type, activation_type, package_id, duration_days, expires_at, max_uses, single_use, assigned_telegram_user_id, status, created_by) VALUES (?, ?, 'activation', ?, ?, ?, NULL, 1, 1, ?, ?, ?)`).run(definition.label, code, type, pkg.id, durationDays, input.assignedTelegramUserId || null, input.status === 'disabled' ? 'disabled' : 'active', actorId ? String(actorId) : null);
  audit(db, 'create_code', actorId, input.assignedTelegramUserId, row.lastInsertRowid, 'success', { activationType: type });
  return hydrateCode(db, row.lastInsertRowid);
};

const createBatch = (input, actorId) => {
  const count = Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('عدد الأكواد يجب أن يكون بين 1 و10000.');
  validateType(input.activationType || input.type);
  const db = getDb();
  const result = [];
  db.transaction(() => { for (let index = 0; index < count; index += 1) result.push(createCode({ activationType: input.activationType || input.type }, actorId)); })();
  return result;
};

const redeemCode = (rawCode, user, actorId = user.telegramUserId) => {
  const db = getDb();
  const code = normalizeCode(rawCode);
  if (!/^TG-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return { ok: false, reason: 'invalid' };
  return db.transaction(() => {
    const row = db.prepare('SELECT uc.*, p.slug AS package_slug, p.name AS package_name FROM user_codes uc JOIN packages p ON p.id=uc.package_id WHERE uc.code=?').get(code);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'disabled') return { ok: false, reason: 'disabled' };
    if (row.status === 'used' || row.uses_count >= 1) return { ok: false, reason: 'used' };
    if (row.assigned_telegram_user_id && String(row.assigned_telegram_user_id) !== String(user.telegramUserId)) return { ok: false, reason: 'assigned' };
    const duplicate = db.prepare('SELECT id FROM code_redemptions WHERE code_id=?').get(row.id);
    if (duplicate) return { ok: false, reason: 'used' };
    const definition = validateType(row.activation_type);
    const start = new Date();
    const end = definition.durationDays ? new Date(start.getTime() + definition.durationDays * 86400000) : null;
    const storedEnd = end ? end.toISOString() : OPEN_END;
    const redemption = db.prepare('INSERT INTO code_redemptions (code_id, telegram_user_id, username, first_name, package_id, subscription_start, subscription_end) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, String(user.telegramUserId), user.username || null, user.firstName || null, row.package_id, start.toISOString(), storedEnd);
    db.prepare('INSERT INTO user_subscriptions (telegram_user_id, package_id, source_code_id, start_at, end_at) VALUES (?, ?, ?, ?, ?)').run(String(user.telegramUserId), row.package_id, row.id, start.toISOString(), storedEnd);
    const { botUserQueries } = require('./db');
    botUserQueries.upsert(user.telegramUserId, user.username, user.firstName);
    botUserQueries.activate(user.telegramUserId, row.id, end ? end.toISOString() : null);
    db.prepare("UPDATE user_codes SET uses_count=1, status='used', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active' AND uses_count=0").run(row.id);
    audit(db, 'redeem_code', actorId, user.telegramUserId, row.id, 'success', { activationType: row.activation_type, redemptionId: redemption.lastInsertRowid });
    return { ok: true, code: row, activationType: row.activation_type, activationLabel: typeLabel(row.activation_type), start, end, redemptionId: redemption.lastInsertRowid };
  })();
};

const listCodes = ({ search, status, activationType, userId, limit = 20, offset = 0 } = {}) => {
  const db = getDb(); const conditions = []; const params = [];
  if (search) { conditions.push('(uc.code LIKE ? OR uc.name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status && status !== 'all') { conditions.push('uc.status=?'); params.push(status); }
  if (activationType) { conditions.push('uc.activation_type=?'); params.push(activationType); }
  if (userId) { conditions.push('EXISTS (SELECT 1 FROM code_redemptions cr WHERE cr.code_id=uc.id AND cr.telegram_user_id=?)'); params.push(String(userId)); }
  params.push(Math.min(Number(limit) || 20, 10000), Math.max(Number(offset) || 0, 0));
  return db.prepare(`SELECT uc.*, p.slug AS package_slug, p.name AS package_name, cr.telegram_user_id AS redeemed_by, cr.redeemed_at FROM user_codes uc JOIN packages p ON p.id=uc.package_id LEFT JOIN code_redemptions cr ON cr.code_id=uc.id ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY uc.created_at DESC LIMIT ? OFFSET ?`).all(...params);
};
const getCode = (idOrCode) => getDb().prepare('SELECT uc.*, p.slug AS package_slug, p.name AS package_name, cr.telegram_user_id AS redeemed_by, cr.redeemed_at FROM user_codes uc JOIN packages p ON p.id=uc.package_id LEFT JOIN code_redemptions cr ON cr.code_id=uc.id WHERE uc.id=? OR uc.code=?').get(idOrCode, normalizeCode(idOrCode));
const setStatus = (id, status, actorId) => { if (!['active', 'disabled'].includes(status)) throw new Error('حالة غير مسموحة.'); const db = getDb(); const result = db.prepare('UPDATE user_codes SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status != \'used\'').run(status, id); audit(db, status === 'disabled' ? 'disable_code' : 'enable_code', actorId, null, id, result.changes ? 'success' : 'not_found'); return result; };
const deleteCode = (id, actorId) => { const db = getDb(); const result = db.prepare("DELETE FROM user_codes WHERE id=? AND uses_count=0 AND status != 'used'").run(id); audit(db, 'delete_code', actorId, null, id, result.changes ? 'success' : 'blocked_or_not_found'); return result; };
const stats = () => { const db = getDb(); const counts = db.prepare('SELECT status, COUNT(*) count FROM user_codes GROUP BY status').all(); const types = db.prepare('SELECT activation_type, COUNT(*) count FROM user_codes GROUP BY activation_type').all(); const totalRedemptions = db.prepare('SELECT COUNT(*) count FROM code_redemptions').get().count; const recent = db.prepare('SELECT cr.*, uc.code, uc.activation_type, p.name package_name FROM code_redemptions cr JOIN user_codes uc ON uc.id=cr.code_id JOIN packages p ON p.id=cr.package_id ORDER BY cr.redeemed_at DESC LIMIT 10').all(); return { counts, types, totalRedemptions, topPackages: [], recent }; };
const getUserRedemptions = (userId) => getDb().prepare('SELECT cr.*, uc.code, uc.activation_type, p.name package_name FROM code_redemptions cr JOIN user_codes uc ON uc.id=cr.code_id JOIN packages p ON p.id=cr.package_id WHERE cr.telegram_user_id=? ORDER BY cr.redeemed_at DESC').all(String(userId));
const listPackages = () => [];

module.exports = { ACTIVATION_TYPES, OPEN_END, initUserCodesSchema, createCode, createBatch, redeemCode, listCodes, getCode, setStatus, deleteCode, stats, getUserRedemptions, listPackages, normalizeCode, typeLabel };
