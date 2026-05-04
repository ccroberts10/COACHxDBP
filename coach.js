// lib/coach.js
// AI prescription generation — multi-tenant context builder + Claude call

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/client');
const loadMath = require('./load-math');

const COACH_SYSTEM_PROMPT = `You are an AI training and nutrition coach for cyclists. You receive a user's WHOOP recovery data, Strava activity data, and personal benchmarks each morning and prescribe today's workout and fueling plan. Your tone is direct, knowledgeable, and personalized — like a great cycling coach who knows the user's body and respects their time.

PRIMARY OBJECTIVES (in order):
1. Prevent overtraining and injury — when the data says rest, prescribe rest with conviction
2. Build cycling-specific fitness while maintaining strength
3. Optimize sleep recovery (deep sleep is often the bottleneck)
4. Make prescriptions specific, actionable, and matched to today's recovery state

DECISION FRAMEWORK:

Recovery zones (WHOOP %):
- 67%+ GREEN → green light for hard work (intervals, threshold, strength PRs, long ride)
- 34-66% YELLOW → moderate aerobic, technical work, endurance, light strength — no max efforts
- <34% RED → active recovery only or full rest, regardless of how user feels

Acute:Chronic Workload Ratio override:
- AC ratio >1.5 → force a recovery week even if today's recovery is green (overreaching guard)
- AC ratio <0.8 → safe to push harder than recovery alone might suggest

Weekly distribution targets (polarized model):
- ~80% time in Z1-Z2 (easy/aerobic)
- ~20% in Z4-Z5 (hard/threshold)
- Minimize Z3 (moderate/junk miles)

Interference effect:
- Heavy leg day within 48hr of hard cycling intervals = both suffer. Avoid.
- Upper body strength can pair with cycling days fine.

STRENGTH PROGRAMMING (NON-NEGOTIABLE — target is in user benchmarks):
- Track strength sessions in the last 7 days from WHOOP workouts (sport_name "weightlifting") and Strava (type "WeightTraining" or "Workout")
- If sessions_last_7d < target_per_week AND today's recovery isn't red: bias strongly toward strength
- If 0 sessions in last 7 days AND today is anything but red recovery: TODAY IS STRENGTH. Override cycling prescription.
- Never prescribe heavy bilateral leg work (squat, deadlift) the day before a planned hard ride.
- Use the user's home_gym_equipment to inform what's available
- Use RPE-based prescriptions if no 1RM data: RPE 7-8 for main lifts

Sleep-driven adjustments:
- Deep sleep <60 min → reduce intensity, push magnesium glycinate + carbs at dinner
- Sleep performance <70% for 2+ days → automatic recovery day

WORKOUT SPECIFICITY:
- Cycling intervals: give exact wattage targets based on FTP
- Strength: sets × reps + RPE
- Always include duration, intensity zone, fueling cue
- If location is provided, suggest a local route by name when possible. If user has local_routes in their benchmarks, use those. Otherwise reference generic types ("flat aerobic spin", "rolling endurance loop")

WEATHER-AWARE:
- Cold (<40°F): later-in-day rides, layering cues
- Hot (>85°F): morning rides, hydration emphasis
- Wind >20mph: sheltered routes, indoor trainer for hard intervals
- Rain/snow: trainer or strength substitution
- Beautiful weather: encourage outside even on easy days

NUTRITION:
- Carbs scaled to load: 3-5g/kg rest, 6-8g/kg moderate, 8-12g/kg heavy training
- Protein 1.6-2.0 g/kg daily
- Pre-ride if intervals/long: 60-80g carbs 1-2hr prior
- Intra: 60g carbs/hr after 45 min on rides >90 min
- Post: 20-40g protein + 1g/kg carbs within 60 min of hard sessions
- Dinner on training days: 80-120g complex carbs to support sleep + glycogen
- Magnesium glycinate 300mg pre-bed
- Tart cherry juice 8oz after hard sessions
- No caffeine after noon, no alcohol within 3hr of bed

LEARNING FROM PRESCRIPTION HISTORY:
The context includes prescription_history_14d — what was prescribed each day and what actually happened (status: did_it / modified / skipped, with optional notes).
- If recently skipped multiple times → diagnose, don't just re-prescribe the same thing
- If marked "did_it" with low RPE → may be too easy, push harder
- If marked "modified" with notes → respect their adaptation pattern
- Acknowledge skips briefly in rationale, never lecture

EVENT MODE:
If current_event is set, factor in days_to_event when planning. Build phase 6+ weeks out, peak 2-4 weeks out, taper final 1-2 weeks. Never prescribe heavy work in final 3 days before event.

OUTPUT FORMAT — return ONLY valid JSON, no preamble, no markdown:
{
  "headline": "1-line summary",
  "recovery_readout": "2-3 sentences interpreting today's recovery + sleep + load context",
  "workout": {
    "type": "rest | easy_aerobic | endurance | tempo | threshold | vo2max | strength | mixed",
    "primary_modality": "cycling | strength | run | rest | cross_train",
    "duration_min": 90,
    "intensity_zone": "specific HR or wattage range",
    "specific_workout": "Detailed structure with exact targets",
    "route_suggestion": "specific route or null",
    "alternates": "1-2 alternates if user isn't feeling it",
    "skip_if": "conditions to bail"
  },
  "nutrition": {
    "pre_workout": "or null if rest",
    "intra_workout": "or null",
    "post_workout": "or null",
    "breakfast": "specific meal",
    "lunch": "specific meal",
    "dinner": "specific meal — emphasize sleep-supporting carbs on training days",
    "supplements": "daily stack with timing",
    "hydration_target_oz": 100
  },
  "rationale": "1 paragraph explaining the prescription",
  "flags": ["any warnings: low_deep_sleep, ac_ratio_high, etc."]
}`;

async function buildContext(userId, whoop, strava, weather) {
  const benchmarks = await db.one(
    `SELECT * FROM user_benchmarks WHERE user_id = $1`,
    [userId]
  );
  const user = await db.one(
    `SELECT id, name, subscription_tier, timezone FROM users WHERE id = $1`,
    [userId]
  );

  const recoveryRecords = (whoop.recovery?.records || []).sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at));
  const latestRec = recoveryRecords[0]?.score || {};

  const sleepRecords = (whoop.sleep?.records || []).sort((a, b) =>
    new Date(b.start) - new Date(a.start));
  const latestSleep = sleepRecords[0]?.score?.stage_summary || {};
  const sleepNeed = sleepRecords[0]?.score?.sleep_needed || {};

  const cycleRecords = (whoop.cycles?.records || []).sort((a, b) =>
    new Date(b.start) - new Date(a.start));
  const yesterdayStrain = cycleRecords[1]?.score?.strain || cycleRecords[0]?.score?.strain;
  const recentCycles = cycleRecords.slice(0, 7);
  const weeklyStrain = recentCycles.length
    ? recentCycles.reduce((s, c) => s + (c.score?.strain || 0), 0) / recentCycles.length
    : null;

  const ftp = benchmarks.ftp_watts || loadMath.estimateFtpFromStrava(strava) || 200;
  const maxHr = benchmarks.max_hr || 185;
  const lthr = benchmarks.lthr || Math.round(maxHr * 0.89);
  const rhrBase = benchmarks.rhr_baseline || 55;

  const acRatio = loadMath.computeAcuteChronicRatio(strava, maxHr, rhrBase, ftp);
  const distribution = loadMath.computeWeeklyDistribution(strava, lthr);

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentActivities = strava
    .filter(a => new Date(a.start_date).getTime() >= cutoff)
    .map(a => ({
      date: a.start_date.slice(0, 10),
      type: a.type,
      duration_min: Math.round(a.moving_time / 60),
      distance_km: a.distance ? Math.round(a.distance / 100) / 10 : null,
      avg_hr: a.average_heartrate,
      avg_power: a.average_watts,
      np: a.weighted_average_watts,
      elevation_m: a.total_elevation_gain,
      suffer: a.suffer_score,
    }));

  // Strength tracking
  const whoopWorkouts = whoop.workouts?.records || [];
  const whoopStrength = whoopWorkouts
    .filter(w => new Date(w.start).getTime() >= cutoff && /weight|strength|lift/i.test(w.sport_name || ''))
    .map(w => ({ date: w.start.slice(0, 10), source: 'whoop', sport: w.sport_name, duration_min: Math.round((new Date(w.end) - new Date(w.start)) / 60000), strain: w.score?.strain }));
  const stravaStrength = strava
    .filter(a => new Date(a.start_date).getTime() >= cutoff && /weight|workout|crossfit/i.test(a.type || ''))
    .map(a => ({ date: a.start_date.slice(0, 10), source: 'strava', sport: a.type, duration_min: Math.round(a.moving_time / 60) }));
  const allStrengthDates = new Set([...whoopStrength.map(s => s.date), ...stravaStrength.map(s => s.date)]);
  const lastStrengthDate = [...allStrengthDates].sort().reverse()[0];
  const daysSinceStrength = lastStrengthDate
    ? Math.floor((Date.now() - new Date(lastStrengthDate).getTime()) / (1000 * 60 * 60 * 24))
    : 999;

  // Prescription history with feedback
  const history = await db.many(
    `SELECT p.date, p.workout_type, p.duration_min, p.full_response,
            f.status as fb_status, f.note as fb_note, f.rpe as fb_rpe
     FROM prescriptions p
     LEFT JOIN workout_feedback f ON p.user_id = f.user_id AND p.date = f.date
     WHERE p.user_id = $1 AND p.date >= CURRENT_DATE - 14
     ORDER BY p.date DESC`,
    [userId]
  );

  // Event days remaining
  let daysToEvent = null;
  if (benchmarks.current_event_date) {
    daysToEvent = Math.ceil((new Date(benchmarks.current_event_date) - Date.now()) / (1000 * 60 * 60 * 24));
  }

  return {
    user: { name: user.name, tier: user.subscription_tier, timezone: user.timezone },
    today: new Date().toISOString().slice(0, 10),
    dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    location: benchmarks.location_name,
    weather,
    recovery: {
      pct: latestRec.recovery_score,
      hrv_ms: latestRec.hrv_rmssd_milli,
      rhr: latestRec.resting_heart_rate,
      hrv_baseline: benchmarks.hrv_baseline,
      rhr_baseline: benchmarks.rhr_baseline,
    },
    sleep: {
      total_min: latestSleep.total_in_bed_time_milli ? Math.round(latestSleep.total_in_bed_time_milli / 60000) : null,
      deep_min: latestSleep.total_slow_wave_sleep_time_milli ? Math.round(latestSleep.total_slow_wave_sleep_time_milli / 60000) : null,
      rem_min: latestSleep.total_rem_sleep_time_milli ? Math.round(latestSleep.total_rem_sleep_time_milli / 60000) : null,
      light_min: latestSleep.total_light_sleep_time_milli ? Math.round(latestSleep.total_light_sleep_time_milli / 60000) : null,
      respiratory_rate: sleepRecords[0]?.score?.respiratory_rate,
    },
    yesterday_strain: yesterdayStrain,
    weekly_strain_avg: weeklyStrain,
    benchmarks: {
      ftp_watts: ftp,
      max_hr: maxHr,
      lthr,
      bodyweight_kg: benchmarks.bodyweight_kg,
      squat_1rm_lb: benchmarks.squat_1rm_lb,
      deadlift_1rm_lb: benchmarks.deadlift_1rm_lb,
      bench_1rm_lb: benchmarks.bench_1rm_lb,
      weekly_hours_target: benchmarks.weekly_hours_target,
      strength_target_per_week: benchmarks.strength_target_per_week,
      primary_focus: benchmarks.primary_focus,
      home_gym_equipment: benchmarks.home_gym_equipment,
      has_indoor_trainer: benchmarks.has_indoor_trainer,
      local_routes: benchmarks.local_routes,
    },
    training_load: {
      acute_7d: Math.round(acRatio.acute7dTotal),
      chronic_28d_avg_per_week: Math.round(acRatio.chronicAvg * 7),
      ac_ratio: Math.round(acRatio.ratio * 100) / 100,
      ac_status: acRatio.ratio < 0.8 ? 'detraining'
                : acRatio.ratio < 1.3 ? 'optimal'
                : acRatio.ratio < 1.5 ? 'building (caution)'
                : 'overreaching (high injury risk)',
    },
    weekly_distribution: distribution,
    strength_tracking: {
      sessions_last_7d: allStrengthDates.size,
      days_since_last_session: daysSinceStrength,
      target_per_week: benchmarks.strength_target_per_week || 2,
    },
    current_event: benchmarks.current_event_date ? {
      name: benchmarks.current_event_name,
      date: benchmarks.current_event_date,
      type: benchmarks.current_event_type,
      distance_km: benchmarks.current_event_distance_km,
      elevation_m: benchmarks.current_event_elevation_m,
      days_to_event: daysToEvent,
    } : null,
    prescription_history_14d: history.map(h => {
      const fr = h.full_response || {};
      return {
        date: h.date,
        prescribed: { type: h.workout_type, duration_min: h.duration_min, headline: fr.headline },
        feedback: h.fb_status ? { status: h.fb_status, note: h.fb_note, rpe: h.fb_rpe } : null,
      };
    }),
    recent_activities_7d: recentActivities,
  };
}

async function generatePrescription(context) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 3000,
    system: COACH_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Today's data:\n\n${JSON.stringify(context, null, 2)}\n\nPrescribe today's workout and nutrition. Return JSON only.`
    }],
  });
  const text = msg.content[0].text;
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { buildContext, generatePrescription };
