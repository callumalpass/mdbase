import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS files (
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
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);`;

const dbPath = workerData?.dbPath;
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(SCHEMA_SQL);

const getStmt = db.prepare(
  "SELECT mtime_ms, size, frontmatter_json, body FROM files WHERE path = ?",
);
const upsertStmt = db.prepare(
  "INSERT INTO files (path, mtime_ms, size, frontmatter_json, body) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, " +
    "frontmatter_json = excluded.frontmatter_json, body = excluded.body",
);
const deleteStmt = db.prepare("DELETE FROM files WHERE path = ?");

parentPort.on("message", (msg) => {
  try {
    if (msg.op === "get") {
      const row = getStmt.get(msg.path);
      if (!row || row.mtime_ms !== msg.mtimeMs || row.size !== msg.size) {
        parentPort.postMessage({ id: msg.id, ok: true, result: null });
        return;
      }
      parentPort.postMessage({
        id: msg.id,
        ok: true,
        result: { frontmatterJson: row.frontmatter_json, body: row.body ?? "" },
      });
      return;
    }
    if (msg.op === "upsert") {
      upsertStmt.run(msg.path, msg.mtimeMs, msg.size, msg.frontmatterJson, msg.body ?? "");
      parentPort.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.op === "delete") {
      deleteStmt.run(msg.path);
      parentPort.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.op === "close") {
      db.close();
      parentPort.postMessage({ id: msg.id, ok: true });
      return;
    }
    parentPort.postMessage({ id: msg.id, ok: false, error: "unknown_op" });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: err?.message ?? "cache_error" });
  }
});
