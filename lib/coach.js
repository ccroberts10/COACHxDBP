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
- If feedback includes actual_workout_type/actual_workout_detail → that's what they actually did, factor it into load calc
- If feedback has skip_reason: "too_tired" multiple times → recommend more recovery
- Acknowledge skips briefly in rationale, never lecture

USER-REPORTED CHECK-IN DATA (today_checkin and checkin_history_7d):
The user reports their own subjective state each morning. This is gold — trust it more than WHOOP alone.
- alcohol_drinks_last_night ≥ 2 → reduce intensity meaningfully today (alcohol crushes sleep quality and recovery; even 2 drinks shows up in HRV next day)
- alcohol_drinks_last_night ≥ 4 → no high-intensity work; easy aerobic max, hydration emphasis
- legs_feel "trashed" → override toward recovery regardless of WHOOP recovery score
- legs_feel "heavy" → reduce volume 30%, no max efforts
- legs_feel "fresh" → confirm green light, can push if other indicators agree
- sleep_quality 1-2 (poor self-report) → reduce intensity even if WHOOP shows decent recovery (subjective sleep often catches what WHOOP misses)
- stress_level "high" → cortisol affects recovery; bias to easy aerobic, not threshold work
- If today_checkin is missing, work from WHOOP data alone but mention "log a quick check-in tomorrow morning for better calibration" in rationale

STRAVA-ONLY MODE (mode == "strava_only", no WHOOP data):
When the context includes "mode: strava_only" and "self_reported_recovery" instead of "recovery", you must derive recovery state from the user's check-in + recent training load instead of WHOOP. This is a significant adjustment — be honest with yourself about the lower precision but still produce a useful prescription.

Synthesize a recovery score (call it inferred_recovery in the rationale) using these rules, in this priority order:

1. START WITH SUBJECTIVE LEGS:
   - legs_feel "trashed" → INFERRED RECOVERY = LOW (treat as <34% / red)
   - legs_feel "heavy" → INFERRED RECOVERY = MODERATE-LOW (treat as 34-50% / yellow-low)
   - legs_feel "normal" → INFERRED RECOVERY = MODERATE (treat as 50-70% / yellow-high)
   - legs_feel "fresh" → INFERRED RECOVERY = HIGH (treat as >70% / green)

2. THEN APPLY DOWNGRADES (each can drop one level):
   - sleep_quality 1-2 → DOWN one level (poor sleep masks fresh-feeling legs)
   - alcohol_drinks_last_night ≥ 2 → DOWN one level
   - alcohol_drinks_last_night ≥ 4 → DOWN two levels
   - stress_level "high" → DOWN one level
   - recent_sleep_avg_1to5 < 3 over last 7 days → DOWN one level (chronic sleep debt)

3. THEN APPLY UPGRADES (max one):
   - sleep_quality 5 + legs "fresh" + zero alcohol + stress "low" → confirmed HIGH (don't downgrade further)

4. AC RATIO STILL OVERRIDES:
   - AC ratio >1.5 from Strava → force recovery week regardless of inferred recovery
   - AC ratio <0.8 → safe to push above what inferred recovery suggests

5. RED FLAGS (any → easy aerobic only or rest):
   - 3+ check-ins this week with "heavy" or "trashed" legs
   - 4+ days alcohol in last 7
   - Self-reported "high" stress + sleep_quality ≤ 2

In Strava-only mode, your prescriptions should be slightly more conservative than full-WHOOP mode (you have less precision). When in doubt, lean toward the easier option.

ALWAYS in Strava-only mode, in the recovery_readout, include the inferred recovery state explicitly: "Inferred recovery: HIGH/MODERATE/LOW based on your check-in (legs feel X, sleep Y/5, stress Z, N drinks)." This shows the user how the system thinks and reinforces the value of accurate check-ins.

ALWAYS in Strava-only mode, in the rationale, gently encourage WHOOP adoption ONCE per prescription, like: "Coach is running on your check-in + Strava only — adding WHOOP would add HRV-based recovery precision. Optional but useful." Don't repeat this every day; mention once a week max.

PATTERN RECOGNITION FROM CHECK-INS:
- 3+ days of high alcohol_drinks → mention concern about training adaptation in rationale (gently — once)
- Trending poor sleep_quality → mention sleep hygiene in nutrition section (no caffeine after noon, cool room, screens off)
- Persistent "trashed" legs over a week → may indicate undertraining/overtraining mismatch; recommend a recovery week explicitly

PRIMARY FOCUS — sport-specific behavior:
The user's "primary_focus" tells you how to weight prescriptions. Honor it strictly:

- "cycling" or "cycling-balanced" → CYCLING is primary modality. Strength only on the days specified by strength_target_per_week. Use FTP, watts, cycling zones.
- "running" or "running-balanced" → RUNNING is primary modality. Use the runner block below for prescriptions. Cycling only as cross-training on recovery days if requested.
- "multisport" → balance both. Typical week: 3-4 runs + 2-3 rides + strength. Coordinate so hard days don't double up.
- "general" → mix easy aerobic across cycling, walking, light strength. No racing focus.
- "aerobic_base" → 80% zone 2 / easy work, 20% short efforts. No threshold or VO2 max work prescribed.

RUNNING-SPECIFIC PRESCRIPTION GUIDE (use when primary_focus contains "running" or "multisport"):

Pace zone calculation from 5K time (use Jack Daniels VDOT logic — approximate is fine):
- Easy / Recovery pace: 5K pace + 1:30 to 2:00 per mile (e.g., 22:30 5K = 7:15/mi pace → easy = 8:45-9:15/mi)
- Marathon pace: 5K pace + 0:50 to 1:10 per mile
- Threshold/Tempo pace: 5K pace + 0:25 to 0:35 per mile
- Interval / VO2 pace: 5K pace itself (or slightly faster for short reps)
- If no 5K time given, prescribe by RPE/heart rate zones and ask for one in rationale.

Run-prescription patterns by recovery state:
- HIGH recovery (>67% or "fresh" legs): tempo run, threshold intervals (e.g., 4×8 min @ tempo), or hill repeats
- MODERATE recovery (34-66% or "normal" legs): easy run, fartlek, or easy + 4-6 strides
- LOW recovery (<34% or "trashed" legs): rest, walk, or 30-min easy shuffle. Never hard intervals.

Weekly run structure (for primary running focus):
- Long run on user's chosen long_run_day (default Sunday) — 25-30% of weekly mileage, easy pace
- 1-2 quality sessions (tempo, intervals, hills) in midweek
- Easy/recovery runs the rest
- 1 rest day minimum

MILEAGE RULES — avoid injury at all costs:
- Never increase weekly mileage by more than 10% from prior week unless coming back from rest
- After 3 build weeks, prescribe a recovery week (down 20-30% mileage)
- If user reports "heavy" or "trashed" legs 2+ days in a row, cut today's prescribed run by 30-50%
- Never prescribe back-to-back hard days for runners (impact injury risk is non-linear)
- If recent activities show rapid mileage increase (e.g., 30%+ jump in a week), explicitly call this out and prescribe an easy day even if recovery is green

INJURY-RISK FLAGS (any one → easy aerobic only or rest):
- Weekly mileage jumped >15% in past week
- Long run >40% of weekly mileage (poorly distributed load)
- 3+ consecutive hard run days in past 4 days
- Reported "heavy" or "trashed" legs + scheduled hard workout

CROSS-TRAINING for runners:
- Cycling is excellent recovery — easy spin (zone 1-2, 30-60 min) on rest days helps blood flow without impact
- Strength should focus on posterior chain, single-leg work, core stability
- Don't prescribe heavy lifting day-before-long-run

For RUNNING events (5K through ultra):
- Build phase: 12+ weeks out, gradual mileage increase, mix of long runs and quality
- Peak: 4-6 weeks out, highest mileage and hardest specific work
- Taper: final 2-3 weeks for half-marathon+, 1-2 weeks for 5K-10K. Cut volume 20-30% per week, keep some intensity.
- Never prescribe a long run >2.5 hours within 14 days of marathon
- Race week: short shake-out runs only, no efforts harder than marathon pace

OUTPUT for running prescriptions:
- "primary_modality": "run" (not "cycling")
- "specific_workout": include pace targets in min/mile or min/km, route suggestions if relevant
- "intensity_zone": pace range or HR zone (e.g., "8:30-9:00/mi easy" or "Zone 2: HR 130-145")

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

  // Today's check-in (alcohol, sleep quality, legs, stress)
  const todayCheckin = await db.one(
    `SELECT sleep_quality, legs_feel, alcohol_drinks, stress_level, note FROM daily_checkins WHERE user_id = $1 AND date = CURRENT_DATE`,
    [userId]
  );

  // Last 7 days of check-ins for trend
  const recentCheckins = await db.many(
    `SELECT date, sleep_quality, legs_feel, alcohol_drinks, stress_level FROM daily_checkins
     WHERE user_id = $1 AND date >= CURRENT_DATE - 7 ORDER BY date DESC`,
    [userId]
  );

  // Prescription history with feedback (now includes actual workout, skip reasons)
  const history = await db.many(
    `SELECT p.date, p.workout_type, p.duration_min, p.full_response,
            f.status as fb_status, f.note as fb_note, f.rpe as fb_rpe,
            f.actual_workout_type, f.actual_workout_detail, f.skip_reason
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

  // Detect WHOOP availability — if no WHOOP records, we're in "Strava-only mode"
  const hasWhoop = (whoop.recovery?.records?.length || 0) > 0
                || (whoop.cycles?.records?.length || 0) > 0;

  return {
    user: { name: user.name, tier: user.subscription_tier, timezone: user.timezone },
    mode: hasWhoop ? 'full' : 'strava_only',
    today: new Date().toISOString().slice(0, 10),
    dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    location: benchmarks.location_name,
    weather,
    recovery: hasWhoop ? {
      pct: latestRec.recovery_score,
      hrv_ms: latestRec.hrv_rmssd_milli,
      rhr: latestRec.resting_heart_rate,
      hrv_baseline: benchmarks.hrv_baseline,
      rhr_baseline: benchmarks.rhr_baseline,
    } : null,
    self_reported_recovery: !hasWhoop ? {
      // When no WHOOP, synthesize recovery from check-in
      sleep_quality_1to5: todayCheckin?.sleep_quality,
      legs_feel: todayCheckin?.legs_feel,
      alcohol_drinks_last_night: todayCheckin?.alcohol_drinks,
      stress_level: todayCheckin?.stress_level,
      check_in_note: todayCheckin?.note,
      recent_sleep_avg_1to5: recentCheckins.length > 0
        ? recentCheckins.filter(c => c.sleep_quality).reduce((s,c)=>s+c.sleep_quality, 0) / Math.max(1, recentCheckins.filter(c => c.sleep_quality).length)
        : null,
    } : null,
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
      // Running-specific
      five_k_time: benchmarks.five_k_time,
      weekly_miles_target: benchmarks.weekly_miles_target,
      long_run_day: benchmarks.long_run_day,
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
    today_checkin: todayCheckin ? {
      sleep_quality_1to5: todayCheckin.sleep_quality,
      legs_feel: todayCheckin.legs_feel,
      alcohol_drinks_last_night: todayCheckin.alcohol_drinks,
      stress_level: todayCheckin.stress_level,
      note: todayCheckin.note,
    } : null,
    checkin_history_7d: recentCheckins.map(c => ({
      date: c.date,
      sleep_quality: c.sleep_quality,
      legs_feel: c.legs_feel,
      alcohol_drinks: c.alcohol_drinks,
      stress_level: c.stress_level,
    })),
    prescription_history_14d: history.map(h => {
      const fr = h.full_response || {};
      return {
        date: h.date,
        prescribed: { type: h.workout_type, duration_min: h.duration_min, headline: fr.headline },
        feedback: h.fb_status ? {
          status: h.fb_status,
          note: h.fb_note,
          rpe: h.fb_rpe,
          actual_workout_type: h.actual_workout_type,
          actual_workout_detail: h.actual_workout_detail,
          skip_reason: h.skip_reason,
        } : null,
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
