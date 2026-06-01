'use strict';
const crypto = require('crypto');
const { deriveKey, resolveKey, encrypt, decrypt, MAGIC } = require('../../lib/encryption');

const OVERHEAD = MAGIC.length + 12 + 16; // MAGIC + IV + AUTH_TAG

describe('resolveKey', () => {
  test('returns null for null', ()     => expect(resolveKey(null)).toBeNull());
  test('returns null for empty string', () => expect(resolveKey('')).toBeNull());
  test('returns null for undefined',   () => expect(resolveKey(undefined)).toBeNull());

  test('uses 64-char hex string directly as 32-byte key', () => {
    const raw = crypto.randomBytes(32);
    expect(resolveKey(raw.toString('hex'))).toEqual(raw);
  });

  test('derives 32-byte key from arbitrary passphrase', () => {
    const k = resolveKey('my-passphrase');
    expect(k).toBeInstanceOf(Buffer);
    expect(k.length).toBe(32);
  });

  test('passphrase derivation is deterministic', () => {
    expect(resolveKey('same')).toEqual(resolveKey('same'));
  });

  test('different passphrases yield different keys', () => {
    expect(resolveKey('one')).not.toEqual(resolveKey('two'));
  });
});

describe('encrypt / decrypt', () => {
  let key;
  beforeEach(() => { key = crypto.randomBytes(32); });

  test('round-trips arbitrary plaintext', () => {
    const plain = Buffer.from('hello world — test payload');
    expect(decrypt(encrypt(plain, key), key)).toEqual(plain);
  });

  test('round-trips empty buffer', () => {
    const empty = Buffer.alloc(0);
    expect(decrypt(encrypt(empty, key), key)).toEqual(empty);
  });

  test('round-trips 1 MB buffer', () => {
    const large = crypto.randomBytes(1024 * 1024);
    expect(decrypt(encrypt(large, key), key)).toEqual(large);
  });

  test('encrypted output starts with MAGIC bytes', () => {
    expect(encrypt(Buffer.from('x'), key).slice(0, 4)).toEqual(MAGIC);
  });

  test('encrypted output length = plaintext + overhead', () => {
    const plain = Buffer.from('test data');
    expect(encrypt(plain, key).length).toBe(plain.length + OVERHEAD);
  });

  test('each call produces a different ciphertext (random IV)', () => {
    const plain = Buffer.from('same input');
    expect(encrypt(plain, key)).not.toEqual(encrypt(plain, key));
  });

  test('decrypt returns buffer unchanged when no MAGIC header (backward compat)', () => {
    const legacy = Buffer.from('unencrypted legacy content');
    expect(decrypt(legacy, key)).toEqual(legacy);
  });

  test('decrypt returns short buffer unchanged (too short for magic check)', () => {
    const short = Buffer.alloc(10);
    expect(decrypt(short, key)).toEqual(short);
  });

  test('decrypt throws on tampered ciphertext (GCM auth tag mismatch)', () => {
    const ct = encrypt(Buffer.from('sensitive data'), key);
    ct[ct.length - 1] ^= 0xff;
    expect(() => decrypt(ct, key)).toThrow();
  });

  test('decrypt throws with wrong key', () => {
    const ct = encrypt(Buffer.from('data'), key);
    const wrongKey = crypto.randomBytes(32);
    expect(() => decrypt(ct, wrongKey)).toThrow();
  });
});
