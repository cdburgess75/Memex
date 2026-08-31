'use strict';
// Per-user, in-memory credentials for DELEGATED SMB connectors.
//
// SMB has no browser single-sign-on, so to reach a share AS the signed-in user (so
// NTFS decides what they can see) Depot needs that user's own domain credentials. The
// user supplies them once per session ("unlock"); we hold them ONLY in this process's
// memory, keyed by user + connector, with a sliding TTL.
//
// Hard rules — these credentials must NEVER be:
//   - written to the database, a file, a backup, an audit entry, or a log line
//   - returned to any client
//   - reused across users or connectors
// They evaporate on TTL, on an explicit lock, or on process restart; the user simply
// re-enters them. This is the deliberate trade-off of SMB-without-Kerberos, and it is
// why the store is memory-only and access-scoped.

const TTL_MS = 12 * 60 * 60 * 1000;   // 12h idle timeout, refreshed on each use
const MAX_ENTRIES = 5000;             // backstop against unbounded growth

const store = new Map();              // `${userId}::${connectorId}` -> { domain, username, password, exp }

// Lowercase the ids so a non-canonical connector id in one call (e.g. an uppercased
// UUID on the "lock" path) still matches the canonical row id used on unlock — a Lock
// that reports success must actually clear the credentials.
function keyOf(userId, connectorId) { return `${String(userId).toLowerCase()}::${String(connectorId).toLowerCase()}`; }

function prune() {
  const now = Date.now();
  for (const [k, v] of store) if (v.exp <= now) store.delete(k);
}

// Store (or replace) a user's credentials for one connector.
function set(userId, connectorId, { domain, username, password } = {}) {
  prune();
  if (store.size >= MAX_ENTRIES) {
    // Evict the soonest-to-expire entry rather than refuse — this is a cache, not a vault.
    let oldestKey = null, oldestExp = Infinity;
    for (const [k, v] of store) if (v.exp < oldestExp) { oldestExp = v.exp; oldestKey = k; }
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(keyOf(userId, connectorId), {
    domain: String(domain || ''),
    username: String(username || ''),
    password: String(password || ''),
    exp: Date.now() + TTL_MS,
  });
}

// Retrieve a user's credentials for one connector, or null if absent/expired.
// Reading refreshes the idle timeout (sliding expiry) so an active session stays unlocked.
function get(userId, connectorId) {
  const k = keyOf(userId, connectorId);
  const v = store.get(k);
  if (!v) return null;
  if (v.exp <= Date.now()) { store.delete(k); return null; }
  v.exp = Date.now() + TTL_MS;
  return { domain: v.domain, username: v.username, password: v.password };
}

function has(userId, connectorId) { return get(userId, connectorId) !== null; }

// Explicit lock — a user clearing one connector, or all of theirs (e.g. on sign-out).
function forget(userId, connectorId) { return store.delete(keyOf(userId, connectorId)); }
function forgetUser(userId) {
  const prefix = `${String(userId)}::`;
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

// Test seam only.
function _clear() { store.clear(); }

module.exports = { set, get, has, forget, forgetUser, _clear };
