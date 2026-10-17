'use strict';
// The API reference, as one readable page built from lib/openapi.js. Self-contained: no
// scripts, no outside styles, so it renders under the same-origin content policy and can
// be read by anyone who wants to write against the API.
const express = require('express');
const path = require('path');
const router = express.Router();
const { spec } = require('../lib/openapi');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A very small Markdown: paragraphs, **bold**, `code` and fenced blocks. Enough for the intro.
function md(text) {
  const blocks = String(text || '').split(/\n{2,}/);
  return blocks.map(b => {
    const fence = b.match(/^```\n?([\s\S]*?)\n?```$/);
    if (fence) return `<pre><code>${esc(fence[1])}</code></pre>`;
    const inline = esc(b).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
    return `<p>${inline}</p>`;
  }).join('\n');
}
const schemaText = (s) => {
  if (!s) return '';
  if (s.$ref) return s.$ref.split('/').pop();
  if (s.allOf) return s.allOf.map(schemaText).join(' + ');
  if (s.type === 'array') return `array of ${schemaText(s.items)}`;
  if (s.type === 'object' && s.properties) return `{ ${Object.entries(s.properties).map(([k, v]) => `${k}: ${schemaText(v)}${v.description ? ` — ${v.description}` : ''}`).join('; ')} }`;
  return [s.type, s.format, s.enum ? `one of ${s.enum.join(', ')}` : '', s.nullable ? 'or null' : ''].filter(Boolean).join(' ');
};

// Depot as a drive (routes/dav.js, tools/depot-drive): how to connect from each kind of computer.
function driveSection(origin) {
  const o = esc(origin);
  return `<section id="drive"><h2>Connect as a drive</h2>
<p>Depot can be opened as a drive on a computer. Each library you can open is a folder at the top; inside are its folders and files, as on the website. You sign in the way you do on the website, Microsoft included; nothing is typed into a password box. What you do on the drive is done as you, with your rights there: saving over a file keeps what it held as a version, and deleting a file sends it to the Trash.</p>
<p>The drive is <strong>rclone</strong> (free, from <a href="https://rclone.org/install/">rclone.org</a>), which keeps a copy of what you open on your computer so files open quickly and work while offline, plus a small helper, <code>depot-drive</code>, that handles the sign-in for it.</p>
<p class="k">Mac</p>
<p>Install rclone (from rclone.org, or <code>brew install rclone</code>), then in Terminal:</p>
<pre><code>mkdir -p ~/.local/bin &amp;&amp; curl -fsSL ${o}/api/docs/depot-drive.sh -o ~/.local/bin/depot-drive &amp;&amp; chmod +x ~/.local/bin/depot-drive
~/.local/bin/depot-drive setup ${o}
~/.local/bin/depot-drive mount</code></pre>
<p>A browser window opens: sign in as you do on the website, then answer <strong>Yes</strong> to "Grant access to Depot Drive". Depot then appears in Finder at <code>~/Depot</code> for as long as the last command runs (Ctrl-C closes the drive).</p>
<p class="k">Windows</p>
<p>Install rclone (from rclone.org) and <a href="https://winfsp.dev">WinFsp</a>, then in PowerShell:</p>
<pre><code>irm ${o}/api/docs/depot-drive.ps1 -OutFile "$env:USERPROFILE\\depot-drive.ps1"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\depot-drive.ps1" setup ${o}
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\depot-drive.ps1" mount</code></pre>
<p>Depot appears as the next free drive letter while the last command runs.</p>
<p class="k">Linux</p>
<p>As on a Mac, with rclone and <code>fuse3</code> from your distribution.</p>
<p>The helper keeps your sign-in (in the Keychain on a Mac; encrypted to your Windows account) and renews it on its own. It ends after 30 days unused, or when an administrator switches you off; <code>depot-drive signout</code> forgets it. To open the drive at every sign-in, rclone's documentation covers running a mount at login. A computer's own housekeeping files (.DS_Store, Thumbs.db, Office's ~$ files) are accepted and discarded. A name Depot would change (one with &amp;, parentheses or accents, say) is refused rather than stored under another name. Not on the drive: the Trash, versions, links and sharing, which stay on the website.</p>
</section>`;
}

// The helper itself, for the instructions above.
const TOOLS = path.join(__dirname, '..', '..', 'tools', 'depot-drive');
for (const name of ['depot-drive.sh', 'depot-drive.ps1']) {
  router.get(`/${name}`, (_req, res) => {
    res.sendFile(path.join(TOOLS, name), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-cache' } });
  });
}

function page(origin) {
  const s = spec();
  const byTag = new Map(s.tags.map(t => [t.name, []]));
  for (const [path, ops] of Object.entries(s.paths)) {
    for (const [method, o] of Object.entries(ops)) byTag.get(o.tags[0])?.push({ path, method, o });
  }
  const nav = [...byTag.keys()].map(t => `<a href="#${esc(t.toLowerCase().replace(/\s+/g, '-'))}">${esc(t)}</a>`).join('') + '<a href="#drive">Connect as a drive</a>';
  const sections = [...byTag].map(([tag, ops]) => `<section id="${esc(tag.toLowerCase().replace(/\s+/g, '-'))}"><h2>${esc(tag)}</h2>${ops.map(({ path, method, o }) => {
    const params = (o.parameters || []).map(p => `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}</td><td>${p.required ? 'yes' : ''}</td><td>${esc(schemaText(p.schema))}${p.description ? ` — ${esc(p.description)}` : ''}</td></tr>`).join('');
    const body = o.requestBody ? Object.entries(o.requestBody.content).map(([ct, c]) => `<p class="k">Body</p><p><code>${esc(ct)}</code>${c.schema && c.schema.properties ? `: ${esc(schemaText(c.schema))}` : ''}${c.schema && c.schema.required?.length ? ` (required: ${esc(c.schema.required.join(', '))})` : ''}</p>`).join('') : '';
    const responses = Object.entries(o.responses).map(([code, r]) => `<tr><td><code>${esc(code)}</code></td><td>${esc(r.description)}${r.content && r.content['application/json']?.schema?.properties ? `<div class="s">${esc(schemaText(r.content['application/json'].schema))}</div>` : ''}</td></tr>`).join('');
    return `<article><h3><span class="m ${esc(method)}">${esc(method.toUpperCase())}</span> <code>/api/v1${esc(path)}</code></h3><p class="sum">${esc(o.summary)} <span class="scope">scope: ${esc(o['x-scope'])}</span></p>${md(o.description.replace(/\n\nScope: \*\*\w+\*\*\./, ''))}${params ? `<p class="k">Parameters</p><table><tr><th>Name</th><th>In</th><th>Required</th><th>Type</th></tr>${params}</table>` : ''}${body}<p class="k">Responses</p><table>${responses}</table></article>`;
  }).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Depot API</title>
<style>
:root{--ink:#17191D;--soft:#5C6069;--rule:#E4E4E8;--well:#F4F4F6;--accent:#0E6FA8;--get:#1F7A4D;--post:#0E6FA8;--put:#8A5A00;--patch:#6B4BB8;--delete:#B3261E}
@media (prefers-color-scheme:dark){:root{--ink:#EDEEF1;--soft:#9AA0AB;--rule:#262B33;--well:#1A1E24;--accent:#3DA3DC;--get:#5BC28A;--post:#6DB8E8;--put:#E0A94C;--patch:#B39DF0;--delete:#F08A84}body{background:#15181D}}
body{margin:0;font:16px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--ink)}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:30px;margin:0 0 6px}h2{font-size:22px;margin:40px 0 12px;padding-top:12px;border-top:1px solid var(--rule)}h3{font-size:17px;margin:28px 0 4px;font-weight:600}
p{margin:8px 0}code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--well);padding:1px 5px;border-radius:4px}pre{background:var(--well);padding:12px 14px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
nav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:18px 0 6px}nav a{color:var(--accent);text-decoration:none;font-weight:600}
.m{display:inline-block;min-width:58px;text-align:center;font:700 12px/1 ui-monospace,Menlo,monospace;padding:5px 7px;border-radius:6px;color:#fff;letter-spacing:.04em;vertical-align:2px}.m.get{background:var(--get)}.m.post{background:var(--post)}.m.put{background:var(--put)}.m.patch{background:var(--patch)}.m.delete{background:var(--delete)}
.sum{font-weight:600;margin:6px 0 2px}.scope{font-weight:500;color:var(--soft);margin-left:8px;font-size:14px}.k{font-weight:600;font-size:13px;color:var(--soft);text-transform:uppercase;letter-spacing:.04em;margin:12px 0 4px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--rule)}th{color:var(--soft);font-weight:600;font-size:13px}.s{color:var(--soft);font-size:13px;margin-top:2px}
article{padding-bottom:6px}
</style></head><body><div class="wrap">
<h1>Depot API</h1><p class="sum">Version 1 · <a href="/api/v1/openapi.json" style="color:var(--accent)">OpenAPI description</a></p>
${md(s.info.description)}
<nav>${nav}</nav>
${sections}
${driveSection(origin)}
</div></body></html>`;
}

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(page(`${req.protocol}://${req.get('host') || 'depot.example.com'}`));
});
module.exports = router;
