'use strict';
// The two controls retention and legal hold add to the Compliance section, and the
// enriched trash-retention evidence. Everything reads lib/retention.js, mocked here.
jest.mock('../../lib/db', () => ({ queryOne: jest.fn(), query: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async () => null), get: jest.fn(async () => null) }));
jest.mock('../../lib/retention', () => ({
  policySummary: jest.fn(), holdCounts: jest.fn(), activeHolds: jest.fn(),
}));

const settings = require('../../lib/settings');
const retention = require('../../lib/retention');
const { CHECKS, CONTROL_CATALOG, FRAMEWORKS, UPCOMING } = require('../../lib/compliance');

const lib = (name, min, dispose) => ({ name, client: true, min_years: min, dispose_years: dispose, words: [min ? `keep at least ${min} years` : '', dispose ? `move to the trash after ${dispose} years without changes` : ''].filter(Boolean).join('; ') || 'no retention policy' });

beforeEach(() => jest.clearAllMocks());

describe('the catalog', () => {
  test('retention_policy and legal_hold are the last entries, with a fix pointer each; legal_hold is attestable', () => {
    expect(Object.keys(CONTROL_CATALOG).slice(-2)).toEqual(['retention_policy', 'legal_hold']);
    expect(Object.keys(CHECKS).slice(-2)).toEqual(['retention_policy', 'legal_hold']);
    expect(CONTROL_CATALOG.retention_policy.fix).toBe('retention');
    expect(CONTROL_CATALOG.legal_hold.fix).toBe('holds');
    expect(CONTROL_CATALOG.legal_hold.attestable).toBe(true);
    expect(CONTROL_CATALOG.retention_policy.manual).toBeUndefined();
    for (const id of ['retention_policy', 'legal_hold']) expect(UPCOMING).not.toContain(id);
  });
  test('the frameworks that ask for retention cite their clause', () => {
    const by = Object.fromEntries(FRAMEWORKS.map(f => [f.id, f]));
    const cite = (fw, id) => by[fw].requirements.find(r => r.control === id)?.cite;
    expect(cite('safeguards', 'retention_policy')).toBe('314.4(c)(6)');
    expect(by.safeguards.requirements.find(r => r.control === 'retention_policy').why).toMatch(/IRC §6107/);
    expect(cite('hipaa', 'retention_policy')).toBe('164.316(b)(2)');
    expect(cite('soc2', 'retention_policy')).toBe('CC6.5');
    expect(cite('soc2', 'legal_hold')).toBe('CC6.5');
    for (const fw of ['safeguards', 'hipaa', 'soc2', 'nist_csf', 'iso27001']) for (const id of ['retention_policy', 'legal_hold']) expect(by[fw].controls).toContain(id);
  });
});

describe('retention_policy', () => {
  test('green when every shared library has a minimum; the rule is in the evidence', async () => {
    retention.policySummary.mockResolvedValue({ total: 2, withMinimum: 2, withDisposal: 1, withNone: 0, missingMinimum: [], libraries: [lib('Clients', 3, 7), lib('Payroll', 6, null)] });
    const r = await CHECKS.retention_policy();
    expect(r.ready).toBe(true);
    expect(r.evidence).toMatch(/“Clients” keep at least 3 years; move to the trash after 7 years without changes; “Payroll” keep at least 6 years/);
    expect(r.evidence).toMatch(/The rule: every shared library/);
  });
  test('not green while one is missing, and it is named', async () => {
    retention.policySummary.mockResolvedValue({ total: 2, withMinimum: 1, withDisposal: 0, withNone: 1, missingMinimum: ['Payroll'], libraries: [lib('Clients', 3, null), lib('Payroll', null, null)] });
    const r = await CHECKS.retention_policy();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/1 of 2 shared libraries has no minimum: “Payroll”\. Set: “Clients” keep at least 3 years/);
  });
  test('no shared library yet is a gap, not a pass', async () => {
    retention.policySummary.mockResolvedValue({ total: 0, withMinimum: 0, withDisposal: 0, withNone: 0, missingMinimum: [], libraries: [] });
    expect((await CHECKS.retention_policy()).ready).toBe(false);
  });
});

describe('legal_hold', () => {
  test('never used: not green, says how to place one', async () => {
    retention.holdCounts.mockResolvedValue({ active: 0, ever: 0 });
    retention.activeHolds.mockResolvedValue([]);
    const r = await CHECKS.legal_hold();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/never been placed.*library, folder or file menu/);
  });
  test('in use: green, listing the open holds with who, when and why', async () => {
    retention.holdCounts.mockResolvedValue({ active: 1, ever: 3 });
    retention.activeHolds.mockResolvedValue([{ where: 'folder “Clients/Smith” in “Clients”', placed_at: '2026-11-03T12:00:00Z', placed_by: 'admin@firm.test', reason: 'Smith v. Jones' }]);
    const r = await CHECKS.legal_hold();
    expect(r.ready).toBe(true);
    expect(r.evidence).toMatch(/3 placed so far, 1 open\. 1 hold in place: folder “Clients\/Smith” in “Clients” since November 3, 2026 \(admin@firm.test: Smith v. Jones\)/);
  });
});

describe('retention (the trash) counts the libraries too', () => {
  test('the per-library counts ride on the trash sentence', async () => {
    settings.getOrEnv.mockResolvedValue('30');
    retention.policySummary.mockResolvedValue({ total: 3, withMinimum: 2, withDisposal: 1, withNone: 1, missingMinimum: ['X'], libraries: [] });
    const r = await CHECKS.retention();
    expect(r.ready).toBe(true);
    expect(r.evidence).toMatch(/purged after 30 days.*Of 3 shared libraries, 2 have a minimum time files are kept, 1 disposes of untouched files on their own, and 1 has no policy\./);
  });
});
