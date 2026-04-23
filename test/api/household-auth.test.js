const {
  test,
  assert,
  request,
  app,
  db,
  uniqueSuffix,
  auth
} = require('./helpers');

test('multi-family isolation with household invites', async () => {
  const suffix = uniqueSuffix();
  const familyAAdminRes = await request(app)
    .post('/api/auth/register')
    .send({
      name: `FamilyA-Admin-${suffix}`,
      pin: '1111',
      createHousehold: true,
      householdName: `Family A ${suffix}`
    });
  assert.equal(familyAAdminRes.status, 201);
  const familyAAdmin = familyAAdminRes.body;

  const createInviteRes = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(familyAAdmin.token))
    .send({ ttlHours: 48 });
  assert.equal(createInviteRes.status, 201);
  assert.ok(createInviteRes.body.code);

  const familyAChild = await request(app)
    .post('/api/auth/register')
    .send({ name: `FamilyA-Child-${suffix}`, pin: '2222', inviteCode: createInviteRes.body.code });
  assert.equal(familyAChild.status, 201);

  const childCreatesInviteRes = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(familyAChild.body.token))
    .send({ ttlHours: 24 });
  assert.equal(childCreatesInviteRes.status, 403);

  const updateChildRoleByAdmin = await request(app)
    .patch(`/api/auth/household/members/${familyAChild.body.user.id}/role`)
    .set(auth(familyAAdmin.token))
    .send({ role: 'member' });
  assert.equal(updateChildRoleByAdmin.status, 200);
  assert.equal(updateChildRoleByAdmin.body.member.role, 'member');

  const updateRoleByChildDenied = await request(app)
    .patch(`/api/auth/household/members/${familyAAdmin.user.id}/role`)
    .set(auth(familyAChild.body.token))
    .send({ role: 'member' });
  assert.equal(updateRoleByChildDenied.status, 403);

  const familyBAdmin = await request(app)
    .post('/api/auth/register')
    .send({ name: `FamilyB-Admin-${suffix}`, pin: '3333', createHousehold: true, householdName: 'Family B' });
  assert.equal(familyBAdmin.status, 201);

  const crossHouseholdRequest = await request(app)
    .post('/api/requests')
    .set(auth(familyAAdmin.token))
    .send({ toId: familyBAdmin.body.user.id, amount: 5, reason: 'cross household test' });
  assert.equal(crossHouseholdRequest.status, 403);

  const inHouseholdRequest = await request(app)
    .post('/api/requests')
    .set(auth(familyAAdmin.token))
    .send({ toId: familyAChild.body.user.id, amount: 5, reason: 'in household test' });
  assert.equal(inHouseholdRequest.status, 201);

  const familyAMembers = await request(app)
    .get('/api/users/members')
    .set(auth(familyAAdmin.token));
  assert.equal(familyAMembers.status, 200);
  assert.equal(familyAMembers.body.length, 2);
  const expectedFamilyAIds = [familyAAdmin.user.id, familyAChild.body.user.id];
  assert.ok(familyAMembers.body.every((member) => expectedFamilyAIds.includes(member.id)));

  const reset = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(familyAAdmin.token))
    .send({ confirmation: 'RESET EVERYTHING' });
  assert.equal(reset.status, 403);
});

test('invite lifecycle preview catches active used and expired codes', async () => {
  const suffix = uniqueSuffix();
  const adminRes = await request(app)
    .post('/api/auth/register')
    .send({
      name: `InviteLifecycle-Admin-${suffix}`,
      pin: '1111',
      createHousehold: true,
      householdName: `Invite Lifecycle ${suffix}`
    });
  assert.equal(adminRes.status, 201);

  const activeInvite = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(adminRes.body.token))
    .send({ ttlHours: 24 });
  assert.equal(activeInvite.status, 201);
  assert.ok(activeInvite.body.code);

  const activePreview = await request(app)
    .get(`/api/auth/invites/${activeInvite.body.code}`);
  assert.equal(activePreview.status, 200);
  assert.equal(activePreview.body.code, activeInvite.body.code);
  assert.equal(activePreview.body.household.id, adminRes.body.user.household_id);
  assert.ok(Array.isArray(activePreview.body.members));
  assert.ok(activePreview.body.members.some((member) => member.id === adminRes.body.user.id));

  const activeLegacyLookup = await request(app)
    .get(`/api/auth/users?inviteCode=${activeInvite.body.code}`);
  assert.equal(activeLegacyLookup.status, 200);
  assert.ok(activeLegacyLookup.body.length >= 1);

  const joinedRes = await request(app)
    .post('/api/auth/register')
    .send({ name: `InviteLifecycle-Join-${suffix}`, pin: '2222', inviteCode: activeInvite.body.code });
  assert.equal(joinedRes.status, 201);

  const usedPreview = await request(app)
    .get(`/api/auth/invites/${activeInvite.body.code}`);
  assert.equal(usedPreview.status, 410);
  assert.match(usedPreview.body.error, /already used/i);

  const usedLegacyLookup = await request(app)
    .get(`/api/auth/users?inviteCode=${activeInvite.body.code}`);
  assert.equal(usedLegacyLookup.status, 200);
  assert.equal(usedLegacyLookup.body.length, 0);

  const usedJoinAttempt = await request(app)
    .post('/api/auth/register')
    .send({ name: `InviteLifecycle-Reuse-${suffix}`, pin: '3333', inviteCode: activeInvite.body.code });
  assert.equal(usedJoinAttempt.status, 400);
  assert.match(usedJoinAttempt.body.error, /already used/i);

  const expiringInvite = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(adminRes.body.token))
    .send({ ttlHours: 1 });
  assert.equal(expiringInvite.status, 201);

  db.prepare('UPDATE household_invites SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60 * 1000).toISOString(), expiringInvite.body.id);

  const expiredPreview = await request(app)
    .get(`/api/auth/invites/${expiringInvite.body.code}`);
  assert.equal(expiredPreview.status, 410);
  assert.match(expiredPreview.body.error, /expired/i);

  const expiredLegacyLookup = await request(app)
    .get(`/api/auth/users?inviteCode=${expiringInvite.body.code}`);
  assert.equal(expiredLegacyLookup.status, 200);
  assert.equal(expiredLegacyLookup.body.length, 0);

  const expiredJoinAttempt = await request(app)
    .post('/api/auth/register')
    .send({ name: `InviteLifecycle-Expired-${suffix}`, pin: '4444', inviteCode: expiringInvite.body.code });
  assert.equal(expiredJoinAttempt.status, 400);
  assert.match(expiredJoinAttempt.body.error, /expired/i);
});

test('new household registration returns PT login credentials', async () => {
  const suffix = uniqueSuffix();
  const registration = await request(app)
    .post('/api/auth/register')
    .send({
      name: `HouseholdAuth-${suffix}`,
      pin: '7788',
      createHousehold: true,
      householdName: `Household Auth ${suffix}`
    });

  assert.equal(registration.status, 201);
  assert.ok(registration.body.householdAuth);
  assert.match(registration.body.householdAuth.householdLoginId, /^PT-[A-Z]+(?:-[A-F0-9]{4})?$/);
  assert.match(registration.body.householdAuth.householdCode, /^\d{6}$/);
});

test('household access endpoint gates member login to the resolved household', async () => {
  const suffix = uniqueSuffix();

  const adminRes = await request(app)
    .post('/api/auth/register')
    .send({
      name: `AccessAdmin-${suffix}`,
      pin: '1111',
      createHousehold: true,
      householdName: `Access Household ${suffix}`
    });
  assert.equal(adminRes.status, 201);

  const inviteRes = await request(app)
    .post('/api/auth/household/invites')
    .set(auth(adminRes.body.token))
    .send({ ttlHours: 24 });
  assert.equal(inviteRes.status, 201);

  const memberRes = await request(app)
    .post('/api/auth/register')
    .send({ name: `AccessMember-${suffix}`, pin: '2222', inviteCode: inviteRes.body.code });
  assert.equal(memberRes.status, 201);

  const outsiderRes = await request(app)
    .post('/api/auth/register')
    .send({
      name: `AccessOutsider-${suffix}`,
      pin: '3333',
      createHousehold: true,
      householdName: `Other Household ${suffix}`
    });
  assert.equal(outsiderRes.status, 201);

  const badAccess = await request(app)
    .post('/api/auth/household/access')
    .send({
      householdLoginId: adminRes.body.householdAuth.householdLoginId,
      householdCode: '000000'
    });
  assert.equal(badAccess.status, 401);

  const access = await request(app)
    .post('/api/auth/household/access')
    .send({
      householdLoginId: adminRes.body.householdAuth.householdLoginId,
      householdCode: adminRes.body.householdAuth.householdCode
    });
  assert.equal(access.status, 200);
  assert.ok(Array.isArray(access.body.members));
  assert.ok(access.body.members.some((u) => u.id === memberRes.body.user.id));

  const memberLogin = await request(app)
    .post('/api/auth/login')
    .send({
      userId: memberRes.body.user.id,
      pin: '2222',
      householdAccessToken: access.body.accessToken
    });
  assert.equal(memberLogin.status, 200);

  const outsiderLoginDenied = await request(app)
    .post('/api/auth/login')
    .send({
      userId: outsiderRes.body.user.id,
      pin: '3333',
      householdAccessToken: access.body.accessToken
    });
  assert.equal(outsiderLoginDenied.status, 404);
});

test('auth users endpoint requires inviteCode scope', async () => {
  const res = await request(app).get('/api/auth/users');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /inviteCode/i);

  const householdIdQuery = await request(app).get('/api/auth/users?householdId=default-household');
  assert.equal(householdIdQuery.status, 400);
  assert.match(householdIdQuery.body.error, /inviteCode/i);
});
