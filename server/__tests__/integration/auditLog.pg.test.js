'use strict';
// Integration test for the tamper-evident audit-log SQL path (ensureChain
// migration, hash-chained append under the advisory lock, keyset-paginated
// verify, and tamper detection). Requires a REAL, THROWAWAY Postgres.
//
// It DROPS and recreates the document_events table, so point it at a scratch
// database, never a production one:
//
//   createdb memex_audit_test
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_audit_test \
//     npx jest integration/auditLog.pg
//
// Without MEMEX_TEST_PG_URL the whole suite is skipped (normal CI / sandbox).
const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;

suite('auditLog against real Postgres', () => {
  let db, auditLog;

  beforeAll(async () => {
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    auditLog = require('../../lib/auditLog');
    // Fresh table + sequence so ensureChain runs from a clean slate.
    await db.query('DROP TABLE IF EXISTS document_events');
    await db.query('DROP SEQUENCE IF EXISTS document_events_chain_seq');
    await db.query(`CREATE TABLE document_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID, event_type TEXT NOT NULL, actor_id UUID, actor_email TEXT, detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // A pre-existing row (hash NULL) that must stay outside the chain.
    await db.query("INSERT INTO document_events (event_type, actor_email, detail) VALUES ('legacy', 'old@x.com', 'pre-chain row')");
  });

  afterAll(async () => {
    try { await db.query('DROP TABLE IF EXISTS document_events'); } catch { /* best effort */ }
    try { await db.query('DROP SEQUENCE IF EXISTS document_events_chain_seq'); } catch { /* best effort */ }
    try { await db.end(); } catch { /* pool may already be closed */ }
  });

  test('ensureChain adds the columns without rewriting/erroring, and is idempotent', async () => {
    await auditLog.ensureChain();
    await auditLog.ensureChain(); // second call is a no-op
    const cols = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'document_events'"
    );
    const names = cols.map(c => c.column_name);
    expect(names).toEqual(expect.arrayContaining(['chain_seq', 'prev_hash', 'hash', 'ts_ms']));
  });

  test('append builds an intact chain, including a mixed-case UUID', async () => {
    await auditLog.append({ documentId: null, eventType: 'uploaded', actorEmail: 'a@x.com', detail: 'file one' });
    await auditLog.append({ eventType: 'share_created', actorEmail: 'a@x.com', detail: 'link' });
    // The exact bug the review caught: an uppercase UUID must still verify.
    await auditLog.append({ documentId: 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', eventType: 'share_revoked', actorEmail: 'a@x.com', detail: 'revoke' });
    const r = await auditLog.verify();
    expect(r.ok).toBe(true);
    expect(r.count).toBe(3); // the legacy NULL-hash row is excluded
  });

  test('concurrent appends do not fork the chain', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) =>
      auditLog.append({ eventType: 'edited', actorEmail: `u${i}@x.com`, detail: `edit ${i}` })));
    const r = await auditLog.verify();
    expect(r.ok).toBe(true);
    expect(r.count).toBe(28); // 3 + 25
  });

  test('tampering with a row is detected at that entry', async () => {
    await db.query(
      "UPDATE document_events SET detail = 'TAMPERED' WHERE chain_seq = (SELECT MIN(chain_seq) FROM document_events WHERE hash IS NOT NULL)"
    );
    const r = await auditLog.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hash/);
    expect(typeof r.brokenAt).toBe('number');
  });
});
