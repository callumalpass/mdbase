CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  content_hash TEXT,
  frontmatter_json TEXT NOT NULL,
  body TEXT,
  types_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS field_values (
  path TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_int INTEGER,
  PRIMARY KEY (path, field_name),
  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS links (
  source_path TEXT NOT NULL,
  target_path TEXT,
  target_raw TEXT NOT NULL,
  location TEXT NOT NULL,
  field_name TEXT,
  format TEXT NOT NULL,
  FOREIGN KEY (source_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  path TEXT NOT NULL,
  tag TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (path, tag, source),
  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fv_name ON field_values(field_name, value_text);
CREATE INDEX IF NOT EXISTS idx_fv_num ON field_values(field_name, value_number);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_path);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
