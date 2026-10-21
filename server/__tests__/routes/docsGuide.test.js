'use strict';
// /api/docs/guide: the plain-language guide beside the reference. It must stay true to the
// API it teaches, so every call it shows is held to lib/openapi.js, and it must stay
// readable anywhere: one page, no scripts, written for the Depot it is read on.
const express = require('express');
const request = require('supertest');
const { spec } = require('../../lib/openapi');
const guide = require('../../lib/apiGuide');

const app = express();
app.use('/api/docs', require('../../routes/docs'));

const paths = spec().paths;

// Does a concrete sample path (after /api/v1) match a documented one? {id}-style parts match
// one segment; {path} matches the rest of the line.
function documented(samplePath) {
  const segs = samplePath.split('/').filter(Boolean);
  return Object.keys(paths).some(p => {
    const parts = p.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '{path}') return segs.length > i;
      if (segs[i] === undefined) return false;
      if (parts[i].startsWith('{')) continue;
      if (parts[i] !== segs[i]) return false;
    }
    return parts.length === segs.length;
  });
}

describe('the guide page', () => {
  test('is served as one self-contained HTML page, written for this Depot', async () => {
    const r = await request(app).get('/api/docs/guide').set('Host', 'depot.acme.test').expect(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.text).toContain('<h1>Using the Depot API</h1>');
    expect(r.text).toContain('export DEPOT=http://depot.acme.test');
    expect(r.text).toContain("$Depot = &#39;http://depot.acme.test&#39;");
    expect(r.text).not.toMatch(/<script/i);
    expect(r.text).not.toContain('depot.example.com');
    for (const s of guide.sections()) expect(r.text).toContain(`<section id="${s.id}"><h2>${s.title.replace(/'/g, '&#39;')}</h2>`);
  });
  test('the reference links to it, and it links back', async () => {
    const ref = await request(app).get('/api/docs').expect(200);
    expect(ref.text).toContain('<a href="/api/docs/guide">New here? Start with the guide</a>');
    const g = await request(app).get('/api/docs/guide').expect(200);
    expect(g.text).toContain('<a href="/api/docs">The reference: every call</a>');
    expect(g.text).toContain('<a href="/api/docs#drive">Connect as a drive</a>');
  });
  test('every call it teaches exists in the API description, with that method', () => {
    for (const [method, path] of guide.TEACHES) {
      expect(paths[path]).toBeDefined();
      expect(Object.keys(paths[path])).toContain(method.toLowerCase());
    }
  });
  test('every sample URL is a documented path', () => {
    const urls = [];
    for (const s of guide.sections('https://depot.example.com')) {
      for (const b of s.blocks) {
        if (!b.code) continue;
        for (const m of b.text.matchAll(/\/api\/v1(\/[^\s"'`?)]*)/g)) urls.push(m[1]);
      }
    }
    expect(urls.length).toBeGreaterThan(30);
    const bad = urls.filter(u => !documented(u.replace(/<[a-z-]+>|\$\([^)]*\)|\$[A-Za-z_]+|[^/]+@[^/]+/g, 'x').replace(/\/x\/x$/, '/x')));
    expect(bad).toEqual([]);
  });
  test('samples come in pairs, curl and PowerShell, for the everyday tasks', () => {
    const everyday = ['first-call', 'libraries', 'list', 'upload', 'download', 'search', 'links', 'shares', 'trash', 'activity'];
    for (const id of everyday) {
      const s = guide.sections().find(x => x.id === id);
      expect(s.blocks.some(b => b.code === 'curl')).toBe(true);
      expect(s.blocks.some(b => b.code === 'powershell')).toBe(true);
    }
  });
  test('no token or secret-looking value is printed as real', () => {
    const text = JSON.stringify(guide.sections());
    expect(text).not.toMatch(/depot_[A-Za-z0-9]{43}/);
    expect(text).toContain('depot_YOUR_TOKEN');
  });
});
