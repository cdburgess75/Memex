'use strict';
// Download tickets keep the password out of URLs: the exchange page mints a
// short-lived ticket from the password (sent in a header) and the download link
// carries the ticket, not the secret. These pin the signing contract.
jest.mock('../../lib/db', () => ({ query: jest.fn().mockResolvedValue([]), queryOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/storage', () => ({ getUrl: jest.fn(), download: jest.fn(), isLocalProvider: jest.fn().mockResolvedValue(true), localBase: jest.fn(), validateLocalToken: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn() }));
jest.mock('../../middleware/auth', () => (req, _res, next) => next());

const { issueShareTicket, verifyShareTicket } = require('../../routes/files');

describe('share download tickets', () => {
  test('a fresh ticket verifies for its own share id', () => {
    const t = issueShareTicket('share-1');
    expect(verifyShareTicket('share-1', t)).toBe(true);
  });

  test('a ticket is bound to one share — it does not verify for another', () => {
    const t = issueShareTicket('share-1');
    expect(verifyShareTicket('share-2', t)).toBe(false);
  });

  test('an expired ticket is rejected', () => {
    const t = issueShareTicket('share-1', -1000); // already past
    expect(verifyShareTicket('share-1', t)).toBe(false);
  });

  test('a tampered MAC is rejected', () => {
    const t = issueShareTicket('share-1');
    const [exp] = t.split('.');
    expect(verifyShareTicket('share-1', exp + '.forgedforgedforged')).toBe(false);
  });

  test('a tampered expiry (extending the window) is rejected — the MAC covers it', () => {
    const t = issueShareTicket('share-1', 1000);
    const [, mac] = t.split('.');
    const farFuture = Date.now() + 10 * 60 * 1000;
    expect(verifyShareTicket('share-1', farFuture + '.' + mac)).toBe(false);
  });

  test('garbage and empty tickets are rejected without throwing', () => {
    for (const bad of ['', null, undefined, 'x', '123', 'abc.def', '.']) {
      expect(verifyShareTicket('share-1', bad)).toBe(false);
    }
  });
});

describe('rate-limit routing: password surface stays tight, uploads run generous', () => {
  const { isUploadPath } = require('../../lib/rateLimiters');
  // The recipient-upload route carries a ticket (never the password), so it is
  // safe outside the tight limiter AND must be exempt from apiLimiter or its
  // generous budget is unreachable. The password-verifying routes must NOT be
  // exempted — that would widen brute-force.
  test('the exchange upload path is exempt from the general apiLimiter', () => {
    expect(isUploadPath({ originalUrl: '/api/files/share/ABC123/upload' })).toBe(true);
  });
  test.each([
    ['/api/files/share/ABC123/info'],
    ['/api/files/share/ABC123/ticket'],
    ['/api/files/share/ABC123'],
  ])('the password/ticket-verifying path %s stays under the tight limiter', (p) => {
    expect(isUploadPath({ originalUrl: p })).toBe(false);
  });
});
