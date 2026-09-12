'use strict';
// A byte-identical re-upload is folded into an existing document only where the
// uploader could EDIT that document: folding is a change to it.
jest.mock('../../lib/db', () => {
  const api = { query: jest.fn().mockResolvedValue([]), queryOne: jest.fn() };
  // The row goes in under the library's tree lock, inside one transaction; the stand-in
  // hands the callback a client backed by the same mocks (a pg client answers { rows }).
  // The lock's own plumbing (lib/folderLocks) is answered here rather than by the mocks,
  // which queue their rows in order.
  api.withTransaction = jest.fn(async (fn) => fn({ query: async (sql, params = []) => {
    if (/^\s*(SET LOCAL|SELECT DISTINCT hashtext|SELECT pg_advisory)/i.test(sql)) return { rows: [] };
    const one = await api.queryOne(sql, params);
    return { rows: one ? [one] : [] };
  } }));
  return api;
});
jest.mock('../../lib/storage', () => ({ download: jest.fn().mockResolvedValue(Buffer.from('same bytes')), del: jest.fn().mockResolvedValue() }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn().mockResolvedValue('same bytes') }));
jest.mock('../../lib/libraries', () => ({ defaultLibraryId: jest.fn().mockResolvedValue('lib-1') }));
jest.mock('../../lib/fileEvents', () => ({ logEvent: jest.fn().mockResolvedValue(), logDocumentEvent: jest.fn().mockResolvedValue() }));
const db = require('../../lib/db');
const { createDocumentRecord } = require('../../lib/documents');

test('the dedupe lookup requires write on the existing document', async () => {
  db.queryOne.mockResolvedValueOnce({ id: 'existing' });
  const r = await createDocumentRecord({ displayName: 'a.txt', storagePath: 'p', mimetype: 'text/plain', storedSize: 10, user: { id: 'u1', email: 'u@x.com', role: 'contributor' }, sourceDetail: 't', libraryId: 'lib-1' });
  expect(r.deduped).toBe(true);
  const [sql, params] = db.queryOne.mock.calls[0];
  expect(sql).toMatch(/d\.content_hash = \$1/);
  expect(params[7]).toEqual(['write', 'admin']);
});

test.each([[true], [false]])('it only folds into a file of the same kind (library content %p)', async (scoped) => {
  db.queryOne.mockClear();
  db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'new' });
  await createDocumentRecord({ displayName: 'a.txt', storagePath: 'p', mimetype: 'text/plain', storedSize: 10, user: { id: 'u1', email: 'u@x.com', role: 'contributor' }, sourceDetail: 't', libraryId: 'lib-1', libraryScoped: scoped });
  const [sql, params] = db.queryOne.mock.calls[0];
  expect(sql).toMatch(/AND d\.library_scoped = \$9/);
  expect(params[8]).toBe(scoped);
});
