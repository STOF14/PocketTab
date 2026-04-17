#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function findLatestBackup(backupDir) {
  const candidates = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith('pockettab-') && name.endsWith('.db'))
    .map((name) => ({
      name,
      fullPath: path.join(backupDir, name),
      mtimeMs: fs.statSync(path.join(backupDir, name)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0] || null;
}

function runVerification() {
  const backupDir = process.env.DB_BACKUP_DIR || path.join(__dirname, '..', 'backups');
  const backupFile = process.env.DB_BACKUP_FILE || null;

  if (!fs.existsSync(backupDir)) {
    throw new Error(`Backup directory not found: ${backupDir}`);
  }

  const selectedBackup = backupFile
    ? { fullPath: path.resolve(backupFile), name: path.basename(backupFile) }
    : findLatestBackup(backupDir);

  if (!selectedBackup || !fs.existsSync(selectedBackup.fullPath)) {
    throw new Error('No backup file found to verify');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pockettab-restore-'));
  const restorePath = path.join(tempDir, 'restore.db');
  fs.copyFileSync(selectedBackup.fullPath, restorePath);

  let db;
  try {
    db = new Database(restorePath, { readonly: true, fileMustExist: true });
    const integrityRows = db.prepare('PRAGMA integrity_check').all();
    const integrity = integrityRows[0]?.integrity_check || 'unknown';
    if (integrity !== 'ok') {
      throw new Error(`Integrity check failed: ${integrity}`);
    }

    const tableCount = db.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table'").get().total;

    const result = {
      ok: true,
      backupFile: selectedBackup.fullPath,
      restoredFile: restorePath,
      integrity,
      tableCount
    };

    console.log(JSON.stringify(result));
  } finally {
    if (db) {
      db.close();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  runVerification();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
