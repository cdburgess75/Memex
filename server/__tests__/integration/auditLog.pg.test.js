'use strict';
// Integration test for the tamper-evident audit-log SQL path (the chain columns
// applied by the real migration runner, hash-chained append under the advisory
// lock, keyset-paginated verify, and tamper detection). Requires a REAL,
// THROWAWAY Postgres.
//
// It DROPS and recreates tables (everything the migrations create), so point it
// at a scratch database, never a production one:
//
//   createdb memex_audit_test
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_audit_test \
//     npx jest integration/auditLog.pg
//
// Without MEMEX_TEST_PG_URL the whole suite is skipped (normal CI / sandbox).
const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;

// Everything the migrations (0001–0004) create, plus the base tables this test
// seeds, so reruns start clean.
const MIGRATION_TABLES = [
  'schema_migrations', 'user_preferences', 'storage_connectors', 'user_profiles',
  'notifications', 'library_members', 'libraries', 'document_acl', 'upload_sessions',
  'document_share_links', 'folder_share_links', 'upload_links', 'recent_opens',
  'compliance_attestations', 'folder_notify_prefs', 'document_follows',
  'document_events', 'documents',
];

suite('auditLog against real Postgres', () => {
  let db, auditLog, migrations;

  async function dropAll() {
    for (const t of MIGRATION_TABLES) await db.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    await db.query('DROP SEQUENCE IF EXISTS document_events_chain_seq');
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    auditLog = require('../../lib/auditLog');
    migrations = require('../../lib/migrations');
    await dropAll();
    // Minimal stand-ins for the base tables postgres/init/01_schema.sql provides
    // on a real box; the migrations build everything else on top of them.
    await db.query(`CREATE TABLE documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ)`);
    await db.query(`CREATE TABLE document_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID, event_type TEXT NOT NULL, actor_id UUID, actor_email TEXT, detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // A pre-existing row (hash NULL) that must stay outside the chain.
    await db.query("INSERT INTO document_events (event_type, actor_email, detail) VALUES ('legacy', 'old@x.com', 'pre-chain row')");
  });

  afterAll(async () => {
    try { await dropAll(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* pool may already be closed */ }
  });

  test('migrations add the chain columns without rewriting/erroring, and re-running is a no-op', async () => {
    const first = await migrations.run();
    expect(first.applied).toContain('0004_runtime_ensure_tables.sql');
    const second = await migrations.run(); // everything recorded → nothing to do
    expect(second.applied).toEqual([]);
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
