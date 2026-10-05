'use strict';
// Postgres TEXT cannot hold U+0000, so extracted text never carries one: a PDF that
// yields a NUL must still upload, with the NUL gone and the rest of the text kept.
jest.mock('pdf-parse', () => jest.fn(async () => ({ text: 'Cyber Security\u0000 Checklist\u0000' })));
const { extractText } = require('../../lib/textExtraction');

test('a NUL in text extracted from a PDF is removed', async () => {
  expect(await extractText(Buffer.from('%PDF'), 'Checklist.pdf')).toBe('Cyber Security Checklist');
});

test('a NUL byte in a plain-text file is removed', async () => {
  expect(await extractText(Buffer.from('before\u0000after\u0000', 'utf8'), 'notes.txt')).toBe('beforeafter');
});

test('text without a NUL comes back unchanged, and an unreadable type is still null', async () => {
  expect(await extractText(Buffer.from('plain words\n', 'utf8'), 'notes.md')).toBe('plain words\n');
  expect(await extractText(Buffer.from([0, 1, 2]), 'photo.jpg')).toBeNull();
});
