const {
  test,
  assert,
  crypto,
  request,
  app,
  uniqueSuffix,
  auth
} = require('./helpers');

test('message access uses indistinguishable not-found responses', async () => {
  const suffix = uniqueSuffix();
  const admin = await request(app)
    .post('/api/auth/register')
    .send({ name: `MsgAdmin-${suffix}`, pin: '1111', createHousehold: true, householdName: `Msg Household ${suffix}` });
  assert.equal(admin.status, 201);

  const inviteOne = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(admin.body.token))
    .send({ ttlHours: 24 });
  assert.equal(inviteOne.status, 201);

  const child = await request(app)
    .post('/api/auth/register')
    .send({ name: `MsgChild-${suffix}`, pin: '2222', inviteCode: inviteOne.body.code });
  assert.equal(child.status, 201);

  const inviteTwo = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(admin.body.token))
    .send({ ttlHours: 24 });
  assert.equal(inviteTwo.status, 201);

  const outsider = await request(app)
    .post('/api/auth/register')
    .send({ name: `MsgOutsider-${suffix}`, pin: '3333', inviteCode: inviteTwo.body.code });
  assert.equal(outsider.status, 201);

  const createdRequest = await request(app)
    .post('/api/requests')
    .set(auth(child.body.token))
    .send({ toId: admin.body.user.id, amount: 5, reason: 'Message policy check' });
  assert.equal(createdRequest.status, 201);

  const deniedRead = await request(app)
    .get(`/api/messages?refType=request&refId=${createdRequest.body.id}`)
    .set(auth(outsider.body.token));
  assert.equal(deniedRead.status, 404);
  assert.deepEqual(deniedRead.body, { error: 'Not found' });

  const missingRead = await request(app)
    .get(`/api/messages?refType=request&refId=${crypto.randomUUID()}`)
    .set(auth(outsider.body.token));
  assert.equal(missingRead.status, 404);
  assert.deepEqual(missingRead.body, { error: 'Not found' });
});

test('cross-household probes return 404 for protected resources', async () => {
  const suffix = uniqueSuffix();
  const familyAAdmin = await request(app)
    .post('/api/auth/register')
    .send({ name: `ProbeA-Admin-${suffix}`, pin: '1111', createHousehold: true, householdName: `Probe Household A ${suffix}` });
  assert.equal(familyAAdmin.status, 201);

  const inviteRes = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(familyAAdmin.body.token))
    .send({ ttlHours: 24 });
  assert.equal(inviteRes.status, 201);

  const familyAChild = await request(app)
    .post('/api/auth/register')
    .send({ name: `ProbeA-Child-${suffix}`, pin: '2222', inviteCode: inviteRes.body.code });
  assert.equal(familyAChild.status, 201);

  const familyBAdmin = await request(app)
    .post('/api/auth/register')
    .send({ name: `ProbeB-Admin-${suffix}`, pin: '3333', createHousehold: true, householdName: 'Probe Family B' });
  assert.equal(familyBAdmin.status, 201);

  const reqA = await request(app)
    .post('/api/requests')
    .set(auth(familyAAdmin.body.token))
    .send({ toId: familyAChild.body.user.id, amount: 9, reason: 'probe request' });
  assert.equal(reqA.status, 201);

  const payA = await request(app)
    .post('/api/payments')
    .set(auth(familyAAdmin.body.token))
    .send({ toId: familyAChild.body.user.id, amount: 4, message: 'probe payment' });
  assert.equal(payA.status, 201);

  const msgA = await request(app)
    .post('/api/messages')
    .set(auth(familyAAdmin.body.token))
    .send({ refType: 'request', refId: reqA.body.id, text: 'probe message' });
  assert.equal(msgA.status, 201);

  const attachmentA = await request(app)
    .post('/api/attachments')
    .set(auth(familyAAdmin.body.token))
    .field('refType', 'request')
    .field('refId', reqA.body.id)
    .attach('file', Buffer.from('probe-data'), {
      filename: 'probe.txt',
      contentType: 'text/plain'
    });
  assert.equal(attachmentA.status, 201);

  const requestProbe = await request(app)
    .patch(`/api/requests/${reqA.body.id}`)
    .set(auth(familyBAdmin.body.token))
    .send({ status: 'accepted' });
  assert.equal(requestProbe.status, 404);

  const paymentProbe = await request(app)
    .patch(`/api/payments/${payA.body.id}`)
    .set(auth(familyBAdmin.body.token))
    .send({ status: 'confirmed' });
  assert.equal(paymentProbe.status, 404);

  const messageProbe = await request(app)
    .get(`/api/messages?refType=request&refId=${reqA.body.id}`)
    .set(auth(familyBAdmin.body.token));
  assert.equal(messageProbe.status, 404);

  const attachmentProbe = await request(app)
    .get(`/api/attachments/${attachmentA.body.id}/download`)
    .set(auth(familyBAdmin.body.token));
  assert.equal(attachmentProbe.status, 404);
});

test('login rejects non-json content type with 415', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'text/plain')
    .send('userId=abc&pin=1234');

  assert.equal(res.status, 415);
  assert.match(res.body.error, /Unsupported Media Type/i);
});

test('structured logs never include request body fields', async () => {
  const marker = `redaction-marker-${uniqueSuffix()}`;
  const captured = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (line, ...rest) => {
    if (typeof line === 'string') captured.push(line);
    if (typeof originalLog === 'function') originalLog(line, ...rest);
  };
  console.warn = (line, ...rest) => {
    if (typeof line === 'string') captured.push(line);
    if (typeof originalWarn === 'function') originalWarn(line, ...rest);
  };
  console.error = (line, ...rest) => {
    if (typeof line === 'string') captured.push(line);
    if (typeof originalError === 'function') originalError(line, ...rest);
  };

  try {
    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: `Logger-${uniqueSuffix()}`,
        pin: '1234',
        sensitiveProbe: marker
      });
    assert.equal(registerRes.status, 201);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  const requestLogs = captured.filter((line) => {
    if (typeof line !== 'string' || !line.includes('"type":"http_request"')) {
      return false;
    }

    try {
      const payload = JSON.parse(line);
      return payload.path === '/api/auth/register';
    } catch (err) {
      return false;
    }
  });

  assert.ok(requestLogs.length >= 1);
  const combined = requestLogs.join('\n');
  assert.equal(combined.includes(marker), false);
  assert.equal(combined.includes('sensitiveProbe'), false);
  assert.equal(combined.includes('"pin":'), false);
});
