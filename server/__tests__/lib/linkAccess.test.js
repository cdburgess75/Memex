'use strict';
// A public link serves its files only while its creator could still publish them. The
// public routes and the lists that show a link's state all ask lib/linkAccess.
const mockActor = { value: null };
const mockDocs = { rows: [], one: null };
jest.mock('../../lib/db', () => ({ query: jest.fn(async () => mockDocs.rows), queryOne: jest.fn() }));
jest.mock('../../lib/documentAccess', () => ({
  ...jest.requireActual('../../lib/documentAccess'),
  resolveActor: jest.fn(async () => mockActor.value),
  getAccessibleDocument: jest.fn(async () => mockDocs.one),
}));
const db = require('../../lib/db');
const documentAccess = require('../../lib/documentAccess');
const { linkCreator, creatorCanPublish, servableDocs } = require('../../lib/linkAccess');

beforeEach(() => { jest.clearAllMocks(); mockActor.value = null; mockDocs.rows = []; mockDocs.one = null; });

test.each([['admin', true], ['contributor', true], ['viewer', false], ['', false]])('a %p creator may publish: %p', async (role, ok) => {
  mockActor.value = { id: 'c1', role, email: 'c@x.com', emailVerified: true };
  expect(!!(await linkCreator('c1'))).toBe(ok);
});

test('a missing creator publishes nothing', async () => {
  expect(await linkCreator('gone')).toBeNull();
  expect(await creatorCanPublish('gone', 'd1')).toBeNull();
  expect(await servableDocs('gone', ['d1'])).toEqual({ creator: null, docs: [] });
  expect(db.query).not.toHaveBeenCalled();
});

test("a file link lives while its creator can still edit the file, checked live", async () => {
  mockActor.value = { id: 'c1', role: 'contributor', email: 'c@x.com', emailVerified: true };
  mockDocs.one = { id: 'd1' };
  expect(await creatorCanPublish('c1', 'd1')).toEqual(mockActor.value);
  expect(documentAccess.getAccessibleDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1', required: 'write', deleted: 'active' }));
  mockDocs.one = null;
  expect(await creatorCanPublish('c1', 'd1')).toBeNull();
});

test("a folder link serves only snapshot files its creator can still edit, not in Trash", async () => {
  mockActor.value = { id: 'c1', role: 'contributor', email: 'c@x.com', emailVerified: true };
  mockDocs.rows = [{ id: 'd1' }];
  const r = await servableDocs('c1', ['d1', 'd2'], 'd.id, d.name');
  expect(r.docs).toEqual([{ id: 'd1' }]);
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(/SELECT d\.id, d\.name FROM documents d/);
  expect(sql).toMatch(/d\.deleted_at IS NULL AND/);
  expect(sql).toContain(documentAccess.condition('d', 2));
  expect(params).toEqual([['d1', 'd2'], ...documentAccess.userParams(mockActor.value, 'write')]);
});
