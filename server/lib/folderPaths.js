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

// The path a folder gets when somebody renames it. A folder name is one segment, and the
// characters that mean something in HTML or in a path are replaced -- so the name that
// comes back is not always the name that was typed. The preview and the rename itself
// both go through here, because an answer shown for one name and carried out on another
// is not an answer at all. null when the name cannot be a folder name.
function renamedPath(oldPath, rawName) {
  const name = String(rawName || '').trim();
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return null;
  const parent = parentOf(oldPath);
  const safe = name.replace(/[^a-zA-Z0-9._ -]/g, '_');
  return parent ? `${parent}/${safe}` : safe;
}

// Moving a folder into itself (or into its own child) is not a move.
const movesIntoItself = (oldPath, target) => target === oldPath || isUnder(target, oldPath);

module.exports = { codePoints, cutFor, parentOf, baseOf, isAtOrUnder, isUnder, rekey, renamedPath, movesIntoItself };
