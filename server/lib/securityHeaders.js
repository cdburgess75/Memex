'use strict';
// Baseline security response headers (SOC 2 / customer-security-review hygiene).
//
// The Content-Security-Policy is ENFORCED on self-contained deployments and left
// report-only everywhere else. The full policy is safe to enforce when every resource
// the browser loads is same-origin — verified statically and against the live box:
//   - no external scripts/styles/fonts (Inter is self-hosted at /vendor/fonts) and
//     no eval/new Function, so `script-src 'self' 'unsafe-inline'` (the SPA is inline,
//     with inline handlers) and `style-src 'self' 'unsafe-inline'` suffice —
//     'unsafe-eval' is deliberately NOT granted (the vendor xlsx/mammoth bundles' eval
//     paths are dead in-browser);
//   - no external images (avatars are CSS initials) → `img-src 'self' data: blob:`;
//   - `connect-src 'self'` — the directive that stops XSS token exfiltration: AI
//     providers are proxied server-side, the A/V signaling socket is same-origin
//     (wss://<host>/ws), Keycloak is proxied same-origin, ICE config from /webrtc/ice;
//   - `frame-src 'self'` — the Collabora editor and PDF preview are same-origin
//     (Collabora is proxied THROUGH the app; its own internals bypass this middleware,
//     which is mounted AFTER the proxy).
//
// But three NON-default configurations put resources on other origins, and enforcing
// 'self' would break them: S3 object storage (previews load from external
// presigned URLs), a separately-hosted Collabora (collabora_url set), and a
// split-domain Keycloak (external KEYCLOAK_URL). For those we keep the policy
// report-only so nothing breaks — the report-uri still gathers data for a tailored
// policy. configure({selfContained}) is called once at boot; until then, and whenever
// detection is unsure, we FAIL SAFE to report-only.
//
// Permissions-Policy allows same-origin microphone/camera (built-in A/V calls);
// geolocation is off. HSTS only over genuine HTTPS (behind Caddy), so plain-http local
// installs are unaffected.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "report-uri /api/csp-report",
].join('; ');

// Fail-safe default: do NOT enforce until a boot-time check proves the deployment is
// self-contained. A misdetection must never break a customer, so unknown → report-only.
let _enforceEligible = false;
function configure({ selfContained } = {}) { _enforceEligible = selfContained === true; }

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Enforce only on a self-contained deployment over real HTTPS (the same condition
  // that makes Keycloak same-origin); otherwise report-only so nothing is broken.
  const enforce = _enforceEligible && req.secure;
  res.setHeader(enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', CSP);
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

securityHeaders.configure = configure;
module.exports = securityHeaders;
