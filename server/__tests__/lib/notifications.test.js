'use strict';
jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../lib/profiles', () => ({
  ensureProfiles: jest.fn().mockResolvedValue(),
  setProfile: jest.fn().mockResolvedValue({}),
}));

const db = require('../../lib/db');
const notif = require('../../lib/notifications');

const user = { id: '810da857-4296-473f-99e9-96f2a5ebd47e', email: 'Me@Test.com' };

beforeEach(() => {
  notif._resetForTests();
  db.query.mockReset(); db.query.mockResolvedValue([]);
  db.queryOne.mockReset(); db.queryOne.mockResolvedValue(null);
});

describe('ensureTable', () => {
  test('creates the table, indexes, and the opt-out column', async () => {
    await notif.ensureTable();
    const sql = db.query.mock.calls.map(c => c[0]).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS notifications');
    expect(sql).toContain('ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS notifications_enabled');
  });
});

describe('create', () => {
  test('inserts for an enabled recipient, lowercasing the email', async () => {
    db.queryOne.mockResolvedValueOnce(null);            // enabledForEmail: no profile row → enabled
    db.queryOne.mockResolvedValueOnce({ id: 'n1' });    // the INSERT ... RETURNING
    const r = await notif.create({ userEmail: 'Grantee@Test.com', type: 'share_granted', title: 'x', refType: 'document', refId: 'doc1' });
    const insert = db.queryOne.mock.calls.find(c => /INSERT INTO notifications/.test(c[0]));
    expect(insert).toBeTruthy();
    expect(insert[1][1]).toBe('grantee@test.com'); // user_email lowercased
    expect(insert[1][2]).toBe('share_granted');    // type
    expect(insert[1][6]).toBe('doc1');             // ref_id
    expect(r).toEqual({ id: 'n1' });
  });

  test('is a no-op when the recipient opted out', async () => {
    db.queryOne.mockResolvedValueOnce({ notifications_enabled: false }); // enabledForEmail
    const r = await notif.create({ userEmail: 'off@test.com', type: 'share_granted', title: 'x' });
    expect(r).toBeNull();
    expect(db.queryOne.mock.calls.some(c => /INSERT INTO notifications/.test(c[0]))).toBe(false);
  });

  test('dedupeMinutes skips creation when a matching recent notification exists', async () => {
    db.queryOne.mockResolvedValueOnce(null);                 // enabledForEmail → enabled
    db.queryOne.mockResolvedValueOnce({ id: 'existing' });   // dedupe lookup finds a recent one
    const r = await notif.create({ userEmail: 'owner@test.com', type: 'document_edited', title: 'x', refId: 'doc1', dedupeMinutes: 30 });
    expect(r).toBeNull();
    expect(db.queryOne.mock.calls.some(c => /INSERT INTO notifications/.test(c[0]))).toBe(false);
    const dedupe = db.queryOne.mock.calls.find(c => /created_at > NOW\(\) - /.test(c[0]));
    expect(dedupe[1]).toEqual(['document_edited', 'doc1', null, 'owner@test.com', '30']);
  });

  test('dedupeMinutes still creates when no recent match exists', async () => {
    db.queryOne.mockResolvedValueOnce(null);               // enabledForEmail
    db.queryOne.mockResolvedValueOnce(null);               // dedupe lookup: none found
    db.queryOne.mockResolvedValueOnce({ id: 'new' });      // INSERT
    const r = await notif.create({ userEmail: 'owner@test.com', type: 'document_edited', title: 'x', refId: 'doc1', dedupeMinutes: 30 });
    expect(r).toEqual({ id: 'new' });
    expect(db.queryOne.mock.calls.some(c => /INSERT INTO notifications/.test(c[0]))).toBe(true);
  });
});

describe('listing / counts / marking', () => {
  test('listForUser matches by user_id OR email', async () => {
    await notif.listForUser(user, 50);
    const call = db.query.mock.calls.find(c => /FROM notifications/.test(c[0]) && /ORDER BY created_at/.test(c[0]));
    expect(call[0]).toContain('user_id = $1 OR lower(user_email) = lower($2)');
    expect(call[1]).toEqual([user.id, user.email]);
  });

  test('unreadCount filters read_at IS NULL and returns a number', async () => {
    db.queryOne.mockResolvedValue({ n: 3 });
    expect(await notif.unreadCount(user)).toBe(3);
    const call = db.queryOne.mock.calls.find(c => /COUNT\(\*\)/.test(c[0]));
    expect(call[0]).toContain('read_at IS NULL');
  });

  test('markRead updates the given ids for this recipient', async () => {
    db.query.mockResolvedValue([{ id: 'a' }]);
    expect(await notif.markRead(user, ['a', 'b'])).toBe(1);
    const call = db.query.mock.calls.find(c => /UPDATE notifications SET read_at/.test(c[0]) && /ANY\(\$1/.test(c[0]));
    expect(call[1][0]).toEqual(['a', 'b']);
  });

  test('markRead with no ids is a no-op (no db write)', async () => {
    expect(await notif.markRead(user, [])).toBe(0);
    expect(db.query.mock.calls.some(c => /UPDATE notifications/.test(c[0]))).toBe(false);
  });

  test('markAllRead updates all unread for the recipient', async () => {
    db.query.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    expect(await notif.markAllRead(user)).toBe(2);
  });
});

describe('preferences', () => {
  test('getPref defaults to true when no profile row', async () => {
    db.queryOne.mockResolvedValue(null);
    expect(await notif.getPref(user)).toBe(true);
  });

  test('getPref reflects an explicit opt-out', async () => {
    db.queryOne.mockResolvedValue({ notifications_enabled: false });
    expect(await notif.getPref(user)).toBe(false);
  });

  test('setPref writes the flag for the user', async () => {
    await notif.setPref(user, false);
    const call = db.query.mock.calls.find(c => /UPDATE user_profiles SET notifications_enabled/.test(c[0]));
    expect(call[1]).toEqual([false, user.id]);
  });
});
