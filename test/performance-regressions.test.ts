import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Collection } from "../src/operations/collection.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<Collection> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-cache-regression-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "_types"), { recursive: true });
  await fs.writeFile(path.join(root, "mdbase.yaml"), 'spec_version: "0.3.0"\n', "utf8");
  for (const type of ["task", "note"]) {
    await fs.writeFile(path.join(root, `_types/${type}.md`), `---
kind: mdbase.type
name: ${type}
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type: { const: ${type} }
      title: { type: string }
---
`, "utf8");
  }
  await fs.writeFile(path.join(root, "a.md"), "---\ntype: task\ntitle: A\n---\n", "utf8");
  await fs.writeFile(path.join(root, "b.md"), "---\ntype: task\ntitle: B\n---\n", "utf8");
  await fs.writeFile(path.join(root, "source.md"), "---\ntype: task\ntitle: Source\n---\n[[a]]\n", "utf8");
  const opened = await Collection.open(root);
  if (!opened.collection) throw new Error(opened.error?.message ?? "open failed");
  return opened.collection;
}

describe("in-memory cache mutation regressions", () => {
  it("updates effective, raw, and type-filtered query state without a rescan", async () => {
    const collection = await fixture();
    await collection.queryCanonical({ types: ["task"] });

    const updated = await collection.update({
      path: "a.md",
      fields: { type: "note", title: "Changed" },
    });
    expect(updated.error).toBeUndefined();

    const tasks = await collection.queryCanonical({ types: ["task"] });
    const notes = await collection.queryCanonical({ types: ["note"], frontmatter: "raw" });
    expect(tasks.results.map((row) => row.path)).not.toContain("a.md");
    expect(notes.results).toMatchObject([{
      path: "a.md",
      frontmatter: { type: "note", title: "Changed" },
    }]);
    await collection.close();
  });

  it("invalidates backlink indexes while retaining the updated file cache", async () => {
    const collection = await fixture();
    expect((await collection.computeBacklinksForFile("a.md")).map((entry) => entry.file.path)).toEqual([
      "source.md",
    ]);

    await collection.update({ path: "source.md", body: "[[b]]\n" });

    expect(await collection.computeBacklinksForFile("a.md")).toEqual([]);
    expect((await collection.computeBacklinksForFile("b.md")).map((entry) => entry.file.path)).toEqual([
      "source.md",
    ]);
    const deleted = await collection.delete("b.md", { check_backlinks: true });
    expect(deleted.broken_links).toEqual([{ path: "source.md" }]);
    await collection.close();
  });
});
