'use strict';
// Creating a library records its owner (by user id) and chains the creation.
const request = require('supertest');
const express = require('express');

const mockQueries = [];
jest.mock('../../lib/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/INSERT INTO libraries/.test(sql)) return { id: 'lib-new', name: params[0], created_by_email: params[2], owner_id: params[1], owner_email: params[2], created_at: new Date() };
    return null;
  }),
}));
const mockAppend = jest.fn().mockResolvedValue({});
jest.mock('../../lib/auditLog', () => ({ append: (...a) => mockAppend(...a) }));
let mockUser;
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const app = () => { const a = express(); a.use(express.json()); a.use('/api/libraries', require('../../routes/libraries')); return a; };
beforeEach(() => { mockQueries.length = 0; mockAppend.mockClear(); });

test('the creator owns the library, recorded by id with a lower-cased address', async () => {
  mockUser = { id: '11111111-1111-4111-8111-111111111111', email: 'Richard@PTechLLC.com', role: 'contributor' };
  const res = await request(app()).post('/api/libraries').send({ name: 'Clients' });
  expect(res.status).toBe(200);
  const ins = mockQueries.find(q => /INSERT INTO libraries/.test(q.sql));
  expect(ins.sql).toMatch(/owner_id, owner_email/);
  expect(ins.params).toEqual(['Clients', mockUser.id, 'richard@ptechllc.com']);
  expect(res.body.owner_id).toBe(mockUser.id);
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
