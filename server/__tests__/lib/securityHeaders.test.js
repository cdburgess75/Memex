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

  test('sets a safe CSP (no script-src/connect-src, so the inline-script SPA still works)', async () => {
    const r = await request(app()).get('/x');
    const csp = r.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    // Deliberately absent: restricting these would blank the single-file SPA.
    expect(csp).not.toMatch(/script-src/);
    expect(csp).not.toMatch(/connect-src/);
  });

  test('sends a report-only CSP with connect-src + report-uri (enforces nothing yet)', async () => {
    const r = await request(app()).get('/x');
    const ro = r.headers['content-security-policy-report-only'];
    expect(ro).toBeDefined();
    expect(ro).toContain("connect-src 'self'");
    expect(ro).toContain('report-uri /api/csp-report');
    // The connect-src lockdown lives ONLY in the report-only header, never enforced yet.
    expect(r.headers['content-security-policy']).not.toContain('connect-src');
  });
});
