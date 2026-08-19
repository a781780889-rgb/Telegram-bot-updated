const fs = require('fs');
const path = require('path');
const { getDb } = require('../database/db');

const persistentRoot = process.env.PERSISTENT_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH;
const databasePath = process.env.DATABASE_PATH || process.env.DB_PATH || (persistentRoot ? path.join(persistentRoot, 'database', 'bot.db') : './data/database/bot.db');
const sessionsPath = process.env.SESSIONS_PATH || process.env.SESSIONS_DIR || (persistentRoot ? path.join(persistentRoot, 'sessions') : './data/sessions');
const backupPath = process.env.BACKUP_PATH || process.env.DATA_BACKUP_DIR || (persistentRoot ? path.join(persistentRoot, 'backups') : path.join(path.dirname(databasePath), 'backups'));

const count = (db, table) => {
  try { return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; } catch (_) { return null; }
};

const getPersistenceHealth = () => {
  const db = getDb();
  const migrations = db.prepare('SELECT MAX(version) AS version, COUNT(*) AS count FROM schema_migrations').get();
  const encryptedSessions = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE encrypted_session IS NOT NULL AND encrypted_session != ''").get().count;
  const filesOnDisk = fs.existsSync(sessionsPath)
    ? fs.readdirSync(sessionsPath, { withFileTypes: true }).filter((entry) => entry.isFile()).length
    : 0;
  return {
    database: fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0,
    databasePath,
    users: count(db, 'bot_users'),
    activeSubscriptions: (() => { try { return db.prepare('SELECT COUNT(*) AS count FROM bot_users WHERE is_activated = 1').get().count; } catch (_) { return null; } })(),
    telegramAccounts: count(db, 'accounts'),
    sessionsInDatabase: encryptedSessions,
    sessionFiles: filesOnDisk,
    tasks: count(db, 'publish_tasks'),
    schemaVersion: migrations.version || 0,
    migrations: migrations.count,
    storage: [path.dirname(databasePath), path.dirname(sessionsPath), path.dirname(backupPath)].every((directory) => fs.existsSync(directory)),
    backup: fs.existsSync(backupPath),
    sessionsPath,
    backupPath,
  };
};

const formatPersistenceHealth = (health) => [
  '🩺 *فحص سلامة النظام*',
  '',
  `${health.database ? '✅' : '❌'} قاعدة البيانات: ${health.database ? 'OK' : 'غير متاحة'}`,
  `${health.storage ? '✅' : '❌'} التخزين: ${health.storage ? 'OK' : 'غير مكتمل'}`,
  `👥 المستخدمون: ${health.users}`,
  `🎟️ الاشتراكات النشطة: ${health.activeSubscriptions}`,
  `📱 حسابات Telegram: ${health.telegramAccounts}`,
  `🔐 Sessions داخل قاعدة البيانات: ${health.sessionsInDatabase}`,
  `📄 ملفات Sessions على القرص: ${health.sessionFiles}`,
  `📋 المهام: ${health.tasks}`,
  `🗃️ Schema version: ${health.schemaVersion}`,
  `${health.backup ? '✅' : '⚠️'} النسخ الاحتياطية: ${health.backup ? 'OK' : 'لم يُنشأ مجلد النسخ بعد'}`,
].join('\n');

module.exports = { getPersistenceHealth, formatPersistenceHealth };
