const {
  test,
  assert,
  request,
  app,
  db,
  uniqueSuffix,
  auth,
  registerUser
} = require('./helpers');

test('attachment payload boundaries enforce clear UX-safe errors', async () => {
  const suffix = uniqueSuffix();
  const sender = await registerUser(`Attachment-Sender-${suffix}`, '8181');
  const receiver = await registerUser(`Attachment-Receiver-${suffix}`, '8282');

  const requestRes = await request(app)
    .post('/api/requests')
    .set(auth(sender.token))
    .send({ toId: receiver.user.id, amount: 12, reason: 'Attachment boundary setup' });
  assert.equal(requestRes.status, 201);

  const previousMaxAttachmentBytes = process.env.MAX_ATTACHMENT_BYTES;
  process.env.MAX_ATTACHMENT_BYTES = '16';

  try {
    const exactBoundaryUpload = await request(app)
      .post('/api/attachments')
      .set(auth(sender.token))
      .field('refType', 'request')
      .field('refId', requestRes.body.id)
      .attach('file', Buffer.from('1234567890ABCDEF'), {
        filename: 'exact.bin',
        contentType: 'application/octet-stream'
      });
    assert.equal(exactBoundaryUpload.status, 201);

    const tooLargeUpload = await request(app)
      .post('/api/attachments')
      .set(auth(sender.token))
      .field('refType', 'request')
      .field('refId', requestRes.body.id)
      .attach('file', Buffer.from('1234567890ABCDEFG'), {
        filename: 'oversize.bin',
        contentType: 'application/octet-stream'
      });
    assert.equal(tooLargeUpload.status, 400);
    assert.match(tooLargeUpload.body.error, /exceeds max size/i);

    const emptyPayloadUpload = await request(app)
      .post('/api/attachments')
      .set(auth(sender.token))
      .field('refType', 'request')
      .field('refId', requestRes.body.id)
      .attach('file', Buffer.alloc(0), {
        filename: 'empty.bin',
        contentType: 'application/octet-stream'
      });
    assert.equal(emptyPayloadUpload.status, 400);
    assert.match(emptyPayloadUpload.body.error, /payload is empty/i);

    const disallowedMimeUpload = await request(app)
      .post('/api/attachments')
      .set(auth(sender.token))
      .field('refType', 'request')
      .field('refId', requestRes.body.id)
      .attach('file', Buffer.from('unsafe-binary'), {
        filename: 'payload.exe',
        contentType: 'application/x-msdownload'
      });
    assert.equal(disallowedMimeUpload.status, 400);
    assert.match(disallowedMimeUpload.body.error, /mime type is not allowed/i);
  } finally {
    if (typeof previousMaxAttachmentBytes === 'undefined') {
      delete process.env.MAX_ATTACHMENT_BYTES;
    } else {
      process.env.MAX_ATTACHMENT_BYTES = previousMaxAttachmentBytes;
    }
  }
});

test('name normalization enforces uniqueness within a household only', async () => {
  const suffix = uniqueSuffix();

  const householdAAdmin = await request(app)
    .post('/api/auth/register')
    .send({
      name: `  Invisible-${suffix}  `,
      pin: '9090',
      createHousehold: true,
      householdName: `Invisible Household A ${suffix}`
    });
  assert.equal(householdAAdmin.status, 201);

  const sameNameDifferentHousehold = await request(app)
    .post('/api/auth/register')
    .send({
      name: `invisible-${suffix}`,
      pin: '9191',
      createHousehold: true,
      householdName: `Invisible Household B ${suffix}`
    });
  assert.equal(sameNameDifferentHousehold.status, 201);
  assert.notEqual(sameNameDifferentHousehold.body.user.household_id, householdAAdmin.body.user.household_id);

  const inviteForCaseVariant = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(householdAAdmin.body.token))
    .send({ ttlHours: 24 });
  assert.equal(inviteForCaseVariant.status, 201);

  const caseVariant = await request(app)
    .post('/api/auth/register')
    .send({ name: `invisible-${suffix}`, pin: '9292', inviteCode: inviteForCaseVariant.body.code });
  assert.equal(caseVariant.status, 400);
  assert.match(caseVariant.body.error, /already taken/i);

  const inviteForLongNameOne = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(householdAAdmin.body.token))
    .send({ ttlHours: 24 });
  assert.equal(inviteForLongNameOne.status, 201);

  const firstLong = await request(app)
    .post('/api/auth/register')
    .send({ name: `abcdefghijklmnopqrst-${suffix}-A`, pin: '9393', inviteCode: inviteForLongNameOne.body.code });
  assert.equal(firstLong.status, 201);

  const inviteForLongNameTwo = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(householdAAdmin.body.token))
    .send({ ttlHours: 24 });
  assert.equal(inviteForLongNameTwo.status, 201);

  const secondLongCollision = await request(app)
    .post('/api/auth/register')
    .send({ name: `abcdefghijklmnopqrst-${suffix}-B`, pin: '9494', inviteCode: inviteForLongNameTwo.body.code });
  assert.equal(secondLongCollision.status, 400);
  assert.match(secondLongCollision.body.error, /already taken/i);
});

test('amount parsing rejects malformed and over-precision values', async () => {
  const suffix = uniqueSuffix();

  const adminRes = await request(app)
    .post('/api/auth/register')
    .send({
      name: `AmountAdmin-${suffix}`,
      pin: '1111',
      createHousehold: true,
      householdName: `Amount Household ${suffix}`
    });
  assert.equal(adminRes.status, 201);

  const inviteRes = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(adminRes.body.token))
    .send({ ttlHours: 24 });
  assert.equal(inviteRes.status, 201);

  const memberRes = await request(app)
    .post('/api/auth/register')
    .send({ name: `AmountMember-${suffix}`, pin: '2222', inviteCode: inviteRes.body.code });
  assert.equal(memberRes.status, 201);

  const invalidRequestPrefix = await request(app)
    .post('/api/requests')
    .set(auth(adminRes.body.token))
    .send({ toId: memberRes.body.user.id, amount: '10abc', reason: 'invalid prefix' });
  assert.equal(invalidRequestPrefix.status, 400);

  const invalidRequestPrecision = await request(app)
    .post('/api/requests')
    .set(auth(adminRes.body.token))
    .send({ toId: memberRes.body.user.id, amount: '10.999', reason: 'invalid precision' });
  assert.equal(invalidRequestPrecision.status, 400);

  const validRequest = await request(app)
    .post('/api/requests')
    .set(auth(adminRes.body.token))
    .send({ toId: memberRes.body.user.id, amount: '10.50', reason: 'valid amount' });
  assert.equal(validRequest.status, 201);

  const acceptValidRequest = await request(app)
    .patch(`/api/requests/${validRequest.body.id}`)
    .set(auth(memberRes.body.token))
    .send({ status: 'accepted' });
  assert.equal(acceptValidRequest.status, 200);

  const invalidPaymentPrefix = await request(app)
    .post('/api/payments')
    .set(auth(memberRes.body.token))
    .send({ toId: adminRes.body.user.id, amount: '5xyz', message: 'bad amount' });
  assert.equal(invalidPaymentPrefix.status, 400);

  const invalidRecurringPrecision = await request(app)
    .post('/api/recurring')
    .set(auth(adminRes.body.token))
    .send({
      fromId: adminRes.body.user.id,
      toId: memberRes.body.user.id,
      amount: '7.001',
      frequency: 'weekly',
      reason: 'bad recurring amount'
    });
  assert.equal(invalidRecurringPrecision.status, 400);
});

test('money tables persist cents-only schema', () => {
  const requestColumns = db.prepare('PRAGMA table_info(requests)').all().map((col) => col.name);
  assert.ok(requestColumns.includes('amount_cents'));
  assert.equal(requestColumns.includes('amount'), false);

  const paymentColumns = db.prepare('PRAGMA table_info(payments)').all().map((col) => col.name);
  assert.ok(paymentColumns.includes('amount_cents'));
  assert.equal(paymentColumns.includes('amount'), false);
});

test('GET endpoints do not generate recurring requests', async () => {
  const suffix = uniqueSuffix();

  const adminRes = await request(app)
    .post('/api/auth/register')
    .send({
      name: `RecurringAdmin-${suffix}`,
      pin: '1111',
      createHousehold: true,
      householdName: `Recurring Household ${suffix}`
    });
  assert.equal(adminRes.status, 201);

  const inviteRes = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(adminRes.body.token))
    .send({ ttlHours: 24 });
  assert.equal(inviteRes.status, 201);

  const memberRes = await request(app)
    .post('/api/auth/register')
    .send({ name: `RecurringMember-${suffix}`, pin: '2222', inviteCode: inviteRes.body.code });
  assert.equal(memberRes.status, 201);

  const recurringCreate = await request(app)
    .post('/api/recurring')
    .set(auth(adminRes.body.token))
    .send({
      fromId: adminRes.body.user.id,
      toId: memberRes.body.user.id,
      amount: 12,
      reason: 'No side effect check',
      frequency: 'weekly',
      nextRunAt: '2000-01-01T00:00:00.000Z'
    });
  assert.equal(recurringCreate.status, 201);

  const requestsBefore = await request(app)
    .get('/api/requests')
    .set(auth(memberRes.body.token));
  assert.equal(requestsBefore.status, 200);
  assert.equal(requestsBefore.body.length, 0);

  const recurringList = await request(app)
    .get('/api/recurring')
    .set(auth(adminRes.body.token));
  assert.equal(recurringList.status, 200);
  assert.ok(recurringList.body.some((rr) => rr.id === recurringCreate.body.id));

  const requestsAfterGet = await request(app)
    .get('/api/requests')
    .set(auth(memberRes.body.token));
  assert.equal(requestsAfterGet.status, 200);
  assert.equal(requestsAfterGet.body.length, 0);

  const recurringRun = await request(app)
    .post('/api/recurring/run')
    .set(auth(adminRes.body.token))
    .send({ limit: 10 });
  assert.equal(recurringRun.status, 200);
  assert.ok(recurringRun.body.generated >= 1);

  const requestsAfterRun = await request(app)
    .get('/api/requests')
    .set(auth(memberRes.body.token));
  assert.equal(requestsAfterRun.status, 200);
  assert.ok(requestsAfterRun.body.some((reqRow) => reqRow.recurring_id === recurringCreate.body.id));
});
