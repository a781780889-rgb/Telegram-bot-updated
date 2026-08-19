const { createPersistenceBackup } = require('../src/database/db');
const { getPersistenceHealth } = require('../src/services/persistenceHealth');

try {
  const healthBefore = getPersistenceHealth();
  const backup = createPersistenceBackup('pre-deploy');
  if (healthBefore.database !== true) throw new Error('Database is not readable');
  if (healthBefore.schemaVersion < 1) throw new Error('Schema version is invalid');
  if (!backup?.database) throw new Error('Database backup was not created');
  console.log(JSON.stringify({ ok: true, health: healthBefore, backup }, null, 2));
} catch (error) {
  console.error(`[PRE-DEPLOY] FAILED: ${error.message}`);
  process.exitCode = 1;
}
