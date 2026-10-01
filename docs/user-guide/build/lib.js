// Shared by docx.js and pdf.js: loads the chapters and pictures into one model, and
// holds the measurements and colours both outputs use, so the Word file and the PDF
// carry the same text and pictures at the same sizes.
'use strict';
const fs = require('fs');
const path = require('path');

const G = path.join(__dirname, '..');            // docs/user-guide
const REPO = path.join(G, '..', '..');           // repo root

const TITLE = 'Getting started with Depot';
const SUBTITLE = 'A guide for everyday use';
const PARTS = { 1: 'Quick start', 2: 'Going further' };

// Ledger palette, read from index.html (:root and html.dark). Hex without '#'.
const C = {
  // dark (cover, part openers, chapter bands)
  darkPaper: '0D0F12', darkSurface: '15181D', darkRaised: '1C2027', darkRule: '262B33',
  darkInk: 'EDEEF1', darkInkSoft: 'B4BAC4', darkInkFaint: '9AA0AB',
  darkAccent: '3DA3DC', darkAccentSoft: '2E86BC', darkAccentInk: '08131B',
  // light (body pages)
  ink: '17191D', inkSoft: '5C6069', inkFaint: '6A6E77',
  accent: '0E6FA8', accentWash: 'E8F2F9', lineStrong: 'CBCBD2', rule: 'E4E4E8', surface2: 'F4F4F6',
  warning: '9A6212', warningWash: 'FBF3E6',
  // the picture callouts (capture/run.js CALLOUT_COLOR)
  callout: 'F2542D',
};

// The Depot shield (DEPOT_MARK in index.html).
const MARK_PATH = 'M12 2.4l8 3v6.2c0 4.9-3.3 8.9-8 10.4-4.7-1.5-8-5.5-8-10.4V5.4zM8.9 8.1h6.2a1 1 0 0 1 0 2h-6.2a1 1 0 0 1 0-2zM8.9 11.8h6.2a1 1 0 0 1 0 2h-6.2a1 1 0 0 1 0-2zM10.7 15.5h2.6a1 1 0 0 1 0 2h-2.6a1 1 0 0 1 0-2z';
function markSvg(color = 'currentColor') {
  return `<svg viewBox="0 0 24 24" fill="${color}" fill-rule="evenodd" aria-hidden="true"><path d="${MARK_PATH}"/></svg>`;
}

// Page geometry (inches). US Letter, 1 inch side margins -> 6.5 inch text width.
const PAGE = { width: 8.5, height: 11, marginX: 1, marginTop: 0.85, marginBottom: 0.9, footer: 0.45 };
const TEXT_W = PAGE.width - 2 * PAGE.marginX;

// Picture sizing. Screens are captured at 2x, so CSS px = PNG px / 2. A crop of a small
// menu is not blown up past ~88 CSS px per inch (about 11 pt for the app's 13 px text).
const PX_PER_IN = 100;
const FULL_MAX_H = 4.6;      // leaves room for the steps on the same page
const SIDE_MIN_ASPECT = 1.15; // taller than this (height/width) and it sits beside its steps
const SIDE_W = 2.9, SIDE_MAX_H = 6.0;

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('not a PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function sizePicture(px, { hasSideText }) {
  const aspect = px.h / px.w;
  const cssW = px.w / 2;
  if (aspect > SIDE_MIN_ASPECT) {
    let w = Math.min(SIDE_W, cssW / PX_PER_IN), h = w * aspect;
    if (h > SIDE_MAX_H) { h = SIDE_MAX_H; w = h / aspect; }
    return { layout: hasSideText ? 'side' : 'center', w: round(w), h: round(h) };
  }
  let w = Math.min(TEXT_W, cssW / PX_PER_IN), h = w * aspect;
  if (h > FULL_MAX_H) { h = FULL_MAX_H; w = h / aspect; }
  return { layout: w > TEXT_W - 0.05 ? 'full' : 'center', w: round(w), h: round(h) };
}
const round = (n) => Math.round(n * 1000) / 1000;

// "Click **Share**, then …" -> [{ text: 'Click ', bold: false }, { text: 'Share', bold: true }, …]
function runs(s) {
  const out = [];
  String(s ?? '').split(/(\*\*[^*]+\*\*)/).forEach(part => {
    if (!part) return;
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    out.push(m ? { text: m[1], bold: true } : { text: part.replace(/\*\*/g, ''), bold: false });
  });
  return out;
}

function editionLine() {
  try {
    const v = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
    const m = v.match(/(\d{4})\.(\d{2})/);
    if (m) return `Edition ${m[1]}.${m[2]}`;
  } catch {}
  const d = new Date();
  return `Edition ${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const FORBIDDEN = [/paratech/i];

// Reads content/*.json (skipping "_*"), sorted by part then order, and resolves each
// section's picture through images/manifest.json. Missing things warn and are skipped.
function loadModel({ contentDir = path.join(G, 'content'), imagesDir = path.join(G, 'out', 'images'), warn = console.warn } = {}) {
  let manifest = {};
  const mf = path.join(imagesDir, 'manifest.json');
  if (fs.existsSync(mf)) {
    try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { warn(`warning: ${mf} does not parse (${e.message}); pictures get no alt text`); }
  } else warn(`warning: no ${mf}; pictures are looked up by file name`);

  const files = fs.existsSync(contentDir) ? fs.readdirSync(contentDir).filter(f => f.endsWith('.json') && !f.startsWith('_')) : [];
  if (!files.length) warn(`warning: no chapter files in ${contentDir}`);
  const chapters = [];
  for (const f of files) {
    const file = path.join(contentDir, f);
    let ch;
    try { ch = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { warn(`warning: skipping ${f}: ${e.message}`); continue; }
    if (!ch || typeof ch !== 'object' || !ch.title) { warn(`warning: skipping ${f}: no title`); continue; }
    const id = ch.id || f.replace(/\.json$/, '');
    const raw = JSON.stringify(ch);
    for (const re of FORBIDDEN) if (re.test(raw)) throw new Error(`${f} mentions a name the guide must never carry (${re}). Fix the content first.`);
    if (/—/.test(raw)) warn(`warning: ${f} contains an em dash`);
    const sections = (Array.isArray(ch.sections) ? ch.sections : []).map((s, i) => {
      const sec = {
        heading: s.heading || '', text: arr(s.text), steps: arr(s.steps), bullets: arr(s.bullets),
        tip: s.tip || '', note: s.note || '', picture: null,
      };
      if (s.shot) sec.picture = resolvePicture(id, s.shot, s, ch, { manifest, imagesDir, warn, where: `${f} section ${i + 1}` });
      if (sec.picture) sec.picture.size = sizePicture(sec.picture.px, { hasSideText: sec.steps.length > 0 || sec.bullets.length > 0 });
      return sec;
    });
    chapters.push({ id, part: Number(ch.part) || 1, order: Number(ch.order) || 999, theme: ch.theme || 'light', title: ch.title, intro: ch.intro || '', sections });
  }
  chapters.sort((a, b) => a.part - b.part || a.order - b.order || a.id.localeCompare(b.id));
  const parts = [];
  for (const ch of chapters) {
    let p = parts.find(x => x.n === ch.part);
    if (!p) { p = { n: ch.part, title: PARTS[ch.part] || `Part ${ch.part}`, chapters: [] }; parts.push(p); }
    ch.n = ch.order < 999 ? ch.order : null;
    p.chapters.push(ch);
  }
  // Number any chapter without an order after the last numbered one.
  let last = 0;
  for (const p of parts) for (const ch of p.chapters) { if (ch.n == null) ch.n = last + 1; last = ch.n; }
  return { title: TITLE, subtitle: SUBTITLE, edition: editionLine(), parts, chapters };
}

function resolvePicture(chapterId, shotId, section, ch, { manifest, imagesDir, warn, where }) {
  const rec = manifest[`${chapterId}/${shotId}`];
  const file = path.join(imagesDir, rec?.file || `${chapterId}/${shotId}.png`);
  if (!fs.existsSync(file)) { warn(`warning: ${where}: picture ${chapterId}/${shotId} is missing (${path.relative(G, file)}); left out`); return null; }
  if (rec && rec.ok === false) warn(`warning: ${where}: picture ${chapterId}/${shotId} was captured with problems${rec.error ? ': ' + rec.error : ''}`);
  if (!rec) warn(`warning: ${where}: ${chapterId}/${shotId} is not in manifest.json; using a plain alt text`);
  let buf, px;
  try { buf = fs.readFileSync(file); px = pngSize(buf); } catch (e) { warn(`warning: ${where}: cannot read ${file}: ${e.message}; left out`); return null; }
  // Embed the print-size copy when there is a fresh one (build/optimize-images.js), but
  // keep px from the original capture: every size decision is made in capture pixels.
  let embedFile = file;
  const small = require('./optimize-images').printCopyPath(imagesDir, file);
  try { if (fs.statSync(small).mtimeMs >= fs.statSync(file).mtimeMs) { buf = fs.readFileSync(small); embedFile = small; } } catch { /* no copy: use the original */ }
  let pdfFile = embedFile;
  const smallJpg = small.replace(/\.png$/, '.jpg');
  try { if (fs.statSync(smallJpg).mtimeMs >= fs.statSync(file).mtimeMs) pdfFile = smallJpg; } catch { /* no JPEG copy */ }
  const alt = (rec?.caption || '').trim() || `Screen picture: ${section.heading || ch.title}`;
  return { id: shotId, file: embedFile, pdfFile, buf, px, alt, theme: rec?.theme || '', device: rec?.device || 'desktop' };
}

const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter(x => typeof x === 'string' && x.trim());

// A small drawing for "How to use this guide": a badge in a picture and the step it
// matches. Plain HTML with inline styles (CSS px, 96 per inch) so the PDF shows it
// natively and assets.js can photograph the very same thing for Word. The badge and
// ring copy capture/run.js drawCallouts.
const EXAMPLE_W = 520, EXAMPLE_H = 116;
function calloutExampleHtml() {
  const ui = "font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif";
  const cap = `${ui};font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6A6E77;margin:0 0 8px`;
  const btn = `display:inline-block;${ui};font-size:13px;font-weight:550;color:#17191D;background:#FFFFFF;border:1px solid #CBCBD2;border-radius:8px;padding:7px 13px;margin-right:14px;line-height:16px`;
  const badge = (n, x, y) => `<span style="position:absolute;left:${x}px;top:${y}px;width:30px;height:30px;border-radius:50%;background:#F2542D;color:#fff;${ui};font-weight:700;font-size:17px;line-height:26px;text-align:center;border:2px solid #fff;box-sizing:border-box">${n}</span>`;
  return `<div style="position:relative;width:${EXAMPLE_W}px;height:${EXAMPLE_H}px;${ui}">
  <div style="position:absolute;left:0;top:0;width:282px">
    <p style="${cap}">In the picture</p>
    <div style="position:relative;background:#F4F4F6;border:1px solid #E4E4E8;border-radius:10px;padding:26px 18px 22px;white-space:nowrap">
      <span style="${btn}">Open</span><span style="position:relative;${btn}">Share<span style="position:absolute;left:-7px;top:-7px;right:-7px;bottom:-7px;border:3px solid #F2542D;border-radius:10px;box-shadow:0 0 0 2px rgba(255,255,255,.85)"></span></span><span style="${btn}">Download</span>
      ${badge(1, 80, 6)}
    </div>
  </div>
  <div style="position:absolute;left:296px;top:62px;width:30px;height:2px;background:#9AA0AB"></div>
  <div style="position:absolute;left:322px;top:57px;width:0;height:0;border-left:9px solid #9AA0AB;border-top:6px solid transparent;border-bottom:6px solid transparent"></div>
  <div style="position:absolute;left:344px;top:0;width:176px">
    <p style="${cap}">In the steps</p>
    <div style="display:flex;align-items:center;gap:12px;padding-top:24px;font-size:16px;color:#17191D">
      <span style="flex:0 0 auto;width:29px;height:29px;border-radius:50%;background:#F2542D;color:#fff;font-weight:750;font-size:16px;line-height:29px;text-align:center">1</span>
      <span>Click <strong>Share</strong>.</span>
    </div>
  </div>
</div>`;
}
const CALLOUT_EXAMPLE_ALT = 'Example: in the picture, badge 1 marks the Share button. In the steps, step 1 says Click Share.';

// Chapter wording for the "How to use this guide" note.
function howToUse(model) {
  const ld = model.chapters.find(c => c.id === 'light-dark');
  return [
    [{ text: 'Each chapter shows one everyday task. Most sections have a picture of the screen and numbered steps below it.', bold: false }],
    [{ text: 'The orange numbered badges in a picture match the numbered steps. Badge 1 shows where to click for step 1.', bold: false }],
    runs('Words in **bold** are labels you see on the screen, such as **Share** or **Upload**.'),
    [{ text: 'Depot has a light look and a dark look. The pictures switch between the two from chapter to chapter, so you will recognise both.' + (ld ? ` Chapter ${ld.n}, “${ld.title}”, shows how to choose.` : ''), bold: false }],
    [{ text: 'Part 1 covers the everyday basics. Part 2 covers things you will need less often.', bold: false }],
    [{ text: 'Whenever you need a chapter fast, turn back to the contents page.', bold: false }],
  ];
}

module.exports = { G, REPO, TITLE, SUBTITLE, PARTS, C, PAGE, TEXT_W, MARK_PATH, markSvg, pngSize, sizePicture, runs, editionLine, loadModel, howToUse, calloutExampleHtml, CALLOUT_EXAMPLE_ALT, EXAMPLE_W, EXAMPLE_H };
