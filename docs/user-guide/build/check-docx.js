// Checks a built .docx: every XML part parses, document.xml has the expected headings,
// and every relationship that points inside the package (pictures, headers, footers,
// numbering, fonts) resolves to a file that exists.
//
//   node build/check-docx.js ["out/Getting started with Depot.docx"]
'use strict';
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { xml2js } = require('xml-js');
const { G, TITLE } = require('./lib');

async function checkDocx(file) {
  const problems = [];
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const parsed = {};
  for (const n of names.filter(n => /\.(xml|rels)$/.test(n))) {
    const s = await zip.file(n).async('string');
    try { parsed[n] = xml2js(s, { compact: false }); } catch (e) { problems.push(`${n} does not parse: ${e.message}`); }
  }
  for (const req of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'word/fontTable.xml']) {
    if (!names.includes(req)) problems.push(`missing part ${req}`);
  }

  // Relationships: resolve every internal target relative to the part that owns the .rels.
  let images = 0;
  const relIds = {};
  for (const relsName of names.filter(n => n.endsWith('.rels'))) {
    const owner = relsName.replace(/_rels\/([^/]+)\.rels$/, '$1');
    const base = path.posix.dirname(owner === relsName ? '' : owner);
    const rels = find(parsed[relsName], 'Relationship');
    relIds[owner] = new Set();
    for (const r of rels) {
      const a = r.attributes || {};
      relIds[owner].add(a.Id);
      if (a.TargetMode === 'External') continue;
      const target = a.Target.startsWith('/') ? a.Target.slice(1) : path.posix.normalize(path.posix.join(base === '.' ? '' : base, a.Target));
      if (!names.includes(target)) problems.push(`${relsName}: ${a.Id} -> ${a.Target} does not exist`);
      else if (/\/image$/.test(a.Type)) {
        images++;
        const head = await zip.file(target).async('nodebuffer');
        if (!(head[0] === 0x89 && head.toString('ascii', 1, 4) === 'PNG') && !(head[0] === 0xFF && head[1] === 0xD8)) problems.push(`${target} is not a PNG or JPEG`);
      }
    }
  }

  // Every r:embed / r:id used in a part must be declared in that part's relationships.
  for (const part of names.filter(n => /^word\/[^/]+\.xml$/.test(n))) {
    const s = await zip.file(part).async('string');
    const ids = new Set([...s.matchAll(/r:(?:embed|id|link)="([^"]+)"/g)].map(m => m[1]));
    for (const id of ids) if (!relIds[part] || !relIds[part].has(id)) problems.push(`${part} uses ${id} but no relationship declares it`);
  }

  // Word refuses a table cell whose last child is not a paragraph ("unreadable content").
  for (const part of names.filter(n => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))) {
    for (const tc of find(parsed[part], 'w:tc')) {
      const kids = (tc.elements || []).filter(e => e.type === 'element' && e.name !== 'w:tcPr');
      if (!kids.length || kids[kids.length - 1].name !== 'w:p') problems.push(`${part}: a table cell does not end with a paragraph`);
    }
  }
  // Every file type in the package needs a content type.
  const ct = await zip.file('[Content_Types].xml').async('string');
  for (const ext of new Set(names.map(n => (n.match(/\.([A-Za-z0-9]+)$/) || [])[1]).filter(Boolean))) {
    if (!new RegExp(`Extension="${ext}"`, 'i').test(ct) && !names.filter(n => n.endsWith('.' + ext)).every(n => ct.includes(`PartName="/${n}"`))) problems.push(`[Content_Types].xml has no type for .${ext}`);
  }

  const doc = await zip.file('word/document.xml').async('string');
  const h1 = (doc.match(/<w:pStyle w:val="Heading1"\/>/g) || []).length;
  const h2 = (doc.match(/<w:pStyle w:val="Heading2"\/>/g) || []).length;
  const drawings = (doc.match(/<w:drawing>/g) || []).length;
  const alts = [...doc.matchAll(/<wp:docPr [^>]*descr="([^"]*)"/g)].map(m => m[1]);
  if (/paratech/i.test(doc)) problems.push('document mentions ParaTech');
  const fontTable = await zip.file('word/fontTable.xml')?.async('string') || '';
  if (!/w:name="Aptos"[\s\S]*?w:altName w:val="Calibri"/.test(fontTable)) problems.push('fontTable.xml has no Aptos -> Calibri fallback');
  return { problems, stats: { parts: names.length, images, drawings, headings1: h1, headings2: h2, picturesWithAlt: alts.filter(Boolean).length } };
}

function find(node, name, out = []) {
  if (!node) return out;
  if (node.name === name) out.push(node);
  for (const c of node.elements || []) find(c, name, out);
  return out;
}

if (require.main === module) {
  const file = path.resolve(process.argv[2] || path.join(G, 'out', `${TITLE}.docx`));
  checkDocx(file).then(({ problems, stats }) => {
    console.log(`${path.basename(file)}: ${stats.parts} parts, ${stats.images} image relationships, ${stats.drawings} drawings in the body (${stats.picturesWithAlt} with alt text), ${stats.headings1} Heading 1, ${stats.headings2} Heading 2`);
    if (problems.length) { for (const p of problems) console.log('PROBLEM ' + p); process.exit(1); }
    console.log('ok');
  }).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { checkDocx };
