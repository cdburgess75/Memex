'use strict';
// Creating a library records its owner (by user id) and chains the creation.
const request = require('supertest');
const express = require('express');

const mockQueries = [];
jest.mock('../../lib/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    // no owner columns echoed back: what the INSERT stores is checked column by column below
    if (/INSERT INTO libraries/.test(sql)) return { id: 'lib-new', name: params[0], created_at: new Date() };
    return null;
  }),
}));
const mockAppend = jest.fn().mockResolvedValue({});
jest.mock('../../lib/auditLog', () => ({ append: (...a) => mockAppend(...a) }));
let mockUser;
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const app = () => { const a = express(); a.use(express.json()); a.use('/api/libraries', require('../../routes/libraries')); return a; };
beforeEach(() => { mockQueries.length = 0; mockAppend.mockClear(); });

// Which value each column of the INSERT receives: `INSERT INTO t (a, b) VALUES ($1, $2)`
// with its parameters, resolved column by column.
function insertedRow({ sql, params }) {
  const m = sql.match(/INSERT INTO libraries\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/);
  const cols = m[1].split(',').map(c => c.trim());
  const vals = m[2].split(',').map(v => v.trim());
  expect(vals).toHaveLength(cols.length);
  return Object.fromEntries(cols.map((c, i) => {
    const ref = vals[i].match(/^\$(\d+)$/);
    return [c, ref ? params[Number(ref[1]) - 1] : vals[i]];
  }));
}

test('the creator owns the library, recorded by id with a lower-cased address', async () => {
  mockUser = { id: '11111111-1111-4111-8111-111111111111', email: 'Richard@PTechLLC.com', role: 'contributor' };
  const res = await request(app()).post('/api/libraries').send({ name: 'Clients' });
  expect(res.status).toBe(200);
  const row = insertedRow(mockQueries.find(q => /INSERT INTO libraries/.test(q.sql)));
  expect(row).toEqual({
    name: 'Clients',
    created_by: mockUser.id, created_by_email: 'richard@ptechllc.com',
    owner_id: mockUser.id, owner_email: 'richard@ptechllc.com',
  });
});

test('a failed audit write never fails the create', async () => {
  mockUser = { id: '11111111-1111-4111-8111-111111111111', email: 'richard@ptechllc.com', role: 'contributor' };
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockAppend.mockRejectedValueOnce(new Error('chain locked'));
  const res = await request(app()).post('/api/libraries').send({ name: 'Clients' });
  expect(res.status).toBe(200);
  expect(res.body.id).toBe('lib-new');
  expect(err).toHaveBeenCalledWith('audit library_created failed:', 'chain locked');
  err.mockRestore();
});

test('creation is chained with the id first and the name quoted', async () => {
  mockUser = { id: '11111111-1111-4111-8111-111111111111', email: 'richard@ptechllc.com', role: 'contributor' };
  await request(app()).post('/api/libraries').send({ name: 'Payroll (lib-old)' });
  expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
    eventType: 'library_created', detail: `library lib-new "Payroll (lib-old)" owner ${mockUser.id}`,
  }));
});

test('a viewer cannot create a library', async () => {
  mockUser = { id: '55555555-5555-4555-8555-555555555555', email: 'v@x.com', role: 'viewer' };
  expect((await request(app()).post('/api/libraries').send({ name: 'Nope' })).status).toBe(403);
  expect(mockQueries).toHaveLength(0);
});
