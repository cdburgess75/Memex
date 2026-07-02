'use strict';
// Covers the AI per-library scoping added to searchAccessibleDocuments: the
// libraryIds argument becomes a trailing uuid[] param, and its placeholder index
// ($7) must sit right after the query ($1) and the five ACL params.
jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
}));

const db = require('../../lib/db');
const access = require('../../lib/documentAccess');

const user = { id: '810da857-4296-473f-99e9-96f2a5ebd47e', email: 'u@test.com', role: 'contributor' };
const searchCall = () => db.query.mock.calls.find(c => /document_fts/.test(c[0]));

describe('searchAccessibleDocuments — library scope', () => {
  beforeEach(() => {
    access._resetForTests();
    db.query.mockReset();
    db.query.mockResolvedValue([]);
  });

  test('userParams still returns exactly five params (so the library index is $7)', () => {
    expect(access.userParams(user, 'read')).toHaveLength(5);
  });

  test('no libraryIds → trailing param is null and placeholder is $7', async () => {
    await access.searchAccessibleDocuments(user, 'invoice');
    const call = searchCall();
    expect(call).toBeTruthy();
    expect(call[1][0]).toBe('invoice');                 // $1 query
    expect(call[1]).toHaveLength(7);                     // $1 + 5 ACL + library
    expect(call[1][6]).toBeNull();                       // $7 library param
    expect(call[0]).toContain('ANY($7::uuid[])');
  });

  test('libraryIds array is passed through (stringified) as the trailing param', async () => {
    const libs = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
    await access.searchAccessibleDocuments(user, 'invoice', 6, libs);
    expect(searchCall()[1][6]).toEqual(libs);
  });

  test('an empty libraryIds array means "no filter" (null), not an empty array', async () => {
    await access.searchAccessibleDocuments(user, 'invoice', 6, []);
    expect(searchCall()[1][6]).toBeNull();
  });

  test('a blank query short-circuits to []', async () => {
    await expect(access.searchAccessibleDocuments(user, '   ')).resolves.toEqual([]);
    expect(searchCall()).toBeUndefined();
  });
});
