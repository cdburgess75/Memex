// Big folder ZIPs.
//
// lib/zip.js writes the classic format -- 32-bit sizes and offsets -- and loads each file
// whole before writing it. That is fine for the few small archives it still makes, and
// wrong for a folder: past 4 GB the archive is corrupt, and one 3 GB video is 3 GB of RAM.
// This streams each file from storage straight into the archive (yazl: ZIP64 when it is
// needed, one file open at a time), so memory stays flat however big the folder is.
//
// Two guards, because an archive this size is minutes of disk and network and the public
// folder page lets anyone holding a link ask for one:
//   - a size limit, ONE setting for every ZIP the app makes (folder_zip_max_mb);
//   - a cap on how many build at once across the process.
const yazl = require('yazl');
const settings = require('./settings');

const DEFAULT_MAX_MB = 8192;
const MAX_CONCURRENT = 3;      // across the process, everybody
const MAX_PUBLIC = 2;          // of those, how many may be for link visitors: one is always left for people signed in
const MIN_BYTES_PER_SEC = 256 * 1024; // slower than this, sustained, and the download is ended (see deadlineMs)
let building = 0, publicBuilding = 0;
const busyKeys = new Set();    // one ZIP at a time per link, and per visitor address

async function maxBytes() {
  const mb = parseInt(await settings.getOrEnv('folder_zip_max_mb') || String(DEFAULT_MAX_MB), 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024;
}
async function maxMb() { return Math.round((await maxBytes()) / (1024 * 1024)); }

class ZipBusyError extends Error {
  constructor(msg) { super(msg || 'Depot is preparing other downloads right now. Try again in a minute.'); this.status = 503; this.code = 'ZIP_BUSY'; }
}

// Takes a slot or throws ZipBusyError. The returned function gives it back, once.
//   isPublic  a link visitor, not somebody signed in. They share MAX_PUBLIC of the slots, so
//             however many links are out there, people who work here can still get a ZIP.
//   keys      what this download is "for" (the link's id, the visitor's address): one at a
//             time each. Three slow readers on one link used to be enough to stop every ZIP
//             on the box; now one link, or one address, can hold exactly one slot.
function takeSlot({ isPublic = false, keys = [] } = {}) {
  const held = keys.filter(Boolean).map(String);
  if (held.some(k => busyKeys.has(k))) throw new ZipBusyError('A ZIP for this folder is already downloading. Wait for it to finish, or download files one at a time.');
  if (building >= MAX_CONCURRENT || (isPublic && publicBuilding >= MAX_PUBLIC)) throw new ZipBusyError();
  building++; if (isPublic) publicBuilding++;
  held.forEach(k => busyKeys.add(k));
  let released = false;
  return () => { if (released) return; released = true; building--; if (isPublic) publicBuilding--; held.forEach(k => busyKeys.delete(k)); };
}
const canStart = ({ isPublic = false, keys = [] } = {}) => !(building >= MAX_CONCURRENT || (isPublic && publicBuilding >= MAX_PUBLIC) || keys.filter(Boolean).some(k => busyKeys.has(String(k))));

// How long a ZIP of this size may take before it is ended: a minute's grace, then no slower
// than MIN_BYTES_PER_SEC overall. A reader taking a byte a minute is not downloading.
const deadlineMs = (bytes) => 60000 + Math.ceil((Number(bytes) || 0) / MIN_BYTES_PER_SEC) * 1000;

// entries: [{ name, open: async () => readableStream }]. Resolves when the archive has been
// written to `out`; rejects otherwise -- and ALWAYS settles, having closed whatever it had
// open. Names are made unique: two files landing on one name would silently lose one.
//
// Everything that can go wrong is listened for, because yazl reports a file it cannot open,
// and a read that fails half way, by emitting 'error' on the ZipFile itself: with nobody
// listening that is an uncaught exception, and one missing blob under a linked folder let
// anyone holding the link take the server down.
async function streamZip(entries, out, { totalBytes = 0 } = {}) {
  const zip = new yazl.ZipFile();
  const seen = new Map();
  const unique = (name) => {
    const n = seen.get(name) || 0; seen.set(name, n + 1);
    if (!n) return name;
    const dot = name.lastIndexOf('.'); const slash = name.lastIndexOf('/');
    return dot > slash ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  };
  let current = null, settled = false, timer = null;
  return new Promise((resolve, reject) => {
    const finish = (err) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (err) { // close everything we hold: the file being read (its descriptor, its decipher), and the archive
        try { current && current.destroy(); } catch (e) { /* already gone */ }
        try { zip.outputStream.unpipe(out); zip.outputStream.destroy(); } catch (e) { /* already gone */ }
        return reject(err);
      }
      resolve();
    };
    zip.on('error', finish);
    zip.outputStream.on('error', finish);
    out.on('error', finish);
    out.on('close', () => finish(new Error('download closed before the archive was finished'))); // after 'finish' this is a no-op
    timer = setTimeout(() => finish(Object.assign(new Error('download too slow; ended'), { code: 'ZIP_TOO_SLOW' })), deadlineMs(totalBytes));
    if (timer.unref) timer.unref();
    zip.outputStream.pipe(out).on('finish', () => finish());
    try {
      for (const e of entries) {
        // Lazy: the file is opened when the archive reaches it, never all at once.
        zip.addReadStreamLazy(unique(e.name), { compress: false }, (cb) => {
          if (settled) return cb(new Error('cancelled'));
          Promise.resolve().then(e.open).then((stream) => {
            if (settled) { try { stream.destroy(); } catch (x) { /* */ } return cb(new Error('cancelled')); }
            current = stream; stream.once('error', finish); cb(null, stream);
          }, (err) => { finish(err); cb(err); });
        });
      }
      zip.end();
    } catch (e) { finish(e); } // yazl refuses a name with ".." or a leading "/": fail closed
  });
}

module.exports = { streamZip, takeSlot, canStart, maxBytes, maxMb, deadlineMs, ZipBusyError, DEFAULT_MAX_MB, MAX_CONCURRENT, MAX_PUBLIC, _building: () => building };
