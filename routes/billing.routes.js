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

    // Coach tier is in soft-launch phase pending Strava/WHOOP partnership approval.
    // Block direct checkout to keep the friend launch focused on Rewards.
    // Owner (Casey) is already on Coach via OWNER100 — existing subscriptions unaffected.
    if (priceKey === 'coach_monthly' || priceKey === 'coach_annual') {
      return res.status(403).json({
        error: 'Coach tier is launching soon. Join the waitlist on the landing page and we\'ll notify you when it goes live.',
        coach_pending: true,
      });
    }

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
    const session = await stripeLib.getStripe().checkout.sessions.retrieve(session_id, {
      expand: ['subscription'],
    });
    const email = session.customer_details?.email || session.customer_email;
    let magicLinkSent = false;
    if (email) {
      try {
        await auth.requestMagicLink(email);
        magicLinkSent = true;
        console.log(`[billing/success] Magic link sent to ${email}`);
      } catch (linkErr) {
        console.error(`[billing/success] Magic link send FAILED for ${email}:`, linkErr.message, linkErr.stack);
      }
    }

    // Pull trial info from subscription if present
    let trialNote = '';
    const sub = session.subscription;
    if (sub && typeof sub === 'object' && sub.trial_end) {
      const trialEnd = new Date(sub.trial_end * 1000);
      const now = new Date();
      const daysLeft = Math.max(0, Math.round((trialEnd - now) / 86400000));
      const trialEndStr = trialEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      trialNote = `<p class="lede" style="background:var(--hi-vis);color:var(--ink);padding:10px 14px;margin-top:14px;font-size:0.88rem;font-weight:500">🎉 You're on a free trial — ${daysLeft} days free, first charge ${trialEndStr}.</p>`;
    }

    const successBody = magicLinkSent ? `
      <p class="lede">Your subscription is active. We just emailed a sign-in link to <span class="email-call">${email}</span>.</p>
      ${trialNote}
      <p class="lede" style="opacity:0.6;font-size:0.82rem">Tap the link in your inbox to access your dashboard and finish setup. The link expires in 15 minutes. Check spam if you don't see it.</p>
    ` : `
      <p class="lede">Your subscription is active. Sign in below to access your dashboard.</p>
      ${trialNote}
      <p class="lede" style="opacity:0.6;font-size:0.82rem">We had trouble emailing your sign-in link automatically. Click below to request one.</p>
    `;

    res.send(renderPage({
      title: 'Welcome',
      headline: magicLinkSent ? 'You\'re in.<br>Check your inbox.' : 'You\'re in.<br>Sign in below.',
      body: successBody,
      // Always show a fallback button — even if magic link was sent, the user might not receive it (spam, typo, etc).
      cta: magicLinkSent ? 'Didn\'t get the email? →' : 'Request sign-in link →',
      ctaUrl: '/login',
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
