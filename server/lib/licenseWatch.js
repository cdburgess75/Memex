'use strict';
// License warnings. A minute after boot and once a day after that, the server
// evaluates its license and tells the administrators when something needs doing:
// the term is ending, has ended, the grace period is over, or no valid license is
// in place. Each notice goes out once per threshold, in-app and by email, to
// every administrator who is not switched off. ParaTech ops is an administrator
// on every managed box, so it hears the same thing the customer does.
//
// Nothing here changes what the server allows; lib/license.js decides that.
const license = require('./license');
const settings = require('./settings');
const notifications = require('./notifications');
const email = require('./email');
const auditLog = require('./auditLog');
const enforce = require('./licenseEnforce');

const INTERVAL_MS = 24 * 3600 * 1000;
const FIRST_RUN_MS = 60 * 1000;
const THRESHOLDS = [30, 14, 7, 1];           // days left that each earn a notice
const MEM_NOTICE = 'license_notice_sent';    // the last notice key, so each goes once
const MEM_STATE = 'license_state_seen';      // the last state, for the audit trail
const CONTACT = 'ParaTech (info@ptechllc.com)';

const PROBLEM = {
  no_public_key: 'this server trusts no license key',
  no_license: 'no license file is installed',
  bad_signature: 'the license signature is not valid',
  unknown_kid: 'the license was signed with a key this server does not trust',
  domain_mismatch: "the license was issued for a different address than this server's",
  serial_regressed: 'the license is older than one this server has already seen',
  serial_mismatch: 'the license belongs to a different installation',
  bad_payload: 'the license file is not well formed',
};

const day = (iso) => String(iso || '').slice(0, 10);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Which notice, if any, a status calls for. Equal keys on consecutive days mean
// "already said", so a 25-day-left license sends once at the 30-day threshold.
function noticeKey(st) {
  if (!st || !st.accepted) return `unlicensed:${st?.stateReason || 'unknown'}${st?.readOnly ? ':readonly' : ''}`;
  if (st.state === 'readonly') return 'readonly';
  if (st.state === 'lapsed') return 'lapsed';
  if (st.state === 'expiring') {
    const t = THRESHOLDS.filter((d) => st.daysLeft <= d).pop() ?? THRESHOLDS[0];
    return `expiring:${t}`;
  }
  return 'ok';
}

// The words. Subject doubles as the in-app title; text is the email body and the
// in-app body.
function notice(st, key) {
  const who = st.customer ? ` for ${st.customer}` : '';
  if (key.startsWith('unlicensed:')) {
    const why = PROBLEM[st.stateReason] || 'the license could not be accepted';
    const tail = st.readOnly
      ? 'The grace period is over, so the server is read-only until a valid license is installed.'
      : `New accounts and updates are off. ${st.graceEnds ? `The server becomes read-only on ${day(st.graceEnds)} unless a valid license is installed.` : ''}`.trim();
    return { subject: 'Depot has no valid license', text: `Depot has no valid license on this server: ${why}. ${tail} Contact ${CONTACT}.` };
  }
  if (key === 'readonly') {
    return { subject: 'Depot is read-only: the license grace period has ended', text: `The license grace period${who} ended on ${day(st.graceEnds)}. The server is read-only until the license is renewed. Renew with ${CONTACT}.` };
  }
  if (key === 'lapsed') {
    return { subject: 'Depot license term ended: renew now', text: `The license term${who} ended on ${st.expires}. New accounts and updates are off. The server becomes read-only on ${day(st.graceEnds)} unless the license is renewed. Renew with ${CONTACT}.` };
  }
  if (key.startsWith('expiring:')) {
    const when = st.daysLeft === 0 ? 'today' : `in ${plural(st.daysLeft, 'day')}`;
    return { subject: `Depot license: term ends ${when}`, text: `The license term${who} ends on ${st.expires}, ${when}. After that, new accounts and updates stop, and ${plural(st.graceDays ?? 30, 'day')} later the server becomes read-only. Renew with ${CONTACT}.` };
  }
  return { subject: 'Depot license renewed', text: `The license${who} is in good standing${st.expires ? ` through ${st.expires}` : ''}. Nothing to do.` };
}

const admins = () => enforce.admins();

async function send(key, n) {
  let sent = 0;
  for (const a of await admins()) {
    await notifications.create({
      userId: a.user_id, userEmail: a.email, type: 'license', title: n.subject, body: n.text,
      refType: 'license', refId: key, dedupeMinutes: 1440,
    }).catch(() => {});
    await email.sendMail({ to: a.email, subject: n.subject, text: n.text }).catch(() => {});
    sent++;
  }
  return sent;
}

function audit(eventType, detail) {
  return auditLog.append({ eventType, actorEmail: null, detail }).catch(() => {});
}

// One pass: evaluate, record a state change, say what is new. Never throws.
async function check(now = new Date()) {
  const st = await license.status(now);
  enforce.prime(st); // the gate learns the answer now, not a minute from now
  const stateNow = st.accepted ? st.state : `unlicensed:${st.stateReason || 'unknown'}`;
  const stateSeen = await settings.get(MEM_STATE);
  if (stateSeen !== stateNow) {
    await audit('license_state_changed', `${stateSeen || 'none'} -> ${stateNow}`);
    await settings.set(MEM_STATE, stateNow);
  }
  const key = noticeKey(st);
  const last = await settings.get(MEM_NOTICE);
  if (key === last) return { state: stateNow, key, sent: 0 };
  // Good standing is only news after a warning went out.
  const n = key === 'ok' ? (last && last !== 'ok' ? notice(st, key) : null) : notice(st, key);
  const sent = n ? await send(key, n) : 0;
  await settings.set(MEM_NOTICE, key);
  if (n) await audit('license_notice', `${key}: ${n.subject} (${plural(sent, 'administrator')})`);
  return { state: stateNow, key, sent };
}

let _timer = null;
async function runGuarded() {
  try { await check(); } catch (e) { console.error('[license] watch failed:', e.message); }
}
function start() {
  if (_timer) return _timer;
  const first = setTimeout(runGuarded, FIRST_RUN_MS);
  first.unref?.();
  _timer = setInterval(runGuarded, INTERVAL_MS);
  _timer.unref?.();
  return _timer;
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { check, noticeKey, notice, start, stop, THRESHOLDS, MEM_NOTICE, MEM_STATE, INTERVAL_MS, PROBLEM };
