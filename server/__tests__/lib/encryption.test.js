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

describe('segmented format', () => {
  const {
    encryptSegmented, decryptSegmented, encryptSegments, decryptSegments,
    parseSegmentedHeader, segmentedLayout, segmentedReadPlan, SEG_MAGIC, SEG_HEADER_LEN, SEG_TAG_LEN,
  } = require('../../lib/encryption');
  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');
  const S = 64; // tiny segments, so a few hundred bytes span many of them

  let key;
  beforeEach(() => { key = crypto.randomBytes(32); });

  async function collect(iterable) {
    const out = [];
    for await (const c of iterable) out.push(c);
    return Buffer.concat(out);
  }
  // Split a buffer into pieces of the given sizes (cycled), to feed streams chunks that
  // don't line up with segments.
  function pieces(buf, sizes) {
    const out = [];
    for (let off = 0, i = 0; off < buf.length; i += 1) {
      const n = sizes[i % sizes.length];
      out.push(buf.subarray(off, off + n));
      off += n;
    }
    return out;
  }
  async function streamEncrypt(plain, sizes = [plain.length || 1]) {
    return collect(encryptSegments(key, { segmentSize: S })(Readable.from(pieces(plain, sizes))));
  }
  async function streamDecrypt(file, range, sizes = [file.length]) {
    const hdr = parseSegmentedHeader(file);
    const plan = segmentedReadPlan(hdr, file.length, range);
    const body = file.subarray(plan.readStart, plan.readEnd + 1);
    return collect(decryptSegments(key, hdr, plan)(Readable.from(pieces(body, sizes))));
  }

  test.each([0, 1, S - 1, S, S + 1, 5 * S, 7 * S + 13])('a %i-byte file round-trips, buffered and streamed', async (n) => {
    const plain = crypto.randomBytes(n);
    const file = encryptSegmented(plain, key, { segmentSize: S });
    expect(file.subarray(0, 4)).toEqual(SEG_MAGIC);
    const segments = Math.max(1, Math.ceil(n / S));
    expect(file.length).toBe(SEG_HEADER_LEN + n + segments * SEG_TAG_LEN);
    expect(segmentedLayout(parseSegmentedHeader(file), file.length)).toEqual({ plainSize: n, segments });
    expect(decryptSegmented(file, key)).toEqual(plain);
    expect(decrypt(file, key)).toEqual(plain); // decrypt() reads either format
    expect(await streamDecrypt(file, null)).toEqual(plain);

    const streamed = await streamEncrypt(plain, [7, 100, 1, 64]); // chunks that straddle segments
    expect(streamed.length).toBe(file.length);
    expect(decryptSegmented(streamed, key)).toEqual(plain);
    expect(await streamDecrypt(streamed, null, [5, 81, 3])).toEqual(plain);
  });

  test('a byte range decrypts only the segments it covers', async () => {
    const plain = crypto.randomBytes(7 * S + 13);
    const file = encryptSegmented(plain, key, { segmentSize: S });
    const hdr = parseSegmentedHeader(file);
    for (const [start, end] of [[0, 0], [10, 20], [S - 3, S + 2], [S, 2 * S - 1], [3 * S + 5, plain.length - 1], [plain.length - 1, plain.length - 1]]) {
      const plan = segmentedReadPlan(hdr, file.length, { start, end });
      expect(plan.first).toBe(Math.floor(start / S));
      expect(plan.count).toBe(Math.floor(end / S) - Math.floor(start / S) + 1);
      expect(await streamDecrypt(file, { start, end }, [9, 30])).toEqual(plain.subarray(start, end + 1));
    }
  });

  test('every file gets a fresh header (salt + nonce prefix), so equal inputs encrypt differently', () => {
    const plain = Buffer.from('same input');
    const a = encryptSegmented(plain, key, { segmentSize: S });
    const b = encryptSegmented(plain, key, { segmentSize: S });
    expect(a.subarray(9, SEG_HEADER_LEN)).not.toEqual(b.subarray(9, SEG_HEADER_LEN));
    expect(a.subarray(SEG_HEADER_LEN)).not.toEqual(b.subarray(SEG_HEADER_LEN));
  });

  describe('refuses a damaged file instead of returning wrong bytes', () => {
    const plain = crypto.randomBytes(4 * S + 10); // 5 segments, the last one short
    const sealed = S + SEG_TAG_LEN;
    let file;
    beforeEach(() => { file = encryptSegmented(plain, key, { segmentSize: S }); });
    const seg = (f, i) => f.subarray(SEG_HEADER_LEN + i * sealed, SEG_HEADER_LEN + (i + 1) * sealed);

    const damaged = {
      'a flipped ciphertext byte': (f) => { f[SEG_HEADER_LEN + 2 * sealed + 5] ^= 1; return f; },
      'a flipped tag byte': (f) => { f[SEG_HEADER_LEN + sealed - 1] ^= 1; return f; },
      'an edited header (salt)': (f) => { f[20] ^= 1; return f; },
      'an edited header (segment size)': (f) => { f.writeUInt32BE(S + 1, 5); return f; },
      'two segments swapped': (f) => Buffer.concat([f.subarray(0, SEG_HEADER_LEN), seg(f, 1), seg(f, 0), f.subarray(SEG_HEADER_LEN + 2 * sealed)]),
      'a middle segment dropped': (f) => Buffer.concat([f.subarray(0, SEG_HEADER_LEN + sealed), f.subarray(SEG_HEADER_LEN + 2 * sealed)]),
      'the last segment dropped (cut at a boundary)': (f) => f.subarray(0, SEG_HEADER_LEN + 4 * sealed),
      'the last few bytes cut off': (f) => f.subarray(0, f.length - 3),
      'cut to the header alone': (f) => f.subarray(0, SEG_HEADER_LEN),
      'a wrong key': (f) => { key = crypto.randomBytes(32); return f; },
    };
    test.each(Object.keys(damaged))('%s', async (what) => {
      const bad = damaged[what](Buffer.from(file));
      expect(() => decryptSegmented(bad, key)).toThrow();
      await expect((async () => streamDecrypt(bad, null))()).rejects.toThrow();
    });

    test('a damaged segment outside the requested range does not block that range', async () => {
      file[SEG_HEADER_LEN + 3 * sealed + 5] ^= 1; // segment 3
      expect(await streamDecrypt(file, { start: 0, end: 2 * S - 1 })).toEqual(plain.subarray(0, 2 * S));
      await expect(streamDecrypt(file, { start: 3 * S, end: 3 * S })).rejects.toThrow();
    });
  });

  test('a cipher failure mid-stream rejects the pipeline (it does not escape as an uncaught exception)', async () => {
    const real = crypto.createCipheriv;
    let calls = 0;
    const spy = jest.spyOn(crypto, 'createCipheriv').mockImplementation((...args) => {
      const c = real(...args);
      if (++calls === 3) c.update = () => { throw new Error('Trying to add data in unsupported state'); };
      return c;
    });
    try {
      const sink = [];
      await expect(pipeline(
        Readable.from(pieces(crypto.randomBytes(10 * S), [S / 2])),
        encryptSegments(key, { segmentSize: S }),
        async function* (src) { for await (const c of src) sink.push(c); },
      )).rejects.toThrow('unsupported state');
    } finally { spy.mockRestore(); }
  });

  test('parseSegmentedHeader: not this format → null; unknown version or absurd segment size → error', () => {
    expect(parseSegmentedHeader(encrypt(Buffer.from('x'), key))).toBeNull();
    expect(parseSegmentedHeader(Buffer.from('plain text that is long enough to hold a header, honest'))).toBeNull();
    const file = encryptSegmented(Buffer.from('x'), key, { segmentSize: S });
    const v2 = Buffer.from(file); v2[4] = 2;
    expect(() => parseSegmentedHeader(v2)).toThrow(/version/);
    const huge = Buffer.from(file); huge.writeUInt32BE(0xffffffff, 5);
    expect(() => parseSegmentedHeader(huge)).toThrow(/segment size/);
  });
});
