'use strict';
// Sensitive data in files: payment card numbers, US Social Security numbers, and US bank
// routing and account numbers, found in the text the search index already extracts from
// each file. Nothing here reads a file twice and nothing here blocks an upload: the
// routes that store extracted text hand it to check(), which runs after the response is
// on its way and records what it finds in document_findings. A finding holds the type, a
// count and a masked sample (the last four digits); never the value itself.
//
// Each type has a setting, off or flag: sensitive_data_cards (flag), sensitive_data_ssn
// (flag), sensitive_data_bank (off). A tax office legitimately holds Social Security
// numbers, so those findings are informational; the PCI control (lib/compliance.js
// sensitive_data) turns on card findings alone. There is no "refuse" mode.
const db = require('./db');
const settings = require('./settings');

const TYPES = ['card', 'ssn', 'bank'];
const SETTING_KEYS = { card: 'sensitive_data_cards', ssn: 'sensitive_data_ssn', bank: 'sensitive_data_bank' };
const DEFAULTS = { card: 'flag', ssn: 'flag', bank: 'off' };
const WORDS = { card: 'card numbers', ssn: 'Social Security numbers', bank: 'bank account or routing numbers' };
const WORD = { card: 'card number', ssn: 'Social Security number', bank: 'bank account or routing number' };
// How much of a file's text is read: enough for any office document, bounded for a
// pasted database dump.
const MAX_CHARS = 2_000_000;

// ---- detectors (pure) ----

function luhn(digits) {
  let sum = 0, double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// The issuer ranges of the card brands in common use, with each brand's lengths; a number
// outside them is not a card, however well it passes Luhn (an order number, say).
function cardBrand(digits) {
  const n = digits.length;
  const p2 = Number(digits.slice(0, 2)), p3 = Number(digits.slice(0, 3)), p4 = Number(digits.slice(0, 4));
  if (digits[0] === '4' && (n === 13 || n === 16 || n === 19)) return 'Visa';
  if (((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) && n === 16) return 'Mastercard';
  if ((p2 === 34 || p2 === 37) && n === 15) return 'American Express';
  if ((p4 === 6011 || (p3 >= 644 && p3 <= 649) || p2 === 65) && n >= 16 && n <= 19) return 'Discover';
  if ((p2 === 36 || p2 === 38 || p2 === 39 || (p3 >= 300 && p3 <= 305)) && n >= 14 && n <= 19) return 'Diners Club';
  if (p4 >= 3528 && p4 <= 3589 && n >= 16 && n <= 19) return 'JCB';
  if (p2 === 62 && n >= 16 && n <= 19) return 'UnionPay';
  return null;
}

// A run of 13 to 19 digits, spaces or dashes allowed between them, not part of a longer
// run of digits. Luhn and a known issuer range both have to hold.
const CARD_RE = /(?<![\d])(\d(?:[ -]?\d){12,18})(?![\d])/g;
function findCards(text) {
  const hits = [];
  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[1].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (/^(\d)\1+$/.test(digits)) continue;        // 0000 0000 0000 0000 passes Luhn; it is a placeholder
    if (!luhn(digits) || !cardBrand(digits)) continue;
    hits.push(digits);
  }
  return hits;
}

// Social Security numbers under the SSA's own rules: the area is never 000, 666 or 900 and
// up, the group never 00, the serial never 0000, and two numbers the SSA has publicly
// retired (one printed on wallet inserts in 1938, one used in an advertisement) are never
// anyone's. With a separator, the same separator twice (123-45-6789, 123 45 6789). A bare
// nine digits is a number of every kind (a routing number is nine digits too), so it counts
// only when the words before it say what it is.
const SSN_RE = /(?<![\d-])(\d{3})([- ]?)(\d{2})\2(\d{4})(?![\d-])/g;
const SSN_CONTEXT = /\b(?:ssn|ss\s?#|ss\s?no\.?|social\s+security|soc\.?\s*sec\.?|taxpayer\s+id|tin)(?![a-z])[^\n]{0,40}$/i;
const SSN_NEVER = new Set(['078051120', '219099999']);
function validSsn(area, group, serial) {
  const a = Number(area), g = Number(group), s = Number(serial);
  if (a === 0 || a === 666 || a >= 900) return false;
  if (g === 0 || s === 0) return false;
  return !SSN_NEVER.has(area + group + serial);
}
function findSsns(text) {
  const hits = [];
  for (const m of text.matchAll(SSN_RE)) {
    const [, area, sep, group, serial] = m;
    if (!validSsn(area, group, serial)) continue;
    if (!sep && !SSN_CONTEXT.test(text.slice(Math.max(0, m.index - 60), m.index))) continue;
    hits.push(area + group + serial);
  }
  return hits;
}

// Routing numbers: nine digits, ABA checksum, a prefix the Federal Reserve assigns
// (00–12, 21–32, 61–72, 80), and the word routing, ABA or transit nearby, since a
// checksum alone lets one number in ten through. Account numbers: 6 to 17 digits right
// after the words account number (or acct, account no., account #).
const ROUTING_RE = /(?<![\d-])(\d{9})(?![\d-])/g;
const ROUTING_CONTEXT = /\b(?:routing|aba|rtn|transit|r\/t)\b/i;
const ACCOUNT_RE = /\b(?:acct|account)\.?\s*(?:no\.?|number|num\.?|#)?\s*[:#]?\s*(\d(?:[ -]?\d){5,16})(?![\d])/gi;
function abaValid(d) {
  const p = Number(d.slice(0, 2));
  if (!((p <= 12) || (p >= 21 && p <= 32) || (p >= 61 && p <= 72) || p === 80)) return false;
  const n = [...d].map(Number);
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0;
}
function findBank(text) {
  const hits = [];
  for (const m of text.matchAll(ROUTING_RE)) {
    if (!abaValid(m[1])) continue;
    const around = text.slice(Math.max(0, m.index - 60), m.index + 9 + 24);
    if (!ROUTING_CONTEXT.test(around)) continue;
    hits.push(m[1]);
  }
  for (const m of text.matchAll(ACCOUNT_RE)) {
    const digits = m[1].replace(/[ -]/g, '');
    if (digits.length < 6 || digits.length > 17) continue;
    if (/^(\d)\1+$/.test(digits)) continue;
    hits.push(digits);
  }
  return hits;
}

const mask = (type, digits) => {
  const last = digits.slice(-4);
  return type === 'ssn' ? `•••-••-${last}` : `•••• ${last}`;
};

// Every finding in a piece of text: [{ type, count, sample }], one per type found, the
// sample masked to its last four digits. `types` limits the search to the types asked for.
function detect(text, { types = TYPES, maxChars = MAX_CHARS } = {}) {
  const t = String(text || '').slice(0, maxChars);
  if (!t) return [];
  const out = [];
  const add = (type, hits) => { if (hits.length) out.push({ type, count: hits.length, sample: mask(type, hits[0]) }); };
  if (types.includes('card')) add('card', findCards(t));
  if (types.includes('ssn')) add('ssn', findSsns(t));
  if (types.includes('bank')) add('bank', findBank(t));
  return out;
}

// ---- settings ----

async function modes() {
  const out = {};
  for (const type of TYPES) {
    const v = String((await settings.getOrEnv(SETTING_KEYS[type])) || '').toLowerCase();
    out[type] = v === 'off' ? 'off' : v === 'flag' ? 'flag' : DEFAULTS[type];
  }
  return out;
}
async function enabledTypes() {
  const m = await modes();
  return TYPES.filter(t => m[t] === 'flag');
}

// ---- recording ----

async function adminRecipients() {
  return db.query(`SELECT user_id, COALESCE(verified_email, email) AS email FROM user_roles WHERE role = 'admin' AND disabled_at IS NULL AND COALESCE(verified_email, email) IS NOT NULL`);
}

async function tellAdmins(docId, name, finding) {
  try {
    const notifications = require('./notifications');
    for (const a of await adminRecipients()) {
      await notifications.create({
        userId: a.user_id, userEmail: a.email, type: 'sensitive_data_found',
        title: `A card number may be in ${name || 'a file'}`,
        body: `${finding.count === 1 ? 'One number' : `${finding.count} numbers`} that look like payment card numbers (${finding.sample}). Open Compliance › Findings to look, then resolve it or delete the file.`,
        refType: 'document', refId: docId, dedupeMinutes: 60,
      }).catch(() => {});
    }
  } catch (e) { console.error('sensitive data: could not tell the admins:', e.message); }
}

async function audit(docId, eventType, detail, actor = null) {
  try { await require('./auditLog').append({ documentId: docId, eventType, actorId: actor?.id || null, actorEmail: actor?.email || null, detail }); }
  catch (e) { console.error('sensitive data: could not record the event:', e.message); }
}

// Match what was found against what is on record for this document, for the types that
// are switched on. New: a row, a chained event and (card numbers) a word to the admins.
// Still there: the count and sample move on. Gone: the row resolves itself. Back after an
// admin resolved it: the row reopens, since the file changed and the number is still in it.
async function record(docId, findings, { name = null } = {}) {
  const types = await enabledTypes();
  const rows = await db.query('SELECT id, type, resolved_at FROM document_findings WHERE document_id = $1', [docId]);
  const have = Object.fromEntries(rows.map(r => [r.type, r]));
  const found = Object.fromEntries(findings.filter(f => types.includes(f.type)).map(f => [f.type, f]));
  for (const type of types) {
    const f = found[type], row = have[type];
    if (f && !row) {
      await db.query('INSERT INTO document_findings (document_id, type, count, sample) VALUES ($1, $2, $3, $4)', [docId, type, f.count, f.sample]);
      await audit(docId, 'sensitive_data_found', `${WORDS[type]} · ${f.count}`);
      if (type === 'card') await tellAdmins(docId, name, f);
    } else if (f && row && !row.resolved_at) {
      await db.query('UPDATE document_findings SET count = $2, sample = $3, last_seen = now() WHERE id = $1', [row.id, f.count, f.sample]);
    } else if (f && row) {
      await db.query('UPDATE document_findings SET count = $2, sample = $3, last_seen = now(), resolved_at = NULL, resolved_by = NULL, note = NULL WHERE id = $1', [row.id, f.count, f.sample]);
      await audit(docId, 'sensitive_data_found', `${WORDS[type]} · ${f.count} · found again after the file changed`);
      if (type === 'card') await tellAdmins(docId, name, f);
    } else if (!f && row && !row.resolved_at) {
      await db.query("UPDATE document_findings SET resolved_at = now(), resolved_by = 'depot', note = 'No longer in the file.' WHERE id = $1", [row.id]);
      await audit(docId, 'sensitive_data_resolved', `${WORDS[type]} · no longer in the file`);
    }
  }
  await db.query('UPDATE documents SET sensitive_checked_at = now() WHERE id = $1', [docId]);
}

// Read one document's text and record what is in it. Returns the findings.
async function scanDocument(docId, text, opts = {}) {
  const types = await enabledTypes();
  const findings = types.length ? detect(text, { types }) : [];
  await record(docId, findings, opts);
  return findings;
}

// The hook the file routes call once extracted text is stored: never throws, never waits.
// Pending work is tracked so a test (or a shutdown) can wait for it with idle().
const pending = new Set();
function check(docId, text, opts = {}) {
  if (!docId) return;
  const p = (async () => {
    await new Promise(r => setImmediate(r));
    try {
      const name = opts.name ?? (await db.queryOne('SELECT name FROM documents WHERE id = $1', [docId]))?.name ?? null;
      await scanDocument(docId, text, { name });
    } catch (e) { console.error('sensitive data check failed (non-fatal):', e.message); }
  })();
  pending.add(p);
  p.finally(() => pending.delete(p));
}
async function idle() { while (pending.size) await Promise.allSettled([...pending]); }

// ---- reading ----

const FINDING_COLUMNS = `f.id, f.document_id, f.type, f.count, f.sample, f.first_seen, f.last_seen, f.resolved_at, f.resolved_by, f.note,
  d.name AS document_name, d.library_id, d.uploaded_by_email, l.name AS library_name`;

async function list({ status = 'open', type = null, limit = 200 } = {}) {
  const where = ['d.deleted_at IS NULL'];
  const params = [];
  if (status === 'open') where.push('f.resolved_at IS NULL');
  else if (status === 'resolved') where.push('f.resolved_at IS NOT NULL');
  if (type && TYPES.includes(type)) { params.push(type); where.push(`f.type = $${params.length}`); }
  params.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
  const rows = await db.query(
    `SELECT ${FINDING_COLUMNS} FROM document_findings f
       JOIN documents d ON d.id = f.document_id
       LEFT JOIN libraries l ON l.id = d.library_id
      WHERE ${where.join(' AND ')}
      ORDER BY (f.type = 'card') DESC, f.resolved_at NULLS FIRST, f.first_seen DESC
      LIMIT $${params.length}`, params);
  return rows.map(shape);
}

function shape(r) {
  return {
    id: r.id, document_id: r.document_id, document_name: r.document_name, library_id: r.library_id, library_name: r.library_name,
    uploaded_by_email: r.uploaded_by_email, type: r.type, type_word: WORDS[r.type] || r.type, count: r.count, sample: r.sample,
    first_seen: r.first_seen, last_seen: r.last_seen, resolved_at: r.resolved_at, resolved_by: r.resolved_by, note: r.note,
  };
}

async function get(id) {
  const r = await db.queryOne(`SELECT ${FINDING_COLUMNS} FROM document_findings f JOIN documents d ON d.id = f.document_id LEFT JOIN libraries l ON l.id = d.library_id WHERE f.id = $1`, [id]);
  return r ? shape(r) : null;
}

// An admin says this finding is handled: looked at and acceptable, or the number removed.
async function resolve(id, user, note = '') {
  const row = await db.queryOne('SELECT id, document_id, type, resolved_at FROM document_findings WHERE id = $1', [id]);
  if (!row) return null;
  if (!row.resolved_at) {
    await db.query('UPDATE document_findings SET resolved_at = now(), resolved_by = $2, note = $3 WHERE id = $1', [id, user?.email || 'admin', String(note || '').slice(0, 500) || null]);
    await audit(row.document_id, 'sensitive_data_resolved', `${WORDS[row.type]}${note ? ` · ${String(note).slice(0, 200)}` : ''}`, user);
  }
  return get(id);
}

// The numbers the compliance control, the reports and the Health page quote.
async function summary() {
  const m = await modes();
  const [byType, counts, last] = await Promise.all([
    db.query(`SELECT f.type, count(*) FILTER (WHERE f.resolved_at IS NULL)::int AS open, count(*) FILTER (WHERE f.resolved_at IS NOT NULL)::int AS resolved
                FROM document_findings f JOIN documents d ON d.id = f.document_id WHERE d.deleted_at IS NULL GROUP BY f.type`),
    db.queryOne('SELECT count(*)::int AS total, count(*) FILTER (WHERE sensitive_checked_at IS NOT NULL)::int AS checked FROM documents WHERE deleted_at IS NULL'),
    db.queryOne('SELECT max(sensitive_checked_at) AS at FROM documents WHERE deleted_at IS NULL'),
  ]);
  const open = { card: 0, ssn: 0, bank: 0 }, resolved = { card: 0, ssn: 0, bank: 0 };
  for (const r of byType) { open[r.type] = r.open; resolved[r.type] = r.resolved; }
  return {
    modes: m, open, resolved,
    files_checked: counts?.checked || 0, files_total: counts?.total || 0,
    last_check_at: last?.at ? new Date(last.at).toISOString() : null,
    backfill: backfillStatus(),
  };
}

// ---- the one-time check of files that were here before this existed ----
// Batches of 100 with a pause between them, so 80,000 files go by without a load spike,
// and no restart is needed. Progress stays in memory; the finished summary is kept in
// settings (sensitive_data_backfill) so Health can say when it last ran.
const BATCH = 100, PAUSE_MS = 250;
let _backfill = { running: false, done: 0, total: 0, started_at: null, finished_at: null, error: null, by: null, all: false };
let _backfillPromise = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function backfillStatus() { return { ..._backfill }; }

async function restoreBackfillStatus() {
  if (_backfill.started_at) return;
  try {
    const saved = JSON.parse((await settings.get('sensitive_data_backfill')) || 'null');
    if (saved && typeof saved === 'object') _backfill = { ..._backfill, ...saved, running: false };
  } catch { /* none kept */ }
}

async function startBackfill({ all = false, by = null } = {}) {
  if (_backfill.running) return backfillStatus();
  const where = all ? 'deleted_at IS NULL' : 'deleted_at IS NULL AND sensitive_checked_at IS NULL';
  const total = (await db.queryOne(`SELECT count(*)::int AS n FROM documents WHERE ${where}`))?.n || 0;
  _backfill = { running: true, done: 0, total, started_at: new Date().toISOString(), finished_at: null, error: null, by, all };
  _backfillPromise = (async () => {
    try {
      if (all) await db.query('UPDATE documents SET sensitive_checked_at = NULL WHERE deleted_at IS NULL');
      for (;;) {
        const batch = await db.query('SELECT id, name, document_text FROM documents WHERE deleted_at IS NULL AND sensitive_checked_at IS NULL ORDER BY created_at LIMIT $1', [BATCH]);
        if (!batch.length) break;
        for (const d of batch) {
          try { await scanDocument(d.id, d.document_text || '', { name: d.name }); }
          catch (e) {
            console.error('sensitive data backfill: a file could not be checked:', e.message);
            await db.query('UPDATE documents SET sensitive_checked_at = now() WHERE id = $1', [d.id]).catch(() => {});
          }
          _backfill.done++;
        }
        await sleep(PAUSE_MS);
      }
    } catch (e) {
      _backfill.error = e.message;
    } finally {
      _backfill.running = false;
      _backfill.finished_at = new Date().toISOString();
      try { await settings.set('sensitive_data_backfill', JSON.stringify(_backfill), null); } catch { /* best effort */ }
    }
  })();
  return backfillStatus();
}
async function waitBackfill() { if (_backfillPromise) await _backfillPromise; }

// One line for Health (lib/health.js): null when every type is off.
async function healthLine() {
  const s = await summary();
  if (!Object.values(s.modes).includes('flag')) return null;
  return { open: s.open, files_checked: s.files_checked, files_total: s.files_total, last_check_at: s.last_check_at, backfill: s.backfill };
}

function _resetForTests() { pending.clear(); _backfill = { running: false, done: 0, total: 0, started_at: null, finished_at: null, error: null, by: null, all: false }; _backfillPromise = null; }

module.exports = {
  TYPES, SETTING_KEYS, DEFAULTS, WORDS, WORD, MAX_CHARS,
  detect, luhn, cardBrand, abaValid, validSsn, findCards, findSsns, findBank,
  modes, enabledTypes, scanDocument, record, check, idle,
  list, get, resolve, summary, healthLine,
  startBackfill, backfillStatus, waitBackfill, restoreBackfillStatus,
  _resetForTests,
};
