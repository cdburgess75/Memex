-- Create the Supabase Storage bucket for documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Documents metadata table
CREATE TABLE IF NOT EXISTS documents (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  size             INTEGER     NOT NULL DEFAULT 0,
  mime_type        TEXT        NOT NULL,
  storage_path     TEXT        NOT NULL,
  google_drive_id  TEXT,
  uploaded_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_documents"   ON documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_documents" ON documents FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_documents" ON documents FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_delete_documents" ON documents FOR DELETE TO authenticated USING (true);

-- Storage RLS
CREATE POLICY "auth_upload_documents"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents');

CREATE POLICY "auth_read_storage_documents"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documents');

CREATE POLICY "auth_delete_storage_documents"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'documents');
