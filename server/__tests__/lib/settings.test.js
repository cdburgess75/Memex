'use strict';

jest.mock('../../lib/db');
const db       = require('../../lib/db');
const settings = require('../../lib/settings');

beforeEach(() => {
  settings._reset();
  db.query.mockResolvedValue([]);
  db.queryOne.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe('getOrEnv', () => {
  test('returns env var when no DB row exists', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    expect(await settings.getOrEnv('anthropic_api_key')).toBe('env-key');
  });

  test('returns null when key absent from both DB and env', async () => {
    expect(await settings.getOrEnv('anthropic_api_key')).toBeNull();
  });

  test('DB value takes precedence over env var', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    db.query.mockResolvedValue([{ key: 'anthropic_api_key', value: 'db-key' }]);
    settings._reset();
    expect(await settings.getOrEnv('anthropic_api_key')).toBe('db-key');
  });

  test('returns null for unknown key', async () => {
    expect(await settings.getOrEnv('not_a_real_key')).toBeNull();
  });
});

describe('set', () => {
  test('upserts a value and updates cache', async () => {
    // Prime cache so _ensureFresh does not trigger a refresh on the subsequent get()
    db.query.mockResolvedValue([]);
    await settings.refresh();
    db.query.mockClear();

    await settings.set('anthropic_model', 'claude-opus-4-8', 'user-1');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO system_settings'),
      ['anthropic_model', 'claude-opus-4-8', 'user-1']
    );

    // Cache is fresh and contains the value — get() must not hit DB
    db.query.mockClear();
    expect(await settings.get('anthropic_model')).toBe('claude-opus-4-8');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('deletes DB row and removes from cache when value is falsy', async () => {
    // Pre-populate cache
    await settings.set('anthropic_model', 'some-model', 'user-1');
    db.query.mockClear();

    await settings.set('anthropic_model', null, 'user-1');
    expect(db.query).toHaveBeenCalledWith(
      'DELETE FROM system_settings WHERE key = $1', ['anthropic_model']
    );
    expect(await settings.get('anthropic_model')).toBeNull();
  });
});

describe('refresh', () => {
  test('populates cache from DB rows', async () => {
    db.query.mockResolvedValue([
      { key: 'anthropic_model', value: 'claude-sonnet-4-6' },
      { key: 'storage_provider', value: 's3' },
    ]);
    await settings.refresh();
    expect(await settings.get('anthropic_model')).toBe('claude-sonnet-4-6');
    expect(await settings.get('storage_provider')).toBe('s3');
  });

  test('silently ignores DB errors (env vars still work)', async () => {
    process.env.ANTHROPIC_API_KEY = 'fallback';
    db.query.mockRejectedValue(new Error('DB down'));
    await expect(settings.refresh()).resolves.toBeUndefined();
    expect(await settings.getOrEnv('anthropic_api_key')).toBe('fallback');
  });
});
