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
  try {
    const session = await stripeLib.stripe.checkout.sessions.retrieve(session_id);
    const email = session.customer_details?.email || session.customer_email;
    if (email) await auth.requestMagicLink(email);
    res.send(`<!DOCTYPE html><html><head><title>Welcome to DBP Coach</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:-apple-system,sans-serif;background:#000;color:#e8e8e8;padding:40px 20px;text-align:center;margin:0}
      h1{font-size:1.6em}p{color:#aaa;line-height:1.6;max-width:480px;margin:14px auto}
      .check{font-size:3em;margin:20px 0}</style></head><body>
      <div class="check">✅</div>
      <h1>Welcome to DBP Coach</h1>
      <p>Your subscription is active. We just sent a sign-in link to <b>${email}</b>.</p>
      <p>Tap the link in your inbox to access your dashboard and finish setup.</p>
      </body></html>`);
  } catch (e) {
    res.send(`<p>Subscription confirmed. <a href="/login">Sign in</a> to continue.</p>`);
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
