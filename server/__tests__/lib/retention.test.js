'use strict';
// Retention policies and legal holds (lib/retention.js) against mocked tables: what a
// policy accepts, what a hold refuses and how it says so, what the daily job notices and
// disposes of, and what every place/release writes to the hash-chained record.
jest.mock('../../lib/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), withTransaction: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async () => null), get: jest.fn(async () => null) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => ({ upload: jest.fn(async () => {}), del: jest.fn(async () => {}) }));
jest.mock('../../lib/keepMarker', () => ({ keepSharedFoldersAlive: jest.fn(async () => []) }));

const db = require('../../lib/db');
const auditLog = require('../../lib/auditLog');
const notifications = require('../../lib/notifications');
const retention = require('../../lib/retention');

const LIB = 'aaaaaaaa-0000-4000-8000-000000000001';
const DOC = 'bbbbbbbb-0000-4000-8000-000000000002';
const HOLD = 'cccccccc-0000-4000-8000-000000000003';
const ADMIN = { id: 'dddddddd-0000-4000-8000-000000000004', email: 'admin@firm.test', role: 'admin' };

beforeEach(() => jest.clearAllMocks());

describe('the SQL every route and job shares', () => {
  test('a held document: its own hold, its library held, or a folder above it held', () => {
    const sql = retention.heldSql('d');
    expect(sql).toMatch(/h\.document_id = d\.id/);
    expect(sql).toMatch(/h\.scope = 'library' AND h\.library_id = d\.library_id/);
    expect(sql).toMatch(/starts_with\(d\.name, h\.folder_path \|\| '\/'\)/);
    expect(sql).toMatch(/h\.released_at IS NULL/);   // a released hold holds nothing
  });
  test('purgeable = not held and past the library minimum', () => {
    expect(retention.purgeableSql('d')).toMatch(/^NOT EXISTS[\s\S]*legal_holds[\s\S]*AND NOT EXISTS[\s\S]*retention_min_years/);
    expect(retention.underMinimumSql('d')).toMatch(/d\.created_at > NOW\(\) - make_interval\(years => l\.retention_min_years\)/);
  });
});

describe('the policy', () => {
  const saved = (min, dispose) => ({ id: LIB, name: 'Clients', retention_min_years: min, retention_dispose_years: dispose, retention_set_at: '2026-11-03T00:00:00Z', retention_set_by_email: ADMIN.email });
  test('whole years from 1 to 100, or blank; both blank is "no policy"', async () => {
    db.queryOne.mockResolvedValueOnce(saved(3, null));
    const p = await retention.setPolicy(LIB, { min_years: '3', dispose_years: '' }, ADMIN);
    expect(p).toMatchObject({ min_years: 3, dispose_years: null, set_by: ADMIN.email });
    expect(db.queryOne.mock.calls[0][1]).toEqual([LIB, 3, null, ADMIN.email]);
    for (const bad of [{ min_years: 0 }, { min_years: 2.5 }, { min_years: 101 }, { dispose_years: -1 }, { min_years: 'three' }]) {
      await expect(retention.setPolicy(LIB, bad, ADMIN)).rejects.toMatchObject({ status: 400 });
    }
  });
  test('files cannot be disposed of before the time they must be kept', async () => {
    await expect(retention.setPolicy(LIB, { min_years: 6, dispose_years: 3 }, ADMIN)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/at least "keep at least"/) });
  });
  test('setting it is a hash-chained event that says what was set, in words', async () => {
    db.queryOne.mockResolvedValueOnce(saved(3, 7));
    await retention.setPolicy(LIB, { min_years: 3, dispose_years: 7 }, ADMIN);
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'retention_policy_set', actorEmail: ADMIN.email,
      detail: expect.stringMatching(/library .* "Clients" · keep at least 3 years; move to the trash after 7 years without changes/),
    }));
    expect(retention.describePolicy({ min_years: 1 })).toBe('keep at least 1 year');
    expect(retention.describePolicy({})).toBe('no retention policy');
  });
  test('the summary counts shared libraries only: not personal ones, not ones put away', async () => {
    db.query.mockResolvedValueOnce([
      { id: '1', name: 'Clients', personal: false, archived_at: null, retention_min_years: 3, retention_dispose_years: null, files: 10 },
      { id: '2', name: 'Payroll', personal: false, archived_at: null, retention_min_years: null, retention_dispose_years: 7, files: 2 },
      { id: '3', name: 'Old', personal: false, archived_at: '2026-01-01', retention_min_years: null, retention_dispose_years: null, files: 0 },
      { id: '4', name: 'Dave', personal: true, archived_at: null, retention_min_years: null, retention_dispose_years: null, files: 5 },
    ]);
    const s = await retention.policySummary();
    expect(s).toMatchObject({ total: 2, withMinimum: 1, withDisposal: 1, withNone: 0, missingMinimum: ['Payroll'] });
    expect(s.libraries.map(l => l.client)).toEqual([true, true, false, false]);
  });
});

describe('what a hold refuses, and how', () => {
  test('a held document: 423 LEGAL_HOLD with a plain sentence that names the way out', async () => {
    db.queryOne.mockResolvedValueOnce({ hold_id: HOLD });
    await expect(retention.assertDocumentNotHeld(db, DOC, 'deleted')).rejects.toMatchObject({ code: 'LEGAL_HOLD', status: 423, message: expect.stringMatching(/legal hold.*cannot be deleted.*administrator can release/) });
    expect(db.queryOne.mock.calls[0][0]).toMatch(/^SELECT h\.id AS hold_id FROM legal_holds h JOIN documents d/);   // reads from the holds, never like a document read
  });
  test('a document that is not held passes, and a bad id is not even asked', async () => {
    await expect(retention.assertDocumentNotHeld(db, DOC, 'deleted')).resolves.toBeUndefined();
    await expect(retention.assertDocumentNotHeld(db, 'not-a-uuid', 'deleted')).resolves.toBeUndefined();
    expect(db.queryOne).toHaveBeenCalledTimes(1);
  });
  test('a folder with held files under it: the count is in the sentence', async () => {
    db.queryOne.mockResolvedValueOnce({ held_count: 3 });
    await expect(retention.assertNothingHeldUnder(db, LIB, 'Clients/Smith', 'renamed')).rejects.toMatchObject({ code: 'LEGAL_HOLD', status: 423, message: expect.stringMatching(/3 files here are under a legal hold, so this cannot be renamed/) });
    expect(db.queryOne.mock.calls[0][1]).toEqual([LIB, 'Clients/Smith']);
  });
  test('a purge: refused while held, then refused while younger than the minimum', async () => {
    db.queryOne.mockResolvedValueOnce({ held: true, under_minimum: true, min_years: 3 });
    await expect(retention.assertPurgeAllowed(db, DOC)).rejects.toMatchObject({ code: 'LEGAL_HOLD', status: 423 });
    db.queryOne.mockResolvedValueOnce({ held: false, under_minimum: true, min_years: 3 });
    await expect(retention.assertPurgeAllowed(db, DOC)).rejects.toMatchObject({ code: 'RETENTION_MINIMUM', status: 423, message: expect.stringMatching(/at least 3 years.*stay in the Trash/) });
    db.queryOne.mockResolvedValueOnce({ held: false, under_minimum: false, min_years: 3 });
    await expect(retention.assertPurgeAllowed(db, DOC)).resolves.toBeUndefined();
  });
  test('sendRefusal answers only these two, as JSON with the code', () => {
    const res = { status: jest.fn(() => res), json: jest.fn() };
    expect(retention.sendRefusal(res, retention.holdError('moved'))).toBe(true);
    expect(res.status).toHaveBeenCalledWith(423);
    expect(res.json).toHaveBeenCalledWith({ code: 'LEGAL_HOLD', error: expect.stringMatching(/cannot be moved/) });
    expect(retention.sendRefusal(res, new Error('other'))).toBe(false);
  });
});

describe('placing and releasing a hold', () => {
  const row = (over = {}) => ({ id: HOLD, scope: 'folder', library_id: LIB, folder_path: 'Clients/Smith', document_id: null, reason: 'Smith v. Jones', placed_by: ADMIN.id, placed_by_email: ADMIN.email, placed_at: '2026-11-03T00:00:00Z', released_at: null, library_name: 'Clients', document_name: null, ...over });
  test('a folder hold needs a library, a folder and a reason; it is chained with where and why', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id: LIB, name: 'Clients' })   // the library
      .mockResolvedValueOnce(null)                           // no hold already there
      .mockResolvedValueOnce({ id: HOLD })                   // the insert
      .mockResolvedValueOnce(row());                         // read back
    const h = await retention.placeHold({ scope: 'folder', library_id: LIB, folder_path: '/Clients/Smith/', reason: 'Smith v. Jones' }, ADMIN);
    expect(h).toMatchObject({ id: HOLD, scope: 'folder', where: 'folder “Clients/Smith” in “Clients”', active: true, placed_by: ADMIN.email });
    expect(db.queryOne.mock.calls[2][1]).toEqual(['folder', LIB, 'Clients/Smith', null, 'Smith v. Jones', ADMIN.id, ADMIN.email]);
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'hold_placed', documentId: null, actorEmail: ADMIN.email, detail: expect.stringMatching(/folder “Clients\/Smith” in “Clients” · "Smith v. Jones"/) }));
    await expect(retention.placeHold({ scope: 'folder', library_id: LIB, folder_path: 'X' }, ADMIN)).rejects.toMatchObject({ status: 400 });   // no reason
    await expect(retention.placeHold({ scope: 'elsewhere', reason: 'x' }, ADMIN)).rejects.toMatchObject({ status: 400 });
  });
  test('a document hold is chained against that document; the same hold twice is a 409', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id: DOC, name: 'Clients/Smith/2024 return.pdf', library_id: LIB })
      .mockResolvedValueOnce({ id: LIB, name: 'Clients' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: HOLD })
      .mockResolvedValueOnce(row({ scope: 'document', folder_path: null, document_id: DOC, document_name: 'Clients/Smith/2024 return.pdf' }));
    const h = await retention.placeHold({ scope: 'document', document_id: DOC, reason: 'subpoena' }, ADMIN);
    expect(h.where).toBe('file “Clients/Smith/2024 return.pdf” in “Clients”');
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'hold_placed', documentId: DOC }));
    db.queryOne.mockResolvedValueOnce({ id: DOC, name: 'x', library_id: LIB }).mockResolvedValueOnce({ id: LIB, name: 'Clients' }).mockResolvedValueOnce({ id: HOLD });
    await expect(retention.placeHold({ scope: 'document', document_id: DOC, reason: 'again' }, ADMIN)).rejects.toMatchObject({ status: 409 });
  });
  test('releasing needs a note and an open hold, and is chained too', async () => {
    await expect(retention.releaseHold(HOLD, '', ADMIN)).rejects.toMatchObject({ status: 400 });
    db.queryOne.mockResolvedValueOnce(null);
    await expect(retention.releaseHold(HOLD, 'matter closed', ADMIN)).rejects.toMatchObject({ status: 404 });
    db.queryOne.mockResolvedValueOnce({ id: HOLD }).mockResolvedValueOnce(row({ released_at: '2026-12-01T00:00:00Z', released_by_email: ADMIN.email, release_note: 'matter closed' }));
    const h = await retention.releaseHold(HOLD, 'matter closed', ADMIN);
    expect(h).toMatchObject({ active: false, released_by: ADMIN.email, release_note: 'matter closed' });
    expect(db.queryOne.mock.calls[1][0]).toMatch(/WHERE id = \$1 AND released_at IS NULL/);
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'hold_released', detail: expect.stringMatching(/released · "matter closed"/) }));
  });
});

describe('the daily job', () => {
  test('a notice goes to whoever added the file, once, 30 days before the line, and is stamped', async () => {
    const due = new Date(Date.now() + 20 * 86400000).toISOString();
    db.query
      .mockResolvedValueOnce([{ id: DOC, name: 'Clients/Smith/2017 return.pdf', uploaded_by: ADMIN.id, uploaded_by_email: ADMIN.email, library_name: 'Clients', retention_dispose_years: 7, due }])
      .mockResolvedValueOnce([{ id: DOC }]);   // the stamp
    const r = await retention.noticeOnce();
    expect(r.noticed).toBe(1);
    expect(db.query.mock.calls[0][0]).toMatch(/disposal_notice_at IS NULL AND NOT EXISTS[\s\S]*legal_holds/);
    expect(db.query.mock.calls[1][0]).toMatch(/SET disposal_notice_at = NOW\(\) WHERE id = \$1 AND disposal_notice_at IS NULL/);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({
      userEmail: ADMIN.email, type: 'retention_notice', refId: DOC,
      title: expect.stringMatching(/“2017 return.pdf” will move to the Trash on/),
      body: expect.stringMatching(/7 years.*“Clients”.*can still be restored/),
    }));
  });
  test('a file stamped by someone else meanwhile gets no second notice', async () => {
    db.query.mockResolvedValueOnce([{ id: DOC, name: 'a.pdf', due: new Date().toISOString(), retention_dispose_years: 1 }]).mockResolvedValueOnce([]);
    expect((await retention.noticeOnce()).noticed).toBe(0);
    expect(notifications.create).not.toHaveBeenCalled();
  });
  test('disposal: the batch is read past the line, not held, past the minimum, noticed 30 days ago; each goes to the Trash under the library lock, chained, and announced', async () => {
    db.query.mockResolvedValueOnce([{ id: DOC, name: 'Clients/Smith/2017 return.pdf', library_id: LIB, uploaded_by: ADMIN.id, uploaded_by_email: ADMIN.email, library_name: 'Clients', retention_dispose_years: 7 }]);
    const seen = [];
    db.withTransaction.mockImplementation(async (fn) => fn({ query: async (sql, params) => {
      seen.push(sql);
      if (/^\s*(SET LOCAL|SELECT DISTINCT hashtext|SELECT pg_advisory)/i.test(sql)) return { rows: [] };
      if (/UPDATE documents d SET deleted_at = NOW\(\)/.test(sql)) { expect(params[0]).toEqual([DOC]); return { rows: [{ id: DOC, name: 'Clients/Smith/2017 return.pdf' }] }; }
      return { rows: [] };
    } }));
    const r = await retention.disposeOnce();
    expect(r.disposed).toBe(1);
    const pick = db.query.mock.calls[0][0];
    expect(pick).toMatch(/d\.disposal_notice_at IS NOT NULL AND d\.disposal_notice_at < NOW\(\) - make_interval\(days => \$1::int\)/);
    expect(pick).toMatch(/AND NOT EXISTS[\s\S]*legal_holds[\s\S]*AND NOT EXISTS[\s\S]*retention_min_years/);
    const update = seen.find(s => /UPDATE documents d SET deleted_at/.test(s));
    expect(update).toMatch(/deleted_by_email = 'system@retention'/);
    expect(update).toMatch(/legal_holds/);   // asked again under the lock: a hold placed meanwhile wins
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ documentId: DOC, eventType: 'disposed', actorEmail: 'system@retention', detail: expect.stringMatching(/retention policy of "Clients": no changes for 7 years/) }));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'retention_disposed', refId: DOC, title: '“2017 return.pdf” was moved to the Trash' }));
  });
  test('nothing due: no transaction, no events', async () => {
    const r = await retention.runOnce();
    expect(r).toEqual({ noticed: 0, disposed: 0 });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
  test('the timer is armed once and can be stopped', () => {
    const t = retention.start();
    expect(retention.start()).toBe(t);
    retention.stop();
    expect(retention.INTERVAL_HOURS).toBe(24);
    expect(retention.NOTICE_DAYS).toBe(30);
  });
});
