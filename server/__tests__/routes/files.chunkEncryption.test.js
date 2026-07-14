'use strict';
// U8: staged resumable-upload chunks are encrypted at rest when a storage encryption
// key is configured, and decrypt back to the original bytes on assembly. With no key,
// the original streaming (plaintext) path is preserved unchanged.
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const { Readable } = require('stream');

jest.mock('../../lib/db', () => ({ query: jest.fn().mockResolvedValue([]), queryOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn() }));
jest.mock('../../middleware/auth', () => (_req, _res, next) => next());
jest.mock('../../lib/storage', () => ({
  isLocalProvider: jest.fn().mockResolvedValue(true),
  localBase: jest.fn(),
  download: jest.fn(),
  del: jest.fn(),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));

const storage = require('../../lib/storage');
const settings = require('../../lib/settings');
const files = require('../../routes/files');

const collect = async (readable) => {
  const parts = [];
  for await (const c of readable) parts.push(c);
  return Buffer.concat(parts);
};

describe('resumable chunk staging (U8 at-rest encryption)', () => {
  let TMP;
  const plaintext = Buffer.from('the quick brown fox '.repeat(1000)); // ~20 KB

  beforeAll(async () => {
    TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'memex-chunk-'));
    storage.localBase.mockResolvedValue(TMP);
  });
  afterAll(async () => { await fs.rm(TMP, { recursive: true, force: true }).catch(() => {}); });

  test('encrypts staged chunks when a key is configured, round-tripping on assembly', async () => {
    settings.getOrEnv.mockResolvedValue('test-passphrase-123'); // storage_encryption_key
    const sid = 'enc-session';
    const n = await files.writeChunk(sid, 0, Readable.from(plaintext), 0);
    expect(n).toBe(plaintext.length); // returns the PLAINTEXT byte count (size checks depend on it)

    const onDisk = await fs.readFile(path.join(TMP, '.uploads', sid, '0.part'));
    expect(onDisk.slice(0, 4).toString()).toBe('MXEC'); // encrypted (magic present)
    expect(onDisk.equals(plaintext)).toBe(false);        // no plaintext on disk

    const assembled = await collect(await files.chunkedFileStream({ id: sid, total_chunks: 1 }));
    expect(assembled.equals(plaintext)).toBe(true);      // decrypts back to the original
  });

  test('stages plaintext (streaming) when no key is configured', async () => {
    settings.getOrEnv.mockResolvedValue(null);
    const sid = 'plain-session';
    const n = await files.writeChunk(sid, 0, Readable.from(plaintext), 0);
    expect(n).toBe(plaintext.length);

    const onDisk = await fs.readFile(path.join(TMP, '.uploads', sid, '0.part'));
    expect(onDisk.equals(plaintext)).toBe(true); // unchanged path: plaintext on disk

    const assembled = await collect(await files.chunkedFileStream({ id: sid, total_chunks: 1 }));
    expect(assembled.equals(plaintext)).toBe(true);
  });

  test('enforces the per-chunk size cap on the encryption path', async () => {
    settings.getOrEnv.mockResolvedValue('test-passphrase-123');
    await expect(files.writeChunk('cap-session', 0, Readable.from(plaintext), 100))
      .rejects.toMatchObject({ code: 'CHUNK_TOO_LARGE' });
  });
});
