const {
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
  loadIsolatedApp
} = require('./helpers');

test('legacy PIN hashes are rehashed on successful login', async () => {
  const suffix = uniqueSuffix();
  const registration = await registerUser(`Legacy-${suffix}`, '5555');
  const legacyHash = bcrypt.hashSync('5555', 10);

  db.prepare('UPDATE users SET pin_hash = ?, pin_hash_needs_rehash = 1 WHERE id = ?').run(legacyHash, registration.user.id);

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ userId: registration.user.id, pin: '5555' });
  assert.equal(loginRes.status, 200);

  const row = db.prepare('SELECT pin_hash, pin_hash_needs_rehash FROM users WHERE id = ?').get(registration.user.id);
  assert.equal(row.pin_hash_needs_rehash, 0);
  assert.ok(bcrypt.getRounds(row.pin_hash) >= 12);
  assert.equal(bcrypt.compareSync(`5555${process.env.PIN_PEPPER}`, row.pin_hash), true);
});

test('pin change response instructs client to clear token and relogin', async () => {
  const user = await registerUser(`PinRotate-${uniqueSuffix()}`, '1212');
  const changeRes = await request(app)
    .patch('/api/users/pin')
    .set(auth(user.token))
    .send({ oldPin: '1212', newPin: '3434' });

  assert.equal(changeRes.status, 200);
  assert.equal(changeRes.body.sessionRevoked, true);
  assert.equal(changeRes.body.nextAction, 'clear_token_and_redirect_to_login');
});

test('user can update own username when household name is unique', async () => {
  const suffix = uniqueSuffix();
  const admin = await request(app)
    .post('/api/auth/register')
    .send({
      name: `RenameAdmin-${suffix}`,
      pin: '1234',
      createHousehold: true,
      householdName: `Rename Household ${suffix}`
    });
  assert.equal(admin.status, 201);

  const rename = await request(app)
    .patch('/api/users/me/name')
    .set(auth(admin.body.token))
    .send({ newName: `Renamed-${suffix}` });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.user.name, `Renamed-${suffix}`);

  const me = await request(app)
    .get('/api/users/me')
    .set(auth(admin.body.token));
  assert.equal(me.status, 200);
  assert.equal(me.body.name, `Renamed-${suffix}`);
});

test('username updates reject duplicates and admin can reset member credentials', async () => {
  const suffix = uniqueSuffix();
  const admin = await request(app)
    .post('/api/auth/register')
    .send({
      name: `CredAdmin-${suffix}`,
      pin: '1111',
      createHousehold: true,
      householdName: `Cred Household ${suffix}`
    });
  assert.equal(admin.status, 201);

  const invite = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(admin.body.token))
    .send({ ttlHours: 24 });
  assert.equal(invite.status, 201);

  const child = await request(app)
    .post('/api/auth/register')
    .send({ name: `CredChild-${suffix}`, pin: '2222', inviteCode: invite.body.code });
  assert.equal(child.status, 201);

  const duplicateRename = await request(app)
    .patch('/api/users/me/name')
    .set(auth(child.body.token))
    .send({ newName: `CredAdmin-${suffix}` });
  assert.equal(duplicateRename.status, 400);

  const reset = await request(app)
    .patch(`/api/users/${child.body.user.id}/credentials-reset`)
    .set(auth(admin.body.token))
    .send({ newName: `CredChildReset-${suffix}`, newPin: '3333' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.updated.username, true);
  assert.equal(reset.body.updated.pin, true);

  const loginWithOldPin = await request(app)
    .post('/api/auth/login')
    .send({ userId: child.body.user.id, pin: '2222' });
  assert.equal(loginWithOldPin.status, 401);

  const loginWithNewPin = await request(app)
    .post('/api/auth/login')
    .send({ userId: child.body.user.id, pin: '3333' });
  assert.equal(loginWithNewPin.status, 200);
});

test('auth rate limit persists across app restarts', async () => {
  const isolatedDbPath = path.join(os.tmpdir(), `pockettab-rate-limit-${crypto.randomUUID()}.db`);
  const baseEnv = {
    NODE_ENV: 'development',
    JWT_SECRET: 'rate-limit-test-secret',
    PIN_PEPPER: 'rate-limit-pepper-0123456789abcdef0123456789abcdef',
    DB_PATH: isolatedDbPath,
    DISABLE_RATE_LIMIT: 'false',
    RATE_LIMIT_WINDOW_MS: '600000',
    AUTH_RATE_LIMIT_MAX: '2',
    GLOBAL_RATE_LIMIT_MAX: '1000'
  };

  const firstBoot = loadIsolatedApp(baseEnv);
  try {
    const first = await request(firstBoot.app)
      .post('/api/auth/login')
      .send({ userId: 'missing-user', pin: '0000' });
    const second = await request(firstBoot.app)
      .post('/api/auth/login')
      .send({ userId: 'missing-user', pin: '0000' });
    const limited = await request(firstBoot.app)
      .post('/api/auth/login')
      .send({ userId: 'missing-user', pin: '0000' });

    assert.notEqual(first.status, 429);
    assert.notEqual(second.status, 429);
    assert.equal(limited.status, 429);
  } finally {
    firstBoot.cleanup();
  }

  const secondBoot = loadIsolatedApp(baseEnv);
  try {
    const stillLimited = await request(secondBoot.app)
      .post('/api/auth/login')
      .send({ userId: 'missing-user', pin: '0000' });
    assert.equal(stillLimited.status, 429);
  } finally {
    secondBoot.cleanup();
    if (fs.existsSync(isolatedDbPath)) {
      fs.unlinkSync(isolatedDbPath);
    }
    if (fs.existsSync(`${isolatedDbPath}-wal`)) {
      fs.unlinkSync(`${isolatedDbPath}-wal`);
    }
    if (fs.existsSync(`${isolatedDbPath}-shm`)) {
      fs.unlinkSync(`${isolatedDbPath}-shm`);
    }
  }
});

test('multi-device session revoke invalidates only one token at a time', async () => {
  const user = await registerUser(`SessionEdge-${uniqueSuffix()}`, '7171');
  const secondLogin = await loginUser(user.user.id, '7171');

  const sessionList = await request(app)
    .get('/api/users/sessions')
    .set(auth(user.token));
  assert.equal(sessionList.status, 200);
  assert.ok(sessionList.body.length >= 2);

  const newestSession = sessionList.body[0];
  const revokeOne = await request(app)
    .delete(`/api/users/sessions/${newestSession.id}`)
    .set(auth(user.token));
  assert.equal(revokeOne.status, 200);

  const profileViaTokenA = await request(app)
    .get('/api/users/me')
    .set(auth(user.token));
  const profileViaTokenB = await request(app)
    .get('/api/users/me')
    .set(auth(secondLogin.token));

  const statusSet = [profileViaTokenA.status, profileViaTokenB.status].sort((a, b) => a - b);
  assert.deepEqual(statusSet, [200, 403]);

  const survivorToken = profileViaTokenA.status === 200 ? user.token : secondLogin.token;
  const survivorSessions = await request(app)
    .get('/api/users/sessions')
    .set(auth(survivorToken));
  assert.equal(survivorSessions.status, 200);
  assert.ok(survivorSessions.body.length >= 1);
});

test('session cookies are issued on register/login and support cookie-based auth', async () => {
  const suffix = uniqueSuffix();
  const agent = request.agent(app);

  const registration = await agent
    .post('/api/auth/register')
    .send({
      name: `CookieSession-${suffix}`,
      pin: '1122',
      createHousehold: true,
      householdName: `Cookie Household ${suffix}`
    });
  assert.equal(registration.status, 201);

  const registerCookies = registration.headers['set-cookie'] || [];
  assert.ok(registerCookies.some((value) => value.startsWith('pt_session=')));
  assert.ok(registerCookies.some((value) => /HttpOnly/i.test(value)));
  assert.ok(registerCookies.some((value) => /SameSite=Strict/i.test(value)));

  const meFromCookie = await agent.get('/api/users/me');
  assert.equal(meFromCookie.status, 200);
  assert.equal(meFromCookie.body.id, registration.body.user.id);

  const login = await request(app)
    .post('/api/auth/login')
    .send({ userId: registration.body.user.id, pin: '1122' });
  assert.equal(login.status, 200);

  const loginCookies = login.headers['set-cookie'] || [];
  assert.ok(loginCookies.some((value) => value.startsWith('pt_session=')));

  const logout = await agent.post('/api/auth/logout');
  assert.equal(logout.status, 200);

  const meAfterLogout = await agent.get('/api/users/me');
  assert.equal(meAfterLogout.status, 401);
});

test('production mode blocks implicit household join and requires household access token for login', async () => {
  const isolatedDbPath = path.join(os.tmpdir(), `pockettab-prod-auth-${crypto.randomUUID()}.db`);
  const isolated = loadIsolatedApp({
    NODE_ENV: 'production',
    JWT_SECRET: 'prod-test-jwt-secret',
    PIN_PEPPER: process.env.PIN_PEPPER,
    DB_PATH: isolatedDbPath,
    DISABLE_RATE_LIMIT: 'true',
    ALLOW_DATA_RESET: 'false',
    DATA_RESET_SECRET: process.env.DATA_RESET_SECRET
  });

  try {
    const suffix = uniqueSuffix();

    const implicitJoin = await request(isolated.app)
      .post('/api/auth/register')
      .send({ name: `ProdImplicit-${suffix}`, pin: '1111' });
    assert.equal(implicitJoin.status, 400);
    assert.match(implicitJoin.body.error, /inviteCode|createHousehold/i);

    const admin = await request(isolated.app)
      .post('/api/auth/register')
      .send({
        name: `ProdAdmin-${suffix}`,
        pin: '2222',
        createHousehold: true,
        householdName: `Prod Household ${suffix}`
      });
    assert.equal(admin.status, 201);

    const loginWithoutHouseholdAccess = await request(isolated.app)
      .post('/api/auth/login')
      .send({ userId: admin.body.user.id, pin: '2222' });
    assert.equal(loginWithoutHouseholdAccess.status, 400);
    assert.match(loginWithoutHouseholdAccess.body.error, /household access token/i);

    const householdAccess = await request(isolated.app)
      .post('/api/auth/household/access')
      .send({
        householdLoginId: admin.body.householdAuth.householdLoginId,
        householdCode: admin.body.householdAuth.householdCode
      });
    assert.equal(householdAccess.status, 200);

    const loginWithHouseholdAccess = await request(isolated.app)
      .post('/api/auth/login')
      .send({
        userId: admin.body.user.id,
        pin: '2222',
        householdAccessToken: householdAccess.body.accessToken
      });
    assert.equal(loginWithHouseholdAccess.status, 200);
  } finally {
    isolated.cleanup();
    if (fs.existsSync(isolatedDbPath)) fs.unlinkSync(isolatedDbPath);
    if (fs.existsSync(`${isolatedDbPath}-wal`)) fs.unlinkSync(`${isolatedDbPath}-wal`);
    if (fs.existsSync(`${isolatedDbPath}-shm`)) fs.unlinkSync(`${isolatedDbPath}-shm`);
  }
});
