'use strict';
// The page a folder link opens. No account, no SPA, no framework: one self-contained
// document, for somebody who was sent a folder and should not have to learn anything.
// It lists the folder, lets them walk into subfolders, download any file on its own, and
// download the folder -- or the subfolder they are in -- as a ZIP.
//
// Every name on it arrives from the server as DATA and is written with textContent. Nothing
// here ever builds markup from a file or folder name. Files are downloads, never rendered:
// this is a public origin, and a preview of somebody's upload is how a link page gets owned.
// `token` is pre-sanitized by the caller.
module.exports = function folderPage(token) {
  const t = JSON.stringify(String(token || ''));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Shared folder — Depot</title>
<style>
  :root { --accent:#C2603D; --accent-soft:#A94E2F; --ink:#242424; --ink-soft:#5b5b5b; --rule:#e5e2dd; --paper:#F4F1EA; --well:#faf7f3; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; padding:24px 16px 40px; background:var(--paper); color:var(--ink);
         font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  .card { width:100%; max-width:760px; margin:0 auto; background:#fff; border:1px solid var(--rule); border-radius:16px;
          box-shadow:0 8px 30px rgba(0,0,0,.06); padding:24px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:600; }
  .brand-logo { width:30px; height:30px; border-radius:8px; background:var(--accent); color:#fff; display:inline-flex; align-items:center; justify-content:center; }
  .brand-logo svg { width:19px; height:19px; }
  h1 { font-size:20px; margin:16px 0 2px; overflow-wrap:anywhere; }
  .sub { color:var(--ink-soft); font-size:14px; margin:0 0 16px; }
  .crumbs { display:flex; flex-wrap:wrap; align-items:center; gap:4px; font-size:14px; margin:0 0 10px; color:var(--ink-soft); }
  .crumb { border:0; background:transparent; padding:2px 4px; min-height:24px; font:inherit; color:var(--accent-soft); cursor:pointer; border-radius:5px; }
  .crumb:hover { text-decoration:underline; } .crumb[aria-current] { color:var(--ink); font-weight:600; cursor:default; text-decoration:none; }
  .bar { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:0 0 10px; }
  .count { font-size:13px; color:var(--ink-soft); }
  ul.list { list-style:none; margin:0; padding:0; border:1px solid var(--rule); border-radius:12px; overflow:hidden; }
  .row { display:flex; align-items:center; gap:12px; padding:10px 14px; min-height:52px; background:#fff; }
  .row + .row { border-top:1px solid var(--rule); }
  .row .ic { flex:none; width:22px; height:22px; color:var(--ink-soft); }
  .row .meta { flex:1; min-width:0; }
  .row .nm { font-weight:600; overflow-wrap:anywhere; }
  .row .sz { color:var(--ink-soft); font-size:13px; }
  button.open { all:unset; box-sizing:border-box; display:flex; align-items:center; gap:12px; flex:1; min-width:0; cursor:pointer; border-radius:8px; }
  button.open:hover .nm { text-decoration:underline; }
  .btn { border:0; border-radius:10px; background:var(--accent); color:#fff; padding:10px 16px; font:600 14px inherit; cursor:pointer;
         text-decoration:none; display:inline-flex; align-items:center; justify-content:center; min-height:40px; }
  .btn:hover { background:var(--accent-soft); }
  .btn.ghost { background:#fff; color:var(--ink); border:1px solid var(--rule); padding:8px 12px; min-height:36px; font-size:13px; white-space:nowrap; }
  .btn.ghost:hover { background:var(--well); }
  .btn[aria-disabled="true"] { opacity:.5; pointer-events:none; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  label { display:block; font-weight:600; font-size:13px; margin:16px 0 5px; }
  input[type=password] { width:100%; max-width:340px; padding:10px 12px; border:1px solid var(--rule); border-radius:9px; font:16px inherit; }
  .note { margin-top:14px; font-size:12.5px; color:var(--ink-soft); }
  .msg { padding:14px; border-radius:10px; font-size:14px; margin-top:12px; }
  .msg.err { background:#fdecea; color:#8a2b20; } .msg.info { background:var(--well); color:var(--ink-soft); }
  .hidden { display:none !important; }
  @media (max-width:520px) { .card { padding:18px 14px; } .row { padding:10px; } }
</style>
</head>
<body>
<main class="card">
  <div class="brand"><span class="brand-logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M12 2.4l8 3v6.2c0 4.9-3.3 8.9-8 10.4-4.7-1.5-8-5.5-8-10.4V5.4zM8.9 8.1h6.2a1 1 0 0 1 0 2h-6.2a1 1 0 0 1 0-2zM8.9 11.8h6.2a1 1 0 0 1 0 2h-6.2a1 1 0 0 1 0-2zM10.7 15.5h2.6a1 1 0 0 1 0 2h-2.6a1 1 0 0 1 0-2z"/></svg></span>Depot</div>

  <div id="loading"><h1>Opening folder…</h1></div>

  <div id="gone" class="hidden"><h1>This link isn't available</h1><div id="gone-msg" class="msg err" role="alert"></div></div>

  <form id="lock" class="hidden" autocomplete="off">
    <h1>This folder is password protected</h1>
    <p class="sub">Enter the password the sender gave you.</p>
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="off" required>
    <div id="lock-err" class="msg err hidden" role="alert"></div>
    <p><button class="btn" type="submit">Open folder</button></p>
  </form>

  <div id="main" class="hidden">
    <h1 id="fname"></h1>
    <p class="sub"><span id="sent-by"></span> <span id="expiry"></span></p>
    <nav class="crumbs" id="crumbs" aria-label="Folders"></nav>
    <div class="bar"><span class="count" id="count" role="status"></span><a class="btn" id="zip" href="#" download></a></div>
    <div id="zip-note" class="msg info hidden"></div>
    <div id="busy" class="msg err hidden" role="alert"></div>
    <ul class="list" id="list"></ul>
    <p id="empty" class="msg info hidden">This folder is empty.</p>
    <p class="note" id="live-note"></p>
  </div>
</main>
<script>
(function () {
  var TOKEN = ${t};
  var API = '/api/files/folder/share/' + encodeURIComponent(TOKEN);
  var $ = function (id) { return document.getElementById(id); };
  function show(id) { $(id).classList.remove('hidden'); } function hide(id) { $(id).classList.add('hidden'); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function fmt(n) { var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = Number(n) || 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return (i ? v.toFixed(1) : v) + ' ' + u[i]; }
  function icon(d) { var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true'); var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.appendChild(p); return s; }
  var FOLDER = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', FILE = 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5';

  // A ticket proves entry: minted from the password here, or handed over (in the URL's
  // fragment, which is never sent to a server) by Depot for a link that needs a sign-in.
  var ticket = (location.hash.match(/(?:^#|&)t=([^&]+)/) || [])[1]; ticket = ticket ? decodeURIComponent(ticket) : '';
  if (ticket) { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
  var path = '';
  function headers() { return ticket ? { 'X-Share-Ticket': ticket } : {}; }
  function withTicket(u) { return ticket ? u + (u.indexOf('?') < 0 ? '?' : '&') + 'dl=' + encodeURIComponent(ticket) : u; }

  // "Opened" is a PERSON looking, not a page load: reported once, on the first real input.
  var reported = false;
  function reportOpenOnce() {
    if (reported) return; var evs = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    function fire() { if (reported) return; reported = true; evs.forEach(function (n) { window.removeEventListener(n, fire, true); });
      try { fetch(API + '/opened', { method: 'POST', headers: headers(), keepalive: true }).catch(function () {}); } catch (e) {} }
    evs.forEach(function (n) { window.addEventListener(n, fire, { capture: true, passive: true }); });
  }

  function fail(msg) { hide('loading'); hide('lock'); hide('main'); $('gone-msg').textContent = msg; show('gone'); }

  function load(sub) {
    fetch(API + '/info?path=' + encodeURIComponent(sub || ''), { headers: headers() }).then(function (r) {
      if (r.status === 410) throw new Error('This link has expired.');
      if (r.status === 404) throw new Error(sub ? 'That folder is no longer in this link.' : 'This link is no longer active.');
      if (!r.ok) throw new Error('Something went wrong opening this folder. Try again in a moment.');
      return r.json();
    }).then(function (info) {
      hide('loading');
      if (info.needsPassword && !info.unlocked) { hide('main'); show('lock'); $('pw').focus(); return; }
      hide('lock'); show('main'); reportOpenOnce();
      path = info.path || '';
      $('fname').textContent = info.name || 'Folder';
      document.title = (info.name || 'Shared folder') + ' — Depot';
      $('sent-by').textContent = info.sentBy ? 'Sent by ' + info.sentBy + '.' : '';
      $('expiry').textContent = info.expiresAt ? 'This link expires ' + new Date(info.expiresAt).toLocaleDateString(undefined, { dateStyle: 'long' }) + '.' : '';
      $('live-note').textContent = info.live ? 'This shows the folder as it is now, including anything added since it was sent.' : 'This shows the files that were in the folder when the link was made.';
      draw(info);
    }).catch(function (e) { fail(e.message); });
  }

  function draw(info) {
    var crumbs = $('crumbs'); crumbs.textContent = '';
    var parts = path ? path.split('/') : [];
    function crumb(label, to, current) { var b = el('button', 'crumb', label); b.type = 'button'; if (current) b.setAttribute('aria-current', 'page'); else b.onclick = function () { load(to); }; return b; }
    crumbs.appendChild(crumb(info.name || 'Folder', '', !parts.length));
    parts.forEach(function (p, i) { crumbs.appendChild(el('span', null, '/')); crumbs.appendChild(crumb(p, parts.slice(0, i + 1).join('/'), i === parts.length - 1)); });

    $('count').textContent = info.count + (info.count === 1 ? ' file' : ' files') + ' · ' + fmt(info.bytes);
    var here = parts.length ? parts[parts.length - 1] : (info.name || 'folder');
    var zip = $('zip'); zip.textContent = 'Download "' + here + '" as ZIP';
    zip.href = withTicket(API + '/zip?path=' + encodeURIComponent(path));
    var ok = info.zip && info.zip.allowed;
    zip.setAttribute('aria-disabled', ok ? 'false' : 'true'); if (!ok) zip.removeAttribute('href');
    hide('busy');
    if (!ok && info.count) { $('zip-note').textContent = 'This folder is ' + fmt(info.bytes) + ', larger than the ' + fmt((info.zip ? info.zip.limitMb : 0) * 1048576) + ' a single ZIP may be. Download files one at a time, or open a subfolder and download that.'; show('zip-note'); } else hide('zip-note');

    var list = $('list'); list.textContent = '';
    (info.folders || []).forEach(function (f) {
      var li = el('li', 'row'), b = el('button', 'open'); b.type = 'button'; b.setAttribute('aria-label', 'Open folder ' + f.name);
      b.appendChild(icon(FOLDER)); var m = el('span', 'meta'); m.appendChild(el('div', 'nm', f.name)); m.appendChild(el('div', 'sz', f.files + (f.files === 1 ? ' file' : ' files') + ' · ' + fmt(f.bytes))); b.appendChild(m);
      b.onclick = function () { load(f.path); }; li.appendChild(b); list.appendChild(li);
    });
    (info.files || []).forEach(function (f) {
      var li = el('li', 'row'); li.appendChild(icon(FILE));
      var m = el('div', 'meta'); m.appendChild(el('div', 'nm', f.name)); m.appendChild(el('div', 'sz', fmt(f.size))); li.appendChild(m);
      var a = el('a', 'btn ghost', 'Download'); a.href = withTicket(API + '/file/' + encodeURIComponent(f.id)); a.setAttribute('download', ''); a.setAttribute('aria-label', 'Download ' + f.name);
      li.appendChild(a); list.appendChild(li);
    });
    if (!(info.folders || []).length && !(info.files || []).length) { hide('list'); show('empty'); } else { show('list'); hide('empty'); }
    window.scrollTo(0, 0);
  }

  // A ZIP that cannot start (too many others building) answers JSON, which a plain link
  // would show as a page of text. Ask first; start the real download only if it can run.
  $('zip').addEventListener('click', function (e) {
    var a = this; if (!a.href || a.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    e.preventDefault(); hide('busy');
    fetch(withTicket(API + '/zip?check=1&path=' + encodeURIComponent(path)), { headers: headers() }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (x.ok && x.j && x.j.ok) { window.location.href = a.href; } else { $('busy').textContent = (x.j && x.j.error) || 'That download could not start. Try again in a minute.'; show('busy'); } })
      .catch(function () { $('busy').textContent = 'That download could not start. Check your connection and try again.'; show('busy'); });
  });

  $('lock').addEventListener('submit', function (e) {
    e.preventDefault(); hide('lock-err');
    fetch(API + '/ticket', { method: 'POST', headers: { 'X-Share-Password': $('pw').value } }).then(function (r) {
      if (r.status === 401) throw new Error('That password did not work.');
      if (!r.ok) throw new Error('This link is no longer active.');
      return r.json();
    }).then(function (j) { ticket = j.ticket; $('pw').value = ''; load(''); })
      .catch(function (err) { $('lock-err').textContent = err.message; show('lock-err'); $('pw').select(); });
  });

  load('');
})();
</script>
</body>
</html>`;
};
