'use strict';
// The /api/access routes: signed in only, the caller is whoever auth says, and a failure
// is a plain 500 with nothing from the database in it.
const request = require('supertest');
const express = require('express');

const mockState = { user: null };
jest.mock('../../middleware/auth', () => (req, res, next) => {
  if (!mockState.user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { ...mockState.user };
  next();
});
jest.mock('../../lib/accessKeys', () => ({ sharedWithMe: jest.fn() }));
const accessKeys = require('../../lib/accessKeys');
const app = () => { const a = express(); a.use('/api/access', require('../../routes/access')); return a; };
const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'me@acme.test', verifiedEmail: 'me@acme.test', role: 'viewer' };

beforeEach(() => { jest.clearAllMocks(); mockState.user = ME; jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('GET /api/access/shared-with-me', () => {
  test('needs a signed-in caller', async () => {
    mockState.user = null;
    expect((await request(app()).get('/api/access/shared-with-me')).status).toBe(401);
    expect(accessKeys.sharedWithMe).not.toHaveBeenCalled();
  });
  test('any role gets its own list', async () => {
    accessKeys.sharedWithMe.mockResolvedValue({ email_verified: true, libraries: [] });
    const res = await request(app()).get('/api/access/shared-with-me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email_verified: true, libraries: [] });
    expect(accessKeys.sharedWithMe).toHaveBeenCalledWith(expect.objectContaining({ id: ME.id, role: 'viewer' }));
  });
  test('a database failure is a generic 500', async () => {
    accessKeys.sharedWithMe.mockRejectedValue(Object.assign(new Error('relation "secret_table" does not exist'), { code: '42P01' }));
    const res = await request(app()).get('/api/access/shared-with-me');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret_table');
  });
});
