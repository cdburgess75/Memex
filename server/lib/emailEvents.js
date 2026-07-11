'use strict';
// Per-event email gating. Each notification event can send an email in addition
// to the in-app bell, controlled by an admin toggle (Settings → System → Email →
// Email notifications). Sending is best-effort and never throws.
const settings = require('./settings');
const email = require('./email');

// Sensible defaults when the admin hasn't set a toggle yet: notify recipients of
// things aimed AT them; keep the noisy "document edited" (Office autosaves a lot)
// off by default.
const DEFAULTS = {
  share_granted: true,
  share_downloaded: true,
  upload_received: true,
  document_edited: false,
};

async function enabled(eventType) {
  let raw;
  try { raw = await settings.getOrEnv('email_ev_' + eventType); }
  catch { return DEFAULTS[eventType] ?? false; }
  if (raw == null || raw === '') return DEFAULTS[eventType] ?? false;
  return String(raw).toLowerCase() === 'true';
}

// Send an event email only when the event's toggle is on. Returns the same shape
// as email.sendMail (plus { sent:false, reason:'event_disabled' } when off).
async function send(eventType, mail) {
  try {
    if (!mail || !mail.to) return { sent: false, reason: 'no_recipient' };
    if (!(await enabled(eventType))) return { sent: false, reason: 'event_disabled' };
    return await email.sendMail(mail);
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = { enabled, send, DEFAULTS };
