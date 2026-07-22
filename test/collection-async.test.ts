import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { CollectionAsync } from "../src/operations/collection-async.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("CollectionAsync compatibility facade", () => {
  it("delegates typed operations and preserves the legacy fields alias", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-async-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "_types"));
    await fs.writeFile(path.join(root, "mdbase.yaml"), 'spec_version: "0.3.0"\n', "utf8");
    await fs.writeFile(path.join(root, "_types/task.md"), `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type: { const: task }
      title: { type: string }
---
`, "utf8");

    const opened = await CollectionAsync.open(root);
    expect(opened.error).toBeUndefined();
    const collection = opened.collection!;
    const created = await collection.create({
      path: "created.md",
      type: "task",
      fields: { title: "Created through compatibility facade" },
    });
    expect(created.error).toBeUndefined();

    const read = await collection.read("created.md");
    expect(read.frontmatter?.title).toBe("Created through compatibility facade");
    const updated = await collection.update({
      path: "created.md",
      fields: { title: "Updated" },
      if_revision: read.revision,
    });
    expect(updated.frontmatter?.title).toBe("Updated");
    await collection.close();
  });
});
