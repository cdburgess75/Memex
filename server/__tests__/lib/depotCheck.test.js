'use strict';
// scripts/depot-check.sh reports the license: the field it prints, and which states
// are WARN or CRIT. Everything the script shells out to is shimmed on PATH; the
// license answer comes from a fake `docker` that prints what the app would.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'depot-check.sh');
const haveJq = spawnSync('jq', ['--version']).status === 0;
const d = haveJq ? describe : describe.skip;

let tmp, shims, root;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-check-'));
  shims = path.join(tmp, 'bin'); fs.mkdirSync(shims);
  root = path.join(tmp, 'memex'); fs.mkdirSync(root);
  const docs = path.join(tmp, 'docs'); fs.mkdirSync(docs);
  fs.writeFileSync(path.join(root, '.env'), `PORT=3000\nMEMEX_MODE=local\nMEMEX_DOCS_DIR=${docs}\n`);
  const shim = (name, body) => { const p = path.join(shims, name); fs.writeFileSync(p, '#!/usr/bin/env bash\n' + body); fs.chmodSync(p, 0o755); };
  shim('timeout', 'shift; exec "$@"\n');
  shim('tailscale', 'exit 1\n');
  shim('curl', 'case "$*" in *healthz*) echo "{\\"db\\":\\"up\\",\\"version\\":\\"v2026.10.16.002\\"}";; *) exit 1;; esac\n');
  shim('docker', [
    'case "$*" in',
    '  *psql*) printf "backup_enabled|true\\nbackup_interval_hours|24\\nbackup_last_run|%s\\nbackup_last_status|{\\"ok\\":true}\\n" "$(( $(date +%s) * 1000 ))";;',
    '  *license*) [ -n "${LIC_FAIL:-}" ] && exit 1; echo "$LIC_LINE";;',
    '  *) exit 1;;',
    'esac',
    '',
  ].join('\n'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(licLine, extra = {}) {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, MEMEX_ROOT: root, LIC_LINE: licLine, ...extra } });
  const out = r.stdout.trim();
  const reasons = (/reasons=(\S+)/.exec(out) || [, ''])[1].split(',').filter(Boolean);
  return { status: r.status, out, reasons, field: (/\blicense=(\S+)/.exec(out) || [])[1] };
}

d('depot-check.sh license field', () => {
  test('an accepted license in good standing is license=ok and no reason', () => {
    const r = run('yes ok 200 ok');
    expect(r.field).toBe('ok');
    expect(r.reasons.filter((x) => x.startsWith('license'))).toEqual([]);
    expect(r.status).not.toBe(2);
    expect(r.out).toMatch(/^DEPOT (OK|WARN) /);
  });

  test('a perpetual term prints a dash for days and is still ok', () => {
    expect(run('yes ok - ok').field).toBe('ok');
  });

  test('expiring with 14 days or more is informational; inside 14 days is WARN', () => {
    const far = run('yes expiring 20 expiring');
    expect(far.field).toBe('expiring:20d');
    expect(far.reasons).not.toContain('license_expiring');
    const near = run('yes expiring 10 expiring');
    expect(near.field).toBe('expiring:10d');
    expect(near.reasons).toContain('license_expiring');
    expect(near.status).toBeGreaterThanOrEqual(1);
  });

  test('lapsed and read-only are CRIT', () => {
    const lapsed = run('yes lapsed -3 lapsed');
    expect(lapsed).toMatchObject({ status: 2, field: 'lapsed' });
    expect(lapsed.reasons).toContain('license_lapsed');
    const ro = run('yes readonly -40 readonly');
    expect(ro).toMatchObject({ status: 2, field: 'readonly' });
    expect(ro.reasons).toContain('license_readonly');
  });

  test('a license that was not accepted is CRIT and names the reason', () => {
    const r = run('no unlicensed - domain_mismatch');
    expect(r).toMatchObject({ status: 2, field: 'invalid:domain_mismatch' });
    expect(r.reasons).toContain('license_invalid');
  });

  test('no answer from the app is WARN, never a crash', () => {
    const r = run('', { LIC_FAIL: '1' });
    expect(r.field).toBe('unknown');
    expect(r.reasons).toContain('license_unknown');
    expect(r.status).toBeGreaterThanOrEqual(1);
    expect(r.out).toMatch(/^DEPOT /);
  });
});
