'use strict';

jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
}));

const db = require('../../lib/db');
const access = require('../../lib/documentAccess');

const user = {
  id: '810da857-4296-473f-99e9-96f2a5ebd47e',
  email: 'user@test.com',
  role: 'contributor',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('documentAccess', () => {
  test('maps required permissions to accepted grants', () => {
    expect(access.permissionsFor('read')).toEqual(['read', 'write', 'admin']);
    expect(access.permissionsFor('write')).toEqual(['write', 'admin']);
    expect(access.permissionsFor('admin')).toEqual(['admin']);
  });

  test('builds stable user params for SQL access checks', () => {
    expect(access.userParams(user, 'write')).toEqual([
      'contributor',
      user.id,
      user.id,
      'user@test.com',
      ['write', 'admin'],
    ]);
  });

  test('getAccessibleDocument scopes lookup through owner/admin/ACL condition', async () => {
    db.queryOne.mockResolvedValueOnce({ id: 'doc-1' });

    const doc = await access.getAccessibleDocument({
      id: 'doc-1',
      user,
      required: 'read',
      columns: 'd.id',
    });

    expect(doc).toEqual({ id: 'doc-1' });
    // Schema comes from migrations (0004), not lazy runtime DDL.
    expect(db.query).not.toHaveBeenCalled();
    expect(db.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM documents d'),
      ['doc-1', 'contributor', user.id, user.id, 'user@test.com', ['read', 'write', 'admin']]
    );
    expect(db.queryOne.mock.calls[0][0]).toContain('FROM document_acl da');
  });

  // The org-shared clause reads only d.library_id and takes no bind parameter, so
  // all 18 call sites keep their startIndex and parameter arrays. If someone gives
  // it a parameter, every one of those call sites silently misaligns and starts
  // comparing the wrong values — these two tests are the guard against that.
  test('condition grants access to any document in an org-shared library', () => {
    const sql = access.condition('d', 1);
    expect(sql).toContain('FROM libraries lib');
    expect(sql).toContain('lib.id = d.library_id');
    expect(sql).toContain('lib.org_shared');
  });

  test('condition uses no bind parameter beyond the five userParams supplies', () => {
    for (const start of [1, 2, 3, 4, 6]) {
      const sql = access.condition('d', start);
      const used = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])).sort((a, b) => a - b);
      // exactly $start..$start+4, each once, and nothing higher
      expect(used).toEqual([start, start + 1, start + 2, start + 3, start + 4]);
    }
  });

  test('condition honours the alias for both the ACL and the library clause', () => {
    const sql = access.condition('documents', 2);
    expect(sql).toContain('lib.id = documents.library_id');
    expect(sql).toContain('da.document_id = documents.id');
  });

  test('grantOwnerAdmin upserts an owner admin grant', async () => {
    await access.grantOwnerAdmin('doc-1', user);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO document_acl'),
      ['doc-1', user.id, 'user@test.com', user.id]
    );
  });

  test('grantUserAccess validates and upserts email grants', async () => {
    db.queryOne.mockResolvedValueOnce({ id: 'grant-1', subject_email: 'reader@test.com', permission: 'read' });

    const grant = await access.grantUserAccess('doc-1', {
      email: ' Reader@Test.com ',
      permission: 'read',
      grantedBy: user,
    });

    expect(grant.id).toBe('grant-1');
    expect(db.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO document_acl'),
      ['doc-1', 'reader@test.com', 'read', user.id, 'user@test.com']
    );
  });

  test('grantUserAccess rejects invalid input', async () => {
    await expect(access.grantUserAccess('doc-1', { email: 'nope', permission: 'read', grantedBy: user }))
      .rejects.toThrow(/Valid user email/);
    await expect(access.grantUserAccess('doc-1', { email: 'reader@test.com', permission: 'owner', grantedBy: user }))
      .rejects.toThrow(/Permission/);
  });

  test('revokeUserAccess deletes one grant by document and grant id', async () => {
    db.queryOne.mockResolvedValueOnce({ id: 'grant-1' });

    const grant = await access.revokeUserAccess('doc-1', 'grant-1');

    expect(grant.id).toBe('grant-1');
    expect(db.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM document_acl'),
      ['doc-1', 'grant-1']
    );
  });
});
