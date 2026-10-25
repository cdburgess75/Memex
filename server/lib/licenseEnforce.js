'use strict';
// What the license changes about what the server allows. lib/license.js says what the
// license IS (its state); this is the one place the rest of the app asks what that
// MEANS: may this request change things, may this person get an account, is this
// feature included. The status is cached for a minute, so the gate on every request
// costs nothing.
//
// LICENSE_ENFORCE=off (operator environment only, never a setting) turns all of it
// off, for development and evaluation installs. Provisioned servers never set it.
// Reporting (GET /api/license, the warnings) is unaffected by it.
const license = require('./license');
const db = require('./db');
const notifications = require('./notifications');
const auditLog = require('./auditLog');

const TTL_MS = 60_000;
const CONTACT = 'ParaTech (info@ptechllc.com)';
const READONLY_CODE = 'LICENSE_READONLY';
const READONLY_MESSAGE = 'This server is read-only until its license is renewed. Files can still be viewed and downloaded.';
const FEATURE_CODE = 'LICENSE_FEATURE';

let cache = { at: 0, st: null, pending: null };

function enforcing() {
  return String(process.env.LICENSE_ENFORCE || 'on').trim().toLowerCase() !== 'off';
}

// The evaluated license, at most a minute old. One evaluation at a time.
async function current({ maxAgeMs = TTL_MS } = {}) {
  if (cache.st && Date.now() - cache.at < maxAgeMs) return cache.st;
  if (cache.pending) return cache.pending;
  cache.pending = license.status().then(
    (st) => { cache = { at: Date.now(), st, pending: null }; return st; },
    (e) => { cache.pending = null; throw e; },
  );
  return cache.pending;
}
// Something that just evaluated the license (the daily watch, an upload) hands the
// answer over, so the gate does not wait a minute to learn it.
function prime(st) { cache = { at: Date.now(), st, pending: null }; }
function invalidate() { cache = { at: 0, st: null, pending: null }; }

// May this request change the workspace's content?
async function readOnly() {
  if (!enforcing()) return false;
  try { return !!(await current()).readOnly; } catch { return false; }
}

// Is a named feature (editor, api, ...) included? A license without a feature list
// includes everything, and so does a license that was not accepted: the grace period
// and read-only state deal with those, not the feature list it may carry.
async function feature(name) {
  if (!enforcing()) return true;
  try {
    const st = await current();
    if (!st.accepted || !Array.isArray(st.features)) return true;
    return st.features.includes(name);
  } catch { return true; }
}

function refuse(res) { return res.status(403).json({ code: READONLY_CODE, error: READONLY_MESSAGE }); }
function refuseFeature(res, what) { return res.status(403).json({ code: FEATURE_CODE, error: `${what} is not included in this server's license.` }); }

// A seat is an account with a role row that is not switched off. Outside people on
// share links have no row and never count. null when the count is unavailable.
async function seatsUsed() {
  try {
    const row = await db.queryOne('SELECT COUNT(*)::int AS n FROM user_roles WHERE disabled_at IS NULL');
    return row && Number.isInteger(row.n) ? row.n : null;
  } catch { return null; }
}

// Every administrator who is not switched off, by their best address.
async function admins() {
  try {
    const rows = await db.query(
      `SELECT user_id, COALESCE(verified_email, email) AS email
         FROM user_roles
        WHERE role = 'admin' AND disabled_at IS NULL AND COALESCE(verified_email, email) IS NOT NULL`
    );
    return rows.filter((r) => r.email);
  } catch { return []; }
}

// New accounts stop while the term has lapsed, while a license file is present but
// not accepted, and once an install with no file at all has gone read-only. A
// missing file alone does not stop them during its grace period: a fresh install
// still has to let its first administrator in.
function freezesSeats(st) {
  return !!st.seatFreeze && (st.accepted || st.present || st.readOnly);
}

// May one more account be made? Called on a first sign-in, before the role row is
// written. { ok } to admit; { ok:false, code, error } to refuse with a 403.
async function admitNewAccount() {
  if (!enforcing()) return { ok: true };
  let st;
  try { st = await current(); } catch { return { ok: true }; }
  if (freezesSeats(st)) {
    return {
      ok: false, code: 'LICENSE_SEAT_FREEZE',
      error: st.accepted
        ? "No new accounts can be made until this server's license is renewed. Ask an administrator."
        : 'No new accounts can be made until a valid license is installed on this server. Ask an administrator.',
    };
  }
  const licensed = st.seats ? st.seats.licensed : null;
  if (licensed == null) return { ok: true };
  const used = await seatsUsed();
  if (used == null || used < licensed) return { ok: true };
  if (st.seats.policy === 'hard') {
    return { ok: false, code: 'SEAT_LIMIT', error: `This server has used all ${licensed} of its licensed seats. Ask an administrator.` };
  }
  // Soft cap: let them in, and tell the administrators once a day.
  overCap(used + 1, licensed).catch(() => {});
  return { ok: true, overCap: true };
}

async function overCap(used, licensed) {
  const title = `Depot seats: ${used} accounts on a ${licensed}-seat license`;
  const body = `A new account was just made. The license allows ${licensed}; the workspace now has ${used}. Contact ${CONTACT} to add seats.`;
  for (const a of await admins()) {
    await notifications.create({ userId: a.user_id, userEmail: a.email, type: 'license', title, body, refType: 'license', refId: 'seats', dedupeMinutes: 1440 }).catch(() => {});
  }
  await auditLog.append({ eventType: 'license_seats_exceeded', actorEmail: null, detail: `${used} of ${licensed} seats` }).catch(() => {});
}

module.exports = {
  enforcing, current, prime, invalidate, readOnly, feature, refuse, refuseFeature,
  seatsUsed, admins, admitNewAccount, freezesSeats,
  READONLY_CODE, READONLY_MESSAGE, FEATURE_CODE, TTL_MS,
};
