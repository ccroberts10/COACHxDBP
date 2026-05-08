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
     WHERE u.subscription_tier IN ('rewards', 'coach')
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
     WHERE subscription_tier IN ('rewards', 'coach')
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
     WHERE subscription_tier IN ('rewards', 'coach')
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

// ===================================================================
// CAP CHECKING — enforce per-template usage limits
// ===================================================================

/**
 * Check if a user can be issued a perk from this template.
 * Returns { allowed: bool, reason: string|null, used: { year, month, week }, remaining: { year, month, week } }
 */
async function checkPerkCap(userId, templateId) {
  const template = await db.one(`SELECT * FROM perk_templates WHERE id = $1 AND active = TRUE`, [templateId]);
  if (!template) return { allowed: false, reason: 'Template not found' };

  // 1. Seasonal restriction — current month must be in redemption_months if set
  if (template.redemption_months && template.redemption_months.length > 0) {
    const currentMonth = new Date().getMonth() + 1; // 1-12
    if (!template.redemption_months.includes(currentMonth)) {
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const allowed = template.redemption_months.map(m => monthNames[m-1]).join(', ');
      return {
        allowed: false,
        reason: `${template.name} can only be redeemed during: ${allowed}.`,
        used: { year: 0, month: 0, week: 0 },
        remaining: { year: null, month: null, week: null },
      };
    }
  }

  // 2. Count usage in different time windows
  const yearStart = new Date();
  yearStart.setMonth(0, 1); yearStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);

  const counts = await db.one(
    `SELECT
       COUNT(*) FILTER (WHERE issued_at >= $3) AS year_count,
       COUNT(*) FILTER (WHERE issued_at >= $4) AS month_count,
       COUNT(*) FILTER (WHERE issued_at >= $5) AS week_count
     FROM perk_redemptions
     WHERE user_id = $1 AND template_id = $2`,
    [userId, templateId, yearStart, monthStart, weekStart]
  );

  const yearCount = parseInt(counts?.year_count || 0);
  const monthCount = parseInt(counts?.month_count || 0);
  const weekCount = parseInt(counts?.week_count || 0);

  const used = { year: yearCount, month: monthCount, week: weekCount };
  const remaining = {
    year: template.max_per_year != null ? Math.max(0, template.max_per_year - yearCount) : null,
    month: template.max_per_month != null ? Math.max(0, template.max_per_month - monthCount) : null,
    week: template.max_per_week != null ? Math.max(0, template.max_per_week - weekCount) : null,
  };

  // 3. Check each cap
  if (template.max_per_year != null && yearCount >= template.max_per_year) {
    return {
      allowed: false,
      reason: `Annual limit reached (${yearCount}/${template.max_per_year} this year).`,
      used, remaining,
    };
  }
  if (template.max_per_month != null && monthCount >= template.max_per_month) {
    return {
      allowed: false,
      reason: `Monthly limit reached (${monthCount}/${template.max_per_month} this month).`,
      used, remaining,
    };
  }
  if (template.max_per_week != null && weekCount >= template.max_per_week) {
    return {
      allowed: false,
      reason: `Weekly limit reached (${weekCount}/${template.max_per_week} this week).`,
      used, remaining,
    };
  }

  return { allowed: true, reason: null, used, remaining, template };
}

/**
 * Get usage summary for a user across all capped templates.
 * Returns array of { template_id, name, used: {year, month, week}, remaining: {...} }.
 */
async function getMemberCapsSummary(userId) {
  const templates = await db.many(
    `SELECT * FROM perk_templates
     WHERE active = TRUE
       AND (max_per_year IS NOT NULL OR max_per_month IS NOT NULL OR max_per_week IS NOT NULL OR redemption_months IS NOT NULL)
     ORDER BY sort_order`
  );
  const result = [];
  for (const t of templates) {
    const check = await checkPerkCap(userId, t.id);
    result.push({
      template_id: t.id,
      name: t.name,
      category: t.category,
      max_per_year: t.max_per_year,
      max_per_month: t.max_per_month,
      max_per_week: t.max_per_week,
      redemption_months: t.redemption_months,
      cap_notes: t.cap_notes,
      used: check.used,
      remaining: check.remaining,
      currently_allowed: check.allowed,
      reason_if_blocked: check.allowed ? null : check.reason,
    });
  }
  return result;
}

// ===================================================================
// ISSUE PERK FROM TEMPLATE — admin-driven or system-driven
// ===================================================================

async function issuePerkFromTemplate({
  userId,
  templateId,
  triggerType = 'manual',
  issuedBy = 'system',
  expiresInDays,           // override template default if provided
  customDescription,       // override template description if provided
  bypassCaps = false,      // for admin override
}) {
  // Cap check (unless bypassed)
  if (!bypassCaps) {
    const cap = await checkPerkCap(userId, templateId);
    if (!cap.allowed) {
      const err = new Error(`Cannot issue perk: ${cap.reason}`);
      err.code = 'CAP_REACHED';
      err.capInfo = cap;
      throw err;
    }
  }

  const template = await db.one(`SELECT * FROM perk_templates WHERE id = $1 AND active = TRUE`, [templateId]);
  if (!template) throw new Error('Template not found or inactive');

  const codePrefix = template.category === 'service' ? 'SVC' :
                     template.category === 'merch' ? 'MRC' :
                     template.category === 'food' ? 'EAT' : 'DBP';
  const code = await ensureUniqueCode(codePrefix);

  const days = expiresInDays != null ? expiresInDays : template.default_expires_days;
  let expiresAt = null;
  if (days != null && days > 0) {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);
  }

  const description = customDescription || template.description;
  // Map template category back to legacy perk_type for backwards compat
  const perkType = template.category === 'drink' ? 'drink' :
                   template.category === 'food' ? 'food' :
                   template.category === 'service' ? 'service' :
                   template.category === 'merch' ? 'merch' : 'discount';

  await db.query(
    `INSERT INTO perk_redemptions
       (user_id, perk_type, code, description, expires_at,
        template_id, savings_cents, cost_cents, trigger_type, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [userId, perkType, code, description, expiresAt,
     template.id,
     template.is_percentage ? null : template.default_retail_cents,
     template.is_percentage ? null : template.default_cost_cents,
     triggerType, issuedBy]
  );
  return { code, description, expires_at: expiresAt, template };
}

// ===================================================================
// REDEEM CODE — barista enters subtotal for percentage discounts
// ===================================================================

async function redeemCode(code, staffName, opts = {}) {
  const { note = null, subtotalCents = null } = opts;
  const perk = await db.one(
    `SELECT p.*, u.email, u.name as user_name, t.is_percentage, t.percentage_off, t.default_retail_cents, t.default_cost_cents
     FROM perk_redemptions p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN perk_templates t ON t.id = p.template_id
     WHERE p.code = $1`,
    [code.toUpperCase()]
  );
  if (!perk) return { success: false, error: 'Code not found' };
  if (perk.redeemed_at) return { success: false, error: 'Already redeemed', perk };
  if (perk.expires_at && new Date(perk.expires_at) < new Date()) {
    return { success: false, error: 'Expired', perk };
  }

  // For percentage discounts, calculate actual savings from subtotal
  let savingsCents = perk.savings_cents;
  let costCents = perk.cost_cents;
  if (perk.is_percentage && perk.percentage_off) {
    if (subtotalCents == null) {
      return { success: false, error: 'Subtotal required for percentage discount', requires_subtotal: true, perk };
    }
    savingsCents = Math.round(subtotalCents * perk.percentage_off / 100);
    costCents = savingsCents; // for percentage, savings = cost (margin loss)
  }

  await db.query(
    `UPDATE perk_redemptions
     SET redeemed_at = NOW(), redeemed_by_staff = $1, redemption_note = $2,
         savings_cents = COALESCE($3, savings_cents),
         cost_cents = COALESCE($4, cost_cents)
     WHERE code = $5`,
    [staffName, note, savingsCents, costCents, code.toUpperCase()]
  );
  return { success: true, perk: { ...perk, savings_cents: savingsCents, cost_cents: costCents } };
}

// ===================================================================
// SAVINGS STATS — for member dashboard + admin analytics
// ===================================================================

async function getMemberSavings(userId) {
  const result = await db.one(
    `SELECT
       COALESCE(SUM(CASE WHEN redeemed_at >= date_trunc('month', NOW()) THEN savings_cents END), 0) as month_cents,
       COALESCE(SUM(CASE WHEN redeemed_at >= date_trunc('year', NOW()) THEN savings_cents END), 0) as year_cents,
       COALESCE(SUM(savings_cents), 0) as lifetime_cents,
       COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL) as redemption_count
     FROM perk_redemptions WHERE user_id = $1`,
    [userId]
  );
  return result;
}

async function getAdminAnalytics() {
  const overview = await db.one(
    `SELECT
       COUNT(*) FILTER (WHERE redeemed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())) as active_count,
       COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL) as redeemed_count,
       COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL AND redeemed_at >= date_trunc('month', NOW())) as redeemed_this_month,
       COALESCE(SUM(savings_cents) FILTER (WHERE redeemed_at >= date_trunc('month', NOW())), 0) as total_savings_this_month_cents,
       COALESCE(SUM(cost_cents) FILTER (WHERE redeemed_at >= date_trunc('month', NOW())), 0) as total_cost_this_month_cents
     FROM perk_redemptions`
  );
  return overview;
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
  issuePerkFromTemplate,
  checkPerkCap,
  getMemberCapsSummary,
  redeemCode,
  getMemberSavings,
  getAdminAnalytics,
  getActiveLeaderboards,
  computeStandings,
};
