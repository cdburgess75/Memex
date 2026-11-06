'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-sd-pg-'));
// Sensitive data, end to end, through the WHOLE file and admin routers against a REAL,
// THROWAWAY Postgres: a file with what looks like a card number is uploaded and accepted
// (nothing is refused), the text the search index extracts is checked after the response,
// a finding is recorded with its last four digits only, the hash-chained record and the
// administrators are told, the PCI control goes red, an administrator resolves it through
// the admin router and the control goes green again; an edit that removes the number
// resolves the finding by itself; a Social Security number is listed but never fails the
// control; the one-time check of existing files picks up a file that was here before.
// DROPS AND RECREATES the public schema; refuses to run unless the database name
// contains "test". Every number here is made up at run time.
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
const mockBlobs = new Map();
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async (p, buf) => { mockBlobs.set(p, Buffer.from(buf)); }),
  uploadStream: jest.fn(async (p, readable) => { const b = []; for await (const c of readable) b.push(c); mockBlobs.set(p, Buffer.concat(b)); return { size: mockBlobs.get(p).length }; }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }), copy: jest.fn(async (a, b) => { mockBlobs.set(b, mockBlobs.get(a) || Buffer.alloc(0)); }),
  download: jest.fn(async (p) => mockBlobs.get(p) || Buffer.alloc(0)),
  downloadStream: jest.fn(async (p) => ({ stream: require('stream').Readable.from([mockBlobs.get(p) || Buffer.alloc(0)]), length: (mockBlobs.get(p) || Buffer.alloc(0)).length })),
  isLocalProvider: jest.fn(async () => false), getUrl: jest.fn(), localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn(async () => ({ sent: false, reason: 'test' })), actingAs: (u) => ({ label: u.email, sendAs: u.email }) }));

suite('sensitive data in files, through the real routers and a real database', () => {
  let db, request, app, jwt, sd, compliance;
  const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const OWNER = { id: U(1), email: 'owner@corp.test' }, ADMIN = { id: U(3), email: 'admin@corp.test' };
  const LIB = U(50);
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  // A card number made at run time: a Visa prefix padded with 1s, plus its Luhn check digit.
  let CARD;

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    delete process.env.MALWARE_SCAN_ENABLED;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    for (const [a, role] of [[OWNER, 'contributor'], [ADMIN, 'admin']]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [a.id, a.email, role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Clients', OWNER.id, OWNER.email]);
    sd = require('../../lib/sensitiveData');
    sd.enableForTests();   // the hook is off under Jest unless a suite asks for it
    compliance = require('../../lib/compliance');
    const body = '4111111111111111'.slice(0, 15);
    for (let d = 0; d <= 9; d++) if (sd.luhn(body + d)) { CARD = body + d; break; }
    // A file that was here before any of this existed, with a card number in its text.
    mockBlobs.set('seed/old', Buffer.from(`old statement ${CARD}`));
    await db.query(`INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, document_text)
                    VALUES ('Archive/old-statement.txt', 30, 'text/plain', 'seed/old', $1, $2, $3, true, $4)`, [OWNER.id, OWNER.email, LIB, `old statement ${CARD}`]);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/files', require('../../routes/files'));   // the WHOLE router, as the server mounts it
    app.use('/api/admin', require('../../routes/admin'));
    app.use('/api/v1', require('../../routes/v1'));
  });
  afterAll(async () => { try { await sd.idle(); } catch { /* nothing queued */ } try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  const as = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: true }); return (r) => r.set('Authorization', 'Bearer t').set('x-library-id', LIB); };
  const findings = () => db.query('SELECT f.type, f.count, f.sample, f.resolved_at, f.resolved_by, f.note, d.name FROM document_findings f JOIN documents d ON d.id = f.document_id ORDER BY d.name, f.type');
  const events = (type) => db.query('SELECT document_id, actor_email, detail, hash FROM document_events WHERE event_type = $1 ORDER BY chain_seq', [type]);

  let docId;
  test('a file with a card number is accepted, and after the response a finding, a chained event and a word to the admins exist', async () => {
    const res = await as(OWNER)(request(app).post('/api/files/upload')).attach('file', Buffer.from(`Client paid with card ${CARD.slice(0, 4)} ${CARD.slice(4, 8)} ${CARD.slice(8, 12)} ${CARD.slice(12)} on 2026-03-01.\nSSN 212-34-5678.`), 'payment-note.txt');
    expect(res.status).toBe(200);
    docId = res.body.doc.id;
    await sd.idle();
    const rows = await findings();
    expect(rows).toEqual([
      { type: 'card', count: 1, sample: `•••• ${CARD.slice(-4)}`, resolved_at: null, resolved_by: null, note: null, name: 'payment-note.txt' },
      { type: 'ssn', count: 1, sample: '•••-••-5678', resolved_at: null, resolved_by: null, note: null, name: 'payment-note.txt' },
    ]);
    expect(JSON.stringify(rows)).not.toContain(CARD);
    const ev = await events('sensitive_data_found');
    expect(ev.map(e => e.detail)).toEqual(['card numbers · 1', 'Social Security numbers · 1']);
    expect(ev[0]).toMatchObject({ document_id: docId, hash: expect.any(String) });
    const notes = await db.query("SELECT user_email, type, title, ref_type, ref_id FROM notifications WHERE type = 'sensitive_data_found'");
    expect(notes).toEqual([{ user_email: ADMIN.email, type: 'sensitive_data_found', title: 'A card number may be in payment-note.txt', ref_type: 'document', ref_id: docId }]);
    expect(await db.queryOne('SELECT sensitive_checked_at IS NOT NULL AS checked FROM documents WHERE id = $1', [docId])).toEqual({ checked: true });
  });
  test('the PCI control is red while the card finding is open, and names the count', async () => {
    const r = await compliance.CHECKS.sensitive_data();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/^1 file holds what looks like a payment card number\. Card numbers: 1 open, 0 resolved\. Social Security numbers: 1 open, 0 resolved\. Bank numbers: not checked\./);
    const h = await require('../../lib/health').summary();
    expect(h.findings).toMatchObject({ open: { card: 1, ssn: 1, bank: 0 } });
    expect(h.reasons).toContain('1 file holds what looks like a payment card number. Open Compliance › Findings.');
  });
  test('the admin list and the public API show the finding with the file, the library and the masked sample', async () => {
    const res = await as(ADMIN)(request(app).get('/api/admin/compliance/findings'));
    expect(res.status).toBe(200);
    expect(res.body.findings.map(f => [f.document_name, f.library_name, f.type, f.count, f.sample])).toEqual([
      ['payment-note.txt', 'Clients', 'card', 1, `•••• ${CARD.slice(-4)}`],
      ['payment-note.txt', 'Clients', 'ssn', 1, '•••-••-5678'],
    ]);
    expect(res.body.summary).toMatchObject({ modes: { card: 'flag', ssn: 'flag', bank: 'off' }, open: { card: 1, ssn: 1, bank: 0 }, files_checked: 1, files_total: 2 });
    const cmp = await as(ADMIN)(request(app).get('/api/admin/compliance'));
    expect(cmp.body.findings.open).toHaveLength(2);
    expect(cmp.body.frameworks.find(f => f.id === 'pci_dss').controls.find(c => c.id === 'sensitive_data')).toMatchObject({ ready: false, fix: 'compliance:findings' });
    const forbidden = await as(OWNER)(request(app).get('/api/admin/compliance/findings'));
    expect(forbidden.status).toBe(403);
  });
  test('an administrator resolves the card finding with a note: who, when and the note are kept, the record says so, the control is green', async () => {
    const id = (await db.queryOne("SELECT id FROM document_findings WHERE type = 'card'")).id;
    const res = await as(ADMIN)(request(app).post(`/api/admin/compliance/findings/${id}/resolve`)).send({ note: 'Client statement; the number is theirs and belongs here.' });
    expect(res.status).toBe(200);
    expect(res.body.finding).toMatchObject({ resolved_by: ADMIN.email, note: 'Client statement; the number is theirs and belongs here.', resolved_at: expect.any(String) });
    expect((await events('sensitive_data_resolved')).map(e => [e.actor_email, e.detail])).toEqual([[ADMIN.email, 'card numbers · Client statement; the number is theirs and belongs here.']]);
    const r = await compliance.CHECKS.sensitive_data();
    expect(r.ready).toBe(true);
    expect(r.evidence).toMatch(/^Every file is checked for card numbers as it arrives, and none is open\. Card numbers: 0 open, 1 resolved\. Social Security numbers: 1 open, 0 resolved\./);
    expect(await as(ADMIN)(request(app).post(`/api/admin/compliance/findings/${U(99)}/resolve`)).send({}).then(r => r.status)).toBe(404);
  });
  test('an edit that takes the Social Security number out resolves that finding by itself; the card finding reopens when the file changes with the number still in it', async () => {
    const res = await as(OWNER)(request(app).put(`/api/files/${docId}/content`)).send({ content: `Client paid with card ${CARD} on 2026-03-01. SSN removed.` });
    expect(res.status).toBe(200);
    await sd.idle();
    const rows = await findings();
    expect(rows.find(r => r.type === 'ssn')).toMatchObject({ resolved_by: 'depot', note: 'No longer in the file.' });
    expect(rows.find(r => r.type === 'card')).toMatchObject({ resolved_at: null, resolved_by: null, count: 1 });
    expect((await events('sensitive_data_found')).at(-1).detail).toBe('card numbers · 1 · found again after the file changed');
    expect((await compliance.CHECKS.sensitive_data()).ready).toBe(false);
  });
  test('the switches: card detection off makes the control red whatever the findings; bank on lists routing numbers', async () => {
    const bad = await as(ADMIN)(request(app).put('/api/admin/compliance/findings/settings')).send({ cards: 'refuse' });
    expect(bad.status).toBe(400);
    const res = await as(ADMIN)(request(app).put('/api/admin/compliance/findings/settings')).send({ cards: 'off', bank: 'flag' });
    expect(res.body.modes).toEqual({ card: 'off', ssn: 'flag', bank: 'flag' });
    expect((await compliance.CHECKS.sensitive_data()).evidence).toMatch(/^Card numbers are not being checked for\./);
    await as(ADMIN)(request(app).put('/api/admin/compliance/findings/settings')).send({ cards: 'flag' });
  });
  test('the one-time check of existing files finds the old statement, in the background, and the public API lists it', async () => {
    expect(await db.queryOne("SELECT count(*)::int AS n FROM documents WHERE sensitive_checked_at IS NULL AND deleted_at IS NULL")).toEqual({ n: 1 });
    const res = await as(ADMIN)(request(app).post('/api/admin/compliance/findings/check')).send({});
    expect(res.status).toBe(200);
    expect(res.body.backfill).toMatchObject({ total: 1, by: ADMIN.email });
    await sd.waitBackfill();
    expect(sd.backfillStatus()).toMatchObject({ running: false, done: 1, total: 1, error: null });
    const rows = await findings();
    expect(rows.filter(r => r.name === 'Archive/old-statement.txt')).toEqual([expect.objectContaining({ type: 'card', count: 1, sample: `•••• ${CARD.slice(-4)}` })]);
    expect(await db.queryOne("SELECT count(*)::int AS n FROM documents WHERE sensitive_checked_at IS NULL AND deleted_at IS NULL")).toEqual({ n: 0 });
    const v1 = await as(ADMIN)(request(app).get('/api/v1/admin/compliance/findings?type=card'));
    expect(v1.status).toBe(200);
    expect(v1.body.findings.map(f => f.document_name).sort()).toEqual(['Archive/old-statement.txt', 'payment-note.txt']);
    expect(v1.body.summary.files_checked).toBe(2);
  });
  test('the reports carry a sensitive-data section with the open card findings', async () => {
    const evidence = require('../../lib/evidence');
    const b = await evidence.build();
    expect(b.findings).toMatchObject({ open: { card: 2 }, openCards: expect.arrayContaining([expect.objectContaining({ document_name: 'Archive/old-statement.txt' })]) });
    const html = evidence.toReportHtml(b, 'pci_dss');
    expect(html).toContain('Sensitive data in files');
    expect(html).toContain('Archive/old-statement.txt');
    expect(html).not.toContain(CARD);
    expect(evidence.toMarkdown(b)).toContain('## Sensitive data in files');
  });
  test('deleting the file takes its finding with it', async () => {
    await db.query("DELETE FROM documents WHERE name = 'Archive/old-statement.txt'");
    expect((await findings()).map(r => r.name)).toEqual(['payment-note.txt', 'payment-note.txt']);
  });
});
