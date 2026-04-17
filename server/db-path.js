const fs = require('fs');
const path = require('path');

const RENDER_PERSISTENT_DIR = '/var/data';
const DEFAULT_DB_FILENAME = 'pockettab.db';

function hasNonEmptyValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function resolveDbPath(options = {}) {
  const {
    nodeEnv = process.env.NODE_ENV,
    dbPathEnv = process.env.DB_PATH,
    isRender = Boolean(process.env.RENDER),
    renderPersistentDirExists = fs.existsSync(RENDER_PERSISTENT_DIR),
    onWarn = (message) => console.warn(message)
  } = options;

  if (hasNonEmptyValue(dbPathEnv)) {
    return dbPathEnv;
  }

  if (nodeEnv === 'production') {
    if (isRender && renderPersistentDirExists) {
      const fallbackPath = path.join(RENDER_PERSISTENT_DIR, DEFAULT_DB_FILENAME);
      onWarn(`[db] DB_PATH is not set; defaulting to ${fallbackPath} on Render.`);
      return fallbackPath;
    }

    throw new Error(
      'DB_PATH is required when NODE_ENV=production. For Render, set DB_PATH to your mounted disk path (for example /var/data/pockettab.db).'
    );
  }

  return path.join(__dirname, '..', DEFAULT_DB_FILENAME);
}

function ensureDbDirectory(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

module.exports = {
  DEFAULT_DB_FILENAME,
  RENDER_PERSISTENT_DIR,
  ensureDbDirectory,
  resolveDbPath
};