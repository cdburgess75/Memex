'use strict';
// Unit-tests the audit-feed filter builder: correct parameterization ($1..$N in
// order), no SQL when unfiltered, and each filter mapping to the right column.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(), set: jest.fn(), refresh: jest.fn() }));
jest.mock('../../lib/compliance', () => ({}));
jest.mock('../../lib/documentAccess', () => ({}));
jest.mock('../../middleware/auth', () => (req, _res, next) => next());
jest.mock('../../middleware/requireRole', () => () => (req, _res, next) => next());

const { activityFilters } = require('../../routes/admin');

describe('activityFilters', () => {
  test('no filters → empty clause, no params', () => {
    expect(activityFilters({})).toEqual({ clause: '', params: [] });
  });

  test('actor/document use ILIKE with wildcards; event is exact', () => {
    const { clause, params } = activityFilters({ actor: 'Dave', event: 'uploaded', q: 'Report' });
    expect(clause).toBe('WHERE de.actor_email ILIKE $1 AND de.event_type = $2 AND d.name ILIKE $3');
    expect(params).toEqual(['%Dave%', 'uploaded', '%Report%']);
  });

  test('date range: from is inclusive, to is exclusive-of-next-day', () => {
    const { clause, params } = activityFilters({ from: '2026-07-01', to: '2026-07-06' });
    expect(clause).toBe(
      "WHERE de.created_at >= $1 AND de.created_at < ($2::date + INTERVAL '1 day')"
    );
    expect(params).toEqual(['2026-07-01', '2026-07-06']);
  });

  test('placeholders stay sequential regardless of which filters are present', () => {
    const { clause, params } = activityFilters({ event: 'share_downloaded', to: '2026-07-06' });
    expect(clause).toBe(
      "WHERE de.event_type = $1 AND de.created_at < ($2::date + INTERVAL '1 day')"
    );
    expect(params).toHaveLength(2);
  });

  test('blank/whitespace filter values are ignored', () => {
    expect(activityFilters({ actor: '   ', event: '', q: '' })).toEqual({ clause: '', params: [] });
  });
});
