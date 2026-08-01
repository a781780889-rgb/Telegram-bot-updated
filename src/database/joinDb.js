/**
 * Join-to-Links Database Module
 *
 * Provides the schema and all queries for the "الانضمام للروابط" feature,
 * AND doubles as the project's CENTRAL DATABASE for all Telegram
 * links/groups/folders (نظام إدارة قاعدة البيانات المركزية):
 *
 *   - join_groups    : CENTRAL registry of every Telegram group ever seen,
 *                      from ANY source (search / join / folders / manual add).
 *                      Dedup key = (user_id, telegram_id) — NEVER the raw link,
 *                      since one group can have many links.
 *   - join_links     : queued/processed links submitted by the user (join queue).
 *                      Each link carries an independent status — see
 *                      JOIN_LINK_STATUSES below for the full list.
 *   - join_accounts  : per-account join settings/state/counters (enabled,
 *                      limits, rolling hour/day/session counters, ban info).
 *   - join_settings  : per-user speed / interval / limits / retry / protection
 *                      settings (the "لوحة التحكم" for the join engine).
 *   - join_logs      : full operations log for the Logs + performance screens.
 *   - tg_folders       : Telegram folders created to organize central groups
 *   - tg_folder_groups : which central group belongs to which folder (1:1 — a
 *                        group can only ever live in ONE folder, enforced by
 *                        UNIQUE(user_id, group_id))
 *   - tg_folder_settings : per-user folder configuration (group_per_folder, etc.)
 *
 * ── Queueing model ─────────────────────────────────────────────────────────
 * There is no separate "queue" table. A link IS a queue entry: its own row
 * (status + assigned_account_id + next_retry_at) fully describes where it
 * sits. Each account's independent queue is simply:
 *
 *   SELECT * FROM join_links
 *   WHERE assigned_account_id = <account> AND status IN ('pending','failed_flood')
 *     AND (next_retry_at IS NULL OR next_retry_at <= now)
 *   ORDER BY id ASC
 *
 * This keeps the queue durable across restarts for free (no in-memory state
 * to lose) and keeps "process links in order, one at a time, per account"
 * a property of the SQL itself rather than something callers have to get
 * right every time.
 *
 * Shares the SQLite file that db.js owns; imported lazily from db.js
 * during initializeSchema() to avoid a circular-require issue — same
 * pattern as linksDb.js.
 */

const { getDb } = require('./db');
const logger = require('../utils/logger');

// ─── Safe migration helper (additive-only, same pattern as db.js) ────────────

const columnExists = (database, table, column) => {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
};

const addColumnIfMissing = (database, table, column, ddl) => {
  if (!columnExists(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
};

// ─── Timestamp helpers ─────────────────────────────────────────────────────
//
// SQLite's CURRENT_TIMESTAMP is UTC, formatted 'YYYY-MM-DD HH:MM:SS' (no
// 'T', no 'Z', no milliseconds). Any value we want to compare against it in
// SQL (`col <= CURRENT_TIMESTAMP`) MUST use that exact format — a plain
// `Date.toISOString()` ("...T...Z") sorts as text incorrectly against it
// (the literal 'T' character is always > the space CURRENT_TIMESTAMP uses
// at the same position, so the comparison silently never resolves the way
// you'd expect). These two helpers are the only sanctioned way to move a
// timestamp between JS and a column that gets compared against
// CURRENT_TIMESTAMP in SQL.

/** JS Date → SQLite CURRENT_TIMESTAMP-compatible string (UTC). */
const toSqliteUtc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

/** SQLite timestamp string (as produced above or by CURRENT_TIMESTAMP) → JS Date (UTC). */
const fromSqliteUtc = (value) => (value ? new Date(`${value.replace(' ', 'T')}Z`) : null);

// ─── Status vocabularies (single source of truth — UI reads these) ───────────

/**
 * The full set of independent link statuses (بند ثامناً في المواصفات).
 * Kept as stable English keys in the DB; Arabic labels live here so every
 * screen (statistics / logs / list) renders them identically.
 */
const JOIN_LINK_STATUSES = {
  pending: '🆕 جديد',
  in_progress: '⏳ قيد التنفيذ',
  joined: '✅ تم الانضمام',
  skipped: '⏭️ تم التخطي (مكرر)',
  invalid: '🚫 رابط غير صالح',
  expired: '⌛ منتهي الصلاحية',
  private: '🔒 خاص / غير متاح',
  needs_approval: '🕓 بانتظار الموافقة',
  rejected: '❌ مرفوض',
  failed_flood: '🌊 متوقف مؤقتًا (Flood)',
  failed_privacy: '🔐 فشل بسبب الخصوصية',
  failed: '❌ فشل',
  deleted: '🗑️ محذوف',
};

/** Statuses considered a permanent, non-retryable dead end for a link. */
const TERMINAL_FAILURE_STATUSES = [
  'invalid', 'expired', 'private', 'rejected', 'failed_privacy', 'failed',
];

/** Statuses that still occupy an account's queue (claimable / resumable). */
const OPEN_STATUSES = ['pending', 'failed_flood'];

// ─── Schema ───────────────────────────────────────────────────────────────────

const initJoinSchema = () => {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS join_groups (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT    NOT NULL,
      telegram_id    TEXT    NOT NULL,
      title          TEXT,
      joined_by_account_id INTEGER,
      first_link     TEXT,
      status         TEXT    NOT NULL DEFAULT 'joined',
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, telegram_id)
    );

    CREATE TABLE IF NOT EXISTS join_links (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT    NOT NULL,
      url            TEXT    NOT NULL,
      url_type       TEXT    NOT NULL DEFAULT 'public',
      telegram_id    TEXT,
      status         TEXT    NOT NULL DEFAULT 'pending',
      assigned_account_id INTEGER,
      skip_reason    TEXT,
      retry_count    INTEGER NOT NULL DEFAULT 0,
      next_retry_at  DATETIME,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at   DATETIME
    );

    CREATE TABLE IF NOT EXISTS join_accounts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             TEXT    NOT NULL,
      account_id          INTEGER NOT NULL,
      enabled             INTEGER NOT NULL DEFAULT 1,
      state               TEXT    NOT NULL DEFAULT 'idle',
      joined_count        INTEGER NOT NULL DEFAULT 0,
      max_joins           INTEGER NOT NULL DEFAULT 50,
      batch_size          INTEGER NOT NULL DEFAULT 3,
      join_delay_seconds  INTEGER NOT NULL DEFAULT 30,
      rest_seconds        INTEGER NOT NULL DEFAULT 600,
      batch_progress      INTEGER NOT NULL DEFAULT 0,
      cooldown_until       DATETIME,
      ban_reason          TEXT,
      last_joined_at      DATETIME,
      updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS join_settings (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            TEXT    NOT NULL UNIQUE,
      batch_size         INTEGER NOT NULL DEFAULT 3,
      join_delay_seconds INTEGER NOT NULL DEFAULT 30,
      rest_seconds       INTEGER NOT NULL DEFAULT 600,
      max_joins_per_account INTEGER NOT NULL DEFAULT 50,
      auto_distribute    INTEGER NOT NULL DEFAULT 1,
      updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS join_logs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT    NOT NULL,
      account_id     INTEGER,
      link           TEXT,
      group_title    TEXT,
      result         TEXT    NOT NULL,
      detail         TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_join_groups_user_tid  ON join_groups(user_id, telegram_id);
    CREATE INDEX IF NOT EXISTS idx_join_links_user_id    ON join_links(user_id);
    CREATE INDEX IF NOT EXISTS idx_join_links_status     ON join_links(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_join_accounts_user_id ON join_accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_join_logs_user_id     ON join_logs(user_id, created_at);
  `);

  // ── Central-DB additive migrations on join_groups ──────────────────────────
  // All ADDITIVE ONLY (no data loss). Mirrors the safe-migration pattern in db.js.
  addColumnIfMissing(db, 'join_groups', 'link', 'TEXT');
  addColumnIfMissing(db, 'join_groups', 'link_type', 'TEXT');
  addColumnIfMissing(db, 'join_groups', 'source', "TEXT DEFAULT 'join'");
  addColumnIfMissing(db, 'join_groups', 'folder_id', 'INTEGER');
  addColumnIfMissing(db, 'join_groups', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');

  // ── join_links: retry + independent-queue support ──────────────────────────
  // (CREATE TABLE above already has these for brand-new installs; ALTER here
  // covers upgrades of an existing database.)
  addColumnIfMissing(db, 'join_links', 'retry_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_links', 'next_retry_at', 'DATETIME');

  // ── join_accounts: rolling hour/day/session counters + per-account snapshot
  //    of the randomized timing / retry settings used for its current run ──
  addColumnIfMissing(db, 'join_accounts', 'joined_hour_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_accounts', 'hour_window_start', 'DATETIME');
  addColumnIfMissing(db, 'join_accounts', 'joined_day_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_accounts', 'day_window_start', 'DATETIME');
  addColumnIfMissing(db, 'join_accounts', 'joined_session_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_accounts', 'max_joins_per_hour', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_accounts', 'max_joins_per_day', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_accounts', 'max_joins_per_session', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_accounts', 'join_delay_min_seconds', 'INTEGER NOT NULL DEFAULT 20');
  addColumnIfMissing(db, 'join_accounts', 'join_delay_max_seconds', 'INTEGER NOT NULL DEFAULT 45');
  addColumnIfMissing(db, 'join_accounts', 'rest_min_seconds', 'INTEGER NOT NULL DEFAULT 300');
  addColumnIfMissing(db, 'join_accounts', 'rest_max_seconds', 'INTEGER NOT NULL DEFAULT 900');
  addColumnIfMissing(db, 'join_accounts', 'max_retries', 'INTEGER NOT NULL DEFAULT 2');
  addColumnIfMissing(db, 'join_accounts', 'retry_delay_seconds', 'INTEGER NOT NULL DEFAULT 90');
  addColumnIfMissing(db, 'join_accounts', 'current_link_id', 'INTEGER');

  // ── join_settings: control-panel additions (بند ثاني عشر) ───────────────────
  addColumnIfMissing(db, 'join_settings', 'join_delay_min_seconds', 'INTEGER NOT NULL DEFAULT 20');
  addColumnIfMissing(db, 'join_settings', 'join_delay_max_seconds', 'INTEGER NOT NULL DEFAULT 45');
  addColumnIfMissing(db, 'join_settings', 'rest_min_seconds', 'INTEGER NOT NULL DEFAULT 300');
  addColumnIfMissing(db, 'join_settings', 'rest_max_seconds', 'INTEGER NOT NULL DEFAULT 900');
  addColumnIfMissing(db, 'join_settings', 'max_joins_per_hour', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_settings', 'max_joins_per_day', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_settings', 'max_joins_per_session', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'join_settings', 'max_retries', 'INTEGER NOT NULL DEFAULT 2');
  addColumnIfMissing(db, 'join_settings', 'retry_delay_seconds', 'INTEGER NOT NULL DEFAULT 90');
  addColumnIfMissing(db, 'join_settings', 'retry_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'join_settings', 'smart_protection_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'join_settings', 'queue_enabled', 'INTEGER NOT NULL DEFAULT 1');

  // ── join_logs: richer audit trail (بند حادي عشر) ────────────────────────────
  addColumnIfMissing(db, 'join_logs', 'duration_ms', 'INTEGER');
  addColumnIfMissing(db, 'join_logs', 'flood_wait_seconds', 'INTEGER');
  addColumnIfMissing(db, 'join_logs', 'link_status', 'TEXT');

  // ── Telegram Folders feature (قسم إنشاء مجلدات تيليجرام) ───────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_folders (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           TEXT    NOT NULL,
      folder_number     INTEGER NOT NULL,
      name              TEXT    NOT NULL,
      tg_filter_id      INTEGER,
      capacity          INTEGER NOT NULL DEFAULT 100,
      groups_count      INTEGER NOT NULL DEFAULT 0,
      status            TEXT    NOT NULL DEFAULT 'building',
      invite_link       TEXT,
      account_id        INTEGER,
      error_message     TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, folder_number)
    );

    CREATE TABLE IF NOT EXISTS tg_folder_groups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT    NOT NULL,
      folder_id    INTEGER NOT NULL,
      group_id     INTEGER NOT NULL,
      added_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (folder_id) REFERENCES tg_folders(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id)  REFERENCES join_groups(id) ON DELETE CASCADE,
      UNIQUE(user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS tg_folder_settings (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            TEXT    NOT NULL UNIQUE,
      groups_per_folder  INTEGER NOT NULL DEFAULT 100,
      default_account_id INTEGER,
      updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tg_folders_user_id        ON tg_folders(user_id);
    CREATE INDEX IF NOT EXISTS idx_tg_folders_status         ON tg_folders(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_tg_folder_groups_folder   ON tg_folder_groups(folder_id);
    CREATE INDEX IF NOT EXISTS idx_tg_folder_groups_user     ON tg_folder_groups(user_id);
    CREATE INDEX IF NOT EXISTS idx_join_groups_folder_id     ON join_groups(folder_id);
  `);

  // ── Crash-recovery sweep ────────────────────────────────────────────────────
  // If the previous process died (redeploy / crash) mid-run, nothing must be
  // left permanently stuck in a transient "in progress" state: links reopen
  // for retry and accounts reopen for a fresh start. Safe to run every boot.
  const recoveredLinks = db.prepare(
    `UPDATE join_links SET status = 'pending', next_retry_at = NULL
     WHERE status IN ('in_progress', 'failed_flood')`
  ).run().changes;
  const recoveredAccounts = db.prepare(
    `UPDATE join_accounts SET state = 'idle', current_link_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE state IN ('working', 'resting')`
  ).run().changes;
  if (recoveredLinks || recoveredAccounts) {
    logger.info(
      `Join: startup recovery reset ${recoveredLinks} link(s) and ${recoveredAccounts} account(s) left mid-run by a previous process.`
    );
  }

  logger.info('Join-to-links + central groups/folders schema initialised.');
};

// ─── Groups (CENTRAL dedup registry, keyed by Telegram ID) ────────────────────
//
// This is the project's single source of truth for every Telegram group,
// regardless of which section discovered it (search / join / folders /
// manual add). All sections MUST check/register through these queries —
// never maintain a parallel groups table elsewhere.

const joinGroupQueries = {
  exists: (userId, telegramId) => {
    return !!getDb()
      .prepare('SELECT 1 FROM join_groups WHERE user_id = ? AND telegram_id = ?')
      .get(userId, String(telegramId));
  },

  /**
   * Fetch the full central row for a group, or null.
   */
  getByTelegramId: (userId, telegramId) => {
    return getDb()
      .prepare('SELECT * FROM join_groups WHERE user_id = ? AND telegram_id = ?')
      .get(userId, String(telegramId)) ?? null;
  },

  getById: (id) => {
    return getDb().prepare('SELECT * FROM join_groups WHERE id = ?').get(id) ?? null;
  },

  /**
   * Register a group in the central DB (idempotent — first writer wins).
   * Any section (search, join, folders, manual) can call this the same way.
   *
   * @param {string} userId
   * @param {string|number} telegramId
   * @param {string} title
   * @param {number} accountId
   * @param {string} link
   * @param {object} extra  { linkType, source }
   */
  register: (userId, telegramId, title, accountId, link, extra = {}) => {
    const stmt = getDb().prepare(`
      INSERT INTO join_groups
        (user_id, telegram_id, title, joined_by_account_id, first_link, status,
         link, link_type, source, updated_at)
      VALUES (?, ?, ?, ?, ?, 'joined', ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, telegram_id) DO NOTHING
    `);
    return stmt.run(
      userId,
      String(telegramId),
      title || null,
      accountId,
      link || null,
      link || null,
      extra.linkType || null,
      extra.source || 'join',
    );
  },

  /**
   * Groups not yet placed in any folder — candidates for folder building.
   * @param {string} userId
   * @param {number} limit
   */
  getUnfoldered: (userId, limit = 100) => {
    return getDb()
      .prepare(
        `SELECT * FROM join_groups
         WHERE user_id = ? AND folder_id IS NULL AND status != 'مكررة'
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(userId, limit);
  },

  /**
   * Mark a batch of groups as belonging to a folder.
   * @param {number[]} groupIds
   * @param {number} folderId
   */
  assignFolder: (groupIds, folderId) => {
    if (!groupIds.length) return;
    const stmt = getDb().prepare(
      `UPDATE join_groups SET folder_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    );
    const tx = getDb().transaction((ids) => {
      for (const id of ids) stmt.run(folderId, id);
    });
    tx(groupIds);
  },

  countUnfolderedByUserId: (userId) => {
    return getDb()
      .prepare(
        `SELECT COUNT(*) as count FROM join_groups WHERE user_id = ? AND folder_id IS NULL`
      )
      .get(userId)?.count || 0;
  },

  getAllByUserId: (userId) => {
    return getDb()
      .prepare('SELECT * FROM join_groups WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId);
  },

  countByUserId: (userId) => {
    return getDb()
      .prepare('SELECT COUNT(*) as count FROM join_groups WHERE user_id = ?')
      .get(userId)?.count || 0;
  },

  /**
   * Full central-DB statistics block (used by the central stats screen).
   * @param {string} userId
   */
  getCentralStats: (userId) => {
    const db = getDb();
    const uid = String(userId);

    const totalGroups = db
      .prepare(`SELECT COUNT(*) c FROM join_groups WHERE user_id = ?`)
      .get(uid)?.c || 0;

    const inFolders = db
      .prepare(`SELECT COUNT(*) c FROM join_groups WHERE user_id = ? AND folder_id IS NOT NULL`)
      .get(uid)?.c || 0;

    const totalFolders = db
      .prepare(`SELECT COUNT(*) c FROM tg_folders WHERE user_id = ?`)
      .get(uid)?.c || 0;

    const completedFolders = db
      .prepare(`SELECT COUNT(*) c FROM tg_folders WHERE user_id = ? AND status IN ('مكتمل', 'جاهز للمشاركة')`)
      .get(uid)?.c || 0;

    const readyFolders = db
      .prepare(`SELECT COUNT(*) c FROM tg_folders WHERE user_id = ? AND status = 'جاهز للمشاركة'`)
      .get(uid)?.c || 0;

    const totalLinks = db
      .prepare(`SELECT COUNT(*) c FROM join_links WHERE user_id = ?`)
      .get(uid)?.c || 0;

    const duplicatesBlocked = db
      .prepare(`SELECT COUNT(*) c FROM join_links WHERE user_id = ? AND status = 'skipped'`)
      .get(uid)?.c || 0;

    const invalidLinks = db
      .prepare(`SELECT COUNT(*) c FROM join_links WHERE user_id = ? AND status = 'invalid'`)
      .get(uid)?.c || 0;

    return {
      totalLinks,
      totalGroups,
      groupsInFolders: inFolders,
      groupsUnfoldered: totalGroups - inFolders,
      duplicatesBlocked,
      invalidLinks,
      totalFolders,
      completedFolders,
      readyFolders,
    };
  },
};

// ─── Links queue ────────────────────────────────────────────────────────────────
//
// A link's row IS its queue slot (see the "Queueing model" note at the top of
// this file). assigned_account_id decides whose queue it lives in; status +
// next_retry_at decide whether it is currently claimable.

const joinLinkQueries = {
  /**
   * Insert new links for a user. URLs that are already queued in a
   * non-terminal state (pending / in_progress / needs_approval /
   * failed_flood) for this user are skipped instead of duplicated —
   * this is the "إزالة أي تعارضات أو عمليات مكررة" requirement applied
   * at insert time.
   * @returns {{ inserted: number, duplicateSkipped: number }}
   */
  insertMany: (userId, urls) => {
    const db = getDb();
    const existing = new Set(
      db
        .prepare(
          `SELECT LOWER(url) as u FROM join_links
           WHERE user_id = ? AND status IN ('pending','in_progress','needs_approval','failed_flood')`
        )
        .all(userId)
        .map((r) => r.u)
    );

    const insert = db.prepare(
      `INSERT INTO join_links (user_id, url, status) VALUES (?, ?, 'pending')`
    );

    let inserted = 0;
    let duplicateSkipped = 0;

    const tx = db.transaction((rows) => {
      for (const url of rows) {
        const key = url.toLowerCase();
        if (existing.has(key)) {
          duplicateSkipped++;
          continue;
        }
        existing.add(key);
        insert.run(userId, url);
        inserted++;
      }
    });
    tx(urls);

    return { inserted, duplicateSkipped };
  },

  getById: (id) => getDb().prepare('SELECT * FROM join_links WHERE id = ?').get(id) ?? null,

  getPendingByUserId: (userId, limit = 500) => {
    return getDb()
      .prepare(
        `SELECT * FROM join_links WHERE user_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?`
      )
      .all(userId, limit);
  },

  /**
   * This account's own due work: assigned to it, still open, and either
   * never retried or its retry backoff has elapsed. ORDER BY id ASC is
   * what makes "معالجة الروابط بالترتيب فقط" (in-order only) a guarantee
   * of the query rather than something every caller has to remember.
   */
  getDueForAccount: (userId, accountId, limit = 1) => {
    return getDb()
      .prepare(
        `SELECT * FROM join_links
         WHERE user_id = ? AND assigned_account_id = ?
           AND status IN ('pending','failed_flood')
           AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
         ORDER BY id ASC LIMIT ?`
      )
      .all(userId, accountId, limit);
  },

  /**
   * Atomically claim the oldest unassigned pending link for an account.
   * Used only when auto-distribution is OFF (dynamic shared-pool mode).
   * Wrapped in a transaction so the "check then claim" is a single unit —
   * no two calls can ever walk away with the same row.
   */
  claimNextUnassigned: (userId, accountId) => {
    const db = getDb();
    const tx = db.transaction(() => {
      const row = db
        .prepare(
          `SELECT * FROM join_links
           WHERE user_id = ? AND assigned_account_id IS NULL AND status = 'pending'
             AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
           ORDER BY id ASC LIMIT 1`
        )
        .get(userId);
      if (!row) return null;
      db.prepare(`UPDATE join_links SET assigned_account_id = ? WHERE id = ?`).run(accountId, row.id);
      row.assigned_account_id = accountId;
      return row;
    });
    return tx();
  },

  /**
   * Single entry point a worker calls for "give me my next unit of work".
   * @param {boolean} autoDistribute  when false, falls back to claiming
   *                                  from the shared unassigned pool.
   */
  getNextForAccount: (userId, accountId, autoDistribute) => {
    const due = joinLinkQueries.getDueForAccount(userId, accountId, 1);
    if (due.length) return due[0];
    if (!autoDistribute) return joinLinkQueries.claimNextUnassigned(userId, accountId);
    return null;
  },

  /**
   * Round-robin assign every currently-unassigned pending link across the
   * given accounts (بند سابعاً — توزيع الروابط). Idempotent: only touches
   * links with assigned_account_id IS NULL, so calling it again mid-run
   * (e.g. after the user adds more links) only distributes the new ones.
   * @returns {number} how many links were just assigned
   */
  distributeUnassigned: (userId, accountIds) => {
    if (!accountIds.length) return 0;
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id FROM join_links WHERE user_id = ? AND assigned_account_id IS NULL AND status = 'pending' ORDER BY id ASC`
      )
      .all(userId);
    if (!rows.length) return 0;

    const stmt = db.prepare(`UPDATE join_links SET assigned_account_id = ? WHERE id = ?`);
    const tx = db.transaction((items) => {
      items.forEach((row, i) => {
        stmt.run(accountIds[i % accountIds.length], row.id);
      });
    });
    tx(rows);
    return rows.length;
  },

  getUnassignedPendingCount: (userId) => {
    return getDb()
      .prepare(`SELECT COUNT(*) c FROM join_links WHERE user_id = ? AND assigned_account_id IS NULL AND status = 'pending'`)
      .get(userId)?.c || 0;
  },

  /**
   * Free up links currently assigned to accounts that are no longer part
   * of the active run (e.g. an account was disabled between runs) so they
   * can be redistributed instead of sitting orphaned forever.
   */
  reclaimOrphaned: (userId, activeAccountIds) => {
    const db = getDb();
    if (!activeAccountIds.length) {
      return db
        .prepare(
          `UPDATE join_links SET assigned_account_id = NULL
           WHERE user_id = ? AND status IN ('pending','failed_flood') AND assigned_account_id IS NOT NULL`
        )
        .run(userId).changes;
    }
    const placeholders = activeAccountIds.map(() => '?').join(',');
    return db
      .prepare(
        `UPDATE join_links SET assigned_account_id = NULL
         WHERE user_id = ? AND status IN ('pending','failed_flood')
           AND assigned_account_id IS NOT NULL AND assigned_account_id NOT IN (${placeholders})`
      )
      .run(userId, ...activeAccountIds).changes;
  },

  countByStatus: (userId) => {
    const rows = getDb()
      .prepare(
        `SELECT status, COUNT(*) as count FROM join_links WHERE user_id = ? GROUP BY status`
      )
      .all(userId);
    const out = {};
    for (const key of Object.keys(JOIN_LINK_STATUSES)) out[key] = 0;
    for (const r of rows) out[r.status] = r.count;
    return out;
  },

  /**
   * Generic status transition. `processed_at` is stamped as "last touched
   * by the engine", not necessarily final — in_progress and pending
   * (retry-scheduled) transitions go through here too.
   */
  updateStatus: (id, status, extra = {}) => {
    const fields = ['status = ?', 'processed_at = CURRENT_TIMESTAMP'];
    const values = [status];
    const allowed = [
      'telegram_id', 'assigned_account_id', 'skip_reason', 'url_type',
      'retry_count', 'next_retry_at',
    ];
    for (const key of allowed) {
      if (extra[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(extra[key]);
      }
    }
    values.push(id);
    return getDb()
      .prepare(`UPDATE join_links SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
  },

  /** Bulk soft-delete every link currently in a terminal-failure status. */
  softDeleteTerminal: (userId) => {
    const placeholders = TERMINAL_FAILURE_STATUSES.map(() => '?').join(',');
    return getDb()
      .prepare(
        `UPDATE join_links SET status = 'deleted', processed_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND status IN (${placeholders})`
      )
      .run(userId, ...TERMINAL_FAILURE_STATUSES).changes;
  },

  /**
   * Fetch links by a specific status for the links-overview filter screen.
   * @param {string} userId
   * @param {string} status   any JOIN_LINK_STATUSES key
   * @param {number} limit
   */
  getByStatus: (userId, status, limit = 20) => {
    return getDb()
      .prepare(
        `SELECT * FROM join_links WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT ?`
      )
      .all(userId, status, limit);
  },

  getNeedsApproval: (userId, limit = 10) => {
    return getDb()
      .prepare(
        `SELECT * FROM join_links WHERE user_id = ? AND status = 'needs_approval' ORDER BY id ASC LIMIT ?`
      )
      .all(userId, limit);
  },

  /** Resolve a needs_approval link once the admin checks it manually. */
  decideApproval: (id, accepted) => {
    return joinLinkQueries.updateStatus(id, accepted ? 'joined' : 'rejected');
  },

  deleteAllByUserId: (userId) => {
    return getDb().prepare('DELETE FROM join_links WHERE user_id = ?').run(userId);
  },
};

// ─── Per-account join state ──────────────────────────────────────────────────────

const joinAccountQueries = {
  ensure: (userId, accountId) => {
    getDb()
      .prepare(
        `INSERT INTO join_accounts (user_id, account_id) VALUES (?, ?)
         ON CONFLICT(user_id, account_id) DO NOTHING`
      )
      .run(userId, accountId);
    return joinAccountQueries.get(userId, accountId);
  },

  get: (userId, accountId) => {
    return getDb()
      .prepare('SELECT * FROM join_accounts WHERE user_id = ? AND account_id = ?')
      .get(userId, accountId);
  },

  /**
   * Lazily clears any cooldown whose FloodWait has already elapsed, so the
   * accounts list never shows a stale "🔴 محظور" after the wait is really
   * over, even if no join run is currently active to notice.
   */
  autoResumeExpiredCooldowns: (userId) => {
    return getDb()
      .prepare(
        `UPDATE join_accounts SET state = 'idle', ban_reason = NULL, cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND state = 'banned' AND cooldown_until IS NOT NULL AND cooldown_until <= CURRENT_TIMESTAMP`
      )
      .run(userId).changes;
  },

  getAllByUserId: (userId) => {
    joinAccountQueries.autoResumeExpiredCooldowns(userId);
    return getDb()
      .prepare(
        `SELECT ja.*, a.phone, a.first_name, a.last_name, a.status as account_status
         FROM join_accounts ja
         JOIN accounts a ON a.id = ja.account_id
         WHERE ja.user_id = ?
         ORDER BY ja.id ASC`
      )
      .all(userId);
  },

  setEnabled: (userId, accountId, enabled) => {
    return getDb()
      .prepare(
        `UPDATE join_accounts SET enabled = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND account_id = ?`
      )
      .run(enabled ? 1 : 0, userId, accountId);
  },

  updateState: (userId, accountId, state, extra = {}) => {
    const fields = ['state = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [state];
    const allowed = [
      'joined_count', 'max_joins', 'batch_size', 'join_delay_seconds',
      'rest_seconds', 'batch_progress', 'cooldown_until', 'ban_reason', 'last_joined_at',
      'joined_hour_count', 'hour_window_start', 'joined_day_count', 'day_window_start',
      'joined_session_count', 'max_joins_per_hour', 'max_joins_per_day', 'max_joins_per_session',
      'join_delay_min_seconds', 'join_delay_max_seconds', 'rest_min_seconds', 'rest_max_seconds',
      'max_retries', 'retry_delay_seconds', 'current_link_id',
    ];
    for (const key of allowed) {
      if (extra[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(extra[key]);
      }
    }
    values.push(userId, accountId);
    return getDb()
      .prepare(
        `UPDATE join_accounts SET ${fields.join(', ')} WHERE user_id = ? AND account_id = ?`
      )
      .run(...values);
  },

  /** Records one successful join against every relevant counter at once. */
  registerJoin: (userId, accountId) => {
    return getDb()
      .prepare(
        `UPDATE join_accounts
         SET joined_count = joined_count + 1,
             joined_hour_count = joined_hour_count + 1,
             joined_day_count = joined_day_count + 1,
             joined_session_count = joined_session_count + 1,
             batch_progress = batch_progress + 1,
             last_joined_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND account_id = ?`
      )
      .run(userId, accountId);
  },

  resetBatchProgress: (userId, accountId) => {
    return getDb()
      .prepare(
        `UPDATE join_accounts SET batch_progress = 0, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND account_id = ?`
      )
      .run(userId, accountId);
  },

  /** Called once per account at the start of a new run (بند خامساً — حد الجلسة). */
  resetSessionCounters: (userId, accountId) => {
    return getDb()
      .prepare(
        `UPDATE join_accounts SET joined_session_count = 0, batch_progress = 0, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND account_id = ?`
      )
      .run(userId, accountId);
  },

  /**
   * The single entry point a worker calls before every attempt. Lazily
   * rolls the hour/day windows forward if they have expired, then reports
   * whether the account is currently blocked by any configured limit.
   * @returns {{ row: object|null, limited: null|{type:string, resumeAt:string|null, message:string} }}
   */
  assessAccount: (userId, accountId) => {
    const db = getDb();
    let row = joinAccountQueries.get(userId, accountId);
    if (!row) return { row: null, limited: { type: 'missing', resumeAt: null, message: 'الحساب غير موجود' } };

    const now = Date.now();
    const patch = {};
    const hourStart = fromSqliteUtc(row.hour_window_start);
    if (!hourStart || now - hourStart.getTime() >= 3600 * 1000) {
      patch.hour_window_start = toSqliteUtc(new Date(now));
      patch.joined_hour_count = 0;
    }
    const dayStart = fromSqliteUtc(row.day_window_start);
    if (!dayStart || now - dayStart.getTime() >= 24 * 3600 * 1000) {
      patch.day_window_start = toSqliteUtc(new Date(now));
      patch.joined_day_count = 0;
    }
    if (Object.keys(patch).length) {
      const fields = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE join_accounts SET ${fields} WHERE user_id = ? AND account_id = ?`)
        .run(...Object.values(patch), userId, accountId);
      row = joinAccountQueries.get(userId, accountId);
    }

    if (row.max_joins && row.joined_count >= row.max_joins) {
      return { row, limited: { type: 'total', resumeAt: null, message: 'وصل الحساب للحد الأقصى الكلي المحدد في الإعدادات' } };
    }
    if (row.max_joins_per_session && row.joined_session_count >= row.max_joins_per_session) {
      return { row, limited: { type: 'session', resumeAt: null, message: 'وصل الحساب لحد هذه الجلسة' } };
    }
    if (row.max_joins_per_hour && row.joined_hour_count >= row.max_joins_per_hour) {
      const resumeAt = toSqliteUtc(new Date(fromSqliteUtc(row.hour_window_start).getTime() + 3600 * 1000));
      return { row, limited: { type: 'hour', resumeAt, message: 'وصل الحساب للحد الأقصى بالساعة' } };
    }
    if (row.max_joins_per_day && row.joined_day_count >= row.max_joins_per_day) {
      const resumeAt = toSqliteUtc(new Date(fromSqliteUtc(row.day_window_start).getTime() + 24 * 3600 * 1000));
      return { row, limited: { type: 'day', resumeAt, message: 'وصل الحساب للحد الأقصى اليومي' } };
    }
    return { row, limited: null };
  },

  startFloodWait: (userId, accountId, seconds, message) => {
    const until = toSqliteUtc(new Date(Date.now() + Math.max(1, seconds) * 1000));
    return joinAccountQueries.updateState(userId, accountId, 'banned', {
      ban_reason: message,
      cooldown_until: until,
    });
  },

  clearBan: (userId, accountId) => {
    return joinAccountQueries.updateState(userId, accountId, 'idle', {
      ban_reason: null,
      cooldown_until: null,
    });
  },

  setCurrentLink: (userId, accountId, linkId) => {
    return getDb()
      .prepare(`UPDATE join_accounts SET current_link_id = ? WHERE user_id = ? AND account_id = ?`)
      .run(linkId, userId, accountId);
  },
};

// ─── Settings ─────────────────────────────────────────────────────────────────

const joinSettingsQueries = {
  get: (userId) => {
    let row = getDb()
      .prepare('SELECT * FROM join_settings WHERE user_id = ?')
      .get(userId);
    if (!row) {
      getDb()
        .prepare('INSERT INTO join_settings (user_id) VALUES (?)')
        .run(userId);
      row = getDb()
        .prepare('SELECT * FROM join_settings WHERE user_id = ?')
        .get(userId);
    }
    return row;
  },

  update: (userId, patch) => {
    joinSettingsQueries.get(userId); // ensure row exists
    const allowed = [
      'batch_size', 'join_delay_seconds', 'rest_seconds',
      'max_joins_per_account', 'auto_distribute',
      'join_delay_min_seconds', 'join_delay_max_seconds',
      'rest_min_seconds', 'rest_max_seconds',
      'max_joins_per_hour', 'max_joins_per_day', 'max_joins_per_session',
      'max_retries', 'retry_delay_seconds',
      'retry_enabled', 'smart_protection_enabled', 'queue_enabled',
    ];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(patch[key]);
      }
    }
    if (!fields.length) return;
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(userId);
    getDb()
      .prepare(`UPDATE join_settings SET ${fields.join(', ')} WHERE user_id = ?`)
      .run(...values);
  },
};

// ─── Logs ─────────────────────────────────────────────────────────────────────

const joinLogQueries = {
  add: (userId, accountId, link, groupTitle, result, detail, extra = {}) => {
    return getDb()
      .prepare(
        `INSERT INTO join_logs
           (user_id, account_id, link, group_title, result, detail, duration_ms, flood_wait_seconds, link_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        accountId || null,
        link || null,
        groupTitle || null,
        result,
        detail || null,
        extra.durationMs ?? null,
        extra.floodWaitSeconds ?? null,
        extra.linkStatus ?? null,
      );
  },

  getRecentByUserId: (userId, limit = 30) => {
    return getDb()
      .prepare(
        `SELECT jl.*, a.phone FROM join_logs jl
         LEFT JOIN accounts a ON a.id = jl.account_id
         WHERE jl.user_id = ? ORDER BY jl.id DESC LIMIT ?`
      )
      .all(userId, limit);
  },

  clearByUserId: (userId) => {
    return getDb().prepare('DELETE FROM join_logs WHERE user_id = ?').run(userId);
  },

  /**
   * Aggregate monitoring numbers for the performance dashboard (بند عاشراً).
   * Account-state counts (working / stopped / banned) are read from
   * join_accounts by the caller via joinAccountQueries.getAllByUserId —
   * this covers the log-derived numbers (today's joins, rates, avg time).
   */
  getPerformanceStats: (userId) => {
    const db = getDb();
    const uid = String(userId);
    const TERMINAL_RESULTS = [
      'joined', 'skipped', 'invalid', 'expired', 'private',
      'needs_approval', 'rejected', 'failed_flood', 'failed_privacy', 'failed',
    ];
    const placeholders = TERMINAL_RESULTS.map(() => '?').join(',');

    const todayJoins = db
      .prepare(
        `SELECT COUNT(*) c FROM join_logs WHERE user_id = ? AND result = 'joined' AND DATE(created_at) = DATE('now')`
      )
      .get(uid)?.c || 0;

    const totalAttempts = db
      .prepare(
        `SELECT COUNT(*) c FROM join_logs WHERE user_id = ? AND result IN (${placeholders})`
      )
      .get(uid, ...TERMINAL_RESULTS)?.c || 0;

    const totalJoined = db
      .prepare(`SELECT COUNT(*) c FROM join_logs WHERE user_id = ? AND result = 'joined'`)
      .get(uid)?.c || 0;

    const avgDurationMs = db
      .prepare(
        `SELECT AVG(duration_ms) a FROM join_logs WHERE user_id = ? AND result = 'joined' AND duration_ms IS NOT NULL`
      )
      .get(uid)?.a || 0;

    const successRate = totalAttempts ? Math.round((totalJoined / totalAttempts) * 100) : 0;

    return {
      todayJoins,
      totalAttempts,
      successRate,
      failureRate: totalAttempts ? 100 - successRate : 0,
      avgDurationSeconds: avgDurationMs ? Math.round(avgDurationMs / 100) / 10 : 0,
    };
  },
};

// ─── Folders (تنظيم المجموعات داخل مجلدات تيليجرام) ──────────────────────────

const DEFAULT_FOLDER_SETTINGS = {
  groups_per_folder: 100,
};

const folderSettingsQueries = {
  get: (userId) => {
    const db = getDb();
    const uid = String(userId);
    let row = db.prepare('SELECT * FROM tg_folder_settings WHERE user_id = ?').get(uid);
    if (!row) {
      db.prepare(
        `INSERT INTO tg_folder_settings (user_id, groups_per_folder) VALUES (?, ?)`
      ).run(uid, DEFAULT_FOLDER_SETTINGS.groups_per_folder);
      row = db.prepare('SELECT * FROM tg_folder_settings WHERE user_id = ?').get(uid);
    }
    return row ?? { ...DEFAULT_FOLDER_SETTINGS, user_id: uid };
  },

  update: (userId, patch) => {
    folderSettingsQueries.get(userId);
    const allowed = ['groups_per_folder', 'default_account_id'];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(patch[key]);
      }
    }
    if (!fields.length) return;
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(String(userId));
    getDb()
      .prepare(`UPDATE tg_folder_settings SET ${fields.join(', ')} WHERE user_id = ?`)
      .run(...values);
  },
};

const folderQueries = {
  /**
   * Create a new folder row (status 'قيد الإنشاء' / building) with the next
   * sequential folder_number for this user.
   * @param {string} userId
   * @param {number} capacity
   */
  create: (userId, capacity = 100) => {
    const db = getDb();
    const uid = String(userId);
    const last = db
      .prepare('SELECT MAX(folder_number) as n FROM tg_folders WHERE user_id = ?')
      .get(uid)?.n || 0;
    const folderNumber = last + 1;
    const name = `مجلد رقم ${folderNumber}`;

    const result = db
      .prepare(
        `INSERT INTO tg_folders (user_id, folder_number, name, capacity, status)
         VALUES (?, ?, ?, ?, 'قيد الإنشاء')`
      )
      .run(uid, folderNumber, name, capacity);

    return folderQueries.getById(result.lastInsertRowid);
  },

  getById: (id) => getDb().prepare('SELECT * FROM tg_folders WHERE id = ?').get(id) ?? null,

  getAllByUserId: (userId) =>
    getDb()
      .prepare('SELECT * FROM tg_folders WHERE user_id = ? ORDER BY folder_number ASC')
      .all(String(userId)),

  /**
   * The current open (not-yet-full) folder for a user, if any.
   * @param {string} userId
   */
  getOpenFolder: (userId) =>
    getDb()
      .prepare(
        `SELECT * FROM tg_folders
         WHERE user_id = ? AND status = 'قيد الإنشاء'
         ORDER BY folder_number DESC LIMIT 1`
      )
      .get(String(userId)) ?? null,

  incrementGroupsCount: (folderId, by = 1) => {
    getDb()
      .prepare(
        `UPDATE tg_folders SET groups_count = groups_count + ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(by, folderId);
  },

  updateStatus: (folderId, status, extra = {}) => {
    const fields = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [status];
    const allowed = ['tg_filter_id', 'invite_link', 'account_id', 'error_message'];
    for (const key of allowed) {
      if (extra[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(extra[key]);
      }
    }
    values.push(folderId);
    getDb()
      .prepare(`UPDATE tg_folders SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
  },

  deleteById: (folderId, userId) => {
    const db = getDb();
    // Free up the groups so they can be re-assigned to a future folder.
    db.prepare(`UPDATE join_groups SET folder_id = NULL WHERE folder_id = ?`).run(folderId);
    db.prepare(`DELETE FROM tg_folder_groups WHERE folder_id = ?`).run(folderId);
    db.prepare(`DELETE FROM tg_folders WHERE id = ? AND user_id = ?`).run(folderId, String(userId));
  },
};

const folderGroupQueries = {
  /**
   * Link a central group to a folder. Enforced UNIQUE(user_id, group_id) at
   * the schema level guarantees a group can never live in more than one folder.
   */
  add: (userId, folderId, groupId) => {
    getDb()
      .prepare(
        `INSERT INTO tg_folder_groups (user_id, folder_id, group_id)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, group_id) DO NOTHING`
      )
      .run(String(userId), folderId, groupId);
  },

  getByFolderId: (folderId) =>
    getDb()
      .prepare(
        `SELECT fg.*, jg.title, jg.telegram_id, jg.link
         FROM tg_folder_groups fg
         JOIN join_groups jg ON jg.id = fg.group_id
         WHERE fg.folder_id = ?
         ORDER BY fg.added_at ASC`
      )
      .all(folderId),

  isGroupInAnyFolder: (userId, groupId) =>
    !!getDb()
      .prepare(`SELECT 1 FROM tg_folder_groups WHERE user_id = ? AND group_id = ?`)
      .get(String(userId), groupId),
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initJoinSchema,
  toSqliteUtc,
  fromSqliteUtc,
  JOIN_LINK_STATUSES,
  TERMINAL_FAILURE_STATUSES,
  OPEN_STATUSES,
  joinGroupQueries,
  joinLinkQueries,
  joinAccountQueries,
  joinSettingsQueries,
  joinLogQueries,
  folderQueries,
  folderGroupQueries,
  folderSettingsQueries,
};
