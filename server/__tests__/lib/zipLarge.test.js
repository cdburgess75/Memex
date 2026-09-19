'use strict';
// The big-ZIP writer has to survive everything a storage backend and a visitor can do to it:
// a blob that is gone, a read that dies half way, a reader who hangs up. Each used to be an
// uncaught 'error' on yazl's ZipFile -- a crash any link holder could cause. And the slots
// have to be shared fairly: one link, or one address, can never hold more than one.
const { Readable, Writable, PassThrough } = require('stream');
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async () => null) }));
const zipLarge = require('../../lib/zipLarge');

const sink = () => { const chunks = []; const w = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }); w.bytes = () => Buffer.concat(chunks); return w; };
const file = (name, body = 'abc') => ({ name, open: async () => Readable.from([body]) });

describe('streamZip always settles, and closes what it opened', () => {
  test('a good archive', async () => {
    const out = sink();
    await zipLarge.streamZip([file('A/one.txt'), file('A/two.txt')], out, { totalBytes: 6 });
    const s = out.bytes().toString('latin1');
    expect(s).toContain('A/one.txt'); expect(s).toContain('A/two.txt');
  });
  test('two files on one name both survive', async () => {
    const out = sink();
    await zipLarge.streamZip([file('A/x.txt', '1'), file('A/x.txt', '2')], out);
    expect(out.bytes().toString('latin1')).toContain('A/x (1).txt');
  });
  test('a file that cannot be opened rejects; it does not crash the process', async () => {
    const gone = { name: 'A/gone.txt', open: async () => { throw new Error('blob missing'); } };
    await expect(zipLarge.streamZip([file('A/one.txt'), gone], sink())).rejects.toThrow(/blob missing/);
  });
  test('a read that fails half way rejects, and the source is destroyed', async () => {
    let src;
    const bad = { name: 'A/bad.bin', open: async () => { let n = 0; src = new Readable({ read() { if (n++ < 2) this.push(Buffer.alloc(1024)); else this.destroy(new Error('disk read failed')); } }); return src; } };
    await expect(zipLarge.streamZip([bad], sink())).rejects.toThrow(/disk read failed/);
    expect(src.destroyed).toBe(true);
  });
  test('a reader who hangs up rejects, and the file being read is closed', async () => {
    let src;
    const endless = { name: 'A/big.bin', open: async () => { src = new Readable({ read() { setImmediate(() => this.push(Buffer.alloc(64 * 1024))); } }); return src; } };
    const out = new PassThrough({ highWaterMark: 1024 }); // nobody reads it: backpressure, like a stalled client
    const p = zipLarge.streamZip([endless], out);
    setTimeout(() => out.destroy(), 30);
    await expect(p).rejects.toThrow(/closed before the archive was finished/);
    expect(src.destroyed).toBe(true);
  });
  test('a name that climbs is refused, not written', async () => {
    await expect(zipLarge.streamZip([file('../escape.txt')], sink())).rejects.toThrow();
  });
  test('a download slower than the floor is ended', async () => {
    jest.useFakeTimers();
    try {
      let src;
      const stalled = { name: 'A/slow.bin', open: async () => { src = new Readable({ read() {} }); return src; } };
      const p = zipLarge.streamZip([stalled], new PassThrough(), { totalBytes: 0 });
      const caught = p.catch(e => e);
      await jest.advanceTimersByTimeAsync(zipLarge.deadlineMs(0) + 1);
      expect((await caught).code).toBe('ZIP_TOO_SLOW');
    } finally { jest.useRealTimers(); }
  });
  test('the deadline is a minute of grace plus the size at the floor speed', () => {
    expect(zipLarge.deadlineMs(0)).toBe(60000);
    expect(zipLarge.deadlineMs(256 * 1024 * 100)).toBe(60000 + 100000);
  });
});

describe('slots', () => {
  const held = []; const take = (o) => { const f = zipLarge.takeSlot(o); held.push(f); return f; };
  afterEach(() => { held.splice(0).forEach(f => f()); expect(zipLarge._building()).toBe(0); });

  test('link visitors share all but one: somebody signed in can always get a ZIP', () => {
    take({ isPublic: true, keys: ['link:a'] }); take({ isPublic: true, keys: ['link:b'] });
    expect(() => take({ isPublic: true, keys: ['link:c'] })).toThrow(zipLarge.ZipBusyError);
    expect(zipLarge.canStart({ isPublic: true, keys: ['link:c'] })).toBe(false);
    expect(zipLarge.canStart()).toBe(true);
    take(); // the signed-in one
    expect(() => take()).toThrow(/Try again in a minute/);
  });
  test('one link, and one address, hold one slot each', () => {
    take({ isPublic: true, keys: ['link:a', 'ip:1.2.3.4'] });
    expect(() => take({ isPublic: true, keys: ['link:a', 'ip:9.9.9.9'] })).toThrow(/already downloading/);
    expect(() => take({ isPublic: true, keys: ['link:z', 'ip:1.2.3.4'] })).toThrow(/already downloading/);
    expect(zipLarge.canStart({ isPublic: true, keys: ['link:a'] })).toBe(false);
    expect(zipLarge._building()).toBe(1); // a refusal took nothing
  });
  test('giving a slot back frees its keys, and only once', () => {
    const free = take({ isPublic: true, keys: ['link:a'] });
    free(); free();
    expect(zipLarge._building()).toBe(0);
    take({ isPublic: true, keys: ['link:a'] });
  });
});
