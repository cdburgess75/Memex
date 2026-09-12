-- Piece 4: folder shares follow their folder.
--
-- Nothing here changes who can open what: documentAccess.condition() reads none of these
-- tables. They are the record of what a folder operation did -- which shares it ended and
-- which documents it trashed -- so that an undo can put it back and a manager can be told
-- what happened, plus the indexes the new path lookups need.

-- Which library a chunked upload is landing in, so a rename can carry an in-flight
-- session with it. Completed sessions take it from their document; active ones are left
-- NULL and resolve the way they do today.
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS library_id UUID;
UPDATE upload_sessions s SET library_id = (SELECT d.library_id FROM documents d WHERE d.id = s.document_id)
 WHERE s.library_id IS NULL AND s.document_id IS NOT NULL;

-- One row per structural folder operation, so it can be named, audited and undone.
CREATE TABLE IF NOT EXISTS folder_ops (
  op_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id        UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  target_library_id UUID,
  kind              TEXT NOT NULL CHECK (kind IN ('rename','reparent','delete','library_move','release_keep')),
  path              TEXT NOT NULL,
  new_path          TEXT,
  actor             UUID,
  actor_email       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ,
  undone_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS folder_ops_lib_path_idx ON folder_ops (library_id, path, created_at DESC);

-- Which documents an operation put in the Trash. ON DELETE CASCADE means a document
-- purged in the meantime simply drops out of the operation, which is what an undo needs.
CREATE TABLE IF NOT EXISTS folder_op_documents (
  op_id       UUID NOT NULL REFERENCES folder_ops(op_id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (op_id, document_id)
);

-- Shares an operation ended, kept so an undo can re-create them and so the folder's
-- Share panel can offer "share these people again". group_id has no foreign key on
-- purpose: the group may be gone by the time anyone looks.
CREATE TABLE IF NOT EXISTS library_grants_ended (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  op_id         UUID NOT NULL,
  grant_id      UUID NOT NULL,
  library_id    UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path   TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_email TEXT,
  group_id      UUID,
  permission    TEXT NOT NULL,
  granted_at    TIMESTAMPTZ,
  cause         TEXT NOT NULL CHECK (cause IN ('folder_deleted','moved_to_library','folder_purged')),
  ended_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_by      UUID,
  ended_by_email TEXT,
  restored_at   TIMESTAMPTZ,
  restored_op   UUID
);
CREATE INDEX IF NOT EXISTS library_grants_ended_op_idx   ON library_grants_ended (op_id);
CREATE INDEX IF NOT EXISTS library_grants_ended_path_idx ON library_grants_ended (library_id, folder_path) WHERE restored_at IS NULL;

-- "Is anything still under this folder?" runs on every per-file trash, rename-out and
-- transfer under a shared folder. starts_with() cannot use an index; this can.
-- text_pattern_ops compares byte by byte whatever the collation is.
CREATE INDEX IF NOT EXISTS documents_lib_name_pattern_idx
  ON documents (library_id, name text_pattern_ops) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS library_grants_lib_path_idx      ON library_grants (library_id, folder_path);
CREATE INDEX IF NOT EXISTS folder_notify_prefs_lib_path_idx ON folder_notify_prefs (library_id, folder_path);
CREATE INDEX IF NOT EXISTS upload_sessions_lib_active_idx   ON upload_sessions (library_id) WHERE status = 'active';

-- Dead since the inbound-upload rewrite: the table was never read again, only its DDL remained.
DROP TABLE IF EXISTS upload_links;
