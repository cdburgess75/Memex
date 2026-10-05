'use strict';

// Postgres TEXT cannot hold U+0000, and some PDFs yield it: one in the text refuses the
// whole upload ("invalid byte sequence for encoding UTF8: 0x00"). Every caller stores what
// this returns, so it is stripped here, once, and no path can store it.
const stripNul = (text) => (typeof text === 'string' ? text.replace(/\u0000/g, '') : text);

async function extractText(buffer, filename) {
  return stripNul(await extractRawText(buffer, filename));
}

async function extractRawText(buffer, filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const MAX = 100_000;

  if (ext === 'docx' || ext === 'doc') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value.slice(0, MAX);
  }

  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    return wb.SheetNames.map(name =>
      `## ${name}\n\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`
    ).join('\n\n').slice(0, MAX);
  }

  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    return (await pdfParse(buffer)).text.slice(0, MAX);
  }

  if (['txt', 'md', 'csv'].includes(ext)) return buffer.toString('utf8').slice(0, MAX);
  return null;
}

module.exports = { extractText };
