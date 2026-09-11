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
//   - the route returns exactly what the library function builds.
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_access_test \
//     npx jest --runInBand integration/accessKeys.pg
//
// ACCESS_SEEDS sets the number of scenarios (default 30). A failure prints its seed;
// ACCESS_SEED=<n> re-runs just that one. Without MEMEX_TEST_PG_URL the suite is skipped.
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(600000);
const SEEDS = process.env.ACCESS_SEED ? [Number(process.env.ACCESS_SEED)]
  : Array.from({ length: Number(process.env.ACCESS_SEEDS) || 30 }, (_, i) => 1000 + i);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));

// A small, seedable generator, so a failing scenario can be rebuilt from its number.
function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FOLDERS = ['Clients', 'Clients/Mender', 'Clients/Mender Extra', 'Clients/Mender/Deep', 'Q1', 'Q1_A', '50%', 'Tax & Co', '📁 Emoji', 'Empty Folder'];
const NAMES = ['Clients', 'root.txt', '.keep', 'Clients/.keep', 'Clients/x.txt', 'Clients/Mender/a.pdf', 'Clients/Mender Extra/b.pdf',
  'Clients/Mender/Deep/w.pdf', 'Q1/r.xlsx', 'Q1_A/s.docx', '50%/t.txt', 'Tax & Co/u.pdf', '📁 Emoji/v.png', 'Q1/.keep'];
const RANK = { read: 1, write: 2, admin: 3 };

function scenario(seed) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;
  const recase = (e) => (chance(0.3) ? e.toUpperCase() : chance(0.3) ? e.replace(/^./, c => c.toUpperCase()) : e);

  const accounts = [];
  const acct = (role, email, verified) => { const a = { id: id(), role, email, verified }; accounts.push(a); return a; };
  const admin = acct('admin', 'admin0@acme.test', 'admin0@acme.test');
  if (chance(0.5)) acct('admin', 'admin1@acme.test', 'admin1@acme.test');
  const cs = Array.from({ length: 6 }, (_, i) => acct('contributor', `c${i}@acme.test`, `c${i}@acme.test`));
  const vs = [acct('viewer', 'v0@outside.test', 'v0@outside.test'), acct('viewer', 'v1@acme.test', 'v1@acme.test'), acct('viewer', 'v2@acme.test', 'v2@acme.test')];
  acct('contributor', 'c1@acme.test', null);                // claims c1's address, never verified
  acct('contributor', 'c2@acme.test', 'c2@acme.test');      // a second account on c2's verified address
  acct(pick(['contributor', 'viewer']), 'Mixed@Acme.test', 'Mixed@Acme.test'); // written straight to the database
  const contacts = ['ghost0@acme.test', 'ghost1@elsewhere.test', 'ghost2@acme.test'];
  const addresses = [...new Set([...accounts.map(a => a.email.toLowerCase()), ...contacts])];

  const libraries = [
    { id: id(), name: 'Accounting', owner: cs[0] },
    { id: id(), name: 'Demoted', owner: vs[1] },
    { id: id(), name: 'Admin Lib', owner: admin },
    { id: id(), name: 'Ownerless', owner: null },
  ];

  const groups = Array.from({ length: 4 }, (_, i) => {
    const owner = pick(accounts);
    const members = new Map();
    for (const e of addresses) if (chance(0.3)) members.set(e, recase(e));
    if (chance(0.5)) members.set(owner.email.toLowerCase(), owner.email);
    return { id: id(), name: `Group ${i} ${seed}`, owner, members: [...members.values()] };
  });

  const documents = [];
  for (const lib of libraries) {
    const used = new Set();
    for (let i = 0; i < 20; i++) {
      const name = pick(NAMES);
      if (used.has(name)) continue;
      used.add(name);
      const uploader = chance(0.15) ? null : chance(0.1) ? { id: id(), email: 'gone@acme.test' } : pick(accounts);
      documents.push({
        id: id(), library: lib, name, uploader,
        scoped: uploader && lib.owner && uploader.id === lib.owner.id ? chance(0.8) : chance(0.5),
        deleted: chance(0.1), size: Math.floor(rnd() * 1000),
      });
    }
  }

  const acl = [];
  const aclKeys = new Set();
  const addAcl = (doc, subject, permission, by) => {
    const key = `${doc.id}|${subject}`;
    if (!subject || aclKeys.has(key)) return;
    aclKeys.add(key);
    acl.push({ id: id(), doc, subject, permission, by });
  };
  for (const d of documents) if (d.uploader) addAcl(d, d.uploader.id, 'admin', d.uploader); // owner rows, by id
  for (let i = 0; i < 45; i++) {
    const d = pick(documents);
    const by = pick(accounts);
    const subject = chance(0.2) ? pick(accounts).id : recase(pick(addresses));
    addAcl(d, subject, pick(['read', 'write', 'admin']), by);
  }

  const grants = [];
  const grantKeys = new Set();
  for (let i = 0; i < 18; i++) {
    const lib = pick(libraries);
    const folder = chance(0.4) ? '' : pick(FOLDERS);
    const byGroup = chance(0.4);
    const subject = byGroup ? pick(groups) : pick(addresses);
    const key = `${lib.id}|${folder}|${byGroup ? 'g' : 'u'}|${byGroup ? subject.id : subject}`;
    if (grantKeys.has(key)) continue;
    grantKeys.add(key);
    grants.push({ id: id(), lib, folder, group: byGroup ? subject : null, email: byGroup ? null : subject, permission: pick(['read', 'write']), by: pick(accounts) });
  }
  const profiles = accounts.filter(() => chance(0.6)).map(a => ({ a, name: chance(0.2) ? '' : `Name of ${a.email}` }));
  return { seed, accounts, libraries, groups, documents, acl, grants, profiles };
}

suite('Shared with me against real Postgres (P5)', () => {
  let db, documentAccess, accessKeys, request, app, jwt;
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

  async function load(s) {
    await db.query('TRUNCATE document_acl, library_grants, group_members, groups, documents, libraries, user_roles, user_profiles CASCADE');
    for (const a of s.accounts) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $4)', [a.id, a.email, a.role, a.verified]);
    }
    for (const p of s.profiles) await db.query('INSERT INTO user_profiles (user_id, email, display_name) VALUES ($1, $2, $3)', [p.a.id, p.a.email, p.name]);
    for (const l of s.libraries) {
      await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [l.id, l.name, l.owner?.id || null, l.owner ? l.owner.email.toLowerCase() : null]);
    }
    for (const g of s.groups) {
      await db.query('INSERT INTO groups (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [g.id, g.name, g.owner.id, g.owner.email]);
      for (const m of g.members) await db.query('INSERT INTO group_members (group_id, member_email) VALUES ($1, $2)', [g.id, m]);
    }
    for (const d of s.documents) {
      await db.query(
        `INSERT INTO documents (id, name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, deleted_at)
         VALUES ($1, $2, $3, 'application/octet-stream', $9, $4, $5, $6, $7, CASE WHEN $8 THEN NOW() END)`,
        [d.id, d.name, d.size, d.uploader?.id || null, d.uploader?.email || null, d.library.id, d.scoped, d.deleted, `seed/${d.id}`]);
    }
    for (const r of s.acl) {
      await db.query(
        `INSERT INTO document_acl (id, document_id, subject_type, subject_id, subject_email, permission, granted_by, granted_by_email)
         VALUES ($1, $2, 'user', $3, lower($3), $4, $5, $6)`,
        [r.id, r.doc.id, r.subject, r.permission, r.by.id, r.by.email]);
    }
    for (const g of s.grants) {
      await db.query(
        `INSERT INTO library_grants (id, library_id, folder_path, subject_type, subject_email, group_id, permission, granted_by, granted_by_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [g.id, g.lib.id, g.folder, g.group ? 'group' : 'user', g.email, g.group?.id || null, g.permission, g.by.id, g.by.email]);
    }
  }

  // Every account's level on one document, from the rule itself (acctRefs is the rule
  // over a stored account; P0 in auth.test.js pins it to userParams(resolveActor)).
  const everyone = (alias) => {
    const at = (p) => documentAccess.conditionWith(alias, documentAccess.acctRefs('t', p));
    return `CASE WHEN ${at('$2')} THEN 'admin' WHEN ${at('$3')} THEN 'write' WHEN ${at('$4')} THEN 'read' END`;
  };
  const perms = () => ['admin', 'write', 'read'].map(l => documentAccess.permissionsFor(l));
  async function levelsOn(client, docId) {
    const { rows } = await client.query(
      `SELECT t.user_id::text AS uid, ${everyone('d')} AS level FROM documents d CROSS JOIN user_roles t WHERE d.id = $1`,
      [docId, ...perms()]);
    return new Map(rows.map(r => [r.uid, r.level]));
  }
  // A door's level for everyone: a real library file put behind it, then rolled back.
  async function doorLevels(libraryId, folder) {
    let out;
    await db.withTransaction(async (c) => {
      const { rows: [{ id }] } = await c.query(
        `INSERT INTO documents (name, mime_type, storage_path, uploaded_by, library_id, library_scoped)
         VALUES ($1, 'text/plain', 'probe', gen_random_uuid(), $2, true) RETURNING id`,
        [folder ? `${folder}/zz probe file` : 'zz probe file', libraryId]);
      out = await levelsOn(c, id);
      throw Object.assign(new Error('rollback'), { rollback: true });
    }).catch((e) => { if (!e.rollback) throw e; });
    return out;
  }

  test.each(SEEDS)('scenario %i', async (seed) => {
    const s = scenario(seed);
    await load(s);
    const doorCache = new Map();
    const door = async (lib, folder) => {
      const k = `${lib}|${folder}`;
      if (!doorCache.has(k)) doorCache.set(k, await doorLevels(lib, folder));
      return doorCache.get(k);
    };
    const fileCache = new Map();
    const file = async (docId) => {
      if (!fileCache.has(docId)) fileCache.set(docId, await levelsOn({ query: (q, p) => db.query(q, p).then(rows => ({ rows })) }, docId));
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

        // sound: each door's level is the rule's, on a real file behind that door
        for (const r of rows) {
          const level = (await door(r.library.id, r.path)).get(a.id);
          expect([r.library.name, r.path, r.level]).toEqual([r.library.name, r.path, level]);
          expect(r.effective).toBe(a.role === 'admin' || a.role === 'contributor' ? level : 'read');
        }

        // files given to the verified address one by one: each once, never their own personal file
        const keep = (name) => name === '.keep' || name.endsWith('/.keep');
        const given = s.acl.filter(r => r.subject.toLowerCase() === a.verified.toLowerCase()
          && !r.doc.deleted && !keep(r.doc.name) && !(!r.doc.scoped && r.doc.uploader?.id === a.id));
        expect(got.files.map(f => f.document.id).sort()).toEqual([...new Set(given.map(r => r.doc.id))].sort());
        for (const f of got.files) {
          const level = (await file(f.document.id)).get(a.id);
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
});
