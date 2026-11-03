'use strict';
// scripts/host-updates.sh: the facts it reports about nightly OS updates, and when the
// 2:30 a.m. timer restarts the box. apt, docker, systemctl and friends are shimmed on PATH;
// the script is copied into a throwaway install so its .env (UPDATE_RING) is the test's.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'host-updates.sh');
const havePy = spawnSync('python3', ['--version']).status === 0;
const d = havePy ? describe : describe.skip;

let tmp, shims, root, state, flag, log;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-updates-'));
  shims = path.join(tmp, 'bin'); fs.mkdirSync(shims);
  root = path.join(tmp, 'memex'); fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'host-updates.sh'));
  state = path.join(tmp, 'state');
  flag = path.join(tmp, 'reboot-required');
  log = path.join(tmp, 'uu.log');
  const shim = (name, body) => { const p = path.join(shims, name); fs.writeFileSync(p, '#!/usr/bin/env bash\n' + body); fs.chmodSync(p, 0o755); };
  shim('apt', 'printf "%s" "${APT_OUT:-Listing...\n}"\n');
  shim('docker', 'exit 1\n');
  shim('pgrep', 'exit 1\n');
  shim('logger', 'exit 0\n');
  shim('systemctl', `echo "$*" >> "${tmp}/systemctl.calls"\n`);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(arg, { ring, env = {} } = {}) {
  fs.writeFileSync(path.join(root, '.env'), ring === undefined ? '' : `UPDATE_RING=${ring}\n`);
  const r = spawnSync('bash', [path.join(root, 'scripts', 'host-updates.sh'), arg], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, DEPOT_STATE_DIR: state, DEPOT_REBOOT_FLAG: flag,
      DEPOT_UU_LOG: log, DEPOT_HOLD_FILE: path.join(tmp, 'hold'), DEPOT_APT_CONF: path.join(tmp, '52depot'), ...env },
  });
  return r;
}
const json = (r) => JSON.parse(r.stdout.trim().split('\n').pop());
const rebooted = () => (fs.existsSync(path.join(tmp, 'systemctl.calls')) ? fs.readFileSync(path.join(tmp, 'systemctl.calls'), 'utf8') : '').includes('reboot');
const stamp = (when) => { const p = (n) => String(n).padStart(2, '0'); return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())}:${p(when.getSeconds())},000`; };

d('host-updates.sh --json', () => {
  test('a clean last run, what is waiting, and no restart needed', () => {
    const at = new Date(Date.now() - 3 * 3600e3);
    fs.writeFileSync(log, [
      `${stamp(new Date(at - 86400e3))} INFO Starting unattended upgrades script`,
      `${stamp(new Date(at - 86400e3))} ERROR an older failure that no longer counts`,
      `${stamp(at)} INFO Starting unattended upgrades script`,
      `${stamp(at)} INFO All upgrades installed`,
    ].join('\n'));
    const out = json(run('--json', { env: { APT_OUT: 'Listing...\nsystemd/resolute-updates 259.9 amd64 [upgradable from: 259.5]\nopenssl/resolute-security 3.5.1 amd64 [upgradable from: 3.5.0]\n' } }));
    expect(out.last_run.result).toBe('ok');
    expect(Math.abs(new Date(out.last_run.started_at) - at)).toBeLessThan(2000);
    expect(out.pending).toEqual({ total: 2, security: 1 });
    expect(out.reboot).toMatchObject({ required: false, since: null, ring: 1, wait_hours: 20, held: false });
    expect(out.managed).toBe(false);
  });

  test('an error in the last run is a failure, with its message', () => {
    fs.writeFileSync(log, `${stamp(new Date())} INFO Starting unattended upgrades script\n${stamp(new Date())} ERROR dpkg returned an error code (1)\n`);
    expect(json(run('--json')).last_run).toMatchObject({ result: 'failed', message: 'dpkg returned an error code (1)' });
  });

  test('a waiting restart keeps the time it first appeared, and forgets it once done', () => {
    fs.writeFileSync(flag, '*** System restart required ***\n');
    fs.writeFileSync(flag + '.pkgs', 'linux-base\nlinux-image-7.0.0-42-generic\nlinux-base\n');
    const first = json(run('--json', { ring: 0 }));
    expect(first.reboot).toMatchObject({ required: true, packages: ['linux-base', 'linux-image-7.0.0-42-generic'], ring: 0, wait_hours: 0 });
    fs.writeFileSync(path.join(state, 'reboot-required-since'), String(Math.floor(Date.now() / 1000) - 5 * 3600));
    fs.writeFileSync(flag, 'rewritten by a later update\n');
    expect(Date.now() - new Date(json(run('--json')).reboot.since)).toBeGreaterThan(4.9 * 3600e3);
    fs.rmSync(flag);
    expect(json(run('--json')).reboot).toMatchObject({ required: false, since: null });
    expect(fs.existsSync(path.join(state, 'reboot-required-since'))).toBe(false);
  });
});

d('host-updates.sh --reboot-if-due', () => {
  const waiting = (hours) => {
    fs.writeFileSync(flag, 'x\n');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'reboot-required-since'), String(Math.floor(Date.now() / 1000) - hours * 3600));
  };

  test('nothing waiting: no restart', () => {
    run('--reboot-if-due', { ring: 0 });
    expect(rebooted()).toBe(false);
  });

  test('ring 0 restarts the same night', () => {
    waiting(1);
    const r = run('--reboot-if-due', { ring: 0 });
    expect(rebooted()).toBe(true);
    expect(r.stdout).toMatch(/restarting to finish updates/);
    expect(fs.readFileSync(path.join(state, 'last-reboot'), 'utf8')).toMatch(/^\d{4}-/);
  });

  test('later rings, and a box with no ring set, wait a night', () => {
    waiting(1);
    expect(run('--reboot-if-due', { ring: 1 }).stdout).toMatch(/restarts tomorrow night/);
    expect(run('--reboot-if-due').stdout).toMatch(/restarts tomorrow night/);
    expect(rebooted()).toBe(false);
    waiting(25);
    run('--reboot-if-due', { ring: 1 });
    expect(rebooted()).toBe(true);
  });

  test('a hold stops it', () => {
    waiting(48);
    fs.writeFileSync(path.join(tmp, 'hold'), '');
    expect(run('--reboot-if-due', { ring: 0 }).stdout).toMatch(/held/);
    expect(rebooted()).toBe(false);
  });

  test('not while updates are still installing', () => {
    waiting(48);
    fs.writeFileSync(path.join(shims, 'pgrep'), '#!/usr/bin/env bash\nexit 0\n');
    expect(run('--reboot-if-due', { ring: 0 }).stdout).toMatch(/still installing/);
    expect(rebooted()).toBe(false);
  });
});

// Never as root: on a root Linux runner --install would set up the machine running the tests.
(havePy && process.getuid() !== 0 ? describe : describe.skip)('host-updates.sh --install without root', () => {
  test('changes nothing and says why', () => {
    const r = run('--install');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not setting up/);
  });
});
