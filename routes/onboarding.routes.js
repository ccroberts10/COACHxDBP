// routes/onboarding.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const db = require('../db/client');
const whoop = require('../lib/whoop');
const strava = require('../lib/strava');

// All onboarding endpoints require auth
router.use(auth.requireAuthApi);

// Get current onboarding state
router.get('/state', async (req, res) => {
  const benchmarks = await db.one(`SELECT * FROM user_benchmarks WHERE user_id = $1`, [req.user.id]);
  const integrations = await db.many(
    `SELECT service, status, last_synced_at FROM integrations WHERE user_id = $1`,
    [req.user.id]
  );
  res.json({
    user: { id: req.user.id, email: req.user.email, name: req.user.name, onboarding_completed: req.user.onboarding_completed },
    benchmarks: benchmarks || null,
    integrations: integrations,
  });
});

// Save onboarding step data (incremental — can save partial)
router.post('/save', async (req, res) => {
  const userId = req.user.id;
  const {
    name, birthdate, bodyweight_kg, location_lat, location_lng, location_name,
    primary_focus, weekly_hours_target, strength_target_per_week,
    home_gym_equipment, has_indoor_trainer,
    ftp_watts, max_hr, lthr, squat_1rm_lb, deadlift_1rm_lb, bench_1rm_lb,
    current_event_name, current_event_date, current_event_type, current_event_distance_km, current_event_elevation_m,
  } = req.body;

  // Update user table
  if (name !== undefined) {
    await db.query(`UPDATE users SET name = $1 WHERE id = $2`, [name, userId]);
  }
  if (birthdate !== undefined) {
    await db.query(`UPDATE users SET birthdate = $1 WHERE id = $2`, [birthdate || null, userId]);
  }

  // Upsert user_benchmarks
  await db.query(
    `INSERT INTO user_benchmarks (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  const updates = [];
  const values = [];
  let i = 2;
  const fields = {
    bodyweight_kg, location_lat, location_lng, location_name,
    primary_focus, weekly_hours_target, strength_target_per_week,
    home_gym_equipment: home_gym_equipment ? JSON.stringify(home_gym_equipment) : undefined,
    has_indoor_trainer,
    ftp_watts, max_hr, lthr, squat_1rm_lb, deadlift_1rm_lb, bench_1rm_lb,
    current_event_name, current_event_date, current_event_type, current_event_distance_km, current_event_elevation_m,
  };
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    updates.push(`${key} = $${i++}`);
    values.push(val === '' ? null : val);
  }
  if (updates.length) {
    await db.query(
      `UPDATE user_benchmarks SET ${updates.join(', ')}, updated_at = NOW() WHERE user_id = $1`,
      [userId, ...values]
    );
  }

  res.json({ success: true });
});

// Mark onboarding complete (after WHOOP + Strava connected + benchmarks saved)
router.post('/complete', async (req, res) => {
  const userId = req.user.id;
  // Get user tier to determine integration requirements
  const user = await db.one(`SELECT subscription_tier FROM users WHERE id = $1`, [userId]);
  const tier = user?.subscription_tier;

  // Verify integrations based on tier
  const ints = await db.many(`SELECT service FROM integrations WHERE user_id = $1`, [userId]);
  const services = ints.map(i => i.service);

  // Rewards tier: no integrations required
  // Coach tier: at minimum Strava required (WHOOP optional but recommended)
  if (tier === 'coach' && !services.includes('strava')) {
    return res.status(400).json({ error: 'Connect Strava to use Coach (WHOOP recommended but optional).' });
  }

  await db.query(`UPDATE users SET onboarding_completed = TRUE WHERE id = $1`, [userId]);

  // Generate member code if missing
  try {
    const memberRewards = require('../lib/member-rewards');
    await memberRewards.ensureMemberCode(userId);
  } catch (e) {
    console.error('[onboarding] member code generation failed:', e.message);
  }

  res.json({ success: true });
});

// =====================================================
// OAUTH CALLBACKS - mounted under /onboarding in server.js
// but really these are integration callbacks, also accessible after onboarding
// =====================================================

router.get('/integrations/whoop/connect', auth.requireAuth, (req, res) => {
  res.redirect(whoop.authUrl(req.user.id));
});

router.get('/integrations/strava/connect', auth.requireAuth, (req, res) => {
  res.redirect(strava.authUrl(req.user.id));
});

module.exports = router;
