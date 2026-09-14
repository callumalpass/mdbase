import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Collection } from "../src/operations/collection.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(keys = "[]", extra = "") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "optional-membership-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "_types"));
  await fs.writeFile(path.join(root, "mdbase.yaml"), `spec_version: "0.3.0"\nsettings:\n  explicit_type_keys: ${keys}\n  default_validation: error\n`);
  await fs.writeFile(path.join(root, "_types/task.md"), `---\nkind: mdbase.type\nname: task\nmatch:\n  where:\n    tags: {contains: task}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n${extra}---\n`);
  const opened = await Collection.open(root);
  if (!opened.collection) throw new Error(JSON.stringify(opened.error));
  return { root, collection: opened.collection };
}

it.each(["[]", "[kind]", "[mdbase_type]"])("reopens selected writes without claiming domain type metadata: %s", async (keys) => {
  const { root, collection } = await fixture(keys);
  const result = await collection.v03Operations().create({ path: "yes.md", type: "task", frontmatter: { title: "Read paper", type: "article-journal", tags: ["task"] } });
  expect(result.valid, JSON.stringify(result)).toBe(true);
  const reopened = await Collection.open(root);
  const read = await reopened.collection!.v03Operations().read({ path: "yes.md" });
  expect(read.valid).toBe(true);
  expect(read.result.types).toEqual(["task"]);
  expect((read.result.frontmatter as Record<string, unknown>).type).toBe("article-journal");
  if (keys === "[]") {
    expect((read.result.frontmatter as Record<string, unknown>)).not.toHaveProperty("mdbase_type");
    expect((read.result.frontmatter as Record<string, unknown>)).not.toHaveProperty("kind");
  }
});

it("does not write a record which fails selected membership", async () => {
  const { root, collection } = await fixture();
  const result = await collection.v03Operations().create({ path: "no.md", type: "task", frontmatter: { tags: ["other"] } });
  expect(result.valid).toBe(false);
  await expect(fs.access(path.join(root, "no.md"))).rejects.toThrow();
});

it("does not write when lifecycle erases inferred membership", async () => {
  const { root, collection } = await fixture("[]", "lifecycle:\n  on_create:\n    set:\n      tags: {literal: []}\n");
  const result = await collection.v03Operations().create({ path: "no.md", type: "task", frontmatter: { tags: ["task"] } });
  expect(result.valid).toBe(false);
  await expect(fs.access(path.join(root, "no.md"))).rejects.toThrow();
});

it("fails rather than silently excluding a throwing matching rule", async () => {
  const { root } = await fixture();
  await fs.writeFile(path.join(root, "_types/broken.md"), '---\nkind: mdbase.type\nname: broken\nmatch:\n  expr: {$expr: "1 / 0 > 0"}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n');
  const opened = await Collection.open(root);
  expect(opened.error).toBeUndefined();
  const result = await opened.collection!.v03Operations().create({ path: "no.md", type: "task", frontmatter: { tags: ["task"] } });
  expect(result.valid).toBe(false);
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "expression_evaluation_error")).toBe(true);
  await expect(fs.access(path.join(root, "no.md"))).rejects.toThrow();
});
