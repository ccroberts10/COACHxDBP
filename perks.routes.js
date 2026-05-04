// routes/perks.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const db = require('../db/client');
const perks = require('../lib/perks');

// Leaderboards (any authed user can view)
router.get('/leaderboards', auth.requireAuthApi, async (req, res) => {
  try {
    const boards = await perks.getActiveLeaderboards();
    res.json({ boards });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// User's active perks (Elite tier)
router.get('/my-perks', auth.requireAuthApi, async (req, res) => {
  const rows = await db.many(
    `SELECT * FROM perk_redemptions
     WHERE user_id = $1 AND (redeemed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()))
     ORDER BY issued_at DESC`,
    [req.user.id]
  );
  res.json({ perks: rows });
});

// =====================================================
// BARISTA REDEMPTION — PIN-protected, separate from user auth
// =====================================================

// Look up a code (does NOT redeem yet)
router.post('/lookup', async (req, res) => {
  const { code, pin } = req.body;
  if (!code || !pin) return res.status(400).json({ error: 'code and pin required' });
  const staff = await verifyStaffPin(pin);
  if (!staff) return res.status(401).json({ error: 'Invalid PIN' });

  const perk = await db.one(
    `SELECT p.*, u.name as user_name
     FROM perk_redemptions p JOIN users u ON u.id = p.user_id
     WHERE p.code = $1`,
    [code.toUpperCase()]
  );
  if (!perk) return res.status(404).json({ error: 'Code not found' });
  res.json({
    code: perk.code,
    user_name: perk.user_name,
    perk_type: perk.perk_type,
    description: perk.description,
    redeemed: !!perk.redeemed_at,
    expired: perk.expires_at && new Date(perk.expires_at) < new Date(),
    expires_at: perk.expires_at,
  });
});

// Redeem a code
router.post('/redeem', async (req, res) => {
  const { code, pin, note } = req.body;
  if (!code || !pin) return res.status(400).json({ error: 'code and pin required' });
  const staff = await verifyStaffPin(pin);
  if (!staff) return res.status(401).json({ error: 'Invalid PIN' });

  const result = await perks.redeemCode(code, staff.staff_name, note);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

async function verifyStaffPin(pin) {
  // PINs stored as plain values for simplicity at MVP — in prod, hash them
  const staff = await db.one(`SELECT * FROM staff_pins WHERE pin = $1 AND active = TRUE`, [pin]);
  return staff || null;
}

module.exports = router;
