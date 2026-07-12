'use strict';
// Tamper-evident audit log. Every file event in document_events is hash-chained:
// each row's hash = SHA-256(prev_row_hash | canonical(row)). Altering or deleting
// any row breaks the chain from that point forward, which verify() detects. New
// columns (chain_seq, prev_hash, hash, ts_ms) are added in place; pre-existing
// rows (hash NULL) are outside the chain and ignored by verify.
const crypto = require('crypto');
const db = require('./db');

const AUDIT_LOCK = 728412; // advisory-lock key that serializes appends

let ensured = false;
async function ensureChain() {
  if (ensured) return;
  await db.query('ALTER TABLE document_events ADD COLUMN IF NOT EXISTS chain_seq BIGSERIAL');
  await db.query('ALTER TABLE document_events ADD COLUMN IF NOT EXISTS prev_hash TEXT');
  await db.query('ALTER TABLE document_events ADD COLUMN IF NOT EXISTS hash TEXT');
  await db.query('ALTER TABLE document_events ADD COLUMN IF NOT EXISTS ts_ms BIGINT');
  ensured = true;
}

// Canonical, stable serialization of the hashed fields. ts_ms (integer epoch
// millis) is hashed instead of created_at so verify round-trips exactly.
function hashEvent(prevHash, row) {
  const canonical = JSON.stringify({
    t: row.event_type || '',
    a: row.actor_email || '',
    d: row.document_id || '',
    x: row.detail || '',
    ms: Number(row.ts_ms) || 0,
  });
  return crypto.createHash('sha256').update(String(prevHash || '') + '|' + canonical).digest('hex');
}

// Append one event, chained to the current head. Serialized by an advisory lock
// so prev_hash is always the true latest even under concurrent writes.
async function append({ documentId = null, eventType, actorId = null, actorEmail = null, detail = null }) {
  await ensureChain();
  const ts_ms = Date.now();
  return db.withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
    const prevRows = await client.query('SELECT hash FROM document_events WHERE hash IS NOT NULL ORDER BY chain_seq DESC LIMIT 1');
    const prevHash = prevRows.rows[0] ? prevRows.rows[0].hash : '';
    const row = { event_type: eventType, actor_email: actorEmail, document_id: documentId, detail, ts_ms };
    const hash = hashEvent(prevHash, row);
    const r = await client.query(
      `INSERT INTO document_events (document_id, event_type, actor_id, actor_email, detail, ts_ms, prev_hash, hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($6::double precision / 1000.0))
       RETURNING chain_seq, hash`,
      [documentId, eventType, actorId, actorEmail, detail, ts_ms, prevHash, hash]
    );
    return r.rows[0];
  });
}

// Pure verifier over chain-ordered rows. Returns the first break, if any.
function verifyRows(rows) {
  let prev = '';
  for (const row of rows) {
    if ((row.prev_hash || '') !== prev) {
      return { ok: false, brokenAt: Number(row.chain_seq), reason: 'prev_hash does not match the previous entry' };
    }
    if (row.hash !== hashEvent(prev, row)) {
      return { ok: false, brokenAt: Number(row.chain_seq), reason: 'row contents do not match its hash' };
    }
    prev = row.hash;
  }
  return { ok: true, count: rows.length, head: prev || null };
}

// Walk the whole chain from the database and verify it.
async function verify() {
  await ensureChain();
  const rows = await db.query(
    'SELECT chain_seq, event_type, actor_email, document_id, detail, ts_ms, prev_hash, hash FROM document_events WHERE hash IS NOT NULL ORDER BY chain_seq ASC'
  );
  return verifyRows(rows);
}

module.exports = { append, verify, verifyRows, hashEvent, ensureChain };
