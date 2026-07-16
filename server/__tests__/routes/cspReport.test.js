'use strict';
const request = require('supertest');
const express = require('express');

function makeApp() {
  const app = express();
  app.use('/api/csp-report', require('../../routes/cspReport'));
  return app;
}

test('logs a concise line and returns 204', async () => {
  const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
  const res = await request(makeApp())
    .post('/api/csp-report')
    .set('Content-Type', 'application/csp-report')
    .send(JSON.stringify({ 'csp-report': { 'violated-directive': "connect-src 'self'", 'blocked-uri': 'https://evil.example/x' } }));
  expect(res.status).toBe(204);
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("connect-src 'self'"));
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('https://evil.example/x'));
  spy.mockRestore();
});

test('sanitizes newlines to prevent log injection', async () => {
  const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
  await request(makeApp())
    .post('/api/csp-report')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ 'csp-report': { 'violated-directive': "img-src\n[INJECTED LINE]", 'blocked-uri': 'x' } }));
  const logged = spy.mock.calls[0][0];
  expect(logged).not.toMatch(/\n/);
  spy.mockRestore();
});
