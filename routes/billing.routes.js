// routes/billing.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const stripeLib = require('../lib/stripe');
const db = require('../db/client');

// Start checkout (anyone can hit this, even logged-out)
router.post('/checkout', async (req, res) => {
  try {
    const { priceKey, email } = req.body;
    if (!priceKey || !email) return res.status(400).json({ error: 'priceKey and email required' });
    const session = await stripeLib.createCheckoutSession({ priceKey, email });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[billing] checkout error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Success page after Stripe checkout - sends magic link to log them in
router.get('/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.redirect('/');

  // Shared style/header used by both success and fallback states
  const renderPage = ({ title, headline, body, cta, ctaUrl }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — DBP Coach</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,700;12..96,800&display=swap" rel="stylesheet">
<style>
:root {
  --ink: #0A0A0A; --paper: #FAFAF7; --bone: #EFEDE5; --hi-vis: #F2E600;
  --line: rgba(10,10,10,0.10); --muted: rgba(10,10,10,0.55);
  --maxi-round: 'Bricolage Grotesque', system-ui, sans-serif;
  --maxi-mono: 'DM Mono', monospace;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: var(--bone); color: var(--ink); font-family: var(--maxi-mono); font-size: 15px; line-height: 1.5; min-height: 100vh; }
.container { max-width: 540px; margin: 0 auto; padding: 28px 24px 60px; }
.nav { padding-bottom: 18px; border-bottom: 1px solid rgba(10,10,10,0.2); margin-bottom: 40px; }
.brand { font-family: var(--maxi-round); font-weight: 800; font-size: 1.3rem; letter-spacing: -0.03em; text-transform: uppercase; line-height: 1; }
.brand .accent { background: var(--hi-vis); padding: 0 6px; }
.section-tag { font-family: var(--maxi-mono); font-size: 0.62rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin-bottom: 18px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.section-tag .num { color: var(--muted); margin-right: 8px; }
.hero { background: var(--ink); color: var(--paper); padding: 36px 28px; margin-bottom: 22px; }
.check-mark { display: inline-block; background: var(--hi-vis); color: var(--ink); font-family: var(--maxi-round); font-weight: 800; font-size: 1.8rem; padding: 4px 14px; line-height: 1; margin-bottom: 16px; }
h1 { font-family: var(--maxi-round); font-weight: 800; font-size: clamp(1.8rem, 5vw, 2.6rem); letter-spacing: -0.03em; text-transform: uppercase; line-height: 0.95; margin-bottom: 12px; }
.lede { font-family: var(--maxi-mono); font-size: 0.95rem; line-height: 1.6; color: rgba(250,250,247,0.78); margin-bottom: 6px; }
.email-call { background: var(--hi-vis); color: var(--ink); padding: 2px 8px; font-weight: 600; }
.next-card { background: var(--paper); border: 1px solid rgba(10,10,10,0.2); padding: 24px 24px; margin-bottom: 14px; }
.next-card h2 { font-family: var(--maxi-round); font-weight: 700; font-size: 1.05rem; letter-spacing: -0.01em; text-transform: uppercase; margin-bottom: 10px; }
.next-card p { font-family: var(--maxi-mono); font-size: 0.86rem; color: var(--muted); line-height: 1.6; margin-bottom: 8px; }
ol { margin-left: 18px; padding: 0; }
ol li { font-family: var(--maxi-mono); font-size: 0.86rem; padding: 6px 0; color: var(--muted); }
ol li strong { color: var(--ink); font-weight: 500; }
.btn { display: inline-block; padding: 14px 26px; background: var(--ink); color: var(--paper); border: 1px solid var(--ink); font-family: var(--maxi-mono); font-size: 0.78rem; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 500; text-decoration: none; margin-top: 10px; }
.btn-primary { background: var(--hi-vis); color: var(--ink); }
.footer { margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--line); font-family: var(--maxi-mono); font-size: 0.7rem; color: var(--muted); letter-spacing: 0.05em; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <div class="nav">
    <div class="brand">DBP <span class="accent">COACH</span></div>
  </div>
  <div class="section-tag"><span class="num">01</span>WELCOME</div>
  <div class="hero">
    <div class="check-mark">✓ ACTIVE</div>
    <h1>${headline}</h1>
    ${body}
  </div>
  ${cta ? `<a class="btn btn-primary" href="${ctaUrl}">${cta}</a>` : ''}
  <div class="footer">DBP COACH · 225 E 8TH AVE · DURANGO, CO 81301</div>
</div>
</body>
</html>`;

  try {
    const session = await stripeLib.getStripe().checkout.sessions.retrieve(session_id);
    const email = session.customer_details?.email || session.customer_email;
    if (email) await auth.requestMagicLink(email);

    const successBody = `
      <p class="lede">Your subscription is active. We just emailed a sign-in link to <span class="email-call">${email || 'your inbox'}</span>.</p>
      <p class="lede" style="opacity:0.6;font-size:0.82rem">Tap the link in your inbox to access your dashboard and finish setup. The link expires in 15 minutes.</p>
    `;

    res.send(renderPage({
      title: 'Welcome',
      headline: 'You\'re in.<br>Check your inbox.',
      body: successBody,
      cta: null,
      ctaUrl: null,
    }));
  } catch (e) {
    console.error('[billing/success] Stripe session lookup failed:', e.message);
    const fallbackBody = `
      <p class="lede">Your subscription is confirmed. To access your dashboard, sign in with your email.</p>
      <p class="lede" style="opacity:0.6;font-size:0.82rem">If you don't receive a sign-in email, check your spam folder or try requesting another link from the sign-in page.</p>
    `;
    res.send(renderPage({
      title: 'Subscription Confirmed',
      headline: 'Subscription<br>confirmed.',
      body: fallbackBody,
      cta: 'Sign in →',
      ctaUrl: '/login',
    }));
  }
});

// Customer portal (manage billing) — requires auth
router.get('/portal', auth.requireAuth, async (req, res) => {
  try {
    if (!req.user.stripe_customer_id) return res.redirect('/');
    const session = await stripeLib.createPortalSession(req.user.stripe_customer_id);
    res.redirect(session.url);
  } catch (e) {
    res.status(500).send(`Portal error: ${e.message}`);
  }
});

// Stripe webhook - mounted with raw body parser in server.js, so this is exported separately
async function webhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripeLib.parseWebhookEvent(req.body, sig);
  } catch (e) {
    console.error('[stripe webhook] sig verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  try {
    await stripeLib.processWebhookEvent(event);
    res.json({ received: true });
  } catch (e) {
    console.error('[stripe webhook] handler error:', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { router, webhookHandler };
