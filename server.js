// server.js
// DBP Coach — main Express entry point

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const path = require('path');
const db = require('./db/client');

const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'America/Denver';

const app = express();

// ===== Middleware =====
// IMPORTANT: Stripe webhook needs raw body BEFORE express.json() parses it
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), require('./routes/billing.routes').webhookHandler);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, 'static')));

// ===== Routes =====
app.use('/auth', require('./routes/auth.routes'));
app.use('/billing', require('./routes/billing.routes').router);
app.use('/onboarding', require('./routes/onboarding.routes'));
app.use('/api/perks', require('./routes/perks.routes'));
app.use('/api/waitlist', require('./routes/waitlist.routes'));
app.use('/api', require('./routes/api.routes'));
app.use('/', require('./routes/pages.routes'));

// 404
app.use((req, res) => {
  res.status(404).send('Not found. <a href="/">Home</a>');
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (req.headers.accept?.includes('json') || req.path.startsWith('/api')) {
    res.status(500).json({ error: err.message });
  } else {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// ===== Cron jobs =====

// Daily prescription pipeline: 6:30am MST for every active user
// 6:30 AM reminder — emails active Coach users that today's prescription is ready to generate
// (Generation happens on-demand when user opens app; this is just the wake-up trigger)
cron.schedule('30 6 * * *', async () => {
  const { sendDailyReminders } = require('./lib/pipeline');
  console.log('[cron] Daily reminder emails');
  try {
    await sendDailyReminders();
  } catch (e) {
    console.error('[cron] Daily reminder error:', e);
  }
}, { timezone: TZ });

// Sunday morning drinks: 8am MST every Sunday for Elite tier
cron.schedule('0 8 * * 0', async () => {
  const { issueSundayDrinks } = require('./lib/perks');
  console.log('[cron] Sunday drinks');
  try {
    await issueSundayDrinks();
  } catch (e) {
    console.error('[cron] Sunday drinks error:', e);
  }
}, { timezone: TZ });

// Birthday check: 9am MST daily — issue birthday perks to users whose birthday is today
cron.schedule('0 9 * * *', async () => {
  const { issueBirthdayPerks } = require('./lib/perks');
  console.log('[cron] Birthday check');
  try {
    await issueBirthdayPerks();
  } catch (e) {
    console.error('[cron] Birthday error:', e);
  }
}, { timezone: TZ });

// Service reminders: 10am MST daily — check km accumulation
cron.schedule('0 10 * * *', async () => {
  const { checkServiceReminders } = require('./lib/perks');
  console.log('[cron] Service reminders');
  try {
    await checkServiceReminders();
  } catch (e) {
    console.error('[cron] Service reminders error:', e);
  }
}, { timezone: TZ });

// Cleanup expired auth tokens / sessions: hourly
cron.schedule('0 * * * *', async () => {
  await db.query(`DELETE FROM auth_tokens WHERE expires_at < NOW() - INTERVAL '1 day'`);
  await db.query(`DELETE FROM sessions WHERE expires_at < NOW()`);
}, { timezone: TZ });

// Auto-trigger scanner: every 15 minutes — issue rewards for activities matching triggers
cron.schedule('*/15 * * * *', async () => {
  try {
    const autoTriggers = require('./lib/auto-triggers');
    await autoTriggers.processUnprocessedActivities();
  } catch (e) {
    console.error('[cron] auto-triggers error:', e);
  }
}, { timezone: TZ });

// ===== Boot =====
(async () => {
  try {
    await db.ensureSchema();
    app.listen(PORT, () => {
      console.log(`[server] DBP Coach running on port ${PORT}`);
      console.log(`[server] Public URL: ${process.env.PUBLIC_URL}`);
      console.log(`[server] Timezone: ${TZ}`);
    });
  } catch (e) {
    console.error('[server] Boot failed:', e);
    process.exit(1);
  }
})();
