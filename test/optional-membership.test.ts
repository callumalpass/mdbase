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

// Starter types (e.g. mdbase-contracts comment v2, view v2) keep a
// `match: { where: { type: <name> } }` rule for hand-written records but do not
// pin `type` in their schema. Selecting such a type on create is explicit
// membership whenever an explicit type key is configured, so the match rule is
// skipped (spec ch. 07 type selection); with no keys there is nowhere to record
// the selection and the persisted record must still match. Mirrors mdbase-rs
// `ResolvedWriteMembership::resolve_create`.
async function starterFixture(keys: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "explicit-match-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "_types"));
  await fs.writeFile(path.join(root, "mdbase.yaml"), `spec_version: "0.3.0"\nsettings:\n  explicit_type_keys: ${keys}\n`);
  await fs.writeFile(path.join(root, "_types/comment.md"), "---\nkind: mdbase.type\nname: comment\nmatch:\n  where:\n    type: comment\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [document]\n    properties:\n      document: {type: string}\n---\n");
  const opened = await Collection.open(root);
  if (!opened.collection) throw new Error(JSON.stringify(opened.error));
  return { root, collection: opened.collection };
}

it.each([
  ["[mdbase_type]", "mdbase_type"],
  ["[type, types]", "type"],
])("selected create under %s records explicit membership without satisfying match", async (keys, key) => {
  const { root, collection } = await starterFixture(keys);
  const created = await collection.v03Operations().create({ path: "c.md", type: "comment", frontmatter: { document: "[[a]]" } });
  expect(created.valid, JSON.stringify(created)).toBe(true);
  expect(created.result.types).toEqual(["comment"]);
  const reopened = await Collection.open(root);
  const read = await reopened.collection!.v03Operations().read({ path: "c.md" });
  expect(read.result.types).toEqual(["comment"]);
  const frontmatter = read.result.frontmatter as Record<string, unknown>;
  expect(frontmatter[key]).toBe("comment");
  if (key === "mdbase_type") expect(frontmatter).not.toHaveProperty("type");
});

it("selected create keeps domain `type` data under [mdbase_type]", async () => {
  const { root, collection } = await starterFixture("[mdbase_type]");
  const created = await collection.v03Operations().create({ path: "c.md", type: "comment", frontmatter: { document: "[[a]]", type: "article-journal" } });
  expect(created.valid, JSON.stringify(created)).toBe(true);
  const raw = await fs.readFile(path.join(root, "c.md"), "utf8");
  expect(raw).toContain("type: article-journal");
  expect(raw).toContain("mdbase_type: comment");
});

it("selected create under [] still requires the persisted record to match", async () => {
  const { root, collection } = await starterFixture("[]");
  const rejected = await collection.v03Operations().create({ path: "c.md", type: "comment", frontmatter: { document: "[[a]]" } });
  expect(rejected.valid).toBe(false);
  expect(rejected.diagnostics.map((diagnostic) => diagnostic.code)).toContain("type_membership_changed");
  await expect(fs.access(path.join(root, "c.md"))).rejects.toThrow();
  const matching = await collection.v03Operations().create({ path: "m.md", type: "comment", frontmatter: { document: "[[a]]", type: "comment" } });
  expect(matching.valid, JSON.stringify(matching)).toBe(true);
  expect(matching.result.types).toEqual(["comment"]);
});

it("hand-written records without an explicit key still match inferentially under [mdbase_type]", async () => {
  const { root } = await starterFixture("[mdbase_type]");
  await fs.writeFile(path.join(root, "hand.md"), "---\ntype: comment\ndocument: '[[a]]'\n---\n");
  await fs.writeFile(path.join(root, "other.md"), "---\ntype: article-journal\n---\n");
  const opened = await Collection.open(root);
  const ops = opened.collection!.v03Operations();
  expect((await ops.read({ path: "hand.md" })).result.types).toEqual(["comment"]);
  expect((await ops.read({ path: "other.md" })).result.types).toEqual([]);
});
