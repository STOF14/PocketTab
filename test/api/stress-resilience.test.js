const {
  test,
  assert,
  request,
  app,
  uniqueSuffix,
  auth,
  loginUser,
  createSeededRng,
  randomInt,
  pickOne
} = require('./helpers');

test('ten-family randomized multi-device resilience regression', async () => {
  const rng = createSeededRng(20260416);
  const suffix = uniqueSuffix();
  const families = [];
  const issues = [];

  function captureIssue(severity, category, feature, context, details) {
    issues.push({ severity, category, feature, context, details });
  }

  for (let i = 0; i < 10; i += 1) {
    const familyName = `Fam${i + 1}-${suffix}`;
    const profile = pickOne(rng, ['heavy', 'moderate', 'sporadic']);
    const size = randomInt(rng, 3, 8);
    const adminPin = `${(1000 + i) % 10000}`.padStart(4, '0');

    const adminRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: `${familyName}-Admin`,
        pin: adminPin,
        createHousehold: true,
        householdName: `${familyName} Household`
      });
    assert.equal(adminRes.status, 201);

    const admin = {
      ...adminRes.body.user,
      pin: adminPin,
      tokens: [adminRes.body.token],
      activeToken: adminRes.body.token
    };
    const members = [admin];

    for (let j = 1; j < size; j += 1) {
      const invite = await request(app)
        .post('/api/auth/household/invites')
        .set(auth(adminRes.body.token))
        .send({ ttlHours: 72 });
      assert.equal(invite.status, 201);
      assert.ok(invite.body.code);

      const pin = `${(2000 + i * 10 + j) % 10000}`.padStart(4, '0');
      const memberRes = await request(app)
        .post('/api/auth/register')
        .send({
          name: `${familyName}-Member${j}`,
          pin,
          inviteCode: invite.body.code
        });
      assert.equal(memberRes.status, 201);
      members.push({
        ...memberRes.body.user,
        pin,
        tokens: [memberRes.body.token],
        activeToken: memberRes.body.token
      });
    }

    const promotePool = members.slice(1);
    const promoteCount = Math.max(1, Math.floor(size / 3));
    for (let p = 0; p < promoteCount && promotePool.length > 0; p += 1) {
      const idx = Math.floor(rng() * promotePool.length);
      const target = promotePool.splice(idx, 1)[0];
      const promote = await request(app)
        .patch(`/api/users/${target.id}/role`)
        .set(auth(admin.tokens[0]))
        .send({ role: 'parent' });
      assert.equal(promote.status, 200);
      target.role = 'parent';
    }

    families.push({
      id: i,
      name: familyName,
      profile,
      members,
      admin
    });
  }

  for (const family of families) {
    for (const member of family.members) {
      const loginA = await loginUser(member.id, member.pin);
      const loginB = await loginUser(member.id, member.pin);
      member.tokens.push(loginA.token, loginB.token);
      member.activeToken = loginB.token;
    }
  }

  for (let i = 0; i < families.length; i += 1) {
    const family = families[i];
    const admin = family.members.find((m) => m.role === 'admin');
    const parent = family.members.find((m) => m.role === 'parent') || admin;
    const child = family.members.find((m) => m.role === 'child') || family.members[1];
    const outsiderAdmin = families[(i + 1) % families.length].members.find((m) => m.role === 'admin');

    const household = await request(app)
      .get('/api/auth/household')
      .set(auth(admin.tokens[0]));
    assert.equal(household.status, 200);
    assert.ok(household.body.memberCount >= 3);

    const membersByParent = await request(app)
      .get('/api/users/members')
      .set(auth(parent.tokens[0]));
    assert.equal(membersByParent.status, 200);
    assert.equal(membersByParent.body.length, family.members.length);

    if (child && child.id !== parent.id) {
      const deniedMembers = await request(app)
        .get('/api/users/members')
        .set(auth(child.tokens[0]));
      assert.equal(deniedMembers.status, 403);
    }

    if (child && child.id !== parent.id) {
      const allowance = await request(app)
        .post('/api/allowances')
        .set(auth(parent.tokens[0]))
        .send({ childId: child.id, budget: 120, period: 'weekly', approvalThreshold: 20 });
      assert.equal(allowance.status, 201);
    }

    const requestCreated = await request(app)
      .post('/api/requests')
      .set(auth(child.tokens[0]))
      .send({ toId: admin.id, amount: 24, reason: `Req-${family.name}`, category: 'ops', tags: ['load', 'wave'] });
    assert.equal(requestCreated.status, 201);

    if (requestCreated.body.status === 'pending_approval') {
      const approved = await request(app)
        .post(`/api/requests/${requestCreated.body.id}/approve-child`)
        .set(auth(parent.tokens[1]))
        .send({});
      assert.equal(approved.status, 200);
      assert.equal(approved.body.status, 'pending');
    }

    const accepted = await request(app)
      .patch(`/api/requests/${requestCreated.body.id}`)
      .set(auth(admin.tokens[1]))
      .send({ status: 'accepted' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'accepted');

    const crossHouseholdRequest = await request(app)
      .post('/api/requests')
      .set(auth(admin.tokens[0]))
      .send({ toId: outsiderAdmin.id, amount: 5, reason: 'cross household deny' });
    assert.equal(crossHouseholdRequest.status, 403);

    const firstPayment = await request(app)
      .post('/api/payments')
      .set(auth(admin.tokens[0]))
      .send({ requestId: requestCreated.body.id, amount: 10, message: 'p1', category: 'ops', tags: ['wave'] });
    assert.equal(firstPayment.status, 201);

    const confirmRace = await Promise.all([
      request(app)
        .patch(`/api/payments/${firstPayment.body.id}`)
        .set(auth(child.tokens[0]))
        .send({ status: 'confirmed' }),
      request(app)
        .patch(`/api/payments/${firstPayment.body.id}`)
        .set(auth(child.tokens[1]))
        .send({ status: 'confirmed' })
    ]);
    const raceStatuses = confirmRace.map((r) => r.status).sort();
    assert.deepEqual(raceStatuses, [200, 400]);

    const secondPayment = await request(app)
      .post('/api/payments')
      .set(auth(admin.tokens[1]))
      .send({ requestId: requestCreated.body.id, amount: 14, message: 'p2', category: 'ops', tags: ['retry'] });
    assert.equal(secondPayment.status, 201);

    const disputeThenRetry = await Promise.all([
      request(app)
        .patch(`/api/payments/${secondPayment.body.id}`)
        .set(auth(child.tokens[0]))
        .send({ status: 'disputed' }),
      request(app)
        .patch(`/api/payments/${secondPayment.body.id}`)
        .set(auth(child.tokens[1]))
        .send({ status: 'confirmed' })
    ]);
    const disputeStatuses = disputeThenRetry.map((r) => r.status).sort();
    assert.deepEqual(disputeStatuses, [200, 400]);

    const msg = await request(app)
      .post('/api/messages')
      .set(auth(child.tokens[0]))
      .send({ refType: 'request', refId: requestCreated.body.id, text: `message-${family.name}` });
    assert.equal(msg.status, 201);

    const outsider = family.members.find((m) => m.id !== child.id && m.id !== admin.id) || parent;
    const deniedMsgRead = await request(app)
      .get(`/api/messages?refType=request&refId=${requestCreated.body.id}`)
      .set(auth(outsider.tokens[0]));
    assert.equal(deniedMsgRead.status, 404);

    const attachment = await request(app)
      .post('/api/attachments')
      .set(auth(child.tokens[0]))
      .field('refType', 'request')
      .field('refId', requestCreated.body.id)
      .attach('file', Buffer.from(`proof-${family.name}`), {
        filename: `${family.name}.txt`,
        contentType: 'text/plain'
      });
    assert.equal(attachment.status, 201);

    const attachmentList = await request(app)
      .get(`/api/attachments?refType=request&refId=${requestCreated.body.id}`)
      .set(auth(admin.tokens[0]));
    assert.equal(attachmentList.status, 200);
    assert.ok(attachmentList.body.length >= 1);

    const attachmentDownload = await request(app)
      .get(`/api/attachments/${attachment.body.id}/download`)
      .set(auth(admin.tokens[1]));
    assert.equal(attachmentDownload.status, 200);
    assert.equal(attachmentDownload.headers['content-type'], 'text/plain');

    const noteList = await request(app)
      .get('/api/notifications?unreadOnly=true')
      .set(auth(child.tokens[1]));
    assert.equal(noteList.status, 200);
    if (noteList.body.length > 0) {
      const readOne = await request(app)
        .patch(`/api/notifications/${noteList.body[0].id}/read`)
        .set(auth(child.tokens[0]));
      assert.equal(readOne.status, 200);
    }
    const readAll = await request(app)
      .patch('/api/notifications/read-all')
      .set(auth(child.tokens[0]));
    assert.equal(readAll.status, 200);

    const recurring = await request(app)
      .post('/api/recurring')
      .set(auth(parent.tokens[0]))
      .send({
        fromId: parent.id,
        toId: admin.id,
        amount: 7,
        reason: `rec-${family.name}`,
        category: 'recurring',
        tags: ['auto'],
        frequency: 'weekly',
        nextRunAt: '2000-01-01T00:00:00.000Z'
      });
    assert.equal(recurring.status, 201);

    const runRecurring = await request(app)
      .post('/api/recurring/run')
      .set(auth(parent.tokens[1]))
      .send({ limit: 10 });
    assert.equal(runRecurring.status, 200);

    const settlements = await request(app)
      .get('/api/settlements/net?scope=household')
      .set(auth(parent.tokens[0]));
    assert.equal(settlements.status, 200);

    if (child && child.id !== parent.id) {
      const deniedSettlements = await request(app)
        .get('/api/settlements/net?scope=household')
        .set(auth(child.tokens[0]));
      assert.equal(deniedSettlements.status, 403);
    }

    const summary = await request(app)
      .get('/api/reports/summary?scope=household')
      .set(auth(parent.tokens[0]));
    assert.equal(summary.status, 200);
    const trends = await request(app)
      .get('/api/reports/trends?scope=household')
      .set(auth(parent.tokens[0]));
    assert.equal(trends.status, 200);
    const csv = await request(app)
      .get('/api/reports/export.csv?scope=household')
      .set(auth(parent.tokens[0]));
    assert.equal(csv.status, 200);
    const pdf = await request(app)
      .get('/api/reports/export.pdf?scope=household')
      .set(auth(parent.tokens[0]));
    assert.equal(pdf.status, 200);

    const reminders = await request(app)
      .post('/api/notifications/reminders/run')
      .set(auth(parent.tokens[1]))
      .send({ staleHours: 0 });
    assert.equal(reminders.status, 200);

    const recovery = await request(app)
      .post('/api/users/pin-recovery-request')
      .set(auth(child.tokens[0]))
      .send({ note: `${family.name} recovery` });
    assert.equal(recovery.status, 201);

    const newPin = `${(5000 + i) % 10000}`.padStart(4, '0');
    const pinReset = await request(app)
      .post(`/api/users/${child.id}/pin-reset`)
      .set(auth(parent.tokens[0]))
      .send({ newPin });
    assert.equal(pinReset.status, 200);
    child.pin = newPin;
    const relogin = await loginUser(child.id, child.pin);
    child.tokens.push(relogin.token);
    child.activeToken = relogin.token;

    const sessions = await request(app)
      .get(`/api/users/sessions?userId=${admin.id}`)
      .set(auth(admin.tokens[0]));
    assert.equal(sessions.status, 200);
    const revokable = sessions.body.find((s) => s.id !== sessions.body[0]?.id) || sessions.body[0];
    if (revokable) {
      const revoke = await request(app)
        .delete(`/api/users/sessions/${revokable.id}`)
        .set(auth(admin.tokens[0]));
      assert.equal(revoke.status, 200);
      assert.equal(revoke.body.message, 'Session revoked');
    }
    const adminRelogin = await loginUser(admin.id, admin.pin);
    admin.tokens.push(adminRelogin.token);
    admin.activeToken = adminRelogin.token;

    const resumedChildToken = child.tokens[child.tokens.length - 1];
    const oldChildToken = child.tokens[0];

    const refreshChecks = await Promise.all([
      request(app).get('/api/requests?limit=5&offset=0').set(auth(resumedChildToken)),
      request(app).get('/api/payments?limit=5&offset=0').set(auth(admin.tokens[0])),
      request(app).get(`/api/messages?refType=request&refId=${requestCreated.body.id}&limit=5&offset=0`).set(auth(resumedChildToken)),
      request(app).get('/api/notifications?unreadOnly=false').set(auth(resumedChildToken))
    ]);

    for (const check of refreshChecks) {
      assert.equal(check.status, 200);
    }

    const revokedSessionProbe = await request(app)
      .get('/api/notifications?unreadOnly=false')
      .set(auth(oldChildToken));
    assert.equal(revokedSessionProbe.status, 403);

    const attachmentDelete = await request(app)
      .delete(`/api/attachments/${attachment.body.id}`)
      .set(auth(resumedChildToken));
    assert.equal(attachmentDelete.status, 200);
  }

  const actionCatalog = [
    async (family) => {
      const admin = family.members.find((m) => m.role === 'admin');
      const child = family.members.find((m) => m.role === 'child') || family.members[1];
      const created = await request(app)
        .post('/api/requests')
        .set(auth(child.activeToken))
        .send({ toId: admin.id, amount: randomInt(rng, 1, 9), reason: `wave-${family.id}` });
      assert.equal(created.status, 201);
    },
    async (family) => {
      const actor = pickOne(rng, family.members);
      const pageA = await request(app)
        .get(`/api/requests?limit=3&offset=${randomInt(rng, 0, 2)}`)
        .set(auth(actor.activeToken));
      const pageB = await request(app)
        .get(`/api/payments?limit=3&offset=${randomInt(rng, 0, 2)}`)
        .set(auth(actor.activeToken));
      assert.equal(pageA.status, 200);
      assert.equal(pageB.status, 200);
    },
    async (family) => {
      const parent = family.members.find((m) => m.role === 'parent') || family.members.find((m) => m.role === 'admin');
      const run = await request(app)
        .post('/api/notifications/reminders/run')
        .set(auth(parent.activeToken))
        .send({ staleHours: 0 });
      assert.equal(run.status, 200);
    }
  ];

  for (let wave = 0; wave < 6; wave += 1) {
    const tasks = [];
    for (const family of families) {
      const activityCount = family.profile === 'heavy' ? 4 : family.profile === 'moderate' ? 2 : 1;
      for (let n = 0; n < activityCount; n += 1) {
        const actionIndex = randomInt(rng, 0, actionCatalog.length - 1);
        tasks.push((async () => {
          try {
            await actionCatalog[actionIndex](family);
          } catch (error) {
            captureIssue('critical', 'concurrency', `wave-action-${actionIndex}`, family.name, error?.message || String(error));
          }
        })());
      }
    }
    await Promise.all(tasks);
  }

  const backlog = [...issues];
  const grouped = backlog.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {});

  console.log('[stress-gap-report]', JSON.stringify({
    families: families.length,
    members: families.reduce((sum, f) => sum + f.members.length, 0),
    issuesFound: backlog.length,
    grouped,
    topItems: backlog.slice(0, 10)
  }));

  assert.equal(backlog.length, 0, JSON.stringify(backlog.slice(0, 5)));
});
