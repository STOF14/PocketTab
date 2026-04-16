#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function run() {
  const backupDir = process.env.DB_BACKUP_DIR || path.join(__dirname, '..', 'backups');
  const minCount = parsePositiveInt(process.env.DB_BACKUP_MIN_COUNT, 1);
  const maxAgeHours = parsePositiveInt(process.env.DB_BACKUP_MAX_AGE_HOURS, 30);
  const now = Date.now();

  const backups = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir)
      .filter((name) => name.startsWith('pockettab-') && name.endsWith('.db'))
      .map((name) => {
        const fullPath = path.join(backupDir, name);
        return {
          name,
          fullPath,
          mtimeMs: fs.statSync(fullPath).mtimeMs
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    : [];

  if (backups.length < minCount) {
    throw new Error(`Expected at least ${minCount} backup file(s), found ${backups.length} in ${backupDir}`);
  }

  const latest = backups[0];
  const latestAgeHours = (now - latest.mtimeMs) / (1000 * 60 * 60);
  if (latestAgeHours > maxAgeHours) {
    throw new Error(`Latest backup (${latest.name}) is ${latestAgeHours.toFixed(2)}h old (max allowed: ${maxAgeHours}h)`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      backupDir,
      total: backups.length,
      latest: latest.name,
      latestAgeHours: Number(latestAgeHours.toFixed(2)),
      minCount,
      maxAgeHours
    })
  );
}

try {
  run();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
