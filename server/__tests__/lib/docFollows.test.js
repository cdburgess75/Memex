'use strict';
// Followers are told about a file only while they can still read it.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/documentAccess', () => ({ readersAmong: jest.fn() }));
const db = require('../../lib/db');
const documentAccess = require('../../lib/documentAccess');
const { followersOf } = require('../../lib/docFollows');

test('a follower who can no longer read the file is dropped, and the actor never included', async () => {
  db.query.mockResolvedValueOnce([{ subscriber_email: 'keep@x.com' }, { subscriber_email: 'Gone@x.com' }, { subscriber_email: 'actor@x.com' }]);
  documentAccess.readersAmong.mockResolvedValueOnce(new Map([['keep@x.com', new Set(['d1'])], ['gone@x.com', new Set()]]));
  expect(await followersOf('d1', 'ACTOR@x.com')).toEqual(['keep@x.com']);
  expect(documentAccess.readersAmong).toHaveBeenCalledWith(['d1'], ['keep@x.com', 'Gone@x.com']);
});

test('no followers asks nothing further', async () => {
  db.query.mockResolvedValueOnce([]);
  expect(await followersOf('d1', 'a@x.com')).toEqual([]);
  expect(documentAccess.readersAmong).not.toHaveBeenCalled();
});
