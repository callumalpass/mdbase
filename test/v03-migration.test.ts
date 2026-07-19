import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeV02CollectionMigration,
  applyV02CollectionMigration,
  recoverV02CollectionMigration,
} from "../src/index.js";

const roots: string[] = [];

async function makeCollection(record = "---\ntype: note\ntitle: Hello\n---\n\nRecord body.\n"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdbase-v03-collection-migration-"));
  roots.push(root);
  await mkdir(path.join(root, "_types"), { recursive: true });
  await writeFile(path.join(root, "mdbase.yaml"), `spec_version: "0.2.1"
name: Migration fixture
custom_config_value: keep-me
settings:
  types_folder: _types
  validation: error
  custom_setting: 42
`);
  await writeFile(path.join(root, "_types", "note.md"), `---
name: note
description: Generated fixture type
match:
  fields_present: [title]
custom_type_value: keep-me
fields:
  title:
    type: string
    required: true
  slug:
    type: string
    unique: true
    plugin_hint: keep-me
---

# Original body

This body must be preserved byte for byte.\n`);
  await writeFile(path.join(root, "record.md"), record);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("v0.2 to v0.3 collection migration", () => {
  it("produces deterministic analysis with hashes, validation, and preserved source material", async () => {
    const root = await makeCollection();
    const first = await analyzeV02CollectionMigration(root);
    const second = await analyzeV02CollectionMigration(root);

    expect(first.valid).toBe(true);
    expect(first.report).toEqual(second.report);
    expect(first.report?.applicable).toBe(true);
    expect(first.report?.operations.map((operation) => operation.path)).toEqual([
      "_types/note.md",
      "mdbase.yaml",
    ]);
    expect(first.report?.operations.every((operation) => /^[a-f0-9]{64}$/.test(operation.source_sha256))).toBe(true);
    expect(first.report?.invalid_records).toEqual([]);
    expect(first.proposedFiles?.["_types/note.md"]).toContain("# Original body\n\nThis body must be preserved byte for byte.\n");
    expect(first.proposedFiles?.["_types/note.md"]).toContain("x-legacy-v0.2:");
    expect(first.proposedFiles?.["_types/note.md"]).toContain("custom_type_value: keep-me");
    expect(first.proposedFiles?.["_types/note.md"]).toContain("fields.slug.plugin_hint: keep-me");
    expect(first.proposedFiles?.["mdbase.yaml"]).toContain("custom_config_value: keep-me");
    expect(first.proposedFiles?.["mdbase.yaml"]).toContain("custom_setting: 42");
  });

  it("backs up and atomically applies an analyzed migration, then rejects re-application", async () => {
    const root = await makeCollection();
    const analysis = await analyzeV02CollectionMigration(root);
    const applied = await applyV02CollectionMigration(root, analysis.report!);

    expect(applied.valid).toBe(true);
    expect(applied.report?.post_apply_validation.status).toBe("passed");
    expect(await readFile(path.join(root, "mdbase.yaml"), "utf8")).toContain("spec_version: 0.3.0");
    expect(await readFile(path.join(root, "_types", "note.md"), "utf8")).toContain("kind: mdbase.type");
    expect(await readFile(path.join(root, analysis.report!.backup.location, "manifest.json"), "utf8")).toContain(analysis.report!.analysis_id);

    const repeated = await analyzeV02CollectionMigration(root);
    expect(repeated.valid).toBe(false);
    expect(repeated.error?.code).toBe("already_migrated");
  });

  it("can roll an applied migration back from its verified backup manifest", async () => {
    const root = await makeCollection();
    const originalConfig = await readFile(path.join(root, "mdbase.yaml"), "utf8");
    const originalType = await readFile(path.join(root, "_types", "note.md"), "utf8");
    const analysis = await analyzeV02CollectionMigration(root);
    const applied = await applyV02CollectionMigration(root, analysis.report!);

    const recovered = await recoverV02CollectionMigration(root, applied.report!.backup.location);

    expect(recovered.valid).toBe(true);
    expect(recovered.restored_paths?.sort()).toEqual(["_types/note.md", "mdbase.yaml"]);
    expect(await readFile(path.join(root, "mdbase.yaml"), "utf8")).toBe(originalConfig);
    expect(await readFile(path.join(root, "_types", "note.md"), "utf8")).toBe(originalType);
    expect((await analyzeV02CollectionMigration(root)).valid).toBe(true);
  });

  it("deletes the generated v0.2 meta type with backup and recovery", async () => {
    const root = await makeCollection();
    const meta = `---
name: meta
description: Schema for type definition files.
match:
  path_glob: "_types/**/*.md"
strict: false
fields:
  name:
    type: string
    required: true
  fields:
    type: any
---
`;
    await writeFile(path.join(root, "_types", "meta.md"), meta);

    const analysis = await analyzeV02CollectionMigration(root);
    expect(analysis.report?.applicable).toBe(true);
    expect(analysis.report?.operations).toContainEqual(expect.objectContaining({
      path: "_types/meta.md",
      operation: "delete",
    }));
    expect(analysis.report?.operations.find((operation) => operation.path === "_types/meta.md"))
      .not.toHaveProperty("target_sha256");
    expect(analysis.proposedFiles?.["_types/meta.md"]).toBeNull();
    expect(analysis.report?.generated_file_evidence).toContainEqual({
      path: "_types/meta.md",
      recognized: true,
      reasons: ["legacy_generated_meta_type"],
    });

    const applied = await applyV02CollectionMigration(root, analysis.report!);
    expect(applied.valid).toBe(true);
    await expect(readFile(path.join(root, "_types", "meta.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const recovered = await recoverV02CollectionMigration(root, applied.report!.backup.location);
    expect(recovered.valid).toBe(true);
    expect(await readFile(path.join(root, "_types", "meta.md"), "utf8")).toBe(meta);
  });

  it("refuses a tampered backup during recovery", async () => {
    const root = await makeCollection();
    const analysis = await analyzeV02CollectionMigration(root);
    const applied = await applyV02CollectionMigration(root, analysis.report!);
    const backupRoot = path.join(root, applied.report!.backup.location);
    await writeFile(path.join(backupRoot, "files", "mdbase.yaml"), "tampered\n");

    const recovered = await recoverV02CollectionMigration(root, applied.report!.backup.location);

    expect(recovered.valid).toBe(false);
    expect(recovered.error?.code).toBe("recovery_incomplete");
    expect(recovered.manual_recovery_paths).toContain("mdbase.yaml");
  });

  it("rejects a stale analysis report before writing", async () => {
    const root = await makeCollection();
    const analysis = await analyzeV02CollectionMigration(root);
    await writeFile(path.join(root, "mdbase.yaml"), `${await readFile(path.join(root, "mdbase.yaml"), "utf8")}\n# changed\n`);

    const applied = await applyV02CollectionMigration(root, analysis.report!);
    expect(applied.valid).toBe(false);
    expect(applied.error?.code).toBe("migration_inputs_changed");
    expect(await readFile(path.join(root, "mdbase.yaml"), "utf8")).toContain('spec_version: "0.2.1"');
  });

  it("requires explicit partial mode for invalid records", async () => {
    const root = await makeCollection("---\ntype: note\n---\n\nMissing title.\n");
    const analysis = await analyzeV02CollectionMigration(root);
    expect(analysis.report?.invalid_records.map((record) => record.path)).toContain("record.md");
    expect(analysis.report?.applicable).toBe(false);

    const blocked = await applyV02CollectionMigration(root, analysis.report!);
    expect(blocked.valid).toBe(false);
    expect(blocked.error?.code).toBe("partial_migration_required");

    const applied = await applyV02CollectionMigration(root, analysis.report!, { allowPartial: true });
    expect(applied.valid).toBe(true);
    expect(applied.report?.post_apply_validation.status).toBe("passed_with_invalid_records");
  });

  it("restores earlier writes when a later atomic replacement fails", async () => {
    const root = await makeCollection();
    const analysis = await analyzeV02CollectionMigration(root);
    const originalType = await readFile(path.join(root, "_types", "note.md"), "utf8");
    await mkdir(path.join(root, ".mdbase", "migrations"), { recursive: true });
    const originalMode = (await stat(root)).mode;

    await chmod(root, 0o555);
    try {
      const applied = await applyV02CollectionMigration(root, analysis.report!);
      expect(applied.valid).toBe(false);
      expect(applied.restored).toBe(true);
      expect(await readFile(path.join(root, "_types", "note.md"), "utf8")).toBe(originalType);
    } finally {
      await chmod(root, originalMode);
    }
  });
});
