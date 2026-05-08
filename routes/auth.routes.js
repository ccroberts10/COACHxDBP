// routes/auth.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');

router.post('/request', async (req, res) => {
  try {
    const { email, name } = req.body;
    const result = await auth.requestMagicLink(email, { name });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Free-tier signup — creates account with tier='free' (no Stripe)
router.post('/signup-free', async (req, res) => {
  try {
    const { email, name } = req.body;
    const result = await auth.requestMagicLink(email, { name, tier: 'free' });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;
    const { sessionToken } = await auth.verifyMagicLink(token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    auth.setSessionCookie(res, sessionToken);
    res.redirect('/dashboard');
  } catch (e) {
    res.status(400).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Sign-in link error</h2><p>${e.message}</p><p><a href="/login">Try again</a></p></body></html>`);
  }
});

router.post('/logout', async (req, res) => {
  const sessionToken = req.cookies?.session;
  if (sessionToken) await auth.destroySession(sessionToken);
  res.clearCookie('session');
  res.redirect('/');
});

router.get('/logout', async (req, res) => {
  const sessionToken = req.cookies?.session;
  if (sessionToken) await auth.destroySession(sessionToken);
  res.clearCookie('session');
  res.redirect('/');
});

module.exports = router;
