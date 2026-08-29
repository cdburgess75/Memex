'use strict';
// Upload notifications: ONE summary per upload burst (never one-per-file), to
// the library owner + folder followers, with the uploader excluded.

jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({ sent: true }) }));
jest.mock('../../lib/folderWatchers', () => ({ subscribersFor: jest.fn() }));
jest.mock('../../lib/libraries', () => ({ info: jest.fn() }));

const notifications = require('../../lib/notifications');
const emailEvents = require('../../lib/emailEvents');
const folderWatchers = require('../../lib/folderWatchers');
const libraries = require('../../lib/libraries');
const uploadNotify = require('../../lib/uploadNotify');

beforeEach(() => {
  jest.clearAllMocks();
  uploadNotify._pending.clear();
  libraries.info.mockResolvedValue({ id: 'lib1', name: 'Client Deliverables', created_by_email: 'owner@x.com' });
  folderWatchers.subscribersFor.mockResolvedValue([]);
});

const recipients = () => notifications.create.mock.calls.map((c) => c[0].userEmail).sort();

test('a folder upload of many files sends ONE summary per recipient, not one per file', async () => {
  folderWatchers.subscribersFor.mockResolvedValue(['watcher@x.com', 'owen@x.com']);
  for (let i = 0; i < 34; i++) {
    uploadNotify.record({ libraryId: 'lib1', folderPath: 'Deals/Q3', uploaderEmail: 'owen@x.com', uploaderName: 'Owen', fileName: `f${i}.pdf`, folderName: 'Deals' });
  }
  await uploadNotify.flushAll();
  expect(notifications.create).toHaveBeenCalledTimes(2);  // owner + watcher, once each
  expect(emailEvents.send).toHaveBeenCalledTimes(2);
  expect(recipients()).toEqual(['owner@x.com', 'watcher@x.com']); // owen (uploader) excluded
  const title = notifications.create.mock.calls[0][0].title;
  expect(title).toMatch(/Owen uploaded a folder \(34 files\) to Q3 \(Client Deliverables\)/);
});

test('a single file → "1 file", located by folder + library', async () => {
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'Policies', uploaderEmail: 'owen@x.com', uploaderName: 'Owen', fileName: 'nda.pdf' });
  await uploadNotify.flushAll();
  expect(notifications.create).toHaveBeenCalledTimes(1);
  expect(notifications.create.mock.calls[0][0].title).toBe('Owen uploaded 1 file to Policies (Client Deliverables)');
  expect(emailEvents.send.mock.calls[0][0]).toBe('upload_received');
  expect(emailEvents.send.mock.calls[0][1].to).toBe('owner@x.com');
});

test('the uploader is never notified of their own upload — even if they are the owner', async () => {
  libraries.info.mockResolvedValue({ id: 'lib1', name: 'My Space', created_by_email: 'owen@x.com' });
  uploadNotify.record({ libraryId: 'lib1', folderPath: '', uploaderEmail: 'Owen@X.com', uploaderName: 'Owen', fileName: 'x.pdf' });
  await uploadNotify.flushAll();
  expect(notifications.create).not.toHaveBeenCalled();
  expect(emailEvents.send).not.toHaveBeenCalled();
});

test('no owner and no followers → nobody is notified (no noise)', async () => {
  libraries.info.mockResolvedValue(null);
  folderWatchers.subscribersFor.mockResolvedValue([]);
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'x', uploaderEmail: 'owen@x.com', fileName: 'a.pdf' });
  await uploadNotify.flushAll();
  expect(notifications.create).not.toHaveBeenCalled();
});

test('owner and a follower who are the same address are de-duplicated to one notification', async () => {
  folderWatchers.subscribersFor.mockResolvedValue(['OWNER@x.com']); // same as owner, different case
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'x', uploaderEmail: 'owen@x.com', uploaderName: 'Owen', fileName: 'a.pdf' });
  await uploadNotify.flushAll();
  expect(notifications.create).toHaveBeenCalledTimes(1);
  expect(recipients()).toEqual(['owner@x.com']);
});

test('separate uploaders into the same folder get separate summaries', async () => {
  folderWatchers.subscribersFor.mockResolvedValue(['watcher@x.com']);
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'x', uploaderEmail: 'a@x.com', uploaderName: 'Amy', fileName: '1.pdf' });
  uploadNotify.record({ libraryId: 'lib1', folderPath: 'x', uploaderEmail: 'b@x.com', uploaderName: 'Ben', fileName: '2.pdf' });
  await uploadNotify.flushAll();
  // two bursts (Amy, Ben) × recipients {owner, watcher} = 4 notifications
  expect(notifications.create).toHaveBeenCalledTimes(4);
});
