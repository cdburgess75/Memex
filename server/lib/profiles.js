'use strict';
// Per-user profile (display name + avatar) stored in our DB, overlaying the
// Keycloak identity. Idempotent runtime migration, same pattern as lib/libraries.js.
const db = require('./db');

let ensured = false;

async function ensureProfiles() {
  if (ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id       UUID        PRIMARY KEY,
      email         TEXT,
      display_name  TEXT,
      avatar        TEXT,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  ensured = true;
}

async function getProfile(userId) {
  await ensureProfiles();
  if (!userId) return null;
  return db.queryOne('SELECT user_id, email, display_name, avatar FROM user_profiles WHERE user_id = $1', [userId]);
}

async function setProfile(user, { display_name, avatar } = {}) {
  await ensureProfiles();
  return db.queryOne(
    `INSERT INTO user_profiles (user_id, email, display_name, avatar, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name),
       avatar = COALESCE(EXCLUDED.avatar, user_profiles.avatar),
       updated_at = NOW()
     RETURNING user_id, email, display_name, avatar`,
    [user.id, user.email || null, display_name ?? null, avatar ?? null]
  );
}

module.exports = { ensureProfiles, getProfile, setProfile };
