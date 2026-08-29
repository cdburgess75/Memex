'use strict';
// Upload notifications: ONE summary per upload burst (never one-per-file). Role
// defaults, per-person overridable: the library OWNER is notified by default,
// MEMBERS are not; each person's explicit pref wins; the uploader never.

jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({ sent: true }) }));
jest.mock('../../lib/folderNotifyPrefs', () => ({ effectiveFor: jest.fn() }));
jest.mock('../../lib/libraries', () => ({ info: jest.fn(), listMembers: jest.fn() }));

const notifications = require('../../lib/notifications');
const emailEvents = require('../../lib/emailEvents');
const folderNotifyPrefs = require('../../lib/folderNotifyPrefs');
const libraries = require('../../lib/libraries');
const uploadNotify = require('../../lib/uploadNotify');

beforeEach(() => {
  jest.clearAllMocks();
  uploadNotify._pending.clear();
  libraries.info.mockResolvedValue({ id: 'lib1', name: 'Client Deliverables', created_by_email: 'owner@x.com' });
  libraries.listMembers.mockResolvedValue([]);
  folderNotifyPrefs.effectiveFor.mockResolvedValue(new Map());
});

const recipients = () => notifications.create.mock.calls.map((c) => c[0].userEmail).sort();

test('owner is notified by default; a member is not', async () => {
  libraries.listMembers.mockResolvedValue([{ subject_email: 'member@x.com' }]);
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'Deals', uploaderEmail: 'owen@x.com', uploaderName: 'Owen', fileName: 'a.pdf' });
  await uploadNotify.flushAll();
  expect(recipients()).toEqual(['owner@x.com']); // member default OFF
});

test('a member who opted in IS notified (their pref overrides the default)', async () => {
  libraries.listMembers.mockResolvedValue([{ subject_email: 'member@x.com' }]);
  folderNotifyPrefs.effectiveFor.mockResolvedValue(new Map([['member@x.com', true]]));
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'Deals', uploaderEmail: 'owen@x.com', uploaderName: 'Owen', fileName: 'a.pdf' });
  await uploadNotify.flushAll();
  expect(recipients()).toEqual(['member@x.com', 'owner@x.com']);
});

test('the owner who opted out is NOT notified', async () => {
  folderNotifyPrefs.effectiveFor.mockResolvedValue(new Map([['owner@x.com', false]]));
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'Deals', uploaderEmail: 'owen@x.com', uploaderName: 'Owen', fileName: 'a.pdf' });
  await uploadNotify.flushAll();
  expect(notifications.create).not.toHaveBeenCalled();
});

test('a folder upload of many files → ONE summary per recipient, located by folder', async () => {
  libraries.listMembers.mockResolvedValue([{ subject_email: 'member@x.com' }]);
  folderNotifyPrefs.effectiveFor.mockResolvedValue(new Map([['member@x.com', true]]));
  for (let i = 0; i < 34; i++) {
    uploadNotify.record({ libraryId: 'lib1', folderPath: 'Deals', uploaderEmail: 'owen@x.com', uploaderName: 'Owen', fileName: `f${i}.pdf`, folderName: 'Deals' });
  }
  await uploadNotify.flushAll();
  expect(notifications.create).toHaveBeenCalledTimes(2); // owner + opted-in member, once each
  expect(emailEvents.send).toHaveBeenCalledTimes(2);
  expect(notifications.create.mock.calls[0][0].title).toMatch(/Owen uploaded a folder \(34 files\) to Deals \(Client Deliverables\)/);
});

test('a single file → "1 file", located by folder + library, owner only', async () => {
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'Policies', uploaderEmail: 'owen@x.com', uploaderName: 'Owen', fileName: 'nda.pdf' });
  await uploadNotify.flushAll();
  expect(notifications.create).toHaveBeenCalledTimes(1);
  expect(notifications.create.mock.calls[0][0].title).toBe('Owen uploaded 1 file to Policies (Client Deliverables)');
  expect(emailEvents.send.mock.calls[0][0]).toBe('upload_received');
  expect(emailEvents.send.mock.calls[0][1].to).toBe('owner@x.com');
});

test('the uploader is never notified of their own upload — even as the owner', async () => {
  libraries.info.mockResolvedValue({ id: 'lib1', name: 'My Space', created_by_email: 'owen@x.com' });
  uploadNotify.record({ libraryId: 'lib1', folderPath: '', uploaderEmail: 'Owen@X.com', uploaderName: 'Owen', fileName: 'x.pdf' });
  await uploadNotify.flushAll();
  expect(notifications.create).not.toHaveBeenCalled();
});

test('member pref that equals the owner address is de-duplicated to one notification', async () => {
  libraries.listMembers.mockResolvedValue([{ subject_email: 'owner@x.com' }]); // owner also listed as member
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'x', uploaderEmail: 'owen@x.com', uploaderName: 'Owen', fileName: 'a.pdf' });
  await uploadNotify.flushAll();
  expect(notifications.create).toHaveBeenCalledTimes(1);
  expect(recipients()).toEqual(['owner@x.com']);
});
