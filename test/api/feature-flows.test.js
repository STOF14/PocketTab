const {
  test,
  assert,
  request,
  app,
  uniqueSuffix,
  auth,
  loginUser,
  registerUser
} = require('./helpers');

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
    .field('refType', 'request')
    .field('refId', reqTeenToMom.body.id)
    .attach('file', Buffer.from('proof-of-payment'), {
      filename: 'proof.txt',
      contentType: 'text/plain'
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

  const momRelogin = await loginUser(family.mom.user.id, '1111');

  // Reset-all role + env gate.
  process.env.ALLOW_DATA_RESET = 'false';
  const resetDenied = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(family.dad.token))
    .send({ confirmation: 'RESET EVERYTHING', resetSecret: process.env.DATA_RESET_SECRET });
  assert.equal(resetDenied.status, 403);

  process.env.ALLOW_DATA_RESET = 'true';
  const resetNonAdminDenied = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(family.dad.token))
    .send({ confirmation: 'RESET EVERYTHING', resetSecret: process.env.DATA_RESET_SECRET });
  assert.equal(resetNonAdminDenied.status, 403);

  const resetBadSecret = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(momRelogin.token))
    .send({ confirmation: 'RESET EVERYTHING', resetSecret: 'wrong-secret' });
  assert.equal(resetBadSecret.status, 403);

  const resetBadConfirm = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(momRelogin.token))
    .send({ confirmation: 'NOPE', resetSecret: process.env.DATA_RESET_SECRET });
  assert.equal(resetBadConfirm.status, 400);

  const resetOk = await request(app)
    .delete('/api/users/reset-all')
    .set(auth(momRelogin.token))
    .send({ confirmation: 'RESET EVERYTHING', resetSecret: process.env.DATA_RESET_SECRET });
  assert.equal(resetOk.status, 200);

  const profileAfterReset = await request(app)
    .get('/api/users/me')
    .set(auth(momRelogin.token));
  assert.equal(profileAfterReset.status, 403);

  process.env.ALLOW_DATA_RESET = 'false';
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
    .get('/api/auth/household/members')
    .set(auth(adminRes.body.token));
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
    .field('refType', 'request')
    .field('refId', groceryRequest.body.id)
    .attach('file', Buffer.from('receipt-line-1\nreceipt-line-2'), {
      filename: 'receipt.txt',
      contentType: 'text/plain'
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

