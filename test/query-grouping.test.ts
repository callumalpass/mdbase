import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { Collection } from "../src/operations/collection.js";

async function setupCollection(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-query-"));
  await fs.writeFile(path.join(root, "mdbase.yaml"), 'spec_version: "0.2.0"\n');
  await fs.writeFile(path.join(root, ".mdbase"), "disabled");
  await fs.writeFile(path.join(root, "a.md"), "---\nstatus: open\npriority: 2\n---\nA\n");
  await fs.writeFile(path.join(root, "b.md"), "---\nstatus: closed\npriority: 1\n---\nB\n");
  await fs.writeFile(path.join(root, "c.md"), "---\nstatus: open\npriority: 4\n---\nC\n");
  await fs.writeFile(path.join(root, "d.md"), "---\npriority: 10\n---\nD\n");
  return root;
}

describe("query grouping and summaries", () => {
  it("returns grouped results with per-group summaries", async () => {
    const root = await setupCollection();
    const opened = await Collection.open(root);
    expect(opened.error).toBeUndefined();
    const collection = opened.collection!;

    const result = await collection.query({
      group_by: { property: "status", direction: "asc" },
      property_summaries: { priority: "Average" },
    });

    expect(result.error).toBeUndefined();
    expect(result.groups?.length).toBe(3);
    expect(result.groups?.[0].key).toBe("closed");
    expect(result.groups?.[1].key).toBe("open");
    expect(result.groups?.[2].key).toBeNull();
    expect(result.groups?.[0].summaries?.priority).toBe(1);
    expect(result.groups?.[1].summaries?.priority).toBe(3);
    expect(result.groups?.[2].summaries?.priority).toBe(10);
    expect(result.meta?.total_count).toBe(4);

    await collection.close();
  });

  it("returns top-level summaries in non-grouped queries", async () => {
    const root = await setupCollection();
    const opened = await Collection.open(root);
    expect(opened.error).toBeUndefined();
    const collection = opened.collection!;

    const result = await collection.query({
      property_summaries: { priority: "Sum" },
      limit: 2,
    });

    expect(result.error).toBeUndefined();
    expect(result.summaries?.priority).toBe(17);
    expect(result.meta?.total_count).toBe(4);
    expect(result.results.length).toBe(2);

    await collection.close();
  });
});
