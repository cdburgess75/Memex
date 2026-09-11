'use strict';
// Who has access, and why (piece 3) against a REAL, THROWAWAY Postgres: seeded random
// scenarios, every list checked against the access rule itself.
//   P1  file doors: each person's level is condition() on the file, for every account;
//       every level has reasons, and none is ever 'unexplained'.
//   P2  library and folder doors: each level is condition() on a real library file put
//       behind the door (in a rolled-back transaction), for every account and every path
//       -- prefixes of file names, shared paths, and a path that doesn't exist; no key
//       from a deeper folder is ever counted as opening the door.
//   P2b writeRight agrees: a contributor may add files exactly where the door gives write.
//   P3  complete: on every library file behind a door, the rule's level is the best of
//       the door, the folder shares inside that cover it, and the files given directly.
//   P4  impact: removing (or lowering) each key really does what the list says --
//       checked by deleting the row and re-reading the rule, then rolling back.
//   P6  links: each link's state is what redeeming it really does.
//   P7  privacy: a manager who isn't an admin sees no admin by name and nobody's
//       personal files; others see only their own access.
//   P8  one snapshot: a share deleted halfway through a list doesn't make it contradict itself.
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_access_test \
//     npx jest --runInBand integration/accessDoors.pg
//
// DOOR_SEEDS sets the number of scenarios (default 3); DOOR_SEED=<n> re-runs one.
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(900000);
const SEEDS = process.env.DOOR_SEED ? [Number(process.env.DOOR_SEED)]
  : Array.from({ length: Number(process.env.DOOR_SEEDS) || 3 }, (_, i) => 2000 + i);

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

const { scenario, load, levelsOn, asClient, rolledBack, doorLevels } = require('./helpers/accessScenario');
const RANK = { read: 1, write: 2, admin: 3 };
const best = (...ls) => ls.reduce((m, l) => ((RANK[l] || 0) > (RANK[m] || 0) ? l : m), null);
const keep = (n) => n === '.keep' || n.endsWith('/.keep');
const ZIP_ENTRY = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // a zip local file header

suite('Who has access against real Postgres', () => {
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
    app.use(express.json());
    app.use('/api/access', require('../../routes/access'));
    app.use('/api/files', require('../../routes/files'));
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const actor = (a) => documentAccess.resolveActor(a.id);
  async function libDoor(viewer, lib, p = '') {
    const listed = await libraries.visibleLibraryRow(viewer, lib.id);
    if (!listed) return null;
    const library = libraries.shapeLibrary(viewer, listed);
    return accessKeys.libraryDoor(viewer, { library, listed, path: p, manager: library.can_manage });
  }
  async function fileDoorFor(viewer, d, detail = 'full') {
    const doc = await db.queryOne('SELECT id, name, library_id, library_scoped, uploaded_by, uploaded_by_email FROM documents WHERE id = $1', [d.id]);
    const library = await db.queryOne('SELECT id, name, owner_id, owner_email FROM libraries WHERE id = $1', [doc.library_id]);
    return accessKeys.fileDoor(viewer, { doc, library, full: true, detail });
  }
  const levelsOf = (resp) => new Map(resp.people.filter(p => p.level).map(p => [String(p.user_id), p.level]));
  const noUnexplained = (resp) => resp.people.every(p => p.reasons.every(r => r.kind !== 'unexplained'));
  const tagged = (where, e) => { e.message = `${where}\n${e.message}`; return e; };

  test.each(SEEDS)('scenario %i', async (seed) => {
    const s = scenario(seed);
    await load(db, s, { tokenHash });
    const admin = await actor(s.accounts[0]);
    const role = new Map(s.accounts.map(a => [a.id, a.role]));
    const fileLevels = new Map();
    const onFile = async (id) => {
      if (!fileLevels.has(id)) fileLevels.set(id, await levelsOn(documentAccess, asClient(db), id));
      return fileLevels.get(id);
    };

    // ---- P1: file doors ----
    const live = s.documents.filter(d => !d.deleted);
    for (const d of live) {
      const where = `seed ${seed}, file ${d.library.name}/${d.name}`;
      const resp = await fileDoorFor(admin, d);
      const want = await onFile(d.id);
      try {
        expect(levelsOf(resp)).toEqual(want);
        expect(noUnexplained(resp)).toBe(true);
        for (const p of resp.people) {
          expect(p.reasons.length > 0).toBe(!!p.level);
          const r = role.get(p.user_id);
          expect(p.effective).toBe(r === 'admin' || r === 'contributor' ? p.level : (p.level && 'read'));
        }
      } catch (e) { throw tagged(where, e); }

      // P4 on a file door: take each of its grants away and read the rule again
      for (const k of resp.keys.filter(x => x.kind === 'file_grant')) {
        const after = await rolledBack(db, async (c) => {
          await c.query('DELETE FROM document_acl WHERE id = $1', [k.id]);
          return levelsOn(documentAccess, c, d.id);
        });
        checkImpact(k.impact, want, after, `${where} key ${k.ref}`);
      }
    }

    // a sample, through getAccessibleDocument itself (not the all-accounts form)
    for (const d of live.slice(0, 4)) {
      const want = await onFile(d.id);
      for (const a of s.accounts) {
        const who = await actor(a);
        let lvl = null;
        for (const l of ['read', 'write', 'admin']) {
          if (await documentAccess.getAccessibleDocument({ id: d.id, user: who, required: l, columns: 'd.id' })) lvl = l;
        }
        expect([seed, d.name, a.email, lvl]).toEqual([seed, d.name, a.email, want.get(a.id) || null]);
      }
    }

    // ---- P2, P2b, P3, P4, P6 on library and folder doors ----
    for (const lib of s.libraries) {
      const inLib = s.documents.filter(d => d.library === lib);
      const paths = new Set(['', 'Nope/Not Here']);
      for (const d of inLib) { const parts = d.name.split('/'); for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/')); }
      for (const g of s.grants.filter(x => x.lib === lib && x.folder)) paths.add(g.folder);
      for (const p of paths) {
        const where = `seed ${seed}, ${lib.name}:"${p}"`;
        const resp = await libDoor(admin, lib, p);
        const want = await doorLevels(db, documentAccess, lib.id, p);
        try {
          expect(levelsOf(resp)).toEqual(want);
          expect(noUnexplained(resp)).toBe(true);
          for (const person of resp.people) {
            for (const r of person.reasons) {
              if (r.relation === 'inside') continue;
              if (r.kind === 'library_share' || r.kind === 'folder_share') {
                expect(r.folder_path === '' || r.folder_path === p || p.startsWith(`${r.folder_path}/`)).toBe(true);
              }
            }
            if (!person.level) expect(person.reasons.every(r => r.relation === 'inside')).toBe(true);
            // a key "inside" is to a folder strictly below the door, and is one of the door's keys
            for (const r of person.reasons.filter(x => x.relation === 'inside' && x.kind === 'folder_share')) {
              expect([r.folder_path, p ? r.folder_path.startsWith(`${p}/`) : r.folder_path !== '']).toEqual([r.folder_path, true]);
              expect([r.key, resp.keys.find(k => k.ref === r.key)?.relation]).toEqual([r.key, 'inside']);
            }
          }
        } catch (e) { throw tagged(where, e); }

        // P2b
        for (const a of s.accounts.filter(x => x.role === 'contributor')) {
          const wr = await libraries.writeRight(await actor(a), lib.id, p);
          const lvl = want.get(a.id) || null;
          expect([where, a.email, wr.right === 'owner' || wr.right === 'grant']).toEqual([where, a.email, lvl === 'write' || lvl === 'admin']);
        }

        // P3: every library file behind the door
        const byUser = new Map(resp.people.map(x => [String(x.user_id), x]));
        for (const d of inLib.filter(x => !x.deleted && x.scoped && !keep(x.name) && (!p || x.name.startsWith(`${p}/`)))) {
          const onD = await onFile(d.id);
          for (const a of s.accounts) {
            const person = byUser.get(a.id);
            if (person && person.reasons.some(r => r.kind === 'file_grants' && r.files.more > 0)) continue;
            const got = !person ? null : best(
              person.level,
              ...person.reasons.filter(r => r.kind === 'folder_share' && r.relation === 'inside' && d.name.startsWith(`${r.folder_path}/`)).map(r => r.level),
              ...person.reasons.filter(r => r.kind === 'file_grants').flatMap(r => r.files.items.filter(i => i.id === d.id).map(i => i.permission)),
            );
            expect([where, d.name, a.email, got]).toEqual([where, d.name, a.email, onD.get(a.id) || null]);
          }
        }

        // P4: every removable key (and every files-given-one-by-one key)
        for (const k of resp.keys.filter(x => x.can_remove || x.kind === 'file_grants')) {
          if (k.kind === 'library_share' || k.kind === 'folder_share') {
            const at = k.relation === 'inside' ? k.folder_path : p;
            const before = k.relation === 'inside' ? await doorLevels(db, documentAccess, lib.id, at) : want;
            const gone = await doorLevels(db, documentAccess, lib.id, at, (c) => c.query('DELETE FROM library_grants WHERE id = $1', [k.id]));
            checkImpact(k.impact, before, gone, `${where} ${k.ref}`);
            if (k.impact_if_read) {
              const lowered = await doorLevels(db, documentAccess, lib.id, at, (c) => c.query(`UPDATE library_grants SET permission = 'read' WHERE id = $1`, [k.id]));
              checkImpact(k.impact_if_read, before, lowered, `${where} ${k.ref} (to read)`);
            }
          } else if (k.kind === 'file_grants') {
            const subject = k.ref.slice(4);
            const files = await db.query(
              `SELECT DISTINCT x.id FROM documents x JOIN document_acl acl ON acl.document_id = x.id
                WHERE x.library_id = $1 AND x.deleted_at IS NULL AND ($2 = '' OR starts_with(x.name, $2 || '/'))
                  AND x.name <> '.keep' AND x.name NOT LIKE '%/.keep'
                  AND lower(acl.subject_id) = $3 AND lower(acl.subject_id) IS DISTINCT FROM x.uploaded_by::text`,
              [lib.id, p, subject]);
            expect([where, k.ref, files.length]).toEqual([where, k.ref, k.files_impact.files]);
            const admitted = k.admits.map(r => r.slice(2));
            const open = await rolledBack(db, async (c) => {
              await c.query('DELETE FROM document_acl acl WHERE acl.document_id = ANY($1::uuid[]) AND lower(acl.subject_id) = $2',
                [files.map(f => f.id), subject]);
              const counts = [];
              for (const u of admitted) {
                let n = 0;
                for (const f of files) if ((await levelsOn(documentAccess, c, f.id)).get(u)) n++;
                counts.push(n);
              }
              return counts;
            });
            expect([where, k.ref, k.files_impact.still_open]).toEqual([where, k.ref, open.length ? Math.min(...open) : 0]);
          }
        }

        // P6: links, on the library door
        if (!p) await checkLinks(s, lib, resp, where);
      }
    }

    // ---- P7: what others see ----
    const accounting = s.libraries[0];
    const owner = await actor(accounting.owner);
    const mine = await libDoor(owner, accounting);
    const adminEmails = s.accounts.filter(a => a.role === 'admin').map(a => a.verified);
    expect(mine.can_see_keys).toBe(true);
    expect(mine.people.some(p => adminEmails.includes(p.email))).toBe(false);
    expect(mine.admins.named).toBeUndefined();
    expect(mine).not.toHaveProperty('personal_files');
    expect(JSON.stringify(mine.people)).not.toMatch(/"is_admin"/);
    for (const k of mine.keys) if (k.subject?.type === 'group' && !k.subject.viewable) expect(k.waiting).toBeNull();
    // personal files in it the owner doesn't manage (the rule says so): their grants and
    // links are the uploader's business -- including the one every scenario plants
    const othersPersonal = [];
    for (const d of s.documents.filter(x => x.library === accounting && !x.scoped && !x.deleted && x.uploader?.id !== owner.id)) {
      if ((await onFile(d.id)).get(owner.id) !== 'admin') othersPersonal.push(d);
    }
    expect(othersPersonal.map(d => d.id)).toContain(s.privateDoc.id);
    for (const d of othersPersonal) {
      const shown = mine.keys.some(k => k.kind === 'file_grants' && k.files.items.some(i => i.id === d.id))
        || mine.links.some(l => l.document_id === d.id);
      expect([d.name, shown]).toEqual([d.name, false]);
    }
    // Someone who manages a library file ("Can manage") but not its library sees the
    // file's own keys only: none of the library's shares, its owner, or who they let in.
    for (const g of s.acl.filter(r => r.permission === 'admin' && r.doc.scoped && !r.doc.deleted)) {
      const holder = s.accounts.find(a => a.role === 'contributor' && a.verified && a.verified.toLowerCase() === String(g.subject).toLowerCase());
      if (!holder || g.doc.library.owner?.id === holder.id) continue;
      const hidden = await fileDoorFor(await actor(holder), g.doc, 'hidden');
      expect(hidden.library_detail).toBe('hidden');
      expect(hidden.hidden_note).toEqual({ library_owner_email: g.doc.library.owner ? g.doc.library.owner.email.toLowerCase() : null });
      const leaked = hidden.people.flatMap(p => p.reasons).filter(r => ['owner', 'library_share', 'folder_share'].includes(r.kind));
      expect([g.doc.name, leaked]).toEqual([g.doc.name, []]);
      expect(hidden.keys.filter(k => ['owner', 'library_share', 'folder_share'].includes(k.kind))).toEqual([]);
      for (const k of hidden.keys) if (k.impact) expect(k.impact.lose).toEqual([]);
    }
    const wantHere = await doorLevels(db, documentAccess, accounting.id, '');
    for (const a of s.accounts.filter(x => x.role !== 'admin' && x.id !== accounting.owner.id)) {
      const theirs = await libDoor(await actor(a), accounting);
      if (!theirs) continue;
      expect([a.email, theirs.can_see_keys, Object.keys(theirs).sort()]).toEqual([a.email, false, ['can_see_keys', 'door', 'generated_at', 'you']]);
      expect([a.email, theirs.you.level]).toEqual([a.email, wantHere.get(a.id) || null]);
    }
  });

  // What the list says removing a key does, against what the rule says after it's gone.
  function checkImpact(impact, before, after, where) {
    if (!impact) return;
    for (const r of impact.lose) expect([where, r, after.get(r.slice(2)) || null]).toEqual([where, r, null]);
    for (const k of impact.keep) {
      expect([where, k.ref, after.get(k.ref.slice(2)) || null]).toEqual([where, k.ref, k.after]);
      expect([where, k.ref, 'before', before.get(k.ref.slice(2)) || null]).toEqual([where, k.ref, 'before', k.before]);
    }
    expect([where, impact.unknown]).toEqual([where, []]);
    const listed = new Set([...impact.lose, ...impact.keep.map(k => k.ref)].map(r => r.slice(2)));
    for (const [u, lvl] of before) {
      if (!listed.has(u)) expect([where, 'unlisted', u, after.get(u) || null]).toEqual([where, 'unlisted', u, lvl]);
    }
  }

  // Each link's state is what redeeming it does; every live link on the library is listed.
  async function checkLinks(s, lib, resp, where) {
    const listed = new Map(resp.links.map(l => [l.ref, l]));
    for (const l of s.fileLinks.filter(x => x.doc.library === lib)) {
      const res = await request(app).get(`/api/files/share/${l.token}/info`);
      const shown = listed.get(`lk:${l.id}`);
      if (l.revoked || l.expired || l.doc.deleted) { expect([where, l.token, !!shown]).toEqual([where, l.token, false]); continue; }
      expect([where, l.token, !!shown]).toEqual([where, l.token, true]);
      expect([where, l.token, shown.state, res.status]).toEqual([where, l.token, shown.state, shown.state === 'active' ? 200 : 404]);
    }
    for (const f of s.folderLinks) {
      const shown = listed.get(`fl:${f.id}`);
      if (!shown) continue;
      const all = s.documents.filter(d => f.ids.includes(d.id));
      if (all.some(d => d.library !== lib)) continue; // it serves files beyond this library too
      const res = await request(app).get(`/api/files/folder/share/${f.token}`).buffer(true)
        .parse((r, cb) => { const b = []; r.on('data', c => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
      if (shown.state === 'paused') expect([where, f.token, res.status]).toEqual([where, f.token, 404]);
      else {
        expect([where, f.token, res.status]).toEqual([where, f.token, 200]);
        let entries = 0;
        for (let i = res.body.indexOf(ZIP_ENTRY); i >= 0; i = res.body.indexOf(ZIP_ENTRY, i + 4)) entries++;
        expect([where, f.token, entries]).toEqual([where, f.token, shown.serving]);
      }
    }
  }

  // Budgets on a big library: 25,000 files, 100 accounts, 20 groups, 50 shares (40 on
  // folders), 2,000 files given one by one, 80 links. Postgres times each statement a
  // list runs (EXPLAIN ANALYZE), so a slow network doesn't count; the best of 3 runs.
  (PG && process.env.PERF ? test : test.skip)('performance budgets at 25k files', async () => {
    await db.query(`TRUNCATE document_acl, document_share_links, folder_share_links, library_grants, group_members, groups,
                             documents, libraries, user_roles, user_profiles CASCADE`);
    await db.query(`INSERT INTO user_roles (user_id, email, role, verified_email)
      SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid, 'u' || i || '@big.test',
             CASE WHEN i <= 2 THEN 'admin' WHEN i % 5 = 0 THEN 'viewer' ELSE 'contributor' END, 'u' || i || '@big.test'
        FROM generate_series(1, 100) i`);
    const U = (i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    const { id: lib } = await db.queryOne(`INSERT INTO libraries (name, owner_id, owner_email) VALUES ('Big', $1, 'u3@big.test') RETURNING id`, [U(3)]);
    await db.query(`INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
      SELECT 'F' || (i % 50) || '/Sub ' || (i % 7) || '/file ' || i || '.pdf', 1000, 'application/pdf', 'big/' || i,
             ('00000000-0000-4000-8000-' || lpad(to_hex(3 + i % 90), 12, '0'))::uuid, 'u' || (3 + i % 90) || '@big.test', $1, i % 10 <> 0
        FROM generate_series(1, 25000) i`, [lib]);
    await db.query(`INSERT INTO document_acl (document_id, subject_type, subject_id, subject_email, permission)
      SELECT id, 'user', uploaded_by::text, uploaded_by_email, 'admin' FROM documents`);
    await db.query(`INSERT INTO document_acl (document_id, subject_type, subject_id, subject_email, permission)
      SELECT d.id, 'user', 'u' || (d.n % 97 + 3) || '@big.test', 'u' || (d.n % 97 + 3) || '@big.test', (ARRAY['read','write','admin'])[d.n % 3 + 1]
        FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM documents) d WHERE d.n % 12 = 0 AND d.n <= 24000
      ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO groups (name, owner_id, owner_email) SELECT 'Group ' || g, $1, 'u3@big.test' FROM generate_series(1, 20) g`, [U(3)]);
    await db.query(`INSERT INTO group_members (group_id, member_email)
      SELECT g.id, 'u' || (3 + (row_number() OVER ()) % 97) || '@big.test' FROM groups g, generate_series(1, 15) m ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission)
      SELECT $1, CASE WHEN i <= 10 THEN '' ELSE 'F' || i END, 'user', 'u' || (10 + i) || '@big.test', CASE WHEN i % 2 = 0 THEN 'write' ELSE 'read' END
        FROM generate_series(1, 30) i`, [lib]);
    await db.query(`INSERT INTO library_grants (library_id, folder_path, subject_type, group_id, permission)
      SELECT $1, 'F' || (n + 30) % 50 || '/Sub ' || n % 7, 'group', id, 'read' FROM (SELECT id, row_number() OVER () AS n FROM groups) g`, [lib]);
    await db.query(`INSERT INTO document_share_links (document_id, token_hash, created_by, created_by_email, expires_at)
      SELECT id, md5(id::text), uploaded_by, uploaded_by_email, NOW() + interval '7 days' FROM documents ORDER BY id LIMIT 60`);
    await db.query(`INSERT INTO folder_share_links (folder_path, document_ids, token_hash, created_by, created_by_email)
      SELECT 'F' || i, ARRAY(SELECT id FROM documents WHERE starts_with(name, 'F' || i || '/') LIMIT 40), md5('f' || i), $1, 'u3@big.test'
        FROM generate_series(1, 20) i`, [U(3)]);
    await db.query('ANALYZE');

    const owner = await documentAccess.resolveActor(U(3));
    const me = await documentAccess.resolveActor(U(20));
    const doc = await db.queryOne(`SELECT id, name, library_id, library_scoped, uploaded_by, uploaded_by_email FROM documents WHERE library_scoped ORDER BY id LIMIT 1`);
    const library = await db.queryOne('SELECT id, name, owner_id, owner_email FROM libraries WHERE id = $1', [lib]);
    const cases = {
      library: () => libDoor(owner, { id: lib }),
      folder: () => libDoor(owner, { id: lib }, 'F7'),
      file: () => accessKeys.fileDoor(owner, { doc, library, full: true, detail: 'full' }),
      shared_with_me: () => accessKeys.sharedWithMe(me),
    };
    const BUDGET = { library: 250, folder: 200, file: 60, shared_with_me: 150 };
    const timings = {};
    for (const [name, run] of Object.entries(cases)) {
      let bestMs = Infinity;
      for (let i = 0; i < 3; i++) {
        const statements = [];
        accessKeys.hooks.beforeStatement = async (sql, params) => { statements.push({ sql, params }); };
        try { await run(); } finally { accessKeys.hooks.beforeStatement = null; }
        let ms = 0;
        const each = [];
        for (const st of statements) {
          const plan = await rolledBack(db, async (c) => {
            await c.query('SET TRANSACTION READ ONLY');
            await c.query('SET LOCAL jit = off'); // as withSnapshot runs them
            return (await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${st.sql}`, st.params)).rows[0]['QUERY PLAN'][0];
          });
          ms += plan['Execution Time'] + plan['Planning Time'];
          each.push({ ms: Math.round(plan['Execution Time'] + plan['Planning Time']), sql: st.sql.replace(/\s+/g, ' ').slice(0, 110), st });
          if (name === 'file' || (name === 'shared_with_me' && /FROM document_acl acl JOIN documents d/.test(st.sql))) {
            const scans = JSON.stringify(plan).match(/"Node Type":"Seq Scan","Parent Relationship":"[^"]*",("[^"]*":[^,]*,)*?"Relation Name":"documents"/g) || [];
            expect([name, st.sql.slice(0, 60), scans.length]).toEqual([name, st.sql.slice(0, 60), 0]);
          }
        }
        if (process.env.PERF_DETAIL && i === 0) console.log(name, JSON.stringify([...each].sort((a, b) => b.ms - a.ms).slice(0, 6).map(({ ms, sql }) => ({ ms, sql })), null, 1));
        if (process.env.PERF_EXPLAIN === name && i === 0) {
          const worst = [...each].sort((a, b) => b.ms - a.ms)[0].st;
          const text = await rolledBack(db, async (c) => {
            await c.query('SET LOCAL jit = off');
            return (await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${worst.sql}`, worst.params)).rows.map(r => r['QUERY PLAN']).join('\n');
          });
          console.log(`${name} plan:\n${text}`);
        }
        bestMs = Math.min(bestMs, ms);
      }
      timings[name] = Math.round(bestMs);
    }
    console.log('access list timings (ms, database time):', JSON.stringify(timings));
    for (const [name, ms] of Object.entries(timings)) expect([name, ms <= BUDGET[name]]).toEqual([name, true]);
  });

  test('P8: one snapshot, whatever changes halfway through', async () => {
    const s = scenario(4242);
    await load(db, s, { tokenHash });
    const lib = s.libraries[0];
    const c3 = s.accounts.find(a => a.email === 'c3@acme.test');
    await db.query('DELETE FROM library_grants WHERE library_id = $1', [lib.id]);
    const { id } = await db.queryOne(
      `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission) VALUES ($1, '', 'user', $2, 'write') RETURNING id`,
      [lib.id, c3.verified]);
    const admin = await actor(s.accounts[0]);
    let fired = false;
    accessKeys.hooks.beforeStatement = async (sql) => {
      // once the everyone-gate has run, take the share away before the reasons are read
      if (!fired && /UNION ALL/.test(sql) && /FROM user_roles u WHERE/.test(sql)) {
        fired = true;
        await db.query('DELETE FROM library_grants WHERE id = $1', [id]);
      }
    };
    try {
      const resp = await libDoor(admin, lib);
      expect(fired).toBe(true);
      const person = resp.people.find(p => p.user_id === c3.id);
      expect(person.level).toBe('write');
      expect(person.reasons.map(r => r.key)).toContain(`ls:${id}`);
      expect(noUnexplained(resp)).toBe(true);
      expect(resp.keys.map(k => k.ref)).toContain(`ls:${id}`);
    } finally { accessKeys.hooks.beforeStatement = null; }
    const after = await libDoor(admin, lib);
    expect(after.people.find(p => p.user_id === c3.id && p.level)).toBeUndefined();
  });
});
