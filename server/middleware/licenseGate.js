'use strict';
// The read-only gate. While the license says readonly (lib/license.js: the term and
// its grace period are over, or an unlicensed install has been one for 30 days),
// requests that would change the workspace's content are refused with
// 403 LICENSE_READONLY. Everything that reads, downloads, signs in, or lets an
// administrator repair the license keeps working: settings, setup, the license
// endpoints, tokens, connectors, backups, notifications, preferences.
//
// Mounted once in index.js, after the rate limiters and before every router, so a
// new content route is covered by its prefix without remembering to add a check.
const enforce = require('../lib/licenseEnforce');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DAV_WRITES = new Set(['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY', 'PROPPATCH']);

// Content routers. Mutating methods under these prefixes stop, except the listed
// paths: reads that happen to be POSTs, and a person's own notification choices.
const RULES = [
  { prefix: '/api/files', except: [
    /^\/api\/files\/[^/]+\/open$/,                              // "I opened this file" (a read)
    /^\/api\/files\/share\/[^/]+\/(opened|ticket)$/,            // share links: opened, password -> ticket
    /^\/api\/files\/folder\/zip-ticket$/,                       // a download ticket
    /^\/api\/files\/folder\/share\/[^/]+\/(opened|ticket)$/,    // folder links: the same
    /^\/api\/files\/watch(\/|$)/, /^\/api\/files\/[^/]+\/follow$/, // notification choices
  ] },
  { prefix: '/api/libraries' },
  { prefix: '/api/groups' },
  { prefix: '/api/access', except: [/^\/api\/access\/folder-preview$/] },
  { prefix: '/api/meetings' },
  { prefix: '/api/ai', except: [/^\/api\/ai\/query$/, /^\/api\/ai\/active$/, /^\/api\/ai\/detect-models$/] },
  { prefix: '/api/v1', except: [/^\/api\/v1\/admin\//] },
  { prefix: '/wopi' },
  { prefix: '/dav', methods: DAV_WRITES },
];

function blocked(method, path) {
  const rule = RULES.find((r) => path === r.prefix || path.startsWith(r.prefix + '/'));
  if (!rule) return false;
  if (!(rule.methods || MUTATING).has(String(method).toUpperCase())) return false;
  return !(rule.except || []).some((re) => re.test(path));
}

async function licenseGate(req, res, next) {
  if (!blocked(req.method, req.path)) return next();
  let ro = false;
  try { ro = await enforce.readOnly(); } catch { ro = false; }
  return ro ? enforce.refuse(res) : next();
}

module.exports = licenseGate;
module.exports.blocked = blocked;
module.exports.RULES = RULES;
