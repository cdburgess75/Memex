'use strict';
// Verifies on-the-fly MP4 fast-start against a synthetic non-web-optimized file:
// moov is relocated before mdat, its stco chunk offset is rewritten by +moov.size,
// the mdat sample bytes are preserved at the new offset, and Range slices are exact.
const fs = require('fs');
const os = require('os');
const path = require('path');
const mp4 = require('../../lib/mp4Faststart');

let TMP;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
function box(type, ...parts) {
  const body = Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}
async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}
function write(name, buf) { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; }

// ftyp(20) + mdat + moov, with stco pointing at the sample offset in the original layout.
const ftyp = box('ftyp', 'isom', u32(0x200), 'isom');            // 20 bytes
const sample = Buffer.from('SAMPLE-DATA-1234567890');            // mdat payload (22 bytes)
const mdat = box('mdat', sample);                                // 30 bytes
const origSampleOffset = ftyp.length + 8;                        // 20 + 8 = 28
const stco = box('stco', u32(0), u32(1), u32(origSampleOffset)); // version+flags, count=1, offset
const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stco)))));
const nonFaststart = Buffer.concat([ftyp, mdat, moov]);          // [ftyp][mdat][moov]
const faststart = Buffer.concat([ftyp, moov, mdat]);             // already optimized

beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-mp4-')); });
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('mp4Faststart.plan', () => {
  test('returns null for an already fast-start file', async () => {
    expect(await mp4.plan(write('opt.mp4', faststart))).toBeNull();
  });
  test('returns null for a non-MP4 / garbage file', async () => {
    expect(await mp4.plan(write('junk.bin', Buffer.from('not an mp4 at all, just text...')))).toBeNull();
  });
  test('plans a non-fast-start file with the full size preserved', async () => {
    const p = await mp4.plan(write('reel.mp4', nonFaststart));
    expect(p).toBeTruthy();
    expect(p.totalSize).toBe(nonFaststart.length);
  });
});

describe('mp4Faststart.createStream', () => {
  test('relocates moov before mdat, rewrites the chunk offset, and preserves sample bytes', async () => {
    const p = await mp4.plan(write('reel.mp4', nonFaststart));
    const out = await collect(mp4.createStream(p, null).stream);

    expect(out.length).toBe(nonFaststart.length);
    const moovPos = out.indexOf(Buffer.from('moov'));
    const mdatPos = out.indexOf(Buffer.from('mdat'));
    expect(moovPos).toBeGreaterThan(0);
    expect(moovPos).toBeLessThan(mdatPos); // fast-started: moov now precedes mdat

    // stco offset must be shifted by +moov.size, and point at the real sample bytes.
    const rewritten = out.readUInt32BE(out.indexOf(Buffer.from('stco')) + 12);
    expect(rewritten).toBe(origSampleOffset + moov.length);
    expect(out.subarray(rewritten, rewritten + sample.length).equals(sample)).toBe(true);
  });

  test('serves an exact byte range over the virtual layout', async () => {
    const p = await mp4.plan(write('reel.mp4', nonFaststart));
    const full = await collect(mp4.createStream(p, null).stream);

    // a range that straddles the moov(buffer)/mdat(file) boundary
    const r = mp4.createStream(p, `bytes=15-${ftyp.length + moov.length + 12}`);
    expect(r.range).toEqual({ start: 15, end: ftyp.length + moov.length + 12 });
    const slice = await collect(r.stream);
    expect(slice.equals(full.subarray(15, ftyp.length + moov.length + 13))).toBe(true);
  });

  test('reports an unsatisfiable range', () => {
    return mp4.plan(write('reel.mp4', nonFaststart)).then(p => {
      const r = mp4.createStream(p, 'bytes=99999-100000');
      expect(r.unsatisfiable).toBe(true);
      expect(r.totalSize).toBe(nonFaststart.length);
    });
  });
});
