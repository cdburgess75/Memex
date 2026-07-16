'use strict';
jest.mock('../../lib/db', () => ({ query: jest.fn() }));
jest.mock('../../lib/storage', () => ({ del: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));

const db = require('../../lib/db');
const storage = require('../../lib/storage');
const settings = require('../../lib/settings');
const { pruneOldVersions, maxDocumentVersions } = require('../../lib/documentVersions');

beforeEach(() => { jest.clearAllMocks(); });

describe('pruneOldVersions', () => {
  test('deletes versions beyond the newest N, blob and row', async () => {
    settings.getOrEnv.mockResolvedValue('2'); // keep newest 2
    db.query.mockImplementation((sql) => {
      if (sql.includes('ORDER BY version_number DESC OFFSET')) {
        return Promise.resolve([
          { id: 'v1', storage_path: 'versions/d/0001-x' },
          { id: 'v2', storage_path: 'versions/d/0002-x' },
        ]);
      }
      return Promise.resolve(undefined); // DELETE
    });

    const r = await pruneOldVersions('doc-1');

    expect(r.deleted).toBe(2);
    expect(storage.del).toHaveBeenCalledWith('versions/d/0001-x');
    expect(storage.del).toHaveBeenCalledWith('versions/d/0002-x');
    expect(db.query).toHaveBeenCalledWith('DELETE FROM document_versions WHERE id = $1', ['v1']);
    expect(db.query).toHaveBeenCalledWith('DELETE FROM document_versions WHERE id = $1', ['v2']);
  });

  test('unlimited (0) prunes nothing and issues no queries', async () => {
    settings.getOrEnv.mockResolvedValue('0');
    const r = await pruneOldVersions('doc-1');
    expect(r.deleted).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
    expect(storage.del).not.toHaveBeenCalled();
  });

  test('defaults to keeping 25 when unset', async () => {
    settings.getOrEnv.mockResolvedValue(null);
    expect(await maxDocumentVersions()).toBe(25);
  });
});
