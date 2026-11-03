'use strict';
// Sign-ins into the audit record. Keycloak keeps who signed in, who failed to, and who
// signed out (lib/keycloakAdmin realmEvents); every five minutes this copies what is new
// into the hash-chained document_events table (lib/auditLog), with no document, so the
// one tamper-evident record answers "who got in" as well as "who touched what". HIPAA
// §164.312(b) and SOC 2 CC7.2 ask for exactly that; the compliance control signin_events
// reads status() to say whether it is happening.
//
// Keycloak filters events by whole days only, so each poll asks for the cursor's day and
// trims by time. The cursor (signin_events_cursor) is the newest event copied and the keys
// seen at that very millisecond; the recent chained rows are read back too, so a cursor
// write that was lost in a crash cannot double an entry.
const settings = require('./settings');

const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 24 * 3600e3;   // a fresh install starts with yesterday, not Keycloak's whole history
const CURSOR_KEY = 'signin_events_cursor';
const STATUS_KEY = 'signin_events_last';

// Keycloak's type -> the chained event's type, and its plain label (the admin feed in
// index.html carries the same words in ACTIVITY_LABELS).
const TYPES = { LOGIN: 'signed_in', LOGIN_ERROR: 'sign_in_failed', LOGOUT: 'signed_out' };
const LABELS = { signed_in: 'Signed in', sign_in_failed: 'Sign-in failed', signed_out: 'Signed out' };
const EVENT_TYPES = Object.values(TYPES);

let _timer = null;
let _running = false;
let _last = null;   // the last poll's outcome, also written to settings for other instances

async function enabled() {
  const v = await settings.getOrEnv('signin_events_enabled');
  return !['0', 'false', 'no', 'off'].includes(String(v == null ? '' : v).toLowerCase());
}

// "2026-11-03T10:00:00.000Z · from 203.0.113.9 · via microsoft · reason invalid_user_credentials"
function detailFor(e) {
  const parts = [e.at];
  if (e.ip) parts.push(`from ${e.ip}`);
  if (e.provider) parts.push(`via ${e.provider}`);
  if (e.error) parts.push(`reason ${String(e.error).replace(/_/g, ' ')}`);
  return parts.join(' · ');
}
const keyOf = (type, time, who) => `${type}|${time}|${String(who || '').toLowerCase()}`;

function parseCursor(raw) {
  try { const c = JSON.parse(raw || 'null'); if (c && Number.isFinite(Number(c.time))) return { time: Number(c.time), seen: Array.isArray(c.seen) ? c.seen : [] }; } catch { /* unreadable */ }
  return null;
}

// Keys of what is already in the chain since a time, read from the rows' own detail (the
// ISO time it starts with), so a restart with a stale or missing cursor appends nothing twice.
async function chainedKeys(sinceMs) {
  const db = require('./db');
  const rows = await db.query(
    `SELECT event_type, actor_email, detail FROM document_events WHERE event_type = ANY($1) AND created_at >= $2`,
    [EVENT_TYPES, new Date(sinceMs - 3600e3).toISOString()]
  );
  const keys = new Set();
  for (const r of rows || []) {
    const t = Date.parse(String(r.detail || '').split(' · ')[0]);
    if (Number.isFinite(t)) keys.add(keyOf(r.event_type, t, r.actor_email));
  }
  return keys;
}

// One pass. Returns what it did; never throws (the timer must keep going), but records why
// it could not run so the compliance check can say so.
async function poll({ now = Date.now() } = {}) {
  if (_running) return _last;
  _running = true;
  const outcome = { at: new Date(now).toISOString(), ok: false, appended: 0, eventsEnabled: null, error: null };
  try {
    if (!(await enabled())) { outcome.error = 'off'; return outcome; }
    const kcAdmin = require('./keycloakAdmin');
    const auditLog = require('./auditLog');
    const cfg = await kcAdmin.eventsConfig();
    outcome.eventsEnabled = cfg.enabled && (!cfg.types.length || cfg.types.includes('LOGIN'));
    if (!outcome.eventsEnabled) { outcome.error = 'Keycloak is not keeping sign-in records (events are off in the realm).'; return outcome; }

    const cursor = parseCursor(await settings.get(CURSOR_KEY)) || { time: now - FIRST_RUN_LOOKBACK_MS, seen: [] };
    const seen = new Set(cursor.seen);
    for (const k of await chainedKeys(cursor.time)) seen.add(k);
    const events = (await kcAdmin.realmEvents({ since: new Date(cursor.time) })).filter(e => e.time >= cursor.time && TYPES[e.type]);

    const emails = new Map();   // Keycloak user id -> address, for events with no username
    let newest = cursor.time;
    const atNewest = new Set(cursor.seen);
    for (const e of events) {
      let who = e.username;
      if (!who && e.userId) {
        if (!emails.has(e.userId)) emails.set(e.userId, await kcAdmin.userEmail(e.userId).catch(() => null));
        who = emails.get(e.userId);
      }
      const type = TYPES[e.type];
      const k = keyOf(type, e.time, who);
      if (seen.has(k)) continue;
      seen.add(k);
      await auditLog.append({ documentId: null, eventType: type, actorEmail: who || null, detail: detailFor({ ...e, at: new Date(e.time).toISOString() }) });
      outcome.appended += 1;
      if (e.time > newest) { newest = e.time; atNewest.clear(); }
      if (e.time === newest) atNewest.add(k);
      // Save as we go: a crash mid-batch then costs one re-read, never a double entry.
      if (outcome.appended % 50 === 0) await settings.set(CURSOR_KEY, JSON.stringify({ time: newest, seen: [...atNewest] }), null);
    }
    await settings.set(CURSOR_KEY, JSON.stringify({ time: newest, seen: [...atNewest] }), null);
    outcome.ok = true;
    return outcome;
  } catch (e) {
    outcome.error = e.message || String(e);
    return outcome;
  } finally {
    _running = false;
    _last = outcome;
    try { await settings.set(STATUS_KEY, JSON.stringify(outcome), null); } catch { /* best effort */ }
  }
}

// The last outcome, from this process or (after a restart) from settings.
async function status() {
  if (_last) return { enabled: await enabled(), last: _last };
  let last = null;
  try { last = JSON.parse((await settings.get(STATUS_KEY)) || 'null'); } catch { /* none yet */ }
  return { enabled: await enabled(), last };
}

// Modelled on lib/backup reschedule: one timer that re-arms itself, never holding the
// process open. The first pass runs a minute after boot so Keycloak has time to come up.
function start() {
  stop();
  if (!process.env.KEYCLOAK_ADMIN_PASSWORD) return false;
  const tick = async () => {
    try { await poll(); } catch (e) { console.error('[signin-events] poll failed:', e.message); }
    _timer = setTimeout(tick, INTERVAL_MS);
    _timer.unref?.();
  };
  _timer = setTimeout(tick, 60000);
  _timer.unref?.();
  return true;
}
function stop() { if (_timer) { clearTimeout(_timer); _timer = null; } }
function _reset() { stop(); _running = false; _last = null; }

module.exports = { poll, status, start, stop, enabled, detailFor, keyOf, TYPES, LABELS, EVENT_TYPES, INTERVAL_MS, CURSOR_KEY, STATUS_KEY, _reset };
