ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS content_fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
  ) STORED;

CREATE INDEX IF NOT EXISTS pages_fts_idx ON pages USING GIN(content_fts);

CREATE OR REPLACE FUNCTION search_pages(query_text TEXT)
RETURNS TABLE(id TEXT, title TEXT, category TEXT, headline TEXT) AS $$
  SELECT
    p.id,
    p.title,
    p.category,
    ts_headline(
      'english',
      p.content,
      websearch_to_tsquery('english', query_text),
      'StartSel=<<, StopSel=>>, MaxFragments=2, MaxWords=15, MinWords=5'
    ) AS headline
  FROM pages p
  WHERE p.content_fts @@ websearch_to_tsquery('english', query_text)
  ORDER BY ts_rank(p.content_fts, websearch_to_tsquery('english', query_text)) DESC
  LIMIT 20;
$$ LANGUAGE sql STABLE;
