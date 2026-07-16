'use strict';
// Baseline security response headers (SOC 2 / customer-security-review hygiene).
// Deliberately conservative so nothing in the app breaks:
//   - Content-Security-Policy sets only the directives that are safe without
//     de-inlining the single-file SPA: object-src/base-uri/frame-ancestors add
//     plugin-injection, base-tag-injection, and clickjacking protection. script-src
//     and connect-src are deliberately omitted here (a strict script-src would blank
//     the inline-script SPA, and connect-src is deployment-specific) — locking those
//     down, which is what would block XSS token exfiltration, is a separate,
//     test-gated rollout (report-only first). CSP for the Collabora editor is
//     handled separately by its same-origin proxy.
//   - Permissions-Policy allows microphone/camera for same-origin (the built-in
//     A/V calls use getUserMedia); geolocation is disabled.
//   - HSTS is only sent when the request actually arrived over HTTPS (behind the
//     Caddy TLS proxy), so plain-http local installs are unaffected.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Only the directives that are safe without de-inlining the SPA (see note above):
  // no plugins, no injected <base>, and no framing by other origins.
  res.setHeader('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  // Only over genuine HTTPS. req.secure already honors X-Forwarded-Proto when the
  // app trusts the proxy (set behind Caddy); reading the raw header ourselves
  // would let a client on the plain-http listener spoof HSTS onto a cleartext
  // response when trust-proxy is off.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

module.exports = securityHeaders;
