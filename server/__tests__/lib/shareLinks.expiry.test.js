'use strict';
// The admin cap on how long a link may live (share_link_max_days) and how a new
// link's expiry is resolved against it.
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
const settings = require('../../lib/settings');
const { shareLinkMaxDays, resolveLinkExpiry } = require('../../lib/shareLinks');

const daysFromNow = (iso) => Math.round((new Date(iso).getTime() - Date.now()) / 864e5);

beforeEach(() => settings.getOrEnv.mockReset());

describe('shareLinkMaxDays', () => {
  test('null when unset or nonsense, the number otherwise, never above 365', async () => {
    settings.getOrEnv.mockResolvedValue(null);
    expect(await shareLinkMaxDays()).toBeNull();
    settings.getOrEnv.mockResolvedValue('abc');
    expect(await shareLinkMaxDays()).toBeNull();
    settings.getOrEnv.mockResolvedValue('0');
    expect(await shareLinkMaxDays()).toBeNull();
    settings.getOrEnv.mockResolvedValue('30');
    expect(await shareLinkMaxDays()).toBe(30);
    settings.getOrEnv.mockResolvedValue('9999');
    expect(await shareLinkMaxDays()).toBe(365);
  });
});

describe('resolveLinkExpiry', () => {
  test('no cap: the old behaviour (default, clamp at 365, never allowed)', async () => {
    settings.getOrEnv.mockResolvedValue(null);
    expect(daysFromNow((await resolveLinkExpiry({}, 7)).expiresAt)).toBe(7);
    expect(daysFromNow((await resolveLinkExpiry({ expiresInDays: '90' }, 7)).expiresAt)).toBe(90);
    expect(daysFromNow((await resolveLinkExpiry({ expiresInDays: '9999' }, 7)).expiresAt)).toBe(365);
    expect(daysFromNow((await resolveLinkExpiry({ expiresInDays: 'x' }, 30)).expiresAt)).toBe(30);
    expect(await resolveLinkExpiry({ neverExpires: true }, 7)).toEqual({ expiresAt: null });
  });

  test('with a cap: longer is trimmed to it, never is refused', async () => {
    settings.getOrEnv.mockResolvedValue('30');
    expect(daysFromNow((await resolveLinkExpiry({ expiresInDays: '90' }, 7)).expiresAt)).toBe(30);
    expect(daysFromNow((await resolveLinkExpiry({ expiresInDays: '7' }, 7)).expiresAt)).toBe(7);
    const r = await resolveLinkExpiry({ neverExpires: true }, 7);
    expect(r.code).toBe('LINK_MUST_EXPIRE');
    expect(r.error).toBe('Links on this Depot must expire within 30 days.');
    expect(r.expiresAt).toBeUndefined();
  });
});
