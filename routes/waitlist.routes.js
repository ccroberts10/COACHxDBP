// routes/waitlist.routes.js
// Coach waitlist for soft launch period — collects emails while Strava/WHOOP
// partnerships pend review. We notify these emails when Coach launches.
const express = require('express');
const router = express.Router();
const db = require('../db/client');

router.post('/coach', async (req, res) => {
  try {
    const rawEmail = (req.body?.email || '').trim().toLowerCase();
    if (!rawEmail || !rawEmail.includes('@') || rawEmail.length > 200) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    // Idempotent insert — if email already on list, that's fine
    await db.query(
      `INSERT INTO coach_waitlist (email, source) VALUES ($1, 'landing')
       ON CONFLICT (email) DO NOTHING`,
      [rawEmail]
    );
    console.log(`[waitlist] coach waitlist signup: ${rawEmail}`);
    res.json({ success: true, email: rawEmail });
  } catch (e) {
    console.error('[waitlist] error:', e.message);
    res.status(500).json({ error: 'Could not join waitlist. Try again.' });
  }
});

module.exports = router;
