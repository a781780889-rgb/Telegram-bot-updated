/**
 * Links Database Module
 *
 * Provides the schema and all queries for the links feature:
 *   - links_operations  : one row per search operation
 *   - links_found       : every extracted URL
 *   - links_settings    : per-user search preferences
 *
 * Shares the SQLite file that db.js owns; imported lazily from db.js
 * during initializeSchema() to avoid a circular-require issue.
 */

const { getDb } = require('./db');
const logger = require('../utils/logger');

// ─── Schema ───────────────────────────────────────────────────────────────────

const initLinksSchema = () => {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS links_operations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           TEXT    NOT NULL,
      name              TEXT    NOT NULL DEFAULT 'بحث جديد',
      status            TEXT    NOT NULL DEFAULT 'pending',
      account_mode      TEXT,
      selected_account_ids TEXT,
      link_type         TEXT,
      period            TEXT,
      custom_start      TEXT,
      custom_end        TEXT,
      search_depth      TEXT,
      accounts_used     INTEGER DEFAULT 0,
      chats_scanned     INTEGER DEFAULT 0,
      messages_scanned  INTEGER DEFAULT 0,
      telegram_links    INTEGER DEFAULT 0,
      whatsapp_links    INTEGER DEFAULT 0,
      total_links       INTEGER DEFAULT 0,
      duplicates_removed INTEGER DEFAULT 0,
      saved_links       INTEGER DEFAULT 0,
      file_size_bytes   INTEGER DEFAULT 0,
      output_dir        TEXT,
      error_message     TEXT,
      started_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at       DATETIME,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS links_found (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT    NOT NULL,
      operation_id INTEGER NOT NULL,
      url          TEXT    NOT NULL,
      url_hash     TEXT    NOT NULL,
      link_type    TEXT    NOT NULL,
      account_id   INTEGER,
      dialog_id    TEXT,
      message_id   TEXT,
      found_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (operation_id) REFERENCES links_operations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS links_settings (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            TEXT    NOT NULL UNIQUE,
      remove_duplicates  INTEGER DEFAULT 1,
      save_history       INTEGER DEFAULT 1,
      auto_stop_on_error INTEGER DEFAULT 0,
      retry_on_fail      INTEGER DEFAULT 1,
      output_dir         TEXT    DEFAULT './data/links_output',
      updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_links_ops_user_id
      ON links_operations(user_id);

    CREATE INDEX IF NOT EXISTS idx_links_ops_status
      ON links_operations(status);

    CREATE INDEX IF NOT EXISTS idx_links_found_user_id
      ON links_found(user_id);

    CREATE INDEX IF NOT EXISTS idx_links_found_operation_id
      ON links_found(operation_id);

    CREATE INDEX IF NOT EXISTS idx_links_found_user_hash
      ON links_found(user_id, url_hash);
  `);

  logger.info('Links database schema initialized');
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Build a human-readable operation name from the wizard state.
 * @param {object} wizard
 * @returns {string}
 */
const _buildOperationName = (wizard) => {
  const typeMap   = { telegram: 'تيليجرام', whatsapp: 'واتساب', both: 'تيليجرام + واتساب' };
  const periodMap = { week: 'أسبوع', month: 'شهر', '3months': '3 أشهر', year: 'سنة', custom: 'مخصص' };
  const type   = typeMap[wizard.linkType]   || wizard.linkType   || 'روابط';
  const period = periodMap[wizard.period]   || wizard.period     || '';
  const date   = new Date().toLocaleDateString('ar-EG');
  return `بحث ${type}${period ? ' - ' + period : ''} - ${date}`;
};

const DEFAULT_SETTINGS = {
  remove_duplicates:  1,
  save_history:       1,
  auto_stop_on_error: 0,
  retry_on_fail:      1,
  output_dir:         './data/links_output',
};

const ALLOWED_SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

// ─── linksOperationQueries ────────────────────────────────────────────────────

const linksOperationQueries = {
  /**
   * Create a new operation record.
   * @param {string} userId
   * @param {object} wizard  – wizard state from linksWizardState
   * @returns {number}        new operation ID
   */
  create: (userId, wizard) => {
    const name = _buildOperationName(wizard);
    const stmt = getDb().prepare(`
      INSERT INTO links_operations
        (user_id, name, status,
         account_mode, selected_account_ids,
         link_type, period, custom_start, custom_end, search_depth)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      String(userId),
      name,
      wizard.accountMode || 'all',
      JSON.stringify(wizard.selectedAccountIds || []),
      wizard.linkType    || 'both',
      wizard.period      || 'month',
      wizard.customStart || null,
      wizard.customEnd   || null,
      wizard.searchDepth || 'medium',
    );
    return result.lastInsertRowid;
  },

  /**
   * Fetch a single operation by its ID.
   * @param {number} operationId
   * @returns {object|null}
   */
  getById: (operationId) =>
    getDb()
      .prepare('SELECT * FROM links_operations WHERE id = ?')
      .get(operationId) ?? null,

  /**
   * All operations for a user, newest first.
   * @param {string} userId
   * @returns {object[]}
   */
  getAllByUserId: (userId) =>
    getDb()
      .prepare('SELECT * FROM links_operations WHERE user_id = ? ORDER BY created_at DESC')
      .all(String(userId)),

  /**
   * Completed / stopped operations for a user (have output files).
   * @param {string} userId
   * @returns {object[]}
   */
  getCompletedByUserId: (userId) =>
    getDb()
      .prepare(`
        SELECT * FROM links_operations
        WHERE user_id = ?
          AND status IN ('completed', 'stopped')
        ORDER BY created_at DESC
      `)
      .all(String(userId)),

  /**
   * Persist mid-search progress counters.
   * @param {number} operationId
   * @param {object} updates  – any subset of the allowed columns
   */
  updateProgress: (operationId, updates) => {
    const ALLOWED = [
      'status', 'accounts_used', 'chats_scanned', 'messages_scanned',
      'telegram_links', 'whatsapp_links', 'total_links',
      'duplicates_removed', 'saved_links', 'file_size_bytes',
      'output_dir', 'error_message',
    ];
    const fields = [];
    const values = [];
    for (const key of ALLOWED) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    }
    if (!fields.length) return;
    values.push(operationId);
    getDb()
      .prepare(`UPDATE links_operations SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
  },

  /**
   * Mark the operation finished and stamp finished_at.
   * @param {number} operationId
   * @param {string} status  – 'completed' | 'stopped' | 'error'
   */
  finish: (operationId, status) => {
    getDb()
      .prepare(`
        UPDATE links_operations
        SET status = ?, finished_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(status, operationId);
  },

  /**
   * Rename an operation.
   * @param {number} operationId
   * @param {string} userId
   * @param {string} newName
   */
  rename: (operationId, userId, newName) => {
    getDb()
      .prepare(`
        UPDATE links_operations SET name = ?
        WHERE id = ? AND user_id = ?
      `)
      .run(newName, operationId, String(userId));
  },

  /**
   * Delete a single operation and all its found links.
   * @param {number} operationId
   * @param {string} userId
   */
  deleteById: (operationId, userId) => {
    const db = getDb();
    db.prepare('DELETE FROM links_found       WHERE operation_id = ?').run(operationId);
    db.prepare('DELETE FROM links_operations  WHERE id = ? AND user_id = ?').run(operationId, String(userId));
  },

  /**
   * Delete every operation (and their found links) for a user.
   * Used by the "clean all files" action.
   * @param {string} userId
   */
  deleteAllByUserId: (userId) => {
    const db = getDb();
    const ops = db
      .prepare('SELECT id FROM links_operations WHERE user_id = ?')
      .all(String(userId));

    const delFound = db.prepare('DELETE FROM links_found WHERE operation_id = ?');
    const delOp    = db.prepare('DELETE FROM links_operations WHERE id = ?');

    const txn = db.transaction(() => {
      for (const { id } of ops) {
        delFound.run(id);
        delOp.run(id);
      }
    });
    txn();
  },
};

// ─── linksFoundQueries ────────────────────────────────────────────────────────

const linksFoundQueries = {
  /**
   * Persist one found link (ignores duplicate url_hash per operation).
   */
  insert: (userId, operationId, url, urlHash, linkType, accountId, dialogId, messageId) => {
    getDb()
      .prepare(`
        INSERT OR IGNORE INTO links_found
          (user_id, operation_id, url, url_hash, link_type,
           account_id, dialog_id, message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        String(userId), operationId, url, urlHash, linkType,
        accountId, String(dialogId ?? ''), String(messageId ?? ''),
      );
  },

  /**
   * Cross-session duplicate check: has this URL hash ever been seen for this user?
   * @param {string} userId
   * @param {string} urlHash
   * @returns {boolean}
   */
  existsForUser: (userId, urlHash) =>
    !!getDb()
      .prepare('SELECT 1 FROM links_found WHERE user_id = ? AND url_hash = ? LIMIT 1')
      .get(String(userId), urlHash),

  /**
   * All found links for a specific operation, in insertion order.
   * @param {number} operationId
   * @returns {object[]}
   */
  getByOperationId: (operationId) =>
    getDb()
      .prepare('SELECT * FROM links_found WHERE operation_id = ? ORDER BY found_at ASC')
      .all(operationId),
};

// ─── linksStatsQueries ────────────────────────────────────────────────────────

const linksStatsQueries = {
  /**
   * Aggregated statistics for the statistics screen.
   * Field names match what linksStatisticsMessage() expects.
   * @param {string} userId
   * @returns {object}
   */
  getByUserId: (userId) => {
    const db = getDb();
    const uid = String(userId);

    const row = db.prepare(`
      SELECT
        COUNT(*)                                              AS total_operations,
        COALESCE(SUM(total_links), 0)                        AS total_links,
        COALESCE(SUM(telegram_links), 0)                     AS total_telegram,
        COALESCE(SUM(whatsapp_links), 0)                     AS total_whatsapp,
        COALESCE(SUM(duplicates_removed), 0)                 AS total_duplicates,
        COALESCE(SUM(accounts_used), 0)                      AS accounts_used,
        COALESCE(SUM(messages_scanned), 0)                   AS total_messages,
        MAX(started_at)                                      AS last_search,
        CASE
          WHEN SUM(
            CAST((julianday(COALESCE(finished_at, CURRENT_TIMESTAMP))
                  - julianday(started_at)) * 86400 AS INTEGER)
          ) > 0
          THEN ROUND(
            CAST(COALESCE(SUM(messages_scanned), 0) AS REAL) /
            SUM(
              CAST((julianday(COALESCE(finished_at, CURRENT_TIMESTAMP))
                    - julianday(started_at)) * 86400 AS INTEGER)
            )
          )
          ELSE NULL
        END AS avg_speed
      FROM links_operations
      WHERE user_id = ?
    `).get(uid);

    return {
      total_operations: row?.total_operations  ?? 0,
      total_links:      row?.total_links       ?? 0,
      total_telegram:   row?.total_telegram    ?? 0,
      total_whatsapp:   row?.total_whatsapp    ?? 0,
      total_duplicates: row?.total_duplicates  ?? 0,
      accounts_used:    row?.accounts_used     ?? 0,
      last_search:      row?.last_search       ?? null,
      avg_speed:        row?.avg_speed         ?? null,
    };
  },
};

// ─── linksSettingsQueries ─────────────────────────────────────────────────────

const linksSettingsQueries = {
  /**
   * Return settings for a user, inserting defaults on first call.
   * @param {string} userId
   * @returns {object}
   */
  get: (userId) => {
    const db  = getDb();
    const uid = String(userId);

    let settings = db
      .prepare('SELECT * FROM links_settings WHERE user_id = ?')
      .get(uid);

    if (!settings) {
      db.prepare(`
        INSERT OR IGNORE INTO links_settings
          (user_id, remove_duplicates, save_history,
           auto_stop_on_error, retry_on_fail, output_dir)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        uid,
        DEFAULT_SETTINGS.remove_duplicates,
        DEFAULT_SETTINGS.save_history,
        DEFAULT_SETTINGS.auto_stop_on_error,
        DEFAULT_SETTINGS.retry_on_fail,
        DEFAULT_SETTINGS.output_dir,
      );

      settings = db
        .prepare('SELECT * FROM links_settings WHERE user_id = ?')
        .get(uid);
    }

    // Fallback — should never happen after the INSERT above
    return settings ?? { ...DEFAULT_SETTINGS, user_id: uid };
  },

  /**
   * Update a single setting key for a user.
   * @param {string} userId
   * @param {string} key
   * @param {*}      value
   */
  upsert: (userId, key, value) => {
    if (!ALLOWED_SETTINGS_KEYS.includes(key)) {
      logger.warn(`linksSettingsQueries.upsert: unknown key "${key}" – skipped`);
      return;
    }
    const uid = String(userId);
    // Ensure the row exists before updating
    linksSettingsQueries.get(uid);

    getDb()
      .prepare(`
        UPDATE links_settings
        SET ${key} = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `)
      .run(value, uid);
  },
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initLinksSchema,
  linksOperationQueries,
  linksFoundQueries,
  linksStatsQueries,
  linksSettingsQueries,
};
