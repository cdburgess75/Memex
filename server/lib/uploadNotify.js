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
const folderNotifyPrefs = require('./folderNotifyPrefs');
const libraries = require('./libraries');
const documentAccess = require('./documentAccess');

// The most documents one burst tracks for the per-recipient access check. A burst
// bigger than this is summarised from the first ones only.
const MAX_TRACKED = 5000;

const FLUSH_MS = Number(process.env.UPLOAD_NOTIFY_DEBOUNCE_MS || 15000);
const pending = new Map();
const keyOf = (libraryId, folderPath, uploader) =>
  `${libraryId || ''}|${folderPath || ''}|${String(uploader || '').toLowerCase()}`;

// Role defaults, overridable per person: the library OWNER is notified by
// default, MEMBERS are not — and each person's own explicit pref (folder or
// library level) wins. The uploader is never notified.
async function recipientsFor(libraryId, folderPath, uploaderEmail) {
  let ownerEmail = null;
  try { const lib = await libraries.info(libraryId); ownerEmail = (lib && lib.created_by_email) || null; } catch { /* no owner */ }
  let members = [];
  try { members = (await libraries.listMembers(libraryId)).map((m) => m && m.subject_email).filter(Boolean); } catch { /* open library */ }
  let prefs = new Map();
  try { prefs = await folderNotifyPrefs.effectiveFor(libraryId, folderPath); } catch { /* prefs optional */ }

  const out = new Map(); // lower(email) -> email
  if (ownerEmail) {
    const k = ownerEmail.toLowerCase();
    if (prefs.has(k) ? prefs.get(k) : true) out.set(k, ownerEmail); // owner default ON
  }
  for (const m of members) {
    const k = m.toLowerCase();
    if (out.has(k)) continue;
    if (prefs.has(k) ? prefs.get(k) : false) out.set(k, m); // member default OFF
  }
  if (uploaderEmail) out.delete(String(uploaderEmail).toLowerCase());
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
function record({ libraryId = null, folderPath = '', uploaderEmail, uploaderName, fileName, folderName = null, documentId = null }) {
  const k = keyOf(libraryId, folderPath, uploaderEmail);
  let p = pending.get(k);
  if (!p) { p = { libraryId, folderPath, uploaderEmail, uploaderName, count: 0, items: [] }; pending.set(k, p); }
  p.count += 1;
  if (uploaderName) p.uploaderName = uploaderName;
  if (p.items.length < MAX_TRACKED) p.items.push({ name: fileName || 'file', folder: folderName || null, documentId: documentId ? String(documentId) : null });
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
  const where = await locationLabel(p.libraryId, p.folderPath);

  // Each recipient hears only about the files THEY can read. The candidate list (the
  // library owner, people who asked to be told) says nothing about access -- a member
  // may have no access to this folder, and an owner's access to someone else's upload
  // can end -- and a notice names up to eight files. Someone who can read none of them
  // gets no notice at all.
  const candidates = await recipientsFor(p.libraryId, p.folderPath, p.uploaderEmail);
  const ids = p.items.map((i) => i.documentId).filter(Boolean);
  const readers = candidates.length && ids.length ? await documentAccess.readersAmong(ids, candidates) : new Map();
  const sent = [];
  let lastTitle = null;
  for (const to of candidates) {
    const canRead = readers.get(String(to).toLowerCase()) || new Set();
    const mine = p.items.filter((i) => i.documentId && canRead.has(i.documentId));
    if (!mine.length) continue;
    // Only files this recipient can read are counted; anything past MAX_TRACKED in an
    // enormous burst couldn't be checked, so it isn't mentioned.
    const n = mine.length;
    const files = `${n} file${n === 1 ? '' : 's'}`;
    const folders = new Set(mine.map((i) => i.folder).filter(Boolean));
    const what = folders.size
      ? (folders.size > 1 ? `${folders.size} folders (${files})` : `a folder (${files})`)
      : files;
    const title = `${who} uploaded ${what} to ${where}`;
    const names = mine.slice(0, 8).map((i) => i.name);
    const list = names.map((x) => '• ' + x).join('\n');
    const more = n > names.length ? `\n…and ${n - names.length} more` : '';
    notifications.create({
      userEmail: to, type: 'upload_received', title,
      body: names.slice(0, 3).join(', ') + (n > 3 ? ` +${n - 3} more` : ''),
      refType: 'library', refId: p.libraryId || null,
    }).catch(() => {});
    emailEvents.send('upload_received', {
      to, subject: title,
      text: `${title}.\n\n${list}${more}\n\nSign in to Depot to view.`,
    }).catch(() => {});
    sent.push(to);
    lastTitle = title;
  }
  return { title: lastTitle, recipients: sent, count: p.count };
}

// Flush everything now (tests, and a clean shutdown).
async function flushAll() {
  for (const k of [...pending.keys()]) await flush(k);
}

module.exports = { record, flush, flushAll, recipientsFor, FLUSH_MS, _pending: pending };
