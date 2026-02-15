import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { Collection } from "../src/operations/collection.js";

async function setupCollection(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-security-"));
  await fs.writeFile(path.join(root, "mdbase.yaml"), 'spec_version: "0.2.0"\n');
  await fs.writeFile(path.join(root, ".mdbase"), "disabled");
  await fs.writeFile(path.join(root, "inside.md"), "---\na: 1\n---\ninside\n");
  return root;
}

describe("security regressions", () => {
  it("rejects traversal paths for read/update/delete/rename", async () => {
    const root = await setupCollection();
    const opened = await Collection.open(root);
    expect(opened.error).toBeUndefined();
    const collection = opened.collection!;

    const readRes = await collection.read("../outside.md");
    expect(readRes.error?.code).toBe("invalid_path");

    const updateRes = await collection.update({
      path: "../outside.md",
      fields: { a: 2 },
    });
    expect(updateRes.error?.code).toBe("invalid_path");

    const deleteRes = await collection.delete("../outside.md");
    expect(deleteRes.error?.code).toBe("invalid_path");

    const renameRes = await collection.rename({
      from: "inside.md",
      to: "../outside.md",
    });
    expect((renameRes.error as { code?: string } | undefined)?.code).toBe("invalid_path");

    await collection.close();
  });
});
