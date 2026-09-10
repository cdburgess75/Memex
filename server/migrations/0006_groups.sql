-- Groups: a named list of people that libraries can later be shared with.
--
-- This is piece 1 of the access model (see memory: depot-access-model-decisions).
-- On its own a group grants nothing — nothing in the access predicate reads these
-- tables yet. Sharing a library or folder with a group arrives in piece 2. Shipping
-- groups first lets owners set them up with zero change to who can open what.
--
-- Decisions this encodes:
--   * Groups are Depot-native and flat — no nesting, not synced from a directory.
--   * Membership is an explicit list of email addresses, and may include people
--     outside the organisation (a client's accountant, a vendor). Email is the key
--     because an outside contact is usually added before they have ever signed in,
--     so there is no user id to key on yet.
--   * Whoever creates a group owns and manages it; global admins can manage any.

CREATE TABLE IF NOT EXISTS groups (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  owner_id          UUID,
  owner_email       TEXT,
  created_by        UUID,
  created_by_email  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Names are unique regardless of case. Once libraries can be shared with a group,
-- a picker offering two groups both called "All Staff" is a way to grant access to
-- the wrong one by mistake — or on purpose.
CREATE UNIQUE INDEX IF NOT EXISTS groups_name_lower_uniq ON groups (lower(name));

CREATE TABLE IF NOT EXISTS group_members (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_email    TEXT        NOT NULL,
  added_by        UUID,
  added_by_email  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per person per group, however their address was capitalised.
CREATE UNIQUE INDEX IF NOT EXISTS group_members_uniq ON group_members (group_id, lower(member_email));

-- "Which groups is this person in?" — what piece 2's access predicate will ask on
-- every document read, so it is indexed now rather than retrofitted onto a hot path.
CREATE INDEX IF NOT EXISTS group_members_email_idx ON group_members (lower(member_email));
