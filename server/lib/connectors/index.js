'use strict';
// Storage-connector registry: the adapter catalog, and CRUD over `storage_connectors`
// with credentials encrypted at rest.
//
// Adding a provider is one file plus one line here. The Settings UI is generated from
// each adapter's `fields`, and the route layer dispatches by `kind`, so nothing else
// in the app needs to learn about a new system.
const db = require('../db');
const settings = require('../settings');
const enc = require('../encryption');
const base = require('./base');

const ADAPTERS = {};
for (const mod of [require('./smb'), require('./sharepoint')]) {
  ADAPTERS[mod.kind] = mod;
}

function adapterFor(kind) {
  const a = ADAPTERS[kind];
  if (!a) {
    const e = new Error(`unknown connector type "${kind}"`);
    e.status = 400;
    throw e;
  }
  return a;
}

// What the Settings UI renders its forms from. Deliberately contains no values —
// just the shape of each provider.
function catalog() {
  return Object.values(ADAPTERS).map((a) => ({
    kind: a.kind,
    label: a.label,
    blurb: a.blurb,
    caps: a.caps,
    fields: (a.fields || []).map((f) => ({
      key: f.key, label: f.label, type: f.type, required: !!f.required,
      secret: !!f.secret, placeholder: f.placeholder || '', help: f.help || '',
      default: f.default ?? '',
    })),
  }));
}

async function encKey() {
  const raw = await settings.getOrEnv('storage_encryption_key');
  const key = enc.resolveKey(raw);
  if (!key) {
    // Refusing is the right call: storing a file-server password in plaintext
    // because the deployment happens to lack a key would be a silent downgrade.
    const e = new Error('STORAGE_ENCRYPTION_KEY must be set before saving connector credentials');
    e.status = 400;
    throw e;
  }
  return key;
}

async function sealSecrets(obj) {
  if (!obj || !Object.keys(obj).length) return null;
  return enc.encrypt(Buffer.from(JSON.stringify(obj), 'utf8'), await encKey());
}

async function openSecrets(buf) {
  if (!buf || !buf.length) return {};
  try {
    return JSON.parse(enc.decrypt(Buffer.from(buf), await encKey()).toString('utf8'));
  } catch {
    // A key rotation (or a restore against the wrong key) makes these undecryptable.
    // Surface it as a connector-level failure rather than crashing a browse request.
    const e = new Error('stored credentials could not be decrypted — re-enter them for this connection');
    e.status = 400;
    throw e;
  }
}

// The client-safe view: never includes the secret column, and marks which secret
// fields are already populated so the UI can show "unchanged" instead of a blank.
function publicView(row, adapter) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    label: adapter ? adapter.label : row.kind,
    caps: adapter ? adapter.caps : {},
    config: row.config || {},
    hasSecrets: Boolean(row.secret && row.secret.length),
    enabled: row.enabled,
    readOnly: row.read_only,
    lastStatus: row.last_status || null,
    lastError: row.last_error || null,
    lastCheckedAt: row.last_checked_at || null,
  };
}

async function list() {
  const rows = await db.query(
    `SELECT id, name, kind, config, secret, enabled, read_only, last_status, last_error, last_checked_at
       FROM storage_connectors ORDER BY name`
  );
  return rows.map((r) => publicView(r, ADAPTERS[r.kind]));
}

async function getRow(id) {
  const row = await db.queryOne(
    `SELECT id, name, kind, config, secret, enabled, read_only, last_status, last_error, last_checked_at
       FROM storage_connectors WHERE id = $1`,
    [id]
  );
  if (!row) {
    const e = new Error('connection not found');
    e.status = 404;
    throw e;
  }
  return row;
}

// Everything a request needs to actually talk to the remote system: the row, the
// adapter, and a merged config with decrypted credentials.
async function resolve(id) {
  const row = await getRow(id);
  const adapter = adapterFor(row.kind);
  if (!row.enabled) {
    const e = new Error('this connection is disabled');
    e.status = 403;
    throw e;
  }
  const cfg = { ...(row.config || {}), ...(await openSecrets(row.secret)) };
  return { row, adapter, cfg };
}

async function create(values, userId) {
  const adapter = adapterFor(values.kind);
  const name = String(values.name || '').trim().slice(0, 200);
  if (!name) {
    const e = new Error('name required');
    e.status = 400;
    throw e;
  }
  const missing = base.missingRequired(adapter, values);
  if (missing.length) {
    const e = new Error(`missing required field(s): ${missing.join(', ')}`);
    e.status = 400;
    throw e;
  }
  const { config, secrets } = base.splitFields(adapter, values);
  const row = await db.queryOne(
    `INSERT INTO storage_connectors (name, kind, config, secret, enabled, read_only, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     RETURNING id, name, kind, config, secret, enabled, read_only, last_status, last_error, last_checked_at`,
    [name, adapter.kind, JSON.stringify(config), await sealSecrets(secrets),
     values.enabled !== false, values.readOnly !== false, userId || null]
  );
  return publicView(row, adapter);
}

async function update(id, values) {
  const existing = await getRow(id);
  const adapter = adapterFor(existing.kind);
  const prevSecrets = await openSecrets(existing.secret);
  const { config, secrets } = base.splitFields(adapter, values);

  // A blank secret field means "leave it alone", so editing a connector's root path
  // doesn't require re-typing the password. An explicit new value replaces it.
  const mergedSecrets = { ...prevSecrets };
  for (const [k, v] of Object.entries(secrets)) {
    if (String(v).trim()) mergedSecrets[k] = v;
  }
  const mergedConfig = { ...(existing.config || {}), ...config };

  const row = await db.queryOne(
    `UPDATE storage_connectors
        SET name = $2, config = $3::jsonb, secret = $4, enabled = $5, read_only = $6, updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, kind, config, secret, enabled, read_only, last_status, last_error, last_checked_at`,
    [id, String(values.name || existing.name).trim().slice(0, 200), JSON.stringify(mergedConfig),
     await sealSecrets(mergedSecrets),
     values.enabled === undefined ? existing.enabled : values.enabled !== false,
     values.readOnly === undefined ? existing.read_only : values.readOnly !== false]
  );
  return publicView(row, adapter);
}

async function remove(id) {
  await getRow(id);
  await db.query('DELETE FROM storage_connectors WHERE id = $1', [id]);
}

async function recordTest(id, ok, message) {
  await db.query(
    `UPDATE storage_connectors
        SET last_status = $2, last_error = $3, last_checked_at = NOW()
      WHERE id = $1`,
    [id, ok ? 'ok' : 'error', ok ? null : String(message || '').slice(0, 500)]
  );
}

module.exports = {
  ADAPTERS, adapterFor, catalog, list, getRow, resolve,
  create, update, remove, recordTest, publicView,
};
