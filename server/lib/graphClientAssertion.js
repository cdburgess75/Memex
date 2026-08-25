'use strict';
// Signed JWT client assertion for Microsoft Entra certificate-based
// client-credentials auth. One implementation, shared by the Graph mail sender
// (lib/email.js) and the SharePoint connector (lib/connectors/sharepoint.js),
// so the x5t header and claim shape can never drift between them.
const crypto = require('crypto');

// x5t = base64url of the raw SHA-1 certificate thumbprint bytes. Entra matches it
// against the certificates uploaded to the app registration.
function certAssertion({ tenant, clientId, thumbprint, privateKey }) {
  const jwt = require('jsonwebtoken');
  const hex = String(thumbprint || '').replace(/[^a-fA-F0-9]/g, '');
  const x5t = Buffer.from(hex, 'hex').toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    iss: clientId,
    sub: clientId,
    jti: crypto.randomUUID(),
    nbf: now,
    iat: now,
    exp: now + 600, // 10 minutes
  };
  return jwt.sign(payload, privateKey, { algorithm: 'RS256', header: { alg: 'RS256', typ: 'JWT', x5t } });
}

module.exports = { certAssertion };
