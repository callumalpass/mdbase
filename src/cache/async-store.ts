import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, Statement, SqlJsStatic } from "sql.js";

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

let _sqlJs: SqlJsStatic | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (_sqlJs) return _sqlJs;
  const _require = createRequire(import.meta.url);
  const sqlJsDistDir = path.dirname(_require.resolve("sql.js"));
  _sqlJs = await initSqlJs({
    locateFile: (file: string) => path.join(sqlJsDistDir, file),
  });
  return _sqlJs;
}

export interface CachedFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

export class CacheStoreAsync {
  private db: Database;
  private cacheDir: string;
  private dbPath: string;
  private getStmt: Statement;
  private upsertStmt: Statement;
  private deleteStmt: Statement;

  private constructor(
    db: Database,
    cacheDir: string,
    dbPath: string,
    getStmt: Statement,
    upsertStmt: Statement,
    deleteStmt: Statement,
  ) {
    this.db = db;
    this.cacheDir = cacheDir;
    this.dbPath = dbPath;
    this.getStmt = getStmt;
    this.upsertStmt = upsertStmt;
    this.deleteStmt = deleteStmt;
  }

  static async open(root: string, cacheFolder: string): Promise<CacheStoreAsync | null> {
    try {
      const cacheDir = path.join(root, cacheFolder);
      await fs.promises.mkdir(cacheDir, { recursive: true });

      const dbPath = path.join(cacheDir, "cache.sqlite");
      const SQL = await getSqlJs();
      let db: Database;

      const dbStat = await fs.promises.stat(dbPath).catch(() => null);
      if (dbStat?.isFile()) {
        const fileData = await fs.promises.readFile(dbPath);
        try {
          db = new SQL.Database(fileData);
        } catch {
          // Corrupted file — start fresh
          db = new SQL.Database();
        }
      } else {
        db = new SQL.Database();
      }

      db.run(SCHEMA_SQL);

      const getStmt = db.prepare(
        "SELECT mtime_ms, size, frontmatter_json, body FROM files WHERE path = ?",
      );
      const upsertStmt = db.prepare(
        "INSERT INTO files (path, mtime_ms, size, frontmatter_json, body) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, " +
          "frontmatter_json = excluded.frontmatter_json, body = excluded.body",
      );
      const deleteStmt = db.prepare("DELETE FROM files WHERE path = ?");

      return new CacheStoreAsync(db, cacheDir, dbPath, getStmt, upsertStmt, deleteStmt);
    } catch {
      return null;
    }
  }

  async getFile(relativePath: string, stat: fs.Stats): Promise<CachedFile | null> {
    this.getStmt.bind([relativePath]);
    if (!this.getStmt.step()) {
      this.getStmt.reset();
      return null;
    }
    const row = this.getStmt.getAsObject();
    this.getStmt.reset();

    if ((row["mtime_ms"] as number) !== Math.floor(stat.mtimeMs) || (row["size"] as number) !== stat.size) {
      return null;
    }

    try {
      const frontmatter = JSON.parse(row["frontmatter_json"] as string) as Record<string, unknown>;
      return { frontmatter, body: (row["body"] as string | null) ?? "" };
    } catch {
      return null;
    }
  }

  async upsertFile(
    relativePath: string,
    stat: fs.Stats,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    const fm = JSON.stringify(frontmatter ?? {});
    this.upsertStmt.run([relativePath, Math.floor(stat.mtimeMs), stat.size, fm, body ?? ""]);
  }

  async deleteFile(relativePath: string): Promise<void> {
    this.deleteStmt.run([relativePath]);
  }

  async flush(): Promise<void> {
    const data = this.db.export();
    await fs.promises.writeFile(this.dbPath, data);
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.getStmt.free();
      this.upsertStmt.free();
      this.deleteStmt.free();
      this.db.close();
    }
  }

  async clear(): Promise<void> {
    this.getStmt.free();
    this.upsertStmt.free();
    this.deleteStmt.free();
    this.db.close();
    await fs.promises.rm(this.cacheDir, { recursive: true, force: true });
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
