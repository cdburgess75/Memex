'use strict';
// Past compliance reports and the schedule that produces them. A report is one
// framework's printable HTML (lib/evidence.js toReportHtml) kept whole in
// compliance_reports, so it can be fetched again as it was on the day. The scheduler
// is modelled on lib/backup.js: one timer, re-armed after each run and whenever the
// settings change, running one report per tracked framework and emailing them when
// addresses are set and email is configured.
const db = require('./db');
const settings = require('./settings');
const compliance = require('./compliance');
const evidence = require('./evidence');

const SCHEDULES = ['off', 'monthly', 'quarterly'];
const COLUMNS = 'id, framework, generated_at, generated_by, status, ready, total';

let _timer = null;
let _running = false;

// Build one framework's report from the live bundle and keep it. `by` is the
// administrator's address, or 'schedule'. Returns the row without its HTML.
async function generate(frameworkId, by, bundle) {
  const b = bundle || await evidence.build();
  const fw = (b.frameworks || []).find(f => f.id === frameworkId);
  if (!fw) throw new Error(`No such framework: ${frameworkId}`);
  const html = evidence.toReportHtml(b, frameworkId);
  const total = (fw.controls || []).length;
  const ready = (fw.controls || []).filter(c => c.ready === true).length;
  const status = ready === total ? 'ready' : 'to do';
  const row = await db.queryOne(
    `INSERT INTO compliance_reports (framework, generated_at, generated_by, status, ready, total, html)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
    [frameworkId, b.generatedAt, String(by || 'schedule'), status, ready, total, html]
  );
  return shape(row, b.firm?.name);
}

function shape(row, firmName) {
  if (!row) return null;
  const at = row.generated_at instanceof Date ? row.generated_at.toISOString() : String(row.generated_at);
  return {
    id: String(row.id), framework: row.framework, generated_at: at, generated_by: row.generated_by,
    status: row.status, ready: row.ready, total: row.total,
    file_name: evidence.reportFileName(firmName, row.framework, at),
  };
}

async function firmName() {
  try { return (await settings.getOrEnv('brand_name')) || ''; } catch { return ''; }
}

// Newest first.
async function list({ limit = 100 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = await db.query(`SELECT ${COLUMNS} FROM compliance_reports ORDER BY generated_at DESC, id DESC LIMIT ${n}`);
  const firm = await firmName();
  return rows.map(r => shape(r, firm));
}

// One report with its HTML, or null.
async function get(id) {
  if (!/^\d+$/.test(String(id || ''))) return null;
  const row = await db.queryOne(`SELECT ${COLUMNS}, html FROM compliance_reports WHERE id = $1`, [id]);
  if (!row) return null;
  return { ...shape(row, await firmName()), html: row.html };
}

// ---- schedule ----
function parseSchedule(raw) {
  const v = String(raw || 'off').trim().toLowerCase();
  return SCHEDULES.includes(v) ? v : 'off';
}
function parseRecipients(raw) {
  return String(raw || '').split(/[,\s;]+/).map(s => s.trim().toLowerCase()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

// When the next scheduled run is due: the first day of the month (or quarter) after
// the last run, at 06:00 server time; with no run yet, now, so turning the schedule on
// produces a first report straight away. All in local time, like the office's calendar.
function nextRun(lastRun, schedule, now = Date.now()) {
  if (schedule === 'off') return null;
  if (!lastRun) return now;
  const d = new Date(lastRun);
  const step = schedule === 'quarterly' ? 3 : 1;
  const month = Math.floor(d.getMonth() / step) * step + step;
  return new Date(d.getFullYear(), month, 1, 6, 0, 0, 0).getTime();
}

async function status() {
  const schedule = parseSchedule(await settings.getOrEnv('compliance_report_schedule'));
  const email = String((await settings.getOrEnv('compliance_report_email')) || '');
  const lastRaw = await settings.get('compliance_report_last_run');
  const lastRun = lastRaw ? Number(lastRaw) : null;
  return { schedule, email, lastRun, nextRun: nextRun(lastRun, schedule), running: _running };
}

// One scheduled run: a report for every tracked framework, mailed as attachments when
// addresses are set and email is configured (silently skipped otherwise). Never throws.
async function runScheduled({ now = Date.now() } = {}) {
  if (_running) return { ran: false, reason: 'running' };
  _running = true;
  try {
    const bundle = await evidence.build();
    const tracked = (bundle.frameworks || []).filter(f => f.enabled);
    const reports = [];
    const attachments = [];
    for (const fw of tracked) {
      try {
        const r = await generate(fw.id, 'schedule', bundle);
        reports.push(r);
        attachments.push({ filename: r.file_name, contentType: 'text/html', content: evidence.toReportHtml(bundle, fw.id) });
      } catch (e) { console.error(`[compliance] scheduled ${fw.id} report failed:`, e.message); }
    }
    let mailed = 0;
    const to = parseRecipients(await settings.getOrEnv('compliance_report_email'));
    if (reports.length && to.length) {
      const email = require('./email');
      if (await email.isConfigured()) {
        const firm = (await firmName()) || 'Depot';
        const day = new Date(now).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const names = reports.map(r => `${r.framework}: ${r.status === 'ready' ? 'ready' : `${r.total - r.ready} to do`}`).join('; ');
        for (const addr of to) {
          const r = await email.sendMail({
            to: addr,
            subject: `${firm}: compliance reports for ${day}`,
            text: `Attached are the compliance reports Depot produced on ${day} (${names}). Open each one in a browser and print to PDF for your records.`,
            attachments,
          });
          if (r?.sent) mailed++;
        }
      }
    }
    await settings.set('compliance_report_last_run', String(now)).catch(() => {});
    return { ran: true, reports, mailed };
  } catch (e) {
    console.error('[compliance] scheduled run failed:', e.message);
    return { ran: false, reason: e.message };
  } finally {
    _running = false;
  }
}

async function reschedule() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  const st = await status();
  if (st.schedule === 'off') return null;
  let delay = st.nextRun - Date.now();
  if (delay < 0) delay = 60000;            // overdue → run shortly after boot
  delay = Math.min(delay, 2_000_000_000);  // setTimeout 32-bit safety
  _timer = setTimeout(async () => {
    await runScheduled();
    reschedule();
  }, delay);
  _timer.unref?.();
  return delay;
}

function stop() { if (_timer) { clearTimeout(_timer); _timer = null; } }

module.exports = { SCHEDULES, generate, list, get, status, nextRun, parseSchedule, parseRecipients, runScheduled, reschedule, stop };
