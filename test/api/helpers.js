const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.PIN_PEPPER = 'test-pin-pepper-0123456789abcdef0123456789abcdef';
process.env.DB_PATH = path.join(os.tmpdir(), `pockettab-test-${crypto.randomUUID()}.db`);
process.env.ALLOW_DATA_RESET = 'false';
process.env.DATA_RESET_SECRET = 'test-reset-secret';
process.env.DISABLE_RATE_LIMIT = 'true';

const app = require('../../server/app');
const db = require('../../server/db');

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerUser(name, pin) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name, pin });

  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.ok(res.body.user?.id);

  return res.body;
}

async function loginUser(userId, pin) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ userId, pin });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  return res.body;
}

function createSeededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pickOne(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

const serverRoot = path.join(__dirname, '..', '..', 'server') + path.sep;

function clearServerRequireCache() {
  for (const modulePath of Object.keys(require.cache)) {
    if (modulePath.startsWith(serverRoot)) {
      delete require.cache[modulePath];
    }
  }
}

function loadIsolatedApp(envOverrides) {
  const previous = new Map();

  for (const [key, value] of Object.entries(envOverrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = String(value);
  }

  clearServerRequireCache();
  const isolatedApp = require('../../server/app');
  const isolatedDb = require('../../server/db');

  return {
    app: isolatedApp,
    db: isolatedDb,
    cleanup() {
      try {
        isolatedDb.close();
      } catch (err) {
        // Ignore close errors in tests.
      }

      clearServerRequireCache();

      for (const [key, oldValue] of previous.entries()) {
        if (typeof oldValue === 'undefined') {
          delete process.env[key];
        } else {
          process.env[key] = oldValue;
        }
      }
    }
  };
}

module.exports = {
  test,
  assert,
  path,
  os,
  crypto,
  request,
  bcrypt,
  fs,
  app,
  db,
  uniqueSuffix,
  auth,
  registerUser,
  loginUser,
  createSeededRng,
  randomInt,
  pickOne,
  loadIsolatedApp
};
