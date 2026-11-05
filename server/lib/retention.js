'use strict';
// Retention policies and legal holds.
//
// A library's retention policy (libraries.retention_min_years / retention_dispose_years,
// migrations/0026) says two things in plain words: "keep at least N years" -- a file is
// not purged from the Trash, by anyone or by the sweeper, before it is that old -- and,
// optionally, "dispose after N years of no changes" -- a file nobody has touched for that
// long is moved to the Trash by the daily job here, its owner told 30 days ahead, and the
// move written to the hash-chained record. Both unset is what Depot did before.
//
// A legal hold (legal_holds) covers one document, everything under a folder of a library,
// or a whole library. While it is open, nothing covered can be deleted, purged, replaced
// in place or moved out of where it is -- not by an administrator, not by the Trash
// sweeper, not by the disposal job. Every route that does one of those asks here first
// and answers 423 with code LEGAL_HOLD when refused. Office saves and text edits are
// still allowed (each keeps the bytes it replaces as a version, and versions of a held
// file are never pruned), so people can keep working on a held file without ever losing
// what it held. Placing and releasing a hold are hash-chained document_events rows.
const db = require('./db');
const settings = require('./settings');
const auditLog = require('./auditLog');
// folderOps is required lazily: it reaches documents -> ... -> trashSweeper, which requires this file.
const FolderOpError = () => require('./folderOps').FolderOpError;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || ''));
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const NOTICE_DAYS = 30;              // how far ahead the owner hears about a disposal
const INTERVAL_HOURS = num(process.env.RETENTION_INTERVAL_HOURS, 24);
const BATCH = num(process.env.RETENTION_BATCH, 500);
const MAX_YEARS = 100;

// ---- SQL fragments, for the routes and jobs that must not touch what is held ----

// Does hold `h` cover documents row `alias`: placed on the document itself, on its
// library, or on a folder its name sits under.
function coversSql(alias = 'd', h = 'h') {
  return `(${h}.document_id = ${alias}.id
            OR (${h}.scope = 'library' AND ${h}.library_id = ${alias}.library_id)
            OR (${h}.scope = 'folder' AND ${h}.library_id = ${alias}.library_id AND starts_with(${alias}.name, ${h}.folder_path || '/')))`;
}
// `alias` is the documents row. True while any open hold covers it.
function heldSql(alias = 'd') {
  return `EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL AND ${coversSql(alias, 'h')})`;
}
// The held documents among a set, read from the holds' side: these are the queries the
// routes make, and they deliberately do not look like a document read.
const HELD_FROM = `FROM legal_holds h JOIN documents d ON ${coversSql('d', 'h')} WHERE h.released_at IS NULL`;
// True while the file is younger than its library's minimum retention.
function underMinimumSql(alias = 'd') {
  return `EXISTS (SELECT 1 FROM libraries l WHERE l.id = ${alias}.library_id AND l.retention_min_years IS NOT NULL
            AND ${alias}.created_at > NOW() - make_interval(years => l.retention_min_years))`;
}
// What may be purged for good: not held, and past its library's minimum.
function purgeableSql(alias = 'd') { return `NOT ${heldSql(alias)} AND NOT ${underMinimumSql(alias)}`; }

// ---- refusals ----
const HOLD_WORDS = {
  deleted: 'deleted', purged: 'deleted for good', replaced: 'replaced', moved: 'moved', renamed: 'renamed',
};
function holdError(what = 'deleted', count = 1) {
  const verb = HOLD_WORDS[what] || what;
  const msg = count > 1
    ? `${count} files here are under a legal hold, so this cannot be ${verb}. An administrator can release the hold from Compliance.`
    : `This is under a legal hold, so it cannot be ${verb}. An administrator can release the hold from Compliance.`;
  return new (FolderOpError())('LEGAL_HOLD', 423, msg);
}
function minimumError(years) {
  return new (FolderOpError())('RETENTION_MINIMUM', 423,
    `This library keeps its files for at least ${years} year${years === 1 ? '' : 's'}, so this file cannot be deleted for good yet. It can stay in the Trash until then.`);
}
const isRefusal = (e) => !!e && e.status === 423 && (e.code === 'LEGAL_HOLD' || e.code === 'RETENTION_MINIMUM');
// Answers a refusal from here; false for anything else (the caller goes on to its own handling).
function sendRefusal(res, e) {
  if (!isRefusal(e)) return false;
  res.status(e.status).json({ code: e.code, error: e.message });
  return true;
}

// ---- asks, on a db or a transaction client wearing db's clothes (folderOps.clientQ) ----
async function assertDocumentNotHeld(q, documentId, what = 'deleted') {
  if (!isUuid(documentId)) return;
  const row = await q.queryOne(`SELECT h.id AS hold_id ${HELD_FROM} AND d.id = $1 LIMIT 1`, [documentId]);
  if (row) throw holdError(what);
}
async function assertDocumentsNotHeld(q, ids, what = 'moved') {
  const list = (ids || []).filter(isUuid);
  if (!list.length) return;
  const rows = await q.query(`SELECT DISTINCT d.id AS held_id ${HELD_FROM} AND d.id = ANY($1::uuid[])`, [list]);
  if (rows.length) throw holdError(what, rows.length);
}
// Anything under a folder, live or in the Trash: a folder hold is keyed by the folder's
// name, so the folder itself may not be renamed or moved either while anything in it is held.
async function assertNothingHeldUnder(q, libraryId, folderPath, what = 'deleted') {
  if (!isUuid(libraryId)) return;
  const row = await q.queryOne(
    `SELECT count(DISTINCT d.id)::int AS held_count ${HELD_FROM} AND d.library_id = $1 AND starts_with(d.name, $2 || '/')`,
    [libraryId, folderPath]);
  const n = row?.held_count || 0;
  if (n) throw holdError(what, n);
}
// A purge: refused while held, and refused while younger than the library's minimum.
async function assertPurgeAllowed(q, documentId) {
  if (!isUuid(documentId)) return;
  const row = await q.queryOne(
    `SELECT l.retention_min_years AS min_years, ${heldSql('d')} AS held,
            (l.retention_min_years IS NOT NULL AND d.created_at > NOW() - make_interval(years => l.retention_min_years)) AS under_minimum
       FROM libraries l RIGHT JOIN documents d ON l.id = d.library_id
      WHERE d.id = $1`, [documentId]);
  if (!row) return;
  if (row.held) throw holdError('purged');
  if (row.under_minimum) throw minimumError(Number(row.min_years));
}

// ---- the policy ----
function parseYears(v, name) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_YEARS) {
    const e = new Error(`${name} must be a whole number of years from 1 to ${MAX_YEARS}, or left blank`); e.status = 400; throw e;
  }
  return n;
}
function shapePolicy(row) {
  if (!row) return null;
  return {
    library_id: row.id, name: row.name,
    min_years: row.retention_min_years ?? null, dispose_years: row.retention_dispose_years ?? null,
    set_at: row.retention_set_at || null, set_by: row.retention_set_by_email || null,
  };
}
async function getPolicy(libraryId) {
  if (!isUuid(libraryId)) return null;
  return shapePolicy(await db.queryOne('SELECT id, name, retention_min_years, retention_dispose_years, retention_set_at, retention_set_by_email FROM libraries WHERE id = $1', [libraryId]));
}
async function setPolicy(libraryId, { min_years, dispose_years } = {}, user) {
  const min = parseYears(min_years, 'Keep at least');
  const dispose = parseYears(dispose_years, 'Delete after');
  if (min != null && dispose != null && dispose < min) {
    const e = new Error('Files cannot be deleted before the time they must be kept: "delete after" must be at least "keep at least"'); e.status = 400; throw e;
  }
  const row = await db.queryOne(
    `UPDATE libraries SET retention_min_years = $2, retention_dispose_years = $3, retention_set_at = NOW(), retention_set_by_email = $4
      WHERE id = $1 RETURNING id, name, retention_min_years, retention_dispose_years, retention_set_at, retention_set_by_email`,
    [libraryId, min, dispose, user?.email || null]);
  if (!row) return null;
  await auditLog.append({
    eventType: 'retention_policy_set', actorId: user?.id || null, actorEmail: user?.email || null,
    detail: `library ${row.id} ${JSON.stringify(row.name)} · ${describePolicy(row)}`,
  }).catch(() => {});
  return shapePolicy(row);
}
const yrs = (n) => `${n} year${Number(n) === 1 ? '' : 's'}`;
function describePolicy(p) {
  const min = p.retention_min_years ?? p.min_years, dispose = p.retention_dispose_years ?? p.dispose_years;
  const parts = [];
  if (min) parts.push(`keep at least ${yrs(min)}`);
  if (dispose) parts.push(`move to the trash after ${yrs(dispose)} without changes`);
  return parts.length ? parts.join('; ') : 'no retention policy';
}

// Every library's policy, for the report and the Compliance window. `client` libraries
// are the ones the retention_policy control is judged on: not somebody's personal
// library and not put away -- the shared ones that hold client files.
async function policies() {
  let rows = [];
  try {
    rows = await db.query(
      `SELECT l.id, l.name, l.personal, l.archived_at, l.owner_email, l.retention_min_years, l.retention_dispose_years, l.retention_set_at, l.retention_set_by_email,
              (SELECT count(*)::int FROM documents d WHERE d.library_id = l.id AND d.deleted_at IS NULL AND d.name !~ '(^|/)\\.keep$') AS files
         FROM libraries l ORDER BY l.personal, l.name`);
  } catch { rows = []; }
  return rows.map(r => ({ ...shapePolicy(r), personal: !!r.personal, archived: !!r.archived_at, owner: r.owner_email || null, files: r.files || 0,
    client: !r.personal && !r.archived_at, words: describePolicy(r) }));
}
async function policySummary() {
  const all = await policies();
  const client = all.filter(l => l.client);
  return {
    libraries: all,
    total: client.length,
    withMinimum: client.filter(l => l.min_years).length,
    withDisposal: client.filter(l => l.dispose_years).length,
    withNone: client.filter(l => !l.min_years && !l.dispose_years).length,
    missingMinimum: client.filter(l => !l.min_years).map(l => l.name),
  };
}

// ---- holds ----
const HOLD_COLUMNS = `h.id, h.scope, h.library_id, h.folder_path, h.document_id, h.reason, h.placed_by, h.placed_by_email, h.placed_at,
  h.released_at, h.released_by, h.released_by_email, h.release_note,
  (SELECT l.name FROM libraries l WHERE l.id = h.library_id) AS library_name,
  (SELECT d.name FROM documents d WHERE d.id = h.document_id) AS document_name`;
function shapeHold(h) {
  const where = h.scope === 'library' ? `library “${h.library_name || '?'}”`
    : h.scope === 'folder' ? `folder “${h.folder_path}” in “${h.library_name || '?'}”`
      : `file “${h.document_name || '?'}”${h.library_name ? ` in “${h.library_name}”` : ''}`;
  return {
    id: h.id, scope: h.scope, library_id: h.library_id, library_name: h.library_name || null,
    folder_path: h.folder_path || null, document_id: h.document_id, document_name: h.document_name || null,
    where, reason: h.reason, placed_by: h.placed_by_email || null, placed_at: h.placed_at,
    released_at: h.released_at || null, released_by: h.released_by_email || null, release_note: h.release_note || null,
    active: !h.released_at,
  };
}
async function activeHolds({ libraryId = null } = {}) {
  let rows = [];
  try {
    rows = libraryId
      ? await db.query(`SELECT ${HOLD_COLUMNS} FROM legal_holds h WHERE h.released_at IS NULL AND h.library_id = $1 ORDER BY h.placed_at DESC`, [libraryId])
      : await db.query(`SELECT ${HOLD_COLUMNS} FROM legal_holds h WHERE h.released_at IS NULL ORDER BY h.placed_at DESC`);
  } catch { rows = []; }
  return rows.map(shapeHold);
}
async function holdHistory({ limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  let rows = [];
  try { rows = await db.query(`SELECT ${HOLD_COLUMNS} FROM legal_holds h WHERE h.released_at IS NOT NULL ORDER BY h.released_at DESC LIMIT ${n}`); } catch { rows = []; }
  return rows.map(shapeHold);
}
async function holdCounts() {
  try {
    const r = await db.queryOne(`SELECT count(*) FILTER (WHERE released_at IS NULL)::int AS active, count(*)::int AS ever FROM legal_holds`);
    return { active: r?.active || 0, ever: r?.ever || 0 };
  } catch { return { active: 0, ever: 0 }; }
}
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
async function placeHold({ scope, library_id, folder_path, document_id, reason } = {}, user) {
  const why = String(reason || '').trim();
  if (!why) throw bad('A hold needs a reason: what it is for, in a sentence');
  if (why.length > 500) throw bad('Keep the reason under 500 characters');
  let lib = null, doc = null, folder = null;
  if (scope === 'document') {
    if (!isUuid(document_id)) throw bad('document_id is required');
    doc = await db.queryOne('SELECT id, name, library_id FROM documents WHERE id = $1', [document_id]);
    if (!doc) { const e = new Error('Document not found'); e.status = 404; throw e; }
    lib = doc.library_id ? await db.queryOne('SELECT id, name FROM libraries WHERE id = $1', [doc.library_id]) : null;
  } else if (scope === 'folder' || scope === 'library') {
    if (!isUuid(library_id)) throw bad('library_id is required');
    lib = await db.queryOne('SELECT id, name FROM libraries WHERE id = $1', [library_id]);
    if (!lib) { const e = new Error('Library not found'); e.status = 404; throw e; }
    if (scope === 'folder') {
      folder = String(folder_path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!folder) throw bad('folder_path is required for a folder hold');
    }
  } else throw bad('scope must be library, folder or document');
  const same = await db.queryOne(
    `SELECT id FROM legal_holds WHERE released_at IS NULL AND scope = $1 AND library_id IS NOT DISTINCT FROM $2 AND folder_path IS NOT DISTINCT FROM $3 AND document_id IS NOT DISTINCT FROM $4`,
    [scope, lib?.id || null, folder, doc?.id || null]);
  if (same) { const e = new Error('A hold is already in place here'); e.status = 409; throw e; }
  const row = await db.queryOne(
    `INSERT INTO legal_holds (scope, library_id, folder_path, document_id, reason, placed_by, placed_by_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [scope, lib?.id || null, folder, doc?.id || null, why, user?.id || null, user?.email || null]);
  const hold = shapeHold(await db.queryOne(`SELECT ${HOLD_COLUMNS} FROM legal_holds h WHERE h.id = $1`, [row.id]));
  await auditLog.append({
    documentId: doc?.id || null, eventType: 'hold_placed', actorId: user?.id || null, actorEmail: user?.email || null,
    detail: `hold ${hold.id} on ${hold.where} · ${JSON.stringify(why)}`,
  }).catch(() => {});
  return hold;
}
async function releaseHold(id, note, user) {
  if (!isUuid(id)) { const e = new Error('Hold not found'); e.status = 404; throw e; }
  const why = String(note || '').trim();
  if (!why) throw bad('Releasing a hold needs a note: why it is no longer needed');
  const row = await db.queryOne(
    `UPDATE legal_holds SET released_at = NOW(), released_by = $2, released_by_email = $3, release_note = $4
      WHERE id = $1 AND released_at IS NULL RETURNING id`,
    [id, user?.id || null, user?.email || null, why]);
  if (!row) { const e = new Error('Hold not found, or already released'); e.status = 404; throw e; }
  const hold = shapeHold(await db.queryOne(`SELECT ${HOLD_COLUMNS} FROM legal_holds h WHERE h.id = $1`, [id]));
  await auditLog.append({
    documentId: hold.document_id || null, eventType: 'hold_released', actorId: user?.id || null, actorEmail: user?.email || null,
    detail: `hold ${hold.id} on ${hold.where} released · ${JSON.stringify(why)}`,
  }).catch(() => {});
  return hold;
}

// ---- the disposal job ----
// Two passes a day. First the notices: a file that will cross its library's line within
// NOTICE_DAYS, and has not been told about, gets one notification to whoever added it,
// and the date is stamped. Then the disposals: a file past the line, not held, past the
// minimum, whose notice went out at least NOTICE_DAYS ago, goes to the Trash under the
// library's lock (as a delete by hand does), with a hash-chained event and a second
// notification. The owner can restore it from the Trash like any deleted file.
const liveEligible = `d.deleted_at IS NULL AND d.name !~ '(^|/)\\.keep$' AND l.retention_dispose_years IS NOT NULL`;
const untouchedFor = (col) => `coalesce(d.modified_at, d.created_at) < NOW() - make_interval(years => l.${col})`;

async function noticeOnce({ now = 'NOW()' } = {}) {
  let rows = [];
  try {
    rows = await db.query(
      `SELECT d.id, d.name, d.uploaded_by, d.uploaded_by_email, l.name AS library_name, l.retention_dispose_years,
              coalesce(d.modified_at, d.created_at) + make_interval(years => l.retention_dispose_years) AS due
         FROM documents d JOIN libraries l ON l.id = d.library_id
        WHERE ${liveEligible} AND d.disposal_notice_at IS NULL AND NOT ${heldSql('d')}
          AND coalesce(d.modified_at, d.created_at) < ${now} - make_interval(years => l.retention_dispose_years) + make_interval(days => $1::int)
        ORDER BY due ASC LIMIT $2`, [NOTICE_DAYS, BATCH]);
  } catch { rows = []; }
  let sent = 0;
  for (const d of rows) {
    const stamped = await db.query('UPDATE documents SET disposal_notice_at = NOW() WHERE id = $1 AND disposal_notice_at IS NULL RETURNING id', [d.id]).catch(() => []);
    if (!stamped.length) continue;
    sent += 1;
    const dueDay = new Date(Math.max(new Date(d.due).getTime(), Date.now() + NOTICE_DAYS * 86400000));
    const when = dueDay.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    try {
      await require('./notifications').create({
        userId: d.uploaded_by || null, userEmail: d.uploaded_by_email || null, type: 'retention_notice',
        title: `“${d.name.split('/').pop()}” will move to the Trash on ${when}`,
        body: `Nothing has changed in it for ${yrs(d.retention_dispose_years)}, which is the limit set for “${d.library_name}”. Open or edit it to keep it; otherwise it goes to the Trash on ${when}, where it can still be restored.`,
        refType: 'document', refId: d.id, refPath: d.name,
      });
    } catch { /* the stamp stands: a notice that could not be delivered is not sent again */ }
  }
  return { noticed: sent };
}

async function disposeOnce() {
  let rows = [];
  try {
    rows = await db.query(
      `SELECT d.id, d.name, d.library_id, d.uploaded_by, d.uploaded_by_email, l.name AS library_name, l.retention_dispose_years
         FROM documents d JOIN libraries l ON l.id = d.library_id
        WHERE ${liveEligible} AND ${untouchedFor('retention_dispose_years')}
          AND d.disposal_notice_at IS NOT NULL AND d.disposal_notice_at < NOW() - make_interval(days => $1::int)
          AND NOT ${heldSql('d')} AND NOT ${underMinimumSql('d')}
        ORDER BY d.library_id, d.name LIMIT $2`, [NOTICE_DAYS, BATCH]);
  } catch { rows = []; }
  const result = { disposed: 0 };
  if (!rows.length) return result;
  const { withFolderOp } = require('./folderOps');
  const { keepSharedFoldersAlive } = require('./keepMarker');
  const storage = require('./storage');
  const byLibrary = new Map();
  for (const d of rows) { if (!byLibrary.has(String(d.library_id))) byLibrary.set(String(d.library_id), []); byLibrary.get(String(d.library_id)).push(d); }
  for (const [libraryId, docs] of byLibrary) {
    let out = null;
    try {
      out = await withFolderOp({ libraryIds: [libraryId], kind: 'placement', mode: 'shared' }, async (q) => {
        // Every condition is asked again on this client: a hold placed, an edit made or a
        // restore done while the batch was being read leaves that file where it is.
        const gone = await q.query(
          `UPDATE documents d SET deleted_at = NOW(), deleted_by = NULL, deleted_by_email = 'system@retention'
             FROM libraries l
            WHERE l.id = d.library_id AND d.id = ANY($1::uuid[]) AND ${liveEligible} AND ${untouchedFor('retention_dispose_years')}
              AND d.disposal_notice_at IS NOT NULL AND NOT ${heldSql('d')} AND NOT ${underMinimumSql('d')}
            RETURNING d.id, d.name`, [docs.map(d => d.id)]);
        const planted = gone.length ? await keepSharedFoldersAlive(q, libraryId, gone.map(r => r.name)) : [];
        return { gone, planted };
      });
    } catch (e) { console.error('[retention] disposal failed for a library:', e.message); continue; }
    for (const m of out.planted) await storage.upload(m.storagePath, Buffer.alloc(0), 'application/octet-stream').catch(() => {});
    const byId = new Map(docs.map(d => [String(d.id), d]));
    for (const g of out.gone) {
      const d = byId.get(String(g.id)) || g;
      result.disposed += 1;
      await auditLog.append({
        documentId: g.id, eventType: 'disposed', actorId: null, actorEmail: 'system@retention',
        detail: `moved to the trash by the retention policy of ${JSON.stringify(d.library_name || '')}: no changes for ${yrs(d.retention_dispose_years)} · ${g.name}`,
      }).catch(() => {});
      try {
        await require('./notifications').create({
          userId: d.uploaded_by || null, userEmail: d.uploaded_by_email || null, type: 'retention_disposed',
          title: `“${g.name.split('/').pop()}” was moved to the Trash`,
          body: `Nothing had changed in it for ${yrs(d.retention_dispose_years)}, the limit set for “${d.library_name}”. It can be restored from the Trash for ${await trashDays()} days.`,
          refType: 'document', refId: g.id, refPath: g.name,
        });
      } catch { /* best effort */ }
    }
  }
  return result;
}
async function trashDays() {
  const d = parseInt((await settings.getOrEnv('trash_retention_days')) || '30', 10);
  return Number.isFinite(d) && d >= 0 ? d : 30;
}
async function runOnce() {
  const n = await noticeOnce();
  const d = await disposeOnce();
  return { ...n, ...d };
}

let _timer = null;
let _running = false;
async function runGuarded() {
  if (_running) return;
  _running = true;
  try {
    const r = await runOnce();
    if (r.noticed || r.disposed) console.log(`[retention] ${r.noticed} notice(s) sent, ${r.disposed} file(s) moved to the trash`);
  } catch (e) { console.error('[retention] run failed:', e.message); }
  finally { _running = false; }
}
function start() {
  if (_timer) return _timer;
  const first = setTimeout(runGuarded, 3 * 60 * 1000); // first pass a few minutes after boot
  first.unref?.();
  _timer = setInterval(runGuarded, INTERVAL_HOURS * 3600 * 1000);
  _timer.unref?.();
  return _timer;
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = {
  heldSql, coversSql, underMinimumSql, purgeableSql, holdError, minimumError, isRefusal, sendRefusal,
  assertDocumentNotHeld, assertDocumentsNotHeld, assertNothingHeldUnder, assertPurgeAllowed,
  getPolicy, setPolicy, policies, policySummary, describePolicy,
  activeHolds, holdHistory, holdCounts, placeHold, releaseHold,
  noticeOnce, disposeOnce, runOnce, start, stop, NOTICE_DAYS, INTERVAL_HOURS, MAX_YEARS,
};
