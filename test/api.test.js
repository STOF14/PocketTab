const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.DB_PATH = path.join(os.tmpdir(), `pockettab-test-${crypto.randomUUID()}.db`);
process.env.ALLOW_DATA_RESET = 'false';
process.env.DISABLE_RATE_LIMIT = 'true';

const app = require('../server/app');

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
  assert.equal(outsiderMessageAccess.status, 403);

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
  assert.ok(familyAMembers.body.every((member) => [familyAAdmin.user.id, familyAChild.body.user.id].includes(member.id)));

  const reset = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(familyAAdmin.token))
    .send({ confirmation: 'RESET EVERYTHING' });
  assert.equal(reset.status, 403);
});
