// Builds "Getting started with Depot" as Word and PDF from content/*.json + out/images.
//
//   node build/all.js                 # -> out/Getting started with Depot.docx and .pdf
//   node build/all.js --sample        # the test chapters in build/sample -> build/sample/out
//   node build/all.js --pdf-only | --docx-only | --keep-html
//   node build/all.js --docx-only --docx-start chapter   # preview aid: Word file starting at chapter 1 (or 'part')
//   node build/all.js --content <dir> --images <dir> --out <dir>
//
// Chapter files starting with "_" are skipped. A missing chapter file, picture or
// manifest entry prints a warning and the build carries on without it.
'use strict';
const fs = require('fs');
const path = require('path');
const { G, TITLE, loadModel } = require('./lib');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);

async function main() {
  const sample = flag('--sample');
  const contentDir = path.resolve(opt('--content') || (sample ? path.join(__dirname, 'sample', 'content') : path.join(G, 'content')));
  const imagesDir = path.resolve(opt('--images') || (sample ? path.join(__dirname, 'sample', 'images') : path.join(G, 'out', 'images')));
  const outDir = path.resolve(opt('--out') || (sample ? path.join(__dirname, 'sample', 'out') : path.join(G, 'out')));
  fs.mkdirSync(outDir, { recursive: true });

  const warnings = [];
  const warn = (m) => { warnings.push(m); console.warn(m); };
  await require('./optimize-images').optimizeImages({ imagesDir });
  const model = loadModel({ contentDir, imagesDir, warn });
  const nPics = model.chapters.reduce((n, c) => n + c.sections.filter(s => s.picture).length, 0);
  const rel = path.relative(process.cwd(), contentDir);
  console.log(`${model.chapters.length} chapters in ${model.parts.length} parts, ${nPics} pictures (${rel && !rel.startsWith('..') ? rel : contentDir})`);

  const docxFile = path.join(outDir, `${TITLE}.docx`);
  const pdfFile = path.join(outDir, `${TITLE}.pdf`);
  const { launch } = require('../capture/cdp');
  const chrome = await launch();
  try {
    if (!flag('--pdf-only')) {
      const { renderAssets } = require('./assets');
      const { buildDocx } = require('./docx');
      const assets = await renderAssets(chrome);
      await buildDocx(model, docxFile, { assets, warn, startAt: opt('--docx-start') });
      console.log(`wrote ${docxFile} (${kb(docxFile)})`);
    }
    if (!flag('--docx-only')) {
      const { buildPdf } = require('./pdf');
      const r = await buildPdf(model, pdfFile, { chrome, keepHtml: flag('--keep-html'), warn });
      console.log(`wrote ${pdfFile} (${kb(pdfFile)}, ${r.pages ?? '?'} pages)`);
    }
  } finally {
    await chrome.close();
  }
  if (warnings.length) console.log(`${warnings.length} warning(s)`);
}

const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
