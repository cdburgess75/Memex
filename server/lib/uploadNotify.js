'use strict';
// Upload notifications: when files or folders are uploaded into Depot — by a
// signed-in member OR an external party through a share/exchange/request link —
// notify the people who should know, in-app and by email.
//
// Recipients = the library OWNER (always) + anyone who follows the destination
// (folderWatchers), minus the uploader themselves.
//
// One SUMMARY per upload burst, never one-per-file: a folder or bulk upload
// fires many separate requests within seconds, so each record() resets a short
// debounce and the flush sends a single "X uploaded N files to <place>" — so a
// 200-file folder is one notification and one email, not two hundred.
const notifications = require('./notifications');
const emailEvents = require('./emailEvents');
const folderWatchers = require('./folderWatchers');
const libraries = require('./libraries');

const FLUSH_MS = Number(process.env.UPLOAD_NOTIFY_DEBOUNCE_MS || 15000);
const pending = new Map();
const keyOf = (libraryId, folderPath, uploader) =>
  `${libraryId || ''}|${folderPath || ''}|${String(uploader || '').toLowerCase()}`;

async function recipientsFor(libraryId, folderPath, uploaderEmail) {
  const out = new Map(); // lower(email) -> email (preserve display casing)
  try {
    const lib = await libraries.info(libraryId);
    if (lib && lib.created_by_email) out.set(lib.created_by_email.toLowerCase(), lib.created_by_email);
  } catch { /* no owner is fine */ }
  try {
    // Don't let a follower row overwrite the owner's display casing when they're
    // the same address — first (owner) wins.
    for (const w of await folderWatchers.subscribersFor(libraryId, folderPath)) {
      if (!out.has(w.toLowerCase())) out.set(w.toLowerCase(), w);
    }
  } catch { /* watchers optional */ }
  if (uploaderEmail) out.delete(String(uploaderEmail).toLowerCase()); // never self-notify
  return [...out.values()];
}

async function locationLabel(libraryId, folderPath) {
  let lib = null;
  try { lib = await libraries.info(libraryId); } catch { /* default */ }
  const folder = String(folderPath || '').split('/').filter(Boolean).pop();
  const libName = (lib && lib.name) || 'your workspace';
  return folder ? `${folder} (${libName})` : libName;
}

// Called once per uploaded file, from every user-facing upload path.
function record({ libraryId = null, folderPath = '', uploaderEmail, uploaderName, fileName, folderName = null }) {
  const k = keyOf(libraryId, folderPath, uploaderEmail);
  let p = pending.get(k);
  if (!p) { p = { libraryId, folderPath, uploaderEmail, uploaderName, count: 0, names: [], folders: new Set() }; pending.set(k, p); }
  p.count += 1;
  if (uploaderName) p.uploaderName = uploaderName;
  if (fileName && p.names.length < 8) p.names.push(fileName);
  if (folderName) p.folders.add(folderName);
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => { flush(k).catch((e) => console.error('uploadNotify flush:', e.message)); }, FLUSH_MS);
  if (p.timer.unref) p.timer.unref();
}

async function flush(k) {
  const p = pending.get(k);
  if (!p) return;
  pending.delete(k);
  if (p.timer) clearTimeout(p.timer);

  const who = p.uploaderName || p.uploaderEmail || 'Someone';
  const n = p.count;
  const files = `${n} file${n === 1 ? '' : 's'}`;
  const what = p.folders.size
    ? (p.folders.size > 1 ? `${p.folders.size} folders (${files})` : `a folder (${files})`)
    : files;
  const where = await locationLabel(p.libraryId, p.folderPath);
  const title = `${who} uploaded ${what} to ${where}`;
  const list = p.names.slice(0, 8).map((x) => '• ' + x).join('\n');
  const more = n > p.names.length ? `\n…and ${n - p.names.length} more` : '';

  const recipients = await recipientsFor(p.libraryId, p.folderPath, p.uploaderEmail);
  for (const to of recipients) {
    notifications.create({
      userEmail: to, type: 'upload_received', title,
      body: p.names.slice(0, 3).join(', ') + (n > 3 ? ` +${n - 3} more` : ''),
      refType: 'library', refId: p.libraryId || null,
    }).catch(() => {});
    emailEvents.send('upload_received', {
      to, subject: title,
      text: `${title}.\n\n${list}${more}\n\nSign in to Depot to view.`,
    }).catch(() => {});
  }
  return { title, recipients, count: n };
}

// Flush everything now (tests, and a clean shutdown).
async function flushAll() {
  for (const k of [...pending.keys()]) await flush(k);
}

module.exports = { record, flush, flushAll, recipientsFor, FLUSH_MS, _pending: pending };
