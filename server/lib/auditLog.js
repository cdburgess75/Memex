'use strict';
// Tamper-evident audit log. Every file event in document_events is hash-chained:
// each row's hash = SHA-256(prev_row_hash | canonical(row)). Altering, deleting,
// or reordering any row breaks the chain, which verify() detects. New columns
// (chain_seq, prev_hash, hash, ts_ms) are added in place; pre-existing rows
// (hash NULL) are outside the chain and ignored by verify.
const crypto = require('crypto');
const db = require('./db');

const AUDIT_LOCK = 728412; // advisory-lock key that serializes appends across instances
const VERIFY_BATCH = 5000;

let ensured = false;
let ensuring = null;
async function ensureChain() {
  if (ensured) return;
  if (ensuring) return ensuring; // collapse concurrent first-calls onto one run
  ensuring = (async () => {
    // chain_seq is BIGINT + an explicit sequence default, NOT BIGSERIAL: adding a
    // BIGSERIAL column rewrites the whole table (its nextval default is volatile),
    // whereas ADD COLUMN BIGINT is a metadata-only change and SET DEFAULT only
    // affects future inserts. Pre-existing rows keep chain_seq NULL (harmless —
    // they also have hash NULL and are excluded from the chain).
    await db.query('ALTER TABLE document_events ADD COLUMN IF NOT EXISTS chain_seq BIGINT');
    await db.query('CREATE SEQUENCE IF NOT EXISTS document_events_chain_seq OWNED BY document_events.chain_seq');
    await db.query("ALTER TABLE document_events ALTER COLUMN chain_seq SET DEFAULT nextval('document_events_chain_seq')");
    await db.query('ALTER TABLE document_events ADD COLUMN IF NOT EXISTS prev_hash TEXT');
    await db.query('ALTER TABLE document_events ADD COLUMN IF NOT EXISTS hash TEXT');
    await db.query('ALTER TABLE document_events ADD COLUMN IF NOT EXISTS ts_ms BIGINT');
    // Partial index so the head lookup (DESC LIMIT 1) and verify walk (ASC) are
    // index scans, not full-table seq scans held under the append lock.
    await db.query('CREATE INDEX IF NOT EXISTS document_events_chain_idx ON document_events (chain_seq) WHERE hash IS NOT NULL');
    ensured = true;
  })();
  try { await ensuring; } finally { ensuring = null; }
}

// UUIDs are stored/returned by Postgres in canonical lowercase-hyphenated form,
// so normalize before hashing: append (JS input) and verify (DB value) must hash
// the identical representation or verify would false-positive on tampering.
function normId(id) { return id == null ? null : String(id).toLowerCase(); }

function hashEvent(prevHash, row) {
  const canonical = JSON.stringify({
    t: row.event_type || '',
    a: row.actor_email || '',
    d: normId(row.document_id) || '',
    x: row.detail || '',
    ms: Number(row.ts_ms) || 0,
  });
  return crypto.createHash('sha256').update(String(prevHash || '') + '|' + canonical).digest('hex');
}

// In-process serialization: only one append is ever in flight per Node instance,
// so audit writes never hold more than one pooled connection while queued behind
// the advisory lock (which previously let a burst exhaust the pool). Cross-
// instance ordering is still guaranteed by pg_advisory_xact_lock inside the txn.
let _tail = Promise.resolve();
function serialize(fn) {
  const run = _tail.then(fn, fn);
  _tail = run.then(() => {}, () => {});
  return run;
}

async function append({ documentId = null, eventType, actorId = null, actorEmail = null, detail = null }) {
  await ensureChain();
  const docId = normId(documentId);
  const ts_ms = Date.now();
  return serialize(() => db.withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
    const prevRows = await client.query('SELECT hash FROM document_events WHERE hash IS NOT NULL ORDER BY chain_seq DESC LIMIT 1');
    const prevHash = prevRows.rows[0] ? prevRows.rows[0].hash : '';
    const row = { event_type: eventType, actor_email: actorEmail, document_id: docId, detail, ts_ms };
    const hash = hashEvent(prevHash, row);
    const r = await client.query(
      // ts_ms is bound twice ($6 for the bigint column, $9 for to_timestamp) so a
      // single parameter is never deduced as both bigint and double precision, which
      // Postgres rejects with "inconsistent types deduced for parameter $6".
      `INSERT INTO document_events (document_id, event_type, actor_id, actor_email, detail, ts_ms, prev_hash, hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::double precision / 1000.0))
       RETURNING chain_seq, hash`,
      [docId, eventType, actorId, actorEmail, detail, ts_ms, prevHash, hash, ts_ms]
    );
    return r.rows[0];
  }));
}

// Pure verifier over chain-ordered rows. Returns the first break, if any.
function verifyRows(rows, startPrev = '') {
  let prev = startPrev;
  for (const row of rows) {
    if ((row.prev_hash || '') !== prev) {
      return { ok: false, brokenAt: Number(row.chain_seq), reason: 'prev_hash does not match the previous entry' };
    }
    if (row.hash !== hashEvent(prev, row)) {
      return { ok: false, brokenAt: Number(row.chain_seq), reason: 'row contents do not match its hash' };
    }
    // created_at is the field the admin feed/CSV display and order by, and it is
    // written from ts_ms (which IS hashed). Binding it here so rewriting the
    // visible timestamp out-of-band (without touching ts_ms/hash) is detected.
    // Guarded on presence so the pure unit tests (which omit created_at) still run.
    if (row.created_at != null) {
      const cms = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(row.created_at);
      if (cms !== Number(row.ts_ms)) {
        return { ok: false, brokenAt: Number(row.chain_seq), reason: 'created_at does not match the hashed timestamp' };
      }
    }
    prev = row.hash;
  }
  return { ok: true, prev };
}

// Walk the chain in keyset-paginated batches so peak memory is O(batch), not the
// whole log, and verify each batch with the pure verifier.
async function verify() {
  await ensureChain();
  let prev = '';
  let after = 0;
  let count = 0;
  for (;;) {
    const rows = await db.query(
      'SELECT chain_seq, event_type, actor_email, document_id, detail, ts_ms, prev_hash, hash, created_at FROM document_events WHERE hash IS NOT NULL AND chain_seq > $1 ORDER BY chain_seq ASC LIMIT $2',
      [after, VERIFY_BATCH]
    );
    if (!rows.length) break;
    const r = verifyRows(rows, prev);
    if (!r.ok) return { ok: false, brokenAt: r.brokenAt, reason: r.reason };
    prev = r.prev;
    count += rows.length;
    after = Number(rows[rows.length - 1].chain_seq);
    if (rows.length < VERIFY_BATCH) break;
  }
  return { ok: true, count, head: prev || null };
}

module.exports = { append, verify, verifyRows, hashEvent, normId, ensureChain };
