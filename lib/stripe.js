// lib/stripe.js
// Stripe billing — checkout, webhooks, subscription state sync

const Stripe = require('stripe');
const db = require('../db/client');
const { sendWelcomeEmail } = require('./email');

let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe Price IDs from env (set up in Stripe Dashboard)
// New tier structure: Rewards (rewards only), Coach (coach + rewards)
const PRICES = {
  rewards_monthly: process.env.STRIPE_PRICE_REWARDS_MONTHLY || process.env.STRIPE_PRICE_COACH_MONTHLY, // fallback for legacy
  rewards_annual: process.env.STRIPE_PRICE_REWARDS_ANNUAL || process.env.STRIPE_PRICE_COACH_ANNUAL,
  coach_monthly: process.env.STRIPE_PRICE_COACH_MONTHLY_NEW || process.env.STRIPE_PRICE_ELITE_MONTHLY,
  coach_annual: process.env.STRIPE_PRICE_COACH_ANNUAL_NEW || process.env.STRIPE_PRICE_ELITE_ANNUAL,
};

const TIER_FROM_PRICE = {
  [PRICES.rewards_monthly]: 'rewards',
  [PRICES.rewards_annual]: 'rewards',
  [PRICES.coach_monthly]: 'coach',
  [PRICES.coach_annual]: 'coach',
};

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7');

// Create a Stripe Checkout session for new signup
async function createCheckoutSession({ priceKey, email, userId = null }) {
  const priceId = PRICES[priceKey];
  if (!priceId) throw new Error(`Unknown price key: ${priceKey}`);

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: email,
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { user_id: userId || '', tier: TIER_FROM_PRICE[priceId] },
    },
    metadata: { user_id: userId || '', price_key: priceKey, tier: TIER_FROM_PRICE[priceId] },
    success_url: `${process.env.PUBLIC_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.PUBLIC_URL}/?canceled=1`,
    allow_promotion_codes: true,
  });
  return session;
}

// Create a Customer Portal session for billing management
async function createPortalSession(customerId, returnUrl) {
  return stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl || `${process.env.PUBLIC_URL}/settings`,
  });
}

// Verify webhook signature and parse event
function parseWebhookEvent(rawBody, sigHeader) {
  if (!WEBHOOK_SECRET) {
    console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set');
    return JSON.parse(rawBody);
  }
  return stripe().webhooks.constructEvent(rawBody, sigHeader, WEBHOOK_SECRET);
}

// ===== Webhook handlers =====

async function handleCheckoutCompleted(session) {
  const customerId = session.customer;
  const subscriptionId = session.subscription;
  const email = session.customer_email || session.customer_details?.email;
  const tier = session.metadata?.tier || 'coach';

  if (!email) {
    console.error('[stripe] checkout.completed missing email');
    return;
  }

  // Find or create user
  let user = await db.one(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
  if (!user) {
    user = await db.one(
      `INSERT INTO users (email, stripe_customer_id, stripe_subscription_id, subscription_tier, subscription_status)
       VALUES ($1, $2, $3, $4, 'trialing')
       RETURNING *`,
      [email.toLowerCase(), customerId, subscriptionId, tier]
    );
  } else {
    await db.query(
      `UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, subscription_tier = $3, subscription_status = 'trialing'
       WHERE id = $4`,
      [customerId, subscriptionId, tier, user.id]
    );
  }

  await sendWelcomeEmail(email, user.name);
  console.log('[stripe] Checkout complete:', email, tier);
}

async function handleSubscriptionUpdate(subscription) {
  const customerId = subscription.customer;
  const status = subscription.status; // 'trialing' | 'active' | 'past_due' | 'canceled' | etc.
  const priceId = subscription.items.data[0]?.price?.id;
  const tier = TIER_FROM_PRICE[priceId] || 'coach';
  const trialEndsAt = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
  const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;

  await db.query(
    `UPDATE users
     SET subscription_status = $1,
         subscription_tier = $2,
         stripe_subscription_id = $3,
         trial_ends_at = $4,
         current_period_end = $5
     WHERE stripe_customer_id = $6`,
    [status, tier, subscription.id, trialEndsAt, periodEnd, customerId]
  );
  console.log('[stripe] Subscription update:', customerId, status, tier);
}

async function handleSubscriptionDeleted(subscription) {
  await db.query(
    `UPDATE users SET subscription_status = 'canceled' WHERE stripe_customer_id = $1`,
    [subscription.customer]
  );
  console.log('[stripe] Subscription canceled:', subscription.customer);
}

async function handlePaymentFailed(invoice) {
  await db.query(
    `UPDATE users SET subscription_status = 'past_due' WHERE stripe_customer_id = $1`,
    [invoice.customer]
  );
  console.log('[stripe] Payment failed:', invoice.customer);
}

async function processWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdate(event.data.object);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object);
      break;
    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object);
      break;
    default:
      console.log('[stripe] Unhandled event:', event.type);
  }
}

module.exports = {
  getStripe: stripe,
  PRICES,
  createCheckoutSession,
  createPortalSession,
  parseWebhookEvent,
  processWebhookEvent,
};
