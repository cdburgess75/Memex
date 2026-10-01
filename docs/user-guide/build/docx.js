// Builds the Word file with the docx package (v9). Same model and same picture sizes as
// the PDF. Real Heading 1 / Heading 2 styles so Word's navigation pane works; dark pages
// are a full-page picture in that section's header, behind the text.
'use strict';
const fs = require('fs');
const JSZip = require('jszip');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, Header, Footer,
  HeadingLevel, AlignmentType, WidthType, ShadingType, BorderStyle, TabStopType, PageNumber,
  LevelFormat, VerticalAlign, VerticalAlignSection, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
  TextWrappingType, InternalHyperlink, Bookmark, TableLayoutType,
} = require('docx');
const { C, PAGE, TEXT_W, runs, howToUse, CALLOUT_EXAMPLE_ALT, EXAMPLE_W, EXAMPLE_H } = require('./lib');

const FONT = 'Aptos';
const TW = (inches) => Math.round(inches * 1440);   // twips
const PX = (inches) => Math.round(inches * 96);     // docx image units
const PT = (pt) => pt * 2;                          // half-points
const TEXT_TW = TW(TEXT_W);

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const CELL_NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE };

// Only ever set bold ON: an explicit bold=false would override the Heading styles.
const text = (s, o = {}) => runs(s).map(r => new TextRun({ ...o, text: r.text, bold: r.bold || o.bold ? true : undefined }));
const fromRuns = (rs, o = {}) => rs.map(r => new TextRun({ ...o, text: r.text, bold: r.bold || o.bold ? true : undefined }));

function footer(dark) {
  return new Footer({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: TEXT_TW }],
      spacing: { before: 0, after: 0, line: 240 },
      children: [
        new TextRun({ text: 'Getting started with Depot', size: PT(9.5), color: dark ? C.darkInkFaint : C.inkSoft }),
        new TextRun({ children: ['\t', PageNumber.CURRENT], size: PT(10), bold: true, color: dark ? C.darkInk : C.ink }),
      ],
    })],
  });
}

const emptyHeader = () => new Header({ children: [new Paragraph({ children: [] })] });

// A full-page picture anchored to the page corner, behind the text. It rides in the first
// paragraph of the page (not the header) so viewers that skip headers still show it.
function backgroundRun(png, name) {
  return new ImageRun({
    type: 'png', data: png,
    transformation: { width: PX(PAGE.width), height: PX(PAGE.height) },
    floating: {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
      behindDocument: true, allowOverlap: true, lockAnchor: true,
      wrap: { type: TextWrappingType.NONE },
    },
    altText: { name, description: '', title: '' },
  });
}

const pageProps = (margins = {}) => ({
  page: {
    size: { width: TW(PAGE.width), height: TW(PAGE.height) },
    margin: { top: TW(PAGE.marginTop), bottom: TW(PAGE.marginBottom), left: TW(PAGE.marginX), right: TW(PAGE.marginX), header: TW(0.4), footer: TW(PAGE.footer), ...margins },
  },
});

// A short thick accent line: a paragraph border squeezed by a right indent.
const accentRule = (color, after = 360) => new Paragraph({
  indent: { right: TEXT_TW - TW(0.7) },
  border: { bottom: { style: BorderStyle.SINGLE, size: 32, color, space: 1 } },
  spacing: { before: 0, after },
  children: [new TextRun({ text: '', size: 4 })],
});

// Dark pages carry their colour twice: a full-page picture behind the text (what Word
// shows, edge to edge) and a dark table around the words, so viewers that ignore pictures
// behind text (Quick Look, the iPhone Mail preview) still show light text on dark.
function darkPanel(children) {
  return new Table({
    width: { size: TEXT_TW, type: WidthType.DXA },
    columnWidths: [TEXT_TW],
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS,
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: TEXT_TW, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: C.darkPaper, color: 'auto' },
        borders: CELL_NO_BORDERS,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        children,
      })],
    })],
  });
}
const anchorLine = (run) => new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: 'exact' }, children: [run] });

function cover(model, assets) {
  const m = model.title.match(/^(.*?) (with .*)$/);
  const titleRuns = m
    ? [new TextRun({ text: m[1], color: 'FFFFFF' }), new TextRun({ text: m[2], break: 1, color: 'FFFFFF' })]
    : [new TextRun({ text: model.title, color: 'FFFFFF' })];
  return {
    properties: { ...pageProps({ top: TW(1.05), bottom: TW(1.3), footer: TW(0.85) }) },
    headers: { default: emptyHeader() },
    footers: {
      default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: model.edition, size: PT(11), bold: true, color: C.darkInkFaint, characterSpacing: 12 })] })] }),
    },
    children: [
      anchorLine(backgroundRun(assets.darkBg, 'Cover background')),
      darkPanel([
        new Paragraph({
          spacing: { before: 0, after: 0 },
          children: [new ImageRun({ type: 'png', data: assets.tile, transformation: { width: 96, height: 96 }, altText: { name: 'Depot', description: 'The Depot shield', title: 'Depot' } })],
        }),
        new Paragraph({ spacing: { before: TW(1.85), after: 0 }, children: [] }),
        accentRule(C.darkAccent, 400),
        new Paragraph({
          heading: HeadingLevel.TITLE,
          spacing: { before: 0, after: 300, line: 250, lineRule: 'auto' },
          children: titleRuns,
        }),
        new Paragraph({ spacing: { before: 0, after: 120 }, children: [new TextRun({ text: model.subtitle, size: PT(19), color: C.darkInkSoft })] }),
      ]),
    ],
  };
}

function contents(model) {
  const rows = [];
  const row = (num, title, anchor, { part = false } = {}) => new Paragraph({
    tabStops: [{ type: TabStopType.LEFT, position: TW(0.45) }],
    spacing: { before: part ? 360 : 0, after: 0, line: part ? 300 : 360, lineRule: 'auto' },
    border: { bottom: part ? { style: BorderStyle.SINGLE, size: 10, color: C.ink, space: 4 } : { style: BorderStyle.SINGLE, size: 4, color: C.rule, space: 4 } },
    keepNext: part,
    children: [
      ...(num !== '' ? [new TextRun({ text: String(num), bold: true, color: C.accent, size: PT(12.5) })] : []),
      new TextRun({ text: '\t', size: PT(12.5) }),
      new InternalHyperlink({ anchor, children: [new TextRun({ text: title, size: PT(part ? 13 : 12.5), bold: part, color: C.ink })] }),
    ],
  });
  rows.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 360 }, children: [new TextRun({ text: 'Contents', size: PT(30) })] }));
  rows.push(row('', 'How to use this guide', 'how_to_use'));
  for (const p of model.parts) {
    rows.push(new Paragraph({
      spacing: { before: 400, after: 60 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: C.ink, space: 4 } },
      keepNext: true,
      children: [new InternalHyperlink({ anchor: `part_${p.n}`, children: [new TextRun({ text: `Part ${p.n} · ${p.title}`, bold: true, size: PT(13), color: C.ink })] })],
    }));
    for (const ch of p.chapters) rows.push(row(ch.n, ch.title, `ch_${ch.n}`));
  }
  return rows;
}

function howTo(model, assets) {
  const icons = ['dot', 'badge', 'dot', 'swatch', 'dot'];
  const items = howToUse(model);
  const table = new Table({
    width: { size: TEXT_TW, type: WidthType.DXA },
    columnWidths: [TW(0.5), TEXT_TW - TW(0.5)],
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS,
    rows: items.map((rs, i) => new TableRow({
      cantSplit: true,
      children: [
        new TableCell({
          width: { size: TW(0.5), type: WidthType.DXA }, borders: CELL_NO_BORDERS,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [new ImageRun({ type: 'png', data: assets.icons[icons[i]] || assets.icons.dot, transformation: { width: 28, height: 28 }, altText: { name: icons[i], description: icons[i] === 'badge' ? 'An orange badge with the number 1' : '', title: '' } })] })],
        }),
        new TableCell({
          width: { size: TEXT_TW - TW(0.5), type: WidthType.DXA }, borders: CELL_NO_BORDERS,
          margins: { top: 0, bottom: 200, left: 0, right: 0 },
          children: [
            new Paragraph({ spacing: { before: 0, after: 0 }, children: fromRuns(rs) }),
            ...(i === 1 && assets.example ? [new Paragraph({
              spacing: { before: 200, after: 80 },
              children: [new ImageRun({ type: 'png', data: assets.example, transformation: { width: EXAMPLE_W, height: EXAMPLE_H }, altText: { name: 'Callout example', description: CALLOUT_EXAMPLE_ALT, title: 'Callout example' } })],
            })] : []),
          ],
        }),
      ],
    })),
  });
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { after: 360 },
      children: [new Bookmark({ id: 'how_to_use', children: [new TextRun({ text: 'How to use this guide', size: PT(30) })] })],
    }),
    table,
  ];
}

// Vertically centred on the page (verticalAlign), so a short list (Part 2) balances on
// the page the same way a long one (Part 1) does, instead of both sitting under the same
// fixed top gap and a short list leaving the bottom of the page empty.
function partOpener(p, assets) {
  return {
    properties: { ...pageProps(), verticalAlign: VerticalAlignSection.CENTER },
    headers: { default: emptyHeader() },
    footers: { default: footer(true) },
    children: [
      anchorLine(backgroundRun(assets.darkBg, 'Dark page background')),
      darkPanel([
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 0, after: 360, line: 240 },
        children: [new Bookmark({
          id: `part_${p.n}`,
          children: [
            new TextRun({ text: `Part ${p.n} `, smallCaps: true, bold: true, size: PT(15), color: C.darkAccent, characterSpacing: 30 }),
            new TextRun({ text: p.title, break: 1, bold: true, size: PT(46), color: 'FFFFFF' }),
          ],
        })],
      }),
      accentRule(C.darkAccent, 360),
      ...p.chapters.map((ch, i) => new Paragraph({
        tabStops: [{ type: TabStopType.LEFT, position: TW(0.5) }],
        indent: { right: TW(0.9) },
        spacing: { before: 0, after: 0, line: 400, lineRule: 'auto' },
        border: {
          ...(i === 0 ? { top: { style: BorderStyle.SINGLE, size: 4, color: C.darkRule, space: 5 } } : {}),
          bottom: { style: BorderStyle.SINGLE, size: 4, color: C.darkRule, space: 5 },
        },
        children: [
          new TextRun({ text: String(ch.n), bold: true, size: PT(14), color: C.darkAccent }),
          new TextRun({ text: '\t' + ch.title, size: PT(14), color: C.darkInk }),
        ],
      })),
      new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }),
      ]),
    ],
  };
}

function band(ch) {
  const cellChildren = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      keepNext: true, keepLines: true,
      spacing: { before: 0, after: ch.intro ? 140 : 0, line: 250, lineRule: 'auto' },
      children: [new Bookmark({
        id: `ch_${ch.n}`,
        children: [
          new TextRun({ text: `Chapter ${ch.n} `, smallCaps: true, bold: true, size: PT(12), color: C.darkAccent, characterSpacing: 24 }),
          new TextRun({ text: ch.title, break: 1, bold: true, size: PT(26), color: 'FFFFFF' }),
        ],
      })],
    }),
  ];
  if (ch.intro) cellChildren.push(new Paragraph({ keepNext: true, spacing: { before: 0, after: 0, line: 330 }, children: text(ch.intro, { size: PT(12.5), color: C.darkInkSoft }) }));
  return new Table({
    width: { size: TEXT_TW, type: WidthType.DXA },
    columnWidths: [TEXT_TW],
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS,
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        width: { size: TEXT_TW, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: C.darkPaper, color: 'auto' },
        borders: CELL_NO_BORDERS,
        margins: { top: TW(0.3), bottom: TW(0.32), left: TW(0.4), right: TW(0.4) },
        children: cellChildren,
      })],
    })],
  });
}

function box(kind, s, width = TEXT_TW) {
  const tip = kind === 'tip';
  return new Table({
    width: { size: width, type: WidthType.DXA },
    columnWidths: [width],
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS,
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        width: { size: width, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: tip ? C.accentWash : C.warningWash, color: 'auto' },
        borders: { top: NONE, bottom: NONE, right: NONE, left: { style: BorderStyle.SINGLE, size: 32, color: tip ? C.accent : C.warning } },
        margins: { top: TW(0.14), bottom: TW(0.15), left: TW(0.22), right: TW(0.2) },
        children: [new Paragraph({
          spacing: { before: 0, after: 0 },
          children: [
            new TextRun({ text: tip ? 'Tip' : 'Note', bold: true, color: tip ? '0B587F' : '6E460C' }),
            ...runs(s).map((r, i) => new TextRun({ text: r.text, bold: r.bold ? true : undefined, ...(i === 0 ? { break: 1 } : {}) })),
          ],
        })],
      })],
    })],
  });
}

const gap = (after = 120) => new Paragraph({ spacing: { before: 0, after, line: 240 }, children: [] });

function picture(pic, { keepNext }) {
  const { size } = pic;
  return new Paragraph({
    keepNext, keepLines: true,
    alignment: size.layout === 'side' ? AlignmentType.LEFT : AlignmentType.CENTER,
    spacing: { before: 120, after: 200, line: 240 },
    children: [new ImageRun({
      type: 'png', data: pic.buf,
      transformation: { width: PX(size.w), height: PX(size.h) },
      altText: { name: pic.id, description: pic.alt, title: pic.alt },
      outline: { type: 'solidFill', solidFillType: 'rgb', value: 'BFC2CA', width: 9525 },
    })],
  });
}

function chapter(ch, assets, counter) {
  const kids = [band(ch), gap(300)];
  for (const s of ch.sections) {
    const hasPic = !!s.picture;
    const stepsInstance = counter.next++;
    const stepParas = s.steps.map((t, i) => new Paragraph({
      numbering: { reference: 'steps', level: 0, instance: stepsInstance },
      keepNext: i < s.steps.length - 1, keepLines: true,
      spacing: { before: 0, after: 140 },
      children: text(t),
    }));
    const bulletParas = s.bullets.map((t) => new Paragraph({
      numbering: { reference: 'bullets', level: 0 },
      keepLines: true,
      spacing: { before: 0, after: 100 },
      children: text(t),
    }));
    const lead = (s.text.length > 0);
    if (s.heading) kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: text(s.heading, { bold: true }) }));
    s.text.forEach((t, i) => kids.push(new Paragraph({ keepNext: i === s.text.length - 1 && (hasPic || s.steps.length > 0), children: text(t) })));
    const side = hasPic && s.picture.size.layout === 'side';
    const sideBoxes = [];
    if (side) {
      if (s.tip) sideBoxes.push(gap(60), box('tip', s.tip, TEXT_TW - TW(s.picture.size.w) - TW(0.36)));
      if (s.note) sideBoxes.push(gap(60), box('note', s.note, TEXT_TW - TW(s.picture.size.w) - TW(0.36)));
    }
    if (side) {
      const colPic = TW(s.picture.size.w) + TW(0.36);
      kids.push(new Table({
        width: { size: TEXT_TW, type: WidthType.DXA },
        columnWidths: [colPic, TEXT_TW - colPic],
        layout: TableLayoutType.FIXED,
        borders: NO_BORDERS,
        rows: [new TableRow({
          cantSplit: true,
          children: [
            new TableCell({ width: { size: colPic, type: WidthType.DXA }, borders: CELL_NO_BORDERS, margins: { top: 0, bottom: 0, left: 0, right: TW(0.36) }, children: [picture(s.picture, { keepNext: false })] }),
            new TableCell({
              width: { size: TEXT_TW - colPic, type: WidthType.DXA }, borders: CELL_NO_BORDERS, margins: { top: TW(0.1), bottom: 0, left: 0, right: 0 }, verticalAlign: VerticalAlign.TOP,
              // The Tip/Note sit under the steps, beside the tall picture (as in the PDF).
              children: [...stepParas, ...bulletParas, ...sideBoxes, new Paragraph({ spacing: { before: 0, after: 0 }, children: [] })],
            }),
          ],
        })],
      }));
      kids.push(gap(160));
    } else {
      if (hasPic) kids.push(picture(s.picture, { keepNext: s.steps.length > 0 }));
      kids.push(...stepParas, ...bulletParas);
    }
    if (s.tip && !side) kids.push(gap(60), box('tip', s.tip));
    if (s.note && !side) kids.push(gap(60), box('note', s.note));
    kids.push(gap(lead || hasPic ? 200 : 120));
  }
  return {
    properties: { ...pageProps() },
    headers: { default: emptyHeader() },
    footers: { default: footer(false) },
    children: kids,
  };
}

// startAt ('part' | 'chapter') drops the pages before the first part opener or chapter.
// It exists for previews: Quick Look only draws the first page of a .docx.
async function buildDocx(model, outFile, { assets, warn = console.warn, startAt = null } = {}) {
  const counter = { next: 1 };
  let sections = [cover(model, assets)];
  sections.push({
    properties: { ...pageProps() },
    headers: { default: emptyHeader() },
    footers: { default: footer(false) },
    children: [...contents(model), ...howTo(model, assets)],
  });
  for (const p of model.parts) {
    sections.push(partOpener(p, assets));
    for (const ch of p.chapters) sections.push(chapter(ch, assets, counter));
  }
  if (startAt === 'part') sections = sections.slice(2);
  if (startAt === 'chapter') sections = sections.slice(3);

  const doc = new Document({
    creator: 'Depot',
    title: model.title,
    subject: model.subtitle,
    description: `${model.subtitle}. ${model.edition}.`,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: PT(12), color: C.ink },
          paragraph: { spacing: { line: 320, lineRule: 'auto', after: 140 } },
        },
        title: { run: { font: FONT, size: PT(46), bold: true, color: 'FFFFFF' }, paragraph: { spacing: { after: 300 } } },
        heading1: { run: { font: FONT, size: PT(26), bold: true, color: C.ink }, paragraph: { keepNext: true, keepLines: true, spacing: { before: 0, after: 200, line: 260 } } },
        heading2: { run: { font: FONT, size: PT(17), bold: true, color: C.ink }, paragraph: { keepNext: true, keepLines: true, spacing: { before: 200, after: 120, line: 280 } } },
        listParagraph: { run: { font: FONT } },
      },
    },
    numbering: {
      config: [
        {
          reference: 'steps',
          levels: [{
            level: 0, format: LevelFormat.DECIMAL, text: '%1', alignment: AlignmentType.LEFT,
            style: { run: { font: FONT, bold: true, color: C.callout, size: PT(13) }, paragraph: { indent: { left: TW(0.46), hanging: TW(0.46) } } },
          }],
        },
        {
          reference: 'bullets',
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
            style: { run: { color: C.inkSoft, size: PT(12) }, paragraph: { indent: { left: TW(0.46), hanging: TW(0.26) } } },
          }],
        },
      ],
    },
    sections,
  });

  let buf = await Packer.toBuffer(doc);
  buf = await withFontFallback(buf);
  fs.writeFileSync(outFile, buf);
  return outFile;
}

// Word picks a stand-in from the font table when a font is missing. docx writes no table
// entry for fonts it does not embed, so add Aptos (stand-in: Calibri) and Calibri.
async function withFontFallback(buf) {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('word/fontTable.xml');
  if (!f) return buf;
  let xml = await f.async('string');
  const fonts =
    '<w:font w:name="Aptos"><w:altName w:val="Calibri"/><w:panose1 w:val="020B0004020202020204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>' +
    '<w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>';
  if (/<w:fonts\b[^>]*\/>/.test(xml)) xml = xml.replace(/<w:fonts\b([^>]*)\/>/, `<w:fonts$1>${fonts}</w:fonts>`);
  else if (xml.includes('</w:fonts>') && !xml.includes('w:name="Aptos"')) xml = xml.replace('</w:fonts>', `${fonts}</w:fonts>`);
  zip.file('word/fontTable.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildDocx };
