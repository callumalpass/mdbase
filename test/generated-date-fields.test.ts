import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Collection } from "../src/operations/collection.js";
import { migrateV02TypeToV03 } from "../src/migrations/type-migration.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

async function setupCollection(): Promise<{ collection: Collection; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-gen-date-"));
  await write(
    root,
    "mdbase.yaml",
    [
      'spec_version: "0.2.0"',
      "settings:",
      "  default_validation: error",
      "",
    ].join("\n"),
  );
  await write(
    root,
    "_types/note.md",
    [
      "---",
      "name: note",
      "fields:",
      "  title:",
      "    type: string",
      "    required: true",
      "  created:",
      "    type: date",
      "    generated: now",
      "  updated:",
      "    type: date",
      "    generated: now_on_write",
      "  touched_at:",
      "    type: datetime",
      "    generated: now_on_write",
      "  touched_time:",
      "    type: time",
      "    generated: now_on_write",
      "---",
      "",
    ].join("\n"),
  );
  const result = await Collection.open(root);
  if (result.error || !result.collection) {
    throw new Error(result.error?.message ?? "Failed to open collection");
  }
  return { collection: result.collection, root };
}

describe("generated now/now_on_write on date-typed fields", () => {
  it("create stamps date-typed generated fields with a plain date and passes validation", async () => {
    const { collection } = await setupCollection();
    const result = await collection.create({
      path: "notes/a.md",
      frontmatter: { type: "note", title: "Hello" },
    });

    expect(result.error).toBeUndefined();
    expect(result.frontmatter?.created).toMatch(DATE_RE);
    expect(result.frontmatter?.updated).toMatch(DATE_RE);
    expect(result.frontmatter?.touched_at).toMatch(DATETIME_RE);
    expect(result.frontmatter?.touched_time).toMatch(TIME_RE);
  });

  it("update stamps date-typed now_on_write fields with a plain date and passes validation", async () => {
    const { collection, root } = await setupCollection();
    await write(
      root,
      "notes/b.md",
      [
        "---",
        "type: note",
        "title: Existing",
        "created: 2024-01-01",
        "updated: 2024-01-01",
        'touched_at: "2024-01-01T00:00:00Z"',
        'touched_time: "00:00:00"',
        "---",
        "body",
        "",
      ].join("\n"),
    );

    const result = await collection.update({
      path: "notes/b.md",
      fields: { title: "Renamed" },
    });

    expect(result.error).toBeUndefined();
    expect(result.frontmatter?.title).toBe("Renamed");
    expect(result.frontmatter?.updated).toMatch(DATE_RE);
    expect(result.frontmatter?.touched_at).toMatch(DATETIME_RE);
    expect(result.frontmatter?.touched_time).toMatch(TIME_RE);
  });

  it("migrates v0.2 now/now_on_write on date fields to the {today} provider", () => {
    const result = migrateV02TypeToV03({
      name: "note",
      fields: {
        title: { type: "string", required: true },
        created: { type: "date", generated: "now" },
        updated: { type: "date", generated: "now_on_write" },
        touched_at: { type: "datetime", generated: "now_on_write" },
      },
    });

    expect(result.valid).toBe(true);
    const lifecycle = (result.typeFile as Record<string, any>).lifecycle;
    expect(lifecycle.on_create.set.created).toEqual({ today: true });
    expect(lifecycle.on_update.set.updated).toEqual({ today: true });
    expect(lifecycle.on_update.set.touched_at).toEqual({ now: true });
  });
});
