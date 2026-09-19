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
const MAX_CONCURRENT = 3;
let building = 0;

async function maxBytes() {
  const mb = parseInt(await settings.getOrEnv('folder_zip_max_mb') || String(DEFAULT_MAX_MB), 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024;
}
async function maxMb() { return Math.round((await maxBytes()) / (1024 * 1024)); }

class ZipBusyError extends Error {
  constructor() { super('Depot is preparing other downloads right now. Try again in a minute.'); this.status = 503; this.code = 'ZIP_BUSY'; }
}

// Takes a slot or throws ZipBusyError. The returned function gives it back, once.
function takeSlot() {
  if (building >= MAX_CONCURRENT) throw new ZipBusyError();
  building++;
  let released = false;
  return () => { if (!released) { released = true; building--; } };
}

// entries: [{ name, open: async () => readableStream }]. Resolves when the archive has been
// written to `out` (or rejects, having destroyed it). Names are made unique: two files that
// land on one name inside the archive would silently lose one of them.
async function streamZip(entries, out) {
  const zip = new yazl.ZipFile();
  const seen = new Map();
  const unique = (name) => {
    const n = seen.get(name) || 0; seen.set(name, n + 1);
    if (!n) return name;
    const dot = name.lastIndexOf('.'); const slash = name.lastIndexOf('/');
    return dot > slash ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  };
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on('error', reject);
    out.on('error', reject);
    out.on('close', () => reject(new Error('download closed before the archive was finished')));
    zip.outputStream.pipe(out).on('finish', resolve);
  });
  for (const e of entries) {
    // Lazy: the file is opened when the archive reaches it, never all at once.
    zip.addReadStreamLazy(unique(e.name), { compress: false }, (cb) => {
      Promise.resolve().then(e.open).then((s) => cb(null, s), (err) => cb(err));
    });
  }
  zip.end();
  return done;
}

module.exports = { streamZip, takeSlot, maxBytes, maxMb, ZipBusyError, DEFAULT_MAX_MB, MAX_CONCURRENT, _building: () => building };
