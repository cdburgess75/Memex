'use strict';
// GET /help/getting-started.pdf: the guide as a PDF for anyone, and a plain 404 when a
// build has no guide (never a "PDF" that is really an error message).
const path = require('path');
const fs = require('fs');
const express = require('express');
const request = require('supertest');

jest.mock('../../lib/gettingStarted', () => ({ pdfPath: jest.fn() }));
const gettingStarted = require('../../lib/gettingStarted');

const app = express();
app.use('/help', require('../../routes/help'));
const REAL = path.join(__dirname, '../../assets/getting-started/Getting started with Depot.pdf');
const binary = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

test('serves the bundled guide inline as a PDF', async () => {
  gettingStarted.pdfPath.mockReturnValue(REAL);
  const r = await request(app).get('/help/getting-started.pdf').buffer(true).parse(binary).expect(200);
  expect(r.headers['content-type']).toMatch(/^application\/pdf/);
  expect(r.headers['content-disposition']).toMatch(/^inline;/);
  expect(r.body.slice(0, 5).toString()).toBe('%PDF-');
  expect(r.body.length).toBe(fs.statSync(REAL).size);
});

test('a build without the guide answers a plain-text 404, without PDF headers', async () => {
  gettingStarted.pdfPath.mockReturnValue(path.join(__dirname, 'no-such-guide.pdf'));
  const r = await request(app).get('/help/getting-started.pdf').expect(404);
  expect(r.headers['content-type']).toMatch(/^text\/plain/);
  expect(r.headers['content-disposition']).toBeUndefined();
});

test('nothing else is served from /help', async () => {
  gettingStarted.pdfPath.mockReturnValue(REAL);
  await request(app).get('/help/other.pdf').expect(404);
  await request(app).get('/help/..%2findex.js').expect(404);
});
