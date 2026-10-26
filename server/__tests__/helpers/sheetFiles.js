'use strict';
// Spreadsheet bytes for the tests that parse them: real ones written by SheetJS, and
// hostile ones assembled by hand from raw OOXML parts.
const XLSX = require('xlsx');

const STOCK = [['Item', 'Qty'], ['Widget', 3]];
const NOTES = [['Note'], ['a,b']];
// What extractText makes of a workbook holding STOCK and NOTES, in any of its formats.
const STOCK_TEXT = '## Stock\n\nItem,Qty\nWidget,3\n\n## Notes\n\nNote\n"a,b"';

function workbook(bookType) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(STOCK), 'Stock');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(NOTES), 'Notes');
  return XLSX.write(wb, { type: 'buffer', bookType });
}

// A zip of the given { path: xml } parts, built with SheetJS's own container writer.
function ooxml(parts) {
  const cfb = XLSX.CFB.utils.cfb_new();
  for (const [name, xml] of Object.entries(parts)) XLSX.CFB.utils.cfb_add(cfb, name, Buffer.from(xml, 'utf8'));
  return Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
}

const NS = 'http://schemas.openxmlformats.org';
// A workbook whose names are the keys of Object.prototype: a sheet called __proto__, a
// defined name called constructor, and a cell asking to be markup.
function prototypeNamedXlsx() {
  return ooxml({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="__proto__" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="constructor">__proto__!$A$1</definedName></definedNames></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>polluted</t></is></c><c r="B1" t="inlineStr"><is><t>&lt;script&gt;x&lt;/script&gt;</t></is></c></row></sheetData></worksheet>`,
  });
}

// An HTML page saved as .xls (SheetJS reads HTML tables), carrying script and a handler.
const HTML_AS_XLS = Buffer.from('<html><body><table><tr><td><img src=x onerror=alert(1)>hi</td><td><script>alert(2)</script></td></tr></table></body></html>');

module.exports = { STOCK_TEXT, workbook, ooxml, prototypeNamedXlsx, HTML_AS_XLS };
