'use strict';
// Per-user profile (display name + avatar) stored in our DB, overlaying the
// Keycloak identity. Schema: migrations/0004_runtime_ensure_tables.sql.
const db = require('./db');

async function getProfile(userId) {
  if (!userId) return null;
  return db.queryOne('SELECT user_id, email, display_name, avatar FROM user_profiles WHERE user_id = $1', [userId]);
}

async function setProfile(user, { display_name, avatar } = {}) {
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

module.exports = { getProfile, setProfile };
