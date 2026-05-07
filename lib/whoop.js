// lib/whoop.js
// Per-user WHOOP OAuth and API access

const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const db = require('../db/client');

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const SCOPES = 'offline read:recovery read:sleep read:cycles read:workout read:profile read:body_measurement';

// Sign state with HMAC so we can validate the userId on callback without relying on session cookies.
// Cookies often don't survive OAuth round-trips when WHOOP launches the callback in an in-app browser.
function signState(userId) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const ts = Date.now().toString(36);
  const payload = `${userId}.${nonce}.${ts}`;
  const sig = crypto.createHmac('sha256', CLIENT_SECRET).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${sig}`;
}

function verifyState(state, maxAgeMs = 10 * 60 * 1000) {
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [userId, nonce, ts, sig] = parts;
  const payload = `${userId}.${nonce}.${ts}`;
  const expected = crypto.createHmac('sha256', CLIENT_SECRET).update(payload).digest('hex').slice(0, 32);
  // Constant-time comparison
  if (sig.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch !== 0) return null;
  // Check age
  const stateTime = parseInt(ts, 36);
  if (isNaN(stateTime) || Date.now() - stateTime > maxAgeMs) return null;
  return userId;
}

function authUrl(userId) {
  const redirectUri = `${process.env.PUBLIC_URL}/integrations/whoop/callback`;
  const url = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', signState(userId));
  return url.toString();
}

async function exchangeCode(code) {
  const redirectUri = `${process.env.PUBLIC_URL}/integrations/whoop/callback`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: redirectUri,
  });
  const res = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`WHOOP token exchange failed: ${JSON.stringify(data)}`);
  return data;
}

async function saveTokens(userId, tokenData) {
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
  await db.query(
    `INSERT INTO integrations (user_id, service, access_token, refresh_token, expires_at, scope, status, updated_at)
     VALUES ($1, 'whoop', $2, $3, $4, $5, 'connected', NOW())
     ON CONFLICT (user_id, service) DO UPDATE
     SET access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         scope = EXCLUDED.scope,
         status = 'connected',
         error_message = NULL,
         updated_at = NOW()`,
    [userId, tokenData.access_token, tokenData.refresh_token, expiresAt, SCOPES]
  );
}

async function refreshTokens(userId) {
  const row = await db.one(
    `SELECT * FROM integrations WHERE user_id = $1 AND service = 'whoop'`,
    [userId]
  );
  if (!row) throw new Error('No WHOOP integration');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: SCOPES,  // WHOOP requires scope on refresh, unlike most OAuth providers
  });

  const res = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();

  if (!data.access_token) {
    console.error('[whoop refresh] failed:', JSON.stringify(data));
    await db.query(
      `UPDATE integrations SET status = 'error', error_message = $1, updated_at = NOW()
       WHERE user_id = $2 AND service = 'whoop'`,
      [data.error_description || data.error || 'refresh_failed', userId]
    );
    throw new Error(`WHOOP refresh failed: ${JSON.stringify(data)}`);
  }
  await saveTokens(userId, data);
  return data.access_token;
}

async function getAccessToken(userId) {
  const row = await db.one(
    `SELECT * FROM integrations WHERE user_id = $1 AND service = 'whoop'`,
    [userId]
  );
  if (!row) throw new Error('WHOOP not connected');
  // Refresh if within 60 seconds of expiry
  if (new Date(row.expires_at).getTime() - Date.now() < 60000) {
    return refreshTokens(userId);
  }
  return row.access_token;
}

async function apiGet(userId, endpoint, params = {}) {
  const token = await getAccessToken(userId);
  const url = new URL(`https://api.prod.whoop.com${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WHOOP ${endpoint} ${res.status}: ${text}`);
  }
  return res.json();
}

async function pullAllData(userId) {
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date().toISOString();
  const [sleep, cycles, workouts, recovery] = await Promise.all([
    apiGet(userId, '/developer/v2/activity/sleep', { start, end, limit: 25 }),
    apiGet(userId, '/developer/v2/cycle', { start, end, limit: 25 }),
    apiGet(userId, '/developer/v2/activity/workout', { start, end, limit: 25 }),
    apiGet(userId, '/developer/v2/recovery', { start, end, limit: 25 }).catch(() => ({ records: [] })),
  ]);
  await db.query(
    `UPDATE integrations SET last_synced_at = NOW() WHERE user_id = $1 AND service = 'whoop'`,
    [userId]
  );
  return { recovery, sleep, cycles, workouts };
}

async function disconnect(userId) {
  await db.query(`DELETE FROM integrations WHERE user_id = $1 AND service = 'whoop'`, [userId]);
}

module.exports = {
  authUrl,
  verifyState,
  exchangeCode,
  saveTokens,
  refreshTokens,
  getAccessToken,
  apiGet,
  pullAllData,
  disconnect,
};
