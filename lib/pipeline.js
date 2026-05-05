// lib/pipeline.js
// Daily prescription pipeline — runs for one user or all active users

const db = require('../db/client');
const whoop = require('./whoop');
const strava = require('./strava');
const { getWeather } = require('./weather');
const coach = require('./coach');
const { sendDailyPrescriptionEmail } = require('./email');

async function runDailyForUser(userId) {
  const startTime = Date.now();
  let runId = null;

  try {
    // Get user (we need timezone first)
    const user = await db.one(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (!user) throw new Error('User not found');

    // Compute "today" in the user's timezone (defaults to America/Denver)
    const userTz = user.timezone || 'America/Denver';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: userTz });

    // Log run start
    const run = await db.one(
      `INSERT INTO pipeline_runs (user_id, run_type, status) VALUES ($1, 'cron_daily', 'running') RETURNING id`,
      [userId]
    );
    runId = run.id;

    // Pull WHOOP data
    const whoopData = await whoop.pullAllData(userId);

    // Pull Strava data
    await strava.pullActivities(userId, 30);
    const stravaActivities = await db.many(
      `SELECT raw_strava as raw FROM activities WHERE user_id = $1 ORDER BY date DESC LIMIT 100`,
      [userId]
    );
    const stravaForCoach = stravaActivities.map(r => r.raw);

    // Auto-populate benchmarks from connected services (only fills NULLs, never overwrites)
    try {
      const autoBenchmarks = require('./auto-benchmarks');
      await autoBenchmarks.autoPopulateBenchmarks(userId, whoopData, stravaForCoach);
    } catch (e) {
      console.log('[pipeline] auto-benchmarks failed (non-fatal):', e.message);
    }

    // Get user location for weather
    const benchmarks = await db.one(`SELECT location_lat, location_lng FROM user_benchmarks WHERE user_id = $1`, [userId]);
    const weather = await getWeather(benchmarks?.location_lat, benchmarks?.location_lng);

    // Build context for AI
    const context = await coach.buildContext(userId, whoopData, stravaForCoach, weather);

    // Save daily snapshot
    await db.query(
      `INSERT INTO daily_snapshots
        (user_id, date, recovery_pct, hrv, rhr, sleep_hours, deep_sleep_min, rem_sleep_min,
         yesterday_strain, weekly_strain_avg, acute_chronic_ratio, raw_whoop)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id, date) DO UPDATE SET
         recovery_pct = EXCLUDED.recovery_pct, hrv = EXCLUDED.hrv, rhr = EXCLUDED.rhr,
         sleep_hours = EXCLUDED.sleep_hours, deep_sleep_min = EXCLUDED.deep_sleep_min,
         rem_sleep_min = EXCLUDED.rem_sleep_min, yesterday_strain = EXCLUDED.yesterday_strain,
         weekly_strain_avg = EXCLUDED.weekly_strain_avg, acute_chronic_ratio = EXCLUDED.acute_chronic_ratio,
         raw_whoop = EXCLUDED.raw_whoop`,
      [
        userId, today,
        context.recovery.pct != null ? Math.round(context.recovery.pct) : null,
        context.recovery.hrv_ms,
        context.recovery.rhr != null ? Math.round(context.recovery.rhr) : null,
        context.sleep.total_min ? context.sleep.total_min / 60 : null,
        context.sleep.deep_min != null ? Math.round(context.sleep.deep_min) : null,
        context.sleep.rem_min != null ? Math.round(context.sleep.rem_min) : null,
        context.yesterday_strain, context.weekly_strain_avg,
        context.training_load.ac_ratio,
        JSON.stringify(whoopData),
      ]
    );

    // Generate prescription
    const prescription = await coach.generatePrescription(context);

    // Save prescription
    await db.query(
      `INSERT INTO prescriptions
        (user_id, date, workout_type, duration_min, intensity, workout_detail, nutrition, rationale, full_response, delivered)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
       ON CONFLICT (user_id, date) DO UPDATE SET
         workout_type = EXCLUDED.workout_type, duration_min = EXCLUDED.duration_min,
         intensity = EXCLUDED.intensity, workout_detail = EXCLUDED.workout_detail,
         nutrition = EXCLUDED.nutrition, rationale = EXCLUDED.rationale,
         full_response = EXCLUDED.full_response`,
      [
        userId, today,
        prescription.workout?.type, prescription.workout?.duration_min,
        prescription.workout?.intensity_zone, prescription.workout?.specific_workout,
        JSON.stringify(prescription.nutrition),
        prescription.rationale,
        JSON.stringify(prescription),
      ]
    );

    // Send email with prescription
    await sendDailyPrescriptionEmail(user.email, user.name, prescription, context.recovery.pct);
    await db.query(`UPDATE prescriptions SET delivered = TRUE WHERE user_id = $1 AND date = $2`, [userId, today]);

    await db.query(
      `UPDATE pipeline_runs SET status = 'success', duration_ms = $1, completed_at = NOW() WHERE id = $2`,
      [Date.now() - startTime, runId]
    );
    return { success: true, prescription, context };
  } catch (e) {
    console.error(`[pipeline] User ${userId} failed:`, e.message);
    if (runId) {
      await db.query(
        `UPDATE pipeline_runs SET status = 'failed', error_message = $1, duration_ms = $2, completed_at = NOW() WHERE id = $3`,
        [e.message, Date.now() - startTime, runId]
      ).catch(() => {});
    }
    throw e;
  }
}

async function runDailyForAllUsers() {
  const users = await db.many(
    `SELECT id, email FROM users
     WHERE subscription_status IN ('active', 'trialing')
       AND onboarding_completed = TRUE`
  );
  console.log(`[pipeline] Running for ${users.length} active users`);

  const results = { success: 0, failed: 0, errors: [] };
  for (const user of users) {
    try {
      await runDailyForUser(user.id);
      results.success++;
    } catch (e) {
      results.failed++;
      results.errors.push({ userId: user.id, email: user.email, error: e.message });
    }
    // Stagger 2 sec between users to avoid hammering APIs
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`[pipeline] Done: ${results.success} success, ${results.failed} failed`);
  return results;
}

module.exports = { runDailyForUser, runDailyForAllUsers };
