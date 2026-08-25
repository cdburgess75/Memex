'use strict';
// The client assertion is what Entra validates for certificate credentials; a
// malformed x5t or claim set fails auth with opaque errors, so pin the shape.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { certAssertion } = require('../../lib/graphClientAssertion');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const THUMB = 'F65EA5009BB3E11FD6B1D771DB60F35AB4C8A4F5';

describe('certAssertion', () => {
  test('signs RS256 with the Entra claim shape and x5t header', () => {
    const a = certAssertion({ tenant: 'tid', clientId: 'cid', thumbprint: THUMB, privateKey: PRIV });
    const decoded = jwt.verify(a, PUB, { algorithms: ['RS256'] });
    expect(decoded.aud).toBe('https://login.microsoftonline.com/tid/oauth2/v2.0/token');
    expect(decoded.iss).toBe('cid');
    expect(decoded.sub).toBe('cid');
    expect(decoded.jti).toMatch(/[0-9a-f-]{36}/);
    expect(decoded.exp - decoded.iat).toBe(600);
    const header = JSON.parse(Buffer.from(a.split('.')[0], 'base64url').toString());
    expect(header.x5t).toBe(Buffer.from(THUMB, 'hex').toString('base64url'));
  });

  test('normalizes a colon-separated thumbprint to the same x5t', () => {
    const colons = THUMB.match(/.{2}/g).join(':');
    const a = certAssertion({ tenant: 't', clientId: 'c', thumbprint: colons, privateKey: PRIV });
    const header = JSON.parse(Buffer.from(a.split('.')[0], 'base64url').toString());
    expect(header.x5t).toBe(Buffer.from(THUMB, 'hex').toString('base64url'));
  });
});
