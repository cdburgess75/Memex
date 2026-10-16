'use strict';
// The API reference page and the drive helper it hands out (routes/docs.js).
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const express = require('express');

const TOOLS = path.join(__dirname, '..', '..', '..', 'tools', 'depot-drive');
const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };

function app() {
  const a = express();
  a.use('/api/docs', require('../../routes/docs'));
  return a;
}

describe('the API reference page', () => {
  test('renders, and ends with how to connect as a drive, with the helper links on this host', async () => {
    const r = await request(app()).get('/api/docs').set('Host', 'depot.example.com').expect(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('<h1>Depot API</h1>');
    expect(r.text).toContain('id="drive"');
    expect(r.text).toContain('http://depot.example.com/api/docs/depot-drive.sh');
    expect(r.text).toContain('http://depot.example.com/api/docs/depot-drive.ps1');
    expect(r.text).toContain('depot-drive setup http://depot.example.com');
    expect(r.text).not.toMatch(/token as the .?password/i); // the drive signs in as the website does
    expect(r.text).toContain('<a href="#drive">Connect as a drive</a>');
  });
});

describe('the drive helper', () => {
  test('is served as plain text to save, for Mac/Linux and for Windows', async () => {
    const sh = await request(app()).get('/api/docs/depot-drive.sh').expect(200);
    expect(sh.headers['content-type']).toMatch(/text\/plain/);
    expect(sh.headers['content-disposition']).toBe('attachment; filename="depot-drive.sh"');
    expect(sh.text.startsWith('#!/usr/bin/env bash')).toBe(true);
    for (const cmd of ['setup', 'mount', 'token', 'status', 'signout']) expect(sh.text).toContain(`\n  ${cmd})`);
    const ps = await request(app()).get('/api/docs/depot-drive.ps1').expect(200);
    expect(ps.headers['content-type']).toMatch(/text\/plain/);
    expect(ps.text).toContain("'setup'   { Setup $Arg }");
    expect(ps.text).toContain('urn:ietf:params:oauth:grant-type:device_code');
    await request(app()).get('/api/docs/depot-drive.exe').expect(404);
  });

  test('signs in with the device flow as the drive client, asking for a lasting sign-in', () => {
    const fs = require('fs');
    for (const name of ['depot-drive.sh', 'depot-drive.ps1']) {
      const text = fs.readFileSync(path.join(TOOLS, name), 'utf8');
      expect(text).toContain('/protocol/openid-connect/auth/device');
      expect(text).toContain('openid offline_access');
      expect(text).toContain('driveClientId');
      expect(text).toContain('grant_type=refresh_token'.replace('=', name.endsWith('.ps1') ? " = '" : '='));
      expect(text).toContain('/dav/');
      expect(text).toContain('--vfs-cache-mode full');
    }
  });

  (has('bash') ? test : test.skip)('the shell script parses', () => {
    execFileSync('bash', ['-n', path.join(TOOLS, 'depot-drive.sh')]);
  });

  (has('pwsh') ? test : test.skip)('the PowerShell script parses', () => {
    const out = execFileSync('pwsh', ['-NoProfile', '-Command',
      `$t=$null;$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${path.join(TOOLS, 'depot-drive.ps1')}',[ref]$t,[ref]$e) | Out-Null; if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }; 'ok'`]).toString();
    expect(out.trim()).toBe('ok');
  });
});
