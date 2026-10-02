'use strict';
// In-browser editing is offered only when an admin has switched it on AND the editor
// answers. These pin the difference between the two, and what Settings is told while
// the host is still starting or stopping the editor.
jest.mock('../../lib/db', () => ({ query: jest.fn().mockResolvedValue([]) }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(), set: jest.fn().mockResolvedValue() }));

const db = require('../../lib/db');
const settings = require('../../lib/settings');
const editorStatus = require('../../lib/editorStatus');

const realFetch = global.fetch;
function world({ enabled, up, changedMsAgo = null, url = null }) {
  settings.getOrEnv.mockImplementation(async (k) => ({
    collabora_enabled: enabled, collabora_internal_url: 'http://collabora:9980', collabora_url: url,
  }[k] ?? null));
  global.fetch = jest.fn(async () => { if (up === 'throws') throw new Error('ENOTFOUND collabora'); return { ok: !!up }; });
  db.query.mockResolvedValue(changedMsAgo === null ? [] : [{ updated_at: new Date(Date.now() - changedMsAgo) }]);
}
beforeEach(() => editorStatus._resetForTests());
afterEach(() => { global.fetch = realFetch; });

describe('available (what every client is told)', () => {
  test('switched off: false, and the editor is not even asked', async () => {
    world({ enabled: 'false', up: true });
    expect(await editorStatus.available()).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('switched on but the editor is not answering: false', async () => {
    world({ enabled: 'true', up: 'throws' });
    expect(await editorStatus.available()).toBe(false);
  });
  test('switched on and answering: true, asking its discovery endpoint', async () => {
    world({ enabled: 'true', up: true });
    expect(await editorStatus.available()).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toBe('http://collabora:9980/hosting/discovery');
  });
  test('the answer is cached, so page loads do not each ask the editor', async () => {
    world({ enabled: 'true', up: true });
    await editorStatus.available(); await editorStatus.available(); await editorStatus.available();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test('a directly-exposed editor (collabora_url) still counts without the switch', async () => {
    world({ enabled: null, up: true, url: 'https://office.example.com' });
    expect(await editorStatus.available()).toBe(true);
  });
});

describe('status (what Settings shows an admin)', () => {
  const state = async (w) => { world(w); return (await editorStatus.status()).state; };
  test('off and not running', async () => expect(await state({ enabled: 'false', up: false })).toBe('off'));
  test('on and answering', async () => expect(await state({ enabled: 'true', up: true, changedMsAgo: 5000 })).toBe('on'));
  test('just switched on, not answering yet: starting', async () =>
    expect(await state({ enabled: 'true', up: 'throws', changedMsAgo: 30_000 })).toBe('starting'));
  test('switched on long ago and still not answering: failed', async () =>
    expect(await state({ enabled: 'true', up: false, changedMsAgo: editorStatus.STARTING_GRACE_MS + 1000 })).toBe('failed'));
  test('switched on with no record of when: failed rather than starting forever', async () =>
    expect(await state({ enabled: 'true', up: false })).toBe('failed'));
  test('just switched off, editor still up: stopping', async () =>
    expect(await state({ enabled: 'false', up: true, changedMsAgo: 20_000 })).toBe('stopping'));
  test('switched off a while ago and the editor is still up: lingering', async () =>
    expect(await state({ enabled: 'false', up: true, changedMsAgo: editorStatus.STOPPING_GRACE_MS + 1000 })).toBe('lingering'));
});

describe('setSwitch', () => {
  test('off is stored as the literal "false", never cleared', async () => {
    // Clearing the row would fall back to COLLABORA_ENABLED=true in older .env files
    // and silently switch editing back on.
    await editorStatus.setSwitch(false, 'u1');
    expect(settings.set).toHaveBeenCalledWith('collabora_enabled', 'false', 'u1');
  });
  test('on is stored as "true"', async () => {
    await editorStatus.setSwitch(true, 'u1');
    expect(settings.set).toHaveBeenCalledWith('collabora_enabled', 'true', 'u1');
  });
});
