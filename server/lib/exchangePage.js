'use strict';
// The page an external recipient lands on. No account, no SPA, no framework —
// one self-contained document, because the person opening it is a client who
// was sent a file and should not have to learn anything.
//
// Two halves: the file that was sent to them, and (when the sender allowed it)
// somewhere to send files back. `token` is pre-sanitized by the caller.
module.exports = function exchangePage(token) {
  const t = JSON.stringify(String(token || ''));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Shared file — Depot</title>
<style>
  :root { --accent:#C2603D; --accent-soft:#A94E2F; --ink:#242424; --ink-soft:#5b5b5b; --rule:#e5e2dd; --paper:#F4F1EA; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
         background:var(--paper); color:var(--ink); font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  .card { width:100%; max-width:520px; background:#fff; border:1px solid var(--rule); border-radius:16px;
          box-shadow:0 8px 30px rgba(0,0,0,.06); padding:28px; }
  .brand { display:flex; align-items:center; gap:10px; }
  .brand-logo { width:30px; height:30px; border-radius:8px; background:var(--accent); color:#fff; font-weight:700;
                display:inline-flex; align-items:center; justify-content:center; }
  h1 { font-size:19px; margin:16px 0 4px; word-break:break-word; }
  .sub { color:var(--ink-soft); font-size:14px; margin:0 0 18px; }
  .file-row { display:flex; align-items:center; gap:12px; border:1px solid var(--rule); border-radius:12px;
              padding:14px; background:#faf7f3; }
  .file-row .meta { min-width:0; }
  .file-row .nm { font-weight:600; word-break:break-word; }
  .file-row .sz { color:var(--ink-soft); font-size:13px; }
  label { display:block; font-weight:600; font-size:13px; margin:16px 0 5px; }
  input[type=text], input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--rule); border-radius:9px; font:inherit; }
  input:focus { outline:2px solid rgba(194,96,61,.25); border-color:var(--accent); }
  .btn { margin-top:16px; width:100%; border:0; border-radius:10px; background:var(--accent); color:#fff; padding:12px;
         font:600 15px inherit; cursor:pointer; text-align:center; text-decoration:none; display:block; }
  .btn:hover { background:var(--accent-soft); }
  .btn:disabled { opacity:.55; cursor:default; }
  .btn.ghost { background:#fff; color:var(--ink); border:1px solid var(--rule); }
  .btn.ghost:hover { background:#faf7f3; }
  hr.sep { border:0; border-top:1px solid var(--rule); margin:26px 0 0; }
  .drop { margin-top:8px; border:2px dashed var(--rule); border-radius:12px; padding:24px 16px; text-align:center;
          color:var(--ink-soft); cursor:pointer; transition:.15s; }
  .drop:hover, .drop.over { border-color:var(--accent); background:#faf5f1; color:var(--ink); }
  .files { margin-top:10px; display:flex; flex-direction:column; gap:6px; max-height:230px; overflow:auto; }
  .f { display:flex; justify-content:space-between; gap:10px; font-size:13px; background:#faf7f3; border:1px solid var(--rule);
       border-radius:8px; padding:7px 10px; }
  .f .p { color:var(--ink-soft); min-width:0; word-break:break-all; }
  .f .st { white-space:nowrap; color:var(--ink-soft); }
  .f .st.ok { color:#2E7D32; } .f .st.err { color:#C0392B; }
  .note { margin-top:14px; font-size:12px; color:var(--ink-soft); text-align:center; }
  .msg { padding:14px; border-radius:10px; font-size:14px; }
  .msg.err { background:#fdecea; color:#8a2b20; }
  .hidden { display:none; }
</style>
</head>
<body>
<div class="card">
  <div class="brand"><span class="brand-logo">D</span><strong>Depot</strong></div>

  <div id="loading" class="sub" style="margin-top:16px">Loading…</div>

  <div id="gone" class="hidden">
    <h1>Link unavailable</h1>
    <p class="sub" id="gone-msg">This link is no longer active.</p>
  </div>

  <div id="lock" class="hidden">
    <h1>Password required</h1>
    <p class="sub">This file is protected. The person who sent it will have given you the password separately.</p>
    <label for="pw">Password</label>
    <input type="password" id="pw" autocomplete="off">
    <button class="btn" id="unlock">Unlock</button>
    <div class="msg err hidden" id="lock-err" style="margin-top:12px"></div>
  </div>

  <div id="main" class="hidden">
    <h1 id="title">A file was shared with you</h1>
    <p class="sub" id="sent-by"></p>
    <div class="file-row">
      <div class="meta">
        <div class="nm" id="fname"></div>
        <div class="sz" id="fsize"></div>
      </div>
    </div>
    <a class="btn" id="dl" href="#">Download</a>
    <div class="note" id="expiry"></div>

    <div id="up" class="hidden">
      <hr class="sep">
      <h1 style="font-size:17px">Send files back</h1>
      <p class="sub">Drop files or a whole folder — no account needed. <span id="uplimit"></span></p>
      <div class="drop" id="drop">
        <strong>Choose files</strong> or drag them here<br>
        <span style="font-size:13px">Folders keep their structure.</span>
      </div>
      <input type="file" id="pick" multiple class="hidden">
      <input type="file" id="pickdir" webkitdirectory directory multiple class="hidden">
      <div style="display:flex;gap:8px">
        <button class="btn ghost" id="bfiles" style="flex:1">Choose files</button>
        <button class="btn ghost" id="bdir" style="flex:1">Choose a folder</button>
      </div>
      <div class="files" id="list"></div>
      <button class="btn" id="send" disabled>Upload</button>
    </div>
  </div>
</div>

<script>
(function () {
  var TOKEN = ${t};
  var API = '/api/files/share/' + TOKEN;
  var pw = '';
  var ticket = '';
  var queue = [];
  var sending = false;
  // Password travels in a header, never the URL — a query-string password lands
  // in proxy access logs and browser history, defeating the second factor.
  function pwHeaders() { return pw ? { 'X-Share-Password': pw } : {}; }
  // Uploads and downloads present a TICKET (proof the password was entered),
  // minted once here. It keeps the password off the high-volume upload path, so
  // that path can't be used to guess the password. No password → no ticket.
  function ensureTicket() {
    if (!pw) return Promise.resolve('');
    if (ticket) return Promise.resolve(ticket);
    return fetch(API + '/ticket', { method: 'POST', headers: pwHeaders() })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { throw new Error(j.error || 'Could not authorize'); }); })
      .then(function (j) { ticket = j.ticket; return ticket; });
  }

  var $ = function (id) { return document.getElementById(id); };
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function fmt(n) {
    if (!n && n !== 0) return '';
    var u = ['B', 'KB', 'MB', 'GB']; var i = 0; var v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i ? v.toFixed(1) : v) + ' ' + u[i];
  }

  function load() {
    fetch(API + '/info', { headers: pwHeaders() }).then(function (r) {
      if (r.status === 410) throw new Error('This link has expired.');
      if (r.status === 404) throw new Error('This link is no longer active.');
      return r.json();
    }).then(function (info) {
      hide('loading');
      if (info.needsPassword && !info.unlocked) {
        hide('main'); show('lock');
        if (pw) { $('lock-err').textContent = 'That password did not work.'; show('lock-err'); }
        return;
      }
      hide('lock'); show('main');
      $('fname').textContent = info.name || 'File';
      $('fsize').textContent = fmt(info.size);
      $('sent-by').textContent = info.sentBy ? 'Sent by ' + info.sentBy : '';
      $('expiry').textContent = info.expiresAt
        ? 'This link expires ' + new Date(info.expiresAt).toLocaleDateString(undefined, { dateStyle: 'long' }) + '.'
        : '';
      if (info.allowUpload) {
        show('up');
        $('uplimit').textContent = 'Up to ' + info.maxUploadMb + ' MB per file.';
      }
    }).catch(function (e) {
      hide('loading'); hide('lock'); hide('main');
      $('gone-msg').textContent = e.message; show('gone');
    });
  }

  // Download without ever putting the password in the URL: exchange it for a
  // short-lived ticket (POST, password in a header), then navigate with the
  // ticket. No password → the plain link works directly.
  $('dl').addEventListener('click', function (e) {
    e.preventDefault();
    if (!pw) { window.location = API; return; }
    var btn = $('dl'); var label = btn.textContent; btn.textContent = 'Preparing…';
    ensureTicket()
      .then(function (tk) { window.location = API + '?dl=' + encodeURIComponent(tk); btn.textContent = label; })
      .catch(function (err) { btn.textContent = label; alert(err.message); });
  });

  $('unlock').addEventListener('click', function () { pw = $('pw').value; hide('lock-err'); load(); });
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('unlock').click(); });

  function add(files) {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      queue.push({ file: f, path: f.webkitRelativePath || f.name, state: 'queued' });
    }
    render();
  }
  function render() {
    $('list').innerHTML = queue.map(function (q, i) {
      var cls = q.state === 'done' ? 'ok' : (q.state === 'failed' ? 'err' : '');
      var st = q.state === 'done' ? 'Sent' : (q.state === 'failed' ? (q.error || 'Failed') : (q.state === 'sending' ? 'Sending…' : fmt(q.file.size)));
      return '<div class="f"><span class="p">' + q.path.replace(/[<>&]/g, '') + '</span><span class="st ' + cls + '">' + st + '</span></div>';
    }).join('');
    // Enabled while a batch is NOT running and something needs sending — queued
    // OR a previously failed item (so a transient blip is retryable, not a
    // dead end). During a batch the button stays disabled regardless, which is
    // what stops a mid-batch double-click starting a second concurrent loop.
    var pendingCount = queue.filter(function (q) { return q.state === 'queued' || q.state === 'failed'; }).length;
    $('send').disabled = sending || pendingCount === 0;
    $('send').textContent = pendingCount && queue.some(function (q) { return q.state === 'failed'; }) ? 'Retry / upload' : 'Upload';
  }

  $('bfiles').addEventListener('click', function () { $('pick').click(); });
  $('bdir').addEventListener('click', function () { $('pickdir').click(); });
  $('drop').addEventListener('click', function () { $('pick').click(); });
  $('pick').addEventListener('change', function (e) { add(e.target.files); e.target.value = ''; });
  $('pickdir').addEventListener('change', function (e) { add(e.target.files); e.target.value = ''; });

  ['dragenter', 'dragover'].forEach(function (ev) {
    $('drop').addEventListener(ev, function (e) { e.preventDefault(); $('drop').classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    $('drop').addEventListener(ev, function (e) { e.preventDefault(); $('drop').classList.remove('over'); });
  });
  // Dragging a folder gives directory entries, not files — walk them so the
  // tree arrives intact rather than silently dropping everything but the top.
  $('drop').addEventListener('drop', function (e) {
    e.preventDefault();
    var items = e.dataTransfer.items;
    if (!items || !items.length || !items[0].webkitGetAsEntry) { add(e.dataTransfer.files); return; }
    var pending = 0, collected = [];
    function done() { if (--pending <= 0) { collected.forEach(function (c) { queue.push(c); }); render(); } }
    function walk(entry, prefix) {
      if (entry.isFile) {
        pending++;
        entry.file(function (f) { collected.push({ file: f, path: prefix + f.name, state: 'queued' }); done(); }, done);
      } else if (entry.isDirectory) {
        pending++;
        var reader = entry.createReader();
        (function readMore() {
          reader.readEntries(function (entries) {
            if (!entries.length) { done(); return; }
            entries.forEach(function (en) { walk(en, prefix + entry.name + '/'); });
            readMore();
          }, done);
        })();
      }
    }
    pending = 1;
    for (var i = 0; i < items.length; i++) {
      var en = items[i].webkitGetAsEntry();
      if (en) walk(en, '');
    }
    done();
  });

  $('send').addEventListener('click', function () {
    if (sending) return;                      // hard guard against a double-click
    // Requeue anything that failed last round so a retry actually retries.
    queue.forEach(function (q) { if (q.state === 'failed') { q.state = 'queued'; q.error = null; } });
    var pendingItems = queue.filter(function (q) { return q.state === 'queued'; });
    if (!pendingItems.length) return;
    sending = true;
    render();
    ensureTicket().then(function () {
      var idx = 0;
      (function next() {
        if (idx >= pendingItems.length) { sending = false; render(); return; }
        var q = pendingItems[idx++];
        q.state = 'sending'; render();
        var fd = new FormData();
        fd.append('file', q.file);
        fd.append('relativePath', q.path);
        // The ticket authorises the upload (see ensureTicket) — no password here.
        fetch(API + '/upload', { method: 'POST', headers: ticket ? { 'X-Share-Ticket': ticket } : {}, body: fd })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
          .then(function (res) {
            if (res.ok) { q.state = 'done'; }
            else {
              q.state = 'failed';
              // A stale ticket (long folder drop past its lifetime) → drop it so
              // the next Upload click re-mints, and say so plainly.
              if (res.status === 401) { ticket = ''; q.error = 'Session expired — click Upload again.'; }
              else { q.error = res.j && res.j.error ? res.j.error : 'Failed'; }
            }
            render(); next();
          })
          .catch(function () { q.state = 'failed'; q.error = 'Network error'; render(); next(); });
      })();
    }).catch(function (err) {
      sending = false;
      queue.forEach(function (q) { if (q.state === 'queued') { q.state = 'failed'; q.error = err.message; } });
      render();
    });
  });

  load();
})();
</script>
</body>
</html>`;
};
