const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  DEFAULT_DB_FILENAME,
  RENDER_PERSISTENT_DIR,
  detectRenderEnvironment,
  resolveDbPath
} = require('../server/db-path');

test('resolveDbPath uses project-local default outside production', () => {
  const resolved = resolveDbPath({
    nodeEnv: 'development',
    dbPathEnv: ''
  });

  assert.equal(resolved, path.join(__dirname, '..', DEFAULT_DB_FILENAME));
});

test('resolveDbPath throws in production when DB_PATH is missing and Render fallback is unavailable', () => {
  assert.throws(
    () => resolveDbPath({
      nodeEnv: 'production',
      dbPathEnv: '',
      isRender: false,
      renderPersistentDirExists: false,
      onWarn: () => {}
    }),
    /DB_PATH is required when NODE_ENV=production/
  );
});

test('detectRenderEnvironment detects Render by environment variable prefix', () => {
  assert.equal(detectRenderEnvironment({ RENDER_SERVICE_ID: 'srv-123' }, '/tmp'), true);
});

test('detectRenderEnvironment detects Render by cwd path', () => {
  assert.equal(detectRenderEnvironment({}, '/opt/render/project/src'), true);
});

test('resolveDbPath falls back to Render persistent disk path in production', () => {
  let warning = '';

  const resolved = resolveDbPath({
    nodeEnv: 'production',
    dbPathEnv: '',
    isRender: true,
    renderPersistentDirExists: true,
    onWarn: (message) => {
      warning = message;
    }
  });

  assert.equal(resolved, path.join(RENDER_PERSISTENT_DIR, DEFAULT_DB_FILENAME));
  assert.match(warning, /defaulting to \/var\/data\/pockettab\.db/);
});

test('resolveDbPath uses cwd fallback on Render when /var/data is unavailable', () => {
  let warning = '';

  const resolved = resolveDbPath({
    nodeEnv: 'production',
    dbPathEnv: '',
    isRender: true,
    cwd: '/opt/render/project/src',
    renderPersistentDirExists: false,
    onWarn: (message) => {
      warning = message;
    }
  });

  assert.equal(resolved, '/opt/render/project/src/pockettab.db');
  assert.match(warning, /ephemeral storage/);
});
