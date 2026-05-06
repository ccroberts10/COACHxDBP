// routes/perks.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const db = require('../db/client');
const perks = require('../lib/perks');

// =====================================================
// MEMBER-FACING — requires user auth
// =====================================================

router.get('/leaderboards', auth.requireAuthApi, async (req, res) => {
  try {
    const boards = await perks.getActiveLeaderboards();
    res.json({ boards });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/my-perks', auth.requireAuthApi, async (req, res) => {
  const rows = await db.many(
    `SELECT * FROM perk_redemptions
     WHERE user_id = $1 AND (redeemed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()))
     ORDER BY issued_at DESC`,
    [req.user.id]
  );
  res.json({ perks: rows });
});

router.get('/my-savings', auth.requireAuthApi, async (req, res) => {
  try {
    const stats = await perks.getMemberSavings(req.user.id);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================
// STAFF AUTH HELPER
// =====================================================

async function verifyStaffPin(pin, requiredRole = null) {
  const staff = await db.one(`SELECT * FROM staff_pins WHERE pin = $1 AND active = TRUE`, [pin]);
  if (!staff) return null;
  if (requiredRole && (staff.role || '').toLowerCase() !== requiredRole.toLowerCase()) return null;
  return staff;
}

// =====================================================
// BARISTA — PIN-protected redemption
// =====================================================

router.post('/lookup', async (req, res) => {
  const { code, pin } = req.body;
  if (!code || !pin) return res.status(400).json({ error: 'code and pin required' });
  const staff = await verifyStaffPin(pin);
  if (!staff) return res.status(401).json({ error: 'Invalid PIN' });

  const perk = await db.one(
    `SELECT p.*, u.name as user_name, t.is_percentage, t.percentage_off, t.name as template_name, t.category as template_category
     FROM perk_redemptions p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN perk_templates t ON t.id = p.template_id
     WHERE p.code = $1`,
    [code.toUpperCase()]
  );
  if (!perk) return res.status(404).json({ error: 'Code not found' });
  res.json({
    code: perk.code,
    user_name: perk.user_name,
    perk_type: perk.perk_type,
    description: perk.description,
    template_name: perk.template_name,
    template_category: perk.template_category,
    is_percentage: !!perk.is_percentage,
    percentage_off: perk.percentage_off,
    expected_savings_cents: perk.savings_cents,
    redeemed: !!perk.redeemed_at,
    expired: perk.expires_at && new Date(perk.expires_at) < new Date(),
    expires_at: perk.expires_at,
  });
});

router.post('/redeem', async (req, res) => {
  const { code, pin, note, subtotal_cents } = req.body;
  if (!code || !pin) return res.status(400).json({ error: 'code and pin required' });
  const staff = await verifyStaffPin(pin);
  if (!staff) return res.status(401).json({ error: 'Invalid PIN' });

  const result = await perks.redeemCode(code, staff.staff_name, { note, subtotalCents: subtotal_cents });
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// =====================================================
// ADMIN — manager PIN required
// =====================================================

router.post('/admin/templates', async (req, res) => {
  const { pin } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });
  const templates = await db.many(
    `SELECT * FROM perk_templates WHERE active = TRUE ORDER BY sort_order, name`
  );
  res.json({ templates });
});

router.post('/admin/issue', async (req, res) => {
  const { pin, user_email, template_id, expires_in_days, custom_description } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });
  if (!user_email || !template_id) return res.status(400).json({ error: 'user_email and template_id required' });

  const user = await db.one(`SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1)`, [user_email]);
  if (!user) return res.status(404).json({ error: 'User not found with that email' });

  try {
    const result = await perks.issuePerkFromTemplate({
      userId: user.id,
      templateId: template_id,
      triggerType: 'manual',
      issuedBy: staff.staff_name,
      expiresInDays: expires_in_days,
      customDescription: custom_description,
    });

    // Send email notification (non-fatal if it fails)
    try {
      const { sendRewardIssuedEmail } = require('../lib/email');
      await sendRewardIssuedEmail(
        user.email, user.name, result.code, result.description, result.expires_at, staff.staff_name
      );
    } catch (e) {
      console.error('[admin/issue] email failed (non-fatal):', e.message);
    }

    res.json({ success: true, ...result, user: { name: user.name, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/search-users', async (req, res) => {
  const { pin, query } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });
  if (!query || query.length < 2) return res.json({ users: [] });

  const users = await db.many(
    `SELECT id, name, email, subscription_tier, subscription_status
     FROM users
     WHERE LOWER(email) LIKE LOWER($1) OR LOWER(name) LIKE LOWER($1)
     ORDER BY created_at DESC
     LIMIT 20`,
    [`%${query}%`]
  );
  res.json({ users });
});

router.post('/admin/recent-redemptions', async (req, res) => {
  const { pin, limit = 50 } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });

  const rows = await db.many(
    `SELECT p.id, p.code, p.description, p.issued_at, p.redeemed_at, p.expires_at,
            p.savings_cents, p.cost_cents, p.trigger_type, p.issued_by, p.redeemed_by_staff,
            u.name as user_name, u.email as user_email,
            t.name as template_name
     FROM perk_redemptions p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN perk_templates t ON t.id = p.template_id
     ORDER BY p.issued_at DESC
     LIMIT $1`,
    [limit]
  );
  res.json({ redemptions: rows });
});

// Preview broadcast audience
router.post('/admin/broadcast/audience', async (req, res) => {
  const { pin, audience } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });

  let where = `subscription_status IN ('active', 'trialing') AND onboarding_completed = TRUE`;
  if (audience === 'coach') where += ` AND subscription_tier = 'coach'`;
  if (audience === 'rewards') where += ` AND subscription_tier = 'rewards'`;
  if (audience === 'paying') where += ` AND subscription_tier IN ('rewards', 'coach')`;

  const rows = await db.many(
    `SELECT id, name, email, subscription_tier FROM users WHERE ${where} ORDER BY created_at DESC LIMIT 200`
  );
  const total = await db.one(`SELECT COUNT(*) as count FROM users WHERE ${where}`);
  res.json({ users: rows, total: parseInt(total.count) });
});

// Send broadcast: optionally issue a reward to all matching users + email them
router.post('/admin/broadcast/send', async (req, res) => {
  const { pin, audience, template_id, expires_in_days, subject, headline, body, send_email } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });
  if (!subject || !headline || !body) return res.status(400).json({ error: 'subject, headline, and body required' });

  let where = `subscription_status IN ('active', 'trialing') AND onboarding_completed = TRUE`;
  if (audience === 'coach') where += ` AND subscription_tier = 'coach'`;
  if (audience === 'rewards') where += ` AND subscription_tier = 'rewards'`;
  if (audience === 'paying') where += ` AND subscription_tier IN ('rewards', 'coach')`;

  const recipients = await db.many(`SELECT id, name, email FROM users WHERE ${where}`);
  if (recipients.length === 0) return res.status(400).json({ error: 'No recipients match this audience' });

  const { sendBroadcastEmail } = require('../lib/email');
  let issued = 0, emailed = 0, errors = [];

  for (const user of recipients) {
    let perkResult = null;
    try {
      if (template_id) {
        perkResult = await perks.issuePerkFromTemplate({
          userId: user.id,
          templateId: template_id,
          triggerType: 'broadcast',
          issuedBy: staff.staff_name,
          expiresInDays: expires_in_days,
        });
        issued++;
      }
      if (send_email !== false) {
        await sendBroadcastEmail(
          user.email, user.name, subject, headline, body,
          perkResult?.code, perkResult?.description, perkResult?.expires_at
        );
        emailed++;
      }
    } catch (e) {
      errors.push({ email: user.email, error: e.message });
    }
  }

  res.json({
    success: true,
    recipients_total: recipients.length,
    rewards_issued: issued,
    emails_sent: emailed,
    error_count: errors.length,
    errors: errors.slice(0, 10),
  });
});

router.post('/admin/analytics', async (req, res) => {
  const { pin } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });

  const overview = await perks.getAdminAnalytics();

  // Top members by savings this month
  const topMembers = await db.many(
    `SELECT u.id, u.name, u.email, u.subscription_tier,
            COALESCE(SUM(p.savings_cents), 0) as savings_cents,
            COUNT(p.id) as redemption_count
     FROM users u
     LEFT JOIN perk_redemptions p ON p.user_id = u.id
       AND p.redeemed_at >= date_trunc('month', NOW())
     GROUP BY u.id, u.name, u.email, u.subscription_tier
     HAVING COALESCE(SUM(p.savings_cents), 0) > 0
     ORDER BY savings_cents DESC
     LIMIT 20`
  );

  // Breakdown by category this month
  const byCategory = await db.many(
    `SELECT t.category,
            COUNT(p.id) as count,
            COALESCE(SUM(p.savings_cents), 0) as savings_cents,
            COALESCE(SUM(p.cost_cents), 0) as cost_cents
     FROM perk_redemptions p
     LEFT JOIN perk_templates t ON t.id = p.template_id
     WHERE p.redeemed_at >= date_trunc('month', NOW())
     GROUP BY t.category
     ORDER BY savings_cents DESC`
  );

  res.json({ overview, top_members: topMembers, by_category: byCategory });
});

// =====================================================
// PURCHASE LOGGING — barista logs each purchase by member code
// =====================================================

router.post('/purchase/lookup-member', async (req, res) => {
  const { code, pin } = req.body;
  if (!code || !pin) return res.status(400).json({ error: 'code and pin required' });
  const staff = await verifyStaffPin(pin);
  if (!staff) return res.status(401).json({ error: 'Invalid PIN' });

  const memberRewards = require('../lib/member-rewards');
  const user = await memberRewards.userByMemberCode(code);
  if (!user) return res.status(404).json({ error: 'Member code not found' });

  const punch = await memberRewards.getPunchStats(user.id);
  const streak = await memberRewards.getStreakStats(user.id);
  // Active rewards
  const activePerks = await db.many(
    `SELECT code, description, expires_at FROM perk_redemptions
     WHERE user_id = $1 AND redeemed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY issued_at DESC`,
    [user.id]
  );

  res.json({
    member_code: user.member_code,
    user_name: user.name,
    user_id: user.id,
    tier: user.subscription_tier,
    punch,
    streak,
    active_rewards: activePerks,
  });
});

router.post('/purchase/log', async (req, res) => {
  const { code, pin, category, subcategory, amount_dollars, notes } = req.body;
  if (!code || !pin || !category) return res.status(400).json({ error: 'code, pin, and category required' });
  const staff = await verifyStaffPin(pin);
  if (!staff) return res.status(401).json({ error: 'Invalid PIN' });

  const memberRewards = require('../lib/member-rewards');
  const user = await memberRewards.userByMemberCode(code);
  if (!user) return res.status(404).json({ error: 'Member code not found' });

  const amountCents = Math.round((parseFloat(amount_dollars) || 0) * 100);
  const result = await memberRewards.logPurchase({
    userId: user.id,
    category,
    subcategory: subcategory || null,
    amountCents,
    staffName: staff.staff_name,
    notes: notes || null,
  });

  res.json({ success: true, ...result });
});

router.post('/admin/triggers/list', async (req, res) => {
  const { pin } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });

  const triggers = await db.many(
    `SELECT t.*, pt.name as template_name, pt.category as template_category,
            pt.default_retail_cents as template_value_cents,
            (SELECT COUNT(*) FROM trigger_firings WHERE trigger_id = t.id) as fire_count,
            (SELECT MAX(fired_at) FROM trigger_firings WHERE trigger_id = t.id) as last_fired_at
     FROM auto_triggers t
     LEFT JOIN perk_templates pt ON pt.id = t.template_id
     ORDER BY t.active DESC, t.created_at DESC`
  );
  res.json({ triggers });
});

router.post('/admin/triggers/create', async (req, res) => {
  const { pin, name, trigger_type, template_id, conditions, audience, message_subject, message_body, cooldown_hours, expires_in_days } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });
  if (!name || !trigger_type || !template_id) return res.status(400).json({ error: 'name, trigger_type, template_id required' });

  const result = await db.one(
    `INSERT INTO auto_triggers (name, trigger_type, template_id, conditions, audience, message_subject, message_body, cooldown_hours, expires_in_days, created_by, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
     RETURNING *`,
    [name, trigger_type, template_id, conditions || {}, audience || 'paying',
     message_subject || null, message_body || null,
     cooldown_hours != null ? cooldown_hours : 24,
     expires_in_days != null ? expires_in_days : 1,
     staff.staff_name]
  );
  res.json({ success: true, trigger: result });
});

router.post('/admin/triggers/toggle', async (req, res) => {
  const { pin, trigger_id, active } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });

  await db.query(`UPDATE auto_triggers SET active = $1 WHERE id = $2`, [active, trigger_id]);
  res.json({ success: true });
});

router.post('/admin/triggers/delete', async (req, res) => {
  const { pin, trigger_id } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });

  await db.query(`DELETE FROM auto_triggers WHERE id = $1`, [trigger_id]);
  res.json({ success: true });
});

// Manual trigger run (for testing / catching up)
router.post('/admin/triggers/run-now', async (req, res) => {
  const { pin } = req.body;
  const staff = await verifyStaffPin(pin, 'manager');
  if (!staff) return res.status(401).json({ error: 'Manager PIN required' });

  const autoTriggers = require('../lib/auto-triggers');
  const result = await autoTriggers.processUnprocessedActivities();
  res.json({ success: true, ...result });
});

module.exports = router;
