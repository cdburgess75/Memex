'use strict';
// Verifies storage.downloadStream against real files + real crypto: streamed output
// must byte-match the original (encrypted and not), legacy plaintext streams as-is,
// it agrees with the buffered download(), and a tampered ciphertext fails the GCM
// auth check instead of yielding corrupted bytes.
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
const settings = require('../../lib/settings');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('../../lib/storage');

let TMP;
const KEY = 'a'.repeat(64); // 64 hex chars => 32 raw key bytes

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

beforeEach(() => {
  settings.getOrEnv.mockReset();
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-storage-'));
});
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('downloadStream (local)', () => {
  test('round-trips an unencrypted file and reports its length', async () => {
    cfg(null);
    const data = Buffer.from('hello world '.repeat(1000));
    await storage.upload('documents/plain.txt', data, 'text/plain');
    const { stream, length } = await storage.downloadStream('documents/plain.txt');
    expect(length).toBe(data.length);
    expect((await collect(stream)).equals(data)).toBe(true);
  });

  test('round-trips an encrypted file via streaming decrypt, reporting plaintext length', async () => {
    cfg(KEY);
    const data = Buffer.from('secret payload '.repeat(6000)); // ~90 KB => multi-chunk stream
    await storage.upload('documents/enc.bin', data, 'application/octet-stream');
    const onDisk = fs.readFileSync(path.join(TMP, 'documents/enc.bin'));
    expect(onDisk.subarray(0, 4).toString()).toBe('MXEC'); // actually encrypted at rest
    const { stream, length } = await storage.downloadStream('documents/enc.bin');
    expect(length).toBe(data.length);
    expect((await collect(stream)).equals(data)).toBe(true);
  });

  test('streams a legacy plaintext file (no magic) as-is even when a key is configured', async () => {
    cfg(KEY);
    fs.mkdirSync(path.join(TMP, 'documents'), { recursive: true });
    const legacy = Buffer.from('i predate encryption');
    fs.writeFileSync(path.join(TMP, 'documents/legacy.txt'), legacy);
    const { stream, length } = await storage.downloadStream('documents/legacy.txt');
    expect(length).toBe(legacy.length);
    expect((await collect(stream)).equals(legacy)).toBe(true);
  });

  test('streamed output matches the buffered download()', async () => {
    cfg(KEY);
    const data = Buffer.from('parity check '.repeat(300));
    await storage.upload('documents/parity.bin', data, 'application/octet-stream');
    const streamed = await collect((await storage.downloadStream('documents/parity.bin')).stream);
    const buffered = await storage.download('documents/parity.bin');
    expect(streamed.equals(buffered)).toBe(true);
    expect(streamed.equals(data)).toBe(true);
  });

  test('a tampered ciphertext fails the GCM auth check (no silent corruption)', async () => {
    cfg(KEY);
    const data = Buffer.from('integrity matters '.repeat(100));
    await storage.upload('documents/tamper.bin', data, 'application/octet-stream');
    const p = path.join(TMP, 'documents/tamper.bin');
    const raw = fs.readFileSync(p); raw[40] ^= 0xff; fs.writeFileSync(p, raw); // flip a ciphertext byte (offset >= 32)
    const { stream } = await storage.downloadStream('documents/tamper.bin');
    await expect(collect(stream)).rejects.toThrow();
  });
});

describe('uploadStream maxBytes cap', () => {
  const { Readable } = require('stream');

  test('an under-cap stream uploads and round-trips', async () => {
    cfg(null);
    const data = Buffer.alloc(2000, 9);
    const r = await storage.uploadStream('documents/under.bin', Readable.from([data]), 'application/octet-stream', { maxBytes: 1024 * 1024 });
    expect(r.size).toBe(data.length);
    expect((await storage.download('documents/under.bin')).equals(data)).toBe(true);
  });

  test('an over-cap stream rejects with UPLOAD_TOO_LARGE and leaves no file behind', async () => {
    cfg(null);
    const src = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]); // 1200 > 1000
    await expect(
      storage.uploadStream('documents/over.bin', src, 'application/octet-stream', { maxBytes: 1000 })
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
    expect(fs.existsSync(path.join(TMP, 'documents/over.bin'))).toBe(false);
  });

  test('over-cap also holds for encrypted storage (cap applies before the cipher)', async () => {
    cfg(KEY);
    const src = Readable.from([Buffer.alloc(800), Buffer.alloc(800)]); // 1600 > 1000
    await expect(
      storage.uploadStream('documents/overenc.bin', src, 'application/octet-stream', { maxBytes: 1000 })
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
    expect(fs.existsSync(path.join(TMP, 'documents/overenc.bin'))).toBe(false);
  });
});
