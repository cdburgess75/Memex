'use strict';
// Guardrails on the most exposed surface in the product: bytes arriving from
// someone with a link, no account, and no training.

const g = require('../../lib/externalUpload');

describe('rejectionFor — what may be uploaded', () => {
  test.each([
    ['report.pdf'], ['Statement 2026.xlsx'], ['deck.pptx'], ['photo.JPG'],
    ['notes.txt'], ['archive.zip'], ['no-extension'],
  ])('accepts an ordinary business file: %s', (name) => {
    expect(g.rejectionFor(name, 1024)).toBeNull();
  });

  test.each([
    ['payload.exe'], ['setup.MSI'], ['script.ps1'], ['run.bat'], ['thing.dll'],
    ['app.jar'], ['installer.dmg'], ['x.sh'], ['sneaky.vbs'], ['disk.iso'],
  ])('refuses an executable: %s', (name) => {
    expect(g.rejectionFor(name, 1024)).toMatch(/can’t be uploaded/);
  });

  test('refuses a double extension pretending to be a document', () => {
    // Shows as "invoice.pdf" in a file list; runs as an executable.
    expect(g.rejectionFor('invoice.pdf.exe', 1024)).toMatch(/can’t be uploaded/);
  });

  test('is case-insensitive — a renamed payload is still refused', () => {
    expect(g.rejectionFor('PAYLOAD.ExE', 10)).toMatch(/can’t be uploaded/);
  });

  test.each([
    ['payload.exe.'], ['payload.exe...'], ['setup.msi. '], ['x.bat.'],
  ])('a trailing dot/space cannot smuggle an executable past the blocklist: %s', (name) => {
    // Windows drops trailing dots/spaces, so these all execute as their base ext.
    expect(g.rejectionFor(name, 10)).toMatch(/can’t be uploaded/);
  });

  test('enforces its own size ceiling, separate from staff limits', () => {
    expect(g.rejectionFor('big.pdf', 101 * 1024 * 1024)).toMatch(/larger than the 100 MB limit/);
    expect(g.rejectionFor('ok.pdf', 99 * 1024 * 1024)).toBeNull();
  });

  test('a custom ceiling is honoured', () => {
    expect(g.rejectionFor('x.pdf', 6 * 1024 * 1024, 5)).toMatch(/5 MB/);
  });

  test('refuses a nameless file', () => {
    expect(g.rejectionFor('', 10)).toMatch(/no name/);
    expect(g.rejectionFor('   ', 10)).toMatch(/no name/);
  });
});

describe('safeRelativePath — a folder drag names folders on our disk', () => {
  test('keeps a genuine folder structure', () => {
    expect(g.safeRelativePath('Tax 2026/Q1/receipt.pdf')).toBe('Tax 2026/Q1');
  });

  test('a file at the root has no folder', () => {
    expect(g.safeRelativePath('receipt.pdf')).toBe('');
    expect(g.safeRelativePath('./receipt.pdf')).toBe('');
    expect(g.safeRelativePath('')).toBe('');
  });

  test.each([
    ['../../etc/passwd'],
    ['..\\..\\windows\\system32\\x.dll'],
    ['/etc/cron.d/x'],
    ['foo/../../../bar/x.pdf'],
  ])('strips traversal: %s', (p) => {
    const out = g.safeRelativePath(p);
    expect(out).not.toMatch(/\.\./);
    expect(out.startsWith('/')).toBe(false);
    expect(out).not.toMatch(/\\/);
  });

  test('caps depth so a crafted tree cannot go a thousand deep', () => {
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join('/') + '/x.pdf';
    expect(g.safeRelativePath(deep).split('/')).toHaveLength(8);
  });

  test('neutralises characters that break paths on disk', () => {
    expect(g.safeRelativePath('we:ird|name/x.pdf')).not.toMatch(/[:|]/);
  });
});
