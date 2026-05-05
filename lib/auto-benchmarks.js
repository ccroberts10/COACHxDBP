// lib/auto-benchmarks.js
// Auto-populate user benchmarks from WHOOP + Strava when fields are NULL
// Never overwrites manually entered values.

const db = require('./client').pool ? require('./client') : require('../db/client');
const dbClient = require('../db/client');
const strava = require('./strava');
const loadMath = require('./load-math');

/**
 * Auto-populate any NULL benchmark fields from connected services.
 * Called from pipeline.runDailyForUser after data is pulled.
 *
 * @param {string} userId
 * @param {object} whoopData - already-pulled WHOOP data { recovery, sleep, cycles, workouts }
 * @param {Array} stravaActivities - already-pulled Strava activities
 */
async function autoPopulateBenchmarks(userId, whoopData, stravaActivities) {
  const current = await dbClient.one(`SELECT * FROM user_benchmarks WHERE user_id = $1`, [userId]);
  if (!current) {
    // Create row first if missing
    await dbClient.query(`INSERT INTO user_benchmarks (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
  }

  const updates = {};

  // ===== STRAVA ATHLETE PROFILE =====
  let athlete = null;
  try {
    athlete = await strava.getAthleteProfile(userId);
  } catch (e) {
    console.log('[auto-benchmarks] strava athlete fetch failed:', e.message);
  }

  if (athlete) {
    // FTP from Strava (if user set it on Strava and we don't have it)
    if (!current?.ftp_watts && athlete.ftp) {
      updates.ftp_watts = Math.round(athlete.ftp);
    }
    // Max HR from Strava (some users set this on Strava)
    if (!current?.max_hr && athlete.max_heartrate) {
      updates.max_hr = Math.round(athlete.max_heartrate);
    }
    // Bodyweight (Strava has 'weight' in kg)
    if (!current?.bodyweight_kg && athlete.weight) {
      updates.bodyweight_kg = athlete.weight;
    }
  }

  // ===== FTP FALLBACK FROM ACTIVITIES =====
  // If we still don't have FTP, estimate from best 20-min NP
  if (!current?.ftp_watts && !updates.ftp_watts && stravaActivities?.length) {
    const estimated = loadMath.estimateFtpFromStrava(stravaActivities);
    if (estimated) {
      updates.ftp_watts = estimated;
    }
  }

  // ===== MAX HR FALLBACK FROM ACTIVITIES =====
  // Use highest max_heartrate observed in last 30 days of activities
  if (!current?.max_hr && !updates.max_hr && stravaActivities?.length) {
    const observed = stravaActivities
      .map(a => a.max_heartrate)
      .filter(v => v && v > 100 && v < 230);
    if (observed.length) {
      updates.max_hr = Math.round(Math.max(...observed));
    }
  }

  // ===== LTHR DERIVATION =====
  // 89% of max HR is a solid default for cyclists per Joe Friel
  if (!current?.lthr && (updates.max_hr || current?.max_hr)) {
    const mhr = updates.max_hr || current.max_hr;
    updates.lthr = Math.round(mhr * 0.89);
  }

  // ===== WHOOP-DERIVED BASELINES =====
  // RHR baseline = 30-day average from cycles
  if (!current?.rhr_baseline && whoopData?.cycles?.records?.length) {
    const rhrs = whoopData.cycles.records
      .map(c => c.score?.average_heart_rate)
      .filter(v => v && v > 30 && v < 100);
    if (rhrs.length >= 5) {
      // Use the lowest 30% of values as RHR estimate (cycles avg HR underestimates true RHR)
      // Actually better: take WHOOP's recovery records' resting_heart_rate (more accurate)
    }
  }
  // Better source: WHOOP recovery records have resting_heart_rate explicitly
  if (!current?.rhr_baseline && whoopData?.recovery?.records?.length) {
    const rhrs = whoopData.recovery.records
      .map(r => r.score?.resting_heart_rate)
      .filter(v => v && v > 30 && v < 100);
    if (rhrs.length >= 5) {
      const avg = rhrs.reduce((s, v) => s + v, 0) / rhrs.length;
      updates.rhr_baseline = Math.round(avg);
    }
  }

  // HRV baseline = 30-day average from recovery records
  if (!current?.hrv_baseline && whoopData?.recovery?.records?.length) {
    const hrvs = whoopData.recovery.records
      .map(r => r.score?.hrv_rmssd_milli)
      .filter(v => v && v > 5 && v < 250);
    if (hrvs.length >= 5) {
      const avg = hrvs.reduce((s, v) => s + v, 0) / hrvs.length;
      updates.hrv_baseline = Math.round(avg * 10) / 10;
    }
  }

  // ===== APPLY UPDATES =====
  if (Object.keys(updates).length === 0) return { updates: {} };

  const setClauses = [];
  const values = [];
  let i = 2;
  for (const [key, val] of Object.entries(updates)) {
    setClauses.push(`${key} = $${i++}`);
    values.push(val);
  }
  await dbClient.query(
    `UPDATE user_benchmarks SET ${setClauses.join(', ')}, updated_at = NOW() WHERE user_id = $1`,
    [userId, ...values]
  );
  console.log(`[auto-benchmarks] Updated for user ${userId}:`, updates);
  return { updates };
}

module.exports = { autoPopulateBenchmarks };
