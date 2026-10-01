// Builds the PDF: model -> HTML (pdf-template.html) -> headless Chrome Page.printToPDF.
// Two passes: the first finds the page each Part and Chapter starts on (from the PDF's
// own bookmarks), the second prints those numbers in the contents.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { REPO, markSvg, howToUse, runs, calloutExampleHtml, CALLOUT_EXAMPLE_ALT } = require('./lib');

const FONT = path.join(REPO, 'vendor', 'fonts', 'inter-var.woff2');
const TEMPLATE = path.join(__dirname, 'pdf-template.html');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inl = (s) => runs(s).map(r => (r.bold ? `<strong>${esc(r.text)}</strong>` : esc(r.text))).join('');
const inlRuns = (rs) => rs.map(r => (r.bold ? `<strong>${esc(r.text)}</strong>` : esc(r.text))).join('');
const SEP = '<span class="sep">&nbsp;·&nbsp;</span>';

function renderHtml(model, pages = null) {
  const pg = (key) => (pages && pages[key] ? String(pages[key]) : pages ? '' : '00');
  const b = [];

  // Cover: the mark, the title, the subtitle, the edition. Nothing else.
  b.push(`<section class="cover">
  <div class="tile" aria-hidden="true">${markSvg()}</div>
  <div class="words">
    <div class="rule"></div>
    <h1>${esc(model.title)}</h1>
    <p class="subtitle">${esc(model.subtitle)}</p>
  </div>
  <div class="edition">${esc(model.edition)}</div>
</section>`);

  // Contents.
  const toc = [];
  toc.push(`<li class="row front-row"><span class="num"></span><a class="t" href="#how-to-use">How to use this guide</a><span class="pg">${pg('howto')}</span></li>`);
  for (const p of model.parts) {
    toc.push(`<li class="part-row"><a href="#part-${p.n}">Part ${p.n} · ${esc(p.title)}</a><span class="pg">${pg('part-' + p.n)}</span></li>`);
    for (const ch of p.chapters) {
      toc.push(`<li class="row"><span class="num">${ch.n}</span><a class="t" href="#ch-${esc(ch.id)}">${esc(ch.title)}</a><span class="pg">${pg('ch-' + ch.n)}</span></li>`);
    }
  }
  b.push(`<section class="front" id="contents"><h1 class="page-title">Contents</h1><ol class="toc">${toc.join('\n')}</ol></section>`);

  // How to use this guide.
  const how = howToUse(model);
  const icons = [
    '<span class="dot"></span>',
    '<span class="badge">1</span>',
    '<span class="dot"></span>',
    '<span class="swatch"><i></i><i></i></span>',
    '<span class="dot"></span>',
  ];
  const example = `<figure class="example" role="img" aria-label="${esc(CALLOUT_EXAMPLE_ALT)}">${calloutExampleHtml()}</figure>`;
  b.push(`<section class="front" id="how-to-use"><h1 class="page-title">How to use this guide</h1><ul class="howto">${how.map((rs, i) => `<li><div class="ico">${icons[i] || icons[0]}</div><div>${inlRuns(rs)}${i === 1 ? example : ''}</div></li>`).join('')}</ul></section>`);

  for (const p of model.parts) {
    b.push(`<section class="part" id="part-${p.n}">
  <h1><span class="eyebrow">Part ${p.n}${SEP}</span><span class="title">${esc(p.title)}</span></h1>
  <div class="rule"></div>
  <ol>${p.chapters.map(ch => `<li><span class="num">${ch.n}</span><span>${esc(ch.title)}</span></li>`).join('')}</ol>
</section>`);
    for (const ch of p.chapters) b.push(renderChapter(ch));
  }

  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  return tpl
    .replace(/\{\{TITLE\}\}/g, esc(model.title))
    .replace(/\{\{SUBTITLE\}\}/g, esc(model.subtitle))
    .replace('{{FONT_URL}}', pathToFileURL(FONT).href)
    .replace('{{BODY}}', b.join('\n'));
}

function renderChapter(ch) {
  const out = [`<section class="chapter" id="ch-${esc(ch.id)}" data-theme="${esc(ch.theme)}">
  <header class="band">
    <h1><span class="eyebrow">Chapter ${ch.n}${SEP}</span><span class="title">${esc(ch.title)}</span></h1>
    ${ch.intro ? `<p class="intro">${inl(ch.intro)}</p>` : ''}
  </header>`];
  for (const s of ch.sections) {
    // The heading, lead text, picture and steps travel together; bullets and boxes may flow on.
    const head = [];
    if (s.heading) head.push(`<h2>${inl(s.heading)}</h2>`);
    s.text.forEach((t) => head.push(`<p>${inl(t)}</p>`));
    const steps = s.steps.length ? `<ol class="steps">${s.steps.map((t, i) => `<li><span class="badge">${i + 1}</span><div>${inl(t)}</div></li>`).join('')}</ol>` : '';
    const bullets = s.bullets.length ? `<ul class="bullets">${s.bullets.map(t => `<li>${inl(t)}</li>`).join('')}</ul>` : '';
    const boxes = [];
    if (s.tip) boxes.push(`<aside class="box tip"><span class="label">Tip</span><p>${inl(s.tip)}</p></aside>`);
    if (s.note) boxes.push(`<aside class="box note"><span class="label">Note</span><p>${inl(s.note)}</p></aside>`);
    const tail = [];
    let body;
    if (s.picture) {
      const { size } = s.picture;
      const img = `<figure class="pic ${size.layout}"><img src="${pathToFileURL(s.picture.pdfFile || s.picture.file).href}" alt="${esc(s.picture.alt)}" data-w="${size.w}" data-h="${size.h}" style="width:${size.w}in;height:${size.h}in"></figure>`;
      // A tall picture (a phone) sits beside its steps, and the Tip/Note go under the steps.
      if (size.layout === 'side') { head.push(`<div class="side" style="--pic-w:${size.w}in">${img}<div>${steps}${bullets}${boxes.join('')}</div></div>`); body = `<div class="keep">${head.join('')}</div>`; }
      else {
        // The heading, its lead text, the picture and the steps are ONE keep-together block.
        // When the picture does not fit in the room left on a page, the whole section moves
        // to the next page and the page before simply ends early, at a section boundary.
        // (Splitting the heading and lead text off into their own block was tried: it left
        // a heading and one sentence stranded at the foot of a page with their picture and
        // steps overleaf, which reads as missing content. See QA on share-folder p15/16,
        // light-dark p25 and connections p39.)
        body = `<div class="keep">${head.join('')}${img}${steps}</div>`;
        tail.push(bullets, ...boxes);
      }
    } else { head.push(steps); body = `<div class="keep">${head.join('')}</div>`; tail.push(bullets, ...boxes); }
    out.push(`<section class="sec">${body}${tail.join('')}</section>`);
  }
  out.push('</section>');
  return out.join('\n');
}

// ---- fitting chapters (runs inside the page) ----
// Lays each chapter out in a multi-column box whose columns are exactly one page of
// content. Chrome breaks columns with the same rules it breaks pages (keep-together
// blocks, headings kept with what follows), so the column count is the page count.
function fitChapters({ contentW, contentH, scales }) {
  const IN = 96, W = contentW * IN, H = contentH * IN, GAP = IN;
  const box = document.createElement('div');
  box.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;column-width:${W}px;column-gap:${GAP}px;column-fill:auto;visibility:hidden`;
  document.body.appendChild(box);
  const setScale = (root, k) => {
    for (const im of root.querySelectorAll('.pic img')) {
      const w = +im.dataset.w * k, h = +im.dataset.h * k;
      im.style.width = w + 'in'; im.style.height = h + 'in';
      const side = im.closest('.side'); if (side) side.style.setProperty('--pic-w', w + 'in');
    }
  };
  const pagesOf = (ch, k) => {
    const c = ch.cloneNode(true);
    c.removeAttribute('id'); c.style.breakBefore = 'auto';
    setScale(c, k);
    box.replaceChildren(c);
    const r0 = box.getBoundingClientRect();
    let cols = 1;
    for (const el of c.querySelectorAll('*')) for (const r of el.getClientRects()) {
      if (r.width && r.height) cols = Math.max(cols, Math.floor((r.left - r0.left + 2) / (W + GAP)) + 1);
    }
    return cols;
  };
  const out = [];
  document.querySelectorAll('section.chapter').forEach((ch) => {
    if (!ch.querySelector('.pic img')) return;
    const from = pagesOf(ch, 1);
    if (from < 2) return;
    for (const k of scales) {
      const to = pagesOf(ch, k);
      if (to < from) { out.push({ id: ch.id, chapter: ch.querySelector('.band h1 .eyebrow')?.textContent.replace(/[^0-9]/g, '') || ch.id, scale: k, from, to }); break; }
    }
  });
  box.remove();
  return out;
}

function applyScales(fits) {
  for (const f of fits) {
    const ch = document.getElementById(f.id);
    if (!ch) continue;
    for (const im of ch.querySelectorAll('.pic img')) {
      const w = +im.dataset.w * f.scale, h = +im.dataset.h * f.scale;
      im.style.width = w + 'in'; im.style.height = h + 'in';
      const side = im.closest('.side'); if (side) side.style.setProperty('--pic-w', w + 'in');
    }
  }
  return true;
}

// ---- reading the page numbers back out of Chrome's PDF ----
// Skia writes plain (uncompressed) dictionaries for the page tree and the outline, so a
// small scan finds each bookmark's title and target page. If anything looks off we
// return null and the contents simply goes without page numbers.
function outlinePages(buf) {
  const s = buf.toString('latin1');
  const objs = new Map();
  const re = /(\d+) 0 obj\b/g;
  let m;
  const starts = [];
  while ((m = re.exec(s))) starts.push([+m[1], m.index + m[0].length]);
  for (const [n, at] of starts) {
    const end = s.indexOf('endobj', at);
    const body = s.slice(at, end < 0 ? at + 4000 : end);
    const st = body.indexOf('stream');
    objs.set(n, st >= 0 ? body.slice(0, st) : body);
  }
  const cat = [...objs.values()].find(o => /\/Type\s*\/Catalog/.test(o));
  const rootRef = cat && cat.match(/\/Pages\s+(\d+) 0 R/);
  if (!rootRef) return null;
  const order = [];
  const walk = (n, depth = 0) => {
    const o = objs.get(n);
    if (!o || depth > 20) return;
    if (/\/Type\s*\/Pages\b/.test(o)) {
      const kids = o.match(/\/Kids\s*\[([^\]]*)\]/);
      if (kids) for (const k of kids[1].matchAll(/(\d+) 0 R/g)) walk(+k[1], depth + 1);
    } else order.push(n);
  };
  walk(+rootRef[1]);
  const pageOf = new Map(order.map((n, i) => [n, i + 1]));
  const items = [];
  for (const o of objs.values()) {
    const t = o.match(/\/Title\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/);
    const d = o.match(/\/Dest\s*\[\s*(\d+) 0 R/);
    if (t && d && pageOf.has(+d[1])) items.push({ title: pdfString(t[1]).replace(/[\s ]+/g, ' ').trim(), page: pageOf.get(+d[1]) });
  }
  return { pages: order.length, items };
}

function pdfString(tok) {
  if (tok.startsWith('<')) {
    const hex = tok.slice(1, -1).replace(/\s+/g, '');
    const bytes = Buffer.from(hex, 'hex');
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    return bytes.toString('latin1');
  }
  return tok.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => {
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    return map[e] ?? String.fromCharCode(parseInt(e, 8));
  });
}

function pageMap(outline) {
  if (!outline) return null;
  const pages = {};
  for (const it of outline.items) {
    let m;
    if ((m = it.title.match(/^Chapter (\d+)\b/i))) pages['ch-' + m[1]] ??= it.page;
    else if ((m = it.title.match(/^Part (\d+)\b/i))) pages['part-' + m[1]] ??= it.page;
    else if (/^How to use this guide/i.test(it.title)) pages.howto ??= it.page;
  }
  return Object.keys(pages).length ? pages : null;
}

async function buildPdf(model, outFile, { chrome, keepHtml = false, warn = console.warn } = {}) {
  const { launch } = require('../capture/cdp');
  const own = !chrome;
  const browser = chrome || await launch();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-guide-pdf-'));
  const htmlFile = path.join(tmpDir, 'guide.html');
  const opts = { generateDocumentOutline: true, generateTaggedPDF: true, preferCSSPageSize: true, printBackground: true };
  try {
    const page = await browser.newPage();
    let fits = null;
    const print = async (html) => {
      fs.writeFileSync(htmlFile, html);
      await page.goto(pathToFileURL(htmlFile).href, { waitMs: 200 });
      await page.eval(() => document.fonts.ready.then(() => Promise.all([...document.images].map(i => i.decode().catch(() => {})))).then(() => true));
      if (!fits) {
        // Where shrinking a chapter's pictures a little saves a page (a Tip left alone on
        // the last page, a picture pushed over leaving a gap), do it. Word keeps full size.
        fits = await page.eval(fitChapters, { contentW: 8.5 - 2, contentH: 11 - 0.85 - 0.9, scales: [0.94, 0.88, 0.82] });
        for (const f of fits) console.log(`  pdf: chapter ${f.chapter} pictures at ${Math.round(f.scale * 100)}% saves a page (${f.from} -> ${f.to})`);
      }
      if (fits.length) await page.eval(applyScales, fits);
      await page.pdf(outFile, opts);
      return fs.readFileSync(outFile);
    };
    const firstPass = await print(renderHtml(model));
    const pages = pageMap(outlinePages(firstPass));
    let pageCount = outlinePages(firstPass)?.pages;
    if (!pages) warn('warning: could not read page numbers from the first PDF pass; the contents will have none');
    const second = await print(renderHtml(model, pages || {}));
    const check = pageMap(outlinePages(second));
    pageCount = outlinePages(second)?.pages ?? pageCount;
    if (pages && check && JSON.stringify(pages) !== JSON.stringify(check)) warn('warning: page numbers moved between passes; contents may be off by a page');
    if (keepHtml) fs.copyFileSync(htmlFile, outFile.replace(/\.pdf$/i, '.html'));
    await page.close();
    return { pages: pageCount, starts: check || pages };
  } finally {
    if (own) await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { buildPdf, renderHtml, outlinePages, pageMap };
