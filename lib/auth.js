// lib/auth.js
// Passwordless magic link auth + session management

const crypto = require('crypto');
const db = require('../db/client');
const { sendMagicLinkEmail } = require('./email');

const MAGIC_LINK_EXPIRES_MIN = 15;
const SESSION_EXPIRES_DAYS = 30;

function genToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Issue a magic link to the user's email. Creates user if doesn't exist.
async function requestMagicLink(email, { name = null, tier = null } = {}) {
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    throw new Error('Invalid email');
  }

  // Find or create user
  let user = await db.one(`SELECT * FROM users WHERE email = $1`, [cleanEmail]);
  let isNew = false;
  if (!user) {
    isNew = true;
    const initialTier = tier === 'free' ? 'free' : null;
    const initialStatus = tier === 'free' ? 'active' : 'pending';
    user = await db.one(
      `INSERT INTO users (email, name, subscription_tier, subscription_status) VALUES ($1, $2, $3, $4) RETURNING *`,
      [cleanEmail, name, initialTier, initialStatus]
    );
    console.log(`[auth] Created user: ${cleanEmail} (tier=${initialTier || 'none'})`);
  } else if (tier === 'free' && !user.subscription_tier) {
    await db.query(
      `UPDATE users SET subscription_tier = 'free', subscription_status = 'active' WHERE id = $1 AND subscription_tier IS NULL`,
      [user.id]
    );
  }

  const token = genToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRES_MIN * 60 * 1000);

  console.log(`[auth] Inserting auth token for ${cleanEmail}`);
  await db.query(
    `INSERT INTO auth_tokens (token, user_id, email, expires_at) VALUES ($1, $2, $3, $4)`,
    [token, user.id, cleanEmail, expiresAt]
  );

  const link = `${process.env.PUBLIC_URL}/auth/verify?token=${token}`;
  console.log(`[auth] Calling sendMagicLinkEmail for ${cleanEmail}`);
  await sendMagicLinkEmail(cleanEmail, link, MAGIC_LINK_EXPIRES_MIN);
  console.log(`[auth] sendMagicLinkEmail returned for ${cleanEmail}`);

  return { sent: true, email: cleanEmail, isNew };
}

// Verify a magic link, create a session, return session token
async function verifyMagicLink(token, { ip = null, userAgent = null } = {}) {
  if (!token) throw new Error('Missing token');

  const auth = await db.one(
    `SELECT * FROM auth_tokens WHERE token = $1`,
    [token]
  );
  if (!auth) throw new Error('Invalid or expired link');
  if (auth.used_at) throw new Error('Link already used');
  if (new Date(auth.expires_at) < new Date()) throw new Error('Link expired');

  // Mark token as used (single-use)
  await db.query(`UPDATE auth_tokens SET used_at = NOW() WHERE token = $1`, [token]);

  // Look up user before update so we can detect first-time signin
  const user = await db.one(`SELECT * FROM users WHERE id = $1`, [auth.user_id]);
  const isFirstSignin = !user.email_verified;

  // Mark user verified + last login
  await db.query(
    `UPDATE users SET email_verified = TRUE, last_login_at = NOW() WHERE id = $1`,
    [auth.user_id]
  );

  // Send welcome email on first sign-in (tier-aware, non-fatal)
  if (isFirstSignin) {
    try {
      const { sendWelcomeEmail } = require('./email');
      await sendWelcomeEmail(user.email, user.name, user.subscription_tier);
    } catch (e) {
      console.error('[auth] welcome email failed (non-fatal):', e.message);
    }
  }

  // Create session via shared helper
  const sessionToken = await createSessionForUser(auth.user_id, { ip, userAgent });
  return { sessionToken, userId: auth.user_id };
}

// Create a fresh session for a user (used by magic-link verify AND OAuth callbacks)
async function createSessionForUser(userId, { ip = null, userAgent = null } = {}) {
  const sessionToken = genToken(48);
  const sessionExpires = new Date(Date.now() + SESSION_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO sessions (token, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionToken, userId, sessionExpires, ip, userAgent]
  );
  return sessionToken;
}

// Look up the user attached to a session token
async function getUserFromSession(sessionToken) {
  if (!sessionToken) return null;
  const row = await db.one(
    `SELECT u.*, s.expires_at as session_expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [sessionToken]
  );
  return row;
}

async function destroySession(sessionToken) {
  if (!sessionToken) return;
  await db.query(`DELETE FROM sessions WHERE token = $1`, [sessionToken]);
}

// Express middleware: require valid session, attach req.user
function requireAuth(req, res, next) {
  const sessionToken = req.cookies?.session;
  if (!sessionToken) return res.redirect('/login');
  getUserFromSession(sessionToken).then(user => {
    if (!user) {
      res.clearCookie('session');
      return res.redirect('/login');
    }
    req.user = user;
    next();
  }).catch(next);
}

// JSON-API variant of requireAuth
function requireAuthApi(req, res, next) {
  const sessionToken = req.cookies?.session;
  if (!sessionToken) return res.status(401).json({ error: 'Not logged in' });
  getUserFromSession(sessionToken).then(user => {
    if (!user) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Session expired' });
    }
    req.user = user;
    next();
  }).catch(next);
}

// Require an active subscription (active or trialing)
function requireActiveSubscription(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const status = req.user.subscription_status;
  if (status !== 'active' && status !== 'trialing') {
    return res.status(402).json({
      error: 'Subscription required',
      tier: req.user.subscription_tier,
      status,
      action_url: '/billing',
    });
  }
  next();
}

// Require rewards access (rewards or coach tier)
function requireRewardsAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  if (!['rewards', 'coach'].includes(req.user.subscription_tier)) {
    return res.status(403).json({
      error: 'Membership required',
      action_url: '/billing/upgrade',
    });
  }
  next();
}
// Backwards-compat alias
const requireElite = requireRewardsAccess;

// Admin guard
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// Helper: set session cookie
function setSessionCookie(res, sessionToken) {
  res.cookie('session', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  });
}

module.exports = {
  requestMagicLink,
  verifyMagicLink,
  createSessionForUser,
  getUserFromSession,
  destroySession,
  requireAuth,
  requireAuthApi,
  requireActiveSubscription,
  requireElite,
  requireRewardsAccess,
  requireAdmin,
  setSessionCookie,
};
