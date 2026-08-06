'use strict';
// Path containment is the security boundary for a connector: an operator scopes a
// mount to one share or one site, and no request may climb out of it. These are the
// cases that matter, expressed against the helper every adapter routes through.
const base = require('../../lib/connectors/base');

describe('normalizePath', () => {
  test('strips redundant separators and dot segments', () => {
    expect(base.normalizePath('/a//b/./c/')).toBe('a/b/c');
    expect(base.normalizePath('')).toBe('');
    expect(base.normalizePath('/')).toBe('');
  });

  test('treats backslashes as separators (SMB paths arrive both ways)', () => {
    expect(base.normalizePath('a\\b\\c')).toBe('a/b/c');
    expect(base.normalizePath('\\\\a\\b')).toBe('a/b');
  });

  test('resolves interior .. without escaping', () => {
    expect(base.normalizePath('a/b/../c')).toBe('a/c');
  });

  test('refuses to escape the root rather than clamping', () => {
    // Clamping would silently turn an escape attempt into a different, valid
    // request; refusing keeps the caller honest and the failure visible.
    for (const evil of ['..', '../etc/passwd', 'a/../../b', '/../x', '..\\..\\windows']) {
      expect(() => base.normalizePath(evil)).toThrow(/escapes/);
    }
  });

  test('rejects NUL, which can truncate a path inside a native layer', () => {
    expect(() => base.normalizePath('a/b\0.txt')).toThrow(/invalid path/);
  });
});

describe('resolveWithinRoot', () => {
  test('prefixes the operator root', () => {
    expect(base.resolveWithinRoot('Projects/2026', 'q3/plan.docx')).toBe('Projects/2026/q3/plan.docx');
    expect(base.resolveWithinRoot('', 'plan.docx')).toBe('plan.docx');
    expect(base.resolveWithinRoot('Projects', '')).toBe('Projects');
  });

  test('a caller cannot traverse out of the configured root', () => {
    expect(() => base.resolveWithinRoot('Projects/2026', '../../secrets')).toThrow(/escapes/);
  });
});

describe('splitFields', () => {
  const adapter = {
    fields: [
      { key: 'host', type: 'text' },
      { key: 'port', type: 'number' },
      { key: 'readAll', type: 'bool' },
      { key: 'password', type: 'password', secret: true },
    ],
  };

  test('routes secret fields away from the plain config', () => {
    const { config, secrets } = base.splitFields(adapter, {
      host: 'files.corp', port: '445', readAll: true, password: 'hunter2', bogus: 'ignored',
    });
    expect(config).toEqual({ host: 'files.corp', port: 445, readAll: true });
    expect(secrets).toEqual({ password: 'hunter2' });
    // A field the adapter never declared must not ride along into storage.
    expect(config.bogus).toBeUndefined();
  });

  test('omits keys the caller did not supply, so a partial edit is a partial update', () => {
    const { config, secrets } = base.splitFields(adapter, { host: 'x' });
    expect(config).toEqual({ host: 'x' });
    expect(secrets).toEqual({});
  });
});

describe('missingRequired', () => {
  const adapter = { fields: [{ key: 'a', label: 'Server', required: true }, { key: 'b', label: 'Port' }] };

  test('reports blank required fields by label', () => {
    expect(base.missingRequired(adapter, { a: '   ' })).toEqual(['Server']);
    expect(base.missingRequired(adapter, { a: 'host' })).toEqual([]);
  });
});

describe('assertCapability', () => {
  const rw = { label: 'X', caps: { write: true, remove: false } };

  test('refuses a capability the adapter does not implement', () => {
    expect(() => base.assertCapability(rw, { read_only: false }, 'remove')).toThrow(/does not support/);
  });

  test('refuses any mutation on a read-only mount', () => {
    expect(() => base.assertCapability(rw, { read_only: true }, 'write')).toThrow(/read-only/);
  });

  test('allows a supported capability on a writable mount', () => {
    expect(() => base.assertCapability(rw, { read_only: false }, 'write')).not.toThrow();
  });
});
