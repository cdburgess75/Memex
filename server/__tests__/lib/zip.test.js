'use strict';
const zlib = require('zlib');
const { zipStream } = require('../../lib/zip');

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

// Parse the End Of Central Directory record's total-entry count.
function eocdCount(buf) {
  const sig = 0x06054b50;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === sig) return buf.readUInt16LE(i + 10);
  }
  return -1;
}

// Extract each entry's stored/deflated body by walking the local file headers and
// inflating (or copying) the bytes, so we can assert the payload round-trips.
function extractEntries(buf) {
  const out = {};
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const bodyStart = i + 30 + nameLen + extraLen;
    const body = buf.slice(bodyStart, bodyStart + compSize);
    out[name] = method === 8 ? zlib.inflateRawSync(body) : body;
    i = bodyStart + compSize;
  }
  return out;
}

describe('zipStream', () => {
  test('produces a valid archive whose entries round-trip', async () => {
    const files = {
      'folder/a.txt': Buffer.from('hello world\n'.repeat(500)),
      'folder/sub/b.bin': Buffer.from([...Array(5000).keys()].map(x => x % 256)),
      'folder/empty.txt': Buffer.alloc(0),
    };
    const entries = Object.entries(files).map(([name, data]) => ({ name, load: async () => data }));
    const zip = await collect(zipStream(entries));

    expect(eocdCount(zip)).toBe(3);
    const got = extractEntries(zip);
    for (const [name, data] of Object.entries(files)) {
      expect(got[name]).toBeDefined();
      expect(Buffer.compare(got[name], data)).toBe(0);
    }
  });

  test('fetches files lazily, one at a time (bounded memory)', async () => {
    let inFlight = 0;
    let peak = 0;
    const make = name => ({
      name,
      load: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        return Buffer.from(name);
      },
    });
    await collect(zipStream([make('a'), make('b'), make('c'), make('d')]));
    expect(peak).toBe(1); // never more than one file resident at once
  });

  test('strips leading slashes from entry names', async () => {
    const zip = await collect(zipStream([{ name: '/leading/x.txt', load: async () => Buffer.from('x') }]));
    expect(Object.keys(extractEntries(zip))).toEqual(['leading/x.txt']);
  });
});
