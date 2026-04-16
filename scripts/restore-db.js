#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function resolveTargetDbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'pockettab.db');
}

function resolveBackupPath() {
  const argPath = process.argv[2];
  if (!argPath) {
    throw new Error('Backup file path is required. Usage: npm run restore:db -- /absolute/path/to/backup.db');
  }

  return path.resolve(argPath);
}

function restoreDatabase() {
  const backupPath = resolveBackupPath();
  const targetPath = resolveTargetDbPath();
  const targetDir = path.dirname(targetPath);

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const previousPath = `${targetPath}.pre-restore-${timestamp}.bak`;
  const tempPath = `${targetPath}.restoring-${timestamp}.tmp`;

  fs.copyFileSync(backupPath, tempPath);
  if (fs.existsSync(targetPath)) {
    fs.renameSync(targetPath, previousPath);
  }
  fs.renameSync(tempPath, targetPath);

  console.log(
    JSON.stringify({
      ok: true,
      restoredFrom: backupPath,
      targetPath,
      previousSnapshot: fs.existsSync(previousPath) ? previousPath : null
    })
  );
}

try {
  restoreDatabase();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
