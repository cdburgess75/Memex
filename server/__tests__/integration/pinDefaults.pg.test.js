'use strict';
// "Pin for everyone in this group" (migration 0024, lib/pinDefaults.js) through the real
// routes -- groups, library shares, preferences -- and the real auth middleware, against a
// REAL, THROWAWAY Postgres. DROPS AND RECREATES the public schema; refuses unless the
// database name has "test" in it.
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_test \
//     npx jest --runInBand integration/pinDefaults.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(60000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));

const person = (n, email, role = 'contributor', verified = true) => ({ id: `0000000${n}-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, email, role, verified });
const OWNER = person(1, 'owner@corp.test');
const AMY = person(2, 'amy@corp.test');            // in IT, signed in before, has her own pin
const BEN = person(3, 'ben@corp.test');            // in IT, first signs in after the default is set
const CLAIM = person(4, 'cat@corp.test', 'contributor', false); // claims a member's address, unverified
const OUT = person(5, 'out@corp.test');            // not in IT
const DEE = person(6, 'dee@corp.test');            // joins IT later
const EVE = person(7, 'eve@corp.test', 'viewer');  // joins IT after MSP's default is turned off
const FAY = person(8, 'fay@corp.test');            // many page loads at once

suite('pinned by default for a group, in a real database', () => {
  let db, app, request, jwt;
  let IT, CLIENTS, MSP, OLD, clientsShare, mspShare, folderShare, personShare;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const as = (who) => jwt.verify.mockReturnValue({ sub: who.id, email: who.email, email_verified: who.verified });
  const call = (who, method, url, body) => { as(who); const r = request(app)[method](url).set('Authorization', 'Bearer t'); return body === undefined ? r : r.send(body); };
  const pins = async (who) => { const r = await call(who, 'get', '/api/preferences'); expect(r.status).toBe(200); return r.body.pinnedLibraries; };
  const setPin = (who, lib, share, pinned) => call(who, 'put', `/api/libraries/${lib}/shares/${share}/pin`, { pinned });
  const share = async (lib, body) => { const r = await call(OWNER, 'post', `/api/libraries/${lib}/shares`, body); expect(r.status).toBe(201); return r.body.share; };
  const addMember = async (email) => expect((await call(OWNER, 'post', `/api/groups/${IT}/members`, { email })).status).toBe(201);
  const audits = () => db.query("SELECT detail FROM document_events WHERE detail LIKE '%pin for members%' ORDER BY chain_seq");

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    jwt = require('jsonwebtoken');
    jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/preferences', require('../../routes/preferences'));
    app.use('/api/libraries', require('../../routes/libraries'));
    app.use('/api/groups', require('../../routes/groups'));

    // Everybody but Ben and Dee has signed in before (the real auth middleware makes their
    // accounts on first sight; this just records the rest).
    for (const p of [OWNER, AMY, CLAIM, OUT, EVE, FAY]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $4)', [p.id, p.email, p.role, p.verified ? p.email : null]);
    }
    const lib = async (name) => (await db.queryOne(
      'INSERT INTO libraries (name, created_by, created_by_email, owner_id, owner_email) VALUES ($1, $2, $3, $2, $3) RETURNING id', [name, OWNER.id, OWNER.email])).id;
    CLIENTS = await lib('Clients'); MSP = await lib('MSP'); OLD = await lib('Old stuff');
    const g = await call(OWNER, 'post', '/api/groups', { name: 'IT' });
    expect(g.status).toBe(201);
    IT = (g.body.group || g.body).id;
    for (const e of [AMY.email, BEN.email, 'Cat@Corp.test', FAY.email]) await addMember(e);
    // Amy's own pins, from before.
    await db.query(`INSERT INTO user_preferences (user_id, pinned_libraries) VALUES ($1, $2::jsonb)`, [AMY.id, JSON.stringify(['her-own'])]);

    clientsShare = await share(CLIENTS, { group_id: IT, permission: 'write' });
    mspShare = await share(MSP, { group_id: IT, permission: 'read' });
    personShare = await share(MSP, { email: OUT.email, permission: 'read' });
    const oldShare = await share(OLD, { group_id: IT, permission: 'read' });
    // a folder share needs a folder the owner can see
    await db.query(`INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
                    VALUES ('Sub/a.txt', 1, 'text/plain', 'p/a', $1, $2, $3, true)`, [OWNER.id, OWNER.email, CLIENTS]);
    folderShare = await share(CLIENTS, { group_id: IT, permission: 'read', folder_path: 'Sub' });
    expect((await setPin(OWNER, OLD, oldShare.id, true)).status).toBe(200);
    await db.query('UPDATE libraries SET archived_at = NOW() WHERE id = $1', [OLD]);
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  test('nothing is pinned for anyone until the owner says so', async () => {
    expect(await pins(AMY)).toEqual(['her-own']);
    expect(clientsShare.pin_by_default).toBe(false);
  });

  test('only a group share of the whole library takes it, only from someone who manages the library', async () => {
    const before = await db.query('SELECT id, pin_by_default FROM library_grants ORDER BY id');
    expect((await setPin(OWNER, CLIENTS, folderShare.id, true)).status).toBe(400);
    expect((await setPin(OWNER, MSP, personShare.id, true)).status).toBe(400);
    expect((await call(OWNER, 'put', `/api/libraries/${CLIENTS}/shares/${clientsShare.id}/pin`, { pinned: 'yes' })).status).toBe(400);
    expect((await setPin(OWNER, MSP, clientsShare.id, true)).status).toBe(404);        // another library's share
    expect((await setPin(AMY, CLIENTS, clientsShare.id, true)).status).toBe(403);      // a Read-Write member, not the owner
    expect((await setPin(EVE, CLIENTS, clientsShare.id, true)).status).toBe(403);      // a viewer
    expect((await setPin(OUT, CLIENTS, clientsShare.id, true)).status).toBe(404);      // cannot see the library
    expect(await db.query('SELECT id, pin_by_default FROM library_grants ORDER BY id')).toEqual(before);
    // and the table itself refuses it on anything else
    await expect(db.query('UPDATE library_grants SET pin_by_default = true WHERE id = $1', [folderShare.id])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('UPDATE library_grants SET pin_by_default = true WHERE id = $1', [personShare.id])).rejects.toMatchObject({ code: '23514' });
  });

  test('the owner turns it on; the share list says so, and the audit log records it', async () => {
    const r = await setPin(OWNER, CLIENTS, clientsShare.id, true);
    expect(r.status).toBe(200);
    expect(r.body.share.pin_by_default).toBe(true);
    expect((await setPin(OWNER, MSP, mspShare.id, true)).status).toBe(200);
    expect((await setPin(OWNER, MSP, mspShare.id, true)).status).toBe(200); // again: no change, no second audit row
    const list = (await call(OWNER, 'get', `/api/libraries/${CLIENTS}/shares`)).body.shares;
    expect(list.find(x => x.id === clientsShare.id).pin_by_default).toBe(true);
    expect(list.find(x => x.id === folderShare.id).pin_by_default).toBe(false);
    const rows = (await audits()).map(a => a.detail);
    expect(rows.filter(d => d.includes(`library ${MSP} `))).toHaveLength(1);
    expect(rows.some(d => d.includes(`library ${CLIENTS} `) && d.includes(' on by '))).toBe(true);
  });

  test('a member gets them once, after their own pins, in name order -- not the archived one', async () => {
    expect(await pins(AMY)).toEqual(['her-own', CLIENTS, MSP]);
    expect(await pins(AMY)).toEqual(['her-own', CLIENTS, MSP]);
  });

  test('unpinned stays unpinned', async () => {
    expect((await call(AMY, 'put', '/api/preferences', { pinnedLibraries: ['her-own', CLIENTS], favoriteFiles: [] })).status).toBe(200);
    expect(await pins(AMY)).toEqual(['her-own', CLIENTS]);
    expect(await pins(AMY)).toEqual(['her-own', CLIENTS]);
  });

  test('a member signing in for the first time gets them', async () => {
    expect(await db.queryOne('SELECT 1 FROM user_roles WHERE user_id = $1', [BEN.id])).toBeNull();
    expect(await pins(BEN)).toEqual([CLIENTS, MSP]);
  });

  test('an unverified address that claims a member, and someone outside the group, get nothing', async () => {
    expect(await pins(CLAIM)).toEqual([]);
    expect(await pins(OUT)).toEqual([]);
    expect(await db.queryOne('SELECT count(*)::int AS n FROM pin_defaults_applied WHERE user_id = ANY($1::uuid[])', [[CLAIM.id, OUT.id]])).toEqual({ n: 0 });
  });

  test('many page loads at once give each library once', async () => {
    const all = await Promise.all(Array.from({ length: 6 }, () => pins(FAY)));
    for (const p of all) expect(new Set(p).size).toBe(p.length);
    expect(await pins(FAY)).toEqual([CLIENTS, MSP]);
  });

  test('someone who joins the group later gets them on their next page load', async () => {
    await addMember(DEE.email);
    expect(await pins(DEE)).toEqual([CLIENTS, MSP]);
  });

  test('turned off: nobody new gets it, and nobody loses a pin they were given', async () => {
    expect((await setPin(OWNER, MSP, mspShare.id, false)).status).toBe(200);
    await addMember(EVE.email);
    expect(await pins(EVE)).toEqual([CLIENTS]);
    expect(await pins(BEN)).toEqual([CLIENTS, MSP]);
  });

  test('a share removed and made again does not bring back what someone unpinned', async () => {
    expect((await call(OWNER, 'delete', `/api/libraries/${MSP}/shares/${mspShare.id}`)).status).toBe(200);
    mspShare = await share(MSP, { group_id: IT, permission: 'read' });
    expect((await setPin(OWNER, MSP, mspShare.id, true)).status).toBe(200);
    expect(await pins(AMY)).toEqual(['her-own', CLIENTS]);   // unpinned it before: stays unpinned
    expect(await pins(EVE)).toEqual([CLIENTS, MSP]);          // never had it: gets it now
  });

  test('a library brought back from the archive is given then, once', async () => {
    await db.query('UPDATE libraries SET archived_at = NULL WHERE id = $1', [OLD]);
    expect(await pins(BEN)).toEqual([CLIENTS, MSP, OLD]);
    expect(await pins(BEN)).toEqual([CLIENTS, MSP, OLD]);
  });
});
