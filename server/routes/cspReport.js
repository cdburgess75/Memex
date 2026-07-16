'use strict';
// Sink for Content-Security-Policy (report-only) violation reports during the CSP
// rollout. Logs one concise, sanitized line per report and returns 204. Deliberately
// unauthenticated (browsers post CSP reports without credentials) and body-size
// capped; the report body is never stored, only summarized to the log.
const express = require('express');
const router = express.Router();

const clean = (v) => String(v ?? '?').replace(/[\r\n\t]+/g, ' ').slice(0, 200);

router.post('/', express.json({ type: () => true, limit: '8kb' }), (req, res) => {
  try {
    const r = (req.body && (req.body['csp-report'] || req.body.body || req.body)) || {};
    const directive = clean(r['violated-directive'] || r['effective-directive'] || r.effectiveDirective);
    const blocked = clean(r['blocked-uri'] || r.blockedURL);
    console.log(`[csp-report] ${directive} blocked ${blocked}`);
  } catch { /* ignore malformed report */ }
  res.status(204).end();
});

module.exports = router;
