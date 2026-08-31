'use strict';
// Activity + audit logging for the file domain, plus a compact request
// fingerprint for auditing anonymous public downloads. Extracted from
// routes/files.js (ST-1) so every file sub-router logs through one place.
const db = require('./db');
const auditLog = require('./auditLog');

async function logEvent(event, userId, userEmail) {
  await db.query(
    'INSERT INTO activity_log (event, user_id, user_email) VALUES ($1, $2, $3)',
    [event, userId, userEmail]
  );
}

async function logDocumentEvent(documentId, eventType, userId, userEmail, detail = null) {
  // Appended to the tamper-evident hash chain (see lib/auditLog).
  await auditLog.append({ documentId, eventType, actorId: userId, actorEmail: userEmail, detail });
}

function requestAuditDetail(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const userAgent = String(req.get('user-agent') || 'unknown').replace(/\s+/g, ' ').slice(0, 160);
  return `ip ${ip} · user-agent ${userAgent}`;
}

module.exports = { logEvent, logDocumentEvent, requestAuditDetail };
