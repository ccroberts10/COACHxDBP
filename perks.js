// lib/perks.js
// DBP Elite member perks: Sunday drinks, birthdays, service reminders, leaderboards

const crypto = require('crypto');
const db = require('../db/client');
const {
  sendSundayDrinkEmail,
  sendBirthdayEmail,
  sendServiceReminderEmail,
  sendCompetitionWinnerEmail,
} = require('./email');

// Generate a short, human-readable redemption code: e.g. "DBP-3X7K"
function genCode(prefix = 'DBP') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid barista confusion
  let code = '';
  for (let i = 0; i < 4; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return `${prefix}-${code}`;
}

async function ensureUniqueCode(prefix) {
  for (let i = 0; i < 8; i++) {
    const code = genCode(prefix);
    const existing = await db.one(`SELECT 1 FROM perk_redemptions WHERE code = $1`, [code]);
    if (!existing) return code;
  }
  // Fallback: longer code
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ===================================================================
// SUNDAY DRINK PERKS — Elite tier, 1 per Sunday
// ===================================================================

async function issueSundayDrinks() {
  const today = new Date().toISOString().slice(0, 10);
  // Only Elite users with active subscriptions
  const eligible = await db.many(
    `SELECT u.id, u.email, u.name, s.recovery_pct
     FROM users u
     LEFT JOIN daily_snapshots s ON s.user_id = u.id AND s.date = $1
     WHERE u.subscription_tier = 'elite'
       AND u.subscription_status IN ('active', 'trialing')
       AND u.onboarding_completed = TRUE`,
    [today]
  );

  let issued = 0;
  for (const user of eligible) {
    try {
      // Skip if already issued today
      const existing = await db.one(
        `SELECT 1 FROM perk_redemptions
         WHERE user_id = $1 AND perk_type = 'sunday_drink' AND issued_at::date = CURRENT_DATE`,
        [user.id]
      );
      if (existing) continue;

      const code = await ensureUniqueCode('DBP');
      const expiresAt = new Date();
      expiresAt.setHours(23, 59, 59);

      await db.query(
        `INSERT INTO perk_redemptions (user_id, perk_type, code, description, expires_at)
         VALUES ($1, 'sunday_drink', $2, 'Sunday recovery drink — any drink, valid today only', $3)`,
        [user.id, code, expiresAt]
      );

      await sendSundayDrinkEmail(user.email, user.name, code, user.recovery_pct || 50);
      issued++;
    } catch (e) {
      console.error('[perks] Sunday drink failed for user', user.id, e.message);
    }
  }
  console.log(`[perks] Sunday drinks issued: ${issued}/${eligible.length}`);
  return { issued, total: eligible.length };
}

// ===================================================================
// BIRTHDAY PERKS — Elite tier, free coffee for the month of birthday
// ===================================================================

async function issueBirthdayPerks() {
  // Find users whose birthday is today (any year)
  const eligible = await db.many(
    `SELECT id, email, name FROM users
     WHERE subscription_tier = 'elite'
       AND subscription_status IN ('active', 'trialing')
       AND onboarding_completed = TRUE
       AND birthdate IS NOT NULL
       AND EXTRACT(MONTH FROM birthdate) = EXTRACT(MONTH FROM CURRENT_DATE)
       AND EXTRACT(DAY FROM birthdate) = EXTRACT(DAY FROM CURRENT_DATE)`
  );

  let issued = 0;
  for (const user of eligible) {
    try {
      // Skip if already issued this year
      const existing = await db.one(
        `SELECT 1 FROM perk_redemptions
         WHERE user_id = $1 AND perk_type = 'birthday_drink'
           AND EXTRACT(YEAR FROM issued_at) = EXTRACT(YEAR FROM CURRENT_DATE)`,
        [user.id]
      );
      if (existing) continue;

      const code = await ensureUniqueCode('BDAY');
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);
      expiresAt.setDate(0); // Last day of current month

      await db.query(
        `INSERT INTO perk_redemptions (user_id, perk_type, code, description, expires_at)
         VALUES ($1, 'birthday_drink', $2, $3, $4)`,
        [user.id, code, 'Birthday coffee — any drink, valid through end of month', expiresAt]
      );

      await sendBirthdayEmail(user.email, user.name, code);
      issued++;
    } catch (e) {
      console.error('[perks] Birthday perk failed for user', user.id, e.message);
    }
  }
  console.log(`[perks] Birthday perks issued: ${issued}`);
  return { issued };
}

// ===================================================================
// SERVICE REMINDERS — based on accumulated km from Strava
// ===================================================================

async function checkServiceReminders() {
  // Recompute total km from activities for all elite users
  const eliteUsers = await db.many(
    `SELECT id, email, name FROM users
     WHERE subscription_tier = 'elite'
       AND subscription_status IN ('active', 'trialing')
       AND onboarding_completed = TRUE`
  );

  let reminded = 0;
  for (const user of eliteUsers) {
    try {
      // Sum total km from rides
      const result = await db.one(
        `SELECT COALESCE(SUM(distance_m), 0) / 1000 as total_km
         FROM activities WHERE user_id = $1 AND type IN ('Ride', 'VirtualRide')`,
        [user.id]
      );
      const totalKm = parseFloat(result.total_km);

      // Get or create service interval row
      let interval = await db.one(`SELECT * FROM service_intervals WHERE user_id = $1`, [user.id]);
      if (!interval) {
        await db.query(
          `INSERT INTO service_intervals (user_id, total_km_lifetime, km_at_last_tuneup, next_reminder_at_km)
           VALUES ($1, $2, $2, $3)`,
          [user.id, totalKm, totalKm + 1500]
        );
        continue;
      }

      // Check if reminder threshold crossed and not recently sent
      const kmSinceLastTuneup = totalKm - parseFloat(interval.km_at_last_tuneup || 0);
      if (kmSinceLastTuneup >= 1500) {
        // Don't send if reminder was sent in last 30 days
        if (interval.reminder_sent_at) {
          const daysSince = (Date.now() - new Date(interval.reminder_sent_at).getTime()) / (86400000);
          if (daysSince < 30) continue;
        }

        await sendServiceReminderEmail(user.email, user.name, kmSinceLastTuneup);
        await db.query(
          `UPDATE service_intervals SET total_km_lifetime = $1, reminder_sent_at = NOW(), updated_at = NOW()
           WHERE user_id = $2`,
          [totalKm, user.id]
        );
        reminded++;
      } else {
        // Just update km
        await db.query(
          `UPDATE service_intervals SET total_km_lifetime = $1, updated_at = NOW() WHERE user_id = $2`,
          [totalKm, user.id]
        );
      }
    } catch (e) {
      console.error('[perks] Service reminder failed for user', user.id, e.message);
    }
  }
  console.log(`[perks] Service reminders sent: ${reminded}`);
  return { reminded };
}

// ===================================================================
// REDEMPTION — barista scans/types code
// ===================================================================

async function redeemCode(code, staffName, note = null) {
  const perk = await db.one(
    `SELECT p.*, u.email, u.name as user_name
     FROM perk_redemptions p JOIN users u ON u.id = p.user_id
     WHERE p.code = $1`,
    [code.toUpperCase()]
  );
  if (!perk) return { success: false, error: 'Code not found' };
  if (perk.redeemed_at) return { success: false, error: 'Already redeemed', perk };
  if (perk.expires_at && new Date(perk.expires_at) < new Date()) {
    return { success: false, error: 'Expired', perk };
  }

  await db.query(
    `UPDATE perk_redemptions SET redeemed_at = NOW(), redeemed_by_staff = $1, redemption_note = $2 WHERE code = $3`,
    [staffName, note, code.toUpperCase()]
  );
  return { success: true, perk };
}

// ===================================================================
// LEADERBOARD - Strava-derived stats for active competitions
// ===================================================================

async function getActiveLeaderboards() {
  const comps = await db.many(
    `SELECT * FROM competitions WHERE is_active = TRUE AND end_date >= CURRENT_DATE`
  );
  const result = [];
  for (const comp of comps) {
    const standings = await computeStandings(comp);
    result.push({ competition: comp, standings });
  }
  return result;
}

async function computeStandings(comp) {
  // Different metrics: total_km, total_elevation_m, recovery_streak, consistency_days
  let metricSql;
  switch (comp.metric) {
    case 'total_km':
      metricSql = `COALESCE(SUM(a.distance_m), 0) / 1000`;
      break;
    case 'total_elevation_m':
      metricSql = `COALESCE(SUM(a.elevation_gain_m), 0)`;
      break;
    case 'consistency_days':
      metricSql = `COUNT(DISTINCT a.date)`;
      break;
    default:
      metricSql = `COUNT(*)`;
  }
  return db.many(
    `SELECT u.id, u.name, ${metricSql} as score
     FROM competition_participants cp
     JOIN users u ON u.id = cp.user_id
     LEFT JOIN activities a ON a.user_id = u.id AND a.date BETWEEN $1 AND $2
       AND a.type IN ('Ride', 'VirtualRide')
     WHERE cp.competition_id = $3
     GROUP BY u.id, u.name
     ORDER BY score DESC
     LIMIT 50`,
    [comp.start_date, comp.end_date, comp.id]
  );
}

module.exports = {
  issueSundayDrinks,
  issueBirthdayPerks,
  checkServiceReminders,
  redeemCode,
  getActiveLeaderboards,
  computeStandings,
};
