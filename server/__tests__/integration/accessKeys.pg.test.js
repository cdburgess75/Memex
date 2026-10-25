'use strict';
// Who can get in, and why (piece 3) against a REAL, THROWAWAY Postgres: seeded random
// scenarios, each checked against the access rule itself. This part covers Shared with
// me (property P5):
//   - sound: every level it reports is documentAccess.condition() -- for a library or
//     folder, on a real library file inserted behind that door in a rolled-back
//     transaction; for a file, on the file itself;
//   - complete: every share that reaches the account (its verified address, or a group
//     it's in; not on a library it owns) is in exactly one row, and every file given to
//     its verified address appears once, except its own personal files;
//   - an account without a verified address gets nothing;
//   - agrees with the library list: every library or folder row is a library the account
//     is listed (lib/libraries), since the page refuses to open a row whose library is not
//     in that list -- a library that was put away comes off both at once;
//   - the route returns exactly what the library function builds.
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_access_test \
//     npx jest --runInBand integration/accessKeys.pg
//
// ACCESS_SEEDS sets the number of scenarios (default 12). A failure prints its seed;
// ACCESS_SEED=<n> re-runs just that one. Without MEMEX_TEST_PG_URL the suite is skipped.
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(600000);
const SEEDS = process.env.ACCESS_SEED ? [Number(process.env.ACCESS_SEED)]
  : Array.from({ length: Number(process.env.ACCESS_SEEDS) || 12 }, (_, i) => 1000 + i);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));

const { scenario, load, levelsOn, asClient, doorLevels } = require('./helpers/accessScenario');

suite('Shared with me against real Postgres (P5)', () => {
  let db, documentAccess, accessKeys, libraries, request, app, jwt, tokenHash;
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
    tokenHash = require('../../lib/shareLinks').tokenHash;
    jwt = require('jsonwebtoken');
    jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use('/api/access', require('../../routes/access'));
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  test.each(SEEDS)('scenario %i', async (seed) => {
    const s = scenario(seed);
    await load(db, s, { tokenHash });
    const doorCache = new Map();
    const door = async (lib, folder) => {
      const k = `${lib}|${folder}`;
      if (!doorCache.has(k)) doorCache.set(k, await doorLevels(db, documentAccess, lib, folder));
      return doorCache.get(k);
    };
    const fileCache = new Map();
    const file = async (docId) => {
      if (!fileCache.has(docId)) fileCache.set(docId, await levelsOn(documentAccess, asClient(db), docId));
      return fileCache.get(docId);
    };
    const dump = () => JSON.stringify({ seed, accounts: s.accounts, grants: s.grants.map(g => ({ ...g, lib: g.lib.name, group: g.group?.name, by: g.by.email })) }).slice(0, 4000);

    const seen = { libraries: 0, folders: 0, files: 0, viaGroup: 0, capped: 0 };
    for (const a of s.accounts) {
      const where = `seed ${seed}, ${a.email} (${a.role}, verified ${a.verified})`;
      const actor = await documentAccess.resolveActor(a.id);
      const got = await accessKeys.sharedWithMe(actor);
      seen.libraries += got.libraries.length; seen.folders += got.folders.length; seen.files += got.files.length;
      seen.viaGroup += [...got.libraries, ...got.folders].filter(r => r.shares.some(x => x.via_group)).length;
      seen.capped += [...got.libraries, ...got.folders, ...got.files].filter(r => r.effective !== r.level).length;
      try {
        expect(got.email_verified).toBe(!!a.verified);
        expect(got.is_admin).toBe(a.role === 'admin');
        if (!a.verified) {
          expect([got.libraries, got.folders, got.files]).toEqual([[], [], []]);
          continue;
        }

        // complete: the shares that reach this account, as the rule matches them
        const reaches = (g) => (g.group
          ? g.group.members.some(m => m.toLowerCase() === a.verified)
          : g.email === a.verified);
        const expected = s.grants.filter(g => reaches(g) && g.lib.owner?.id !== a.id);
        const rows = [...got.libraries.map(r => ({ ...r, path: '' })), ...got.folders];
        const doorKey = (lib, p) => `${lib}|${p}`;
        expect(rows.map(r => doorKey(r.library.id, r.path)).sort())
          .toEqual([...new Set(expected.map(g => doorKey(g.lib.id, g.folder)))].sort());
        expect(rows.flatMap(r => r.shares.map(x => x.share_id)).sort()).toEqual(expected.map(g => g.id).sort());
        expect(rows.every(r => r.library.id !== s.libraries.find(l => l.owner?.id === a.id)?.id)).toBe(true);

        // ...and each is a library this account is listed: the page opens a row through
        // the library list, so a row whose library is not in it could never open
        const listed = new Set((await libraries.listLibraries(actor)).map(l => String(l.id)));
        for (const r of rows) expect([r.library.name, r.path, listed.has(String(r.library.id))]).toEqual([r.library.name, r.path, true]);

        // sound: each door's level is the rule's, on a real file behind that door
        for (const r of rows) {
          const level = (await door(r.library.id, r.path)).get(a.id) || null;
          expect([r.library.name, r.path, r.level]).toEqual([r.library.name, r.path, level]);
          expect(r.effective).toBe(a.role === 'admin' || a.role === 'contributor' ? level : 'read');
        }

        // files given to the verified address one by one: each once, never their own personal file
        const keep = (name) => name === '.keep' || name.endsWith('/.keep');
        const given = s.acl.filter(r => r.subject.toLowerCase() === a.verified.toLowerCase()
          && !r.doc.deleted && !keep(r.doc.name) && !(!r.doc.scoped && r.doc.uploader?.id === a.id));
        expect(got.files.map(f => f.document.id).sort()).toEqual([...new Set(given.map(r => r.doc.id))].sort());
        for (const f of got.files) {
          const level = (await file(f.document.id)).get(a.id) || null;
          expect([f.document.id, f.level]).toEqual([f.document.id, level]);
          expect(level).not.toBeNull();
        }
      } catch (e) {
        e.message = `${where}\n${e.message}\nscenario: ${dump()}`;
        throw e;
      }

      // the route is the function, for whoever the token says (the stored address
      // unchanged by signing in -- Mixed-case is only reachable by writing the database)
      if (a.verified === a.verified?.toLowerCase() || !a.verified) {
        jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: !!a.verified });
        const res = await request(app).get('/api/access/shared-with-me').set('Authorization', 'Bearer t');
        expect(res.status).toBe(200);
        expect(res.body).toEqual(JSON.parse(JSON.stringify(got)));
      }
    }
    // the scenario really exercised the list: whole libraries, folders, groups, files, capping
    expect(Object.entries(seen).filter(([, v]) => v === 0).map(([k]) => k)).toEqual([]);
  });

  // A library that was put away (libraries.archived_at) is listed to administrators only,
  // so its shares come off everyone else's Shared with me with it, instead of staying as
  // rows that say "You can't open that any more" and come straight back on refresh (the
  // twelve emptied libraries of the 2026-10-09 consolidation did exactly that for every
  // member of the group they were shared with). A file given to someone one by one inside
  // it is still theirs to open, and stays listed.
  test('a library that was put away', async () => {
    const s = scenario(SEEDS[0]);
    await load(db, s, { tokenHash });
    const lib = s.libraries[0]; // Accounting, owned by c0, holding libraryDoc
    const owner = lib.owner;
    const by = (email) => s.accounts.find(a => a.email === email);
    const [c4, c5, v2, admin] = ['c4@acme.test', 'c5@acme.test', 'v2@acme.test', 'admin0@acme.test'].map(by);
    await db.query(
      `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission, granted_by, granted_by_email)
       SELECT $1, fp, 'user', em, 'read', $2, $3 FROM unnest($4::text[], $5::text[]) AS t(fp, em)
       ON CONFLICT DO NOTHING`,
      [lib.id, owner.id, owner.email, ['', 'Shared', ''], [c4.verified, c5.verified, admin.verified]]);
    await db.query(
      `INSERT INTO document_acl (document_id, subject_type, subject_id, subject_email, permission, granted_by, granted_by_email)
       VALUES ($1, 'user', $2, $2, 'read', $3, $4) ON CONFLICT DO NOTHING`,
      [s.libraryDoc.id, v2.verified, owner.id, owner.email]);
    const actor = (a) => documentAccess.resolveActor(a.id);
    const doors = async (a) => [...(await accessKeys.sharedWithMe(await actor(a))).libraries.map(r => ({ ...r, path: '' })),
      ...(await accessKeys.sharedWithMe(await actor(a))).folders].filter(r => r.library.id === lib.id);
    const givenFiles = async (a) => (await accessKeys.sharedWithMe(await actor(a))).files.map(f => f.document.id);
    const listedTo = async (a) => (await libraries.listLibraries(await actor(a))).some(l => String(l.id) === lib.id);

    // before: the library, the folder and the file reach them, and the library is listed
    expect((await doors(c4)).some(r => r.path === '')).toBe(true);
    expect((await doors(c5)).some(r => r.path === 'Shared')).toBe(true);
    expect(await givenFiles(v2)).toContain(s.libraryDoc.id);
    for (const a of [c4, c5, admin]) expect([a.email, await listedTo(a)]).toEqual([a.email, true]);

    await db.query('UPDATE libraries SET archived_at = now() WHERE id = $1', [lib.id]);

    // after: off the library list and off Shared with me alike, for everyone but an admin
    for (const a of [c4, c5, v2]) {
      expect([a.email, await doors(a)]).toEqual([a.email, []]);
      expect([a.email, await listedTo(a)]).toEqual([a.email, false]);
    }
    const adminDoors = await doors(admin);
    expect(adminDoors.some(r => r.path === '')).toBe(true);
    expect(adminDoors.every(r => !!r.library.archived_at)).toBe(true);
    expect(await listedTo(admin)).toBe(true);
    // the file given to v2 one by one is still theirs: listed, and the rule still admits them
    expect(await givenFiles(v2)).toContain(s.libraryDoc.id);
    expect((await levelsOn(documentAccess, asClient(db), s.libraryDoc.id)).get(v2.id)).toBe('read');
    // and the route answers as the function does
    jwt.verify.mockReturnValue({ sub: c4.id, email: c4.email, email_verified: true });
    const res = await request(app).get('/api/access/shared-with-me').set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(await accessKeys.sharedWithMe(await actor(c4)))));
    expect(res.body.libraries.map(l => l.library.id)).not.toContain(lib.id);
  });
});
