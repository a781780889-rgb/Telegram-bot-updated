const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const dbPath = process.env.DB_PATH || './data/accounts.db';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;

const getDb = () => {
  if (!db) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeSchema();
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
};

// ─── Account Queries ──────────────────────────────────────────────────────────

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
    const row = stmt.get(userId, phone);
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
    return stmt.run(...values);
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
    return getDb()
      .prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?')
      .run(id, userId);
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
  upsert: (telegramUserId, username, firstName) => {
    const stmt = getDb().prepare(`
      INSERT INTO bot_users (telegram_user_id, username, first_name, last_seen)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        username   = excluded.username,
        first_name = excluded.first_name,
        last_seen  = CURRENT_TIMESTAMP
    `);
    return stmt.run(String(telegramUserId), username || null, firstName || null);
  },
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
};
