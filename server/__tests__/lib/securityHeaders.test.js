'use strict';
const express = require('express');
const request = require('supertest');
const securityHeaders = require('../../lib/securityHeaders');

function app(trustProxy = true) {
  const a = express();
  a.set('trust proxy', trustProxy); // when true, req.secure reflects x-forwarded-proto
  a.use(securityHeaders);
  a.get('/x', (_req, res) => res.send('ok'));
  return a;
}

describe('securityHeaders', () => {
  test('sets the baseline hardening headers on every response', async () => {
    const r = await request(app()).get('/x');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    // A/V calls need mic/cam for same-origin; geolocation is off.
    expect(r.headers['permissions-policy']).toContain('microphone=(self)');
    expect(r.headers['permissions-policy']).toContain('camera=(self)');
    expect(r.headers['permissions-policy']).toContain('geolocation=()');
  });

  test('does NOT send HSTS over plain http (local installs unaffected)', async () => {
    const r = await request(app()).get('/x');
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });

  test('sends HSTS when the request arrived over https (behind the TLS proxy)', async () => {
    const r = await request(app()).get('/x').set('x-forwarded-proto', 'https');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(r.headers['strict-transport-security']).toContain('includeSubDomains');
  });

  test('does NOT send HSTS for a spoofed x-forwarded-proto when trust-proxy is off', async () => {
    const r = await request(app(false)).get('/x').set('x-forwarded-proto', 'https');
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });

  test('does not set a restrictive CSP (SPA relies on inline scripts)', async () => {
    const r = await request(app()).get('/x');
    expect(r.headers['content-security-policy']).toBeUndefined();
  });
});
