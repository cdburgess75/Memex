'use strict';
// "My links" and link revocation (piece 3, part 6) against a REAL, THROWAWAY Postgres,
// over the same seeded scenarios as the access suites:
//   - scope=mine lists exactly the links the caller made (live, paused, expired, revoked);
//     scope=all, for an admin, every link;
//   - each link's state is what redeeming it really does: the file link's
//     /share/:token/info answers 200 when 'active', 410 when 'expired', 404 otherwise; a
//     folder link's ZIP opens when 'active', with exactly `serving` files in it;
//   - a file the caller can no longer open is named only as that (name_hidden);
//   - a writer who doesn't manage a file sees only their own links on it;
//   - every can_revoke in the "who has access" lists is what the revoke routes do.
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test". LINK_SEEDS sets the number of scenarios (default 4).
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(600000);
const SEEDS = process.env.LINK_SEED ? [Number(process.env.LINK_SEED)]
  : Array.from({ length: Number(process.env.LINK_SEEDS) || 4 }, (_, i) => 3000 + i);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async () => {}), download: jest.fn(async () => Buffer.alloc(0)), copy: jest.fn(async () => {}), del: jest.fn(async () => {}),
  downloadStream: jest.fn(async () => ({ stream: require('stream').Readable.from([Buffer.from('bytes')]), length: 5 })),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(), localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));

const { scenario, load, levelsOn, asClient } = require('./helpers/accessScenario');
const ZIP_ENTRY = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

suite('My links and revocation against real Postgres', () => {
  let db, documentAccess, accessKeys, libraries, linkList, request, app, jwt, tokenHash;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    documentAccess = require('../../lib/documentAccess');
    accessKeys = require('../../lib/accessKeys');
    libraries = require('../../lib/libraries');
    linkList = require('../../lib/linkList');
    tokenHash = require('../../lib/shareLinks').tokenHash;
    jwt = require('jsonwebtoken');
    jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/files', require('../../routes/files'));
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const as = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: !!a.verified }); return request(app); };
  const authed = (r) => r.set('Authorization', 'Bearer t');
  const zip = (r) => r.buffer(true).parse((res, cb) => { const b = []; res.on('data', c => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
  const entries = (buf) => { let n = 0; for (let i = buf.indexOf(ZIP_ENTRY); i >= 0; i = buf.indexOf(ZIP_ENTRY, i + 4)) n++; return n; };

  test.each(SEEDS)('scenario %i', async (seed) => {
    const s = scenario(seed);
    await load(db, s, { tokenHash });
    const where = (x) => `seed ${seed}, ${x}`;
    const fileRedeem = new Map();
    const redeem = async (l) => {
      if (!fileRedeem.has(l.id)) fileRedeem.set(l.id, (await request(app).get(`/api/files/share/${l.token}/info`)).status);
      return fileRedeem.get(l.id);
    };
    const folderRedeem = new Map();
    const redeemFolder = async (f) => {
      if (!folderRedeem.has(f.id)) {
        const res = await zip(request(app).get(`/api/files/folder/share/${f.token}`));
        folderRedeem.set(f.id, { status: res.status, entries: res.status === 200 ? entries(res.body) : 0 });
      }
      return folderRedeem.get(f.id);
    };
    const levels = new Map();
    const onFile = async (id) => { if (!levels.has(id)) levels.set(id, await levelsOn(documentAccess, asClient(db), id)); return levels.get(id); };
    const byToken = new Map([...s.fileLinks.map(l => [l.id, l]), ...s.folderLinks.map(f => [f.id, f])]);

    const writers = s.accounts.filter(a => (a.role === 'admin' || a.role === 'contributor') && a.verified === a.verified?.toLowerCase());
    const states = new Set();
    for (const a of writers) {
      const who = await documentAccess.resolveActor(a.id);
      const res = await authed(as(a).get('/api/files/shares'));
      expect(res.status).toBe(200);
      const { shares, folder_links: folders } = res.body;
      expect([where(a.email), res.body.scope]).toEqual([where(a.email), 'mine']);
      // exactly the links they made
      expect(shares.map(x => x.id).sort()).toEqual(s.fileLinks.filter(l => l.by.id === a.id).map(l => l.id).sort());
      expect(folders.map(x => x.id).sort()).toEqual(s.folderLinks.filter(l => l.by.id === a.id).map(l => l.id).sort());
      for (const x of shares) {
        states.add(x.state);
        const l = byToken.get(x.id);
        const status = await redeem(l);
        const want = { active: 200, expired: 410 }[x.state] || 404;
        expect([where(`link ${x.id} (${x.state})`), status]).toEqual([where(`link ${x.id} (${x.state})`), want]);
        const canRead = !!(await onFile(l.doc.id)).get(a.id);
        expect([where(`link ${x.id} name`), x.name_hidden, x.document_name === null]).toEqual([where(`link ${x.id} name`), !canRead, !canRead]);
        expect(x.created_by_me).toBe(true);
      }
      for (const x of folders) {
        const f = byToken.get(x.id);
        const r = await redeemFolder(f);
        if (x.state === 'active') expect([where(`folder ${x.id}`), r.status, r.entries]).toEqual([where(`folder ${x.id}`), 200, x.serving]);
        else expect([where(`folder ${x.id} (${x.state})`), r.status]).toEqual([where(`folder ${x.id} (${x.state})`), x.state === 'expired' ? 410 : 404]);
      }
      // scope=all: admins only
      const all = await authed(as(a).get('/api/files/shares?scope=all'));
      if (a.role === 'admin') {
        expect(all.status).toBe(200);
        expect(all.body.shares.map(x => x.id).sort()).toEqual(s.fileLinks.map(l => l.id).sort());
        expect(all.body.folder_links.map(x => x.id).sort()).toEqual(s.folderLinks.map(l => l.id).sort());
      } else expect([where(a.email), all.status, all.body.code]).toEqual([where(a.email), 403, 'ADMIN_ONLY']);

      // a file's own link list: everyone's to whoever manages it; your own otherwise
      for (const d of [...new Set(s.fileLinks.map(l => l.doc))].filter(x => !x.deleted)) {
        const lvl = (await onFile(d.id)).get(a.id);
        const list = await authed(as(a).get(`/api/files/${d.id}/shares`));
        if (lvl !== 'write' && lvl !== 'admin') { expect([where(d.name), list.status]).toEqual([where(d.name), 404]); continue; }
        const mine = s.fileLinks.filter(l => l.doc === d && (lvl === 'admin' || l.by.id === a.id)).map(l => l.id).sort();
        expect([where(`${a.email} ${d.name}`), list.body.shares.map(x => x.id).sort()]).toEqual([where(`${a.email} ${d.name}`), mine]);
      }
      void who;
    }

    // the scenario really exercised working and non-working links
    expect([where('states seen'), states.has('active'), [...states].some(x => x !== 'active')]).toEqual([where('states seen'), true, true]);

    // Every Revoke the "who has access" lists offer is one the routes allow, and the
    // other way round (last: it revokes for real).
    const accounting = s.libraries[0];
    const owner = s.accounts.find(a => a.id === accounting.owner.id);
    const ownerActor = await documentAccess.resolveActor(owner.id);
    const listed = await libraries.visibleLibraryRow(ownerActor, accounting.id);
    const resp = await accessKeys.libraryDoor(ownerActor, { library: libraries.shapeLibrary(ownerActor, listed), listed, path: '', manager: true });
    // (the planted folder link, over a file the owner can't edit, is one they may not revoke)
    const planted = s.folderLinks.at(-1);
    expect([where('planted link listed'), resp.links.find(l => l.id === planted.id)?.can_revoke]).toEqual([where('planted link listed'), false]);
    for (const l of resp.links) {
      const url = l.kind === 'folder' ? `/api/files/folder/links/${l.id}` : `/api/files/${l.document_id}/shares/${l.id}`;
      const res = await authed(as(owner).delete(url));
      expect([where(`revoke ${l.ref}`), res.status === 200]).toEqual([where(`revoke ${l.ref}`), l.can_revoke]);
    }
    // a link's creator can always revoke it, even once it has paused
    const paused = s.fileLinks.find(l => !l.revoked && l.by.role && writers.includes(l.by));
    if (paused) {
      const res = await authed(as(paused.by).delete(`/api/files/${paused.doc.id}/shares/${paused.id}`));
      expect([where('creator revokes'), [200, 404].includes(res.status)]).toEqual([where('creator revokes'), true]);
      const row = await db.queryOne('SELECT revoked_at FROM document_share_links WHERE id = $1', [paused.id]);
      expect([where('creator revoked'), !!row.revoked_at]).toEqual([where('creator revoked'), true]);
    }
  });

  test('the revoke routes refuse strangers and malformed ids without touching anything', async () => {
    const s = scenario(3999);
    await load(db, s, { tokenHash });
    const stranger = s.accounts.find(a => a.email === 'c5@acme.test');
    const link = s.fileLinks.find(l => !l.revoked && l.by.id !== stranger.id);
    const lvl = (await levelsOn(documentAccess, asClient(db), link.doc.id)).get(stranger.id);
    const res = await authed(as(stranger).delete(`/api/files/${link.doc.id}/shares/${link.id}`));
    const expected = lvl === 'write' || lvl === 'admin' ? 200 : 404;
    expect(res.status).toBe(expected);
    const row = await db.queryOne('SELECT revoked_at FROM document_share_links WHERE id = $1', [link.id]);
    expect(!!row.revoked_at).toBe(expected === 200);
    expect((await authed(as(stranger).delete('/api/files/not-a-uuid/shares/also-not'))).status).toBe(404);
    expect((await authed(as(stranger).delete('/api/files/folder/links/not-a-uuid'))).status).toBe(404);
  });
});
