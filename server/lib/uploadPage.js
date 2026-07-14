'use strict';
// Self-contained public upload page for inbound "file request" links. No auth,
// no SPA — a non-member drops files here and they land in the link owner's
// library. `token` is pre-sanitized (alphanumeric) by the caller.
module.exports = function uploadPage(token) {
  const t = JSON.stringify(String(token || ''));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Upload files — Depot</title>
<style>
  :root { --accent:#C2603D; --accent-soft:#A94E2F; --ink:#242424; --ink-soft:#5b5b5b; --rule:#e5e2dd; --paper:#F4F1EA; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
         background:var(--paper); color:var(--ink); font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  .card { width:100%; max-width:460px; background:#fff; border:1px solid var(--rule); border-radius:16px;
          box-shadow:0 8px 30px rgba(0,0,0,.06); padding:28px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .brand-logo { width:30px; height:30px; border-radius:8px; background:var(--accent); color:#fff; font-weight:700;
                display:inline-flex; align-items:center; justify-content:center; }
  h1 { font-size:19px; margin:14px 0 4px; }
  .sub { color:var(--ink-soft); font-size:14px; margin:0 0 18px; }
  label { display:block; font-weight:600; font-size:13px; margin:14px 0 5px; }
  input[type=text], input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--rule); border-radius:9px; font:inherit; }
  input:focus { outline:2px solid rgba(194,96,61,.25); border-color:var(--accent); }
  .drop { margin-top:6px; border:2px dashed var(--rule); border-radius:12px; padding:26px 16px; text-align:center;
          color:var(--ink-soft); cursor:pointer; transition:.15s; }
  .drop:hover, .drop.over { border-color:var(--accent); background:#faf5f1; color:var(--ink); }
  .files { margin-top:10px; display:flex; flex-direction:column; gap:6px; }
  .file { display:flex; justify-content:space-between; gap:10px; font-size:13px; background:#faf7f3; border:1px solid var(--rule);
          border-radius:8px; padding:7px 10px; }
  .file .st { color:var(--ink-soft); }
  .file .st.ok { color:#2E7D32; } .file .st.err { color:#C0392B; }
  button { margin-top:18px; width:100%; border:0; border-radius:10px; background:var(--accent); color:#fff; padding:12px;
           font:600 15px inherit; cursor:pointer; }
  button:hover { background:var(--accent-soft); }
  button:disabled { opacity:.55; cursor:default; }
  .note { margin-top:14px; font-size:12px; color:var(--ink-soft); text-align:center; }
  .msg { padding:14px; border-radius:10px; font-size:14px; }
  .msg.err { background:#fdecea; color:#8a2b20; }
  .hidden { display:none; }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="brand"><span class="brand-logo">D</span><strong>Depot</strong></div>
  <div id="loading" class="sub">Loading…</div>

  <div id="gone" class="hidden"><h1>Link unavailable</h1><p class="sub" id="gone-msg">This upload link is no longer active.</p></div>

  <form id="form" class="hidden" onsubmit="return false">
    <h1 id="title">Upload files</h1>
    <p class="sub" id="desc">Drop files below — they'll be sent securely to the requester.</p>

    <label for="name">Your name <span style="font-weight:400;color:var(--ink-soft)">(optional)</span></label>
    <input type="text" id="name" autocomplete="name" placeholder="So they know who it's from">

    <div id="pwrap" class="hidden">
      <label for="pw">Password</label>
      <input type="password" id="pw" placeholder="Required to upload">
    </div>

    <label>Files</label>
    <div class="drop" id="drop" onclick="picker.click()">Click to choose files, or drag &amp; drop</div>
    <div style="text-align:center;margin-top:8px"><button type="button" id="folderbtn" style="background:none;border:0;color:var(--accent);font:inherit;cursor:pointer;padding:4px;width:auto;margin:0">or upload a whole folder</button></div>
    <input type="file" id="picker" multiple class="hidden">
    <input type="file" id="folderpicker" webkitdirectory multiple class="hidden">
    <div class="files" id="files"></div>

    <button id="send" disabled>Upload</button>
    <div class="note">Uploaded to a private Depot library. Only the requester can see your files.</div>
  </form>

  <div id="done" class="hidden"><h1>✓ Thank you</h1><p class="sub" id="done-msg">Your files were uploaded.</p></div>
</div>

<script>
const TOKEN = ${t};
const el = id => document.getElementById(id);
let chosen = [];

async function init() {
  try {
    const r = await fetch('/api/files/upload-link/' + TOKEN + '/info');
    if (!r.ok) { showGone(r.status === 410 ? 'This upload link has expired.' : 'This upload link is not valid.'); return; }
    const info = await r.json();
    el('loading').classList.add('hidden');
    el('form').classList.remove('hidden');
    if (info.label) { el('title').textContent = info.label; }
    if (info.needsPassword) el('pwrap').classList.remove('hidden');
  } catch { showGone('Could not reach the server. Try again later.'); }
}
function showGone(msg) { el('loading').classList.add('hidden'); el('gone').classList.remove('hidden'); el('gone-msg').textContent = msg; }

const drop = el('drop'), picker = el('picker'), folderpicker = el('folderpicker');
el('folderbtn').addEventListener('click', () => folderpicker.click());
folderpicker.addEventListener('change', () => addFiles(folderpicker.files));
['dragenter','dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave','drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', ev => addFiles(ev.dataTransfer.files));
picker.addEventListener('change', () => addFiles(picker.files));
function addFiles(list) {
  for (const f of list) chosen.push(f);
  renderFiles();
}
function renderFiles() {
  el('files').innerHTML = chosen.map((f, i) => '<div class="file"><span>' + escapeHtml(f.webkitRelativePath || f.name) + '</span><span class="st" id="st' + i + '">' + fmt(f.size) + '</span></div>').join('');
  el('send').disabled = chosen.length === 0;
}
function fmt(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(0) + ' KB' : (n/1048576).toFixed(1) + ' MB'; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

el('send').addEventListener('click', async () => {
  if (!chosen.length) return;
  el('send').disabled = true;
  const pw = el('pw') ? el('pw').value : '';
  const name = el('name').value.trim();
  let ok = 0, fail = 0;
  for (let i = 0; i < chosen.length; i++) {
    const st = el('st' + i); st.textContent = 'Uploading…'; st.className = 'st';
    const fd = new FormData();
    fd.append('file', chosen[i]);
    if (chosen[i].webkitRelativePath) fd.append('relativePath', chosen[i].webkitRelativePath);
    if (name) fd.append('uploaderName', name);
    if (pw) fd.append('password', pw);
    try {
      const r = await fetch('/api/files/upload-link/' + TOKEN, { method: 'POST', body: fd });
      if (r.ok) { st.textContent = '✓ Sent'; st.className = 'st ok'; ok++; }
      else { const e = await r.json().catch(() => ({})); st.textContent = e.error === 'Upload password required' ? 'Password?' : 'Failed'; st.className = 'st err'; fail++; }
    } catch { st.textContent = 'Failed'; st.className = 'st err'; fail++; }
  }
  if (ok && !fail) {
    el('form').classList.add('hidden'); el('done').classList.remove('hidden');
    el('done-msg').textContent = ok + ' file' + (ok === 1 ? '' : 's') + ' uploaded. You can close this page.';
  } else {
    el('send').disabled = false;
    if (fail) el('send').textContent = 'Retry failed uploads';
  }
});

init();
</script>
</body>
</html>`;
};
