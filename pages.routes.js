// routes/pages.routes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const auth = require('../lib/auth');
const whoop = require('../lib/whoop');
const strava = require('../lib/strava');
const db = require('../db/client');

const VIEWS = path.join(__dirname, '..', 'views');
function send(res, file) {
  return res.sendFile(path.join(VIEWS, file));
}

// Public landing page
router.get('/', (req, res) => {
  // If logged in with active sub, send to dashboard
  if (req.cookies?.session) {
    return auth.getUserFromSession(req.cookies.session).then(user => {
      if (user && (user.subscription_status === 'active' || user.subscription_status === 'trialing')) {
        return res.redirect(user.onboarding_completed ? '/dashboard' : '/onboarding');
      }
      return send(res, 'landing.html');
    }).catch(() => send(res, 'landing.html'));
  }
  send(res, 'landing.html');
});

router.get('/login', (req, res) => send(res, 'login.html'));
router.get('/privacy', (req, res) => send(res, 'privacy.html'));
router.get('/terms', (req, res) => send(res, 'terms.html'));

// Authed pages
router.get('/onboarding', auth.requireAuth, (req, res) => send(res, 'onboarding.html'));
router.get('/dashboard', auth.requireAuth, (req, res) => {
  if (!req.user.onboarding_completed) return res.redirect('/onboarding');
  if (req.user.subscription_status !== 'active' && req.user.subscription_status !== 'trialing') {
    return res.redirect('/');
  }
  send(res, 'dashboard.html');
});
router.get('/settings', auth.requireAuth, (req, res) => send(res, 'settings.html'));
router.get('/barista', (req, res) => send(res, 'barista.html'));

// =====================================================
// OAuth callbacks for integrations
// =====================================================

router.get('/integrations/whoop/connect', auth.requireAuth, (req, res) => {
  res.redirect(whoop.authUrl(req.user.id));
});

router.get('/integrations/whoop/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) throw new Error(error);
    if (!code || !state) throw new Error('Missing code or state');
    const userId = state.split('.')[0];
    if (!userId) throw new Error('Invalid state');
    // Verify session matches user (security: prevent CSRF / token theft)
    const sessionToken = req.cookies?.session;
    const sessionUser = await auth.getUserFromSession(sessionToken);
    if (!sessionUser || sessionUser.id !== userId) throw new Error('Session mismatch');

    const tokens = await whoop.exchangeCode(code);
    await whoop.saveTokens(userId, tokens);
    res.redirect(req.user?.onboarding_completed ? '/settings?whoop=ok' : '/onboarding?step=integrations&whoop=ok');
  } catch (e) {
    console.error('[whoop callback]', e);
    res.status(400).send(`<p>WHOOP connection failed: ${e.message}. <a href="/onboarding">Try again</a></p>`);
  }
});

router.get('/integrations/strava/connect', auth.requireAuth, (req, res) => {
  res.redirect(strava.authUrl(req.user.id));
});

router.get('/integrations/strava/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) throw new Error(error);
    if (!code || !state) throw new Error('Missing code or state');
    const userId = state;
    const sessionToken = req.cookies?.session;
    const sessionUser = await auth.getUserFromSession(sessionToken);
    if (!sessionUser || sessionUser.id !== userId) throw new Error('Session mismatch');

    const tokens = await strava.exchangeCode(code);
    await strava.saveTokens(userId, tokens);
    res.redirect(req.user?.onboarding_completed ? '/settings?strava=ok' : '/onboarding?step=integrations&strava=ok');
  } catch (e) {
    console.error('[strava callback]', e);
    res.status(400).send(`<p>Strava connection failed: ${e.message}. <a href="/onboarding">Try again</a></p>`);
  }
});

module.exports = router;
