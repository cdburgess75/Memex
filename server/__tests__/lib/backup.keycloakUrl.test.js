'use strict';
// keycloakDbUrl is pure; mock backup.js's heavy deps so requiring it needs no DB.
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(), get: jest.fn(), set: jest.fn() }));
jest.mock('../../lib/backupDestinations', () => ({ ARCHIVE_RE: /.*/, adapter: jest.fn() }));

const { keycloakDbUrl } = require('../../lib/backup');

describe('keycloakDbUrl', () => {
  test('swaps the database name, preserving host and credentials', () => {
    expect(keycloakDbUrl('postgres://memex:secret@postgres:5432/memex'))
      .toBe('postgres://memex:secret@postgres:5432/keycloak');
  });

  test('preserves query parameters', () => {
    expect(keycloakDbUrl('postgres://u:p@h:5432/memex?sslmode=require'))
      .toBe('postgres://u:p@h:5432/keycloak?sslmode=require');
  });

  test('handles a non-memex source database name', () => {
    expect(keycloakDbUrl('postgresql://u:p@h/appdb')).toBe('postgresql://u:p@h/keycloak');
  });

  test('empty / undefined input returns empty string', () => {
    expect(keycloakDbUrl('')).toBe('');
    expect(keycloakDbUrl(undefined)).toBe('');
  });
});
