'use strict';
// Covers the compliance evidence bundle: aggregation via injected sources and the
// Markdown rendering (control matrix, probes, audit integrity, access review).
jest.mock('../../lib/compliance', () => ({
  runProbes: jest.fn().mockResolvedValue({}),
  summary: jest.fn().mockResolvedValue({ enabledFrameworks: 1, ready: 2, total: 3, status: 'warn' }),
  profileStatus: jest.fn().mockResolvedValue([
    { id: 'soc2', label: 'SOC 2', enabled: true, scope: 'Security', controls: [
      { id: 'access_control', label: 'Access control', ready: true, evidence: 'Keycloak + RBAC', manual: false },
      { id: 'incident_response', label: 'Incident response', ready: false, evidence: 'No runbook', manual: true, attestation: null },
    ] },
  ]),
  updateStatus: jest.fn().mockResolvedValue({ app: { version: 'v2026.07.12.001', git: { commit: 'abc123' }, updateMethod: 'GitHub pull + rebuild' }, dependencyAudit: { available: true, recommendedCommand: 'npm audit' } }),
  probeMeta: jest.fn().mockReturnValue({ lastRun: 1783900000000, results: { https: { status: 'ok', detail: 'HTTPS reachable' }, backup: { status: 'unknown', detail: 'no backups yet' } } }),
  boolValue: (v) => ['1', 'true', 'yes', 'on', 'enabled'].includes(String(v || '').toLowerCase()),
}));
jest.mock('../../lib/settings', () => ({
  getOrEnv: jest.fn((k) => Promise.resolve({ brand_name: 'Bayou Tax <&> Books', app_url: 'https://depot.bayou.test', share_link_max_days: '30', trash_retention_days: '45', storage_encryption_key: 'k' }[k] ?? null)),
  get: jest.fn((k) => Promise.resolve({ mfa_required: 'true', backup_last_run: '1783900000000' }[k] ?? null)),
}));
jest.mock('../../lib/accessReview', () => ({
  build: jest.fn().mockResolvedValue({ generatedAt: 'x', userCount: 2, openLibraries: ['Public'], users: [
    { email: 'dave@x.com', name: 'Dave', role: 'admin', libraries: ['all (admin)'], directShares: 0, lastActivity: '2026-07-11T09:00:00Z', mfa: 'enrolled' },
    { email: 'ann@x.com', name: '', role: 'viewer', libraries: ['Clients'], directShares: 3, lastActivity: null, mfa: 'federated' },
  ] }),
  mfaWord: (s) => ({ enrolled: 'Authenticator set up', federated: 'Through their identity provider' }[s] || 'Could not check'),
}));
jest.mock('../../lib/auditLog', () => ({ verify: jest.fn().mockResolvedValue({ ok: true, count: 42, head: 'deadbeef' }) }));

const evidence = require('../../lib/evidence');

describe('build', () => {
  test('aggregates posture, frameworks, probes, access review, and audit integrity', async () => {
    const b = await evidence.build();
    expect(b.version).toBe('v2026.07.12.001');
    expect(b.posture.status).toBe('warn');
    expect(b.frameworks).toHaveLength(1);
    expect(b.accessReview.userCount).toBe(2);
    expect(b.auditIntegrity).toEqual({ ok: true, count: 42, head: 'deadbeef' });
    expect(require('../../lib/compliance').runProbes).toHaveBeenCalled(); // refreshed
  });

  test('tolerates a failing source without throwing', async () => {
    require('../../lib/auditLog').verify.mockRejectedValueOnce(new Error('db down'));
    const b = await evidence.build();
    expect(b.auditIntegrity).toEqual({ ok: false, error: 'db down' });
  });
});

describe('toMarkdown', () => {
  test('renders every major section', async () => {
    const md = evidence.toMarkdown(await evidence.build());
    expect(md).toContain('# Memex compliance evidence package');
    expect(md).toContain('## Control matrix');
    expect(md).toContain('| Access control | Met |');
    expect(md).toContain('| Incident response | Gap |');
    expect(md).toContain('## Runtime checks');
    expect(md).toContain('## Audit-log integrity');
    expect(md).toContain('verified intact: 42 chained event(s)');
    expect(md).toContain('## Access review');
    expect(md).toContain('dave@x.com (Dave)');
    expect(md).toContain('never'); // ann has no last activity
  });

  test('reports a broken audit chain when verify failed', () => {
    const md = evidence.toMarkdown({ generatedAt: 'x', frameworks: [], accessReview: { users: [] }, auditIntegrity: { ok: false, brokenAt: 7, reason: 'hash mismatch' } });
    expect(md).toContain('Integrity check FAILED at entry 7: hash mismatch');
  });

  test('surfaces an access-review generation failure instead of an empty table', () => {
    const md = evidence.toMarkdown({ generatedAt: 'x', frameworks: [], auditIntegrity: { ok: true, count: 0 }, accessReview: { error: 'db down', users: [], openLibraries: [] } });
    expect(md).toContain('Access review could not be generated: db down');
    expect(md).toContain('must not be treated as evidence');
  });
});

describe('toPacketHtml — the Safeguards packet', () => {
  test('has the cover, the five sections, the firm name, and no scripts', async () => {
    const b = await evidence.build();
    expect(b.firm).toEqual({ name: 'Bayou Tax <&> Books', hostname: 'depot.bayou.test' });
    const html = evidence.toPacketHtml(b);
    expect(html).toContain('Bayou Tax &lt;&amp;&gt; Books');   // escaped, not raw
    expect(html).not.toContain('Bayou Tax <&> Books');
    for (const sec of ['Summary for your written information security plan', 'Safeguards Rule checklist', 'Who has access', 'Audit-log check', 'Settings this packet relies on']) expect(html).toContain(sec);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('dave@x.com');
    expect(html).toContain('42 chained entries');
  });

  test('the prose reads the live settings', async () => {
    const html = evidence.toPacketHtml(await evidence.build());
    expect(html).toContain('must enter a one-time code');
    expect(html).toContain('expires within 30 days');
    expect(html).toContain('held in the trash for 45 days');
    expect(html).toContain('encrypted where they are stored');
    expect(html).toContain("On the firm's own server");
  });

  test('names what is left when a control is not met', async () => {
    const html = evidence.toPacketHtml(await evidence.build());
    expect(html).toContain('To do');             // incident_response in the mocked framework
    expect(html).toContain('Incident response');
  });
});

// One report per framework: the cover names it, section 1 comes from that framework's
// prose builder (reading the same live settings), the checklist carries its cites, and
// sections 3 to 5 stay shared.
describe('toReportHtml — any framework', () => {
  const fw = (id, name, extra = {}) => ({ id, name, enabled: true, controls: [{ id: 'mfa', label: 'MFA', ready: true, evidence: 'e', why: `${extra.cite || 'x'}: a second step` }, ...(extra.controls || [])] });
  const bundle = async (frameworks) => ({ ...(await evidence.build()), frameworks });

  test('HIPAA: names the framework, reads the sign-in length, and says what is the organization\'s own', async () => {
    require('../../lib/settings').get.mockImplementation((k) => Promise.resolve({ mfa_required: 'true', backup_last_run: '1783900000000', login_session_hours: '10' }[k] ?? null));
    const b = await bundle([fw('hipaa', 'HIPAA', { cite: '164.312(d)', controls: [{ id: 'emergency_access', label: 'Emergency', ready: false, evidence: 'e', gap: 'g', manual: true, why: '164.312(a)(2)(ii): a written way in' }] })]);
    const html = evidence.toReportHtml(b, 'hipaa');
    expect(html).toContain('HIPAA Security Rule · Technical safeguards report');
    expect(html).toContain('<title>Bayou Tax &lt;&amp;&gt; Books — HIPAA report — ');
    expect(html).toContain('Summary for your security policies');
    expect(html).toContain('A sign-in ends on its own after 10 hours');
    expect(html).toContain('is to write down how patient files are reached in an emergency');
    expect(html).toContain('164.312(a)(2)(ii): a written way in');
    expect(html).toContain('Business associate agreements, the risk analysis');
    expect(html).toContain('HIPAA certifies organizations, not software');
    expect(html).toContain('Who has access'); expect(html).toContain('Audit-log check'); expect(html).toContain('Settings this report relies on');
    expect(html).not.toMatch(/<script/i);
  });
  test('PCI: a statement of scope, reading whether the written rule is confirmed', async () => {
    const b = await bundle([fw('pci_dss', 'PCI: no card data in Depot', { controls: [{ id: 'no_card_data', label: 'No card data', ready: true, evidence: 'e', manual: true, why: 'scope' }] })]);
    const html = evidence.toReportHtml(b, 'pci_dss');
    expect(html).toContain('PCI DSS · Statement of scope');
    expect(html).toContain('Depot is therefore outside the organization&#39;s PCI DSS scope');
    expect(html).toContain('A written rule says card numbers are never typed into or uploaded to Depot');
    expect(html).toContain('not a PCI DSS assessment');
    expect(html).toContain('held in the trash for 45 days');   // the shared sentences still read the settings
  });
  test('NIST CSF: the six functions, each reading the live state', async () => {
    const html = evidence.toReportHtml(await bundle([fw('nist_csf', 'NIST Cybersecurity Framework 2.0', { controls: [{ id: 'backup_restore', label: 'Backups', ready: true, evidence: 'e', why: 'RC.RP-01: backups' }] })]), 'nist_csf');
    for (const f of ['Govern.', 'Identify.', 'Protect.', 'Detect.', 'Respond.', 'Recover.']) expect(html).toContain(`<p>${f}`);
    expect(html).toContain('Recover. The server is backed up');
    expect(html).toContain('Profile summary');
  });
  test('a framework with no prose of its own gets the shared summary, named for it', async () => {
    const html = evidence.toReportHtml(await bundle([fw('soc2', 'SOC 2')]), 'soc2');
    expect(html).toContain('SOC 2 · Readiness report');
    expect(html).toContain('must enter a one-time code');
    expect(html).toContain('held in the trash for 45 days');
  });
  test('refuses a framework that is not in the bundle', async () => {
    expect(() => evidence.toReportHtml({ generatedAt: 'x', frameworks: [] }, 'hipaa')).toThrow(/No such framework/);
  });
  test('the packet is the Safeguards report, and the file name is <firm>-<framework>-report-<date>.html', () => {
    expect(evidence.reportFileName('Bayou Tax & Books, LLC', 'pci_dss', '2026-11-03T12:00:00Z')).toBe('bayou-tax-books-llc-pci-dss-report-2026-11-03.html');
    expect(evidence.reportFileName('', 'hipaa', '2026-11-03T12:00:00Z')).toBe('depot-hipaa-report-2026-11-03.html');
  });
});
