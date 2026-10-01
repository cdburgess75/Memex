// Takes the guide's screenshots from the demo copy.
//
//   node capture/run.js                 # every chapter in shots/
//   node capture/run.js share-file home # only these chapters
//   node capture/run.js share-file --only share-dialog   # one shot
//
// A shot spec (shots/<chapter>.js exports an array):
//   { id, caption,                       // caption doubles as the picture's alt text
//     theme: 'light' | 'dark',
//     device: 'desktop' | 'phone',       // desktop = 1440x900, phone = 390x844
//     width, height,                     // optional viewport override
//     route: '#/home' | '/s/<token>',    // hash route in the app, or a public page path
//     signedOut: false,                  // true = show the sign-in screen
//     setup: async (page) => {},         // optional: open menus/dialogs (page API in cdp.js)
//     callouts: [{ n: 1, selector, place: 'tl'|'tr'|'bl'|'br'|'l'|'r'|'t'|'b', box: true }],
//     clip: { selector, pad } | { x, y, width, height } | undefined (whole viewport),
//     world: '<name>',                   // fixture world; defaults to the chapter name
//     localStorage: { key: value } }     // extra browser storage set before loading
// Output: out/images/<chapter>/<id>.png plus out/images/manifest.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launch, sleep } = require('./cdp');

const G = path.join(__dirname, '..');
const OUT = path.join(G, 'out', 'images');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const chapters = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');

const CALLOUT_COLOR = '#F2542D';   // vivid orange-red: reads on light and dark, unlike the blue accent

function startDemo(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(G, 'demo', 'server.js'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = [];
    proc.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => log.push(l)));
    proc.stdout.on('data', d => { if (String(d).includes('Depot demo on')) resolve({ proc, log }); });
    proc.on('exit', c => reject(new Error('demo server exited ' + c + '\n' + log.join('\n'))));
    setTimeout(() => reject(new Error('demo server did not start')), 8000);
  });
}

async function drawCallouts(page, callouts) {
  if (!callouts || !callouts.length) return [];
  return page.eval((list, color) => {
    document.getElementById('__guide_callouts')?.remove();
    const layer = document.createElement('div');
    layer.id = '__guide_callouts';
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const missing = [];
    for (const c of list) {
      const el = document.querySelector(c.selector);
      if (!el) { missing.push(c.selector); continue; }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) { missing.push(c.selector + ' (hidden)'); continue; }
      if (c.box !== false) {
        const b = document.createElement('div');
        b.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:3px solid ${color};border-radius:10px;box-sizing:border-box;box-shadow:0 0 0 2px rgba(255,255,255,.85)`;
        layer.appendChild(b);
      }
      const D = 30, place = c.place || 'tl';
      const pos = {
        tl: [r.left - D / 2 - 4, r.top - D / 2 - 4], tr: [r.right - D / 2 + 4, r.top - D / 2 - 4],
        bl: [r.left - D / 2 - 4, r.bottom - D / 2 + 4], br: [r.right - D / 2 + 4, r.bottom - D / 2 + 4],
        l: [r.left - D - 10, r.top + r.height / 2 - D / 2], r: [r.right + 10, r.top + r.height / 2 - D / 2],
        t: [r.left + r.width / 2 - D / 2, r.top - D - 10], b: [r.left + r.width / 2 - D / 2, r.bottom + 10],
      }[place] || [r.left - D / 2, r.top - D / 2];
      const x = Math.max(2, Math.min(innerWidth - D - 2, pos[0])), y = Math.max(2, Math.min(innerHeight - D - 2, pos[1]));
      const n = document.createElement('div');
      n.textContent = String(c.n);
      n.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${D}px;height:${D}px;border-radius:50%;background:${color};color:#fff;font:700 17px/30px Inter,system-ui,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)`;
      layer.appendChild(n);
    }
    document.body.appendChild(layer);
    return missing;
  }, callouts, CALLOUT_COLOR);
}

async function clipFor(page, clip) {
  if (!clip) return undefined;
  if (clip.selector) {
    const r = await page.eval((sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; }, clip.selector);
    if (!r) throw new Error('clip selector not found: ' + clip.selector);
    const pad = clip.pad ?? 16;
    const vw = await page.eval(() => [innerWidth, innerHeight]);
    const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
    return { x, y, width: Math.min(vw[0] - x, r.width + pad * 2), height: Math.min(vw[1] - y, r.height + pad * 2) };
  }
  return clip;
}

async function main() {
  const shotDir = path.join(G, 'shots');
  const all = fs.readdirSync(shotDir).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
  const todo = chapters.length ? chapters : all;
  const port = 8800 + Math.floor(Math.random() * 150);
  const demo = await startDemo(port);
  const chrome = await launch();
  const manifestFile = path.join(OUT, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
  let failures = 0;
  try {
    for (const ch of todo) {
      delete require.cache[require.resolve(path.join(shotDir, ch + '.js'))];
      const shots = require(path.join(shotDir, ch + '.js'));
      for (const shot of shots) {
        if (only && shot.id !== only) continue;
        const logStart = demo.log.length;
        const page = await chrome.newPage();
        const phone = shot.device === 'phone';
        const w = shot.width || (phone ? 390 : 1440), h = shot.height || (phone ? 844 : 900);
        const rec = { chapter: ch, id: shot.id, caption: shot.caption || '', theme: shot.theme || 'light', device: shot.device || 'desktop', file: `${ch}/${shot.id}.png` };
        try {
          await page.viewport(w, h, { mobile: phone, scale: 2 });
          await page.colorScheme(shot.theme === 'dark' ? 'dark' : 'light');
          const base = `http://127.0.0.1:${port}`;
          // Seed the browser: a demo "session" (the demo server accepts any token) and the theme.
          await page.goto(base + '/__blank', { waitMs: 50 });
          await page.eval((signedOut, theme, worldName) => {
            localStorage.clear();
            document.cookie = 'demo_world=' + worldName + '; path=/';
            if (!signedOut) { localStorage.setItem('memex_access_token', 'demo'); localStorage.setItem('memex_refresh_token', 'demo'); localStorage.setItem('memex_token_exp', String(Date.now() + 864e5)); }
            localStorage.setItem('memex_theme', theme);
            if (window.__guideLocalStorage) {}
          }, !!shot.signedOut, shot.theme === 'dark' ? 'dark' : 'light', shot.world || ch);
          if (shot.localStorage) await page.eval((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, shot.localStorage);
          const route = shot.route || '#/home';
          await page.goto(route.startsWith('/') ? base + route : base + '/' + route, { waitMs: 1500 });
          if (shot.setup) await shot.setup(page);
          await sleep(shot.settleMs ?? 500);
          const missing = await drawCallouts(page, shot.callouts);
          if (missing.length) rec.missingCallouts = missing;
          await sleep(100);
          const clip = await clipFor(page, shot.clip);
          await page.screenshot(path.join(OUT, rec.file), clip);
          rec.ok = !missing.length;
        } catch (e) { rec.ok = false; rec.error = e.message; failures++; }
        rec.unmocked = demo.log.slice(logStart).filter(l => l.startsWith('UNMOCKED') || l.startsWith('FIXTURE ERROR'));
        rec.consoleErrors = page.consoleErrors.slice(0, 10);
        manifest[`${ch}/${shot.id}`] = rec;
        console.log(`${rec.ok ? 'ok  ' : 'FAIL'} ${rec.file}${rec.error ? '  ' + rec.error : ''}${rec.missingCallouts ? '  missing callouts: ' + rec.missingCallouts.join(', ') : ''}${rec.unmocked.length ? '  unmocked: ' + rec.unmocked.length : ''}`);
        for (const l of rec.unmocked) console.log('      ' + l);
        for (const l of rec.consoleErrors) console.log('      console ' + l);
        await page.close();
      }
    }
  } finally {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
    await chrome.close();
    demo.proc.kill();
  }
  process.exitCode = failures ? 1 : 0;
}
main().catch(e => { console.error(e); process.exit(1); });
