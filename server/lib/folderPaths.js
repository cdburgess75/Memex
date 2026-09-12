'use strict';
// Folder paths are the identity of a folder: a folder IS the set of documents whose name
// starts with 'path/'. These are the pure rules for moving one path onto another, shared
// by every structural operation so they cannot drift apart.
//
// Everything counts CODE POINTS, not UTF-16 units: Postgres substring(from n) and the
// char_length in library_grants' CHECK both count code points, so a folder named with an
// emoji in it would otherwise be cut one character short.

const codePoints = (s) => Array.from(String(s || '')).length;

// The parameter Postgres needs for substring(x from $cut): one past the old path.
const cutFor = (oldPath) => codePoints(oldPath) + 1;

const parentOf = (path) => String(path || '').split('/').slice(0, -1).join('/');
const baseOf = (path) => String(path || '').split('/').pop();

// Is `path` the folder itself, or inside it?
const isAtOrUnder = (path, folder) => path === folder || String(path || '').startsWith(`${folder}/`);
const isUnder = (path, folder) => String(path || '').startsWith(`${folder}/`);

// The one rule every rewrite follows: old -> new, and everything under old moves with it.
// Anything else is left exactly as it is.
function rekey(path, oldPath, newPath) {
  const p = String(path || '');
  if (p === oldPath) return newPath;
  if (isUnder(p, oldPath)) return newPath + p.slice(oldPath.length);
  return p;
}

// Moving a folder into itself (or into its own child) is not a move.
const movesIntoItself = (oldPath, target) => target === oldPath || isUnder(target, oldPath);

module.exports = { codePoints, cutFor, parentOf, baseOf, isAtOrUnder, isUnder, rekey, movesIntoItself };
