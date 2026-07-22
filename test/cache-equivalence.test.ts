import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { CanonicalQueryRow } from "../src/operations/canonical-query.js";
import { Collection } from "../src/operations/collection.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function open(root: string): Promise<Collection> {
  const result = await Collection.open(root);
  if (!result.collection) throw new Error(result.error?.message ?? "open failed");
  return result.collection;
}

function comparableRow(row: CanonicalQueryRow): Record<string, unknown> {
  return {
    path: row.path,
    frontmatter: row.frontmatter,
    raw_frontmatter: row.raw_frontmatter,
    body: row.body,
  };
}

async function expectEquivalent(warm: Collection, root: string): Promise<void> {
  const cold = await open(root);
  try {
    const query = {
      include_body: true,
      frontmatter: "both" as const,
      order_by: [{ field: "file.path", direction: "asc" as const }],
    };
    const [warmResult, coldResult] = await Promise.all([
      warm.queryCanonical(query),
      cold.queryCanonical(query),
    ]);
    expect(warmResult.error).toBeUndefined();
    expect(coldResult.error).toBeUndefined();
    expect(warmResult.results.map(comparableRow)).toEqual(coldResult.results.map(comparableRow));

    const paths = warmResult.results.map((row) => row.path).filter((value): value is string => Boolean(value));
    for (const targetPath of paths) {
      const [warmBacklinks, coldBacklinks] = await Promise.all([
        warm.computeBacklinksForFile(targetPath),
        cold.computeBacklinksForFile(targetPath),
      ]);
      const sourcePaths = (entries: typeof warmBacklinks) =>
        entries.map((entry) => entry.file.path).sort();
      expect(sourcePaths(warmBacklinks), `backlinks for ${targetPath}`).toEqual(sourcePaths(coldBacklinks));
    }
  } finally {
    await cold.close();
  }
}

describe("warm cache equivalence", () => {
  it("matches a fresh collection after an adversarial mixed mutation sequence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-cache-equivalence-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "_types"), { recursive: true });
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
      sequence: { type: integer }
---
`, "utf8");

    const active = new Set<string>();
    for (let index = 0; index < 8; index++) {
      const filePath = `records/item-${index}.md`;
      const previous = index === 0 ? "item-7" : `item-${index - 1}`;
      await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
      await fs.writeFile(path.join(root, filePath), `---
type: task
title: Item ${index}
sequence: ${index}
---
Links to [[${previous}]].
`, "utf8");
      active.add(filePath);
    }

    const warm = await open(root);
    try {
      // Populate every derived runtime cache before the first mutation.
      await warm.queryCanonical({ include_body: true, frontmatter: "both" });
      await warm.computeBacklinksForFile("records/item-0.md");

      let created = 0;
      let renamed = 0;
      for (let step = 0; step < 32; step++) {
        const paths = [...active].sort();
        const selected = paths[(step * 7) % paths.length];

        switch (step % 4) {
          case 0: {
            const target = paths[(step * 3 + 1) % paths.length];
            const targetName = path.basename(target, ".md");
            const result = await warm.update({
              path: selected,
              fields: { title: `Updated ${step}`, sequence: step },
              body: `Step ${step} links to [[${targetName}]].\n`,
            });
            expect(result.error, `update ${selected}`).toBeUndefined();
            break;
          }
          case 1: {
            const filePath = `created/new-${created++}.md`;
            const targetName = path.basename(selected, ".md");
            const result = await warm.create({
              path: filePath,
              type: "task",
              frontmatter: { title: `Created ${step}`, sequence: step },
              body: `Created link to [[${targetName}]].\n`,
            });
            expect(result.error, `create ${filePath}`).toBeUndefined();
            active.add(filePath);
            break;
          }
          case 2: {
            const destination = `archive/moved-${renamed++}.md`;
            const result = await warm.rename({ from: selected, to: destination, update_refs: true });
            expect(result.error, `rename ${selected}`).toBeUndefined();
            active.delete(selected);
            active.add(destination);
            break;
          }
          case 3: {
            if (active.size <= 4) break;
            const result = await warm.delete(selected, { check_backlinks: true });
            expect(result.error, `delete ${selected}`).toBeUndefined();
            active.delete(selected);
            break;
          }
        }

        if (step % 4 === 3) {
          await expectEquivalent(warm, root);
        }
      }
      await expectEquivalent(warm, root);
    } finally {
      await warm.close();
    }
  });
});
