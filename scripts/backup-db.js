#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { resolveDbPath } = require('../server/db-path');

function timestampForFilename(date) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-${pad(date.getUTCMilliseconds(), 3)}`;
}

function parseKeepCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 14;
  }
  return parsed;
}

async function backupDatabase() {
  const dbPath = resolveDbPath();
  const backupDir = process.env.DB_BACKUP_DIR || path.join(__dirname, '..', 'backups');
  const keepCount = parseKeepCount(process.env.DB_BACKUP_KEEP);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }

  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = timestampForFilename(new Date());
  const fileName = `pockettab-${stamp}-${crypto.randomBytes(3).toString('hex')}.db`;
  const backupPath = path.join(backupDir, fileName);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(backupPath);
  } finally {
    db.close();
  }

  const backups = fs
    .readdirSync(backupDir)
    .filter((name) => name.startsWith('pockettab-') && name.endsWith('.db'))
    .map((name) => ({
      name,
      fullPath: path.join(backupDir, name),
      mtimeMs: fs.statSync(path.join(backupDir, name)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = [];
  for (let i = keepCount; i < backups.length; i += 1) {
    fs.unlinkSync(backups[i].fullPath);
    removed.push(backups[i].name);
  }

  const result = {
    ok: true,
    dbPath,
    backupPath,
    keepCount,
    removed
  };

  console.log(JSON.stringify(result));
}

backupDatabase().catch((err) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: err.message
    })
  );
  process.exit(1);
});
