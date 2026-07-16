'use strict';
jest.mock('../../lib/db', () => ({ query: jest.fn() }));
jest.mock('../../lib/storage', () => ({ del: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));

const db = require('../../lib/db');
const storage = require('../../lib/storage');
const auditLog = require('../../lib/auditLog');
const trashSweeper = require('../../lib/trashSweeper');

beforeEach(() => { jest.clearAllMocks(); });

describe('trashSweeper.sweepOnce', () => {
  test('hard-deletes expired documents with their main + version blobs and audits it', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM documents') && sql.includes('deleted_at')) {
        return Promise.resolve([{ id: 'd1', name: 'old.pdf', storage_path: 'documents/d1' }]);
      }
      if (sql.includes('FROM document_versions')) {
        return Promise.resolve([{ storage_path: 'versions/d1/0001' }, { storage_path: 'versions/d1/0002' }]);
      }
      return Promise.resolve(undefined); // DELETE
    });

    const r = await trashSweeper.sweepOnce({ days: 30 });

    expect(r.documentsPurged).toBe(1);
    expect(r.blobsDeleted).toBe(3); // two version blobs + one main blob
    expect(storage.del).toHaveBeenCalledWith('documents/d1');
    expect(storage.del).toHaveBeenCalledWith('versions/d1/0001');
    expect(db.query).toHaveBeenCalledWith('DELETE FROM documents WHERE id = $1', ['d1']);
    expect(auditLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'purged', documentId: 'd1', actorEmail: 'system@retention' })
    );
  });

  test('retention 0 disables the sweep entirely', async () => {
    const r = await trashSweeper.sweepOnce({ days: 0 });
    expect(r.documentsPurged).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
    expect(storage.del).not.toHaveBeenCalled();
  });
});
