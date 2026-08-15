const crypto = require('crypto');
const { getDb } = require('./db');
const logger = require('../utils/logger');

const DEFAULT_PACKAGES = [
  ['free', 'Free'],
  ['basic', 'Basic'],
  ['premium', 'Premium'],
  ['vip', 'VIP'],
  ['enterprise', 'Enterprise'],
];

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
      package_id INTEGER NOT NULL,
      duration_days INTEGER NOT NULL CHECK (duration_days > 0),
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
    CREATE INDEX IF NOT EXISTS idx_user_codes_assigned ON user_codes(assigned_telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_user_codes_package ON user_codes(package_id);
    CREATE INDEX IF NOT EXISTS idx_redemptions_user ON code_redemptions(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_redemptions_redeemed_at ON code_redemptions(redeemed_at);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON user_subscriptions(telegram_user_id, status, end_at);
    CREATE INDEX IF NOT EXISTS idx_code_audit_created_at ON code_audit_logs(created_at);
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO packages (slug, name) VALUES (?, ?)');
  const seed = db.transaction(() => DEFAULT_PACKAGES.forEach(([slug, name]) => insert.run(slug, name)));
  seed();
};

const normalizeCode = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');
const generateCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (length) => {
    const bytes = crypto.randomBytes(length);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  };
  return `TG-${part(4)}-${part(4)}-${part(4)}`;
};

const audit = (db, action, actorId, targetId, codeId, result, metadata = {}) => {
  db.prepare(`INSERT INTO code_audit_logs
    (action, actor_telegram_user_id, target_telegram_user_id, code_id, result, metadata)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(action, actorId ? String(actorId) : null, targetId ? String(targetId) : null, codeId || null, result, JSON.stringify(metadata));
};

const getPackage = (db, packageRef) => {
  if (!packageRef) return null;
  return db.prepare('SELECT * FROM packages WHERE (id = ? OR slug = ? OR name = ?) AND is_active = 1').get(packageRef, String(packageRef), String(packageRef));
};

const createCode = (input, actorId) => {
  const db = getDb();
  const pkg = getPackage(db, input.package);
  if (!pkg) throw new Error('الباقة غير موجودة أو غير فعالة.');
  const code = normalizeCode(input.code) || generateCode();
  const maxUses = Number(input.maxUses || (input.singleUse ? 1 : 1));
  const durationDays = Number(input.durationDays);
  if (!/^TG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw new Error('الكود يجب أن يطابق الصيغة الآمنة TG-XXXX-XXXX-XXXX.');
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 36500) throw new Error('مدة الاشتراك غير صحيحة.');
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000000) throw new Error('عدد الاستخدامات غير صحيح.');
  const row = db.prepare(`INSERT INTO user_codes
    (name, code, code_type, package_id, duration_days, expires_at, max_uses, single_use, assigned_telegram_user_id, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.name || null, code, input.type || 'subscription', pkg.id, durationDays, input.expiresAt || null, maxUses, input.singleUse ? 1 : 0, input.assignedTelegramUserId || null, input.status === 'disabled' ? 'disabled' : 'active', actorId ? String(actorId) : null);
  audit(db, 'create_code', actorId, input.assignedTelegramUserId, row.lastInsertRowid, 'success', { code, package: pkg.slug });
  return db.prepare('SELECT uc.*, p.slug AS package_slug, p.name AS package_name FROM user_codes uc JOIN packages p ON p.id=uc.package_id WHERE uc.id=?').get(row.lastInsertRowid);
};

const createBatch = (input, actorId) => {
  const db = getDb();
  const count = Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('عدد الأكواد يجب أن يكون بين 1 و10000.');
  const codes = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i += 1) codes.push(createCode({ ...input, code: null }, actorId));
  });
  tx();
  return codes;
};

const redeemCode = (rawCode, user, actorId = user.telegramUserId) => {
  const db = getDb();
  const code = normalizeCode(rawCode);
  if (!code || code.length > 64) return { ok: false, reason: 'invalid' };
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT uc.*, p.slug AS package_slug, p.name AS package_name
      FROM user_codes uc JOIN packages p ON p.id=uc.package_id WHERE uc.code=?`).get(code);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'disabled') return { ok: false, reason: 'disabled' };
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      db.prepare("UPDATE user_codes SET status='expired', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").run(row.id);
      audit(db, 'redeem_code', actorId, user.telegramUserId, row.id, 'expired');
      return { ok: false, reason: 'expired' };
    }
    if (row.uses_count >= row.max_uses || row.status === 'used') return { ok: false, reason: 'limit' };
    if (row.assigned_telegram_user_id && String(row.assigned_telegram_user_id) !== String(user.telegramUserId)) return { ok: false, reason: 'assigned' };
    const duplicate = db.prepare('SELECT id FROM code_redemptions WHERE code_id=? AND telegram_user_id=?').get(row.id, String(user.telegramUserId));
    if (duplicate) return { ok: false, reason: 'duplicate' };
    const start = new Date();
    const end = new Date(start.getTime() + row.duration_days * 86400000);
    const redemption = db.prepare(`INSERT INTO code_redemptions
      (code_id, telegram_user_id, username, first_name, package_id, subscription_start, subscription_end)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.id, String(user.telegramUserId), user.username || null, user.firstName || null, row.package_id, start.toISOString(), end.toISOString());
    db.prepare(`INSERT INTO user_subscriptions (telegram_user_id, package_id, source_code_id, start_at, end_at)
      VALUES (?, ?, ?, ?, ?)`).run(String(user.telegramUserId), row.package_id, row.id, start.toISOString(), end.toISOString());
    // Activation is committed in the same SQLite transaction as redemption.
    const { botUserQueries } = require('./db');
    botUserQueries.upsert(user.telegramUserId, user.username, user.firstName);
    botUserQueries.activate(user.telegramUserId, row.id, end.toISOString());
    const nextUses = row.uses_count + 1;
    db.prepare(`UPDATE user_codes SET uses_count=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active' AND uses_count < max_uses`)
      .run(nextUses, nextUses >= row.max_uses ? 'used' : 'active', row.id);
    audit(db, 'redeem_code', actorId, user.telegramUserId, row.id, 'success', { redemptionId: redemption.lastInsertRowid });
    return { ok: true, code: row, start, end, redemptionId: redemption.lastInsertRowid };
  });
  return tx();
};

const listCodes = ({ search, status, userId, limit = 20, offset = 0 } = {}) => {
  const db = getDb();
  const conditions = []; const params = [];
  if (search) { conditions.push('(uc.code LIKE ? OR uc.name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status && status !== 'all') { conditions.push('uc.status=?'); params.push(status); }
  if (userId) { conditions.push('EXISTS (SELECT 1 FROM code_redemptions cr WHERE cr.code_id=uc.id AND cr.telegram_user_id=?)'); params.push(String(userId)); }
  params.push(Math.min(Number(limit) || 20, 100), Math.max(Number(offset) || 0, 0));
  return db.prepare(`SELECT uc.*, p.slug AS package_slug, p.name AS package_name FROM user_codes uc JOIN packages p ON p.id=uc.package_id ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY uc.created_at DESC LIMIT ? OFFSET ?`).all(...params);
};

const getCode = (idOrCode) => getDb().prepare(`SELECT uc.*, p.slug AS package_slug, p.name AS package_name FROM user_codes uc JOIN packages p ON p.id=uc.package_id WHERE uc.id=? OR uc.code=?`).get(idOrCode, normalizeCode(idOrCode));
const setStatus = (id, status, actorId) => { const db = getDb(); const result = db.prepare("UPDATE user_codes SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, id); audit(db, `${status === 'disabled' ? 'disable' : 'enable'}_code`, actorId, null, id, result.changes ? 'success' : 'not_found'); return result; };
const deleteCode = (id, actorId) => { const db = getDb(); const result = db.prepare('DELETE FROM user_codes WHERE id=? AND uses_count=0').run(id); audit(db, 'delete_code', actorId, null, id, result.changes ? 'success' : 'blocked_or_not_found'); return result; };
const stats = () => { const db = getDb(); const counts = db.prepare('SELECT status, COUNT(*) count FROM user_codes GROUP BY status').all(); const totalRedemptions = db.prepare('SELECT COUNT(*) count FROM code_redemptions').get().count; const topPackages = db.prepare('SELECT p.name, COUNT(cr.id) count FROM code_redemptions cr JOIN packages p ON p.id=cr.package_id GROUP BY cr.package_id ORDER BY count DESC LIMIT 5').all(); const recent = db.prepare('SELECT cr.*, uc.code, p.name package_name FROM code_redemptions cr JOIN user_codes uc ON uc.id=cr.code_id JOIN packages p ON p.id=cr.package_id ORDER BY cr.redeemed_at DESC LIMIT 10').all(); return { counts, totalRedemptions, topPackages, recent }; };
const getUserRedemptions = (userId) => getDb().prepare('SELECT cr.*, uc.code, p.name package_name FROM code_redemptions cr JOIN user_codes uc ON uc.id=cr.code_id JOIN packages p ON p.id=cr.package_id WHERE cr.telegram_user_id=? ORDER BY cr.redeemed_at DESC').all(String(userId));
const listPackages = () => getDb().prepare('SELECT * FROM packages WHERE is_active=1 ORDER BY id').all();

module.exports = { initUserCodesSchema, createCode, createBatch, redeemCode, listCodes, getCode, setStatus, deleteCode, stats, getUserRedemptions, listPackages, normalizeCode };
