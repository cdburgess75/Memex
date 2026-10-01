// Small pictures the Word file needs and cannot draw itself: the shield tile, the dark
// page background, and the drawing and icons on "How to use this guide". Drawn by the same
// headless Chrome that prints the PDF, from the same colours, so both files match.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { REPO, markSvg, calloutExampleHtml, EXAMPLE_W, EXAMPLE_H } = require('./lib');

const FONT_URL = pathToFileURL(path.join(REPO, 'vendor', 'fonts', 'inter-var.woff2')).href;

const TILE_CSS = 'width:96px;height:96px;border-radius:26px;background:linear-gradient(165deg,#4DABE0,#2E86BC);color:#08131B;display:grid;place-items:center';

async function renderAssets(chrome) {
  const page = await chrome.newPage();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-guide-assets-'));
  await page.session.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const shot = async (inner, w, h, scale) => {
    const f = path.join(tmp, 'a.html');
    fs.writeFileSync(f, `<!doctype html><html><head><style>@font-face{font-family:Inter;font-weight:100 900;src:url('${FONT_URL}') format('woff2')}html,body{margin:0;background:transparent}svg{width:70%;height:70%;display:block}</style></head><body><div style="width:${w}px;height:${h}px;position:relative">${inner}</div></body></html>`);
    await page.viewport(Math.max(w, 50), Math.max(h, 50), { scale });
    await page.goto(pathToFileURL(f).href, { waitMs: 80 });
    await page.eval(() => document.fonts.ready.then(() => true));
    const out = path.join(tmp, 'a.png');
    await page.screenshot(out, { x: 0, y: 0, width: w, height: h });
    return fs.readFileSync(out);
  };
  try {
    return {
      tile: await shot(`<div style="${TILE_CSS}">${markSvg()}</div>`, 96, 96, 4),
      darkBg: await shot('<div style="position:absolute;inset:0;background:#0D0F12"></div>', 102, 132, 1),
      example: await shot(calloutExampleHtml(), EXAMPLE_W, EXAMPLE_H, 4),
      icons: {
        dot: await shot('<div style="position:absolute;left:10px;top:10px;width:9px;height:9px;border-radius:50%;background:#0E6FA8"></div>', 29, 29, 4),
        badge: await shot('<div style="position:absolute;inset:0;border-radius:50%;background:#F2542D;color:#fff;font:750 17px/29px Inter,-apple-system,Segoe UI,Arial,sans-serif;text-align:center">1</div>', 29, 29, 4),
        swatch: await shot('<div style="position:absolute;inset:0;border-radius:7px;overflow:hidden;display:flex;box-shadow:inset 0 0 0 1px #CBCBD2"><i style="flex:1;background:#FBFBFC"></i><i style="flex:1;background:#0D0F12"></i></div>', 29, 29, 4),
      },
    };
  } finally {
    await page.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { renderAssets };
