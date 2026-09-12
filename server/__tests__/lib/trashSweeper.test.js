'use strict';
jest.mock('../../lib/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../lib/storage', () => ({ del: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));

const db = require('../../lib/db');
const storage = require('../../lib/storage');
const auditLog = require('../../lib/auditLog');
const trashSweeper = require('../../lib/trashSweeper');

beforeEach(() => { jest.clearAllMocks(); });

describe('trashSweeper.sweepOnce', () => {
  // The whole purge is one transaction now: version objects read, row deleted while it is
  // still expired, and only then the objects removed.
  const oneClient = (deleted) => {
    const seen = [];
    db.withTransaction.mockImplementation(async (fn) => fn({
      query: async (sql, params) => {
        seen.push({ sql, params });
        if (/FROM document_versions/.test(sql)) return { rows: [{ storage_path: 'versions/d1/0001' }, { storage_path: 'versions/d1/0002' }] };
        if (/^\s*DELETE FROM documents/.test(sql)) return { rows: deleted ? [{ storage_path: 'documents/d1' }] : [] };
        return { rows: [] };
      },
    }));
    return seen;
  };

  test('hard-deletes expired documents with their main + version blobs and audits it', async () => {
    db.query.mockResolvedValue([{ id: 'd1', name: 'old.pdf', storage_path: 'documents/d1' }]);
    const seen = oneClient(true);

    const r = await trashSweeper.sweepOnce({ days: 30 });

    expect(r.documentsPurged).toBe(1);
    expect(r.blobsDeleted).toBe(3); // two version blobs + one main blob
    expect(storage.del).toHaveBeenCalledWith('documents/d1');
    expect(storage.del).toHaveBeenCalledWith('versions/d1/0001');
    // the versions are read before the row goes, or nothing would point at their objects
    const order = seen.map(x => (/document_versions/.test(x.sql) ? 'versions' : 'delete'));
    expect(order).toEqual(['versions', 'delete']);
    expect(seen[1].sql).toMatch(/deleted_at IS NOT NULL AND deleted_at < NOW\(\) - make_interval/);
    expect(auditLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'purged', documentId: 'd1', actorEmail: 'system@retention' })
    );
  });

  test('a document restored between the scan and the purge is left alone, objects and all', async () => {
    db.query.mockResolvedValue([{ id: 'd1', name: 'old.pdf', storage_path: 'documents/d1' }]);
    oneClient(false);   // the conditional DELETE matches nothing: it is live again

    const r = await trashSweeper.sweepOnce({ days: 30 });

    expect([r.documentsPurged, r.blobsDeleted]).toEqual([0, 0]);
    expect(storage.del).not.toHaveBeenCalled();
    expect(auditLog.append).not.toHaveBeenCalled();
  });

  test('retention 0 disables the sweep entirely', async () => {
    const r = await trashSweeper.sweepOnce({ days: 0 });
    expect(r.documentsPurged).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
    expect(storage.del).not.toHaveBeenCalled();
  });
});
