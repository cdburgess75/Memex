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

// The enforce/report-only gate is module-level; reset to the fail-safe default so
// tests don't leak state into each other.
afterEach(() => securityHeaders.configure({ selfContained: false }));
const https = (a) => request(a).get('/x').set('x-forwarded-proto', 'https');

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

  test('self-contained deployment over HTTPS: ENFORCES the full policy', async () => {
    securityHeaders.configure({ selfContained: true });
    const r = await https(app());
    const csp = r.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(r.headers['content-security-policy-report-only']).toBeUndefined();
    // The security-critical directive — connect-src 'self' stops XSS token exfiltration.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("media-src 'self'");
    // The inline single-file SPA + its inline handlers still work ('unsafe-inline'),
    // but eval/new Function do not ('unsafe-eval' deliberately absent).
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    // report-uri is retained under enforcement so anything unexercised still surfaces.
    expect(csp).toContain('report-uri /api/csp-report');
  });

  test('self-contained but plain HTTP: stays report-only (Keycloak port is cross-origin there)', async () => {
    securityHeaders.configure({ selfContained: true });
    const r = await request(app()).get('/x'); // no x-forwarded-proto → req.secure false
    expect(r.headers['content-security-policy']).toBeUndefined();
    expect(r.headers['content-security-policy-report-only']).toContain("connect-src 'self'");
  });

  test('NON-self-contained (external storage/Collabora/Keycloak): stays report-only even over HTTPS', async () => {
    securityHeaders.configure({ selfContained: false });
    const r = await https(app());
    expect(r.headers['content-security-policy']).toBeUndefined();
    const ro = r.headers['content-security-policy-report-only'];
    expect(ro).toContain("connect-src 'self'");
    expect(ro).toContain('report-uri /api/csp-report');
  });

  test('fail-safe: before configure() runs, does NOT enforce (report-only)', async () => {
    // module default is selfContained:false; a fresh deployment must never enforce
    // until the boot-time check has proven it safe.
    const r = await https(app());
    expect(r.headers['content-security-policy']).toBeUndefined();
    expect(r.headers['content-security-policy-report-only']).toBeDefined();
  });
});
