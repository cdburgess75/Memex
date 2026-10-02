'use strict';
/* The getting-started guide is copied into a personal library the moment one is made, and
 * the middleware makes one for any contributor or admin who has none. In a route test that
 * is every person a fixture inserts: two files would land in their library behind each
 * test's back, changing what the test counts and outliving the test itself.
 *
 * So every test file gets a guide that does nothing, unless it asks for the real one:
 * integration/gettingStarted.pg calls jest.unmock('../../lib/gettingStarted') before it
 * requires anything, and suites that check the call itself mock it with their own factory.
 */
jest.mock('../../lib/gettingStarted', () => ({
  seedLibrary: jest.fn(async () => false),
  backfill: jest.fn(async () => ({ candidates: 0, added: 0, failed: 0 })),
  enabled: jest.fn(async () => true),
  stop: jest.fn(),
  settled: jest.fn(async () => {}),
  pdfPath: jest.fn(() => require('path').join(__dirname, '../../assets/getting-started/Getting started with Depot.pdf')),
}));
