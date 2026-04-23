const express = require('express');
const db = require('../db');
const config = require('../config');
const {
  authenticateToken,
  issueSessionToken,
  issueHouseholdAccessToken,
  verifyHouseholdAccessToken,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
  requireRole,
  HOUSEHOLD_ACCESS_TTL_MINUTES,
  JWT_SECRET
} = require('../middleware/auth');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const {
  consumeInvite,
  createHousehold,
  createInvite,
  getUserHousehold,
  getHouseholdByLoginId,
  rotateHouseholdLoginCode,
  resetHouseholdLoginCredentials
} = require('../services/households');
const { hashPin, verifyPin, needsPinRehash } = require('../services/pin-security');
const { isValidHouseholdCode, normalizeHouseholdLoginId } = require('../services/household-login');

const router = express.Router();
const MAX_LOGIN_ATTEMPTS = Number.parseInt(process.env.PIN_MAX_ATTEMPTS || '5', 10);
const LOCK_MINUTES = Number.parseInt(process.env.PIN_LOCK_MINUTES || '15', 10);
const requireExplicitHouseholdFlow = config.isProduction;
const allowLegacyLoginWithoutHouseholdAccess =
  process.env.ALLOW_LEGACY_LOGIN_WITHOUT_HOUSEHOLD_ACCESS === 'true' || !config.isProduction;
const GOOGLE_STATE_COOKIE_NAME = 'pt_google_oauth_state';
const GOOGLE_ACTION_COOKIE_NAME = 'pt_google_oauth_action';
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_ACTION_TTL_MS = 10 * 60 * 1000;
const googleOAuthClient = new OAuth2Client();
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();

function isGoogleAuthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function parseForwardedHeaderValue(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const first = value.split(',')[0]?.trim();
  return first || null;
}

function getRequestOrigin(req) {
  const proto = parseForwardedHeaderValue(req.get('x-forwarded-proto')) || req.protocol || 'http';
  const host = parseForwardedHeaderValue(req.get('x-forwarded-host')) || req.get('host');
  return `${proto}://${host}`;
}

function getGoogleRedirectUri(req) {
  const configured = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (configured && configured.trim()) {
    return configured.trim();
  }

  return `${getRequestOrigin(req)}/api/auth/google/callback`;
}

function googleStateCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/api/auth/google',
    maxAge: GOOGLE_STATE_TTL_MS
  };
}

function googleActionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/api/auth/google',
    maxAge: GOOGLE_ACTION_TTL_MS
  };
}

function googleStateCookieClearOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/api/auth/google'
  };
}

function googleActionCookieClearOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/api/auth/google'
  };
}

function toBase64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signGoogleActionPayload(encodedPayload) {
  return crypto.createHmac('sha256', JWT_SECRET).update(encodedPayload).digest('hex');
}

function createGoogleActionToken(payload) {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signGoogleActionPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function readGoogleActionToken(token) {
  if (typeof token !== 'string' || token.trim() === '') {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signGoogleActionPayload(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const providedBuffer = Buffer.from(signature, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(encodedPayload));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    if (!Number.isFinite(Number(parsed.exp)) || Number(parsed.exp) <= Date.now()) {
      return null;
    }

    if (parsed.mode !== 'login' && parsed.mode !== 'link') {
      return null;
    }

    return parsed;
  } catch (err) {
    return null;
  }
}

function parseCookieValue(req, cookieName) {
  const cookieHeader = req.headers?.cookie;
  if (typeof cookieHeader !== 'string' || cookieHeader.trim() === '') {
    return null;
  }

  const targetPrefix = `${cookieName}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(targetPrefix)) {
      continue;
    }

    const rawValue = trimmed.slice(targetPrefix.length);
    try {
      return decodeURIComponent(rawValue);
    } catch (err) {
      return rawValue;
    }
  }

  return null;
}

function redirectWithGoogleAuthError(res, code) {
  return res.redirect(303, `/app?auth_error=${encodeURIComponent(code)}`);
}

function redirectWithGoogleLinkResult(res, code) {
  return res.redirect(303, `/app?auth_link=${encodeURIComponent(code)}`);
}

function normalizeGoogleDisplayName(payload) {
  const candidateName = String(payload?.name || '').trim();
  if (candidateName) {
    return candidateName.slice(0, 20);
  }

  const emailPrefix = String(payload?.email || '').trim().split('@')[0];
  if (emailPrefix) {
    return emailPrefix.slice(0, 20);
  }

  return 'Google User';
}

function makeUnpredictablePin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function googleAuthFailure(code, message) {
  const err = new Error(message || code);
  err.authErrorCode = code;
  return err;
}

function beginGoogleAuth(req, res, actionPayload) {
  const state = crypto.randomBytes(18).toString('hex');
  const redirectUri = getGoogleRedirectUri(req);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account'
  });

  const actionToken = createGoogleActionToken(actionPayload);
  res.cookie(GOOGLE_STATE_COOKIE_NAME, state, googleStateCookieOptions());
  res.cookie(GOOGLE_ACTION_COOKIE_NAME, actionToken, googleActionCookieOptions());
  return res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

// GET /api/auth/google/status — google auth availability for frontend
router.get('/google/status', (req, res) => {
  return res.json({ enabled: isGoogleAuthConfigured() });
});

// GET /api/auth/google/link/status — linked state for authenticated user
router.get('/google/link/status', authenticateToken, (req, res) => {
  const me = db.prepare('SELECT google_sub, google_email FROM users WHERE id = ?').get(req.userId);
  return res.json({
    enabled: isGoogleAuthConfigured(),
    linked: Boolean(me?.google_sub),
    email: me?.google_email || null
  });
});

// GET /api/auth/google/start — start Google OAuth flow
router.get('/google/start', (req, res) => {
  if (!isGoogleAuthConfigured()) {
    return redirectWithGoogleAuthError(res, 'google_not_configured');
  }

  return beginGoogleAuth(req, res, {
    mode: 'login',
    exp: Date.now() + GOOGLE_ACTION_TTL_MS
  });
});

// GET /api/auth/google/link/start — start authenticated account-link flow
router.get('/google/link/start', authenticateToken, (req, res) => {
  if (!isGoogleAuthConfigured()) {
    return redirectWithGoogleAuthError(res, 'google_not_configured');
  }

  return beginGoogleAuth(req, res, {
    mode: 'link',
    userId: req.userId,
    exp: Date.now() + GOOGLE_ACTION_TTL_MS
  });
});

// GET /api/auth/google/callback — complete Google OAuth and establish session
router.get('/google/callback', async (req, res) => {
  if (!isGoogleAuthConfigured()) {
    return redirectWithGoogleAuthError(res, 'google_not_configured');
  }

  if (typeof req.query?.error === 'string' && req.query.error.trim()) {
    res.clearCookie(GOOGLE_STATE_COOKIE_NAME, googleStateCookieClearOptions());
    res.clearCookie(GOOGLE_ACTION_COOKIE_NAME, googleActionCookieClearOptions());
    return redirectWithGoogleAuthError(res, 'google_access_denied');
  }

  const authorizationCode = String(req.query?.code || '').trim();
  const callbackState = String(req.query?.state || '').trim();
  const expectedState = parseCookieValue(req, GOOGLE_STATE_COOKIE_NAME);
  const actionToken = parseCookieValue(req, GOOGLE_ACTION_COOKIE_NAME);
  const action = readGoogleActionToken(actionToken) || {
    mode: 'login',
    exp: Date.now() + GOOGLE_ACTION_TTL_MS
  };

  if (!authorizationCode || !callbackState || !expectedState || callbackState !== expectedState) {
    res.clearCookie(GOOGLE_STATE_COOKIE_NAME, googleStateCookieClearOptions());
    res.clearCookie(GOOGLE_ACTION_COOKIE_NAME, googleActionCookieClearOptions());
    return redirectWithGoogleAuthError(res, 'google_state_mismatch');
  }

  try {
    const redirectUri = getGoogleRedirectUri(req);
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: authorizationCode,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenResponse.ok) {
      let tokenError = null;
      try {
        tokenError = await tokenResponse.json();
      } catch (parseErr) {
        tokenError = null;
      }

      const oauthError = String(tokenError?.error || '').toLowerCase();
      const oauthDescription = String(tokenError?.error_description || '').toLowerCase();

      if (oauthError === 'invalid_client') {
        throw googleAuthFailure('google_invalid_client', 'Google OAuth client credentials are invalid');
      }

      if (oauthDescription.includes('redirect_uri_mismatch')) {
        throw googleAuthFailure('google_redirect_uri_mismatch', 'Google OAuth redirect URI mismatch');
      }

      throw googleAuthFailure('google_token_exchange_failed', 'Failed to exchange Google authorization code');
    }

    const tokenPayload = await tokenResponse.json();
    const idToken = String(tokenPayload?.id_token || '').trim();
    if (!idToken) {
      throw googleAuthFailure('google_missing_id_token', 'Missing ID token from Google');
    }

    const ticket = await googleOAuthClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });
    const googleProfile = ticket.getPayload() || {};
    const googleSub = String(googleProfile.sub || '').trim();
    const googleEmail = String(googleProfile.email || '').trim().toLowerCase();
    const emailVerified = googleProfile.email_verified === true || googleProfile.email_verified === 'true';

    if (!googleSub || !googleEmail || !emailVerified) {
      throw googleAuthFailure('google_account_not_verified', 'Google account payload is incomplete');
    }

    if (action.mode === 'link') {
      const targetUserId = String(action.userId || '').trim();
      if (!targetUserId) {
        throw new Error('Google link target user not found');
      }

      const targetUser = db.prepare('SELECT id, google_sub FROM users WHERE id = ?').get(targetUserId);
      if (!targetUser) {
        throw new Error('Google link target user not found');
      }

      const linkedBySub = db.prepare('SELECT id FROM users WHERE google_sub = ? LIMIT 1').get(googleSub);
      if (linkedBySub && linkedBySub.id !== targetUser.id) {
        res.clearCookie(GOOGLE_STATE_COOKIE_NAME, googleStateCookieClearOptions());
        res.clearCookie(GOOGLE_ACTION_COOKIE_NAME, googleActionCookieClearOptions());
        return redirectWithGoogleLinkResult(res, 'already_linked_elsewhere');
      }

      const linkedByEmail = db.prepare('SELECT id FROM users WHERE google_email = ? COLLATE NOCASE LIMIT 1').get(googleEmail);
      if (linkedByEmail && linkedByEmail.id !== targetUser.id) {
        res.clearCookie(GOOGLE_STATE_COOKIE_NAME, googleStateCookieClearOptions());
        res.clearCookie(GOOGLE_ACTION_COOKIE_NAME, googleActionCookieClearOptions());
        return redirectWithGoogleLinkResult(res, 'email_in_use_elsewhere');
      }

      if (targetUser.google_sub && targetUser.google_sub !== googleSub) {
        res.clearCookie(GOOGLE_STATE_COOKIE_NAME, googleStateCookieClearOptions());
        res.clearCookie(GOOGLE_ACTION_COOKIE_NAME, googleActionCookieClearOptions());
        return redirectWithGoogleLinkResult(res, 'different_google_already_linked');
      }

      db.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').run(googleSub, googleEmail, targetUser.id);
      const token = issueSessionToken(targetUser.id, req);
      setSessionCookie(res, token);
      res.clearCookie(GOOGLE_STATE_COOKIE_NAME, googleStateCookieClearOptions());
      res.clearCookie(GOOGLE_ACTION_COOKIE_NAME, googleActionCookieClearOptions());
      return redirectWithGoogleLinkResult(res, 'google_success');
    }

    let user = db.prepare(
      'SELECT id, household_id, name, role, created_at, google_email FROM users WHERE google_sub = ?'
    ).get(googleSub);

    if (!user) {
      const linkedByEmail = db.prepare(
        'SELECT id, household_id, name, role, created_at, google_sub, google_email FROM users WHERE google_email = ? COLLATE NOCASE LIMIT 1'
      ).get(googleEmail);

      if (linkedByEmail) {
        db.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').run(googleSub, googleEmail, linkedByEmail.id);
        user = {
          id: linkedByEmail.id,
          household_id: linkedByEmail.household_id,
          name: linkedByEmail.name,
          role: linkedByEmail.role,
          created_at: linkedByEmail.created_at,
          google_email: googleEmail
        };
      }
    }

    if (!user) {
      const createdAt = new Date().toISOString();
      const displayName = normalizeGoogleDisplayName(googleProfile);
      const createdHousehold = createHousehold(`${displayName}'s household`);
      const newUserId = crypto.randomUUID();

      db.prepare(
        `INSERT INTO users (
          id,
          household_id,
          name,
          pin_hash,
          pin_hash_needs_rehash,
          role,
          failed_login_attempts,
          locked_until,
          google_sub,
          google_email,
          created_at
        ) VALUES (?, ?, ?, ?, 0, 'admin', 0, NULL, ?, ?, ?)`
      ).run(
        newUserId,
        createdHousehold.id,
        displayName,
        hashPin(makeUnpredictablePin()),
        googleSub,
        googleEmail,
        createdAt
      );

      user = {
        id: newUserId,
        household_id: createdHousehold.id,
        name: displayName,
        role: 'admin',
        created_at: createdAt,
        google_email: googleEmail
      };
    } else if (user.google_email !== googleEmail) {
      db.prepare('UPDATE users SET google_email = ? WHERE id = ?').run(googleEmail, user.id);
    }

    const token = issueSessionToken(user.id, req);
    setSessionCookie(res, token);
    res.clearCookie(GOOGLE_STATE_COOKIE_NAME, googleStateCookieClearOptions());
    res.clearCookie(GOOGLE_ACTION_COOKIE_NAME, googleActionCookieClearOptions());
    return res.redirect(303, '/app');
  } catch (err) {
    const authErrorCode = typeof err?.authErrorCode === 'string' ? err.authErrorCode : 'google_sign_in_failed';
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      type: 'google_oauth_error',
      requestId: req.requestId || null,
      path: req.originalUrl,
      code: authErrorCode,
      message: err?.message || 'Google OAuth failed'
    }));
    res.clearCookie(GOOGLE_STATE_COOKIE_NAME, googleStateCookieClearOptions());
    res.clearCookie(GOOGLE_ACTION_COOKIE_NAME, googleActionCookieClearOptions());
    return redirectWithGoogleAuthError(res, authErrorCode);
  }
});

function retryAfterSeconds(lockedUntilIso) {
  const remainingMs = new Date(lockedUntilIso).getTime() - Date.now();
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function toStoredRole(role) {
  return role === 'member' ? 'child' : role;
}

function toPublicRole(role) {
  return role === 'admin' ? 'admin' : 'member';
}

function hasHouseholdRecoveryPrivileges(role) {
  return role === 'admin' || role === 'parent';
}

// GET /api/auth/users — List all users (public, for login screen)
router.get('/users', (req, res) => {
  let users = [];
  if (req.query.inviteCode) {
    const invite = db.prepare(
      'SELECT household_id FROM household_invites WHERE code = ? AND used_at IS NULL AND expires_at > ?'
    ).get(String(req.query.inviteCode).trim(), new Date().toISOString());
    users = invite
      ? db.prepare('SELECT id, household_id, name, role, created_at FROM users WHERE household_id = ? ORDER BY created_at ASC').all(invite.household_id)
      : [];
  } else {
    return res.status(400).json({ error: 'inviteCode query parameter is required' });
  }
  res.json(users);
});

// POST /api/auth/household/access — validate household login ID + code and return members
router.post('/household/access', (req, res) => {
  const householdLoginId = normalizeHouseholdLoginId(req.body?.householdLoginId);
  const householdCode = String(req.body?.householdCode || '').trim();

  if (!householdLoginId) {
    return res.status(400).json({ error: 'Household login ID is required' });
  }

  if (!isValidHouseholdCode(householdCode)) {
    return res.status(400).json({ error: 'Household code must be 6 digits' });
  }

  const household = getHouseholdByLoginId(householdLoginId);
  if (!household || !verifyPin(householdCode, household.login_code_hash).matched) {
    return res.status(401).json({ error: 'Invalid household login credentials' });
  }

  const members = db.prepare(
    'SELECT id, household_id, name, role, created_at FROM users WHERE household_id = ? ORDER BY created_at ASC'
  ).all(household.id);

  if (members.length === 0) {
    return res.status(404).json({ error: 'No users found for this household' });
  }

  const accessToken = issueHouseholdAccessToken(household.id);
  return res.json({
    accessToken,
    expiresInSeconds: HOUSEHOLD_ACCESS_TTL_MINUTES * 60,
    household: {
      id: household.id,
      name: household.name,
      login_id: household.login_id,
      loginId: household.login_id
    },
    members
  });
});

// POST /api/auth/household/recover-reset — reset forgotten household login details
router.post('/household/recover-reset', (req, res) => {
  const memberName = String(req.body?.memberName || '').trim().slice(0, 20);
  const pin = String(req.body?.pin || '').trim();
  const householdName = String(req.body?.householdName || '').trim().slice(0, 80);
  const rotateLoginId = req.body?.rotateLoginId !== false;

  if (!memberName) {
    return res.status(400).json({ error: 'Member name is required' });
  }

  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4 digits' });
  }

  const baseQuery = householdName
    ? `SELECT u.id, u.household_id, u.role, u.pin_hash, u.locked_until, h.name as household_name
       FROM users u
       JOIN households h ON h.id = u.household_id
       WHERE u.name = ? COLLATE NOCASE AND h.name = ? COLLATE NOCASE
       LIMIT 25`
    : `SELECT u.id, u.household_id, u.role, u.pin_hash, u.locked_until, h.name as household_name
       FROM users u
       JOIN households h ON h.id = u.household_id
       WHERE u.name = ? COLLATE NOCASE
       LIMIT 25`;
  const candidates = householdName
    ? db.prepare(baseQuery).all(memberName, householdName)
    : db.prepare(baseQuery).all(memberName);

  if (candidates.length === 0) {
    return res.status(401).json({ error: 'Unable to verify recovery details' });
  }

  const now = Date.now();
  let matched = null;
  let matchedCount = 0;
  let sawLockedCandidate = false;
  let sawNonPrivilegedMatch = false;

  for (const candidate of candidates) {
    if (candidate.locked_until && new Date(candidate.locked_until).getTime() > now) {
      sawLockedCandidate = true;
      continue;
    }

    const pinCheck = verifyPin(pin, candidate.pin_hash);
    if (!pinCheck.matched) {
      continue;
    }

    if (!hasHouseholdRecoveryPrivileges(candidate.role)) {
      sawNonPrivilegedMatch = true;
      continue;
    }

    matched = candidate;
    matchedCount += 1;
  }

  if (matchedCount > 1) {
    return res.status(409).json({ error: 'Multiple households matched. Add householdName to recovery request.' });
  }

  if (!matched) {
    if (sawNonPrivilegedMatch) {
      return res.status(403).json({ error: 'Only a household admin or parent can reset household login details' });
    }

    if (sawLockedCandidate) {
      return res.status(423).json({ error: 'Matched account is temporarily locked. Try again later.' });
    }

    return res.status(401).json({ error: 'Unable to verify recovery details' });
  }

  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(matched.id);

  const reset = resetHouseholdLoginCredentials(matched.household_id, { rotateLoginId });
  if (!reset) {
    return res.status(404).json({ error: 'Household not found' });
  }

  return res.json({
    message: 'Household login details reset',
    householdLoginId: reset.login_id,
    householdCode: reset.login_code_plain,
    householdName: matched.household_name,
    loginIdRotated: Boolean(reset.login_id_rotated)
  });
});

// GET /api/auth/invites/:code — validate invite and preview household/members
router.get('/invites/:code', (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) {
    return res.status(400).json({ error: 'Invite code is required' });
  }

  const invite = db.prepare(
    `SELECT hi.id, hi.household_id, hi.expires_at, hi.used_at, h.name as household_name
     FROM household_invites hi
     JOIN households h ON h.id = hi.household_id
     WHERE hi.code = ?`
  ).get(code);

  if (!invite) {
    return res.status(404).json({ error: 'Invite code not found' });
  }

  if (invite.used_at) {
    return res.status(410).json({ error: 'Invite code already used' });
  }

  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ error: 'Invite code expired' });
  }

  const members = db.prepare(
    'SELECT id, household_id, name, role, created_at FROM users WHERE household_id = ? ORDER BY created_at ASC'
  ).all(invite.household_id);

  return res.json({
    code,
    household: {
      id: invite.household_id,
      name: invite.household_name
    },
    expires_at: invite.expires_at,
    members
  });
});

// POST /api/auth/register — Create a new user
router.post('/register', (req, res) => {
  const { name, pin, inviteCode, createHousehold: shouldCreateHousehold, householdName } = req.body ?? {};

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'Name is required' });
  }

  if (!pin || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4 digits' });
  }

  const trimmedName = name.trim().slice(0, 20);

  const createdAt = new Date().toISOString();
  let householdId = null;
  let inviteResolution = null;
  let createdHousehold = null;

  if (inviteCode) {
    const inviteRow = db.prepare('SELECT household_id FROM household_invites WHERE code = ?').get(String(inviteCode).trim());
    if (!inviteRow) {
      return res.status(400).json({ error: 'Invalid invite code' });
    }
    householdId = inviteRow.household_id;
  } else if (shouldCreateHousehold) {
    createdHousehold = createHousehold(householdName || `${trimmedName}'s household`);
    householdId = createdHousehold.id;
  } else {
    if (requireExplicitHouseholdFlow) {
      return res.status(400).json({ error: 'Provide inviteCode or set createHousehold=true' });
    }

    const firstHousehold = db.prepare('SELECT id FROM households ORDER BY created_at ASC LIMIT 1').get();
    if (firstHousehold) {
      householdId = firstHousehold.id;
    } else {
      createdHousehold = createHousehold(householdName || `${trimmedName}'s household`);
      householdId = createdHousehold.id;
    }
  }

  const id = crypto.randomUUID();
  const existing = db.prepare('SELECT id FROM users WHERE household_id = ? AND name = ? COLLATE NOCASE').get(householdId, trimmedName);
  if (existing) {
    return res.status(400).json({ error: 'Name already taken in this household' });
  }

  const pinHash = hashPin(pin);
  const householdUserCount = db.prepare('SELECT COUNT(*) as total FROM users WHERE household_id = ?').get(householdId).total;
  const role = householdUserCount === 0 ? 'admin' : 'child';

  db.prepare(
    'INSERT INTO users (id, household_id, name, pin_hash, role, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(id, householdId, trimmedName, pinHash, role, createdAt);

  if (inviteCode) {
    inviteResolution = consumeInvite(String(inviteCode).trim(), id);
    if (inviteResolution.error) {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return res.status(400).json({ error: inviteResolution.error });
    }
  }

  const token = issueSessionToken(id, req);
  setSessionCookie(res, token);
  const responseBody = {
    token,
    user: { id, household_id: householdId, name: trimmedName, role, created_at: createdAt }
  };

  if (createdHousehold) {
    responseBody.householdAuth = {
      householdLoginId: createdHousehold.login_id,
      householdCode: createdHousehold.login_code_plain
    };
  }

  res.status(201).json(responseBody);
});

// POST /api/auth/login — Login with user ID + PIN
router.post('/login', (req, res) => {
  const { userId, pin, householdAccessToken } = req.body ?? {};

  if (!userId || !pin) {
    return res.status(400).json({ error: 'User ID and PIN required' });
  }

  if (!householdAccessToken && !allowLegacyLoginWithoutHouseholdAccess) {
    return res.status(400).json({ error: 'Household access token is required. Re-enter household login details.' });
  }

  let householdAccess = null;
  if (householdAccessToken) {
    householdAccess = verifyHouseholdAccessToken(householdAccessToken);
    if (!householdAccess.valid) {
      return res.status(403).json({ error: 'Household access expired. Re-enter household login details.' });
    }
  }

  const user = householdAccess?.householdId
    ? db.prepare('SELECT * FROM users WHERE id = ? AND household_id = ?').get(userId, householdAccess.householdId)
    : db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return res.status(423).json({
      error: 'Account is temporarily locked',
      lockedUntil: user.locked_until,
      retryAfter: retryAfterSeconds(user.locked_until)
    });
  }

  const pinCheck = verifyPin(pin, user.pin_hash);

  if (!pinCheck.matched) {
    const nextAttempts = Number(user.failed_login_attempts || 0) + 1;
    if (nextAttempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = ? WHERE id = ?').run(lockedUntil, user.id);
      return res.status(423).json({
        error: 'Too many failed attempts. Account locked temporarily.',
        lockedUntil,
        retryAfter: retryAfterSeconds(lockedUntil)
      });
    }

    db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = NULL WHERE id = ?').run(nextAttempts, user.id);
    return res.status(401).json({ error: 'Incorrect PIN', attemptsRemaining: MAX_LOGIN_ATTEMPTS - nextAttempts });
  }

  if (needsPinRehash(user.pin_hash, pinCheck.matchedWithPepper, Boolean(user.pin_hash_needs_rehash))) {
    const rehashedPin = hashPin(pin);
    db.prepare(
      'UPDATE users SET pin_hash = ?, pin_hash_needs_rehash = 0, failed_login_attempts = 0, locked_until = NULL WHERE id = ?'
    ).run(rehashedPin, user.id);
  } else {
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  }

  const token = issueSessionToken(user.id, req);
  setSessionCookie(res, token);
  res.json({
    token,
    user: {
      id: user.id,
      household_id: user.household_id || null,
      name: user.name,
      role: user.role,
      created_at: user.created_at
    }
  });
});

// POST /api/auth/logout — Revoke current session
router.post('/logout', authenticateToken, (req, res) => {
  revokeSession(req.sessionId);
  clearSessionCookie(res);
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/household — get current household details
router.get('/household', authenticateToken, (req, res) => {
  const household = getUserHousehold(req.userId);
  if (!household) {
    return res.status(404).json({ error: 'Household not found' });
  }

  const memberCount = db.prepare('SELECT COUNT(*) as total FROM users WHERE household_id = ?').get(household.id).total;
  return res.json({ ...household, loginId: household.login_id, memberCount });
});

// GET /api/auth/household/members — list members in current household
router.get('/household/members', authenticateToken, (req, res) => {
  const members = db.prepare(
    'SELECT id, household_id, name, role, created_at FROM users WHERE household_id = ? ORDER BY created_at ASC'
  ).all(req.householdId);

  return res.json(members);
});

// POST /api/auth/household/invites — create join invite for current household
router.post('/household/invites', authenticateToken, requireRole('admin'), (req, res) => {
  const ttlHours = Number.parseInt(req.body?.ttlHours || '24', 10);
  const invite = createInvite(req.householdId, req.userId, Number.isInteger(ttlHours) && ttlHours > 0 ? ttlHours : 24);
  return res.status(201).json(invite);
});

// POST /api/auth/household/login-code/rotate — rotate household login code (admin)
router.post('/household/login-code/rotate', authenticateToken, requireRole('admin'), (req, res) => {
  const rotated = rotateHouseholdLoginCode(req.householdId);
  if (!rotated) {
    return res.status(404).json({ error: 'Household not found' });
  }

  return res.status(201).json({
    message: 'Household login code rotated',
    householdLoginId: rotated.login_id,
    householdCode: rotated.login_code_plain
  });
});

// PATCH /api/auth/household/members/:userId/role — admin-only role management within household
router.patch('/household/members/:userId/role', authenticateToken, requireRole('admin'), (req, res) => {
  const requestedRole = String(req.body?.role || '').trim().toLowerCase();
  if (!['admin', 'member'].includes(requestedRole)) {
    return res.status(400).json({ error: 'role must be admin or member' });
  }

  const target = db.prepare('SELECT id, household_id, role FROM users WHERE id = ?').get(req.params.userId);
  if (!target || target.household_id !== req.householdId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const nextStoredRole = toStoredRole(requestedRole);
  if (target.role === 'admin' && nextStoredRole !== 'admin') {
    const adminCount = db.prepare('SELECT COUNT(*) as total FROM users WHERE household_id = ? AND role = ?').get(req.householdId, 'admin').total;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'At least one admin is required per household' });
    }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(nextStoredRole, target.id);

  const updated = db.prepare('SELECT id, role FROM users WHERE id = ?').get(target.id);
  return res.json({
    message: 'Role updated',
    member: {
      id: updated.id,
      role: toPublicRole(updated.role)
    }
  });
});

module.exports = router;
