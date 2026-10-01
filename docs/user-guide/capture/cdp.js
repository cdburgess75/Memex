// Minimal Chrome DevTools Protocol driver: no npm packages beyond Node 22 built-ins.
// Launches the system Chrome headless with its own throwaway profile.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));

async function launch({ port = 9300 + Math.floor(Math.random() * 500) } = {}) {
  if (!CHROME) throw new Error('Chrome not found; set CHROME=/path/to/chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-guide-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank',
  ], { stdio: 'ignore' });
  let version;
  for (let i = 0; i < 100; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(100); }
  }
  if (!version) { proc.kill(); throw new Error('Chrome did not start'); }
  const browser = await connect(version.webSocketDebuggerUrl);
  return {
    browser,
    async newPage() {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find(x => x.id === targetId);
      const s = await connect(t.webSocketDebuggerUrl);
      await s.send('Page.enable'); await s.send('Runtime.enable');
      return makePage(s);
    },
    async close() { try { await browser.send('Browser.close'); } catch {} proc.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} },
  };
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map(); const listeners = [];
    ws.onopen = () => resolve({
      send(method, params = {}) { return new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej, method }); ws.send(JSON.stringify({ id: i, method, params })); }); },
      on(fn) { listeners.push(fn); },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(p.method + ': ' + m.error.message)) : p.res(m.result); }
      else listeners.forEach(fn => fn(m));
    };
  });
}

function makePage(s) {
  const console_ = [];
  s.on(m => {
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) console_.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') console_.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  const page = {
    session: s,
    consoleErrors: console_,
    async viewport(width, height, { mobile = false, scale = 2 } = {}) {
      await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
      if (mobile) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    },
    async colorScheme(value) { await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }, { name: 'prefers-reduced-motion', value: 'reduce' }] }); },
    async goto(u, { waitMs = 600 } = {}) {
      const loaded = new Promise(r => { const f = (m) => { if (m.method === 'Page.loadEventFired') r(); }; s.on(f); });
      await s.send('Page.navigate', { url: u });
      await Promise.race([loaded, sleep(15000)]);
      await sleep(waitMs);
    },
    async eval(fnOrExpr, ...args) {
      const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})` : fnOrExpr;
      const r = await s.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async waitFor(selector, timeout = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { if (await page.eval((sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, selector)) return true; await sleep(100); }
      throw new Error('waitFor timed out: ' + selector);
    },
    async click(selector) {
      const box = await page.eval((sel) => { const e = document.querySelector(sel); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);
      if (!box) throw new Error('click: not found ' + selector);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(250);
    },
    async hover(selector) {
      const box = await page.eval((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);
      if (box) await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await sleep(200);
    },
    async type(text) { await s.send('Input.insertText', { text }); await sleep(150); },
    async key(key) { for (const type of ['keyDown', 'keyUp']) await s.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0 }); await sleep(150); },
    async screenshot(file, clip) {
      const params = { format: 'png', captureBeyondViewport: false };
      if (clip) params.clip = { ...clip, scale: 1 };
      const r = await s.send('Page.captureScreenshot', params);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async pdf(file, opts = {}) {
      const r = await s.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, ...opts });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async close() { try { s.close(); } catch {} },
  };
  return page;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
module.exports = { launch, sleep };
