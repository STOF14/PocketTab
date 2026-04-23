const {
  test,
  assert,
  path,
  os,
  crypto,
  request,
  fs,
  uniqueSuffix,
  loadIsolatedApp
} = require('./helpers');

test('google oauth start sets state cookie and redirects to google authorize endpoint', async () => {
  const isolatedDbPath = path.join(os.tmpdir(), `pockettab-google-start-${crypto.randomUUID()}.db`);
  const isolated = loadIsolatedApp({
    NODE_ENV: 'test',
    JWT_SECRET: 'google-start-secret',
    PIN_PEPPER: process.env.PIN_PEPPER,
    DB_PATH: isolatedDbPath,
    DISABLE_RATE_LIMIT: 'true',
    ALLOW_DATA_RESET: 'false',
    DATA_RESET_SECRET: process.env.DATA_RESET_SECRET,
    GOOGLE_CLIENT_ID: 'google-client-id-123.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'google-client-secret-123'
  });

  try {
    const res = await request(isolated.app).get('/api/auth/google/start');
    assert.equal(res.status, 302);
    assert.ok(typeof res.headers.location === 'string');
    assert.match(res.headers.location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/i);

    const redirectUrl = new URL(res.headers.location);
    assert.equal(redirectUrl.searchParams.get('client_id'), 'google-client-id-123.apps.googleusercontent.com');
    assert.equal(redirectUrl.searchParams.get('response_type'), 'code');
    assert.equal(redirectUrl.searchParams.get('scope'), 'openid email profile');
    assert.ok(redirectUrl.searchParams.get('state'));

    const stateCookies = (res.headers['set-cookie'] || []).filter((value) => value.startsWith('pt_google_oauth_state='));
    assert.equal(stateCookies.length, 1);
    assert.match(stateCookies[0], /HttpOnly/i);
    assert.match(stateCookies[0], /SameSite=Lax/i);
  } finally {
    isolated.cleanup();
    if (fs.existsSync(isolatedDbPath)) fs.unlinkSync(isolatedDbPath);
    if (fs.existsSync(`${isolatedDbPath}-wal`)) fs.unlinkSync(`${isolatedDbPath}-wal`);
    if (fs.existsSync(`${isolatedDbPath}-shm`)) fs.unlinkSync(`${isolatedDbPath}-shm`);
  }
});

test('google oauth callback creates session and redirects to app URL', async () => {
  const isolatedDbPath = path.join(os.tmpdir(), `pockettab-google-callback-${crypto.randomUUID()}.db`);
  const isolated = loadIsolatedApp({
    NODE_ENV: 'test',
    JWT_SECRET: 'google-callback-secret',
    PIN_PEPPER: process.env.PIN_PEPPER,
    DB_PATH: isolatedDbPath,
    DISABLE_RATE_LIMIT: 'true',
    ALLOW_DATA_RESET: 'false',
    DATA_RESET_SECRET: process.env.DATA_RESET_SECRET,
    GOOGLE_CLIENT_ID: 'google-client-id-123.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'google-client-secret-123'
  });

  const originalFetch = global.fetch;
  const { OAuth2Client } = require('google-auth-library');
  const originalVerifyIdToken = OAuth2Client.prototype.verifyIdToken;

  try {
    global.fetch = async () => ({
      ok: true,
      async json() {
        return { id_token: 'fake-google-id-token' };
      }
    });

    OAuth2Client.prototype.verifyIdToken = async function verifyIdTokenMock(args) {
      assert.equal(args.audience, 'google-client-id-123.apps.googleusercontent.com');
      assert.equal(args.idToken, 'fake-google-id-token');
      return {
        getPayload() {
          return {
            sub: 'google-sub-123',
            email: 'tester@example.com',
            email_verified: true,
            name: 'Google Tester'
          };
        }
      };
    };

    const agent = request.agent(isolated.app);
    const start = await agent.get('/api/auth/google/start');
    assert.equal(start.status, 302);

    const redirectUrl = new URL(start.headers.location);
    const state = redirectUrl.searchParams.get('state');
    assert.ok(state);

    const callback = await agent.get(`/api/auth/google/callback?code=fake-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.location, '/app');

    const callbackCookies = callback.headers['set-cookie'] || [];
    assert.ok(callbackCookies.some((value) => value.startsWith('pt_session=')));

    const me = await agent.get('/api/users/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.name, 'Google Tester');
    assert.equal(me.body.role, 'admin');

    const linkedUser = isolated.db.prepare('SELECT google_sub, google_email FROM users WHERE id = ?').get(me.body.id);
    assert.equal(linkedUser.google_sub, 'google-sub-123');
    assert.equal(linkedUser.google_email, 'tester@example.com');
  } finally {
    global.fetch = originalFetch;
    OAuth2Client.prototype.verifyIdToken = originalVerifyIdToken;
    isolated.cleanup();
    if (fs.existsSync(isolatedDbPath)) fs.unlinkSync(isolatedDbPath);
    if (fs.existsSync(`${isolatedDbPath}-wal`)) fs.unlinkSync(`${isolatedDbPath}-wal`);
    if (fs.existsSync(`${isolatedDbPath}-shm`)) fs.unlinkSync(`${isolatedDbPath}-shm`);
  }
});

test('google oauth callback rejects invalid state and does not authenticate', async () => {
  const isolatedDbPath = path.join(os.tmpdir(), `pockettab-google-state-${crypto.randomUUID()}.db`);
  const isolated = loadIsolatedApp({
    NODE_ENV: 'test',
    JWT_SECRET: 'google-state-secret',
    PIN_PEPPER: process.env.PIN_PEPPER,
    DB_PATH: isolatedDbPath,
    DISABLE_RATE_LIMIT: 'true',
    ALLOW_DATA_RESET: 'false',
    DATA_RESET_SECRET: process.env.DATA_RESET_SECRET,
    GOOGLE_CLIENT_ID: 'google-client-id-123.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'google-client-secret-123'
  });

  try {
    const agent = request.agent(isolated.app);
    const start = await agent.get('/api/auth/google/start');
    assert.equal(start.status, 302);

    const callback = await agent.get('/api/auth/google/callback?code=fake-code&state=wrong-state');
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.location, '/app?auth_error=google_state_mismatch');

    const me = await agent.get('/api/users/me');
    assert.equal(me.status, 401);
  } finally {
    isolated.cleanup();
    if (fs.existsSync(isolatedDbPath)) fs.unlinkSync(isolatedDbPath);
    if (fs.existsSync(`${isolatedDbPath}-wal`)) fs.unlinkSync(`${isolatedDbPath}-wal`);
    if (fs.existsSync(`${isolatedDbPath}-shm`)) fs.unlinkSync(`${isolatedDbPath}-shm`);
  }
});

test('google status endpoint reflects configuration', async () => {
  const notConfiguredDbPath = path.join(os.tmpdir(), `pockettab-google-status-off-${crypto.randomUUID()}.db`);
  const configuredDbPath = path.join(os.tmpdir(), `pockettab-google-status-on-${crypto.randomUUID()}.db`);
  try {
    const noGoogle = loadIsolatedApp({
      NODE_ENV: 'test',
      JWT_SECRET: 'google-status-off-secret',
      PIN_PEPPER: process.env.PIN_PEPPER,
      DB_PATH: notConfiguredDbPath,
      DISABLE_RATE_LIMIT: 'true',
      ALLOW_DATA_RESET: 'false',
      DATA_RESET_SECRET: process.env.DATA_RESET_SECRET,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: ''
    });
    const disabled = await request(noGoogle.app).get('/api/auth/google/status');
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.enabled, false);
    noGoogle.cleanup();

    const withGoogle = loadIsolatedApp({
      NODE_ENV: 'test',
      JWT_SECRET: 'google-status-on-secret',
      PIN_PEPPER: process.env.PIN_PEPPER,
      DB_PATH: configuredDbPath,
      DISABLE_RATE_LIMIT: 'true',
      ALLOW_DATA_RESET: 'false',
      DATA_RESET_SECRET: process.env.DATA_RESET_SECRET,
      GOOGLE_CLIENT_ID: 'google-client-id-123.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'google-client-secret-123'
    });
    const enabled = await request(withGoogle.app).get('/api/auth/google/status');
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.enabled, true);
    withGoogle.cleanup();
  } finally {
    for (const dbFile of [notConfiguredDbPath, configuredDbPath]) {
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
      if (fs.existsSync(`${dbFile}-wal`)) fs.unlinkSync(`${dbFile}-wal`);
      if (fs.existsSync(`${dbFile}-shm`)) fs.unlinkSync(`${dbFile}-shm`);
    }
  }
});

test('google link flow links current authenticated user and keeps session', async () => {
  const isolatedDbPath = path.join(os.tmpdir(), `pockettab-google-link-${crypto.randomUUID()}.db`);
  const isolated = loadIsolatedApp({
    NODE_ENV: 'test',
    JWT_SECRET: 'google-link-secret',
    PIN_PEPPER: process.env.PIN_PEPPER,
    DB_PATH: isolatedDbPath,
    DISABLE_RATE_LIMIT: 'true',
    ALLOW_DATA_RESET: 'false',
    DATA_RESET_SECRET: process.env.DATA_RESET_SECRET,
    GOOGLE_CLIENT_ID: 'google-client-id-123.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'google-client-secret-123'
  });

  const originalFetch = global.fetch;
  const { OAuth2Client } = require('google-auth-library');
  const originalVerifyIdToken = OAuth2Client.prototype.verifyIdToken;

  try {
    global.fetch = async () => ({
      ok: true,
      async json() {
        return { id_token: 'fake-google-link-id-token' };
      }
    });

    OAuth2Client.prototype.verifyIdToken = async function verifyIdTokenMock() {
      return {
        getPayload() {
          return {
            sub: 'google-sub-link-123',
            email: 'linker@example.com',
            email_verified: true,
            name: 'Linked Account'
          };
        }
      };
    };

    const agent = request.agent(isolated.app);
    const register = await agent
      .post('/api/auth/register')
      .send({
        name: `LinkUser-${uniqueSuffix()}`,
        pin: '1122',
        createHousehold: true,
        householdName: `Link Household ${uniqueSuffix()}`
      });
    assert.equal(register.status, 201);

    const linkStatusBefore = await agent.get('/api/auth/google/link/status');
    assert.equal(linkStatusBefore.status, 200);
    assert.equal(linkStatusBefore.body.linked, false);

    const start = await agent.get('/api/auth/google/link/start');
    assert.equal(start.status, 302);
    assert.match(start.headers.location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/i);
    const redirectUrl = new URL(start.headers.location);
    const state = redirectUrl.searchParams.get('state');
    assert.ok(state);

    const callback = await agent.get(`/api/auth/google/callback?code=fake-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.location, '/app?auth_link=google_success');

    const me = await agent.get('/api/users/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.id, register.body.user.id);

    const linkStatusAfter = await agent.get('/api/auth/google/link/status');
    assert.equal(linkStatusAfter.status, 200);
    assert.equal(linkStatusAfter.body.linked, true);
    assert.equal(linkStatusAfter.body.email, 'linker@example.com');

    const linkedUser = isolated.db.prepare('SELECT google_sub, google_email FROM users WHERE id = ?').get(register.body.user.id);
    assert.equal(linkedUser.google_sub, 'google-sub-link-123');
    assert.equal(linkedUser.google_email, 'linker@example.com');
  } finally {
    global.fetch = originalFetch;
    OAuth2Client.prototype.verifyIdToken = originalVerifyIdToken;
    isolated.cleanup();
    if (fs.existsSync(isolatedDbPath)) fs.unlinkSync(isolatedDbPath);
    if (fs.existsSync(`${isolatedDbPath}-wal`)) fs.unlinkSync(`${isolatedDbPath}-wal`);
    if (fs.existsSync(`${isolatedDbPath}-shm`)) fs.unlinkSync(`${isolatedDbPath}-shm`);
  }
});
