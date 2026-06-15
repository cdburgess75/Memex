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
  access._resetForTests();
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
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS document_acl'));
    expect(db.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM documents d'),
      ['doc-1', 'contributor', user.id, user.id, 'user@test.com', ['read', 'write', 'admin']]
    );
    expect(db.queryOne.mock.calls[0][0]).toContain('FROM document_acl da');
  });

  test('grantOwnerAdmin upserts an owner admin grant', async () => {
    await access.grantOwnerAdmin('doc-1', user);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS document_acl'));
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO document_acl'),
      ['doc-1', user.id, 'user@test.com']
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
