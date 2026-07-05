'use strict';
// Same-origin reverse proxy for the Collabora (WOPI) editor, so the browser
// loads the editor from Memex's own origin — no separate :9980 port to expose or
// forward, and it works behind the TLS reverse proxy at go-live. Proxies the
// Collabora asset/endpoint paths (HTTP) and the editing WebSocket (raw TCP relay)
// to the internal collabora service.
const http = require('http');
const net = require('net');
const { URL } = require('url');
const settings = require('./settings');

const PREFIXES = ['/browser', '/hosting', '/cool', '/lool'];

function isCollaboraPath(p) {
  const path = String(p || '');
  return PREFIXES.some(pre => path === pre || path.startsWith(pre + '/') || path.startsWith(pre + '?'));
}

async function target() {
  const raw = (await settings.getOrEnv('collabora_internal_url')) || 'http://collabora:9980';
  return new URL(raw);
}

// Express-style handler: transparently proxy an HTTP request to Collabora.
function httpMiddleware(req, res) {
  target().then((t) => {
    const preq = http.request(
      {
        hostname: t.hostname,
        port: Number(t.port) || 9980,
        method: req.method,
        path: req.originalUrl || req.url,
        // Keep the ORIGINAL Host — Collabora derives its CSP frame-ancestors and
        // WS/connect URLs from it. Overriding to collabora:9980 makes it emit a
        // CSP that blocks the same-origin iframe (blank editor).
        headers: { ...req.headers },
      },
      (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); }
    );
    preq.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('collabora proxy error'); });
    req.pipe(preq);
  }).catch(() => { if (!res.headersSent) res.writeHead(502); res.end('collabora unavailable'); });
}

// Relay a WebSocket upgrade to Collabora at the TCP level (works for any WS
// framing — no re-encoding). Called from the server 'upgrade' handler.
function handleUpgrade(req, socket, head) {
  target().then((t) => {
    const upstream = net.connect(Number(t.port) || 9980, t.hostname, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      raw += '\r\n';
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }).catch(() => socket.destroy());
}

module.exports = { isCollaboraPath, httpMiddleware, handleUpgrade, PREFIXES };
