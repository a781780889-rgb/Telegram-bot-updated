const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const persistentRoot = process.env.PERSISTENT_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dbPath = process.env.DB_PATH || (persistentRoot ? path.join(persistentRoot, 'accounts.db') : './data/accounts.db');
const dbDir = path.dirname(dbPath);
const backupRoot = process.env.DATA_BACKUP_DIR || path.join(dbDir, 'backups');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;

const createDatabaseBackup = (label = 'runtime') => {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return null;
  fs.mkdirSync(backupRoot, { recursive: true });
  try { db?.pragma('wal_checkpoint(PASSIVE)'); } catch (_) {}
  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '_');
  const backupPath = path.join(backupRoot, `accounts-${safeLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  fs.copyFileSync(dbPath, backupPath);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${backupPath}${suffix}`);
  }
  return backupPath;
};

const createPreMigrationBackup = () => createDatabaseBackup('pre-migration');

// Capture active subscriptions before schema work and verify them afterwards.
// A code update must never turn an active subscription off as a side effect.
const captureActiveSubscriptions = (database) => {
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_users'").get();
    if (!table) return null;
    const columns = database.prepare('PRAGMA table_info(bot_users)').all().map((column) => column.name);
    if (!columns.includes('is_activated')) return null;
    return new Set(database.prepare('SELECT telegram_user_id FROM bot_users WHERE is_activated = 1').all().map((row) => String(row.telegram_user_id)));
  } catch (_) {
    return null;
  }
};

const assertActiveSubscriptionsPreserved = (database, snapshot) => {
  if (!snapshot || snapshot.size === 0) return;
  const missing = [...snapshot].filter((telegramUserId) => {
    const row = database.prepare('SELECT is_activated FROM bot_users WHERE telegram_user_id = ?').get(telegramUserId);
    return !row || row.is_activated !== 1;
  });
  if (missing.length) {
    throw new Error(`Subscription integrity check failed for ${missing.length} active user(s): migration would deactivate subscriptions`);
  }
};

const getDb = () => {
  if (!db) {
    const existingDatabase = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
    if (existingDatabase) {
      try {
        const backupPath = createPreMigrationBackup();
        if (backupPath) logger.info(`Database backup created before schema initialization: ${backupPath}`);
      } catch (error) {
        throw new Error(`Database backup failed; initialization stopped to protect existing data: ${error.message}`);
      }
    }
    db = new Database(dbPath);
    const activeSubscriptionsBeforeMigration = captureActiveSubscriptions(db);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      initializeSchema();
      assertActiveSubscriptionsPreserved(db, activeSubscriptionsBeforeMigration);
    } catch (error) {
      try { db.close(); } catch (_) {}
      db = null;
      throw error;
    }
  }
  return db;
};

// ─── Safe Migration System ─────────────────────────────────────────────────────
//
// All migrations are ADDITIVE ONLY — no DROP TABLE, no DROP COLUMN, no DELETE.
// Each migration runs exactly once and is recorded in schema_migrations.
// This guarantees zero data loss across deployments, updates, or restarts.

/**
 * Check if a column exists in a table using PRAGMA.
 * @param {Database} database
 * @param {string} table
 * @param {string} column
 * @returns {boolean}
 */
const columnExists = (database, table, column) => {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
};

/**
 * Apply all pending schema migrations in order.
 * @param {Database} database
 */
const runMigrations = (database) => {
  // Ensure migration tracking table exists before anything else
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const appliedVersions = new Set(
    database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((r) => r.version)
  );

  /**
   * Run a migration if it hasn't been applied yet.
   */
  const apply = (version, name, fn) => {
    if (appliedVersions.has(version)) return;

    logger.info(`DB Migration v${version}: "${name}" — applying…`);
    database.transaction(() => {
      fn(database);
      database
        .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(version, name);
    })();
    appliedVersions.add(version);
    logger.info(`DB Migration v${version}: applied ✓`);
  };

  // ── v1: Core schema ──────────────────────────────────────────────────────────
  // Uses CREATE TABLE IF NOT EXISTS so existing data is never touched.
  apply(1, 'core_schema', (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           TEXT    NOT NULL,
        phone             TEXT    NOT NULL,
        first_name        TEXT,
        last_name         TEXT,
        username          TEXT,
        telegram_id       TEXT,
        status            TEXT    NOT NULL DEFAULT 'pending',
        session_file      TEXT,
        encrypted_session TEXT,
        error_message     TEXT,
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, phone)
      );

      CREATE TABLE IF NOT EXISTS bot_users (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id TEXT    NOT NULL UNIQUE,
        username         TEXT,
        first_name       TEXT,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen        DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_accounts_user_id   ON accounts(user_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_status    ON accounts(status);
      CREATE INDEX IF NOT EXISTS idx_accounts_phone     ON accounts(phone);
      CREATE INDEX IF NOT EXISTS idx_accounts_created_at ON accounts(created_at);
    `);
  });

  // ── v2: Add last_restored_at column ─────────────────────────────────────────
  apply(2, 'add_last_restored_at', (db) => {
    if (!columnExists(db, 'accounts', 'last_restored_at')) {
      db.exec('ALTER TABLE accounts ADD COLUMN last_restored_at DATETIME');
    }
  });

  // ── v3: Mandatory account activation fields ─────────────────────────────────
  apply(3, 'add_bot_user_activation', (db) => {
    const additions = [
      ['is_activated', "INTEGER NOT NULL DEFAULT 0 CHECK (is_activated IN (0,1))"],
      ['activated_at', 'DATETIME'],
      ['activation_code_id', 'INTEGER'],
      ['activation_expires_at', 'DATETIME'],
      ['deactivated_at', 'DATETIME'],
    ];
    for (const [column, definition] of additions) {
      if (!columnExists(db, 'bot_users', column)) {
        db.exec(`ALTER TABLE bot_users ADD COLUMN ${column} ${definition}`);
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_bot_users_activation ON bot_users(is_activated, activation_expires_at)');
  });

  // ── v4: Explicit activation status ───────────────────────────────────────────
  apply(4, 'add_bot_user_activation_status', (db) => {
    if (!columnExists(db, 'bot_users', 'activation_status')) {
      db.exec("ALTER TABLE bot_users ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'inactive'");
    }
    db.exec("UPDATE bot_users SET activation_status = CASE WHEN is_activated=1 THEN 'active' ELSE 'inactive' END WHERE activation_status IS NULL OR activation_status=''");
  });

  // ── v5: Durable audit trail for sensitive persistence operations ─────────────
  apply(5, 'add_persistence_audit_log', (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS persistence_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        account_id INTEGER,
        action TEXT NOT NULL,
        actor TEXT,
        status TEXT NOT NULL,
        error TEXT,
        metadata TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_persistence_audit_user ON persistence_audit_logs(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_persistence_audit_account ON persistence_audit_logs(account_id, created_at);
    `);
  });

  // ── v6: Prevent duplicate Telegram identities without deleting legacy rows ───
  apply(6, 'unique_telegram_account_identity', (db) => {
    const duplicates = db.prepare(`
      SELECT user_id, telegram_id, COUNT(*) AS count
      FROM accounts
      WHERE telegram_id IS NOT NULL AND telegram_id != ''
      GROUP BY user_id, telegram_id HAVING COUNT(*) > 1
    `).all();
    if (duplicates.length) {
      throw new Error(`Unsafe duplicate Telegram identities detected (${duplicates.length}); migration stopped without deleting data.`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_telegram_unique
      ON accounts(user_id, telegram_id) WHERE telegram_id IS NOT NULL AND telegram_id != ''`);
  });
};

// ─── Schema initializer (called once on first getDb()) ────────────────────────

const initializeSchema = () => {
  runMigrations(db);
  logger.info('Database schema initialised — all migrations applied.');

  // Lazy-import linksDb to avoid circular dependency
  try {
    const { initLinksSchema } = require('./linksDb');
    initLinksSchema();
  } catch (_) {}

  // Lazy-import joinDb to avoid circular dependency (same pattern as linksDb above)
  try {
    const { initJoinSchema } = require('./joinDb');
    initJoinSchema();
  } catch (error) {
    logger.error('Failed to initialize join-to-links schema:', error);
  }

  // Lazy-import publishDb
  try {
    const { initPublishSchema } = require('./publishDb');
    initPublishSchema();
  } catch (error) {
    logger.error('Failed to initialize publishing engine schema:', error);
  }

  // User codes, packages, redemptions, subscriptions, and audit logs.
  try {
    const { initUserCodesSchema } = require('./userCodesDb');
    initUserCodesSchema();
  } catch (error) {
    logger.error('Failed to initialize user-codes schema:', error);
    throw error;
  }
};

// ─── Account Queries ──────────────────────────────────────────────────────────

const safeMetadata = (metadata = {}) => {
  const blocked = /(session|token|secret|password|api[_-]?hash|api[_-]?id)/i;
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !blocked.test(key)));
};

const auditPersistence = (details = {}) => {
  try {
    getDb().prepare(`
      INSERT INTO persistence_audit_logs (user_id, account_id, action, actor, status, error, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(details.userId == null ? null : String(details.userId), details.accountId ?? null,
      details.action || 'UNKNOWN', details.actor == null ? null : String(details.actor),
      details.status || 'success', details.error ? String(details.error).slice(0, 1000) : null,
      JSON.stringify(safeMetadata(details.metadata)));
  } catch (error) {
    logger.warn(`Persistence audit write failed for ${details.action || 'UNKNOWN'}: ${error.message}`);
  }
};

const auditQueries = {
  add: auditPersistence,
  list: ({ userId, accountId, limit = 100 } = {}) => {
    const conditions = []; const params = [];
    if (userId != null) { conditions.push('user_id=?'); params.push(String(userId)); }
    if (accountId != null) { conditions.push('account_id=?'); params.push(accountId); }
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
    return getDb().prepare(`SELECT * FROM persistence_audit_logs ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params);
  },
};

const accountQueries = {
  /**
   * Insert a new account row or reset the status of an existing one.
   *
   * IMPORTANT: Uses INSERT … ON CONFLICT DO UPDATE instead of
   * INSERT OR REPLACE so that existing rows (and their encrypted_session /
   * session_file) are NEVER deleted and re-created with a different id.
   * Only `status`, `error_message`, and `updated_at` are reset when the
   * same (user_id, phone) pair already exists.
   *
   * @param {string} userId
   * @param {string} phone
   * @returns {number} row id
   */
  insert: (userId, phone) => {
    const stmt = getDb().prepare(`
      INSERT INTO accounts (user_id, phone, status, error_message, updated_at)
      VALUES (?, ?, 'connecting', NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, phone) DO UPDATE SET
        status        = 'connecting',
        error_message = NULL,
        updated_at    = CURRENT_TIMESTAMP
      RETURNING id
    `);
    const row = stmt.get(String(userId), String(phone));
    auditPersistence({ userId, accountId: row.id, action: 'UPSERT_ACCOUNT', actor: userId, status: 'success', metadata: { phone: String(phone).slice(-4) } });
    return row.id;
  },

  updateStatus: (id, status, extra = {}) => {
    const fields = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [status];

    const allowedExtras = [
      'error_message',
      'first_name',
      'last_name',
      'username',
      'telegram_id',
      'session_file',
      'encrypted_session',
      'last_restored_at',
    ];

    for (const key of allowedExtras) {
      if (extra[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(extra[key]);
      }
    }

    values.push(id);

    const stmt = getDb().prepare(
      `UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`
    );
    const result = stmt.run(...values);
    auditPersistence({ userId: getDb().prepare('SELECT user_id FROM accounts WHERE id=?').get(id)?.user_id, accountId: id, action: status === 'connected' ? 'RECONNECT' : 'UPDATE_ACCOUNT_STATUS', actor: null, status: result.changes ? 'success' : 'not_found', error: result.changes ? null : 'account_not_found', metadata: { accountStatus: status } });
    return result;
  },

  getByUserIdAndPhone: (userId, phone) => {
    return getDb()
      .prepare('SELECT * FROM accounts WHERE user_id = ? AND phone = ?')
      .get(userId, phone);
  },

  getById: (id) => {
    return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  },

  getAllByUserId: (userId) => {
    return getDb()
      .prepare(
        'SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at DESC'
      )
      .all(userId);
  },

  deleteById: (id, userId) => {
    const result = getDb().prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(id, String(userId));
    auditPersistence({ userId, accountId: id, action: 'DELETE_ACCOUNT', actor: userId, status: result.changes ? 'success' : 'not_found', error: result.changes ? null : 'account_not_found' });
    return result;
  },

  getStatsByUserId: (userId) => {
    const database = getDb();

    const total = database
      .prepare('SELECT COUNT(*) as count FROM accounts WHERE user_id = ?')
      .get(userId)?.count || 0;

    const connected = database
      .prepare(
        "SELECT COUNT(*) as count FROM accounts WHERE user_id = ? AND status = 'connected'"
      )
      .get(userId)?.count || 0;

    const disconnected = database
      .prepare(
        "SELECT COUNT(*) as count FROM accounts WHERE user_id = ? AND status IN ('disconnected', 'error', 'banned')"
      )
      .get(userId)?.count || 0;

    const needsRelogin = database
      .prepare(
        "SELECT COUNT(*) as count FROM accounts WHERE user_id = ? AND status IN ('needs_password', 'otp_sent', 'error', 'disconnected')"
      )
      .get(userId)?.count || 0;

    const addedToday = database
      .prepare(
        "SELECT COUNT(*) as count FROM accounts WHERE user_id = ? AND DATE(created_at) = DATE('now')"
      )
      .get(userId)?.count || 0;

    return { total, connected, disconnected, needsRelogin, addedToday };
  },
};

// ─── Bot User Queries ─────────────────────────────────────────────────────────

const botUserQueries = {
  getByTelegramUserId: (telegramUserId) => getDb().prepare('SELECT * FROM bot_users WHERE telegram_user_id=?').get(String(telegramUserId)) || null,

  upsert: (telegramUserId, username, firstName) => {
    const stmt = getDb().prepare(`
      INSERT INTO bot_users (telegram_user_id, username, first_name, last_seen)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        username   = excluded.username,
        first_name = excluded.first_name,
        last_seen  = CURRENT_TIMESTAMP
    `);
    const result = stmt.run(String(telegramUserId), username || null, firstName || null);
    auditPersistence({ userId: telegramUserId, action: 'UPSERT_USER', actor: telegramUserId, status: 'success', metadata: { username: username || null } });
    return result;
  },

  getActivationStatus: (telegramUserId) => {
    const row = getDb().prepare(`
      SELECT is_activated, activated_at, activation_code_id, activation_expires_at, deactivated_at
      FROM bot_users WHERE telegram_user_id = ?
    `).get(String(telegramUserId));
    if (!row || row.is_activated !== 1) return { activated: false, reason: 'not_activated', row };
    if (row.activation_expires_at && new Date(row.activation_expires_at).getTime() <= Date.now()) {
      getDb().prepare(`UPDATE bot_users SET is_activated=0, activation_status='expired', deactivated_at=CURRENT_TIMESTAMP WHERE telegram_user_id=?`).run(String(telegramUserId));
      auditPersistence({ userId: telegramUserId, action: 'EXPIRE_ACTIVATION', actor: 'system', status: 'success' });
      return { activated: false, reason: 'expired', row: { ...row, is_activated: 0, activation_status: 'expired' } };
    }
    return { activated: true, reason: 'active', row: { ...row, activation_status: 'active' } };
  },

  activate: (telegramUserId, codeId, expiresAt) => {
    const result = getDb().prepare(`
      INSERT INTO bot_users (telegram_user_id, is_activated, activation_status, activated_at, activation_code_id, activation_expires_at, last_seen)
      VALUES (?, 1, 'active', CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        is_activated=1, activation_status='active', activated_at=CURRENT_TIMESTAMP, activation_code_id=excluded.activation_code_id,
        activation_expires_at=excluded.activation_expires_at, deactivated_at=NULL, last_seen=CURRENT_TIMESTAMP
    `).run(String(telegramUserId), codeId, expiresAt);
    auditPersistence({ userId: telegramUserId, action: 'ACTIVATE_USER', actor: telegramUserId, status: 'success', metadata: { codeId, hasExpiry: Boolean(expiresAt) } });
    return result;
  },

  deactivate: (telegramUserId) => {
    const result = getDb().prepare(`UPDATE bot_users SET is_activated=0, activation_status='inactive', deactivated_at=CURRENT_TIMESTAMP WHERE telegram_user_id=?`).run(String(telegramUserId));
    auditPersistence({ userId: telegramUserId, action: 'DEACTIVATE_USER', actor: telegramUserId, status: result.changes ? 'success' : 'not_found' });
    return result;
  },

  listActivationUsers: (activated) => getDb().prepare(`
    SELECT telegram_user_id, username, first_name, is_activated, activated_at, activation_expires_at, last_seen
    FROM bot_users WHERE is_activated = ? ORDER BY last_seen DESC LIMIT 100
  `).all(activated ? 1 : 0),

  setActivated: (telegramUserId, activated) => getDb().prepare(`
    UPDATE bot_users SET is_activated=?, activation_status=?, deactivated_at=? WHERE telegram_user_id=?
  `).run(activated ? 1 : 0, activated ? 'active' : 'inactive', activated ? null : new Date().toISOString(), String(telegramUserId)),
};

// ─── Restore-specific Queries ─────────────────────────────────────────────────

/**
 * Return all accounts that have a saved encrypted_session (DB backup).
 * These are candidates for automatic restoration on startup.
 *
 * Excludes accounts that are still in the middle of an OTP / password flow,
 * since those have no valid session to restore.
 *
 * @returns {object[]}
 */
const getAllAccountsWithSession = () => {
  return getDb()
    .prepare(
      `SELECT * FROM accounts
       WHERE encrypted_session IS NOT NULL
         AND encrypted_session != ''
         AND status NOT IN ('pending', 'connecting', 'otp_sent', 'needs_password')
       ORDER BY created_at ASC`
    )
    .all();
};

/**
 * Return all Telegram user IDs that have ever used the bot.
 * Used to send the startup restoration report to every known user.
 *
 * @returns {string[]}
 */
const getBotUserIds = () => {
  return getDb()
    .prepare(
      'SELECT telegram_user_id FROM bot_users ORDER BY last_seen DESC'
    )
    .all()
    .map((r) => r.telegram_user_id);
};

module.exports = {
  getDb,
  accountQueries,
  botUserQueries,
  getAllAccountsWithSession,
  getBotUserIds,
  auditQueries,
  createPreMigrationBackup,
  createDatabaseBackup,
};
