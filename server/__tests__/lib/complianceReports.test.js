'use strict';
// Past reports and the schedule: a report is kept whole, listed newest first, and the
// timer lands on the first of the next month or quarter.
jest.mock('../../lib/db', () => ({ query: jest.fn().mockResolvedValue([]), queryOne: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn().mockResolvedValue(null), get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../lib/email', () => ({ isConfigured: jest.fn().mockResolvedValue(false), sendMail: jest.fn().mockResolvedValue({ sent: true }) }));
const BUNDLE = {
  generatedAt: '2026-11-03T12:00:00.000Z', version: 'v1', firm: { name: 'Bayou Tax & Books', hostname: 'd.test' }, settings: {},
  frameworks: [
    { id: 'safeguards', name: 'FTC Safeguards Rule', short: 'Safeguards', enabled: true, controls: [{ id: 'mfa', label: 'MFA', ready: true, evidence: 'e' }, { id: 'wisp', label: 'WISP', ready: false, evidence: 'e', gap: 'g', manual: true }] },
    { id: 'hipaa', name: 'HIPAA', short: 'HIPAA', enabled: true, controls: [{ id: 'mfa', label: 'MFA', ready: true, evidence: 'e' }] },
    { id: 'soc2', name: 'SOC 2', short: 'SOC 2', enabled: false, controls: [] },
  ],
  accessReview: { users: [], userCount: 0 }, auditIntegrity: { ok: true, count: 0 },
};
jest.mock('../../lib/evidence', () => ({
  build: jest.fn(async () => BUNDLE),
  toReportHtml: jest.fn((b, id) => `<html>${id} report</html>`),
  reportFileName: (firm, fw, iso) => `${String(firm || 'depot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${fw}-report-${iso.slice(0, 10)}.html`,
}));

const db = require('../../lib/db');
const settings = require('../../lib/settings');
const email = require('../../lib/email');
const reports = require('../../lib/complianceReports');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue([]);
  settings.getOrEnv.mockResolvedValue(null);
  settings.get.mockResolvedValue(null);
  email.isConfigured.mockResolvedValue(false);
  db.queryOne.mockImplementation(async (sql, params) => ({ id: 42, framework: params[0], generated_at: new Date(params[1]), generated_by: params[2], status: params[3], ready: params[4], total: params[5] }));
});

describe('generate', () => {
  test('stores the framework, who asked, the count, and the HTML; answers without the HTML', async () => {
    const r = await reports.generate('safeguards', 'ann@x.com');
    expect(db.queryOne).toHaveBeenCalledTimes(1);
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO compliance_reports/);
    expect(params).toEqual(['safeguards', '2026-11-03T12:00:00.000Z', 'ann@x.com', 'to do', 1, 2, '<html>safeguards report</html>']);
    expect(r).toEqual({ id: '42', framework: 'safeguards', generated_at: '2026-11-03T12:00:00.000Z', generated_by: 'ann@x.com', status: 'to do', ready: 1, total: 2, file_name: 'bayou-tax-books-safeguards-report-2026-11-03.html' });
    expect(r.html).toBeUndefined();
  });
  test('"ready" when everything is met; refuses a framework that does not exist', async () => {
    expect((await reports.generate('hipaa', 'ann@x.com')).status).toBe('ready');
    await expect(reports.generate('nope', 'ann@x.com')).rejects.toThrow(/No such framework/);
  });
});

describe('list and get', () => {
  test('list is newest first and carries each file name', async () => {
    settings.getOrEnv.mockImplementation(async k => (k === 'brand_name' ? 'Bayou Tax & Books' : null));
    db.query.mockResolvedValue([{ id: 2, framework: 'hipaa', generated_at: new Date('2026-11-01T06:00:00Z'), generated_by: 'schedule', status: 'ready', ready: 3, total: 3 }]);
    const l = await reports.list();
    expect(db.query.mock.calls[0][0]).toMatch(/ORDER BY generated_at DESC, id DESC LIMIT 100/);
    expect(db.query.mock.calls[0][0]).not.toMatch(/html/);   // the list never drags the HTML along
    expect(l).toEqual([{ id: '2', framework: 'hipaa', generated_at: '2026-11-01T06:00:00.000Z', generated_by: 'schedule', status: 'ready', ready: 3, total: 3, file_name: 'bayou-tax-books-hipaa-report-2026-11-01.html' }]);
  });
  test('get returns the HTML, and null for an id that is not a number', async () => {
    db.queryOne.mockResolvedValue({ id: 2, framework: 'hipaa', generated_at: new Date('2026-11-01T06:00:00Z'), generated_by: 'schedule', status: 'ready', ready: 3, total: 3, html: '<html>kept</html>' });
    expect((await reports.get('2')).html).toBe('<html>kept</html>');
    expect(await reports.get('2; DROP TABLE')).toBeNull();
    expect(db.queryOne).toHaveBeenCalledTimes(1);
  });
});

describe('nextRun', () => {
  const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime();
  test('monthly: the first of the next month at 06:00, local time', () => {
    expect(reports.nextRun(at(2026, 11, 3, 9), 'monthly')).toBe(at(2026, 12, 1, 6));
    expect(reports.nextRun(at(2026, 12, 31, 23), 'monthly')).toBe(at(2027, 1, 1, 6));
  });
  test('quarterly: the first of the next quarter', () => {
    expect(reports.nextRun(at(2026, 11, 3), 'quarterly')).toBe(at(2027, 1, 1, 6));
    expect(reports.nextRun(at(2026, 1, 1, 6), 'quarterly')).toBe(at(2026, 4, 1, 6));
    expect(reports.nextRun(at(2026, 6, 30), 'quarterly')).toBe(at(2026, 7, 1, 6));
  });
  test('off is never; a schedule that has never run is due now', () => {
    expect(reports.nextRun(at(2026, 11, 3), 'off')).toBeNull();
    expect(reports.nextRun(null, 'monthly', 123)).toBe(123);
  });
  test('parseSchedule and parseRecipients are forgiving', () => {
    expect(reports.parseSchedule(' Monthly ')).toBe('monthly');
    expect(reports.parseSchedule('weekly')).toBe('off');
    expect(reports.parseRecipients('Owner@Firm.com, it@provider.com; not-an-address')).toEqual(['owner@firm.com', 'it@provider.com']);
  });
});

describe('runScheduled', () => {
  test('one report per TRACKED framework, by "schedule", and the last run is recorded', async () => {
    const r = await reports.runScheduled({ now: 1700000000000 });
    expect(r.ran).toBe(true);
    expect(db.queryOne.mock.calls.map(c => c[1].slice(0, 3))).toEqual([
      ['safeguards', '2026-11-03T12:00:00.000Z', 'schedule'], ['hipaa', '2026-11-03T12:00:00.000Z', 'schedule']]);
    expect(settings.set).toHaveBeenCalledWith('compliance_report_last_run', '1700000000000');
    expect(email.sendMail).not.toHaveBeenCalled();
  });
  test('emails the reports as attachments to each address when email is configured', async () => {
    settings.getOrEnv.mockImplementation(async k => ({ compliance_report_email: 'owner@x.com, it@y.com', brand_name: 'Clinic' }[k] ?? null));
    email.isConfigured.mockResolvedValue(true);
    const r = await reports.runScheduled();
    expect(r.mailed).toBe(2);
    expect(email.sendMail).toHaveBeenCalledTimes(2);
    const m = email.sendMail.mock.calls[0][0];
    expect(m.to).toBe('owner@x.com');
    expect(m.subject).toMatch(/^Clinic: compliance reports for /);
    // named for the firm as the bundle saw it, the same name the archive row carries
    expect(m.attachments.map(a => a.filename)).toEqual(['bayou-tax-books-safeguards-report-2026-11-03.html', 'bayou-tax-books-hipaa-report-2026-11-03.html']);
    expect(m.attachments[0].contentType).toBe('text/html');
  });
  test('skips mail quietly when addresses are set but email is not configured', async () => {
    settings.getOrEnv.mockImplementation(async k => (k === 'compliance_report_email' ? 'owner@x.com' : null));
    const r = await reports.runScheduled();
    expect(r.ran).toBe(true);
    expect(r.mailed).toBe(0);
    expect(email.sendMail).not.toHaveBeenCalled();
  });
});

describe('reschedule', () => {
  afterEach(() => reports.stop());
  test('no timer when off; otherwise a delay to the next run', async () => {
    expect(await reports.reschedule()).toBeNull();
    settings.getOrEnv.mockImplementation(async k => (k === 'compliance_report_schedule' ? 'monthly' : null));
    settings.get.mockImplementation(async k => (k === 'compliance_report_last_run' ? String(Date.now()) : null));
    const delay = await reports.reschedule();
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(31 * 86400000);
  });
});
