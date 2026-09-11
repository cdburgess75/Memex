'use strict';
// Seeded random scenarios for the access suites (accessKeys.pg, accessDoors.pg): accounts,
// libraries, groups, files, per-file grants, library and folder shares, and public links,
// with the awkward cases on purpose. The same seed always builds the same scenario, so a
// failure can be rebuilt from its number.
const crypto = require('crypto');

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
  const gone = { id: id(), email: 'gone@acme.test' }; // an account that no longer exists

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
      const uploader = chance(0.15) ? null : chance(0.1) ? gone : pick(accounts);
      documents.push({
        id: id(), library: lib, name, uploader,
        scoped: uploader && lib.owner && uploader.id === lib.owner.id ? chance(0.8) : chance(0.5),
        deleted: chance(0.1), size: Math.floor(rnd() * 1000),
      });
    }
  }

  // Always one private file in the first library that its owner doesn't manage, given
  // to someone and linked: what a manager who isn't an admin must never be shown.
  const privateDoc = { id: id(), library: libraries[0], name: 'Private/notes.txt', uploader: cs[3], scoped: false, deleted: false, size: 10 };
  documents.push(privateDoc);
  // ...and one of the library's own files beside it, so a folder link can cover both.
  const libraryDoc = { id: id(), library: libraries[0], name: 'Shared/plan.txt', uploader: cs[0], scoped: true, deleted: false, size: 10 };
  documents.push(libraryDoc);

  const acl = [];
  const aclKeys = new Set();
  const addAcl = (doc, subject, permission, by) => {
    const key = `${doc.id}|${subject}`;
    if (!subject || aclKeys.has(key)) return;
    aclKeys.add(key);
    acl.push({ id: id(), doc, subject, permission, by });
  };
  for (const d of documents) if (d.uploader) addAcl(d, d.uploader.id, 'admin', d.uploader); // owner rows, by id
  addAcl(privateDoc, 'ghost0@acme.test', 'read', cs[3]);
  const others = documents.filter(x => x !== privateDoc && x !== libraryDoc);
  for (let i = 0; i < 45; i++) {
    const d = pick(others);
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

  // Public links: live, revoked, expired; made by anyone, including a viewer and an
  // account that is gone. Folder snapshots are the files under a path in one library,
  // sometimes with a file from another library or a deleted one mixed in.
  const token = () => `t${seed}x${crypto.createHash('sha256').update(String(++n)).digest('hex').slice(0, 24)}`;
  const creators = [...accounts, gone];
  const fileLinks = Array.from({ length: 10 }, () => ({
    id: id(), token: token(), doc: pick(documents), by: pick(creators),
    revoked: chance(0.15), expired: chance(0.15), password: chance(0.2), recipient: chance(0.3) ? pick(contacts) : null,
  }));
  fileLinks.push({ id: id(), token: token(), doc: privateDoc, by: cs[3], revoked: false, expired: false, password: false, recipient: null });
  const folderLinks = Array.from({ length: 5 }, () => {
    const lib = pick(libraries);
    const path = pick(FOLDERS);
    let ids = documents.filter(d => d.library === lib && d.name.startsWith(`${path}/`)).map(d => d.id);
    if (chance(0.25)) ids = [...ids, pick(documents).id];
    return { id: id(), token: token(), lib, path, ids: [...new Set(ids)], by: pick(creators), revoked: chance(0.15), expired: chance(0.15) };
  });

  // A folder link over a file the library's owner can edit and a private one they can't,
  // made by someone else: the owner may not revoke it (they can't edit every file in it).
  folderLinks.push({ id: id(), token: token(), lib: libraries[0], path: 'Shared', ids: [libraryDoc.id, privateDoc.id], by: cs[3], revoked: false, expired: false });
  const profiles = accounts.filter(() => chance(0.6)).map(a => ({ a, name: chance(0.2) ? '' : `Name of ${a.email}` }));
  return { seed, accounts, libraries, groups, documents, acl, grants, fileLinks, folderLinks, profiles, gone, contacts, privateDoc, libraryDoc };
}

// Load a scenario, in a handful of statements.
async function load(db, s, { tokenHash }) {
  await db.query(`TRUNCATE document_acl, document_share_links, folder_share_links, library_grants, group_members, groups,
                           documents, libraries, user_roles, user_profiles CASCADE`);
  const rows = (list, f) => list.map(f);
  const insert = async (sql, list, f) => {
    if (!list.length) return;
    const cols = rows(list, f);
    await db.query(sql, cols[0].map((_, i) => cols.map(c => c[i])));
  };
  await insert(`INSERT INTO user_roles (user_id, email, role, verified_email)
                SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[])`, s.accounts, a => [a.id, a.email, a.role, a.verified]);
  await insert(`INSERT INTO user_profiles (user_id, email, display_name) SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])`,
    s.profiles, p => [p.a.id, p.a.email, p.name]);
  await insert(`INSERT INTO libraries (id, name, owner_id, owner_email) SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[])`,
    s.libraries, l => [l.id, l.name, l.owner?.id || null, l.owner ? l.owner.email.toLowerCase() : null]);
  await insert(`INSERT INTO groups (id, name, owner_id, owner_email) SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[])`,
    s.groups, g => [g.id, g.name, g.owner.id, g.owner.email]);
  await insert(`INSERT INTO group_members (group_id, member_email) SELECT * FROM unnest($1::uuid[], $2::text[])`,
    s.groups.flatMap(g => g.members.map(m => ({ g, m }))), x => [x.g.id, x.m]);
  await insert(
    `INSERT INTO documents (id, name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, deleted_at)
     SELECT i, nm, sz, 'application/octet-stream', 'seed/' || i::text, up, upe, lib, sc, CASE WHEN del THEN NOW() END
       FROM unnest($1::uuid[], $2::text[], $3::bigint[], $4::uuid[], $5::text[], $6::uuid[], $7::boolean[], $8::boolean[]) AS t(i, nm, sz, up, upe, lib, sc, del)`,
    s.documents, d => [d.id, d.name, d.size, d.uploader?.id || null, d.uploader?.email || null, d.library.id, d.scoped, d.deleted]);
  await insert(
    `INSERT INTO document_acl (id, document_id, subject_type, subject_id, subject_email, permission, granted_by, granted_by_email)
     SELECT i, doc, 'user', sub, lower(sub), perm, by, bye FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::text[]) AS t(i, doc, sub, perm, by, bye)`,
    s.acl, r => [r.id, r.doc.id, r.subject, r.permission, r.by.id, r.by.email]);
  await insert(
    `INSERT INTO library_grants (id, library_id, folder_path, subject_type, subject_email, group_id, permission, granted_by, granted_by_email)
     SELECT i, lib, fp, CASE WHEN grp IS NULL THEN 'user' ELSE 'group' END, em, grp, perm, by, bye
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::text[], $7::uuid[], $8::text[]) AS t(i, lib, fp, em, grp, perm, by, bye)`,
    s.grants, g => [g.id, g.lib.id, g.folder, g.email, g.group?.id || null, g.permission, g.by.id, g.by.email]);
  await insert(
    `INSERT INTO document_share_links (id, document_id, token_hash, password_salt, password_hash, expires_at, revoked_at, created_by, created_by_email, recipient_email)
     SELECT i, doc, th, CASE WHEN pw THEN 'salt' END, CASE WHEN pw THEN 'hash' END, CASE WHEN ex THEN NOW() - interval '1 day' ELSE NOW() + interval '7 days' END,
            CASE WHEN rv THEN NOW() END, by, bye, rcp
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::boolean[], $5::boolean[], $6::boolean[], $7::uuid[], $8::text[], $9::text[]) AS t(i, doc, th, pw, ex, rv, by, bye, rcp)`,
    s.fileLinks, l => [l.id, l.doc.id, tokenHash(l.token), l.password, l.expired, l.revoked, l.by.id, l.by.email, l.recipient]);
  for (const f of s.folderLinks) {
    await db.query(
      `INSERT INTO folder_share_links (id, folder_path, document_ids, token_hash, expires_at, revoked_at, created_by, created_by_email)
       VALUES ($1, $2, $3::uuid[], $4, CASE WHEN $5 THEN NOW() - interval '1 day' ELSE NOW() + interval '7 days' END, CASE WHEN $6 THEN NOW() END, $7, $8)`,
      [f.id, f.path, f.ids, tokenHash(f.token), f.expired, f.revoked, f.by.id, f.by.email]);
  }
}

// Every account's level on one document, from the rule itself: acctRefs is the rule over
// a stored account, and auth.test.js (P0) pins it to userParams(resolveActor(id)).
function levelsSql(documentAccess, alias) {
  const at = (p) => documentAccess.conditionWith(alias, documentAccess.acctRefs('t', p));
  return `CASE WHEN ${at('$2')} THEN 'admin' WHEN ${at('$3')} THEN 'write' WHEN ${at('$4')} THEN 'read' END`;
}
const levelPerms = (documentAccess) => ['admin', 'write', 'read'].map(l => documentAccess.permissionsFor(l));
async function levelsOn(documentAccess, client, docId) {
  const { rows } = await client.query(
    `SELECT t.user_id::text AS uid, ${levelsSql(documentAccess, 'd')} AS level FROM documents d CROSS JOIN user_roles t WHERE d.id = $1`,
    [docId, ...levelPerms(documentAccess)]);
  return new Map(rows.filter(r => r.level).map(r => [r.uid, r.level]));
}
const asClient = (db) => ({ query: (q, p) => db.query(q, p).then(rows => ({ rows })) });

// Inside a transaction that is always rolled back: run fn(client).
async function rolledBack(db, fn) {
  let out;
  await db.withTransaction(async (c) => {
    out = await fn(c);
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
  return out;
}

// A door's level for everyone: a real library file put behind it (at <folder>/<name>),
// with an uploader no account has and no grants of its own. `before` runs first in the
// same rolled-back transaction (to take a key away and see what's left).
async function doorLevels(db, documentAccess, libraryId, folder, before = null) {
  return rolledBack(db, async (c) => {
    if (before) await before(c);
    const { rows: [{ id }] } = await c.query(
      `INSERT INTO documents (name, mime_type, storage_path, uploaded_by, library_id, library_scoped)
       VALUES ($1, 'text/plain', 'probe', gen_random_uuid(), $2, true) RETURNING id`,
      [folder ? `${folder}/zz probe file` : 'zz probe file', libraryId]);
    return levelsOn(documentAccess, c, id);
  });
}

module.exports = { mulberry32, scenario, load, levelsOn, asClient, rolledBack, doorLevels, FOLDERS, NAMES };
