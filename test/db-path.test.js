const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { DEFAULT_DB_FILENAME, RENDER_PERSISTENT_DIR, resolveDbPath } = require('../server/db-path');

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
