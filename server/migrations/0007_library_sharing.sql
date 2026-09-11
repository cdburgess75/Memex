-- Piece 2 groundwork: library ownership, verified addresses, and the shares table.
--
-- Nothing here grants access. documentAccess.condition() does not read library_grants
-- until the sharing release, and no route writes to it before then; this migration
-- only puts the columns and table in place so later releases can build on them.

-- Libraries are owned by a user id, like groups (0006_groups.sql). The backfill takes
-- the creator where one was recorded; the library seeded at install has none and stays
-- ownerless until the private-by-default release gives it an owner.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS owner_id    UUID;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS owner_email TEXT;
UPDATE libraries SET owner_id = created_by, owner_email = lower(created_by_email)
 WHERE owner_id IS NULL AND created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS libraries_owner_idx ON libraries (owner_id) WHERE owner_id IS NOT NULL;

-- The address the identity provider has verified for each account, kept up to date on
-- every sign-in by middleware/auth.js (NULL when the token says unverified or says
-- nothing). Library, folder and group shares will match only this column, so claiming
-- someone else's address in an unverified account never inherits their shares.
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS verified_email    TEXT;
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS user_roles_verified_email_idx ON user_roles (verified_email) WHERE verified_email IS NOT NULL;

-- Shares of a whole library (folder_path '') or of one folder inside it (a live path
-- prefix: files added to the folder later are covered too). A share goes to one person
-- by address or to one group, at read or write — never 'admin', which in Depot means
-- managing a file's own access list, and that stays with owners and admins.
CREATE TABLE IF NOT EXISTS library_grants (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id       UUID        NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path      TEXT        NOT NULL DEFAULT '',
  subject_type     TEXT        NOT NULL CHECK (subject_type IN ('user', 'group')),
  subject_email    TEXT,
  group_id         UUID        REFERENCES groups(id) ON DELETE CASCADE,
  permission       TEXT        NOT NULL CHECK (permission IN ('read', 'write')),
  granted_by       UUID,
  granted_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- exactly one subject, and a person's address stored the way it will be matched
  CONSTRAINT library_grants_one_subject CHECK (
       (subject_type = 'user' AND group_id IS NULL AND subject_email IS NOT NULL
        AND subject_email = lower(btrim(subject_email)) AND char_length(subject_email) BETWEEN 3 AND 254)
    OR (subject_type = 'group' AND group_id IS NOT NULL AND subject_email IS NULL)),
  -- a folder path in the one canonical shape canonicalFolderPath (lib/documents.js)
  -- produces: no leading, trailing or doubled slash, no backslash, no . or .. segment,
  -- no control character (JavaScript's \p{Cc}), no segment starting or ending in
  -- whitespace (JavaScript's \s). Both character sets are spelled out rather than
  -- written [[:cntrl:]] / [[:space:]], whose meaning depends on the database locale, so
  -- the database never refuses a path the code accepted. 400 characters matches the
  -- document name cap; 1024 bytes keeps the widest unique-index key under the btree row
  -- limit even when every character takes four bytes.
  CONSTRAINT library_grants_path_shape CHECK (
       folder_path = ''
    OR (char_length(folder_path) <= 400 AND octet_length(folder_path) <= 1024
        AND left(folder_path, 1) <> '/' AND right(folder_path, 1) <> '/'
        AND position('//' IN folder_path) = 0 AND strpos(folder_path, chr(92)) = 0
        AND folder_path !~ '(^|/)[.][.]?(/|$)'
        AND folder_path !~ '[\x01-\x1f\x7f-\x9f]'
        AND folder_path !~ '(^|/)[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
        AND folder_path !~ '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff](/|$)'))
);
CREATE UNIQUE INDEX IF NOT EXISTS library_grants_user_uniq  ON library_grants (library_id, folder_path, subject_email) WHERE subject_type = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS library_grants_group_uniq ON library_grants (library_id, folder_path, group_id)      WHERE subject_type = 'group';
CREATE INDEX IF NOT EXISTS library_grants_email_idx  ON library_grants (subject_email) WHERE subject_type = 'user';
CREATE INDEX IF NOT EXISTS library_grants_group_idx  ON library_grants (group_id)      WHERE subject_type = 'group';
CREATE INDEX IF NOT EXISTS library_grants_folder_idx ON library_grants (library_id)    WHERE folder_path <> '';
