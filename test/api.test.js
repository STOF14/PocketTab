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
process.env.DISABLE_RATE_LIMIT = 'true';

const app = require('../server/app');
const db = require('../server/db');

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

const serverRoot = path.join(__dirname, '..', 'server') + path.sep;

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
  const isolatedApp = require('../server/app');
  const isolatedDb = require('../server/db');

  return {
    app: isolatedApp,
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

test('family of 4 full advanced feature suite', async () => {
  const health = await request(app).get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');

  const suffix = uniqueSuffix();
  const family = {
    mom: await registerUser(`Mom-${suffix}`, '1111'),
    dad: await registerUser(`Dad-${suffix}`, '2222'),
    teen: await registerUser(`Teen-${suffix}`, '3333'),
    kid: await registerUser(`Kid-${suffix}`, '4444')
  };

  assert.equal(family.mom.user.role, 'admin');
  assert.equal(family.dad.user.role, 'child');
  assert.equal(family.teen.user.role, 'child');

  // Admin promotes dad to parent.
  const promoteDad = await request(app)
    .patch(`/api/users/${family.dad.user.id}/role`)
    .set(auth(family.mom.token))
    .send({ role: 'parent' });
  assert.equal(promoteDad.status, 200);
  assert.equal(promoteDad.body.role, 'parent');

  // Role-protected member management.
  const memberListParent = await request(app)
    .get('/api/users/members')
    .set(auth(family.dad.token));
  assert.equal(memberListParent.status, 200);
  assert.equal(memberListParent.body.length, 4);

  const memberListChildDenied = await request(app)
    .get('/api/users/members')
    .set(auth(family.teen.token));
  assert.equal(memberListChildDenied.status, 403);

  // Parent sets child allowance and approval threshold.
  const allowance = await request(app)
    .post('/api/allowances')
    .set(auth(family.dad.token))
    .send({ childId: family.teen.user.id, budget: 100, period: 'weekly', approvalThreshold: 20 });
  assert.equal(allowance.status, 201);
  assert.equal(allowance.body.child_id, family.teen.user.id);

  // Child request above threshold must be approved first.
  const reqTeenToMom = await request(app)
    .post('/api/requests')
    .set(auth(family.teen.token))
    .send({ toId: family.mom.user.id, amount: 25, reason: 'Game credit', category: 'games', tags: ['fun', 'online'] });
  assert.equal(reqTeenToMom.status, 201);
  assert.equal(reqTeenToMom.body.status, 'pending_approval');
  assert.equal(reqTeenToMom.body.requires_approval, true);

  const approveChildReq = await request(app)
    .post(`/api/requests/${reqTeenToMom.body.id}/approve-child`)
    .set(auth(family.dad.token));
  assert.equal(approveChildReq.status, 200);
  assert.equal(approveChildReq.body.status, 'pending');

  const momAcceptsReq = await request(app)
    .patch(`/api/requests/${reqTeenToMom.body.id}`)
    .set(auth(family.mom.token))
    .send({ status: 'accepted' });
  assert.equal(momAcceptsReq.status, 200);
  assert.equal(momAcceptsReq.body.status, 'accepted');

  // Message thread + access control.
  const reqMessage = await request(app)
    .post('/api/messages')
    .set(auth(family.teen.token))
    .send({ refType: 'request', refId: reqTeenToMom.body.id, text: 'Thanks for approving!' });
  assert.equal(reqMessage.status, 201);

  const outsiderMessageAccess = await request(app)
    .get(`/api/messages?refType=request&refId=${reqTeenToMom.body.id}`)
    .set(auth(family.kid.token));
  assert.equal(outsiderMessageAccess.status, 404);

  // Linked payments with partial settlement progression.
  const paymentPart1 = await request(app)
    .post('/api/payments')
    .set(auth(family.mom.token))
    .send({ requestId: reqTeenToMom.body.id, amount: 10, message: 'Partial payment', category: 'games', tags: ['fun'] });
  assert.equal(paymentPart1.status, 201);
  assert.equal(paymentPart1.body.request_id, reqTeenToMom.body.id);

  const confirmPart1 = await request(app)
    .patch(`/api/payments/${paymentPart1.body.id}`)
    .set(auth(family.teen.token))
    .send({ status: 'confirmed' });
  assert.equal(confirmPart1.status, 200);

  const reqAfterPart1 = await request(app)
    .get('/api/requests?status=partially_settled')
    .set(auth(family.teen.token));
  assert.equal(reqAfterPart1.status, 200);
  assert.equal(reqAfterPart1.body[0].remaining, 15);

  const paymentPart2 = await request(app)
    .post('/api/payments')
    .set(auth(family.mom.token))
    .send({ requestId: reqTeenToMom.body.id, amount: 15, message: 'Final payment', category: 'games', tags: ['online'] });
  assert.equal(paymentPart2.status, 201);

  const confirmPart2 = await request(app)
    .patch(`/api/payments/${paymentPart2.body.id}`)
    .set(auth(family.teen.token))
    .send({ status: 'confirmed' });
  assert.equal(confirmPart2.status, 200);

  const reqSettled = await request(app)
    .get('/api/requests?status=settled&category=games&tag=fun')
    .set(auth(family.teen.token));
  assert.equal(reqSettled.status, 200);
  assert.equal(reqSettled.body.length, 1);
  assert.equal(reqSettled.body[0].remaining, 0);

  const linkedPaymentFilter = await request(app)
    .get(`/api/payments?requestId=${reqTeenToMom.body.id}&tag=online`)
    .set(auth(family.mom.token));
  assert.equal(linkedPaymentFilter.status, 200);
  assert.equal(linkedPaymentFilter.body.length, 1);

  // Build another accepted request to drive settlement suggestions.
  const reqDadToKid = await request(app)
    .post('/api/requests')
    .set(auth(family.dad.token))
    .send({ toId: family.kid.user.id, amount: 30, reason: 'Cinema tickets', category: 'entertainment', tags: ['movie'] });
  assert.equal(reqDadToKid.status, 201);

  const kidAcceptsReq = await request(app)
    .patch(`/api/requests/${reqDadToKid.body.id}`)
    .set(auth(family.kid.token))
    .send({ status: 'accepted' });
  assert.equal(kidAcceptsReq.status, 200);

  const householdSettlement = await request(app)
    .get('/api/settlements/net?scope=household')
    .set(auth(family.dad.token));
  assert.equal(householdSettlement.status, 200);
  assert.ok(Array.isArray(householdSettlement.body.suggestedTransfers));

  const childSettlementDenied = await request(app)
    .get('/api/settlements/net?scope=household')
    .set(auth(family.kid.token));
  assert.equal(childSettlementDenied.status, 403);

  // Recurring rule and generator.
  const recurring = await request(app)
    .post('/api/recurring')
    .set(auth(family.dad.token))
    .send({
      fromId: family.dad.user.id,
      toId: family.mom.user.id,
      amount: 12,
      reason: 'Streaming subscription',
      category: 'subscriptions',
      tags: ['streaming'],
      frequency: 'weekly',
      nextRunAt: '2000-01-01T00:00:00.000Z'
    });
  assert.equal(recurring.status, 201);

  const runRecurring = await request(app)
    .post('/api/recurring/run')
    .set(auth(family.dad.token))
    .send({ limit: 10 });
  assert.equal(runRecurring.status, 200);
  assert.ok(runRecurring.body.generated >= 1);

  // Notifications unread/read flow + reminders.
  const teenNotifications = await request(app)
    .get('/api/notifications?unreadOnly=true')
    .set(auth(family.teen.token));
  assert.equal(teenNotifications.status, 200);
  assert.ok(teenNotifications.body.length >= 1);

  const markOneRead = await request(app)
    .patch(`/api/notifications/${teenNotifications.body[0].id}/read`)
    .set(auth(family.teen.token));
  assert.equal(markOneRead.status, 200);
  assert.equal(markOneRead.body.is_read, true);

  const markAllRead = await request(app)
    .patch('/api/notifications/read-all')
    .set(auth(family.teen.token));
  assert.equal(markAllRead.status, 200);

  // Create pending items and run reminder generator.
  const pendingReq = await request(app)
    .post('/api/requests')
    .set(auth(family.mom.token))
    .send({ toId: family.kid.user.id, amount: 9, reason: 'Lunch', category: 'food', tags: ['school'] });
  assert.equal(pendingReq.status, 201);

  const reminderRun = await request(app)
    .post('/api/notifications/reminders/run')
    .set(auth(family.dad.token))
    .send({ staleHours: 0 });
  assert.equal(reminderRun.status, 200);
  assert.ok(reminderRun.body.created >= 1);

  // Attachments proof upload/list/download/delete.
  const attachmentUpload = await request(app)
    .post('/api/attachments')
    .set(auth(family.teen.token))
    .send({
      refType: 'request',
      refId: reqTeenToMom.body.id,
      fileName: 'proof.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('proof-of-payment').toString('base64')
    });
  assert.equal(attachmentUpload.status, 201);

  const attachmentList = await request(app)
    .get(`/api/attachments?refType=request&refId=${reqTeenToMom.body.id}`)
    .set(auth(family.mom.token));
  assert.equal(attachmentList.status, 200);
  assert.equal(attachmentList.body.length, 1);

  const attachmentDownload = await request(app)
    .get(`/api/attachments/${attachmentUpload.body.id}/download`)
    .set(auth(family.mom.token));
  assert.equal(attachmentDownload.status, 200);
  assert.equal(attachmentDownload.headers['content-type'], 'text/plain');

  const attachmentDelete = await request(app)
    .delete(`/api/attachments/${attachmentUpload.body.id}`)
    .set(auth(family.teen.token));
  assert.equal(attachmentDelete.status, 200);

  // Reporting summary + trends + exports.
  const reportSummary = await request(app)
    .get('/api/reports/summary?scope=household')
    .set(auth(family.dad.token));
  assert.equal(reportSummary.status, 200);
  assert.ok(reportSummary.body.totals.requestCount >= 1);

  const reportTrends = await request(app)
    .get('/api/reports/trends?scope=household')
    .set(auth(family.dad.token));
  assert.equal(reportTrends.status, 200);
  assert.ok(Array.isArray(reportTrends.body.monthly));

  const csvExport = await request(app)
    .get('/api/reports/export.csv?scope=household')
    .set(auth(family.dad.token));
  assert.equal(csvExport.status, 200);
  assert.match(csvExport.headers['content-type'], /text\/csv/);
  assert.match(csvExport.text, /type,id,fromId,toId/);

  const pdfExport = await request(app)
    .get('/api/reports/export.pdf?scope=household')
    .set(auth(family.dad.token));
  assert.equal(pdfExport.status, 200);
  assert.match(pdfExport.headers['content-type'], /application\/pdf/);

  // Account safety: lockout, PIN recovery request, parent/admin reset, sessions revoke.
  for (let i = 0; i < 4; i += 1) {
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ userId: family.kid.user.id, pin: '9999' });
    assert.equal(wrong.status, 401);
  }

  const lockout = await request(app)
    .post('/api/auth/login')
    .send({ userId: family.kid.user.id, pin: '9999' });
  assert.equal(lockout.status, 423);
  assert.equal(typeof lockout.body.retryAfter, 'number');
  assert.ok(lockout.body.retryAfter > 0);

  const recoveryRequest = await request(app)
    .post('/api/users/pin-recovery-request')
    .set(auth(family.kid.token))
    .send({ note: 'Forgot my pin' });
  assert.equal(recoveryRequest.status, 201);

  const resetKidPin = await request(app)
    .post(`/api/users/${family.kid.user.id}/pin-reset`)
    .set(auth(family.mom.token))
    .send({ newPin: '7777' });
  assert.equal(resetKidPin.status, 200);

  const kidLoginNewPin = await request(app)
    .post('/api/auth/login')
    .send({ userId: family.kid.user.id, pin: '7777' });
  assert.equal(kidLoginNewPin.status, 200);

  const momSessions = await request(app)
    .get(`/api/users/sessions?userId=${family.mom.user.id}`)
    .set(auth(family.mom.token));
  assert.equal(momSessions.status, 200);
  assert.ok(momSessions.body.length >= 1);

  const sessionToRevoke = momSessions.body.find((s) => s.id !== family.mom.user.id) || momSessions.body[0];
  const revokeMomSession = await request(app)
    .delete(`/api/users/sessions/${sessionToRevoke.id}`)
    .set(auth(family.mom.token));
  assert.equal(revokeMomSession.status, 200);

  // Reset-all role + env gate.
  process.env.ALLOW_DATA_RESET = 'false';
  const resetDenied = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(family.dad.token))
    .send({ confirmation: 'RESET EVERYTHING' });
  assert.equal(resetDenied.status, 403);

  process.env.ALLOW_DATA_RESET = 'true';
  const resetBadConfirm = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(family.dad.token))
    .send({ confirmation: 'NOPE' });
  assert.equal(resetBadConfirm.status, 400);

  const resetOk = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(family.dad.token))
    .send({ confirmation: 'RESET EVERYTHING' });
  assert.equal(resetOk.status, 200);

  const usersAfterReset = await request(app).get('/api/auth/users');
  assert.equal(usersAfterReset.status, 200);
  assert.equal(usersAfterReset.body.length, 0);

  process.env.ALLOW_DATA_RESET = 'false';
});

test('multi-family isolation with household invites', async () => {
  const suffix = uniqueSuffix();
  const familyAAdmin = await registerUser(`FamilyA-Admin-${suffix}`, '1111');

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

test('ten-family randomized multi-device resilience regression', async () => {
  const rng = createSeededRng(20260416);
  const suffix = uniqueSuffix();
  const families = [];
  const issues = [];

  function captureIssue(severity, category, feature, context, details) {
    issues.push({ severity, category, feature, context, details });
  }

  // 1) Define 10 households with random sizes 3-8 and mixed profiles.
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

  // 2) Assign at least 2 extra sessions (multi-device) to every member.
  for (const family of families) {
    for (const member of family.members) {
      const loginA = await loginUser(member.id, member.pin);
      const loginB = await loginUser(member.id, member.pin);
      member.tokens.push(loginA.token, loginB.token);
      member.activeToken = loginB.token;
    }
  }

  // 3) Full-feature matrix per family (valid + invalid permissions).
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
      .send({
        refType: 'request',
        refId: requestCreated.body.id,
        fileName: `${family.name}.txt`,
        mimeType: 'text/plain',
        dataBase64: Buffer.from(`proof-${family.name}`).toString('base64')
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
        // Intentionally in the past so the run endpoint deterministically generates items in this stress suite.
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

    // Refresh/pagination checks after close/reopen-style relogin.
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

  // 4/5) Randomized parallel waves: mixed actions, retries, and occasional interruption.
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

  // 6/7) Defect log + prioritized regression backlog.
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
    .send({
      refType: 'request',
      refId: reqA.body.id,
      fileName: 'probe.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('probe-data').toString('base64')
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
      .send({
        refType: 'request',
        refId: requestRes.body.id,
        fileName: 'exact.bin',
        mimeType: 'application/octet-stream',
        dataBase64: Buffer.from('1234567890ABCDEF').toString('base64')
      });
    assert.equal(exactBoundaryUpload.status, 201);

    const tooLargeUpload = await request(app)
      .post('/api/attachments')
      .set(auth(sender.token))
      .send({
        refType: 'request',
        refId: requestRes.body.id,
        fileName: 'oversize.bin',
        mimeType: 'application/octet-stream',
        dataBase64: Buffer.from('1234567890ABCDEFG').toString('base64')
      });
    assert.equal(tooLargeUpload.status, 400);
    assert.match(tooLargeUpload.body.error, /exceeds max size/i);

    const emptyPayloadUpload = await request(app)
      .post('/api/attachments')
      .set(auth(sender.token))
      .send({
        refType: 'request',
        refId: requestRes.body.id,
        fileName: 'empty.bin',
        mimeType: 'application/octet-stream',
        dataBase64: 'data:application/octet-stream;base64,'
      });
    assert.equal(emptyPayloadUpload.status, 400);
    assert.match(emptyPayloadUpload.body.error, /payload is empty/i);
  } finally {
    if (typeof previousMaxAttachmentBytes === 'undefined') {
      delete process.env.MAX_ATTACHMENT_BYTES;
    } else {
      process.env.MAX_ATTACHMENT_BYTES = previousMaxAttachmentBytes;
    }
  }
});

test('name normalization blocks invisible duplicate profiles', async () => {
  const suffix = uniqueSuffix();

  const trimmedBase = await request(app)
    .post('/api/auth/register')
    .send({ name: `  Invisible-${suffix}  `, pin: '9090' });
  assert.equal(trimmedBase.status, 201);

  const caseVariant = await request(app)
    .post('/api/auth/register')
    .send({ name: `invisible-${suffix}`, pin: '9191' });
  assert.equal(caseVariant.status, 400);
  assert.match(caseVariant.body.error, /already taken/i);

  const firstLong = await request(app)
    .post('/api/auth/register')
    .send({ name: `abcdefghijklmnopqrst-${suffix}-A`, pin: '9292' });
  assert.equal(firstLong.status, 201);

  const secondLongCollision = await request(app)
    .post('/api/auth/register')
    .send({ name: `abcdefghijklmnopqrst-${suffix}-B`, pin: '9393' });
  assert.equal(secondLongCollision.status, 400);
  assert.match(secondLongCollision.body.error, /already taken/i);
});

test('everyday five-person family flow uses all major features', async () => {
  const suffix = uniqueSuffix();

  const adminRes = await request(app)
    .post('/api/auth/register')
    .send({
      name: `Daily-Admin-${suffix}`,
      pin: '1111',
      createHousehold: true,
      householdName: `Daily Household ${suffix}`
    });
  assert.equal(adminRes.status, 201);

  async function issueInviteAndJoin(name, pin) {
    const inviteRes = await request(app)
      .post('/api/auth/household/invites')
      .set(auth(adminRes.body.token))
      .send({ ttlHours: 72 });
    assert.equal(inviteRes.status, 201);

    const previewRes = await request(app)
      .get(`/api/auth/invites/${inviteRes.body.code}`);
    assert.equal(previewRes.status, 200);
    assert.equal(previewRes.body.household.id, adminRes.body.user.household_id);

    const joinRes = await request(app)
      .post('/api/auth/register')
      .send({ name, pin, inviteCode: inviteRes.body.code });
    assert.equal(joinRes.status, 201);
    return joinRes.body;
  }

  const parent = await issueInviteAndJoin(`Daily-Parent-${suffix}`, '2222');
  const member = await issueInviteAndJoin(`Daily-Member-${suffix}`, '3333');
  const childBudgeted = await issueInviteAndJoin(`Daily-KidA-${suffix}`, '4444');
  const childGeneral = await issueInviteAndJoin(`Daily-KidB-${suffix}`, '5555');

  const householdRes = await request(app)
    .get('/api/auth/household')
    .set(auth(adminRes.body.token));
  assert.equal(householdRes.status, 200);
  assert.equal(householdRes.body.memberCount, 5);

  const householdUsers = await request(app)
    .get(`/api/auth/users?householdId=${adminRes.body.user.household_id}`);
  assert.equal(householdUsers.status, 200);
  assert.equal(householdUsers.body.length, 5);

  const promoteParent = await request(app)
    .patch(`/api/users/${parent.user.id}/role`)
    .set(auth(adminRes.body.token))
    .send({ role: 'parent' });
  assert.equal(promoteParent.status, 200);
  assert.equal(promoteParent.body.role, 'parent');

  const memberRoleSet = await request(app)
    .patch(`/api/auth/household/members/${member.user.id}/role`)
    .set(auth(adminRes.body.token))
    .send({ role: 'member' });
  assert.equal(memberRoleSet.status, 200);
  assert.equal(memberRoleSet.body.member.role, 'member');

  const membersAsParent = await request(app)
    .get('/api/users/members')
    .set(auth(parent.token));
  assert.equal(membersAsParent.status, 200);
  assert.equal(membersAsParent.body.length, 5);

  const membersAsChildDenied = await request(app)
    .get('/api/users/members')
    .set(auth(childBudgeted.token));
  assert.equal(membersAsChildDenied.status, 403);

  const parentProfile = await request(app)
    .get('/api/users/me')
    .set(auth(parent.token));
  assert.equal(parentProfile.status, 200);
  assert.equal(parentProfile.body.role, 'parent');

  const allowanceRes = await request(app)
    .post('/api/allowances')
    .set(auth(parent.token))
    .send({ childId: childBudgeted.user.id, budget: 300, period: 'weekly', approvalThreshold: 60 });
  assert.equal(allowanceRes.status, 201);

  const allowanceList = await request(app)
    .get('/api/allowances')
    .set(auth(parent.token));
  assert.equal(allowanceList.status, 200);
  assert.ok(allowanceList.body.some((a) => a.id === allowanceRes.body.id));

  const allowancePatch = await request(app)
    .patch(`/api/allowances/${allowanceRes.body.id}`)
    .set(auth(parent.token))
    .send({ budget: 320, approvalThreshold: 55, active: true, period: 'weekly' });
  assert.equal(allowancePatch.status, 200);
  assert.equal(allowancePatch.body.approvalThreshold, 55);

  const groceryRequest = await request(app)
    .post('/api/requests')
    .set(auth(childBudgeted.token))
    .send({
      toId: adminRes.body.user.id,
      amount: 120,
      reason: 'Weekly grocery run',
      category: 'groceries',
      tags: ['home', 'food']
    });
  assert.equal(groceryRequest.status, 201);
  assert.equal(groceryRequest.body.status, 'pending_approval');

  const approveGroceryRequest = await request(app)
    .post(`/api/requests/${groceryRequest.body.id}/approve-child`)
    .set(auth(parent.token));
  assert.equal(approveGroceryRequest.status, 200);
  assert.equal(approveGroceryRequest.body.status, 'pending');

  const acceptGroceryRequest = await request(app)
    .patch(`/api/requests/${groceryRequest.body.id}`)
    .set(auth(adminRes.body.token))
    .send({ status: 'accepted' });
  assert.equal(acceptGroceryRequest.status, 200);
  assert.equal(acceptGroceryRequest.body.status, 'accepted');

  const groceryMessage = await request(app)
    .post('/api/messages')
    .set(auth(childBudgeted.token))
    .send({
      refType: 'request',
      refId: groceryRequest.body.id,
      text: 'Added lunch ingredients and staples for the week'
    });
  assert.equal(groceryMessage.status, 201);

  const filteredMessages = await request(app)
    .get(`/api/messages?refType=request&refId=${groceryRequest.body.id}&q=lunch`)
    .set(auth(adminRes.body.token));
  assert.equal(filteredMessages.status, 200);
  assert.ok(filteredMessages.body.length >= 1);

  const attachmentUpload = await request(app)
    .post('/api/attachments')
    .set(auth(childBudgeted.token))
    .send({
      refType: 'request',
      refId: groceryRequest.body.id,
      fileName: 'receipt.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('receipt-line-1\nreceipt-line-2').toString('base64')
    });
  assert.equal(attachmentUpload.status, 201);

  const attachmentList = await request(app)
    .get(`/api/attachments?refType=request&refId=${groceryRequest.body.id}`)
    .set(auth(adminRes.body.token));
  assert.equal(attachmentList.status, 200);
  assert.ok(attachmentList.body.some((a) => a.id === attachmentUpload.body.id));

  const attachmentDownload = await request(app)
    .get(`/api/attachments/${attachmentUpload.body.id}/download`)
    .set(auth(adminRes.body.token));
  assert.equal(attachmentDownload.status, 200);
  assert.equal(attachmentDownload.headers['content-type'], 'text/plain');

  const attachmentDelete = await request(app)
    .delete(`/api/attachments/${attachmentUpload.body.id}`)
    .set(auth(adminRes.body.token));
  assert.equal(attachmentDelete.status, 200);

  const groceryPaymentPart = await request(app)
    .post('/api/payments')
    .set(auth(adminRes.body.token))
    .send({ requestId: groceryRequest.body.id, amount: 70, message: 'First transfer for groceries', category: 'groceries' });
  assert.equal(groceryPaymentPart.status, 201);

  const confirmGroceryPaymentPart = await request(app)
    .patch(`/api/payments/${groceryPaymentPart.body.id}`)
    .set(auth(childBudgeted.token))
    .send({ status: 'confirmed' });
  assert.equal(confirmGroceryPaymentPart.status, 200);

  const partiallySettledView = await request(app)
    .get('/api/requests?status=partially_settled')
    .set(auth(childBudgeted.token));
  assert.equal(partiallySettledView.status, 200);
  assert.ok(partiallySettledView.body.some((r) => r.id === groceryRequest.body.id));

  const groceryPaymentFinal = await request(app)
    .post('/api/payments')
    .set(auth(adminRes.body.token))
    .send({ requestId: groceryRequest.body.id, amount: 50, message: 'Final grocery transfer', category: 'groceries' });
  assert.equal(groceryPaymentFinal.status, 201);

  const confirmGroceryPaymentFinal = await request(app)
    .patch(`/api/payments/${groceryPaymentFinal.body.id}`)
    .set(auth(childBudgeted.token))
    .send({ status: 'confirmed' });
  assert.equal(confirmGroceryPaymentFinal.status, 200);

  const snackPayment = await request(app)
    .post('/api/payments')
    .set(auth(member.token))
    .send({ toId: childGeneral.user.id, amount: 18, message: 'Snack split', category: 'food', tags: ['snacks'] });
  assert.equal(snackPayment.status, 201);

  const disputeSnackPayment = await request(app)
    .patch(`/api/payments/${snackPayment.body.id}`)
    .set(auth(childGeneral.token))
    .send({ status: 'disputed' });
  assert.equal(disputeSnackPayment.status, 200);
  assert.equal(disputeSnackPayment.body.status, 'disputed');

  const disputedPayments = await request(app)
    .get('/api/payments?status=disputed')
    .set(auth(member.token));
  assert.equal(disputedPayments.status, 200);
  assert.ok(disputedPayments.body.some((p) => p.id === snackPayment.body.id));

  const acceptedSettlementRequest = await request(app)
    .post('/api/requests')
    .set(auth(member.token))
    .send({ toId: adminRes.body.user.id, amount: 40, reason: 'Fuel share', category: 'transport' });
  assert.equal(acceptedSettlementRequest.status, 201);

  const acceptSettlementRequest = await request(app)
    .patch(`/api/requests/${acceptedSettlementRequest.body.id}`)
    .set(auth(adminRes.body.token))
    .send({ status: 'accepted' });
  assert.equal(acceptSettlementRequest.status, 200);

  const pendingReminderRequest = await request(app)
    .post('/api/requests')
    .set(auth(childGeneral.token))
    .send({ toId: adminRes.body.user.id, amount: 9, reason: 'School lunch top-up', category: 'school' });
  assert.equal(pendingReminderRequest.status, 201);

  const runReminders = await request(app)
    .post('/api/notifications/reminders/run')
    .set(auth(parent.token))
    .send({ staleHours: 0 });
  assert.equal(runReminders.status, 200);
  assert.ok(runReminders.body.created >= 1);

  const childNotifications = await request(app)
    .get('/api/notifications?unreadOnly=true')
    .set(auth(childGeneral.token));
  assert.equal(childNotifications.status, 200);

  if (childNotifications.body.length > 0) {
    const markOneRead = await request(app)
      .patch(`/api/notifications/${childNotifications.body[0].id}/read`)
      .set(auth(childGeneral.token));
    assert.equal(markOneRead.status, 200);
    assert.equal(markOneRead.body.is_read, true);
  }

  const markAllRead = await request(app)
    .patch('/api/notifications/read-all')
    .set(auth(childGeneral.token));
  assert.equal(markAllRead.status, 200);

  const recurringCreate = await request(app)
    .post('/api/recurring')
    .set(auth(parent.token))
    .send({
      fromId: parent.user.id,
      toId: adminRes.body.user.id,
      amount: 22,
      reason: 'Weekly utilities contribution',
      category: 'utilities',
      tags: ['water', 'power'],
      frequency: 'monthly',
      nextRunAt: '2000-01-01T00:00:00.000Z'
    });
  assert.equal(recurringCreate.status, 201);

  const recurringList = await request(app)
    .get('/api/recurring')
    .set(auth(parent.token));
  assert.equal(recurringList.status, 200);
  assert.ok(recurringList.body.some((rr) => rr.id === recurringCreate.body.id));

  const recurringPatch = await request(app)
    .patch(`/api/recurring/${recurringCreate.body.id}`)
    .set(auth(parent.token))
    .send({ frequency: 'weekly', reason: 'Weekly utilities contribution', nextRunAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(recurringPatch.status, 200);
  assert.equal(recurringPatch.body.frequency, 'weekly');

  const recurringRun = await request(app)
    .post('/api/recurring/run')
    .set(auth(parent.token))
    .send({ limit: 10 });
  assert.equal(recurringRun.status, 200);
  assert.ok(recurringRun.body.generated >= 1);

  const householdSettlements = await request(app)
    .get('/api/settlements/net?scope=household')
    .set(auth(parent.token));
  assert.equal(householdSettlements.status, 200);
  assert.ok(Array.isArray(householdSettlements.body.suggestedTransfers));

  const childHouseholdSettlementsDenied = await request(app)
    .get('/api/settlements/net?scope=household')
    .set(auth(childGeneral.token));
  assert.equal(childHouseholdSettlementsDenied.status, 403);

  const childMineSettlements = await request(app)
    .get('/api/settlements/net?scope=mine')
    .set(auth(childGeneral.token));
  assert.equal(childMineSettlements.status, 200);

  const reportSummary = await request(app)
    .get('/api/reports/summary?scope=household')
    .set(auth(parent.token));
  assert.equal(reportSummary.status, 200);
  assert.ok(reportSummary.body.totals.requestCount >= 1);

  const reportTrends = await request(app)
    .get('/api/reports/trends?scope=household')
    .set(auth(parent.token));
  assert.equal(reportTrends.status, 200);

  const reportCsv = await request(app)
    .get('/api/reports/export.csv?scope=household')
    .set(auth(parent.token));
  assert.equal(reportCsv.status, 200);
  assert.match(reportCsv.text, /type,id,fromId,toId/);

  const reportPdf = await request(app)
    .get('/api/reports/export.pdf?scope=household')
    .set(auth(parent.token));
  assert.equal(reportPdf.status, 200);

  const secondParentLogin = await loginUser(parent.user.id, '2222');

  const parentSessions = await request(app)
    .get('/api/users/sessions')
    .set(auth(parent.token));
  assert.equal(parentSessions.status, 200);
  assert.ok(parentSessions.body.length >= 2);

  const revokeParentSession = await request(app)
    .delete(`/api/users/sessions/${parentSessions.body[0].id}`)
    .set(auth(parent.token));
  assert.equal(revokeParentSession.status, 200);

  const profileOriginalParentToken = await request(app)
    .get('/api/users/me')
    .set(auth(parent.token));
  const profileSecondParentToken = await request(app)
    .get('/api/users/me')
    .set(auth(secondParentLogin.token));
  const tokenStatusSet = [profileOriginalParentToken.status, profileSecondParentToken.status].sort((a, b) => a - b);
  assert.deepEqual(tokenStatusSet, [200, 403]);

  const logoutMember = await request(app)
    .post('/api/auth/logout')
    .set(auth(member.token));
  assert.equal(logoutMember.status, 200);

  const memberAfterLogout = await request(app)
    .get('/api/users/me')
    .set(auth(member.token));
  assert.equal(memberAfterLogout.status, 403);

  const recoveryRequest = await request(app)
    .post('/api/users/pin-recovery-request')
    .set(auth(childGeneral.token))
    .send({ note: 'Forgot PIN after school run' });
  assert.equal(recoveryRequest.status, 201);

  const pinReset = await request(app)
    .post(`/api/users/${childGeneral.user.id}/pin-reset`)
    .set(auth(parent.token))
    .send({ newPin: '5656' });
  assert.equal(pinReset.status, 200);

  const reloginAfterReset = await request(app)
    .post('/api/auth/login')
    .send({ userId: childGeneral.user.id, pin: '5656' });
  assert.equal(reloginAfterReset.status, 200);
});
