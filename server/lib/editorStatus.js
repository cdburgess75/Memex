'use strict';
// Whether in-browser Office editing can be offered right now.
//
// Two things have to be true: an admin has switched editing on (the
// collabora_enabled setting), and the editor is actually answering. The app has no
// access to Docker, so it cannot start the editor itself; it records the switch and
// a small script on the host (scripts/editor-switch.sh, run every minute) starts or
// stops the collabora service to match. In between, this module is how the rest of
// the app tells "switched on" apart from "ready": Edit buttons are only offered once
// the editor answers, and Settings can show Starting… instead of a dead button.
const db = require('./db');
const settings = require('./settings');

const PROBE_TIMEOUT_MS = 2000;
const PROBE_TTL_MS = 10_000;
// A first start downloads the editor image (about 1.9 GB) before it can run, so
// "still starting" is given a generous window before Settings calls it a failure.
const STARTING_GRACE_MS = 10 * 60_000;
const STOPPING_GRACE_MS = 3 * 60_000;

let probe = { at: 0, base: '', ok: false, pending: null };

// The admin's switch. Stored as the literal 'true' / 'false' — never cleared, because
// an absent row falls back to COLLABORA_ENABLED in the environment, which older
// installs still have set to true.
async function switchedOn() {
  return String((await settings.getOrEnv('collabora_enabled')) || '').toLowerCase() === 'true';
}

// The same base the edit-URL builder uses for discovery (routes/files.js): the
// internal service address, else a directly-exposed editor origin.
async function discoveryBase() {
  const internal = (await settings.getOrEnv('collabora_internal_url')) || '';
  const external = (await settings.getOrEnv('collabora_url')) || '';
  return String(internal || external).replace(/\/+$/, '');
}

// Is the editor answering? Asks its discovery endpoint, which only responds once the
// editor has finished starting. Cached briefly: /api/config calls this on every page load.
async function running({ maxAgeMs = PROBE_TTL_MS } = {}) {
  const base = await discoveryBase();
  if (!base) return false;
  if (probe.base === base && Date.now() - probe.at < maxAgeMs) return probe.ok;
  if (probe.pending && probe.base === base) return probe.pending;
  probe.base = base;
  probe.pending = (async () => {
    let ok = false;
    try {
      const resp = await fetch(`${base}/hosting/discovery`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      ok = resp.ok;
    } catch { ok = false; }
    probe = { at: Date.now(), base, ok, pending: null };
    return ok;
  })();
  return probe.pending;
}

// What every signed-in client is told (editingEnabled in /api/config): offer editing
// only when it will actually open. The switch decides; collabora_url only says where
// a directly-exposed editor lives once it is on.
async function available() {
  if (!(await switchedOn())) return false;
  return running();
}

// What Settings shows an admin.
//   off       switched off, editor not running
//   stopping  just switched off, the host has not stopped the editor yet
//   lingering switched off for a while and the editor is still running (no helper on this host)
//   starting  switched on, the editor is not answering yet
//   on        switched on and answering
//   failed    switched on long enough ago that it should have started, and it has not
async function status() {
  const enabled = await switchedOn();
  const up = await running({ maxAgeMs: 3000 });
  let changedAt = null;
  try {
    const rows = await db.query("SELECT updated_at FROM system_settings WHERE key = 'collabora_enabled'");
    if (rows[0]?.updated_at) changedAt = new Date(rows[0].updated_at).getTime();
  } catch { /* no timestamp: treated as changed long ago */ }
  const age = changedAt ? Date.now() - changedAt : Infinity;
  let state;
  if (enabled) state = up ? 'on' : (age < STARTING_GRACE_MS ? 'starting' : 'failed');
  // 'failed' is advice, not a verdict: if the editor answers later (a slow first
  // download, or the admin ran the script), the next read says 'on'.
  else state = !up ? 'off' : (age < STOPPING_GRACE_MS ? 'stopping' : 'lingering');
  return { enabled, running: up, state };
}

async function setSwitch(on, userId) {
  await settings.set('collabora_enabled', on ? 'true' : 'false', userId);
  probe.at = 0; // the next status read asks the editor again rather than trusting the cache
}

function _resetForTests() { probe = { at: 0, base: '', ok: false, pending: null }; }

module.exports = { switchedOn, running, available, status, setSwitch, _resetForTests,
  STARTING_GRACE_MS, STOPPING_GRACE_MS };
