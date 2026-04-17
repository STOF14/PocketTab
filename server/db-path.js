const fs = require('fs');
const path = require('path');

const RENDER_PERSISTENT_DIR = '/var/data';
const DEFAULT_DB_FILENAME = 'pockettab.db';
const RENDER_PATH_PREFIX = '/opt/render/';

function hasNonEmptyValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function detectRenderEnvironment(env = process.env, cwd = process.cwd()) {
  if (env.RENDER === 'true') return true;
  if (Object.keys(env).some((key) => key.startsWith('RENDER_'))) return true;
  return typeof cwd === 'string' && cwd.startsWith(RENDER_PATH_PREFIX);
}

function resolveDbPath(options = {}) {
  const {
    nodeEnv = process.env.NODE_ENV,
    dbPathEnv = process.env.DB_PATH,
    isRender = detectRenderEnvironment(),
    cwd = process.cwd(),
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

    if (isRender) {
      const fallbackPath = path.join(cwd, DEFAULT_DB_FILENAME);
      onWarn(
        `[db] DB_PATH is not set and /var/data is unavailable; defaulting to ${fallbackPath} on Render (ephemeral storage). Mount a persistent disk and set DB_PATH for durable data.`
      );
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
  detectRenderEnvironment,
  ensureDbDirectory,
  resolveDbPath
};