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
}));
jest.mock('../../lib/accessReview', () => ({
  build: jest.fn().mockResolvedValue({ generatedAt: 'x', userCount: 2, openLibraries: ['Public'], users: [
    { email: 'dave@x.com', name: 'Dave', role: 'admin', libraries: ['all (admin)'], directShares: 0, lastActivity: '2026-07-11T09:00:00Z' },
    { email: 'ann@x.com', name: '', role: 'viewer', libraries: ['Clients'], directShares: 3, lastActivity: null },
  ] }),
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
