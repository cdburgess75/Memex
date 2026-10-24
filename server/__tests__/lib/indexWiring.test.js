'use strict';
// server/index.js is the composition root and is not loaded by tests (it listens), so
// its wiring is pinned by reading it: the read-only gate must sit after the rate
// limiters and before every router, or a new content route could slip past it.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

test('the license gate is mounted once, after the API rate limiter and before the first router', () => {
  const gate = src.indexOf("app.use(require('./middleware/licenseGate'));");
  expect(gate).toBeGreaterThan(0);
  expect(src.indexOf("app.use(require('./middleware/licenseGate'))", gate + 1)).toBe(-1);
  expect(src.indexOf("app.use('/api', apiLimiter);")).toBeLessThan(gate);
  for (const mount of ["app.use('/api/auth', require('./routes/auth'));", "app.use('/api/files', require('./routes/files'));", "app.use('/api/v1', require('./routes/v1'));", "app.use('/wopi', require('./routes/wopi'));", "app.use('/dav', require('./routes/dav'));"]) {
    expect(src.indexOf(mount)).toBeGreaterThan(gate);
  }
});

test('the license watch is armed at startup', () => {
  expect(src).toContain("require('./lib/licenseWatch').start()");
});
