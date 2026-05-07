// lib/strava.js
// Per-user Strava OAuth and API access

const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const db = require('../db/client');

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const SCOPE = 'read,activity:read_all';

// HMAC-signed state (cookies don't survive OAuth round-trips reliably on mobile)
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
  if (sig.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch !== 0) return null;
  const stateTime = parseInt(ts, 36);
  if (isNaN(stateTime) || Date.now() - stateTime > maxAgeMs) return null;
  return userId;
}

function authUrl(userId) {
  const redirectUri = `${process.env.PUBLIC_URL}/integrations/strava/callback`;
  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('approval_prompt', 'force');
  url.searchParams.set('state', signState(userId));
  return url.toString();
}

async function exchangeCode(code) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Strava token exchange failed: ${JSON.stringify(data)}`);
  return data;
}

async function saveTokens(userId, tokenData) {
  const expiresAt = new Date(tokenData.expires_at * 1000);
  await db.query(
    `INSERT INTO integrations (user_id, service, access_token, refresh_token, expires_at, scope, status, updated_at)
     VALUES ($1, 'strava', $2, $3, $4, $5, 'connected', NOW())
     ON CONFLICT (user_id, service) DO UPDATE
     SET access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         status = 'connected',
         error_message = NULL,
         updated_at = NOW()`,
    [userId, tokenData.access_token, tokenData.refresh_token, expiresAt, SCOPE]
  );
}

async function refreshTokens(userId) {
  const row = await db.one(
    `SELECT * FROM integrations WHERE user_id = $1 AND service = 'strava'`,
    [userId]
  );
  if (!row) throw new Error('No Strava integration');

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    await db.query(
      `UPDATE integrations SET status = 'error', error_message = $1, updated_at = NOW()
       WHERE user_id = $2 AND service = 'strava'`,
      [data.message || 'refresh_failed', userId]
    );
    throw new Error(`Strava refresh failed: ${JSON.stringify(data)}`);
  }
  await saveTokens(userId, data);
  return data.access_token;
}

async function getAccessToken(userId) {
  const row = await db.one(
    `SELECT * FROM integrations WHERE user_id = $1 AND service = 'strava'`,
    [userId]
  );
  if (!row) throw new Error('Strava not connected');
  if (new Date(row.expires_at).getTime() - Date.now() < 60000) {
    return refreshTokens(userId);
  }
  return row.access_token;
}

async function apiGet(userId, endpoint, params = {}) {
  const token = await getAccessToken(userId);
  const url = new URL(`https://www.strava.com/api/v3${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Strava ${endpoint} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getAthleteProfile(userId) {
  return apiGet(userId, '/athlete');
}

async function pullActivities(userId, daysBack = 30) {
  const after = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
  const activities = await apiGet(userId, '/athlete/activities', { after, per_page: 100 });
  const insert = db.pool;
  for (const a of activities) {
    await insert.query(
      `INSERT INTO activities
       (id, user_id, date, type, duration_sec, distance_m, avg_hr, max_hr, avg_power, normalized_power, elevation_gain_m, suffer_score, raw_strava)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (user_id, id) DO UPDATE SET
         date = EXCLUDED.date, type = EXCLUDED.type,
         duration_sec = EXCLUDED.duration_sec, distance_m = EXCLUDED.distance_m,
         avg_hr = EXCLUDED.avg_hr, max_hr = EXCLUDED.max_hr,
         avg_power = EXCLUDED.avg_power, normalized_power = EXCLUDED.normalized_power,
         elevation_gain_m = EXCLUDED.elevation_gain_m, suffer_score = EXCLUDED.suffer_score,
         raw_strava = EXCLUDED.raw_strava`,
      [
        String(a.id), userId, a.start_date.slice(0, 10), a.type,
        Math.round(a.moving_time), a.distance,
        a.average_heartrate ? Math.round(a.average_heartrate) : null,
        a.max_heartrate ? Math.round(a.max_heartrate) : null,
        a.average_watts ? Math.round(a.average_watts) : null,
        a.weighted_average_watts ? Math.round(a.weighted_average_watts) : null,
        a.total_elevation_gain != null ? a.total_elevation_gain : null,
        a.suffer_score != null ? Math.round(a.suffer_score) : null,
        JSON.stringify(a),
      ]
    );
  }
  await db.query(
    `UPDATE integrations SET last_synced_at = NOW() WHERE user_id = $1 AND service = 'strava'`,
    [userId]
  );
  return activities;
}

async function disconnect(userId) {
  await db.query(`DELETE FROM integrations WHERE user_id = $1 AND service = 'strava'`, [userId]);
}

module.exports = {
  authUrl,
  verifyState,
  exchangeCode,
  saveTokens,
  refreshTokens,
  getAccessToken,
  apiGet,
  getAthleteProfile,
  pullActivities,
  disconnect,
};
