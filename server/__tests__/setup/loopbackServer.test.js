'use strict';
// The flake this guards against is invisible: if a supertest upgrade renames the internals
// __tests__/setup/loopbackServer.js hooks into, the hook stops applying, every request
// quietly goes back to its own wildcard-bound throwaway server, and one run in eight or so
// loses a random test to a port another process already holds on 127.0.0.1. Nothing fails
// at the seam, so the seam is what gets checked here.
const request = require('supertest');
const express = require('express');

const app = () => {
  const a = express();
  a.get('/echo', (req, res) => res.json({ headers: Object.keys(req.headers) }));
  return a;
};

test('every supertest request goes through the shared loopback server', async () => {
  const t = request(app()).get('/echo');
  await t;
  expect(t._dispatchId).toBeTruthy();          // the hook applied
  expect(t.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/echo$/); // dialled where it is bound
});

test('two requests share one server, rather than binding a port each', async () => {
  const first = request(app()).get('/echo');
  await first;
  const second = request(app()).get('/echo');
  await second;
  const portOf = (t) => t.url.match(/:(\d+)\//)[1];
  expect(portOf(second)).toBe(portOf(first));
});

test('the routing header is stripped before any route sees it', async () => {
  const res = await request(app()).get('/echo');
  expect(res.status).toBe(200);
  expect(res.body.headers).not.toContain('x-supertest-app');
});
