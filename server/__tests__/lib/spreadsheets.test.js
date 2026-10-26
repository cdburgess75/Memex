'use strict';
// Every server path that parses or writes a spreadsheet, run on the real SheetJS: the
// text extracted for search, and the blank workbook behind "New Excel spreadsheet".
// A hostile file must fail as an ordinary error (the callers treat that as "no text")
// and must never reach past the workbook it came in.
const XLSX = require('xlsx');
const { extractText } = require('../../lib/textExtraction');
const { blankFile } = require('../../lib/blankDocs');
const { STOCK_TEXT, workbook, prototypeNamedXlsx, HTML_AS_XLS } = require('../helpers/sheetFiles');

const protoNames = () => Object.getOwnPropertyNames(Object.prototype).sort();

describe('text extracted for search', () => {
  test('an .xlsx gives every sheet, by name, as CSV', async () => {
    expect(await extractText(workbook('xlsx'), 'Stock.xlsx')).toBe(STOCK_TEXT);
  });

  test('an old binary .xls reads the same', async () => {
    expect(await extractText(workbook('biff8'), 'Stock.xls')).toBe(STOCK_TEXT);
  });

  test('a .csv is read as one sheet', async () => {
    expect(await extractText(Buffer.from('a,b\n1,2\n'), 'list.csv')).toBe('## Sheet1\n\na,b\n1,2');
  });

  test('the text stops at 100,000 characters however big the sheet', async () => {
    const rows = Array.from({ length: 20000 }, (_, i) => [`row ${i}`, 'x'.repeat(20)]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Big');
    const text = await extractText(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'big.xlsx');
    expect(text.length).toBe(100000);
    expect(text.startsWith('## Big\n\nrow 0,')).toBe(true);
  });
});

describe('a malformed or hostile spreadsheet', () => {
  test('a truncated .xlsx is refused with an error', async () => {
    const whole = workbook('xlsx');
    await expect(extractText(whole.subarray(0, whole.length >> 1), 'cut.xlsx')).rejects.toThrow();
  });

  test('bytes that only start like a zip are refused with an error', async () => {
    await expect(extractText(Buffer.from([0x50, 0x4b, 3, 4, 9, 9, 9, 9, 1, 2, 3]), 'bad.xlsx')).rejects.toThrow();
  });

  test('sheet and defined names that are Object.prototype keys pollute nothing', async () => {
    const before = protoNames();
    const text = await extractText(prototypeNamedXlsx(), 'proto.xlsx');
    expect(protoNames()).toEqual(before);
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.constructor).toBe(Object);
    // The cell text is kept as text: search may find it, nothing runs it.
    expect(text).toContain('polluted,<script>x</script>');
  });

  test('an HTML page named .xls yields its cell text only, never its markup', async () => {
    const text = await extractText(HTML_AS_XLS, 'page.xls');
    expect(text).toContain('hi');
    expect(text).not.toMatch(/<img|onerror|<script/i);
  });

  test('a long run of quotes and separators finishes promptly', async () => {
    const nasty = Buffer.from('"'.repeat(50000) + ','.repeat(50000) + ' \t'.repeat(25000));
    const t0 = Date.now();
    await extractText(nasty, 'nasty.csv').catch(() => null);
    await extractText(nasty, 'nasty.xls').catch(() => null);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('a new blank spreadsheet', () => {
  test('is a real .xlsx with one empty sheet', () => {
    const blank = blankFile('xlsx', 'Budget');
    expect(blank.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(blank.buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4])); // a zip
    const wb = XLSX.read(blank.buffer, { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Sheet1']);
    expect(XLSX.utils.sheet_to_csv(wb.Sheets.Sheet1)).toBe('');
  });
});
