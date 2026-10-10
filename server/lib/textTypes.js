'use strict';
// File types the built-in editor opens and saves as plain text, by extension. The page
// keeps the same list (TEXT_EDIT_EXTS in index.html; a test checks they match).
// Left out on purpose: types that are often not UTF-8 (.reg and .rdp are usually
// UTF-16), so saving them as text would corrupt them.
const EDITABLE_TEXT_EXTS = [
  'txt', 'md', 'markdown', 'log', 'json', 'csv', 'tsv',
  'conf', 'config', 'cfg', 'ini', 'properties', 'env', 'toml', 'yaml', 'yml', 'xml',
  'html', 'htm', 'css', 'scss', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'php', 'py', 'rb', 'pl',
  'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'sh', 'bash', 'zsh', 'sql', 'nfo', 'srt', 'vtt',
];
const EDITABLE = new Set(EDITABLE_TEXT_EXTS);
const extOf = (name) => (String(name || '').split('.').pop() || '').toLowerCase();
const isEditableText = (name) => EDITABLE.has(extOf(name));
module.exports = { EDITABLE_TEXT_EXTS, isEditableText, extOf };
