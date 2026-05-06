// lib/member-rewards.js
// Handles: member codes (DBP-CASEY), purchases, punch cards, check-in streaks.

const db = require('../db/client');
const perks = require('./perks');

// ===================================================================
// MEMBER CODES
// ===================================================================

/**
 * Generate a memorable code from name. e.g., "Casey Roberts" → "DBP-CASEY"
 * Handles collisions by appending number.
 */
async function generateMemberCode(name, email) {
  // Extract first name, uppercase, alphanumeric only
  const firstName = (name || '').split(/\s+/)[0] || '';
  let base = firstName.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (base.length < 3) {
    // Fallback: use email prefix
    base = (email || 'MEMBER').split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  }
  if (base.length > 12) base = base.slice(0, 12);

  // Try base, then base + 2, base + 3, etc.
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? `DBP-${base}` : `DBP-${base}${i + 1}`;
    const existing = await db.one(`SELECT id FROM users WHERE member_code = $1`, [candidate]);
    if (!existing) return candidate;
  }
  // Fallback to random
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DBP-${base}${random}`;
}

/**
 * Ensure user has a member code; generate one if missing.
 */
async function ensureMemberCode(userId) {
  const user = await db.one(`SELECT id, name, email, member_code FROM users WHERE id = $1`, [userId]);
  if (!user) throw new Error('User not found');
  if (user.member_code) return user.member_code;

  const code = await generateMemberCode(user.name, user.email);
  await db.query(`UPDATE users SET member_code = $1 WHERE id = $2`, [code, userId]);
  return code;
}

/**
 * Look up user by member code.
 */
async function userByMemberCode(code) {
  const upper = code.trim().toUpperCase();
  return await db.one(
    `SELECT id, name, email, member_code, subscription_tier, subscription_status,
            punch_count, punch_total_lifetime, checkin_streak_current, checkin_streak_longest
     FROM users WHERE UPPER(member_code) = $1`,
    [upper]
  );
}

// ===================================================================
// PURCHASE LOGGING + PUNCH CARD
// ===================================================================

/**
 * Log a purchase. If it's a coffee, increment punch counter.
 * If 10th coffee, auto-issue free coffee reward.
 *
 * @returns { purchase, punch_progress, awarded_perk }
 */
async function logPurchase({ userId, category, subcategory, amountCents, staffName, notes }) {
  const user = await db.one(
    `SELECT id, name, email, punch_count, punch_total_lifetime FROM users WHERE id = $1`,
    [userId]
  );
  if (!user) throw new Error('User not found');

  // Determine if this counts toward punch card.
  // Only DRINK category at full retail (not free Sunday Coach drinks) counts.
  const countsTowardPunch = category === 'drink' && (amountCents || 0) >= 200;

  let newPunchCount = user.punch_count || 0;
  let lifetimePunch = user.punch_total_lifetime || 0;
  let awardedPerk = null;
  let triggeredCode = null;

  if (countsTowardPunch) {
    newPunchCount = (user.punch_count || 0) + 1;
    lifetimePunch += 1;

    // 10th punch → reset to 0 and issue free drink
    if (newPunchCount >= 10) {
      try {
        // Find the "Free 12oz drink" template (or any free-drink template)
        const template = await db.one(
          `SELECT id FROM perk_templates
           WHERE active = TRUE AND name = 'Free 12oz drink'
           LIMIT 1`
        );
        if (template) {
          const result = await perks.issuePerkFromTemplate({
            userId: user.id,
            templateId: template.id,
            triggerType: 'punch_card',
            issuedBy: 'system',
            expiresInDays: 30,
            customDescription: '🎉 Punch card complete! Free drink, on us.',
          });
          awardedPerk = result;
          triggeredCode = result.code;

          // Email the user
          try {
            const { sendBroadcastEmail } = require('./email');
            await sendBroadcastEmail(
              user.email, user.name,
              '🎉 Punch card complete!',
              'Your 10th coffee is on us',
              `You just bought your 9th coffee at DBP — and the 10th is FREE. Show this code on your next visit.`,
              result.code, result.description, result.expires_at
            );
          } catch (e) {
            console.error('[purchases] punch card email failed:', e.message);
          }
        }
      } catch (e) {
        console.error('[purchases] punch reward issue failed:', e.message);
      }
      newPunchCount = 0; // reset after award
    }

    await db.query(
      `UPDATE users SET punch_count = $1, punch_total_lifetime = $2 WHERE id = $3`,
      [newPunchCount, lifetimePunch, userId]
    );
  }

  // Insert purchase record
  const purchase = await db.one(
    `INSERT INTO purchases (user_id, category, subcategory, amount_cents, staff_name, notes, counted_toward_punch, triggered_perk_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, category, subcategory || null, amountCents || 0, staffName || null, notes || null, countsTowardPunch, triggeredCode]
  );

  return {
    purchase,
    punch_progress: { current: newPunchCount, target: 10 },
    counted_toward_punch: countsTowardPunch,
    awarded_perk: awardedPerk,
  };
}

/**
 * Get user-facing punch card stats.
 */
async function getPunchStats(userId) {
  const u = await db.one(
    `SELECT punch_count, punch_total_lifetime FROM users WHERE id = $1`,
    [userId]
  );
  if (!u) return { current: 0, target: 10, lifetime: 0 };
  return {
    current: u.punch_count || 0,
    target: 10,
    lifetime: u.punch_total_lifetime || 0,
    away_from_free: 10 - (u.punch_count || 0),
  };
}

// ===================================================================
// CHECK-IN STREAKS
// ===================================================================

/**
 * Called after a daily_checkin is saved.
 * Updates streak counter and checks for milestone rewards.
 */
async function processCheckinForStreak(userId, todayDate) {
  const user = await db.one(
    `SELECT id, name, email, checkin_streak_current, checkin_streak_longest, checkin_streak_last_date
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!user) return null;

  const today = todayDate; // YYYY-MM-DD string in user's TZ
  const lastDate = user.checkin_streak_last_date
    ? (user.checkin_streak_last_date instanceof Date
        ? user.checkin_streak_last_date.toISOString().slice(0, 10)
        : String(user.checkin_streak_last_date).slice(0, 10))
    : null;

  let newStreak = user.checkin_streak_current || 0;
  if (lastDate === today) {
    // Already counted today. Don't double-count.
    return { streak: newStreak, longest: user.checkin_streak_longest || 0, milestone_awarded: null };
  }

  // Calculate yesterday in user's TZ
  const todayObj = new Date(today + 'T12:00:00');
  const yesterday = new Date(todayObj);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  if (lastDate === yesterdayStr) {
    newStreak += 1; // continued streak
  } else {
    newStreak = 1; // new streak (or reset)
  }

  const longest = Math.max(user.checkin_streak_longest || 0, newStreak);

  await db.query(
    `UPDATE users
     SET checkin_streak_current = $1, checkin_streak_longest = $2, checkin_streak_last_date = $3
     WHERE id = $4`,
    [newStreak, longest, today, userId]
  );

  // Check for milestone reward
  const milestoneAwarded = await checkStreakMilestone(userId, newStreak, user);

  return { streak: newStreak, longest, milestone_awarded: milestoneAwarded };
}

const STREAK_MILESTONES = [
  { days: 7,   templateName: '$1 off any drink',         message: '7 days strong! Have $1 off your next drink at DBP.' },
  { days: 14,  templateName: 'Free 12oz drink',          message: 'Two weeks of check-ins! Free 12oz drink on us.' },
  { days: 30,  templateName: 'Free bag of DBP coffee',   message: '30 days! You earned a free bag of DBP coffee.' },
  { days: 60,  templateName: 'Free 12oz drink',          message: '60 days. Real consistency. Free drink waiting at DBP.' },
  { days: 100, templateName: 'Free bag of DBP coffee',   message: '💯 100 days of check-ins! Hall of fame. Free bag of beans.' },
];

async function checkStreakMilestone(userId, currentStreak, user) {
  const milestone = STREAK_MILESTONES.find(m => m.days === currentStreak);
  if (!milestone) return null;

  // Has user already received this milestone? (paranoid check)
  const existing = await db.one(
    `SELECT id FROM streak_milestones WHERE user_id = $1 AND milestone_days = $2`,
    [userId, currentStreak]
  );
  if (existing) return null;

  try {
    const template = await db.one(
      `SELECT id FROM perk_templates WHERE active = TRUE AND name = $1 LIMIT 1`,
      [milestone.templateName]
    );
    if (!template) return null;

    const result = await perks.issuePerkFromTemplate({
      userId,
      templateId: template.id,
      triggerType: 'streak_milestone',
      issuedBy: 'system',
      expiresInDays: 30,
      customDescription: milestone.message,
    });

    await db.query(
      `INSERT INTO streak_milestones (user_id, milestone_days, perk_code) VALUES ($1, $2, $3)`,
      [userId, currentStreak, result.code]
    );

    // Email
    try {
      const { sendBroadcastEmail } = require('./email');
      await sendBroadcastEmail(
        user.email, user.name,
        `🔥 ${currentStreak}-day streak!`,
        `${currentStreak}-day check-in streak`,
        milestone.message,
        result.code, result.description, result.expires_at
      );
    } catch (e) {
      console.error('[streak] email failed:', e.message);
    }

    return { milestone_days: currentStreak, code: result.code, description: result.description };
  } catch (e) {
    console.error(`[streak] milestone ${currentStreak} reward failed:`, e.message);
    return null;
  }
}

async function getStreakStats(userId) {
  const u = await db.one(
    `SELECT checkin_streak_current, checkin_streak_longest, checkin_streak_last_date FROM users WHERE id = $1`,
    [userId]
  );
  if (!u) return { current: 0, longest: 0, next_milestone: 7 };
  const current = u.checkin_streak_current || 0;
  const next = STREAK_MILESTONES.find(m => m.days > current);
  return {
    current,
    longest: u.checkin_streak_longest || 0,
    next_milestone: next ? next.days : null,
    next_milestone_reward: next ? next.templateName : null,
  };
}

module.exports = {
  generateMemberCode,
  ensureMemberCode,
  userByMemberCode,
  logPurchase,
  getPunchStats,
  processCheckinForStreak,
  getStreakStats,
  STREAK_MILESTONES,
};
