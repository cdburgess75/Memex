// Demo copy of Depot for the user guide. Serves the real SPA (repo-root index.html)
// and answers every /api call from made-up fixtures, so each screen renders exactly
// as the live app would, with no sign-in and no real data.
//
//   node demo/server.js [--port 8790]
//
// Fixtures live in demo/fixtures/*.js. Each exports { routes, presence } where routes
// maps "METHOD /api/path/:param" to a handler ({ req, params, query, body, res }) =>
// JSON value (or { __file, type } to send a file, or { __status, body }), or to a
// plain value. base.js holds the shared world (Acme Co., people, libraries, files).
// A chapter may add fixtures/<chapter>.js; its routes win over base.js, and it is
// loaded only for pages whose demo_world cookie names that chapter.
// Any /api call without a fixture is logged as "UNMOCKED" and answered with 404.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.join(__dirname, '..', '..', '..');           // repo root
const INDEX = path.join(ROOT, 'index.html');
const VENDOR = path.join(ROOT, 'vendor');
const PORT = +(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.env.PORT || 8790);

// A "world" is base.js plus, optionally, one chapter's fixture file. The capture
// runner sets a demo_world cookie per chapter, so chapters never step on each other.
function compile(file) {
  const table = [];
  delete require.cache[require.resolve(file)];
  const mod = require(file);
  for (const [key, handler] of Object.entries(mod.routes || {})) {
    const sp = key.indexOf(' ');
    const method = key.slice(0, sp), pattern = key.slice(sp + 1);
    const names = [];
    const re = new RegExp('^' + pattern.split('/').map(seg => seg.startsWith(':') ? (names.push(seg.slice(1)), '([^/]+)') : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$');
    table.push({ method, pattern, re, names, handler, file: path.basename(file) });
  }
  return { table, presence: mod.presence };
}
const worldCache = new Map();
function world(name) {
  const key = name || '';
  if (worldCache.has(key)) return worldCache.get(key);
  const dir = path.join(__dirname, 'fixtures');
  const base = compile(path.join(dir, 'base.js'));
  let extra = { table: [], presence: undefined };
  if (name && /^[a-z0-9-]+$/.test(name) && fs.existsSync(path.join(dir, name + '.js'))) extra = compile(path.join(dir, name + '.js'));
  const w = { routes: [...extra.table, ...base.table], presence: extra.presence || base.presence || {} };
  worldCache.set(key, w);
  return w;
}
function worldOf(req) { const m = /(?:^|;\s*)demo_world=([a-z0-9-]+)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; }

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });
}
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8' };
function sendFile(res, file, type) {
  try { const buf = fs.readFileSync(file); res.writeHead(200, { 'content-type': type || MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(buf); }
  catch { res.writeHead(404); res.end(); }
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = decodeURIComponent(u.pathname);
  if (p === '/__reload') { worldCache.clear(); res.end('reloaded'); return; }
  if (p.startsWith('/vendor/')) return sendFile(res, path.join(VENDOR, p.slice('/vendor/'.length)));
  if (p.startsWith('/demo-assets/')) return sendFile(res, path.join(__dirname, 'assets', p.slice('/demo-assets/'.length)));
  // Public pages an outside recipient sees: rendered by the real server templates.
  if (p.startsWith('/s/')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(require(path.join(ROOT, 'server', 'lib', 'exchangePage.js'))(p.slice(3).replace(/[^a-zA-Z0-9_-]/g, ''))); }
  if (p.startsWith('/f/')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(require(path.join(ROOT, 'server', 'lib', 'folderPage.js'))(p.slice(3).replace(/[^a-zA-Z0-9_-]/g, ''))); }
  if (p.startsWith('/api/') || p.startsWith('/realms/')) {
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    for (const r of world(worldOf(req)).routes) {
      if (r.method !== req.method && r.method !== '*') continue;
      const m = p.match(r.re);
      if (!m) continue;
      const params = {}; r.names.forEach((n, i) => { params[n] = m[i + 1]; });
      try {
        let out = typeof r.handler === 'function' ? await r.handler({ req, params, query: u.query, body, res }) : r.handler;
        if (res.writableEnded) return;
        if (out && out.__file) return sendFile(res, out.__file, out.type);
        if (out && out.__status) { res.writeHead(out.__status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out.body || {})); }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(out === undefined ? {} : out));
      } catch (e) { console.error('FIXTURE ERROR', req.method, p, e.stack); res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    }
    console.error('UNMOCKED', req.method, p + (u.search || ''));
    res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'not in demo' }));
  }
  // Everything else is the SPA shell, unmodified.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(INDEX));
});

// Presence and call signalling: the demo tells the page who is "online".
try {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const presence = world(worldOf(req)).presence || {};
      const onConnect = presence.onConnect || (() => []);
      for (const msg of onConnect()) ws.send(JSON.stringify(msg));
      ws.on('message', (data) => { let m; try { m = JSON.parse(data); } catch { return; } for (const reply of (presence.onMessage ? presence.onMessage(m) : [])) ws.send(JSON.stringify(reply)); });
    });
  });
} catch (e) { console.error('ws unavailable, presence disabled:', e.message); }

server.listen(PORT, '127.0.0.1', () => console.log(`Depot demo on http://127.0.0.1:${PORT}`));
