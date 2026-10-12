'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-api2-pg-'));
// The public API, release 2 -- people, groups, sharing and administration -- through the
// real routers against a REAL, THROWAWAY Postgres. Tokens are made from the app, then used
// for everything an admin job or an integration would do. DROPS AND RECREATES the public
// schema; refuses to run unless the database name contains "test".
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
const mockBlobs = new Map();
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async (p, buf) => { mockBlobs.set(p, Buffer.from(buf)); }),
  uploadStream: jest.fn(async (p, readable) => { const b = []; for await (const c of readable) b.push(c); const buf = Buffer.concat(b); mockBlobs.set(p, buf); return { size: buf.length }; }),
  download: jest.fn(async (p) => mockBlobs.get(p) || Buffer.alloc(0)),
  downloadStream: jest.fn(async (p) => { const buf = mockBlobs.get(p) || Buffer.alloc(0); return { stream: require('stream').Readable.from([buf]), length: buf.length, totalSize: buf.length }; }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }), copy: jest.fn(async () => {}),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(async () => 'http://x/url'), localBase: jest.fn(async () => require('os').tmpdir()), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
// Mail is answered, never sent; the sign-in server is not asked to mirror the brand.
const mockMail = [];
jest.mock('../../lib/email', () => ({
  sendMail: jest.fn(async (m) => { mockMail.push(m); return { sent: true, via: 'test' }; }),
  actingAs: (u) => ({ label: u.email, sendAs: u.email }),
  isConfigured: async () => false,
}));
jest.mock('../../lib/keycloakAdmin', () => ({ setRealmDisplayName: jest.fn(async () => ({})), getBrokerToken: jest.fn(async () => null) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn(async (buf) => buf.toString('utf8').slice(0, 1000)) }));

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const DAVE = { id: U(1), email: 'dave@corp.test' }, VIEW = { id: U(2), email: 'viewer@corp.test' }, ADMIN = { id: U(3), email: 'admin@corp.test' };
const OTHER = { id: U(4), email: 'other@corp.test' }, NEWBIE = { id: U(5), email: 'newbie@corp.test' };
const LIB = U(50), ORPHAN = U(51), LEAVER = U(52);

suite('the public API, release 2', () => {
  let db, request, app, jwt, tokens = {};
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const asSession = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: true }); return 'Bearer session'; };
  const api = (tok) => ({
    get: (p) => request(app).get('/api/v1' + p).set('Authorization', `Bearer ${tok}`),
    post: (p, body) => request(app).post('/api/v1' + p).set('Authorization', `Bearer ${tok}`).send(body),
    patch: (p, body) => request(app).patch('/api/v1' + p).set('Authorization', `Bearer ${tok}`).send(body),
    putJson: (p, body) => request(app).put('/api/v1' + p).set('Authorization', `Bearer ${tok}`).send(body),
    del: (p, body) => request(app).delete('/api/v1' + p).set('Authorization', `Bearer ${tok}`).send(body),
    put: (p, bytes, type = 'application/octet-stream') => request(app).put('/api/v1' + p).set('Authorization', `Bearer ${tok}`).set('Content-Type', type).send(bytes),
  });

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    for (const [a, role] of [[DAVE, 'contributor'], [VIEW, 'viewer'], [ADMIN, 'admin'], [OTHER, 'contributor'], [NEWBIE, 'viewer']]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [a.id, a.email, role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Projects', DAVE.id, DAVE.email]);
    await db.query('INSERT INTO libraries (id, name) VALUES ($1, $2)', [ORPHAN, 'Old shared drive']);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email, personal) VALUES ($1, $2, $3, $4, false)', [LEAVER, 'Leaver files', NEWBIE.id, NEWBIE.email]);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    const API_FILE_BODY = /^\/api\/v1\/(libraries\/[^/]+\/files\/|uploads\/[^/]+\/chunks\/)/;
    app.use(express.json({ limit: '1mb', type: (req) => !(req.method === 'PUT' && API_FILE_BODY.test(req.path)) && /^application\/(.+\+)?json/i.test(String(req.headers['content-type'] || '')) }));
    app.use('/api/tokens', require('../../routes/tokens'));
    app.get('/api/v1/openapi.json', (_req, res) => res.json(require('../../lib/openapi').spec()));
    app.use('/api/docs', require('../../routes/docs'));
    app.use('/api/v1', require('../../routes/v1'));
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  test('tokens are made from the app: a contributor\'s write and read, an administrator\'s admin and read', async () => {
    const mk = async (who, name, scope) => { const r = await request(app).post('/api/tokens').set('Authorization', asSession(who)).send({ name, scope }); expect(r.status).toBe(201); return r.body; };
    tokens.write = (await mk(DAVE, 'Importer', 'write')).token;
    tokens.read = (await mk(DAVE, 'Reports', 'read')).token;
    tokens.admin = (await mk(ADMIN, 'Ops', 'admin')).token;
    tokens.adminRead = (await mk(ADMIN, 'Ops read', 'read')).token;
    const other = await mk(OTHER, 'Other', 'write'); tokens.other = other.token; tokens.otherId = other.id;
  });

  test('scope: people and administration take an admin token; an administrator\'s read token is not one', async () => {
    const w = await api(tokens.write).get('/users');
    expect(w.status).toBe(403); expect(w.body.error).toMatch(/write scope; this needs admin/);
    expect((await api(tokens.adminRead).get('/admin/settings')).status).toBe(403);
    expect((await api(tokens.adminRead).get('/users')).status).toBe(403);
    expect((await api(tokens.read).post('/groups', { name: 'x' })).status).toBe(403);
    expect((await api(tokens.write).putJson(`/libraries/${LIB}/archived`, { archived: true })).status).toBe(403);
    expect((await api(tokens.read).post(`/libraries/${LIB}/shares`, { email: VIEW.email, permission: 'read' })).status).toBe(403);
  });

  // ---- people ----
  test('people: list, find by address, change a role, switch off and on, what only they can do', async () => {
    const all = await api(tokens.admin).get('/users').expect(200);
    expect(all.body.users.map(u => u.email)).toEqual([ADMIN.email, DAVE.email, NEWBIE.email, OTHER.email, VIEW.email]);
    expect(all.body.users.find(u => u.email === DAVE.email)).toMatchObject({ user_id: DAVE.id, role: 'contributor', disabled_at: null });
    expect((await api(tokens.admin).get('/users?q=new').expect(200)).body.users.map(u => u.email)).toEqual([NEWBIE.email]);
    expect((await api(tokens.admin).get(`/users/${NEWBIE.email}`).expect(200)).body.user_id).toBe(NEWBIE.id);
    expect((await api(tokens.admin).get(`/users/${NEWBIE.id}`).expect(200)).body.email).toBe(NEWBIE.email);
    expect((await api(tokens.admin).get('/users/nobody@corp.test')).status).toBe(404);
    expect((await api(tokens.admin).get(`/users/${U(77)}`)).status).toBe(404);
    expect((await api(tokens.admin).get('/users/what')).status).toBe(404);
    // a role
    expect((await api(tokens.admin).putJson(`/users/${NEWBIE.id}/role`, { role: 'contributor' }).expect(200)).body).toEqual({ role: 'contributor' });
    expect((await api(tokens.admin).get(`/users/${NEWBIE.id}`)).body.role).toBe('contributor');
    expect((await api(tokens.admin).putJson(`/users/${NEWBIE.id}/role`, { role: 'boss' })).status).toBe(400);
    // a mistyped id makes no account (the app's own route would)
    expect((await api(tokens.admin).putJson(`/users/${U(77)}/role`, { role: 'viewer' })).status).toBe(404);
    expect((await db.queryOne('SELECT count(*)::int AS n FROM user_roles')).n).toBe(5);
    // off, and on again
    expect((await api(tokens.admin).putJson(`/users/${ADMIN.id}/disabled`, { disabled: true })).status).toBe(400);
    const off = await api(tokens.admin).putJson(`/users/${NEWBIE.email}/disabled`, { disabled: true, reason: 'left the company' }).expect(200);
    expect(off.body).toMatchObject({ user_id: NEWBIE.id, disabled_reason: 'left the company', own_library_archived: true });
    expect(off.body.disabled_at).not.toBeNull();
    expect((await api(tokens.admin).get(`/users/${NEWBIE.id}`)).body.disabled_at).not.toBeNull();
    const on = await api(tokens.admin).putJson(`/users/${NEWBIE.id}/disabled`, { disabled: false }).expect(200);
    expect(on.body.disabled_at).toBeNull();
    const dep = await api(tokens.admin).get(`/users/${NEWBIE.id}/departure`).expect(200);
    expect(dep.body.user).toMatchObject({ user_id: NEWBIE.id, email: NEWBIE.email, role: 'contributor' });
    expect(dep.body.owns_libraries.map(l => l.name)).toContain('Leaver files');
    expect(dep.body).toMatchObject({ live_file_links: 0, live_folder_links: 0, shares_to_them: 0, personal_files: 0 });
  });

  // ---- groups ----
  let groupId;
  test('groups: make, rename, add and remove someone, hand it over, delete; members see it, outsiders do not', async () => {
    const made = await api(tokens.write).post('/groups', { name: 'Accounting' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Accounting', owner_email: DAVE.email, can_manage: true, member_count: 0 });
    groupId = made.body.id;
    expect((await api(tokens.write).post('/groups', { name: 'Accounting' })).status).toBe(409);
    expect((await api(tokens.write).post('/groups', { name: '' })).status).toBe(400);
    expect((await api(tokens.read).get('/groups').expect(200)).body.map(g => g.name)).toEqual(['Accounting']);
    expect((await api(tokens.write).patch(`/groups/${groupId}`, { name: 'Finance' }).expect(200)).body.name).toBe('Finance');
    const added = await api(tokens.write).post(`/groups/${groupId}/members`, { email: OTHER.email });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ member_email: OTHER.email, already_member: false });
    expect((await api(tokens.write).post(`/groups/${groupId}/members`, { email: OTHER.email })).status).toBe(200);
    expect((await api(tokens.write).post(`/groups/${groupId}/members`, { email: 'not an address' })).status).toBe(400);
    const members = await api(tokens.read).get(`/groups/${groupId}/members`).expect(200);
    expect(members.body).toHaveLength(1);
    expect(members.body[0]).toMatchObject({ id: added.body.id, member_email: OTHER.email, has_signed_in: true });
    expect((await api(tokens.read).get(`/groups/${groupId}`).expect(200)).body).toMatchObject({ name: 'Finance', owner_email: DAVE.email, can_manage: true, share_count: 0 });
    // a member sees the group and who is in it, and may not change it
    expect((await api(tokens.other).get(`/groups/${groupId}`).expect(200)).body.can_manage).toBe(false);
    expect((await api(tokens.other).patch(`/groups/${groupId}`, { name: 'Mine' })).status).toBe(403);
    expect(Object.keys((await api(tokens.other).get(`/groups/${groupId}/members`).expect(200)).body[0]).sort()).toEqual(['display_name', 'member_email']);
    // ids that are nothing
    expect((await api(tokens.read).get(`/groups/${U(88)}`)).status).toBe(404);
    expect((await api(tokens.read).get('/groups/not-an-id')).status).toBe(404);
    expect((await api(tokens.write).del(`/groups/${groupId}/members/not-an-id`)).status).toBe(404);
    await api(tokens.write).del(`/groups/${groupId}/members/${added.body.id}`).expect(200);
    expect((await api(tokens.read).get(`/groups/${groupId}/members`)).body).toEqual([]);
    // handed over, the old owner is nobody to it
    expect((await api(tokens.write).putJson(`/groups/${groupId}/owner`, { email: OTHER.email }).expect(200)).body.owner_email).toBe(OTHER.email);
    expect((await api(tokens.write).del(`/groups/${groupId}`)).status).toBe(404);
    await api(tokens.other).del(`/groups/${groupId}`).expect(200);
    expect((await api(tokens.other).get(`/groups/${groupId}`)).status).toBe(404);
  });

  // ---- sharing ----
  let fileId, shareId;
  test('sharing: a library with a person, a folder with a group; the recipient gets in; change the level, send the mail again, end it', async () => {
    const up = await api(tokens.write).put(`/libraries/${LIB}/files/Shared/plan.txt`, Buffer.from('the plan\n')).expect(200);
    fileId = up.body.doc.id;
    expect((await api(tokens.other).get(`/files/${fileId}`)).status).toBe(404);
    const made = await api(tokens.write).post(`/libraries/${LIB}/shares`, { email: OTHER.email, permission: 'read' });
    expect(made.status).toBe(201);
    expect(made.body.share).toMatchObject({ library_id: LIB, folder_path: '', subject_type: 'user', subject_email: OTHER.email, permission: 'read', account: 'ok', group: null });
    shareId = made.body.share.id;
    expect((await api(tokens.other).get(`/files/${fileId}`)).status).toBe(200);
    const mine = await api(tokens.other).get('/shared-with-me').expect(200);
    expect(mine.body.libraries.map(l => l.library.id)).toEqual([LIB]);
    expect(mine.body.libraries[0].level).toBe('read');
    expect((await api(tokens.other).put(`/libraries/${LIB}/files/Shared/theirs.txt`, Buffer.from('x'))).status).toBeGreaterThanOrEqual(400);
    expect((await api(tokens.write).patch(`/libraries/${LIB}/shares/${shareId}`, { permission: 'write' }).expect(200)).body.share.permission).toBe('write');
    expect((await api(tokens.other).put(`/libraries/${LIB}/files/Shared/theirs.txt`, Buffer.from('x'))).status).toBe(200);
    expect((await api(tokens.write).patch(`/libraries/${LIB}/shares/${shareId}`, { permission: 'all' })).status).toBe(400);
    expect((await api(tokens.write).post(`/libraries/${LIB}/shares/${shareId}/resend`, {}).expect(200)).body.sent).toBe(true);
    expect(mockMail.at(-1)).toMatchObject({ to: OTHER.email });
    // a folder, with a group
    const g = await api(tokens.write).post('/groups', { name: 'Readers' });
    await api(tokens.write).post(`/groups/${g.body.id}/members`, { email: VIEW.email }).expect(201);
    const fshare = await api(tokens.write).post(`/libraries/${LIB}/shares`, { group_id: g.body.id, permission: 'read', folder: 'Shared' });
    expect(fshare.status).toBe(201);
    expect(fshare.body.share).toMatchObject({ folder_path: 'Shared', subject_type: 'group', subject_email: null, group: { id: g.body.id, name: 'Readers', member_count: 1 }, folder_present: true });
    expect((await api(tokens.write).post(`/libraries/${LIB}/shares`, { group_id: g.body.id, permission: 'read', folder: 'Shared' })).status).toBe(409);
    expect((await api(tokens.write).post(`/libraries/${LIB}/shares`, { email: OTHER.email, group_id: g.body.id, permission: 'read' })).status).toBe(400);
    expect((await api(tokens.write).post(`/libraries/${LIB}/shares`, { email: OTHER.email, permission: 'read', folder: 'Nowhere' })).status).toBe(404);
    expect((await api(tokens.write).post(`/libraries/${U(89)}/shares`, { email: OTHER.email, permission: 'read' })).status).toBe(404);
    const list = await api(tokens.read).get(`/libraries/${LIB}/shares`).expect(200);
    expect(list.body.library.id).toBe(LIB);
    expect(list.body.shares.map(s => [s.folder_path, s.subject_type])).toEqual([['', 'user'], ['Shared', 'group']]);
    expect(Array.isArray((await api(tokens.read).get(`/libraries/${LIB}/shares?folder=Shared`).expect(200)).body.ended_shares)).toBe(true);
    expect((await api(tokens.read).get(`/groups/${g.body.id}`)).body.share_count).toBe(1);
    // only whoever manages the library sees its shares
    expect((await api(tokens.other).get(`/libraries/${LIB}/shares`)).status).toBe(403);
    // who can open it, and why
    const door = await api(tokens.read).get(`/libraries/${LIB}/access`).expect(200);
    expect(door.body).toMatchObject({ can_see_keys: true, door: { kind: 'library', library: { id: LIB } } });
    expect(Array.isArray(door.body.people)).toBe(true); expect(Array.isArray(door.body.keys)).toBe(true);
    expect(JSON.stringify(door.body)).toContain(OTHER.email);
    expect((await api(tokens.read).get(`/libraries/${LIB}/access?folder=Shared`).expect(200)).body.door.kind).toBe('folder');
    expect((await api(tokens.read).get(`/libraries/${LIB}/access?folder=Nowhere`)).status).toBe(404);
    expect((await api(tokens.read).get(`/files/${fileId}/access`).expect(200)).body.you).toBeTruthy();
    // a single file, to a person
    const grant = await api(tokens.write).putJson(`/files/${fileId}/grants`, { email: VIEW.email, permission: 'read' }).expect(200);
    expect(grant.body.grant).toMatchObject({ document_id: fileId, subject_email: VIEW.email, permission: 'read' });
    expect((await api(tokens.write).putJson(`/files/${fileId}/grants`, { email: VIEW.email, permission: 'owner' })).status).toBe(400);
    expect((await api(tokens.read).get(`/files/${fileId}/grants`).expect(200)).body.grants.map(x => x.id)).toEqual([grant.body.grant.id]);
    expect((await api(tokens.write).post(`/files/${fileId}/grants/resend`, { email: VIEW.email }).expect(200)).body.sent).toBe(true);
    expect((await api(tokens.write).post(`/files/${fileId}/grants/resend`, { email: 'nobody@corp.test' })).status).toBe(404);
    await api(tokens.write).del(`/files/${fileId}/grants/${grant.body.grant.id}`).expect(200);
    expect((await api(tokens.read).get(`/files/${fileId}/grants`)).body.grants).toEqual([]);
    expect((await api(tokens.write).del(`/files/${fileId}/grants/not-an-id`)).status).toBe(404);
    // ending the share closes the door
    await api(tokens.write).del(`/libraries/${LIB}/shares/${shareId}`).expect(200);
    expect((await api(tokens.other).get(`/files/${fileId}`)).status).toBe(404);
    expect((await api(tokens.write).del(`/libraries/${LIB}/shares/${shareId}`)).status).toBe(404);
  });

  // ---- libraries ----
  test('libraries: give an ownerless one an owner, put one away, hand a leaver\'s to someone, hand your own files to a library', async () => {
    const owned = await api(tokens.admin).post(`/libraries/${ORPHAN}/owner`, { owner_email: DAVE.email }).expect(200);
    expect(owned.body).toMatchObject({ id: ORPHAN, owner_id: DAVE.id, owner_email: DAVE.email });
    expect((await api(tokens.admin).post(`/libraries/${ORPHAN}/owner`, { owner_email: OTHER.email })).status).toBe(409);
    expect((await api(tokens.admin).post(`/libraries/${U(89)}/owner`, { owner_email: OTHER.email })).status).toBe(404);
    expect((await api(tokens.admin).post('/libraries/nope/owner', { owner_email: OTHER.email })).status).toBe(404);
    expect((await api(tokens.read).get('/libraries')).body.libraries.map(l => l.id)).toContain(ORPHAN);
    const away = await api(tokens.admin).putJson(`/libraries/${ORPHAN}/archived`, { archived: true }).expect(200);
    expect(away.body.archived_at).not.toBeNull();
    expect((await api(tokens.read).get('/libraries')).body.libraries.map(l => l.id)).not.toContain(ORPHAN);
    expect((await api(tokens.admin).putJson(`/libraries/${ORPHAN}/archived`, { archived: false }).expect(200)).body.archived_at).toBeNull();
    // a leaver's library
    const still = await api(tokens.admin).post(`/libraries/${LEAVER}/reassign`, { owner_email: OTHER.email });
    expect(still.status).toBe(409); expect(still.body.code).toBe('OWNER_STILL_HERE');
    await api(tokens.admin).putJson(`/users/${NEWBIE.id}/disabled`, { disabled: true, reason: 'left' }).expect(200);
    const re = await api(tokens.admin).post(`/libraries/${LEAVER}/reassign`, { owner_email: OTHER.email }).expect(200);
    expect(re.body).toMatchObject({ id: LEAVER, owner_email: OTHER.email, personal: false });
    await api(tokens.admin).putJson(`/users/${NEWBIE.id}/disabled`, { disabled: false }).expect(200);
    // adopt: a file that is still the uploader's alone becomes the library's
    await db.query('UPDATE documents SET library_scoped = false WHERE id = $1', [fileId]);
    expect((await api(tokens.read).get(`/files/${fileId}`)).body.library_content).toBe(false);
    expect((await api(tokens.write).post(`/libraries/${LIB}/adopt`, { folder: 'Shared' }).expect(200)).body).toMatchObject({ ok: true, count: 1 });
    expect((await api(tokens.read).get(`/files/${fileId}`)).body.library_content).toBe(true);
    expect((await api(tokens.write).post(`/libraries/${LIB}/adopt`, {}).expect(200)).body.count).toBe(0);
  });

  // ---- administration ----
  test('administration: settings without the app-only keys, the editing switch, the lists and exports, tokens, connections, the host', async () => {
    const s = await api(tokens.admin).get('/admin/settings').expect(200);
    for (const k of ['brand_name', 'max_upload_mb', 'api_token_rate_limit', 'trash_retention_days', 'smtp_host', 'storage_provider']) expect(k in s.body).toBe(true);
    for (const k of ['storage_encryption_key', 'login_ms365_enabled', 'login_ldap_url', 'backup_destinations', 'backup_enabled', 'backup_download_secret']) expect(k in s.body).toBe(false);
    expect(Object.keys(s.body).length).toBeGreaterThan(50);
    expect((await api(tokens.admin).patch('/admin/settings', { trash_retention_days: '45' }).expect(200)).body).toEqual({ ok: true });
    expect((await api(tokens.admin).get('/admin/settings')).body.trash_retention_days).toBe('45');
    for (const body of [{ login_ldap_enabled: 'true' }, { storage_encryption_key: 'x' }, { backup_enabled: 'true' }, { confirm_key_change: true, brand_name: 'x' }]) {
      const r = await api(tokens.admin).patch('/admin/settings', body);
      expect(r.status).toBe(400); expect(r.body.error).toMatch(/Changed in Depot itself/);
    }
    const unknown = await api(tokens.admin).patch('/admin/settings', { nonsense: '1' });
    expect(unknown.status).toBe(400); expect(unknown.body.error).toBe('Not a setting: nonsense');
    expect((await api(tokens.admin).patch('/admin/settings', {})).status).toBe(400);
    expect((await api(tokens.admin).get('/admin/settings')).body.brand_name).toBe('');
    // the editing switch
    expect((await api(tokens.admin).get('/admin/editor').expect(200)).body).toMatchObject({ enabled: false, state: 'off', running: false });
    expect((await api(tokens.admin).putJson('/admin/editor', { enabled: 'yes' })).status).toBe(400);
    expect((await api(tokens.admin).putJson('/admin/editor', { enabled: true }).expect(200)).body.enabled).toBe(true);
    expect((await api(tokens.admin).putJson('/admin/editor', { enabled: false }).expect(200)).body).toMatchObject({ enabled: false, state: 'off' });
    // the lists
    const files = await api(tokens.admin).get('/admin/files?q=plan').expect(200);
    expect(files.body.matched).toBe(1); expect(files.body.files[0].name).toBe('Shared/plan.txt'); expect(files.body.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray((await api(tokens.admin).get('/admin/stats').expect(200)).body.recentActivity)).toBe(true);
    expect((await api(tokens.admin).get('/admin/usage').expect(200)).body.thisMonth).toBeTruthy();
    const act = await api(tokens.admin).get('/admin/activity?event=uploaded').expect(200);
    expect(act.body.events.length).toBeGreaterThanOrEqual(2); expect(act.body.eventTypes).toContain('uploaded');
    expect(act.body.events.every(e => e.event_type === 'uploaded')).toBe(true);
    const csv = await api(tokens.admin).get('/admin/activity.csv?event=uploaded').expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/); expect(csv.text.split('\n')[0]).toBe('timestamp,event,actor,document,detail');
    // compliance
    expect(Array.isArray((await api(tokens.admin).get('/admin/compliance').expect(200)).body.frameworks)).toBe(true);
    expect((await api(tokens.admin).patch('/admin/compliance', { enabled: { soc2: true } }).expect(200)).body.ok).toBe(true);
    expect((await api(tokens.admin).get('/admin/compliance')).body.frameworks.find(f => f.id === 'soc2').enabled).toBe(true);
    expect((await api(tokens.admin).putJson('/admin/compliance/attest', { control_id: 'nope', met: true })).status).toBe(400);
    expect((await api(tokens.admin).get('/admin/compliance/audit-verify').expect(200)).body.ok).toBe(true);
    const review = await api(tokens.admin).get('/admin/access-review').expect(200);
    expect(review.body.users.map(u => u.email)).toContain(DAVE.email);
    expect((await api(tokens.admin).get('/admin/access-review.csv').expect(200)).headers['content-type']).toMatch(/text\/csv/);
    // tokens: every live one, and revoking any
    const toks = await api(tokens.admin).get('/admin/tokens').expect(200);
    expect(toks.body.tokens.find(t => t.name === 'Importer')).toMatchObject({ user_email: DAVE.email, scope: 'write' });
    expect(JSON.stringify(toks.body)).not.toContain(tokens.write.slice(12));
    expect((await api(tokens.admin).del('/admin/tokens/not-an-id')).status).toBe(404);
    expect((await api(tokens.admin).del(`/admin/tokens/${U(66)}`)).status).toBe(404);
    await api(tokens.admin).del(`/admin/tokens/${tokens.otherId}`).expect(200);
    expect((await api(tokens.other).get('/me')).status).toBe(401);
    // connections
    expect((await api(tokens.admin).get('/admin/connectors').expect(200)).body).toEqual({ connectors: [] });
    expect((await api(tokens.admin).get('/admin/connectors/kinds').expect(200)).body.kinds.map(k => k.kind).sort()).toEqual(['sharepoint', 'smb']);
    const missing = await api(tokens.admin).post('/admin/connectors', { kind: 'smb', name: 'Scans' });
    expect(missing.status).toBe(400); expect(missing.body.error).toMatch(/missing required/);
    expect((await api(tokens.admin).patch(`/admin/connectors/${U(90)}`, { name: 'x' })).status).toBe(404);
    expect((await api(tokens.admin).del('/admin/connectors/nope')).status).toBe(404);
    // the host
    expect(typeof (await api(tokens.admin).get('/admin/license').expect(200)).body.configured).toBe('boolean');
    expect((await api(tokens.admin).get('/admin/security').expect(200)).body.level).toBeTruthy();
  });

  test('every change is on the record as the person, marked with the token', async () => {
    const rows = await db.query(`SELECT event_type, actor_email, detail FROM document_events WHERE detail LIKE '%via token "%' ORDER BY chain_seq`);
    const by = (name) => new Set(rows.filter(r => r.detail.includes(`via token "${name}"`)).map(r => r.event_type));
    for (const k of ['group_created', 'group_renamed', 'group_member_added', 'group_member_removed', 'group_owner_changed', 'library_shared', 'library_share_changed', 'library_unshared', 'access_granted', 'access_revoked']) expect(by('Importer')).toContain(k);
    for (const k of ['role_changed', 'settings_changed', 'library_created', 'api_token_revoked']) expect(by('Ops')).toContain(k);
    expect(rows.filter(r => r.detail.includes('via token "Importer"')).every(r => r.actor_email === DAVE.email)).toBe(true);
    expect(rows.filter(r => r.detail.includes('via token "Ops"')).every(r => r.actor_email === ADMIN.email)).toBe(true);
  });

  test('the reference describes the new areas', async () => {
    const docs = await request(app).get('/api/docs').expect(200);
    for (const s of ['id="people"', 'id="groups"', 'id="sharing"', 'id="administration"', '/api/v1/users/{id}/disabled', '/api/v1/admin/settings', '/api/v1/libraries/{id}/shares']) expect(docs.text).toContain(s);
    const spec = await request(app).get('/api/v1/openapi.json').expect(200);
    expect(spec.body.tags.map(t => t.name)).toEqual(expect.arrayContaining(['People', 'Groups', 'Sharing', 'Administration']));
    expect(spec.body.components.schemas.Share).toBeTruthy();
  });
});
