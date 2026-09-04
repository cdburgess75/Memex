'use strict';
// Pure-logic + cache-path coverage for the thumbnail generator. Actual rendering
// (sharp/poppler/ffmpeg/Collabora) is exercised in the deployed container, not
// here — these tests never invoke a renderer, so they need no native binaries.
jest.mock('../../lib/storage', () => ({ download: jest.fn(), upload: jest.fn() }));
const storage = require('../../lib/storage');
const thumbs = require('../../lib/thumbnails');

beforeEach(() => jest.clearAllMocks());

describe('canThumbnail', () => {
  test('true for image / pdf / office / video / text / email / archive', () => {
    for (const ext of ['jpg', 'png', 'webp', 'tiff', 'heic', 'heif', 'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'csv', 'mp4', 'mov', 'txt', 'md', 'html', 'htm', 'eml', 'zip', '7z', 'tar', 'gz', 'rar', 'cpp', 'py', 'sh', 'json', 'yaml', 'rdp', 'sample']) {
      expect(thumbs.canThumbnail(ext)).toBe(true);
    }
  });
  test('false for everything else (incl. dmg — its icon is client-side only)', () => {
    for (const ext of ['exe', 'mp3', 'svg', 'dmg', 'bin', 'pyc', '']) {
      expect(thumbs.canThumbnail(ext)).toBe(false);
    }
  });
});

describe('extOf', () => {
  test('lowercased final extension', () => {
    expect(thumbs.extOf({ name: 'Report.FINAL.PDF' })).toBe('pdf');
    expect(thumbs.extOf({ name: 'photo.JPG' })).toBe('jpg');
    expect(thumbs.extOf({ name: 'noext' })).toBe('noext');
    expect(thumbs.extOf({})).toBe('');
  });
});

describe('thumbKey', () => {
  test('content-addressed when a hash is present', () => {
    expect(thumbs.thumbKey({ id: 'd1', content_hash: 'abc123' })).toBe('thumbnails/abc123.webp');
  });
  test('falls back to document id when hash is null (e.g. >25MB)', () => {
    expect(thumbs.thumbKey({ id: 'd1', content_hash: null })).toBe('thumbnails/d1.webp');
    expect(thumbs.thumbKey({ id: 'd1' })).toBe('thumbnails/d1.webp');
  });
});

describe('getThumbnail', () => {
  test('returns the cached blob without rendering when one exists', async () => {
    storage.download.mockResolvedValueOnce(Buffer.from('CACHEDWEBP'));
    const out = await thumbs.getThumbnail({ id: 'd1', name: 'a.png', size: 1000, storage_path: 'documents/a', content_hash: 'h1' });
    expect(out.toString()).toBe('CACHEDWEBP');
    expect(storage.download).toHaveBeenCalledTimes(1);
    expect(storage.download).toHaveBeenCalledWith('thumbnails/h1.webp');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('null (and no storage access) for a non-previewable type', async () => {
    const out = await thumbs.getThumbnail({ id: 'd2', name: 'a.exe', size: 1000, storage_path: 'documents/z' });
    expect(out).toBeNull();
    expect(storage.download).not.toHaveBeenCalled();
  });

  test('skips rendering for a source over the size ceiling', async () => {
    storage.download.mockRejectedValueOnce(new Error('cache miss')); // no cached thumb
    const out = await thumbs.getThumbnail({ id: 'd3', name: 'huge.png', size: 200 * 1024 * 1024, storage_path: 'documents/h', content_hash: 'big' });
    expect(out).toBeNull();
    // Only the cache probe ran — the oversized source was never downloaded.
    expect(storage.download).toHaveBeenCalledTimes(1);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
