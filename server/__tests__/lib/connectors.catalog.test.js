'use strict';
// Guards the connector catalog schema the admin form consumes. `hideWhen` drives
// the form collapsing app-only credential fields when "delegated" is ticked — it
// must survive the catalog() property whitelist, or the delegated form regresses to
// demanding tenant/client/cert it never uses.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const { catalog } = require('../../lib/connectors');

describe('connector catalog() field schema', () => {
  const cat = catalog();
  const fieldsOf = (kind) => {
    const k = cat.find((c) => c.kind === kind);
    const map = {};
    (k.fields || []).forEach((f) => { map[f.key] = f; });
    return map;
  };

  test('SharePoint app-only credentials carry hideWhen=delegated', () => {
    const f = fieldsOf('sharepoint');
    for (const key of ['tenantId', 'clientId', 'clientSecret', 'certThumbprint', 'certKeyPath', 'certKey']) {
      expect(f[key]).toBeDefined();
      expect(f[key].hideWhen).toBe('delegated');
    }
    // Fields used in BOTH modes must not be hidden.
    expect(f.siteUrl.hideWhen).toBeNull();
    expect(f.delegated.hideWhen).toBeNull();
  });

  test('SMB service-account credentials carry hideWhen=delegated', () => {
    const f = fieldsOf('smb');
    expect(f.username.hideWhen).toBe('delegated');
    expect(f.password.hideWhen).toBe('delegated');
    expect(f.host.hideWhen).toBeNull();
  });

  test('sharing is offered on SharePoint but NOT SMB (NTFS has no web-share)', () => {
    const sp = cat.find((c) => c.kind === 'sharepoint');
    const smb = cat.find((c) => c.kind === 'smb');
    expect(sp.caps.share).toBe(true);
    expect(Boolean(smb.caps.share)).toBe(false);
  });
});
