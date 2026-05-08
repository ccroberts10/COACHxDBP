// routes/api.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const db = require('../db/client');
const { runDailyForUser } = require('../lib/pipeline');
const { getWeather } = require('../lib/weather');

// All /api endpoints require active subscription (except billing webhook, mounted separately)
router.use(auth.requireAuthApi);

// Dashboard data endpoint
router.get('/data', auth.requireActiveSubscription, async (req, res) => {
  const userId = req.user.id;
  try {
    // Lazy on-demand prescription generation for Coach tier
    // (Replaces 6:30 AM cron — generation now happens when user actually opens the app)
    if (req.user.subscription_tier === 'coach' && req.user.onboarding_completed) {
      const userTzPre = req.user.timezone || 'America/Denver';
      const todayInUserTzPre = new Date().toLocaleDateString('en-CA', { timeZone: userTzPre });
      const todaysPresc = await db.one(
        `SELECT user_id FROM prescriptions WHERE user_id = $1 AND date = $2`,
        [userId, todayInUserTzPre]
      );
      if (!todaysPresc) {
        // Generate fresh prescription using freshest data right now (non-fatal — if it fails, user can manually retry)
        try {
          const { runDailyForUser } = require('../lib/pipeline');
          await runDailyForUser(userId);
          console.log(`[api/data] lazy-generated prescription for user ${userId}`);
        } catch (e) {
          console.error(`[api/data] lazy generation failed for ${userId}:`, e.message);
          // Continue — user will see "no prescription" state and can tap Run manually
        }
      }
    }

    const [snapshots, prescriptions, activities, feedback, checkins, integrations, benchmarks, perks] = await Promise.all([
      db.many(`SELECT * FROM daily_snapshots WHERE user_id = $1 ORDER BY date DESC LIMIT 14`, [userId]),
      db.many(`SELECT * FROM prescriptions WHERE user_id = $1 ORDER BY date DESC LIMIT 14`, [userId]),
      db.many(`SELECT id, date, type, duration_sec, distance_m, avg_hr, max_hr, avg_power, normalized_power, elevation_gain_m, suffer_score FROM activities WHERE user_id = $1 ORDER BY date DESC LIMIT 14`, [userId]),
      db.many(`SELECT * FROM workout_feedback WHERE user_id = $1 ORDER BY date DESC LIMIT 14`, [userId]),
      db.many(`SELECT * FROM daily_checkins WHERE user_id = $1 ORDER BY date DESC LIMIT 14`, [userId]),
      db.many(`SELECT service, status, error_message, last_synced_at FROM integrations WHERE user_id = $1`, [userId]),
      db.one(`SELECT * FROM user_benchmarks WHERE user_id = $1`, [userId]),
      db.many(`SELECT * FROM perk_redemptions WHERE user_id = $1 AND redeemed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY issued_at DESC`, [userId]),
    ]);

    // Normalize Postgres DATE columns (returned as Date objects) to YYYY-MM-DD strings for keying
    function dateKey(d) {
      if (!d) return null;
      if (typeof d === 'string') return d.slice(0, 10);
      // It's a Date object — format in user's timezone to avoid UTC drift
      return d.toLocaleDateString('en-CA', { timeZone: req.user.timezone || 'America/Denver' });
    }

    const fbByDate = {};
    feedback.forEach(f => { fbByDate[dateKey(f.date)] = f; });
    const checkinByDate = {};
    checkins.forEach(c => { checkinByDate[dateKey(c.date)] = c; });

    // Compute "today" in the USER's timezone, not server's UTC.
    const userTz = req.user.timezone || 'America/Denver';
    const todayInUserTz = new Date().toLocaleDateString('en-CA', { timeZone: userTz });

    let weather = null;
    try {
      weather = await getWeather(benchmarks?.location_lat, benchmarks?.location_lng);
    } catch (e) {}

    const connections = {};
    for (const svc of ['whoop', 'strava']) {
      const i = integrations.find(x => x.service === svc);
      connections[svc] = i ? { service: svc, status: i.status, error_message: i.error_message, last_synced_at: i.last_synced_at } : { service: svc, status: 'disconnected' };
    }

    // Member Rewards: total savings stats
    const savingsRow = await db.one(
      `SELECT
         COALESCE(SUM(CASE WHEN redeemed_at >= date_trunc('month', NOW()) THEN savings_cents END), 0) as month_cents,
         COALESCE(SUM(savings_cents), 0) as lifetime_cents,
         COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL) as redemption_count
       FROM perk_redemptions WHERE user_id = $1`,
      [userId]
    );

    // Member code + punch card + streak (all tiers including free)
    let punchStats = null;
    let streakStats = null;
    let memberCode = null;
    if (['free', 'rewards', 'coach'].includes(req.user.subscription_tier)) {
      try {
        const memberRewards = require('../lib/member-rewards');
        memberCode = await memberRewards.ensureMemberCode(userId);
        punchStats = await memberRewards.getPunchStats(userId);
        streakStats = await memberRewards.getStreakStats(userId);
      } catch (e) {
        console.error('[api/data] member rewards lookup failed:', e.message, e.stack);
      }
    }

    res.json({
      user: { id: req.user.id, email: req.user.email, name: req.user.name, tier: req.user.subscription_tier, status: req.user.subscription_status, member_code: memberCode },
      snapshots,
      prescriptions: prescriptions.map(p => ({ ...p, full_response: p.full_response, feedback: fbByDate[dateKey(p.date)] || null })),
      activities,
      benchmarks,
      perks,
      weather,
      checkins,
      today_checkin: checkinByDate[todayInUserTz] || null,
      today_date: todayInUserTz,
      savings: {
        month_cents: parseInt(savingsRow?.month_cents || 0),
        lifetime_cents: parseInt(savingsRow?.lifetime_cents || 0),
        redemption_count: parseInt(savingsRow?.redemption_count || 0),
      },
      punch: punchStats,
      streak: streakStats,
      connections,
    });
  } catch (e) {
    console.error('[api/data]', e);
    res.status(500).json({ error: e.message });
  }
});

// Trigger pipeline run
router.post('/run', auth.requireActiveSubscription, async (req, res) => {
  try {
    const result = await runDailyForUser(req.user.id);
    res.json({ success: true, prescription: result.prescription });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Save workout feedback
router.post('/feedback', auth.requireActiveSubscription, async (req, res) => {
  const { date, status, note, rpe, actual_workout_type, actual_workout_detail, skip_reason } = req.body;
  if (!date || !status) return res.status(400).json({ error: 'date and status required' });
  if (!['did_it', 'modified', 'skipped'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  await db.query(
    `INSERT INTO workout_feedback (user_id, date, status, note, rpe, actual_workout_type, actual_workout_detail, skip_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, date) DO UPDATE
     SET status = EXCLUDED.status, note = EXCLUDED.note, rpe = EXCLUDED.rpe,
         actual_workout_type = EXCLUDED.actual_workout_type,
         actual_workout_detail = EXCLUDED.actual_workout_detail,
         skip_reason = EXCLUDED.skip_reason,
         updated_at = NOW()`,
    [req.user.id, date, status, note || null, rpe || null,
     actual_workout_type || null, actual_workout_detail || null, skip_reason || null]
  );
  res.json({ success: true });
});

// Save daily wellness check-in (morning)
router.post('/checkin', auth.requireActiveSubscription, async (req, res) => {
  const { date, sleep_quality, legs_feel, alcohol_drinks, stress_level, note } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  await db.query(
    `INSERT INTO daily_checkins (user_id, date, sleep_quality, legs_feel, alcohol_drinks, stress_level, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, date) DO UPDATE
     SET sleep_quality = EXCLUDED.sleep_quality,
         legs_feel = EXCLUDED.legs_feel,
         alcohol_drinks = EXCLUDED.alcohol_drinks,
         stress_level = EXCLUDED.stress_level,
         note = EXCLUDED.note,
         updated_at = NOW()`,
    [req.user.id, date, sleep_quality || null, legs_feel || null,
     alcohol_drinks != null ? alcohol_drinks : null, stress_level || null, note || null]
  );

  // Process streak (all tiers including free)
  let streakResult = null;
  if (['free', 'rewards', 'coach'].includes(req.user.subscription_tier)) {
    try {
      const memberRewards = require('../lib/member-rewards');
      streakResult = await memberRewards.processCheckinForStreak(req.user.id, date);
    } catch (e) {
      console.error('[checkin] streak processing failed:', e.message);
    }
  }

  res.json({ success: true, streak: streakResult });
});

// Disconnect an integration
router.post('/integrations/:service/disconnect', auth.requireActiveSubscription, async (req, res) => {
  const { service } = req.params;
  if (!['whoop', 'strava'].includes(service)) return res.status(400).json({ error: 'invalid service' });
  await db.query(`DELETE FROM integrations WHERE user_id = $1 AND service = $2`, [req.user.id, service]);
  res.json({ success: true });
});

module.exports = router;
