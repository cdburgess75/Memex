'use strict';
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(), get: jest.fn(), set: jest.fn() }));
jest.mock('../../lib/backupDestinations', () => ({ ARCHIVE_RE: /.*/, adapter: jest.fn() }));

const { wrapKeyWithPassphrase, unwrapKeyWithPassphrase } = require('../../lib/backup');

describe('backup key escrow (passphrase wrap/unwrap)', () => {
  test('wrap then unwrap recovers the original key', () => {
    const key = 'a1b2c3'.repeat(10);
    const wrapped = wrapKeyWithPassphrase(key, 'correct horse battery staple');
    expect(unwrapKeyWithPassphrase(wrapped, 'correct horse battery staple')).toBe(key);
  });

  test('the wrapped blob does not contain the plaintext key and is authenticated', () => {
    const key = 'deadbeef'.repeat(8);
    const wrapped = wrapKeyWithPassphrase(key, 'pass');
    expect(wrapped).not.toContain(key);
    const o = JSON.parse(wrapped);
    expect(o.cipher).toBe('aes-256-gcm');
    expect(o.salt && o.iv && o.tag && o.data).toBeTruthy();
  });

  test('a wrong passphrase fails to unwrap (auth-tag mismatch)', () => {
    const wrapped = wrapKeyWithPassphrase('mykey', 'right-passphrase');
    expect(() => unwrapKeyWithPassphrase(wrapped, 'wrong-passphrase')).toThrow();
  });

  test('a tampered blob fails to unwrap', () => {
    const o = JSON.parse(wrapKeyWithPassphrase('mykey', 'pw'));
    o.data = Buffer.from('tampered').toString('base64');
    expect(() => unwrapKeyWithPassphrase(JSON.stringify(o), 'pw')).toThrow();
  });
});
