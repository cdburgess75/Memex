'use strict';
// The Home Storage tile: on the real disk, "used" is what is stored and "free" is what
// Depot can still write. The filesystem's own reserve must not read as used.
const request = require('supertest');
const express = require('express');
const fs = require('fs');

jest.mock('../../lib/db', () => ({ query: jest.fn().mockResolvedValue([]), queryOne: jest.fn().mockResolvedValue({ n: 1 }) }));
jest.mock('../../lib/storage', () => ({
  getUrl: jest.fn(), download: jest.fn(), isLocalProvider: jest.fn().mockResolvedValue(true),
  localBase: jest.fn().mockResolvedValue('/data/documents'), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn() }));
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'u1', email: 'a@test.com', role: 'admin' }; next(); });

const settings = require('../../lib/settings');
const app = express();
app.use('/api/files', require('../../routes/files'));

const GiB = 1024 ** 3;
// A 1100 GiB filesystem with 50 GiB stored and the usual 5% (55 GiB) held back for the system.
const BS = 4096;
const disk = { bsize: BS, blocks: (1100 * GiB) / BS, bfree: (1050 * GiB) / BS, bavail: (995 * GiB) / BS };

afterEach(() => jest.restoreAllMocks());

test('used is what is stored, free is what Depot can write, and the reserve is in neither', async () => {
  jest.spyOn(fs.promises, 'statfs').mockResolvedValue(disk);
  const res = await request(app).get('/api/files/home-stats').expect(200);
  expect(res.body.usedBytes).toBe(50 * GiB);
  expect(res.body.freeBytes).toBe(995 * GiB);
  expect(res.body.totalBytes).toBe(1045 * GiB); // used + free, not the raw 1100
});

test('a workspace quota still wins, and sends no disk figures', async () => {
  jest.spyOn(fs.promises, 'statfs').mockResolvedValue(disk);
  settings.getOrEnv.mockImplementation(async (k) => (k === 'storage_quota_gb' ? '200' : null));
  const res = await request(app).get('/api/files/home-stats').expect(200);
  expect(res.body.totalBytes).toBe(200 * GiB);
  expect(res.body.usedBytes).toBeNull();
  expect(res.body.freeBytes).toBeNull();
  settings.getOrEnv.mockResolvedValue(null);
});
