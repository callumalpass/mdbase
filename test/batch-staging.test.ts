import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitStagedChanges, stageCollection, stagedChanges } from "../src/operations/batch.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function collection(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-batch-staging-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.writeFile(path.join(root, "notes/a.md"), "---\ntitle: A\n---\n");
  await fs.writeFile(path.join(root, "notes/scan.pdf"), Buffer.alloc(2 * 1024 * 1024, 1));
  await fs.writeFile(path.join(root, "notes/small.json"), "{}");
  return root;
}

describe("batch staging", () => {
  it("copies records and small files and stands in placeholders for large attachments", async () => {
    const root = await collection();
    const staged = await stageCollection(root, { isRecordFile: (file) => file.endsWith(".md"), link: false });
    try {
      expect(staged.root.startsWith(root)).toBe(false);
      expect(await fs.readFile(path.join(staged.root, "notes/a.md"), "utf8")).toBe("---\ntitle: A\n---\n");
      expect(await fs.readFile(path.join(staged.root, "notes/small.json"), "utf8")).toBe("{}");
      expect((await fs.stat(path.join(staged.root, "notes/scan.pdf"))).size).toBe(0);

      // Only files the operations changed are committed; placeholders are not.
      await fs.writeFile(path.join(staged.root, "notes/a.md"), "---\ntitle: A2\n---\n");
      await fs.writeFile(path.join(staged.root, "notes/new.md"), "---\ntitle: New\n---\n");
      const changes = await stagedChanges(staged);
      expect(changes).toEqual({ writes: ["notes/a.md", "notes/new.md"], deletes: [] });
      expect(await commitStagedChanges(root, staged, changes)).toBeUndefined();
      expect(await fs.readFile(path.join(root, "notes/a.md"), "utf8")).toBe("---\ntitle: A2\n---\n");
      expect((await fs.stat(path.join(root, "notes/scan.pdf"))).size).toBe(2 * 1024 * 1024);
    } finally {
      await staged.cleanup();
    }
  });

  it("refuses to commit over a file that changed after staging", async () => {
    const root = await collection();
    const staged = await stageCollection(root, { isRecordFile: (file) => file.endsWith(".md") });
    try {
      await fs.rm(path.join(staged.root, "notes/a.md"));
      await fs.writeFile(path.join(staged.root, "notes/a.md"), "---\ntitle: Staged\n---\n");
      await fs.writeFile(path.join(root, "notes/a.md"), "---\ntitle: Changed elsewhere\n---\n");
      const conflict = await commitStagedChanges(root, staged, await stagedChanges(staged));
      expect(conflict?.code).toBe("concurrent_modification");
      expect(await fs.readFile(path.join(root, "notes/a.md"), "utf8")).toBe("---\ntitle: Changed elsewhere\n---\n");
    } finally {
      await staged.cleanup();
    }
  });
});
