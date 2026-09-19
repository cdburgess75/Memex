'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-ext-test-'));
// A recipient's big file arrives in pieces. The staging has to be exact about order and size
// (or a file is silently corrupted), deaf to anything the visitor names (or it writes where it
// likes), bounded (or it is a way to fill the disk), and encrypted when storage is.
const { Readable } = require('stream');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const mockCfg = { values: {} };
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async (k) => mockCfg.values[k] ?? null) }));
jest.mock('../../lib/storage', () => ({ isLocalProvider: jest.fn(async () => false), localBase: jest.fn() }));
const chunks = require('../../lib/externalChunks');

const piece = (buf, h) => Object.assign(Readable.from([buf]), { headers: Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)])) });
const head = (id, offset, total, extra = {}) => ({ 'X-Upload-Id': id, 'X-Upload-Offset': offset, 'X-Upload-Total': total, 'X-Upload-Name': encodeURIComponent('big file.bin'), 'X-Upload-Path': 'Invoices', 'X-Upload-Rel': 'a/big file.bin', ...extra });
const read = async (s) => { const b = []; for await (const c of s) b.push(c); return Buffer.concat(b); };
const newId = () => crypto.randomBytes(12).toString('hex');
const opts = (over = {}) => ({ linkKey: 'folder:' + crypto.randomUUID(), maxFileBytes: 1e9, ...over });

beforeEach(async () => { mockCfg.values = {}; await fs.rm(await chunks._baseDir(), { recursive: true, force: true }); });
afterAll(async () => fs.rm(await chunks._baseDir(), { recursive: true, force: true }));

test('pieces in order become the file, byte for byte, and the staging is removed', async () => {
  const data = crypto.randomBytes(300000), id = newId(), o = opts();
  const a = await chunks.accept(piece(data.subarray(0, 100000), head(id, 0, data.length)), o);
  expect(a).toEqual({ done: false, received: 100000 });
  await chunks.accept(piece(data.subarray(100000, 250000), head(id, 100000, data.length)), o);
  const last = await chunks.accept(piece(data.subarray(250000), head(id, 250000, data.length)), o);
  expect(last).toMatchObject({ done: true, size: data.length, name: 'big file.bin', at: 'Invoices', rel: 'a/big file.bin' });
  expect((await read(last.stream())).equals(data)).toBe(true);
  await last.cleanup();
  expect((await fs.readdir(await chunks._baseDir())).length).toBe(0);
});
test('an empty file is one empty piece', async () => {
  const got = await chunks.accept(piece(Buffer.alloc(0), head(newId(), 0, 0)), opts());
  expect(got.done).toBe(true); expect((await read(got.stream())).length).toBe(0); await got.cleanup();
});
test('a piece out of step is told where the server is, and nothing is written', async () => {
  const id = newId(), o = opts();
  await chunks.accept(piece(Buffer.alloc(1000), head(id, 0, 5000)), o);
  await expect(chunks.accept(piece(Buffer.alloc(1000), head(id, 3000, 5000)), o)).rejects.toMatchObject({ status: 409, extra: { received: 1000 } });
  await expect(chunks.accept(piece(Buffer.alloc(1000), head(id, 0, 5000)), o)).rejects.toMatchObject({ status: 409, extra: { received: 1000 } }); // a repeat, its answer lost
  expect(await chunks.accept(piece(Buffer.alloc(1000), head(id, 1000, 5000)), o)).toEqual({ done: false, received: 2000 });
});
test('an upload the server has never seen cannot start in the middle', async () => {
  await expect(chunks.accept(piece(Buffer.alloc(10), head(newId(), 500, 5000)), opts())).rejects.toMatchObject({ status: 409, extra: { received: 0 } });
});
test('a piece cannot carry more than the file has left', async () => {
  const id = newId(), o = opts();
  await expect(chunks.accept(piece(Buffer.alloc(2000), head(id, 0, 1000)), o)).rejects.toMatchObject({ status: 413 });
  expect((await fs.readdir(await chunks._baseDir()).catch(() => [])).length).toBe(0); // and a failed first piece leaves nothing behind
});
test('the size limit is checked before anything is staged; so is whatever the route asks first', async () => {
  await expect(chunks.accept(piece(Buffer.alloc(10), head(newId(), 0, 5000)), opts({ maxFileBytes: 4999 }))).rejects.toMatchObject({ status: 413 });
  const first = jest.fn(async () => { throw new chunks.ChunkError(400, 'no .exe'); });
  await expect(chunks.accept(piece(Buffer.alloc(10), head(newId(), 0, 5000)), opts({ first }))).rejects.toMatchObject({ status: 400, message: 'no .exe' });
  expect((await fs.readdir(await chunks._baseDir()).catch(() => [])).length).toBe(0);
});
test.each([['../../etc/passwd'], ['a/b'], ['short'], ['x'.repeat(80)], ['']])('an upload id like %p is refused: it never becomes a path', async (id) => {
  await expect(chunks.accept(piece(Buffer.alloc(1), head(id, 0, 1)), opts())).rejects.toMatchObject({ status: 400 });
});
test.each([[-1, 10], [11, 10], ['x', 10], [0, -5], [0, 1.5]])('position %p of %p is refused', async (offset, total) => {
  await expect(chunks.accept(piece(Buffer.alloc(1), head(newId(), offset, total)), opts())).rejects.toMatchObject({ status: 400 });
});
test('staging lives under a name hashed from OUR link key and their id, inside the base folder', async () => {
  const o = opts(); await chunks.accept(piece(Buffer.alloc(10), head(newId(), 0, 50)), o);
  const names = await fs.readdir(await chunks._baseDir());
  expect(names).toHaveLength(1); expect(names[0]).toMatch(/^[0-9a-f]{16}-[0-9a-f]{32}$/);
  await fs.rm(path.join(await chunks._baseDir(), names[0]), { recursive: true });
});
test('one link can only have so many unfinished uploads; another link is unaffected', async () => {
  const o = opts();
  for (let i = 0; i < chunks.OPEN_PER_LINK; i++) await chunks.accept(piece(Buffer.alloc(10), head(newId(), 0, 50)), o);
  await expect(chunks.accept(piece(Buffer.alloc(10), head(newId(), 0, 50)), o)).rejects.toMatchObject({ status: 429 });
  expect(await chunks.accept(piece(Buffer.alloc(10), head(newId(), 0, 50)), opts())).toMatchObject({ done: false });
});
test('abandoned uploads are swept to make room', async () => {
  const o = opts(), base = await chunks._baseDir();
  for (let i = 0; i < chunks.OPEN_PER_LINK; i++) await chunks.accept(piece(Buffer.alloc(10), head(newId(), 0, 50)), o);
  const old = new Date(Date.now() - 7 * 3600e3);
  for (const n of await fs.readdir(base)) await fs.utimes(path.join(base, n), old, old);
  expect(await chunks.accept(piece(Buffer.alloc(10), head(newId(), 0, 50)), o)).toMatchObject({ done: false });
});
test('with storage encryption on, no piece is on disk in the clear, and the file still comes back whole', async () => {
  mockCfg.values.storage_encryption_key = crypto.randomBytes(32).toString('hex');
  const secret = Buffer.from('TOP-SECRET-PAYROLL '.repeat(2000)), id = newId(), o = opts();
  await chunks.accept(piece(secret.subarray(0, 20000), head(id, 0, secret.length)), o);
  const base = await chunks._baseDir(); const dir = (await fs.readdir(base)).find(async () => true);
  const staged = await fs.readFile(path.join(base, (await fs.readdir(base))[(await fs.readdir(base)).length - 1], '0.part')).catch(() => null);
  const all = Buffer.concat(await Promise.all((await fs.readdir(base)).map(async n => fs.readFile(path.join(base, n, '0.part')).catch(() => Buffer.alloc(0)))));
  expect(all.includes(Buffer.from('TOP-SECRET-PAYROLL'))).toBe(false); void dir; void staged;
  const last = await chunks.accept(piece(secret.subarray(20000), head(id, 20000, secret.length)), o);
  expect((await read(last.stream())).equals(secret)).toBe(true); await last.cleanup();
});
test('limits: big defaults, and an administrator can change them', async () => {
  expect(await chunks.limits()).toEqual({ maxFileMb: 10240, maxFileBytes: 10240 * 1048576, maxFiles: 5000, maxTotalBytes: 100 * 1024 ** 3 });
  mockCfg.values = { link_upload_max_mb: '51200', link_upload_max_files: '20000', link_upload_total_gb: '500' };
  expect(await chunks.limits()).toMatchObject({ maxFileMb: 51200, maxFiles: 20000, maxTotalBytes: 500 * 1024 ** 3 });
  mockCfg.values = { link_upload_max_mb: 'banana', link_upload_max_files: '-4' };
  expect(await chunks.limits()).toMatchObject({ maxFileMb: 10240, maxFiles: 5000 });
});
