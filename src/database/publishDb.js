/**
 * Publishing Engine Database Module
 * 
 * Handles storage for:
 * - Ads Library (نصوص، صور، روابط، ملفات)
 * - Publish Tasks (المهام المباشرة والمجدولة)
 * - Publish Logs (سجل عمليات النشر)
 */

const { getDb } = require('./db');
const logger = require('../utils/logger');

const columnExists = (database, table, column) => {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
};

const initPublishSchema = () => {
  const db = getDb();

  // 1. Ads Library
  db.exec(`
    CREATE TABLE IF NOT EXISTS publish_ads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT    NOT NULL,
      type         TEXT    NOT NULL, -- 'text', 'image', 'text_image', 'link', 'file'
      text_content TEXT,
      media_file   TEXT,             -- File ID or path
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Publish Tasks
  db.exec(`
    CREATE TABLE IF NOT EXISTS publish_tasks (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           TEXT    NOT NULL,
      name              TEXT,
      mode              TEXT    NOT NULL, -- 'direct', 'scheduled'
      account_ids       TEXT    NOT NULL, -- JSON array of account IDs
      target_type       TEXT    NOT NULL, -- 'groups', 'folders', 'manual'
      target_ids        TEXT,             -- JSON array of group/folder IDs or raw links
      ad_ids            TEXT    NOT NULL, -- JSON array of ad IDs
      ad_rotation       TEXT    DEFAULT 'sequence', -- 'sequence', 'random'
      interval_seconds  INTEGER DEFAULT 60,
      start_time        TEXT,             -- HH:mm
      end_time          TEXT,             -- HH:mm
      days_of_week      TEXT,             -- JSON array [0,1,2,3,4,5,6]
      max_ads_per_day   INTEGER,
      status            TEXT    NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'paused', 'completed', 'stopped'
      last_run_at       DATETIME,
      next_run_at       DATETIME,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 3. Publish Logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS publish_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT    NOT NULL,
      task_id      INTEGER,
      account_id   INTEGER,
      target_id    TEXT,             -- Telegram ID or link
      ad_id        INTEGER,
      result       TEXT    NOT NULL, -- 'success', 'failed'
      detail       TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES publish_tasks(id) ON DELETE SET NULL
    );
  `);

  // Add columns to existing accounts table if needed for tracking
  if (!columnExists(db, 'accounts', 'last_publish_at')) {
    db.exec(`ALTER TABLE accounts ADD COLUMN last_publish_at DATETIME`);
  }
  if (!columnExists(db, 'accounts', 'publish_count')) {
    db.exec(`ALTER TABLE accounts ADD COLUMN publish_count INTEGER DEFAULT 0`);
  }

  logger.info('Publishing Engine schema initialised.');
};

const adQueries = {
  create: (userId, type, textContent, mediaFile) => {
    const stmt = getDb().prepare(`
      INSERT INTO publish_ads (user_id, type, text_content, media_file)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(userId, type, textContent, mediaFile);
  },
  update: (id, userId, data) => {
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, userId);
    const stmt = getDb().prepare(`UPDATE publish_ads SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`);
    return stmt.run(...values);
  },
  delete: (id, userId) => {
    return getDb().prepare('DELETE FROM publish_ads WHERE id = ? AND user_id = ?').run(id, userId);
  },
  getById: (id, userId) => {
    return getDb().prepare('SELECT * FROM publish_ads WHERE id = ? AND user_id = ?').get(id, userId);
  },
  getAll: (userId) => {
    return getDb().prepare('SELECT * FROM publish_ads WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  }
};

const taskQueries = {
  create: (userId, data) => {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => '?').join(', ');
    const stmt = getDb().prepare(`
      INSERT INTO publish_tasks (user_id, ${keys.join(', ')})
      VALUES (?, ${placeholders})
    `);
    return stmt.run(userId, ...values);
  },
  update: (id, userId, data) => {
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, userId);
    const stmt = getDb().prepare(`UPDATE publish_tasks SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`);
    return stmt.run(...values);
  },
  getById: (id, userId) => {
    return getDb().prepare('SELECT * FROM publish_tasks WHERE id = ? AND user_id = ?').get(id, userId);
  },
  getActive: () => {
    return getDb().prepare("SELECT * FROM publish_tasks WHERE status = 'running'").all();
  },
  getAll: (userId) => {
    return getDb().prepare('SELECT * FROM publish_tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  },
  delete: (id, userId) => {
    return getDb().prepare('DELETE FROM publish_tasks WHERE id = ? AND user_id = ?').run(id, userId);
  }
};

const logQueries = {
  add: (userId, taskId, accountId, targetId, adId, result, detail) => {
    const stmt = getDb().prepare(`
      INSERT INTO publish_logs (user_id, task_id, account_id, target_id, ad_id, result, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(userId, taskId, accountId, targetId, adId, result, detail);
  },
  getRecent: (userId, limit = 50) => {
    return getDb().prepare(`
      SELECT l.*, a.text_content as ad_text, acc.phone as account_phone
      FROM publish_logs l
      LEFT JOIN publish_ads a ON l.ad_id = a.id
      LEFT JOIN accounts acc ON l.account_id = acc.id
      WHERE l.user_id = ?
      ORDER BY l.created_at DESC
      LIMIT ?
    `).all(userId, limit);
  },
  getStats: (userId, taskId) => {
    const db = getDb();
    const success = db.prepare("SELECT COUNT(*) as c FROM publish_logs WHERE user_id = ? AND task_id = ? AND result = 'success'").get(userId, taskId).c;
    const failed = db.prepare("SELECT COUNT(*) as c FROM publish_logs WHERE user_id = ? AND task_id = ? AND result = 'failed'").get(userId, taskId).c;
    return { success, failed };
  }
};

module.exports = {
  initPublishSchema,
  adQueries,
  taskQueries,
  logQueries
};
