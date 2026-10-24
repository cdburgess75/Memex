'use strict';
// Personal access tokens are the license's `api` feature: without it, none can be made.
const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'u1', email: 'a@test.com', role: 'contributor' }; next(); });
jest.mock('../../lib/apiTokens', () => ({ create: jest.fn(async () => ({ token: 'dpt_x', record: { id: 't1' } })), listFor: jest.fn(async () => []), SCOPES: ['read', 'write', 'admin'], revoke: jest.fn() }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/licenseEnforce', () => ({ feature: jest.fn(), refuseFeature: jest.fn((res, what) => res.status(403).json({ code: 'LICENSE_FEATURE', error: `${what} is not included in this server's license.` })) }));
const enforce = require('../../lib/licenseEnforce');
const apiTokens = require('../../lib/apiTokens');

const app = express();
app.use(express.json());
app.use('/api/tokens', require('../../routes/tokens'));

test('with the api feature a token is made', async () => {
  enforce.feature.mockResolvedValue(true);
  const r = await request(app).post('/api/tokens').send({ name: 'Importer', scope: 'write' });
  expect(r.status).toBe(201);
  expect(apiTokens.create).toHaveBeenCalled();
});

test('without it, 403 LICENSE_FEATURE and nothing is made', async () => {
  enforce.feature.mockResolvedValue(false);
  const r = await request(app).post('/api/tokens').send({ name: 'Importer', scope: 'write' });
  expect(r.status).toBe(403);
  expect(r.body).toEqual({ code: 'LICENSE_FEATURE', error: "The API is not included in this server's license." });
  expect(enforce.feature).toHaveBeenCalledWith('api');
  expect(apiTokens.create).not.toHaveBeenCalled();
});

test('listing tokens is not gated', async () => {
  enforce.feature.mockResolvedValue(false);
  expect((await request(app).get('/api/tokens')).status).toBe(200);
});
