'use strict';
// The two readings of a folder path (lib/documents.js). folderLookupPath finds a folder
// that exists, so it refuses only what no stored name can contain; canonicalFolderPath
// is the shape a folder must have to be shared, and migration 0007's CHECK on
// library_grants.folder_path spells out the same rules (checked against real Postgres
// in integration/librarySharing.pg.test.js).
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/storage', () => ({}));
jest.mock('../../lib/libraries', () => ({}));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn() }));
jest.mock('../../lib/fileEvents', () => ({ logEvent: jest.fn(), logDocumentEvent: jest.fn() }));

const { canonicalFolderPath, folderLookupPath, DOCUMENT_COLUMNS } = require('../../lib/documents');
const ch = (...codes) => String.fromCodePoint(...codes);

describe('canonicalFolderPath (the shape a shared folder must have)', () => {
  test.each([
    ['Clients/Acme', 'Clients/Acme'],
    ['/Clients//Acme/', 'Clients/Acme'],
    ['Clients\\Acme', 'Clients/Acme'],
    ['Tax & Co', 'Tax & Co'],
    ['...', '...'],
    ['.hidden/x', '.hidden/x'],
    ['a b/c d', 'a b/c d'],
  ])('%p -> %p', (raw, want) => expect(canonicalFolderPath(raw)).toBe(want));

  test.each([
    ['not a string', 42], ['null', null], ['empty', ''], ['only slashes', '//'],
    ['a . segment', 'a/./b'], ['a .. segment', '../etc'],
    ['a C0 control', 'a' + ch(0x01) + 'b'], ['a newline', 'a\nb'], ['DEL', 'a' + ch(0x7f)],
    ['a C1 control', 'a' + ch(0x92) + 'b'],
    ['a leading space in a segment', 'a/ b'], ['a trailing space', 'a /b'],
    ['a trailing space on the last segment', 'a/b '], ['a no-break space at an edge', ch(0xa0) + 'a'],
    ['an ideographic space at an edge', 'a' + ch(0x3000)],
  ])('refuses %s', (_label, raw) => expect(canonicalFolderPath(raw)).toBeNull());

  test('counts characters, not UTF-16 units, against the 400 cap', () => {
    const emoji = ch(0x1F4C1);
    expect(canonicalFolderPath('x'.repeat(400))).toBe('x'.repeat(400));
    expect(canonicalFolderPath('x'.repeat(401))).toBeNull();
    // 255 emoji: 510 UTF-16 units, 255 characters, 1020 bytes -- allowed
    expect(canonicalFolderPath(emoji.repeat(255))).toBe(emoji.repeat(255));
  });

  test('and caps the bytes at 1024 (the unique index key)', () => {
    const cjk = ch(0x4E2D); // three bytes
    expect(canonicalFolderPath(cjk.repeat(341))).toBe(cjk.repeat(341)); // 1023 bytes
    expect(canonicalFolderPath(cjk.repeat(342))).toBeNull();            // 1026 bytes
  });
});

describe('folderLookupPath (finding a folder that exists)', () => {
  test.each([
    ['a C1 control an outside upload kept', 'Caf' + ch(0xe9) + '/Old' + ch(0x92) + 's'],
    ['a pre-trim legacy name', 'Clients/ Edge '],
    ['a long CJK path', ch(0x4E2D).repeat(360)],
    ['1000 characters', 'x'.repeat(1000)],
  ])('reaches %s', (_label, raw) => expect(folderLookupPath(raw)).toBe(raw));

  test.each([
    ['empty', ''], ['not a string', undefined], ['..', 'a/../b'], ['.', './a'],
    ['a C0 control', 'a' + ch(0x1f)], ['over 1000 characters', 'x'.repeat(1001)],
  ])('refuses %s', (_label, raw) => expect(folderLookupPath(raw)).toBeNull());

  test('tidies separators the same way', () => {
    expect(folderLookupPath('\\Clients\\\\Acme\\')).toBe('Clients/Acme');
  });
});

test('document rows carry their library (the app groups files by it)', () => {
  expect(DOCUMENT_COLUMNS.split(',').map(c => c.trim())).toContain('library_id');
});
