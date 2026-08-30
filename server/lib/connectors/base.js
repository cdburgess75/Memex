'use strict';
// The contract every storage-connector adapter implements, plus the path handling
// all of them share.
//
// An adapter is a plain object:
//
//   {
//     kind:  'smb',                       // stable id, stored in storage_connectors.kind
//     label: 'SMB / Windows file share',  // shown in Settings
//     blurb: 'one line describing it',
//     caps:  { write, remove, mkdir, range },
//     fields: [ …declarative form schema… ],
//     async test(cfg)                  -> { ok, message }
//     async list(cfg, path)            -> [ Entry ]
//     async stat(cfg, path)            -> Entry
//     async read(cfg, path, opts)      -> { stream, size?, mime? }
//     async write(cfg, path, readable) -> void      (only if caps.write)
//     async remove(cfg, path)          -> void      (only if caps.remove)
//     async mkdir(cfg, path)           -> void      (only if caps.mkdir)
//   }
//
// Entry: { name, path, type: 'dir'|'file', size, modified }
//
// `fields` is what makes Settings extensible without touching the UI: the client
// fetches the adapter catalog and renders the form from this schema, so a new
// provider becomes configurable the moment its adapter is registered. Each field is
//
//   { key, label, type: 'text'|'password'|'number'|'bool', required?, secret?,
//     placeholder?, help?, default? }
//
// Fields marked `secret: true` are encrypted at rest and never sent back to a client.

// Path traversal is the whole ballgame for a connector: the operator scopes a mount
// to one share or one site, and a request must not be able to climb out of it. We
// resolve the path ourselves rather than trusting the remote system to refuse,
// because each backend has different (and sometimes forgiving) semantics.
//
// Returns a clean, root-relative path with no leading slash: 'a/b/c' or '' for root.
function badPath(message) {
  // A malformed or escaping path is the caller's mistake, not a server fault: it
  // must surface as 400 with the reason, not as a generic 500 that also fills the
  // error log with routine probing.
  const e = new Error(message);
  e.status = 400;
  return e;
}

function normalizePath(input) {
  const raw = String(input == null ? '' : input);
  // A NUL can truncate a path inside a native/remote layer that is not JS.
  if (raw.includes('\0')) throw badPath('invalid path');
  const out = [];
  for (const rawSeg of raw.split(/[/\\]+/)) {
    const seg = rawSeg.trim();
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      // Refuse rather than silently clamping at the root: a request that tried to
      // escape is a request we should not quietly reinterpret into a different one.
      if (!out.length) throw badPath('path escapes the connector root');
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

// Join the operator-configured root with a caller path. The root is trusted (an
// admin typed it); the caller path is not.
function resolveWithinRoot(rootPath, callerPath) {
  const root = normalizePath(rootPath || '');
  const rel = normalizePath(callerPath || '');
  return root && rel ? `${root}/${rel}` : root || rel;
}

// Adapters describe capabilities; the route layer enforces them so no adapter has to
// remember to. Also gates on the connector's read_only flag.
function assertCapability(adapter, connector, cap) {
  if (!adapter.caps || !adapter.caps[cap]) {
    const e = new Error(`${adapter.label} does not support ${cap}`);
    e.status = 501;
    throw e;
  }
  if (connector.read_only && cap !== 'range') {
    const e = new Error('this connection is mounted read-only');
    e.status = 403;
    throw e;
  }
}

// Split an adapter's declared fields into the plain config and the secret half, so
// the registry can store each in the right column without per-adapter knowledge.
function splitFields(adapter, values) {
  const config = {};
  const secrets = {};
  for (const f of adapter.fields || []) {
    const v = values[f.key];
    if (v === undefined) continue;
    // A bool field posted as the STRING "false" (e.g. by a non-UI API client) must
    // not coerce to true via Boolean("false"); accept only real-truthy / "true"/"1"/"on".
    (f.secret ? secrets : config)[f.key] = f.type === 'bool'
        ? (v === true || v === 1 || ['true', '1', 'on', 'yes'].includes(String(v).toLowerCase()))
      : f.type === 'number' ? Number(v)
      : String(v);
  }
  return { config, secrets };
}

function missingRequired(adapter, values) {
  return (adapter.fields || [])
    .filter((f) => f.required && !String(values[f.key] ?? '').trim())
    .map((f) => f.label);
}

module.exports = {
  normalizePath,
  resolveWithinRoot,
  assertCapability,
  splitFields,
  missingRequired,
};
