'use strict';
// Local storage with at-rest encryption, against real files and real crypto: files are
// written in the segmented format (a small segment size here, so a few hundred bytes
// span many segments), round-trip through every upload and download path, serve byte
// ranges by decrypting only the segments they cover, and files written in the older
// single-message format still read. A cipher failure during an upload rejects the
// upload and removes its temp file -- it used to escape the stream pipeline as an
// uncaught exception, which takes the whole server process down.
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
const settings = require('../../lib/settings');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const enc = require('../../lib/encryption');
const storage = require('../../lib/storage');

const S = 64;
let TMP, KEY;

function cfg(key) {
  settings.getOrEnv.mockImplementation(async (k) => {
    if (k === 'storage_provider') return 'local';
    if (k === 'storage_local_path') return TMP;
    if (k === 'storage_encryption_key') return key || null;
    return null;
  });
}
async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}
// A source that hands over its bytes in uneven pieces, as a network upload does.
function source(buf, sizes = [7, 100, 1, 33]) {
  const out = [];
  for (let off = 0, i = 0; off < buf.length; i += 1) { out.push(buf.subarray(off, off + sizes[i % sizes.length])); off += sizes[i % sizes.length]; }
  return Readable.from(out);
}
const onDisk = (p) => fs.readFileSync(path.join(TMP, p));
const leftovers = () => fs.readdirSync(path.join(TMP, 'documents')).filter(f => f.endsWith('.upload') || f.endsWith('.ciphertext'));

beforeEach(() => {
  settings.getOrEnv.mockReset();
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-storage-seg-'));
  KEY = crypto.randomBytes(32).toString('hex'); // generated per test; nothing secret in the repo
  cfg(KEY);
  storage._setSegmentSizeForTests(S);
});
afterEach(() => {
  storage._setSegmentSizeForTests(null);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('segmented files round-trip', () => {
  test.each([0, 1, S, 5 * S, 7 * S + 13])('a %i-byte file through uploadStream, download and downloadStream', async (n) => {
    const data = crypto.randomBytes(n);
    const r = await storage.uploadStream('documents/a.bin', source(data), 'application/octet-stream');
    expect(r.size).toBe(n);
    expect(leftovers()).toEqual([]);

    const raw = onDisk('documents/a.bin');
    expect(raw.subarray(0, 4)).toEqual(enc.SEG_MAGIC); // encrypted at rest, new format
    expect(raw.length).toBe(enc.SEG_HEADER_LEN + n + Math.max(1, Math.ceil(n / S)) * enc.SEG_TAG_LEN);

    expect((await storage.download('documents/a.bin')).equals(data)).toBe(true);
    const { stream, length, totalSize, range } = await storage.downloadStream('documents/a.bin');
    expect([length, totalSize, range]).toEqual([n, n, null]);
    expect((await collect(stream)).equals(data)).toBe(true);
  });

  test('the buffered upload() writes the same format and round-trips', async () => {
    const data = crypto.randomBytes(3 * S + 1);
    await storage.upload('documents/b.bin', data, 'application/octet-stream');
    expect(onDisk('documents/b.bin').subarray(0, 4)).toEqual(enc.SEG_MAGIC);
    expect((await storage.download('documents/b.bin')).equals(data)).toBe(true);
    expect((await collect((await storage.downloadStream('documents/b.bin')).stream)).equals(data)).toBe(true);
  });

  test('a copied file still decrypts (its key comes from the master key and its own header)', async () => {
    const data = crypto.randomBytes(2 * S + 9);
    await storage.upload('documents/orig.bin', data, 'application/octet-stream');
    await storage.copy('documents/orig.bin', 'documents/copy.bin');
    expect((await storage.download('documents/copy.bin')).equals(data)).toBe(true);
  });
});

describe('ranged downloads of a segmented file', () => {
  const data = crypto.randomBytes(7 * S + 13); // 461 bytes, 8 segments
  const N = data.length;

  test.each([
    ['bytes=0-0', 0, 0],
    ['bytes=10-20', 10, 20],                    // inside one segment
    [`bytes=${S - 3}-${S + 2}`, S - 3, S + 2],  // across a segment boundary
    [`bytes=${S}-${2 * S - 1}`, S, 2 * S - 1],  // exactly one segment
    ['bytes=100-', 100, N - 1],                 // open-ended
    ['bytes=-5', N - 5, N - 1],                 // suffix inside the short last segment
    ['bytes=-200', N - 200, N - 1],             // suffix across several
    [`bytes=300-${N + 1000}`, 300, N - 1],      // end past the file is clamped
    ['bytes=0-', 0, N - 1],
  ])('%s', async (header, start, end) => {
    await storage.uploadStream('documents/r.bin', source(data), 'application/octet-stream');
    const dl = await storage.downloadStream('documents/r.bin', { rangeHeader: header });
    expect(dl.range).toEqual({ start, end });
    expect(dl.length).toBe(end - start + 1);
    expect(dl.totalSize).toBe(N);
    expect((await collect(dl.stream)).equals(data.subarray(start, end + 1))).toBe(true);
  });

  test('reports an unsatisfiable range against the plaintext size', async () => {
    await storage.uploadStream('documents/r.bin', source(data), 'application/octet-stream');
    const r = await storage.downloadStream('documents/r.bin', { rangeHeader: `bytes=${N}-${N + 10}` });
    expect(r).toEqual({ unsatisfiable: true, totalSize: N });
  });

  test('reads only the segments the range covers: damage elsewhere does not touch it', async () => {
    await storage.uploadStream('documents/r.bin', source(data), 'application/octet-stream');
    const p = path.join(TMP, 'documents/r.bin');
    const raw = fs.readFileSync(p);
    raw[enc.SEG_HEADER_LEN + 6 * (S + enc.SEG_TAG_LEN) + 3] ^= 0xff; // segment 6
    fs.writeFileSync(p, raw);

    const early = await storage.downloadStream('documents/r.bin', { rangeHeader: `bytes=0-${2 * S}` });
    expect((await collect(early.stream)).equals(data.subarray(0, 2 * S + 1))).toBe(true);
    const late = await storage.downloadStream('documents/r.bin', { rangeHeader: `bytes=${6 * S}-${6 * S}` });
    await expect(collect(late.stream)).rejects.toThrow();
    await expect(collect((await storage.downloadStream('documents/r.bin')).stream)).rejects.toThrow();
    await expect(storage.download('documents/r.bin')).rejects.toThrow();
  });

  test('a file cut short fails rather than serving a truncated download', async () => {
    await storage.uploadStream('documents/r.bin', source(data), 'application/octet-stream');
    const p = path.join(TMP, 'documents/r.bin');
    fs.truncateSync(p, enc.SEG_HEADER_LEN + 5 * (S + enc.SEG_TAG_LEN)); // drop the last three segments whole
    await expect(collect((await storage.downloadStream('documents/r.bin')).stream)).rejects.toThrow();
    await expect(storage.download('documents/r.bin')).rejects.toThrow();
  });
});

describe('files written in the older single-message format', () => {
  // Byte for byte what the previous localUpload / localUploadStream wrote:
  // MAGIC(4) + IV(12) + AUTH_TAG(16) + CIPHERTEXT, one GCM message for the whole file.
  function writeOld(p, data) {
    fs.mkdirSync(path.join(TMP, 'documents'), { recursive: true });
    const file = enc.encrypt(data, enc.resolveKey(KEY));
    expect(file.subarray(0, 4)).toEqual(enc.MAGIC);
    fs.writeFileSync(path.join(TMP, p), file);
  }

  test('still decrypt through download() and downloadStream()', async () => {
    const data = crypto.randomBytes(5 * S + 3);
    writeOld('documents/old.bin', data);
    expect((await storage.download('documents/old.bin')).equals(data)).toBe(true);
    const { stream, length, totalSize } = await storage.downloadStream('documents/old.bin');
    expect([length, totalSize]).toEqual([data.length, data.length]);
    expect((await collect(stream)).equals(data)).toBe(true);
  });

  test('ignore Range and stream in full (one GCM message is not seekable)', async () => {
    const data = crypto.randomBytes(300);
    writeOld('documents/old.bin', data);
    const { stream, range, totalSize } = await storage.downloadStream('documents/old.bin', { rangeHeader: 'bytes=10-20' });
    expect(range).toBeNull();
    expect(totalSize).toBe(data.length);
    expect((await collect(stream)).equals(data)).toBe(true);
  });

  test('a tampered one still fails its GCM check', async () => {
    const data = crypto.randomBytes(300);
    writeOld('documents/old.bin', data);
    const p = path.join(TMP, 'documents/old.bin');
    const raw = fs.readFileSync(p); raw[40] ^= 0xff; fs.writeFileSync(p, raw);
    await expect(collect((await storage.downloadStream('documents/old.bin')).stream)).rejects.toThrow();
  });

  test('copied over by a fresh upload becomes segmented', async () => {
    writeOld('documents/old.bin', crypto.randomBytes(100));
    const data = crypto.randomBytes(200);
    await storage.uploadStream('documents/old.bin', source(data), 'application/octet-stream');
    expect(onDisk('documents/old.bin').subarray(0, 4)).toEqual(enc.SEG_MAGIC);
    expect((await storage.download('documents/old.bin')).equals(data)).toBe(true);
  });
});

describe('an upload that fails part way', () => {
  // The cipher throws the way OpenSSL does when one GCM message passes 64 GiB.
  function failCipherAt(n) {
    const real = crypto.createCipheriv;
    let calls = 0;
    const boom = () => { if (++calls === n) throw new Error('Trying to add data in unsupported state'); };
    return jest.spyOn(crypto, 'createCipheriv').mockImplementation((...args) => {
      const c = real(...args);
      const update = c.update.bind(c), transform = c._transform.bind(c);
      c.update = (...a) => { boom(); return update(...a); };          // segment-at-a-time use
      c._transform = (...a) => { boom(); return transform(...a); };  // whole-file stream use
      return c;
    });
  }

  test.each([1, 3])('a cipher error on segment %i rejects the upload and leaves no temp file', async (n) => {
    fs.mkdirSync(path.join(TMP, 'documents'), { recursive: true });
    const spy = failCipherAt(n);
    try {
      await expect(
        storage.uploadStream('documents/fail.bin', source(crypto.randomBytes(10 * S)), 'application/octet-stream')
      ).rejects.toThrow('unsupported state');
    } finally { spy.mockRestore(); }
    expect(fs.existsSync(path.join(TMP, 'documents/fail.bin'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test('a source that errors mid-stream rejects and leaves no temp file', async () => {
    fs.mkdirSync(path.join(TMP, 'documents'), { recursive: true });
    const src = Readable.from((async function* () {
      yield crypto.randomBytes(3 * S);
      throw new Error('client went away');
    })());
    await expect(storage.uploadStream('documents/gone.bin', src, 'application/octet-stream')).rejects.toThrow('client went away');
    expect(fs.existsSync(path.join(TMP, 'documents/gone.bin'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test('a failed upload leaves the file it was replacing untouched', async () => {
    const before = crypto.randomBytes(150);
    await storage.upload('documents/keep.bin', before, 'application/octet-stream');
    const spy = failCipherAt(2);
    try {
      await expect(storage.uploadStream('documents/keep.bin', source(crypto.randomBytes(10 * S)), 'application/octet-stream')).rejects.toThrow();
    } finally { spy.mockRestore(); }
    expect((await storage.download('documents/keep.bin')).equals(before)).toBe(true);
    expect(leftovers()).toEqual([]);
  });
});
