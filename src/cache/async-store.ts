import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

export interface CachedFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

type CacheRequest =
  | { id: number; op: "get"; path: string; mtimeMs: number; size: number }
  | { id: number; op: "upsert"; path: string; mtimeMs: number; size: number; frontmatterJson: string; body: string }
  | { id: number; op: "delete"; path: string }
  | { id: number; op: "close" };

type CacheRequestNoId<T> = T extends { id: number } ? Omit<T, "id"> : T;
type CacheRequestPayload = CacheRequestNoId<CacheRequest>;

type CacheResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

export class CacheStoreAsync {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private cacheDir: string;
  private dbPath: string;

  private constructor(worker: Worker, cacheDir: string, dbPath: string) {
    this.worker = worker;
    this.cacheDir = cacheDir;
    this.dbPath = dbPath;
    this.worker.on("message", (msg: CacheResponse) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error));
      }
    });
    this.worker.on("error", (err) => {
      for (const [, entry] of this.pending) {
        entry.reject(err);
      }
      this.pending.clear();
    });
  }

  static async open(root: string, cacheFolder: string): Promise<CacheStoreAsync | null> {
    try {
      const cacheDir = path.join(root, cacheFolder);
      const cacheStat = await fs.promises.stat(cacheDir).catch(() => null);
      if (cacheStat && !cacheStat.isDirectory()) return null;
      if (!cacheStat) {
        await fs.promises.mkdir(cacheDir, { recursive: true });
      }
      const dbPath = path.join(cacheDir, "cache.sqlite");
      const dbStat = await fs.promises.stat(dbPath).catch(() => null);
      if (dbStat && !dbStat.isFile()) return null;
      if (dbStat) {
        const fd = await fs.promises.open(dbPath, "r");
        try {
          const header = Buffer.alloc(16);
          const { bytesRead } = await fd.read(header, 0, 16, 0);
          if (bytesRead < 16 || header.toString("utf-8") !== "SQLite format 3\u0000") {
            return null;
          }
        } finally {
          await fd.close();
        }
      }
      const workerUrl = new URL("./worker.js", import.meta.url);
      const worker = new Worker(workerUrl, { workerData: { dbPath } });
      return new CacheStoreAsync(worker, cacheDir, dbPath);
    } catch {
      return null;
    }
  }

  private request<T>(payload: CacheRequestPayload): Promise<T> {
    const id = ++this.seq;
    const msg: CacheRequest = { id, ...payload } as CacheRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(msg);
    });
  }

  async getFile(relativePath: string, stat: fs.Stats): Promise<CachedFile | null> {
    const result = await this.request<{ frontmatterJson: string; body: string } | null>({
      op: "get",
      path: relativePath,
      mtimeMs: Math.floor(stat.mtimeMs),
      size: stat.size,
    });
    if (!result) return null;
    try {
      const frontmatter = JSON.parse(result.frontmatterJson) as Record<string, unknown>;
      return { frontmatter, body: result.body ?? "" };
    } catch {
      return null;
    }
  }

  async upsertFile(relativePath: string, stat: fs.Stats, frontmatter: Record<string, unknown>, body: string): Promise<void> {
    const fm = JSON.stringify(frontmatter ?? {});
    await this.request<void>({
      op: "upsert",
      path: relativePath,
      mtimeMs: Math.floor(stat.mtimeMs),
      size: stat.size,
      frontmatterJson: fm,
      body: body ?? "",
    });
  }

  async deleteFile(relativePath: string): Promise<void> {
    await this.request<void>({ op: "delete", path: relativePath });
  }

  async close(): Promise<void> {
    await this.request<void>({ op: "close" });
    await this.worker.terminate();
  }

  async clear(): Promise<void> {
    await this.close();
    await fs.promises.rm(this.cacheDir, { recursive: true, force: true });
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
