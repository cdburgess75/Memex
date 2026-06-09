'use strict';

async function extractText(buffer, filename) {
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
