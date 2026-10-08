'use strict';
// "Open this library when I sign in" is kept with the other preferences -- through the
// real route, against a REAL, THROWAWAY Postgres: a page that does not send it never
// clears it. DROPS AND RECREATES the public schema; refuses unless the name has "test".
const fs = require('fs');
const path = require('path');
const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: '00000000-0000-4000-8000-000000000001', email: 'u@corp.test' }; next(); });

suite('the library opened at sign-in, in a real database', () => {
  let db, app, request;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json()); app.use('/api/preferences', require('../../routes/preferences'));
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  test('set, kept by a save that does not mention it, then cleared', async () => {
    expect((await request(app).get('/api/preferences')).body.startLibrary).toBeNull();
    await request(app).put('/api/preferences').send({ pinnedLibraries: ['a'], favoriteFiles: [], startLibrary: 'lib-1' }).expect(200);
    expect((await request(app).get('/api/preferences')).body).toEqual({ pinnedLibraries: ['a'], favoriteFiles: [], startLibrary: 'lib-1' });
    await request(app).put('/api/preferences').send({ pinnedLibraries: ['a', 'b'], favoriteFiles: ['f'] }).expect(200);
    expect((await request(app).get('/api/preferences')).body).toEqual({ pinnedLibraries: ['a', 'b'], favoriteFiles: ['f'], startLibrary: 'lib-1' });
    await request(app).put('/api/preferences').send({ pinnedLibraries: [], favoriteFiles: [], startLibrary: null }).expect(200);
    expect((await request(app).get('/api/preferences')).body.startLibrary).toBeNull();
  });
});
