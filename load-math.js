// lib/load-math.js
// TRIMP, TSS, AC ratio, polarized distribution

function computeTRIMP(activity, maxHr, restingHr) {
  if (!activity.average_heartrate || !maxHr) return null;
  const hrr = (activity.average_heartrate - restingHr) / (maxHr - restingHr);
  const minutes = activity.moving_time / 60;
  const k = 1.92;
  return minutes * hrr * 0.64 * Math.exp(k * hrr);
}

function computeTSS(activity, ftp) {
  if (!activity.weighted_average_watts || !ftp) return null;
  const np = activity.weighted_average_watts;
  const intensity = np / ftp;
  const seconds = activity.moving_time;
  return (seconds * np * intensity) / (ftp * 3600) * 100;
}

function computeAcuteChronicRatio(activities, maxHr, restingHr, ftp) {
  const now = Date.now();
  let acute = 0, chronic = 0, acuteCount = 0, chronicCount = 0;
  for (const a of activities) {
    const ageDays = (now - new Date(a.start_date).getTime()) / (1000 * 60 * 60 * 24);
    const load = computeTSS(a, ftp) || computeTRIMP(a, maxHr, restingHr) || (a.suffer_score || 0);
    if (ageDays <= 7) { acute += load; acuteCount++; }
    if (ageDays <= 28) { chronic += load; chronicCount++; }
  }
  const acuteAvg = acuteCount > 0 ? acute / 7 : 0;
  const chronicAvg = chronicCount > 0 ? chronic / 28 : 0;
  return {
    acute7dTotal: acute,
    chronic28dTotal: chronic,
    acuteAvg, chronicAvg,
    ratio: chronicAvg > 0 ? acuteAvg / chronicAvg : 1,
  };
}

function estimateFtpFromStrava(activities) {
  let best20 = 0;
  for (const a of activities) {
    if (a.type !== 'Ride' && a.type !== 'VirtualRide') continue;
    if (!a.weighted_average_watts || a.moving_time < 20 * 60) continue;
    if (a.weighted_average_watts > best20) best20 = a.weighted_average_watts;
  }
  return best20 ? Math.round(best20 * 0.95) : null;
}

function computeWeeklyDistribution(activities, lthr) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let easy = 0, mod = 0, hard = 0;
  for (const a of activities) {
    if (new Date(a.start_date).getTime() < cutoff) continue;
    if (!a.average_heartrate) continue;
    const pct = a.average_heartrate / (lthr || 165);
    const min = a.moving_time / 60;
    if (pct < 0.85) easy += min;
    else if (pct < 0.95) mod += min;
    else hard += min;
  }
  const total = easy + mod + hard;
  if (total === 0) return null;
  return {
    easyPct: Math.round(easy / total * 100),
    moderatePct: Math.round(mod / total * 100),
    hardPct: Math.round(hard / total * 100),
    totalMinutes: Math.round(total),
  };
}

module.exports = {
  computeTRIMP,
  computeTSS,
  computeAcuteChronicRatio,
  estimateFtpFromStrava,
  computeWeeklyDistribution,
};
