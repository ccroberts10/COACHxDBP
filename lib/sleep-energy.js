// Sleep debt + circadian energy schedule (two-process model: sleep pressure + circadian rhythm).
// Inputs: WHOOP v2 sleep records. Output feeds the coach prompt and the dashboard.
//
// Sleep need  : WHOOP's personal baseline (median of recent nights), else 8h.
// Sleep debt  : last 14 nights, recent nights weighted more. Naps count. Oversleeping
//               pays debt down but never builds a "bank" below zero.
// Energy curve: anchored to typical wake time (median of last 10 main sleeps), using the
//               standard circadian offsets — grogginess, morning peak, afternoon dip,
//               evening peak, wind-down, melatonin window.

const H = 3600000;
const DEFAULT_NEED_H = 8;
const DEBT_NIGHTS = 14;

function median(arr) {
  const a = arr.filter(v => v != null && !isNaN(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function asleepMs(rec) {
  const s = rec?.score?.stage_summary;
  if (!s) return null;
  const v = (s.total_light_sleep_time_milli || 0) + (s.total_slow_wave_sleep_time_milli || 0) + (s.total_rem_sleep_time_milli || 0);
  return v > 0 ? v : null;
}

// Local clock time of an ISO timestamp, in minutes after midnight, using WHOOP's tz offset ("-07:00")
function localMinutes(iso, offset) {
  const d = new Date(iso);
  let offMin = 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset || '');
  if (m) offMin = (m[1] === '-' ? -1 : 1) * (parseInt(m[2]) * 60 + parseInt(m[3]));
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return ((utcMin + offMin) % 1440 + 1440) % 1440;
}

function localDate(iso, offset) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset || '');
  const offMs = m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2]) * 60 + parseInt(m[3])) * 60000 : 0;
  return new Date(new Date(iso).getTime() + offMs).toISOString().slice(0, 10);
}

function fmt(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60), mm = min % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

// Circular median for clock times (handles wake times near midnight)
function clockMedian(mins) {
  if (!mins.length) return null;
  const ref = mins[0];
  const shifted = mins.map(m => { let d = m - ref; if (d > 720) d -= 1440; if (d < -720) d += 1440; return ref + d; });
  return ((median(shifted) % 1440) + 1440) % 1440;
}

function compute(sleepRecords) {
  const recs = (sleepRecords || [])
    .filter(r => r && r.start && r.end && r.score_state !== 'UNSCORABLE')
    .sort((a, b) => new Date(b.end) - new Date(a.end));
  if (!recs.length) return null;

  const main = recs.filter(r => !r.nap);

  // --- Sleep need ---
  const baselines = main.slice(0, 14).map(r => r.score?.sleep_needed?.baseline_milli).filter(Boolean);
  const needH = baselines.length ? Math.round((median(baselines) / H) * 4) / 4 : DEFAULT_NEED_H;

  // --- Sleep per night (main sleep + naps on the same local date of waking) ---
  const byDate = new Map();
  for (const r of recs) {
    const ms = asleepMs(r);
    if (ms == null) continue;
    const key = localDate(r.end, r.timezone_offset);
    byDate.set(key, (byDate.get(key) || 0) + ms / H);
  }
  const nights = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, DEBT_NIGHTS);

  // --- Sleep debt: weighted, recent nights count more (weight 1.0 → ~0.35 over 14 nights) ---
  let weighted = 0, weightSum = 0;
  nights.forEach(([, hrs], i) => {
    const w = Math.pow(0.925, i);
    weighted += (needH - hrs) * w;
    weightSum += w;
  });
  // Scale back to "hours over 14 nights"
  const debtH = nights.length ? Math.max(0, (weighted / weightSum) * Math.min(nights.length, DEBT_NIGHTS)) : null;
  const debtRounded = debtH != null ? Math.round(debtH * 10) / 10 : null;
  const debtLevel = debtH == null ? null : debtH < 2 ? 'low' : debtH < 5 ? 'moderate' : 'high';

  // --- Circadian anchor: typical wake time ---
  const wakeMins = main.slice(0, 10).map(r => localMinutes(r.end, r.timezone_offset));
  const wake = clockMedian(wakeMins);
  const bedMins = main.slice(0, 10).map(r => localMinutes(r.start, r.timezone_offset));
  const bed = clockMedian(bedMins);
  const lastNight = main[0] ? Math.round((asleepMs(main[0]) || 0) / H * 10) / 10 : null;

  const w = wake;
  const win = (a, b) => ({ start: fmt(w + a * 60), end: fmt(w + b * 60) });
  const schedule = w == null ? null : {
    typical_wake: fmt(w),
    typical_bed: bed != null ? fmt(bed) : null,
    grogginess: win(0, 1.5),
    morning_peak: win(2, 5),
    afternoon_dip: win(6.5, 9),
    evening_peak: win(10, 13),
    wind_down: win(14, 15),
    melatonin_window: win(15, 16),
  };

  // Recommended bedtime tonight: back-calculate from typical wake time:
  // wake − sleep need − debt payback (≤45 min) − 15 min to fall asleep.
  // Never earlier than the start of the melatonin window.
  let bedtimeTarget = null;
  if (w != null) {
    const payback = debtH >= 5 ? 45 : debtH >= 2 ? 30 : 0;
    let target = w - needH * 60 - payback - 15;
    const melStart = w + 15 * 60 - 1440;
    if (target < melStart) target = melStart;
    bedtimeTarget = fmt(target);
  }

  return {
    sleep_need_h: needH,
    last_night_h: lastNight,
    nights_counted: nights.length,
    sleep_debt_h: debtRounded,
    sleep_debt_level: debtLevel,
    energy_schedule: schedule,
    bedtime_target: bedtimeTarget,
  };
}

module.exports = { compute };
