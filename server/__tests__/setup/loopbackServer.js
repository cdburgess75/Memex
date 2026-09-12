'use strict';
/* One HTTP server per test file, bound to the address the tests actually dial.
 *
 * Left alone, supertest starts a throwaway server for EVERY request: `app.listen(0)`,
 * which binds the wildcard address, and then it connects to `127.0.0.1` on whatever port
 * the kernel handed out. On macOS those two are not the same question. Asked for an
 * ephemeral port on the wildcard address, the kernel will hand out a port that another
 * process already holds on 127.0.0.1 alone -- an `ssh -L` tunnel, Tailscale's local API --
 * even though binding that same port explicitly would be refused. The connection then goes
 * to the most specific listener, which is the other process, and the test is answered by
 * something that has never heard of Depot: Tailscale's `401 auth required`, or a reset
 * from a tunnel with nothing on the far end ("socket hang up").
 *
 * Measured on this machine: 5 wildcard binds in 40,000 were handed a port somebody else
 * held on loopback; 0 in 40,000 when binding 127.0.0.1 directly. A run makes 864 supertest
 * requests, so that is about one run in ten losing one test -- a different one each time,
 * green again the moment it was re-run. Linux CI never saw it because Linux refuses the
 * double-booking outright, and because none of this is about parallelism: --runInBand is
 * just as exposed on a machine with loopback tunnels running.
 *
 * So: bind ONE server per test file, on 127.0.0.1 itself, and route every request through
 * it. An address the kernel will not double-book cannot be mistaken for someone else's,
 * and one long-lived connection replaces 864 short-lived ones. Each request names the app
 * it belongs to in a header, so tests firing several at once still reach the right one;
 * the header is removed before any route sees it.
 *
 * Nothing else changes: supertest's own request building, assertions and error handling are
 * untouched, and a caller that hands supertest an already-listening server or a URL still
 * gets stock behaviour.
 */
const http = require('http');
const { Test } = require('supertest');

const DISPATCH_HEADER = 'x-supertest-app';

const apps = new Map(); // dispatch id -> the request handler supertest was given
let nextId = 1;
let server = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const id = req.headers[DISPATCH_HEADER];
    delete req.headers[DISPATCH_HEADER]; // routes must see exactly what the test sent
    const handler = apps.get(id);
    if (!handler) {
      // Can only happen if a Test outlived the file that made it; say so loudly rather
      // than letting it look like a route returning 500.
      res.statusCode = 500;
      return res.end('loopbackServer: no app registered for this request');
    }
    handler(req, res);
  });
  // Idle connections are the point -- one connection serves the whole file -- so don't let
  // the server hang up on them mid-run and force a reconnect.
  server.keepAliveTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  apps.clear();
  if (!server) return;
  server.closeAllConnections(); // the client keeps one alive on purpose; let jest exit
  await new Promise((resolve) => server.close(resolve));
  server = null;
});

// supertest wraps a bare express app in an http.Server it has not listened on yet. That --
// and only that -- is what we take over.
const stockServerAddress = Test.prototype.serverAddress;
Test.prototype.serverAddress = function serverAddress(app, path) {
  const handler = server && typeof app.address === 'function' && app.address() === null
    ? app.listeners('request')[0]
    : null;
  if (!handler) return stockServerAddress.call(this, app, path);
  const id = String(nextId++);
  apps.set(id, handler);
  this._dispatchId = id;
  return `http://127.0.0.1:${server.address().port}${path}`;
};

const stockEnd = Test.prototype.end;
Test.prototype.end = function end(fn) {
  if (this._dispatchId) this.set(DISPATCH_HEADER, this._dispatchId);
  return stockEnd.call(this, fn);
};
