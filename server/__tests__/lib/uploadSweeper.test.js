'use strict';
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/storage', () => ({ isLocalProvider: jest.fn(), localBase: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../../lib/db');
const storage = require('../../lib/storage');
const uploadSweeper = require('../../lib/uploadSweeper');

const HOUR = 3600 * 1000;
const HEX = '0123456789abcdef';
let base;
let outside;

// Writes a file and backdates its mtime by `ageHours`.
function put(rel, ageHours, root = base) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
  const t = new Date(Date.now() - ageHours * HOUR);
  fs.utimesSync(full, t, t);
  return full;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-sweep-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-sweep-out-'));
  storage.isLocalProvider.mockResolvedValue(true);
  storage.localBase.mockResolvedValue(base);
  db.query.mockResolvedValue([]);
  // Upload sessions count as active (step 2 keeps their dirs); no document owns a temp name.
  db.queryOne.mockImplementation(async (sql) => (/upload_sessions/.test(sql) ? { '?column?': 1 } : null));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('uploadSweeper.sweepOnce: orphaned upload temp files', () => {
  test('removes a stale temp file and keeps the finished file beside it', async () => {
    const tmp = put(`documents/123-report.pdf.${HEX}.upload`, 48);
    const done = put('documents/123-report.pdf', 48);

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(1);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(done)).toBe(true);
  });

  test("also removes the stale .ciphertext temp an older release's encrypted upload left beside it", async () => {
    const tmp = put(`documents/123-big.iso.${HEX}.upload`, 48);
    const ct = put(`documents/123-big.iso.${HEX}.upload.ciphertext`, 48);
    const done = put('documents/123-other.iso', 48);

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(2);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(ct)).toBe(false);
    expect(fs.existsSync(done)).toBe(true);
  });

  test('keeps a .ciphertext temp that is still being written', async () => {
    const ct = put(`documents/123-big.iso.${HEX}.upload.ciphertext`, 1);

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(0);
    expect(fs.existsSync(ct)).toBe(true);
  });

  test('keeps a temp file that is still being written', async () => {
    const tmp = put(`documents/123-big.iso.${HEX}.upload`, 1);

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(0);
    expect(fs.existsSync(tmp)).toBe(true);
  });

  test('keeps stale files whose names only look like temp files', async () => {
    const names = [
      'documents/123-x.upload',
      'documents/123-notes.abc.upload',
      `documents/123-a.${HEX.toUpperCase()}.upload`,
      `documents/123-a.${HEX}0.upload`,
      `documents/123-a.${HEX}.upload.bak`,
    ];
    const kept = names.map(n => put(n, 48));

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(0);
    for (const f of kept) expect(fs.existsSync(f)).toBe(true);
  });

  test('finds a stale temp file deep in nested folders', async () => {
    const deep = put(`versions/a/b/c/d/e/0007.${HEX}.upload`, 48);
    const sibling = put('versions/a/b/c/d/e/0007', 48);

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(1);
    expect(fs.existsSync(deep)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  test('keeps a matching file that a document row points at', async () => {
    const real = put(`documents/123-mine.${HEX}.upload`, 48);
    db.queryOne.mockImplementation(async (sql, params) =>
      (/FROM documents/.test(sql) && params[0] === `documents/123-mine.${HEX}.upload` ? { '?column?': 1 } : null));

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(0);
    expect(fs.existsSync(real)).toBe(true);
  });

  test('keeps the file when the ownership check fails', async () => {
    const tmp = put(`documents/123-r.pdf.${HEX}.upload`, 48);
    db.queryOne.mockImplementation(async (sql) => {
      if (/upload_sessions/.test(sql)) return { '?column?': 1 };
      throw new Error('db down');
    });

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(0);
    expect(fs.existsSync(tmp)).toBe(true);
  });

  test('leaves the .uploads staging dir to the session sweep', async () => {
    const staged = put(`.uploads/sess-1/0.${HEX}.upload`, 48);

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(0);
    expect(fs.existsSync(staged)).toBe(true);
  });

  test('does not follow symlinks, to dirs or to files', async () => {
    const away = put(`elsewhere/9.${HEX}.upload`, 48, outside);
    fs.mkdirSync(path.join(base, 'documents'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'elsewhere'), path.join(base, 'documents', 'linked-dir'));
    fs.symlinkSync(away, path.join(base, 'documents', `link.${HEX}.upload`));

    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });

    expect(r.tempFilesRemoved).toBe(0);
    expect(fs.existsSync(away)).toBe(true);
    expect(fs.lstatSync(path.join(base, 'documents', `link.${HEX}.upload`)).isSymbolicLink()).toBe(true);
  });

  test('a missing storage dir or a non-local provider sweeps nothing and does not throw', async () => {
    storage.localBase.mockResolvedValue(path.join(base, 'not-there'));
    await expect(uploadSweeper.sweepOnce({ staleHours: 24 })).resolves.toMatchObject({ tempFilesRemoved: 0 });

    const tmp = put(`documents/1.${HEX}.upload`, 48);
    storage.localBase.mockResolvedValue(base);
    storage.isLocalProvider.mockResolvedValue(false);
    const r = await uploadSweeper.sweepOnce({ staleHours: 24 });
    expect(r.tempFilesRemoved).toBe(0);
    expect(fs.existsSync(tmp)).toBe(true);
  });
});
