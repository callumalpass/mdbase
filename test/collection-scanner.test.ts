import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { CollectionScanner } from "../src/operations/collection-scanner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(includeSubfolders = true): Promise<{ root: string; scanner: CollectionScanner }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-scanner-"));
  roots.push(root);
  const files: Record<string, string> = {
    "root.md": "record",
    "asset.png": "asset",
    "ignored.md": "ignored by basename glob",
    "private/secret.md": "ignored directory",
    "notes/note.md": "nested record",
    "notes/data.json": "nested asset",
    "nested/mdbase.yaml": 'spec_version: "0.3.0"',
    "nested/hidden.md": "nested collection record",
    "_types/task.md": "type",
    ".cache/state.json": "cache",
    "migrations/001.md": "migration",
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, contents, "utf8");
  }
  return {
    root,
    scanner: new CollectionScanner({
      root,
      exclude: ["private", "ignored.*"],
      recordExtensions: ["md"],
      includeSubfolders,
      typesFolder: "_types",
      cacheFolder: ".cache",
      migrationsFolder: "migrations",
    }),
  };
}

describe("CollectionScanner", () => {
  it("applies exclusions and nested collection boundaries consistently", async () => {
    const { scanner } = await fixture();

    expect(await scanner.scanRecordFiles()).toEqual(["notes/note.md", "root.md"]);
    expect(await scanner.scanAllFiles()).toEqual([
      "asset.png",
      "notes/data.json",
      "notes/note.md",
      "root.md",
    ]);
    expect(scanner.nonRecordFiles(await scanner.scanAllFiles())).toEqual(new Set([
      "asset.png",
      "notes/data.json",
    ]));
  });

  it("does not recurse when subfolders are disabled", async () => {
    const { scanner } = await fixture(false);
    expect(await scanner.scanRecordFiles()).toEqual(["root.md"]);
    expect(await scanner.scanAllFiles()).toEqual(["asset.png", "root.md"]);
  });

  it("scans runtime type records independently of ordinary exclusions", async () => {
    const { scanner } = await fixture();
    expect(await scanner.scanTypeFiles("_types", "migrations")).toEqual(["_types/task.md"]);
  });
});
