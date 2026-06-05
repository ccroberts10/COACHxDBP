// lib/email.js
// Transactional email via Resend (https://resend.com)

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const db = require('../db/client');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'DBP Coach <coach@durangobikeproject.com>';
const REPLY_TO = process.env.REPLY_TO || 'ccroberts10@gmail.com';

async function sendEmail({ to, subject, html, template = 'unknown', userId = null }) {
  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set, logging email instead:');
    console.log({ to, subject, template });
    return { mock: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        html,
      }),
    });
    const data = await res.json();
    await db.query(
      `INSERT INTO notifications (user_id, channel, template, recipient, subject, payload, status)
       VALUES ($1, 'email', $2, $3, $4, $5, $6)`,
      [userId, template, to, subject, JSON.stringify({ resend_id: data.id, resend_response: data }), res.ok ? 'sent' : 'failed']
    );
    if (res.ok) {
      console.log(`[email] Sent ${template} to ${to} (resend_id=${data.id})`);
    } else {
      console.error(`[email] Send failed (status ${res.status}):`, JSON.stringify(data));
    }
    return data;
  } catch (e) {
    console.error('[email] Exception:', e.message, e.stack);
    throw e;
  }
}

// ===== Email templates =====

function wrap(content, ctaUrl = null, ctaLabel = null) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>DBP Coach</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
        <tr><td>
          <div style="font-size:14px;color:#888;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin-bottom:18px;">🚴 DBP Coach</div>
          ${content}
          ${ctaUrl ? `
          <!-- Bulletproof button: nested table renders correctly across all email clients (iOS Mail, Outlook, Gmail, Yahoo) -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 16px;">
            <tr>
              <td align="center" bgcolor="#000000" style="background-color:#000000;border-radius:8px;padding:14px 32px;">
                <a href="${ctaUrl}" target="_blank" style="display:inline-block;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-weight:700;font-size:16px;letter-spacing:0.02em;text-transform:uppercase;">${ctaLabel}</a>
              </td>
            </tr>
          </table>
          <!-- Fallback plain link: ensures users can sign in even if the button doesn't render -->
          <div style="margin:8px 0 4px;color:#666;font-size:13px;line-height:1.5;">Button not working? Copy and paste this link into your browser:</div>
          <div style="margin:4px 0 12px;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px;color:#0066cc;word-break:break-all;line-height:1.4;"><a href="${ctaUrl}" target="_blank" style="color:#0066cc;text-decoration:underline;">${ctaUrl}</a></div>
          ` : ''}
          <div style="border-top:1px solid #eee;margin-top:32px;padding-top:18px;color:#888;font-size:12px;line-height:1.5;">
            Durango Bike Project · 225 E 8th Ave, Durango, CO<br>
            Questions? Reply to this email.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendMagicLinkEmail(email, link, expiresMin) {
  const html = wrap(
    `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">Sign in to DBP Coach</h1>
     <p style="color:#444;font-size:15px;line-height:1.5;margin:0 0 8px;">Tap the <strong>Sign In</strong> button below. The link is good for ${expiresMin} minutes and can only be used once. If the button doesn't show, scroll down for a copy-paste link.</p>
     <p style="color:#888;font-size:13px;margin:14px 0 0;">If you didn't request this, you can safely ignore it.</p>`,
    link, 'Sign In'
  );
  return sendEmail({ to: email, subject: 'Your DBP Coach sign-in link', html, template: 'magic_link' });
}

async function sendWelcomeEmail(email, userName, tier = null) {
  let subject, body;
  if (tier === 'free') {
    subject = 'Welcome to DBP';
    body = `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">Welcome to DBP${userName ? ', ' + userName : ''}</h1>
     <p style="color:#444;font-size:15px;line-height:1.5;">You're in. Your free DBP account is active — show your member code at the shop to earn punches. Every 10th drink is free, plus we'll buy you a drink on your birthday.</p>
     <p style="color:#444;font-size:15px;line-height:1.5;margin-top:14px;">Want more? Upgrade anytime to <strong>Rewards</strong> ($19/mo) for a free Sunday recovery drink, 10% off retail, free flat repairs, and more — or <strong>Coach</strong> ($29/mo) for AI training plus all rewards.</p>
     <p style="color:#444;font-size:15px;line-height:1.5;margin-top:14px;">Questions? Reply to this email — it goes straight to Casey.</p>`;
  } else if (tier === 'rewards') {
    subject = 'Welcome to DBP Rewards';
    body = `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">Welcome to DBP Rewards${userName ? ', ' + userName : ''}</h1>
     <p style="color:#444;font-size:15px;line-height:1.5;">Your DBP Rewards membership is active. Show your member code at the shop to start earning. Free Sunday recovery drink (drip, or upgrade your latte for $2), 10% off retail, free flat repairs, and an annual tune-up are yours.</p>
     <p style="color:#444;font-size:15px;line-height:1.5;margin-top:14px;">Pop into 225 E 8th Ave whenever — see you soon.</p>
     <p style="color:#444;font-size:15px;line-height:1.5;margin-top:14px;">Questions? Reply to this email — it goes straight to Casey.</p>`;
  } else {
    // Coach tier (default)
    subject = 'Welcome to DBP Coach';
    body = `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">Welcome to DBP Coach${userName ? ', ' + userName : ''}</h1>
     <p style="color:#444;font-size:15px;line-height:1.5;">You're in. Let's get you set up — connect Strava (WHOOP optional), tell us a bit about your training, and your first AI prescription will be ready tomorrow at 6:30 AM.</p>
     <p style="color:#444;font-size:15px;line-height:1.5;margin-top:14px;">Plus all the DBP Rewards perks: free Sunday recovery drink, 10% off retail, free flat repairs, annual tune-up.</p>
     <p style="color:#444;font-size:15px;line-height:1.5;margin-top:14px;">Have a question? Reply to this email — it goes straight to Casey.</p>`;
  }
  const html = wrap(body, `${process.env.PUBLIC_URL}/onboarding`, 'Set up your account');
  return sendEmail({ to: email, subject, html, template: 'welcome' });
}

async function sendSundayDrinkEmail(email, userName, code, recoveryPct) {
  const recoveryNote = recoveryPct >= 67 ? "Recovery is high — treat yourself to a cortado or that espresso tonic."
    : recoveryPct >= 34 ? "Moderate recovery — a flat white or matcha is the move."
    : "Low recovery — herbal tea or a calm chai. Take it easy today.";
  const html = wrap(
    `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">☕ Sunday drink, on us</h1>
     <p style="color:#444;font-size:15px;line-height:1.5;">${recoveryNote}</p>
     <div style="background:#f5f5f5;border-radius:12px;padding:20px;margin:18px 0;text-align:center;">
       <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Show this code at the bar</div>
       <div style="font-size:36px;font-weight:700;letter-spacing:0.04em;font-family:monospace;color:#000;">${code}</div>
       <div style="font-size:12px;color:#888;margin-top:8px;">Valid today only · 9 AM – 4 PM</div>
     </div>
     <p style="color:#666;font-size:13px;line-height:1.5;">Free 12oz drip — or upgrade to any 12oz milk drink (latte, cappuccino, cortado, matcha, chai) for just $2.</p>
     <p style="color:#888;font-size:13px;line-height:1.5;margin-top:10px;">225 E 8th Ave, Durango. See you there.</p>`,
    `${process.env.PUBLIC_URL}/dashboard`, 'Open Coach'
  );
  return sendEmail({ to: email, subject: '☕ Your Sunday drink is on us', html, template: 'sunday_drink' });
}

async function sendBirthdayEmail(email, userName, code) {
  const html = wrap(
    `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">🎂 Happy birthday, ${userName || 'rider'}</h1>
     <p style="color:#444;font-size:15px;line-height:1.5;">Stop in this month for a free coffee on the house — your DBP family appreciates you.</p>
     <div style="background:#f5f5f5;border-radius:12px;padding:20px;margin:18px 0;text-align:center;">
       <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Birthday code</div>
       <div style="font-size:36px;font-weight:700;letter-spacing:0.04em;font-family:monospace;color:#000;">${code}</div>
       <div style="font-size:12px;color:#888;margin-top:8px;">Valid through end of month</div>
     </div>`,
    `${process.env.PUBLIC_URL}/dashboard`, 'Open Coach'
  );
  return sendEmail({ to: email, subject: `🎂 Birthday coffee on us`, html, template: 'birthday' });
}

async function sendServiceReminderEmail(email, userName, totalKm) {
  const html = wrap(
    `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">Time for a tune-up</h1>
     <p style="color:#444;font-size:15px;line-height:1.5;">Your bike has logged about ${Math.round(totalKm).toLocaleString()} km since your last tune-up. That's the typical service interval for cable, drivetrain, and brake check.</p>
     <p style="color:#444;font-size:15px;line-height:1.5;">As an Elite member, you get priority booking. Tap below to claim your slot.</p>`,
    `${process.env.PUBLIC_URL}/service/book`, 'Book service'
  );
  return sendEmail({ to: email, subject: 'Tune-up reminder · priority booking inside', html, template: 'service_reminder' });
}

async function sendCompetitionWinnerEmail(email, userName, compName, prize) {
  const html = wrap(
    `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">🏆 You won, ${userName || 'rider'}</h1>
     <p style="color:#444;font-size:15px;line-height:1.5;">First place in <strong>${compName}</strong>. Stop by DBP this week to claim your prize: ${prize}.</p>
     <p style="color:#444;font-size:15px;line-height:1.5;">We'll tag you on Instagram tonight. Thanks for showing up.</p>`,
    `${process.env.PUBLIC_URL}/dashboard`, 'Open Coach'
  );
  return sendEmail({ to: email, subject: `🏆 You won ${compName}`, html, template: 'competition_winner' });
}

// Issued via admin (one-off comp, manual gift, system trigger)
async function sendRewardIssuedEmail(email, userName, code, description, expiresAt, issuedBy) {
  const expiryLine = expiresAt
    ? `<div style="font-size:12px;color:#888;margin-top:8px;">Valid through ${new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div>`
    : `<div style="font-size:12px;color:#888;margin-top:8px;">No expiration</div>`;
  const fromLine = issuedBy && issuedBy !== 'system'
    ? `<p style="color:#444;font-size:14px;line-height:1.5;font-style:italic;">From ${issuedBy} at DBP.</p>`
    : '';
  const html = wrap(
    `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">🎁 You got a reward, ${userName || 'rider'}</h1>
     <p style="color:#444;font-size:15px;line-height:1.5;">${description}</p>
     ${fromLine}
     <div style="background:#F2E600;border-radius:0;padding:24px;margin:18px 0;text-align:center;border:2px solid #000;">
       <div style="font-size:11px;color:#000;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:8px;font-weight:600;">Show this code at DBP</div>
       <div style="font-size:36px;font-weight:800;letter-spacing:0.05em;font-family:monospace;color:#000;">${code}</div>
       ${expiryLine}
     </div>
     <p style="color:#666;font-size:13px;line-height:1.5;">225 E 8th Ave, Durango.</p>`,
    `${process.env.PUBLIC_URL}/dashboard`, 'Open in app'
  );
  return sendEmail({ to: email, subject: `🎁 ${description}`, html, template: 'reward_issued' });
}

// Broadcast to many users — accepts a custom message body
async function sendBroadcastEmail(email, userName, subject, headline, body, code, description, expiresAt) {
  const codeBlock = code ? `
     <div style="background:#F2E600;border-radius:0;padding:24px;margin:18px 0;text-align:center;border:2px solid #000;">
       <div style="font-size:11px;color:#000;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:8px;font-weight:600;">Show this code at DBP</div>
       <div style="font-size:36px;font-weight:800;letter-spacing:0.05em;font-family:monospace;color:#000;">${code}</div>
       <div style="font-size:13px;color:#000;margin-top:8px;">${description || ''}</div>
       ${expiresAt ? `<div style="font-size:12px;color:#444;margin-top:4px;">Valid through ${new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div>` : ''}
     </div>` : '';
  const html = wrap(
    `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">${headline}</h1>
     <p style="color:#444;font-size:15px;line-height:1.6;white-space:pre-wrap;">${body}</p>
     ${codeBlock}
     <p style="color:#666;font-size:13px;line-height:1.5;">225 E 8th Ave, Durango.</p>`,
    `${process.env.PUBLIC_URL}/dashboard`, 'Open in app'
  );
  return sendEmail({ to: email, subject, html, template: 'broadcast' });
}

async function sendDailyPrescriptionEmail(email, userName, prescription, recoveryPct) {
  const w = prescription.workout || {};
  const n = prescription.nutrition || {};
  const recCol = recoveryPct >= 67 ? '#16a34a' : recoveryPct >= 34 ? '#ca8a04' : '#dc2626';
  const html = wrap(
    `<div style="text-align:center;background:#f5f5f5;border-radius:12px;padding:22px;margin-bottom:18px;">
       <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.1em;">Recovery</div>
       <div style="font-size:48px;font-weight:700;color:${recCol};line-height:1;margin:6px 0;">${recoveryPct ?? '—'}<span style="font-size:18px;">%</span></div>
       <div style="font-size:14px;color:#444;">${prescription.headline || ''}</div>
     </div>

     <h2 style="font-size:14px;color:#888;text-transform:uppercase;letter-spacing:0.08em;margin:20px 0 8px;">Today's Workout · ${w.duration_min || '—'} min</h2>
     <div style="background:#f5f5f5;border-radius:12px;padding:16px;font-size:14px;color:#444;line-height:1.55;">
       ${w.intensity_zone ? `<div style="color:#666;font-size:12px;margin-bottom:8px;">🎯 ${w.intensity_zone}</div>` : ''}
       ${(w.specific_workout || '').replace(/\n/g, '<br>')}
       ${w.route_suggestion ? `<div style="margin-top:10px;color:#666;">📍 ${w.route_suggestion}</div>` : ''}
     </div>

     <h2 style="font-size:14px;color:#888;text-transform:uppercase;letter-spacing:0.08em;margin:20px 0 8px;">Nutrition</h2>
     <div style="background:#f5f5f5;border-radius:12px;padding:16px;font-size:14px;color:#444;line-height:1.55;">
       ${n.breakfast ? `<div><strong style="color:#000;">Breakfast:</strong> ${n.breakfast}</div>` : ''}
       ${n.lunch ? `<div style="margin-top:6px;"><strong style="color:#000;">Lunch:</strong> ${n.lunch}</div>` : ''}
       ${n.dinner ? `<div style="margin-top:6px;"><strong style="color:#000;">Dinner:</strong> ${n.dinner}</div>` : ''}
       ${n.supplements ? `<div style="margin-top:6px;"><strong style="color:#000;">Supps:</strong> ${n.supplements}</div>` : ''}
     </div>`,
    `${process.env.PUBLIC_URL}/dashboard`, 'Open in app'
  );
  return sendEmail({ to: email, subject: `🚴 Today's plan · ${prescription.headline || 'Coach'}`, html, template: 'daily_prescription' });
}

// Daily wake-up reminder for Coach users (replaces pre-generated daily prescription email)
// Generation happens on-demand when they tap the link
async function sendCoachReadyEmail(email, userName) {
  const html = wrap(
    `<h1 style="font-size:24px;color:#000;margin:0 0 12px;letter-spacing:-0.02em;">Good morning${userName ? ', ' + userName : ''} ☀️</h1>
     <p style="color:#444;font-size:15px;line-height:1.6;">Your DBP Coach is ready to build today's plan. Tap below to generate a fresh prescription tuned to your latest recovery, sleep, and training load.</p>
     <p style="color:#888;font-size:13px;line-height:1.5;margin-top:14px;">Coach will use whatever data is freshest — WHOOP recovery if you've already woken up and synced, or your daily check-in for inferred recovery.</p>`,
    `${process.env.PUBLIC_URL}/dashboard`, '☕ Generate today\'s plan'
  );
  return sendEmail({ to: email, subject: '☕ Coach is ready · DBP', html, template: 'daily_reminder' });
}

module.exports = {
  sendEmail,
  sendMagicLinkEmail,
  sendWelcomeEmail,
  sendSundayDrinkEmail,
  sendBirthdayEmail,
  sendServiceReminderEmail,
  sendCompetitionWinnerEmail,
  sendDailyPrescriptionEmail,
  sendCoachReadyEmail,
  sendRewardIssuedEmail,
  sendBroadcastEmail,
};
