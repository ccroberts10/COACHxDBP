// lib/auto-triggers.js
// Detects activity-based conditions (big ride, etc.) and issues rewards automatically.
// Called from cron every hour and after each pipeline run.

const db = require('../db/client');
const perks = require('./perks');

/**
 * Check if an activity matches the conditions of a "big_ride" trigger.
 * Conditions JSON shape:
 * {
 *   min_distance_km: 40,
 *   min_duration_min: null,
 *   min_elevation_m: null,
 *   min_suffer_score: null,
 *   activity_types: ['Ride', 'VirtualRide']
 * }
 */
function activityMatches(activity, conditions) {
  const c = conditions || {};
  // Activity type filter
  if (c.activity_types && c.activity_types.length > 0) {
    if (!c.activity_types.includes(activity.type)) return false;
  }
  // Distance threshold (meters → km)
  if (c.min_distance_km != null) {
    const km = (activity.distance_m || 0) / 1000;
    if (km < c.min_distance_km) return false;
  }
  // Duration (seconds → min)
  if (c.min_duration_min != null) {
    const min = (activity.duration_sec || 0) / 60;
    if (min < c.min_duration_min) return false;
  }
  // Elevation (m)
  if (c.min_elevation_m != null) {
    if ((activity.elevation_gain_m || 0) < c.min_elevation_m) return false;
  }
  // Suffer score
  if (c.min_suffer_score != null) {
    if ((activity.suffer_score || 0) < c.min_suffer_score) return false;
  }
  return true;
}

/**
 * Audience filter for a user — does this user qualify for this trigger?
 */
function audienceMatches(user, audience) {
  // Subscription must be active
  if (!['active', 'trialing'].includes(user.subscription_status)) return false;
  if (audience === 'all') return true;
  if (audience === 'paying') return ['rewards', 'coach'].includes(user.subscription_tier);
  if (audience === 'coach') return user.subscription_tier === 'coach';
  if (audience === 'rewards') return user.subscription_tier === 'rewards';
  // Legacy aliases
  if (audience === 'elite') return user.subscription_tier === 'coach';
  return false;
}

/**
 * Check if user is in cooldown for this trigger.
 */
async function inCooldown(userId, triggerId, cooldownHours) {
  if (!cooldownHours || cooldownHours <= 0) return false;
  const recent = await db.one(
    `SELECT fired_at FROM trigger_firings
     WHERE user_id = $1 AND trigger_id = $2
       AND fired_at > NOW() - ($3 || ' hours')::interval
     ORDER BY fired_at DESC LIMIT 1`,
    [userId, triggerId, cooldownHours]
  );
  return !!recent;
}

/**
 * Process a single activity against all active 'big_ride' triggers.
 * Returns array of issued rewards.
 */
async function processActivityForTriggers(activity) {
  const issued = [];

  // Get the activity's user
  const user = await db.one(
    `SELECT id, name, email, subscription_tier, subscription_status FROM users WHERE id = $1`,
    [activity.user_id]
  );
  if (!user) return issued;

  // Get all active big_ride triggers
  const triggers = await db.many(
    `SELECT t.*, pt.name as template_name, pt.description as template_description
     FROM auto_triggers t
     LEFT JOIN perk_templates pt ON pt.id = t.template_id
     WHERE t.active = TRUE AND t.trigger_type = 'big_ride'`
  );

  for (const trigger of triggers) {
    if (!audienceMatches(user, trigger.audience)) continue;
    if (!activityMatches(activity, trigger.conditions)) continue;
    if (await inCooldown(user.id, trigger.id, trigger.cooldown_hours)) continue;

    // Fire the trigger: issue reward + email + log
    try {
      const result = await perks.issuePerkFromTemplate({
        userId: user.id,
        templateId: trigger.template_id,
        triggerType: 'big_ride',
        issuedBy: 'system',
        expiresInDays: trigger.expires_in_days,
        customDescription: trigger.template_description,
        bypassCaps: true, // earned via auto-trigger; not subject to manual caps
      });

      // Log the firing
      const firing = await db.one(
        `INSERT INTO trigger_firings (trigger_id, user_id, activity_id, perk_redemption_id)
         VALUES ($1, $2, $3, (SELECT id FROM perk_redemptions WHERE code = $4))
         RETURNING id`,
        [trigger.id, user.id, activity.id, result.code]
      );

      // Send email
      try {
        const { sendBroadcastEmail } = require('./email');
        const subject = trigger.message_subject || `🎁 ${result.description}`;
        const headline = trigger.message_subject || 'Recovery on us';
        const distanceKm = ((activity.distance_m || 0) / 1000).toFixed(1);
        const body = trigger.message_body ||
          `That looked brutal — ${distanceKm}km, ${Math.round((activity.duration_sec||0)/60)} min. Recovery latte on us, today only.`;
        await sendBroadcastEmail(
          user.email, user.name, subject, headline, body,
          result.code, result.description, result.expires_at
        );
      } catch (e) {
        console.error('[auto-triggers] email failed:', e.message);
      }

      issued.push({ trigger: trigger.name, code: result.code, user: user.email });
      console.log(`[auto-triggers] FIRED ${trigger.name} → ${user.email} → ${result.code}`);
    } catch (e) {
      console.error(`[auto-triggers] failed to fire ${trigger.name} for ${user.email}:`, e.message);
    }
  }

  // Mark activity processed
  await db.query(
    `UPDATE activities SET triggers_processed_at = NOW() WHERE user_id = $1 AND id = $2`,
    [activity.user_id, activity.id]
  );

  return issued;
}

/**
 * Hourly cron entry: scan for unprocessed activities and run triggers.
 * Called by server cron.
 */
async function processUnprocessedActivities() {
  const activities = await db.many(
    `SELECT * FROM activities
     WHERE triggers_processed_at IS NULL
       AND created_at > NOW() - interval '24 hours'
     ORDER BY created_at DESC
     LIMIT 200`
  );

  let totalIssued = 0;
  for (const activity of activities) {
    try {
      const issued = await processActivityForTriggers(activity);
      totalIssued += issued.length;
    } catch (e) {
      console.error(`[auto-triggers] activity ${activity.id} failed:`, e.message);
      // Mark as processed even on error so we don't retry forever
      await db.query(
        `UPDATE activities SET triggers_processed_at = NOW() WHERE user_id = $1 AND id = $2`,
        [activity.user_id, activity.id]
      );
    }
  }

  if (activities.length > 0) {
    console.log(`[auto-triggers] processed ${activities.length} activities, issued ${totalIssued} rewards`);
  }
  return { activities_processed: activities.length, rewards_issued: totalIssued };
}

module.exports = {
  activityMatches,
  audienceMatches,
  inCooldown,
  processActivityForTriggers,
  processUnprocessedActivities,
};
