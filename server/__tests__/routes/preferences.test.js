'use strict';
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db', () => ({ queryOne: jest.fn(), query: jest.fn() }));
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'user-1', email: 'u@test.com' }; next(); });

const db = require('../../lib/db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/preferences', require('../../routes/preferences'));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/preferences', () => {
  test('returns the stored sets for the caller', async () => {
    db.queryOne.mockResolvedValue({ pinned_libraries: ['lib-1'], favorite_files: ['doc-1', 'doc-2'] });
    const res = await request(makeApp()).get('/api/preferences');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pinnedLibraries: ['lib-1'], favoriteFiles: ['doc-1', 'doc-2'], startLibrary: null });
    expect(db.queryOne.mock.calls[0][1]).toEqual(['user-1']);
  });

  test('returns empty defaults when there is no row', async () => {
    db.queryOne.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/preferences');
    expect(res.body).toEqual({ pinnedLibraries: [], favoriteFiles: [], startLibrary: null });
  });

  test('degrades to empty defaults (not 500) if the query fails', async () => {
    db.queryOne.mockRejectedValue(new Error('relation "user_preferences" does not exist'));
    const res = await request(makeApp()).get('/api/preferences');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pinnedLibraries: [], favoriteFiles: [] });
  });
});

describe('PUT /api/preferences', () => {
  test('upserts the caller row, coercing/deduping ids to strings', async () => {
    db.queryOne.mockResolvedValue({ start_library: null });
    const res = await request(makeApp())
      .put('/api/preferences')
      .send({ pinnedLibraries: ['lib-1', 'lib-1', 2], favoriteFiles: ['doc-9'] });
    expect(res.status).toBe(200);
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO user_preferences/);
    expect(sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(params[0]).toBe('user-1');
    expect(JSON.parse(params[1])).toEqual(['lib-1', '2']); // deduped + stringified
    expect(JSON.parse(params[2])).toEqual(['doc-9']);
  });

  test('treats non-array input as empty', async () => {
    db.queryOne.mockResolvedValue({ start_library: null });
    const res = await request(makeApp()).put('/api/preferences').send({ pinnedLibraries: 'nope' });
    expect(res.status).toBe(200);
    const [, params] = db.queryOne.mock.calls[0];
    expect(JSON.parse(params[1])).toEqual([]);
    expect(JSON.parse(params[2])).toEqual([]);
  });
});

describe('the library opened at sign-in', () => {
  test('GET says which one', async () => {
    db.queryOne.mockResolvedValue({ pinned_libraries: [], favorite_files: [], start_library: 'lib-7' });
    const res = await request(makeApp()).get('/api/preferences');
    expect(res.body.startLibrary).toBe('lib-7');
  });
  test('PUT changes it only when the body names it', async () => {
    db.queryOne.mockResolvedValue({ start_library: 'lib-7' });
    await request(makeApp()).put('/api/preferences').send({ pinnedLibraries: [], favoriteFiles: [] });
    expect(db.queryOne.mock.calls[0][1].slice(3)).toEqual([false, null]);       // kept as it is
    await request(makeApp()).put('/api/preferences').send({ pinnedLibraries: [], favoriteFiles: [], startLibrary: 'lib-9' });
    expect(db.queryOne.mock.calls[1][1].slice(3)).toEqual([true, 'lib-9']);
    await request(makeApp()).put('/api/preferences').send({ pinnedLibraries: [], favoriteFiles: [], startLibrary: null });
    expect(db.queryOne.mock.calls[2][1].slice(3)).toEqual([true, null]);        // cleared
  });
});
