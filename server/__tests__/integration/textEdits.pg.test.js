'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-text-pg-'));
// Saving a text file from the built-in editor, through the real files router against a REAL,
// THROWAWAY Postgres: the revision that stops a save over a file that changed elsewhere, the
// sitting that keeps one version and makes one log entry, and who is told. DROPS AND RECREATES
// the public schema; refuses to run unless the database name contains "test".
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
  uploadStream: jest.fn(async (p, readable) => { const b = []; for await (const c of readable) b.push(c); const buf = Buffer.concat(b); mockBlobs.set(p, buf); return { size: buf.length }; }),
  download: jest.fn(async (p) => { if (!mockBlobs.has(p)) throw new Error('no such blob'); return mockBlobs.get(p); }),
  downloadStream: jest.fn(async (p) => { const buf = mockBlobs.get(p) || Buffer.alloc(0); return { stream: require('stream').Readable.from([buf]), length: buf.length, totalSize: buf.length }; }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }), copy: jest.fn(async (from, to) => { mockBlobs.set(to, mockBlobs.get(from)); }),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(async () => 'http://x/url'), localBase: jest.fn(async () => require('os').tmpdir()), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn(async () => ({ sent: true })), actingAs: (u) => ({ label: u.email, sendAs: u.email }), isConfigured: async () => false }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn(async (buf) => buf.toString('utf8').replace(/[\0\uFFFD]/g, '').slice(0, 1000)) })); // a blank Word file is binary; a text column refuses NULs

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const DAVE = { id: U(1), email: 'dave@corp.test' }, VIEW = { id: U(2), email: 'viewer@corp.test' }, OTHER = { id: U(4), email: 'other@corp.test' };
const LIB = U(50);

suite('saving a text file from the editor', () => {
  let db, request, app, jwt, notifications, emailEvents;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const as = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: true }); return 'Bearer session'; };
  const get = (who, p) => request(app).get('/api/files' + p).set('Authorization', as(who));
  const put = (who, p, body) => request(app).put('/api/files' + p).set('Authorization', as(who)).send(body);
  const post = (who, p, body) => request(app).post('/api/files' + p).set('Authorization', as(who)).send(body);
  const edits = (id) => db.queryOne("SELECT count(*)::int AS n FROM document_events WHERE document_id = $1 AND event_type = 'edited'", [id]).then(r => r.n);
  const versions = (id) => db.query('SELECT version_number, storage_path, source FROM document_versions WHERE document_id = $1 ORDER BY version_number', [id]);
  const backdate = (id) => db.query("UPDATE document_events SET created_at = created_at - interval '11 minutes' WHERE document_id = $1 AND event_type = 'edited'", [id]);
  const settle = async (ok) => { for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    for (const [a, role] of [[DAVE, 'contributor'], [VIEW, 'viewer'], [OTHER, 'contributor']]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [a.id, a.email, role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Projects', DAVE.id, DAVE.email]);
    const shares = require('../../lib/libraryShares');
    for (const a of [VIEW, OTHER]) await shares.createShare({ libraryId: LIB, folderPath: '', email: a.email, permission: 'write', user: { id: DAVE.id, email: DAVE.email } });
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    notifications = require('../../lib/notifications'); emailEvents = require('../../lib/emailEvents');
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/files', require('../../routes/files'));
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  let doc, rev = {};
  test('the editor is handed the text, where the file lives, a revision, and whether this person may change it', async () => {
    doc = (await post(DAVE, '/create', { name: 'notes', type: 'md', folder: 'Plans', library_id: LIB }).expect(200)).body;
    const t = await get(DAVE, `/${doc.id}/text`).expect(200);
    expect(t.body).toMatchObject({ id: doc.id, name: 'notes.md', path: 'Plans/notes.md', folder: 'Plans', library: { id: LIB, name: 'Projects' }, can_edit: true, too_big: false, mime_type: 'text/markdown' });
    expect(t.body.revision).toMatch(/^[0-9a-f]{24}$/);
    expect(typeof t.body.content).toBe('string');
    rev.v0 = t.body.revision; rev.blank = t.body.content;
    // a viewer sees it and may not change it; a contributor with a write share may
    expect((await get(VIEW, `/${doc.id}/text`).expect(200)).body.can_edit).toBe(false);
    expect((await get(OTHER, `/${doc.id}/text`).expect(200)).body.can_edit).toBe(true);
    expect((await get(DAVE, `/${U(77)}/text`)).status).toBe(404);
    expect((await get(DAVE, '/nope/text')).status).toBe(404);
    const word = (await post(DAVE, '/create', { name: 'memo', type: 'docx', library_id: LIB }).expect(200)).body;
    expect((await get(DAVE, `/${word.id}/text`)).status).toBe(400);
  });

  test('the first save of a sitting is the one "edited" entry; saves soon after are quiet and keep no version', async () => {
    const first = await put(DAVE, `/${doc.id}/content`, { content: '# Notes\n\nfirst', base_revision: rev.v0 }).expect(200);
    expect(first.body).toMatchObject({ ok: true, size: 14, new_sitting: true });
    expect(first.body.revision).toMatch(/^[0-9a-f]{24}$/); expect(first.body.revision).not.toBe(rev.v0);
    rev.v1 = first.body.revision;
    const second = await put(DAVE, `/${doc.id}/content`, { content: '# Notes\n\nfirst, then second', base_revision: rev.v1 }).expect(200);
    expect(second.body).toMatchObject({ new_sitting: false, kept_version: false });
    rev.v2 = second.body.revision;
    expect(await edits(doc.id)).toBe(1);
    // the content the sitting began with (the blank file Depot made) was kept, once
    expect(first.body.kept_version).toBe(true);
    const kept = (await versions(doc.id)).filter(v => v.source === 'edit');
    expect(kept).toHaveLength(1);
    expect(mockBlobs.get(kept[0].storage_path).toString()).toBe(rev.blank);
    expect((await get(DAVE, `/${doc.id}/text`)).body.content).toBe('# Notes\n\nfirst, then second');
  });

  test('a save over a file that changed elsewhere is refused, with the revision now; force saves anyway', async () => {
    const stale = await put(DAVE, `/${doc.id}/content`, { content: 'typed in an old tab', base_revision: rev.v1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ code: 'FILE_CHANGED', error: 'This file changed since you opened it', revision: rev.v2 });
    expect((await get(DAVE, `/${doc.id}/text`)).body.content).toBe('# Notes\n\nfirst, then second');
    const forced = await put(DAVE, `/${doc.id}/content`, { content: 'typed in an old tab', base_revision: rev.v1, force: true }).expect(200);
    rev.v3 = forced.body.revision;
    expect((await get(DAVE, `/${doc.id}/text`)).body).toMatchObject({ content: 'typed in an old tab', revision: rev.v3 });
    // without a revision (an older client), a save just saves
    const plain = await put(DAVE, `/${doc.id}/content`, { content: 'plain save' }).expect(200);
    rev.v4 = plain.body.revision;
    expect(await edits(doc.id)).toBe(1); // still the same sitting
  });

  test('ten minutes later it is a new sitting: the content as it was is kept as a version, and a new entry is made', async () => {
    await backdate(doc.id);
    const r = await put(DAVE, `/${doc.id}/content`, { content: 'next day', base_revision: rev.v4 }).expect(200);
    expect(r.body).toMatchObject({ new_sitting: true, kept_version: true });
    rev.v5 = r.body.revision;
    expect(await edits(doc.id)).toBe(2);
    const kept = (await versions(doc.id)).filter(v => v.source === 'edit');
    expect(kept).toHaveLength(2); // the blank from the first sitting, and now the content this one began with
    expect(mockBlobs.get(kept[1].storage_path).toString()).toBe('plain save');
  });

  test('the owner and followers are told once per sitting, never the one who edited', async () => {
    notifications.create.mockClear(); emailEvents.send.mockClear();
    await post(OTHER, `/${doc.id}/follow`, { follow: true }).expect(200);
    await backdate(doc.id);
    await put(DAVE, `/${doc.id}/content`, { content: 'owner edits', base_revision: rev.v5 }).expect(200);
    await settle(() => notifications.create.mock.calls.length >= 1);
    expect(notifications.create.mock.calls.map(c => [c[0].userEmail, c[0].type])).toEqual([[OTHER.email, 'document_edited']]);
    const v6 = (await get(DAVE, `/${doc.id}/text`)).body.revision;
    await put(DAVE, `/${doc.id}/content`, { content: 'owner edits more', base_revision: v6 }).expect(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(notifications.create).toHaveBeenCalledTimes(1); // the same sitting
    // someone else's first save: the owner hears, the follower who did it does not
    notifications.create.mockClear(); emailEvents.send.mockClear();
    const v7 = (await get(OTHER, `/${doc.id}/text`)).body.revision;
    await put(OTHER, `/${doc.id}/content`, { content: 'a colleague edits', base_revision: v7 }).expect(200);
    await settle(() => notifications.create.mock.calls.length >= 1);
    expect(notifications.create.mock.calls.map(c => [c[0].userEmail, c[0].type])).toEqual([[DAVE.email, 'document_edited']]);
    expect(emailEvents.send.mock.calls.map(c => [c[0], c[1].to])).toEqual([['document_edited', DAVE.email]]);
  });

  test('a file too big to edit here comes back cut and read-only; a viewer may not save at all', async () => {
    const big = 'x'.repeat(500001);
    await put(DAVE, `/${doc.id}/content`, { content: big, force: true }).expect(200);
    const t = await get(DAVE, `/${doc.id}/text`).expect(200);
    expect(t.body).toMatchObject({ too_big: true, can_edit: false, size: 500001 });
    expect(t.body.content).toHaveLength(500000);
    expect((await put(VIEW, `/${doc.id}/content`, { content: 'x' })).status).toBe(403);
  });
});
