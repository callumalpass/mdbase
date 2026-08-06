import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateCanonicalSchema } from "../src/validation/canonical.js";
import { Collection } from "../src/operations/collection.js";
import { loadConfigAsync } from "../src/config/loader.js";
import { loadTypesAsync } from "../src/types/loader.js";
import { evaluateMdbaseCel } from "../src/expressions/cel.js";
import { migrateV02TypeFileToV03, migrateV02TypeToV03 } from "../src/migrations/type-migration.js";

async function tempCollection(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-v0.3-"));
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

async function open(root: string): Promise<Collection> {
  const result = await Collection.open(root);
  if (result.error || !result.collection) {
    throw new Error(result.error?.message ?? "Failed to open collection");
  }
  return result.collection;
}

describe("v0.3 core", () => {
  it("initializes a minimal v0.3 collection by default", async () => {
    const root = await tempCollection();
    const result = await Collection.init(root, {
      config: {
        name: "Example",
        description: "A new collection",
        settings: {
          types_folder: "schemas/types",
          record_extensions: ["md", "mdx"],
        },
        "x-example": { owner: "tests" },
      },
    });

    expect(result).toEqual({
      config_path: "mdbase.yaml",
      types_folder: "schemas/types",
      contracts_folder: "_contracts",
    });
    expect(fsSync.existsSync(path.join(root, "schemas/types"))).toBe(true);
    expect(fsSync.existsSync(path.join(root, "_contracts"))).toBe(true);
    expect(fsSync.existsSync(path.join(root, "schemas/types/meta.md"))).toBe(false);
    const loaded = await loadConfigAsync(root);
    expect(loaded.config).toMatchObject({
      spec_version: "0.3.0",
      spec_profile: "v0.3",
      name: "Example",
      description: "A new collection",
      settings: {
        types_folder: "schemas/types",
        record_extensions: ["md", "mdx"],
      },
    });
  });

  it("retains explicit v0.2 initialization behavior", async () => {
    const root = await tempCollection();
    const result = await Collection.init(root, {
      config: { spec_version: "0.2.1" },
    });

    expect(result).toEqual({
      config_path: "mdbase.yaml",
      types_folder: "_types",
      meta_type_path: "_types/meta.md",
    });
    expect(await fs.readFile(path.join(root, "_types/meta.md"), "utf8")).toContain("name: meta");
    expect((await loadConfigAsync(root)).config?.spec_profile).toBe("v0.2");
  });

  it("opens the alpha protocol marker through the v0.3 compatibility path", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.3.0-alpha.1"\n');

    const loaded = await loadConfigAsync(root);
    expect(loaded.valid).toBe(true);
    expect(loaded.config?.spec_profile).toBe("v0.3");
    expect(loaded.config?.spec_version).toBe("0.3.0-alpha.1");
    expect(loaded.warnings).toContain(
      'spec_version "0.3.0-alpha.1" is a compatible v0.3 prerelease; new collections use "0.3.0"',
    );

    const opened = await Collection.open(root);
    expect(opened.error).toBeUndefined();
    await opened.collection?.close();
  });

  it("rejects unsafe init paths and unsupported versions before writing", async () => {
    const traversalRoot = await tempCollection();
    await expect(Collection.init(traversalRoot, {
      config: { settings: { types_folder: "../types" } },
    })).rejects.toThrow("without traversal segments");
    expect(fsSync.existsSync(path.join(traversalRoot, "mdbase.yaml"))).toBe(false);

    const unsupportedRoot = await tempCollection();
    await expect(Collection.init(unsupportedRoot, {
      config: { spec_version: "0.4.0" },
    })).rejects.toThrow("Unsupported spec version");
    expect(fsSync.existsSync(path.join(unsupportedRoot, "mdbase.yaml"))).toBe(false);
  });

  it("does not overwrite an existing collection config", async () => {
    const root = await tempCollection();
    const original = 'spec_version: "0.2.1"\nname: Existing\n';
    await write(root, "mdbase.yaml", original);

    await expect(Collection.init(root)).rejects.toThrow("already exists");
    expect(await fs.readFile(path.join(root, "mdbase.yaml"), "utf8")).toBe(original);
  });

  it("exposes canonical v0.3 operation envelopes with persisted mutation state", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/note.md", `---
kind: mdbase.type
name: note
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    required: [title, created_at]
    properties:
      type: { const: note }
      title: { type: string, minLength: 1 }
      status: { enum: [open, done] }
      created_at: { type: string, format: date-time }
collection:
  read_defaults:
    status: open
lifecycle:
  on_create:
    set:
      created_at: { now: true }
---
`);
    const collection = await open(root);
    try {
      const operations = collection.v03Operations();
      const created = await operations.create({
        type: "note",
        path: "notes/one.md",
        frontmatter: { title: "One" },
        body: "Body",
      });
      expect(created.valid).toBe(true);
      expect(created.result).toMatchObject({
        path: "notes/one.md",
        frontmatter: { type: "note", title: "One" },
        types: ["note"],
      });
      expect((created.result.frontmatter as Record<string, unknown>).status).toBeUndefined();
      expect(created.result.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(validateCanonicalSchema("operationResult", created)).toEqual({ valid: true, errors: [] });

      const read = await operations.read({ path: "notes/one.md" });
      expect(read.valid).toBe(true);
      expect(read.result).toMatchObject({
        path: "notes/one.md",
        frontmatter: { type: "note", title: "One" },
        effective_frontmatter: { type: "note", title: "One", status: "open" },
      });
      expect(validateCanonicalSchema("operationResult", read).valid).toBe(true);

      const updated = await operations.update({
        path: "notes/one.md",
        fields: { status: "done" },
        if_revision: String(created.result.revision),
      });
      expect(updated.valid).toBe(true);
      expect(updated.result.frontmatter).toMatchObject({ status: "done" });
      expect(updated.result.revision).not.toBe(created.result.revision);

      const renamed = await operations.rename({
        from: "notes/one.md",
        to: "archive/one.md",
        if_revision: String(updated.result.revision),
      });
      expect(renamed.valid).toBe(true);
      expect(renamed.result).toMatchObject({ path: "archive/one.md", frontmatter: { status: "done" } });
      expect(renamed.result.revision).toMatch(/^sha256:[a-f0-9]{64}$/);

      const traversal = await operations.read({ path: "../outside.md" });
      expect(traversal.valid).toBe(false);
      expect(traversal.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: "error",
          code: "path_traversal",
          details: { input_path: "../outside.md" },
        }),
      );
      expect(traversal.diagnostics[0].path).toBeUndefined();
      expect(validateCanonicalSchema("operationResult", traversal).valid).toBe(true);

      const deleted = await operations.delete({ path: "archive/one.md" });
      expect(deleted.valid).toBe(true);
      expect(validateCanonicalSchema("operationResult", deleted).valid).toBe(true);
    } finally {
      await collection.close();
    }
  });

  it("rejects the v0.3 operation facade for v0.2 collections", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.2.1"\n');
    const collection = await open(root);
    try {
      expect(() => collection.v03Operations()).toThrow("requires a v0.3 collection");
    } finally {
      await collection.close();
    }
  });

  it("loads the canonical TaskNotes v0.3 migration example when available", async () => {
    const exampleRoot = "/home/calluma/projects/mdbase-spec/examples/v0.3/tasknotes-migration/v0.3";
    if (!fsSync.existsSync(path.join(exampleRoot, "mdbase.yaml"))) {
      return;
    }

    const config = await loadConfigAsync(exampleRoot);
    expect(config.valid).toBe(true);
    const types = await loadTypesAsync(exampleRoot, config.config!);
    expect(types.valid).toBe(true);
    expect(types.types?.get("task")?.kind).toBe("mdbase.type");
    expect(types.types?.get("meta")?.schema?.value).toEqual(expect.any(Object));
  });

  it("loads v0.3 draft config and type files", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  record_extensions: [md, markdown]
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
---
`);

    const config = await loadConfigAsync(root);
    expect(config.valid).toBe(true);
    expect(config.config?.spec_profile).toBe("v0.3");
    expect(config.config?.settings.record_extensions).toEqual(["md", "markdown"]);
    expect(config.config?.settings.default_validation).toBe("error");

    const types = await loadTypesAsync(root, config.config!);
    expect(types.valid).toBe(true);
    expect(types.types?.get("task")?.kind).toBe("mdbase.type");
    expect(types.types?.get("task")?.schema?.dialect).toBe("json-schema-2020-12");
  });

  it("applies read defaults without satisfying JSON Schema required fields", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
match:
  fields_present: [title]
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title, status]
    additionalProperties: true
    properties:
      title: { type: string }
      status: { enum: [open, done] }
collection:
  read_defaults:
    status: open
---
`);
    await write(root, "tasks/a.md", `---
title: A
---
`);

    const collection = await open(root);
    const read = await collection.read("tasks/a.md");
    expect(read.types).toEqual(["task"]);
    expect(read.frontmatter?.status).toBe("open");
    expect(read.rawFrontmatter?.status).toBeUndefined();

    const validation = await collection.validate("tasks/a.md");
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === "schema_required" && issue.field === "status")).toBe(true);
  });

  it("does not let v0.3 read defaults or JSON Schema defaults satisfy required fields on create", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title, status, priority]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
      status:
        enum: [open, done]
        default: open
      priority:
        type: string
        default: normal
collection:
  read_defaults:
    status: open
    priority: normal
---
`);

    const collection = await open(root);
    const created = await collection.create({
      type: "task",
      path: "tasks/a.md",
      frontmatter: { title: "A" },
    });

    expect(created.valid).toBe(false);
    expect(created.error?.code).toBe("validation_failed");
    expect((created as { issues?: Array<{ code: string; field?: string }> }).issues?.some((issue) => issue.code === "schema_required" && issue.field === "status")).toBe(true);
    expect((created as { issues?: Array<{ code: string; field?: string }> }).issues?.some((issue) => issue.code === "schema_required" && issue.field === "priority")).toBe(true);
  });

  it("evaluates v0.3 CEL match expressions", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/open_task.md", `---
kind: mdbase.type
name: open_task
version: 1
match:
  expr:
    $expr: 'status == "open" && present.raw.status'
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
      status: { type: string }
---
`);
    await write(root, "tasks/open.md", `---
title: Open
status: open
---
`);
    await write(root, "tasks/done.md", `---
title: Done
status: done
---
`);

    const collection = await open(root);
    expect((await collection.read("tasks/open.md")).types).toEqual(["open_task"]);
    expect((await collection.read("tasks/done.md")).types).toEqual([]);
  });

  it("uses CEL for v0.3 query string filters", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
match:
  path_glob: "tasks/**/*.md"
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
      status: { type: string }
collection:
  read_defaults:
    status: open
---
`);
    await write(root, "tasks/open.md", `---
title: Open
---
Body mentions runtime.
`);
    await write(root, "tasks/done.md", `---
title: Done
status: done
---
`);

    const collection = await open(root);
    const byDefault = await collection.query({
      where: 'status == "open"',
      order_by: [{ field: "file.path" }],
    });
    expect(byDefault.results?.map((result) => result.path)).toEqual(["tasks/open.md"]);

    const byBody = await collection.query({
      where: 'file.body.contains("runtime") && file.inFolder("tasks")',
      include_body: false,
    });
    expect(byBody.results?.map((result) => result.path)).toEqual(["tasks/open.md"]);
    expect(byBody.results?.[0]).not.toHaveProperty("body");
  });

  it("evaluates v0.3 lifecycle CEL guards", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title, status, dateModified]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
      status: { type: string }
      dateModified: { type: string, format: date-time }
lifecycle:
  on_create:
    set:
      dateModified: { now: true }
  on_update:
    - if: 'old.status != status'
      set:
        dateModified: { now: true }
---
`);

    const collection = await open(root);
    const created = await collection.create({
      type: "task",
      path: "tasks/a.md",
      frontmatter: { title: "A", status: "open" },
    });
    expect(created.valid).toBe(true);
    const firstModified = String(created.frontmatter?.dateModified);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const titleOnly = await collection.update({
      path: "tasks/a.md",
      fields: { title: "A title edit" },
    });
    expect(titleOnly.frontmatter?.dateModified).toBe(firstModified);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const statusChange = await collection.update({
      path: "tasks/a.md",
      fields: { status: "done" },
    });
    expect(String(statusChange.frontmatter?.dateModified)).not.toBe(firstModified);
  });

  it("exposes v0.3 CEL presence maps for raw and effective records", () => {
    const result = evaluateMdbaseCel("present.raw.status == false && present.record.status", {
      raw: { title: "A" },
      record: { title: "A", status: "open" },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.value).toBe(true);
  });

  it("runs v0.3 lifecycle on create and update before JSON Schema validation", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title, id, dateCreated, dateModified]
    additionalProperties: false
    properties:
      type: { const: task }
      title: { type: string, minLength: 1 }
      id: { type: string, minLength: 1 }
      dateCreated: { type: string, format: date-time }
      dateModified: { type: string, format: date-time }
collection:
  path:
    pattern: "tasks/{id}.md"
lifecycle:
  on_create:
    set:
      id: { ulid: true }
      dateCreated: { now: true }
      dateModified: { now: true }
  on_update:
    set:
      dateModified: { now: true }
---
`);

    const collection = await open(root);
    const created = await collection.create({
      type: "task",
      frontmatter: { title: "Ship v0.3" },
    });

    expect(created.error).toBeUndefined();
    expect(created.valid).toBe(true);
    expect(created.path).toMatch(/^tasks\/[0-9A-HJKMNP-TV-Z]{26}\.md$/);
    expect(created.frontmatter?.id).toEqual(expect.any(String));
    expect(created.frontmatter?.dateCreated).toEqual(expect.any(String));
    expect(created.frontmatter?.dateModified).toEqual(expect.any(String));

    const firstModified = String(created.frontmatter?.dateModified);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await collection.update({
      path: created.path!,
      fields: { title: "Ship v0.3 core" },
    });

    expect(updated.error).toBeUndefined();
    expect(updated.valid).toBe(true);
    expect(updated.frontmatter?.dateCreated).toBe(created.frontmatter?.dateCreated);
    expect(String(updated.frontmatter?.dateModified)).not.toBe(firstModified);
  });

  it("enforces v0.3 collection.unique rules before create writes", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title, slug]
    additionalProperties: false
    properties:
      type: { const: task }
      title: { type: string }
      slug: { type: string }
collection:
  unique:
    - field: slug
      scope: type
---
`);

    const collection = await open(root);
    const first = await collection.create({
      type: "task",
      path: "tasks/a.md",
      frontmatter: { title: "A", slug: "same" },
    });
    expect(first.valid).toBe(true);

    const second = await collection.create({
      type: "task",
      path: "tasks/b.md",
      frontmatter: { title: "B", slug: "same" },
    });
    expect(second.valid).toBe(false);
    expect(second.error?.code).toBe("validation_failed");
  });

  it("validates v0.3 collection.links against raw persisted link fields", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/project.md", `---
kind: mdbase.type
name: project
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: project }
      title: { type: string }
---
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
      project: { type: string }
collection:
  read_defaults:
    project: "[[projects/default.md]]"
  links:
    project:
      target_type: project
      validate_exists: true
---
`);
    await write(root, "projects/default.md", `---
type: project
title: Default project
---
`);
    await write(root, "tasks/with-default.md", `---
type: task
title: Uses read default
---
`);
    await write(root, "tasks/missing.md", `---
type: task
title: Missing link
project: "[[projects/missing.md]]"
---
`);
    await write(root, "tasks/wrong-type.md", `---
type: task
title: Wrong type
project: "[[tasks/with-default.md]]"
---
`);

    const collection = await open(root);
    const defaulted = await collection.validate("tasks/with-default.md");
    expect(defaulted.valid).toBe(true);

    const missing = await collection.validate("tasks/missing.md");
    expect(missing.valid).toBe(false);
    expect(missing.issues.some((issue) => issue.code === "link_not_found" && issue.field === "project")).toBe(true);

    const wrongType = await collection.validate("tasks/wrong-type.md");
    expect(wrongType.valid).toBe(false);
    expect(wrongType.issues.some((issue) => issue.code === "link_wrong_type" && issue.field === "project")).toBe(true);
  });

  it("enforces v0.3 collection.links during create and update", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/project.md", `---
kind: mdbase.type
name: project
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: project }
      title: { type: string }
---
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
      project: { type: string }
collection:
  links:
    project:
      target_type: project
      validate_exists: true
---
`);
    await write(root, "projects/alpha.md", `---
type: project
title: Alpha
---
`);

    const collection = await open(root);
    const missing = await collection.create({
      type: "task",
      path: "tasks/missing.md",
      frontmatter: {
        title: "Missing",
        project: "[[projects/missing.md]]",
      },
    });
    expect(missing.valid).toBe(false);
    expect((missing as { issues?: Array<{ code: string; field?: string }> }).issues?.some((issue) => issue.code === "link_not_found" && issue.field === "project")).toBe(true);

    const created = await collection.create({
      type: "task",
      path: "tasks/ok.md",
      frontmatter: {
        title: "OK",
        project: "[[projects/alpha.md]]",
      },
    });
    expect(created.valid).toBe(true);

    const wrongType = await collection.update({
      path: "tasks/ok.md",
      fields: { project: "[[tasks/ok.md]]" },
    });
    expect(wrongType.valid).not.toBe(true);
    expect((wrongType as { issues?: Array<{ code: string; field?: string }> }).issues?.some((issue) => issue.code === "link_wrong_type" && issue.field === "project")).toBe(true);
  });

  it("prevalidates v0.3 collection.links during batch update dry runs", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/project.md", `---
kind: mdbase.type
name: project
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: project }
      title: { type: string }
---
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
      project: { type: string }
collection:
  links:
    project:
      target_type: project
      validate_exists: true
---
`);
    await write(root, "projects/alpha.md", `---
type: project
title: Alpha
---
`);
    await write(root, "tasks/ok.md", `---
type: task
title: OK
project: "[[projects/alpha.md]]"
---
`);

    const collection = await open(root);
    const result = await collection.batchUpdate({
      dry_run: true,
      updates: [
        {
          path: "tasks/ok.md",
          fields: { project: "[[projects/missing.md]]" },
        },
      ],
    });

    expect(result.error?.code).toBe("validation_failed");
    expect(result.error?.message).toContain("Collection policy validation failed");
    expect(result.batch_result.failed).toBe(1);
  });

  it("uses CEL for v0.3 batch update where filters", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
match:
  path_glob: "tasks/**/*.md"
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    additionalProperties: true
    properties:
      title: { type: string }
      status: { type: string }
      reviewed: { type: boolean }
collection:
  read_defaults:
    status: open
---
`);
    await write(root, "tasks/open.md", `---
title: Open
---
`);
    await write(root, "tasks/done.md", `---
title: Done
status: done
---
`);

    const collection = await open(root);
    const result = await collection.batchUpdate({
      where: 'status == "open"',
      fields: { reviewed: true },
      dry_run: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.batch_result.succeeded).toBe(1);
    expect(result.batch_result.details.map((detail) => detail.path)).toEqual(["tasks/open.md"]);
  });

  it("does not treat v0.3 read defaults as persisted unique values during create", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
      bucket: { type: string }
collection:
  read_defaults:
    bucket: inbox
  unique:
    - field: bucket
      scope: type
---
`);

    const collection = await open(root);
    const first = await collection.create({
      type: "task",
      path: "tasks/a.md",
      frontmatter: { title: "A" },
    });
    expect(first.valid).toBe(true);

    const second = await collection.create({
      type: "task",
      path: "tasks/b.md",
      frontmatter: { title: "B" },
    });
    expect(second.valid).toBe(true);
    expect((await collection.read("tasks/a.md")).frontmatter?.bucket).toBe("inbox");
    expect((await collection.read("tasks/b.md")).frontmatter?.bucket).toBe("inbox");
  });

  it("resolves external v0.3 schema refs relative to the type file", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/schemas/task.schema.json", `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "task": {
      "type": "object",
      "required": ["type", "title"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "task" },
        "title": { "type": "string", "minLength": 1 }
      }
    }
  }
}
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  ref: ./schemas/task.schema.json#/$defs/task
---
`);
    await write(root, "tasks/a.md", `---
type: task
title: ""
---
`);

    const collection = await open(root);
    const validation = await collection.validate("tasks/a.md");
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === "schema_min_length" && issue.field === "title")).toBe(true);
  });

  it("resolves v0.3 schema refs from an ancestor package schemas/v0.3 root", async () => {
    const packageRoot = await tempCollection();
    const root = path.join(packageRoot, "examples", "v0.3", "demo");
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(packageRoot, "schemas/v0.3/task.schema.json", `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["type", "title"],
  "additionalProperties": false,
  "properties": {
    "type": { "const": "task" },
    "title": { "type": "string", "minLength": 2 }
  }
}
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  ref: ../../../../schemas/v0.3/task.schema.json
---
`);
    await write(root, "tasks/a.md", `---
type: task
title: A
---
`);

    const collection = await open(root);
    const validation = await collection.validate("tasks/a.md");
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === "schema_min_length" && issue.field === "title")).toBe(true);
  });

  it("rejects external v0.3 schema refs that escape the collection root", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  ref: ../../outside.schema.json
---
`);

    const opened = await Collection.open(root);
    expect(opened.collection).toBeUndefined();
    expect(opened.error?.code).toBe("schema_ref_forbidden");
  });

  it("rejects v0.3 schema refs that escape through symlinks", async () => {
    const root = await tempCollection();
    const outside = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"\n`);
    await write(outside, "outside.schema.json", `{ "type": "object" }\n`);
    await fs.symlink(path.join(outside, "outside.schema.json"), path.join(root, "linked.schema.json"));
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  ref: ../linked.schema.json
---
`);

    const opened = await Collection.open(root);
    expect(opened.collection).toBeUndefined();
    expect(opened.error?.code).toBe("schema_ref_forbidden");
  });

  it("rejects remote refs embedded in v0.3 JSON Schemas without resolving them", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"\n`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    $ref: https://example.invalid/schema.json
---
`);

    const opened = await Collection.open(root);
    expect(opened.collection).toBeUndefined();
    expect(opened.error?.code).toBe("schema_ref_forbidden");
  });

  it("reports unsupported nested file refs as an optional feature", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"\n`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    $ref: ./nested.schema.json
---
`);

    const opened = await Collection.open(root);
    expect(opened.collection).toBeUndefined();
    expect(opened.error?.code).toBe("unsupported_profile");
  });

  it("loads and filters v0.3 type migration metadata", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 2
schema:
  dialect: json-schema-2020-12
  value:
    type: object
migrations:
  - from: 0
    to: 1
    description: Convert v0 fields to JSON Schema shape
    steps:
      - move_default:
          from: fields.status.default
          to: collection.read_defaults.status
  - from: 1
    to: 2
    action: tasknotes.type.upgrade
---
`);

    const collection = await open(root);
    const all = collection.listTypeMigrations({ type: "TASK" });
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      type: "task",
      source_path: "_types/task.md",
      migration: { from: 0, to: 1 },
    });
    expect(collection.listTypeMigrations({ type: "task", from: 1 })).toEqual([
      {
        type: "task",
        source_path: "_types/task.md",
        migration: { from: 1, to: 2, action: "tasknotes.type.upgrade" },
      },
    ]);
  });

  it("migrates the TaskNotes v0.2 fixture into a loadable v0.3 type file", async () => {
    const source = "/home/calluma/projects/mdbase-spec/examples/v0.3/tasknotes-migration/current-v0.2/_types/task.md";
    if (!fsSync.existsSync(source)) {
      return;
    }

    const result = await migrateV02TypeFileToV03(source, {
      sourcePath: "current-v0.2/_types/task.md",
      targetPath: "v0.3/_types/task.md",
    });
    expect(result.valid).toBe(true);
    expect(result.report?.detected_generator).toBe("tasknotes");
    expect(result.report?.summary.defaults_moved_to_read_defaults).toEqual(
      expect.arrayContaining(["status", "priority", "recurrenceAnchor"]),
    );
    expect(result.report?.summary.generated_fields_moved_to_lifecycle).toEqual(
      expect.arrayContaining(["dateCreated", "dateModified"]),
    );
    expect(result.report?.summary.link_fields_moved_to_collection_links).toEqual(
      expect.arrayContaining(["projects[]", "recurrenceParent", "occurrenceTemplate", "blockedBy[].uid"]),
    );

    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", result.renderedTypeFile!);

    const config = await loadConfigAsync(root);
    expect(config.valid).toBe(true);
    const types = await loadTypesAsync(root, config.config!);
    expect(types.valid).toBe(true);
    expect(types.types?.get("task")?.collection?.links?.["blockedBy[].uid"]?.target_type).toBe("task");
    expect(types.types?.get("task")?.implements?.[0]).toMatchObject({
      contract: "tasknotes.task",
      version: "0.2.0",
      fields: { title: "title", status: "status" },
    });
  });

  it("does not classify Pickle response types mentioning TaskNotes as TaskNotes exports", () => {
    const result = migrateV02TypeToV03({
      name: "tasknotes_closeout_response",
      description: "Approve or revise a TaskNotes issue close-out.",
      display_name_key: "decision",
      fields: {
        request: { type: "link", target: "pickle_request", required: true },
        decision: { type: "enum", values: ["approve", "reject"], required: true },
        responded_at: { type: "datetime", generated: "now" },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.report?.detected_generator).toBeUndefined();
    expect(result.typeFile?.["x-tasknotes"]).toBeUndefined();
    const schema = result.typeFile?.schema as { value?: { properties?: Record<string, unknown> } };
    expect(schema.value?.properties).not.toHaveProperty("occurrenceMaterialization");
    expect(result.report?.summary.link_fields_moved_to_collection_links).toEqual(["request"]);
  });

  it("migrates the legacy any field type to an unconstrained JSON Schema", () => {
    const result = migrateV02TypeToV03({
      name: "plan",
      fields: {
        target: { type: "any", description: "String or numeric target." },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.report?.unsupported).toEqual([]);
    const schema = result.typeFile?.schema as { value?: { properties?: Record<string, unknown> } };
    expect(schema.value?.properties?.target).toEqual({
      description: "String or numeric target.",
    });
  });

  it("omits invalid legacy display fields instead of producing dangling v0.3 metadata", () => {
    const result = migrateV02TypeToV03({
      name: "pickle_response_legacy",
      display_name_key: "decision",
      fields: {
        request: { type: "link", target: "pickle_request", required: true },
        responded_at: { type: "datetime", generated: "now" },
      },
    });

    expect(result.valid).toBe(true);
    expect((result.typeFile?.collection as Record<string, unknown>).display).toBeUndefined();
    expect(result.report?.warnings).toContainEqual(
      expect.objectContaining({ code: "display_field_missing" }),
    );
    expect(result.report?.mappings).not.toContainEqual(
      expect.objectContaining({ from: "display_name_key" }),
    );
  });

  it("rejects invalid v0.3 type migration metadata", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
migrations:
  - from: 0
    to: 1
    action: tasknotes.type.upgrade
    steps:
      - noop: true
---
`);

    const opened = await Collection.open(root);
    expect(opened.collection).toBeUndefined();
    expect(opened.error?.code).toBe("invalid_type_definition");
    expect(opened.error?.message).toContain("exactly one of steps or action");
  });

  it("rejects typoed v0.3 type-file keys", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
collecton:
  read_defaults:
    status: open
schema:
  dialect: json-schema-2020-12
  value:
    type: object
---
`);

    const opened = await Collection.open(root);
    expect(opened.collection).toBeUndefined();
    expect(opened.error?.code).toBe("invalid_type_definition");
    expect(opened.error?.message).toContain('unknown top-level key "collecton"');
  });

  it("rejects typoed v0.3 collection semantics keys", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
collection:
  lnks:
    project:
      target_type: project
---
`);

    const opened = await Collection.open(root);
    expect(opened.collection).toBeUndefined();
    expect(opened.error?.code).toBe("invalid_type_definition");
    expect(opened.error?.message).toContain('collection has unknown key "lnks"');
  });

  it("returns opaque revisions and rejects stale conditional writes", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.3.0"\n');
    await write(root, "tasks/a.md", `---
title: A
---
`);
    const collection = await open(root);
    const read = await collection.read("tasks/a.md");
    expect(read.revision).toMatch(/^sha256:[a-f0-9]{64}$/);

    const updated = await collection.update({
      path: "tasks/a.md",
      fields: { title: "B" },
      if_revision: read.revision,
    });
    expect(updated.valid).toBe(true);
    expect(updated.revision).not.toBe(read.revision);

    const stale = await collection.update({
      path: "tasks/a.md",
      fields: { title: "C" },
      if_revision: read.revision,
    });
    expect(stale.error?.code).toBe("concurrent_modification");
  });

  it("rejects lifecycle changes to frozen type membership", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.3.0"\n');
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
schema:
  dialect: json-schema-2020-12
  value: { type: object }
lifecycle:
  on_create:
    set:
      type: { literal: other }
---
`);
    await write(root, "_types/other.md", `---
kind: mdbase.type
name: other
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
`);
    const collection = await open(root);
    const result = await collection.create({ type: "task", path: "tasks/a.md", frontmatter: { title: "A" } });
    expect(result.error?.code).toBe("type_membership_changed");
  });

  it("uses v0.3 raw-presence semantics and canonical query rows", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.3.0"\n');
    await write(root, "_types/has_assignee.md", `---
kind: mdbase.type
name: has_assignee
match:
  where:
    assignee: { exists: true }
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
`);
    await write(root, "records/a.md", `---
title: A
assignee: null
---
`);
    const collection = await open(root);
    expect((await collection.read("records/a.md")).types).toEqual(["has_assignee"]);
    const query = await collection.query({ where: 'title == "A"' });
    expect(query.results?.[0]?.file?.path).toBe("records/a.md");
    expect(query.meta).toEqual({ total_count: 1, has_more: false });
    expect(query.diagnostics).toEqual([]);
  });

  it("uses one invocation timezone for datetime-to-date conversion", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.3.0"\nsettings:\n  timezone: UTC\n');
    await write(root, "records/temporal.md", `---
title: Temporal
scheduled: 2026-08-05T23:30:00Z
---
`);
    await write(root, "views/temporal.md", `---
type: view
id: temporal.views
version: 1
name: Temporal
query:
  where: date(scheduled) == '2026-08-05'
views:
  - id: local-day
    name: Local day
---
`);
    const collection = await open(root);
    const melbourne = await collection.queryCanonical({
      timezone: "Australia/Melbourne",
      where: "date(scheduled) == '2026-08-06'",
    });
    expect(melbourne.meta.total_count).toBe(1);
    const losAngeles = await collection.queryCanonical({
      timezone: "America/Los_Angeles",
      where: "date(scheduled) == '2026-08-05'",
    });
    expect(losAngeles.meta.total_count).toBe(1);
    expect((await collection.executeView({
      path: "views/temporal.md",
      view: "local-day",
      timezone: "America/Los_Angeles",
    })).meta.total_count).toBe(1);
    expect((await collection.executeView({
      path: "views/temporal.md",
      view: "local-day",
      timezone: "Australia/Melbourne",
    })).meta.total_count).toBe(0);
    const invalid = await collection.queryCanonical({
      timezone: "+10:00",
      where: "true",
    });
    expect(invalid.error?.code).toBe("invalid_timezone");
    expect(invalid.diagnostics[0]?.code).toBe("invalid_timezone");
  });

  it("keeps a view's nested query types separate from record membership", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.3.0"\n');
    await write(root, "_types/view.md", `---
kind: mdbase.type
name: view
version: 1
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
`);
    await write(root, "_types/task.md", `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
`);
    await write(root, "views/tasks.md", `---
type: view
id: task.views
version: 1
name: Tasks
query:
  types: [task]
views:
  - id: all
    name: All tasks
---
`);
    await write(root, "tasks/a.md", "---\ntype: task\ntitle: A\n---\n");

    const collection = await open(root);
    expect((await collection.read("views/tasks.md")).types).toEqual(["view"]);
    expect((await collection.queryCanonical({ types: ["task"] })).results.map((row) => row.path)).toEqual([
      "tasks/a.md",
    ]);
  });

  it("loads explicit data-contract unions and validates normalized record views", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  contracts_folder: contracts
`);
    await write(root, "contracts/example.note.md", `---
kind: mdbase.contract
contract_type: record
id: example.note
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    additionalProperties: false
    properties:
      title: { type: string, minLength: 1 }
---
`);
    await write(root, "_types/personal_note.md", `---
kind: mdbase.type
name: personal_note
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    properties:
      type: { const: personal_note }
      title: { type: string }
implements:
  - contract: example.note
    version: 1.0.0
    fields: { title: title }
---
`);
    await write(root, "_types/work_note.md", `---
kind: mdbase.type
name: work_note
version: 2
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, summary]
    properties:
      type: { const: work_note }
      summary: { type: string }
implements:
  - contract: example.note
    version: 1.0.0
    fields: { title: summary }
---
`);
    await write(root, "work.md", "---\ntype: work_note\nsummary: Work note\n---\n");
    await write(root, "invalid.md", "---\ntype: work_note\nsummary: ''\n---\n");

    const collection = await open(root);
    expect(collection.listDataContracts()).toEqual([
      expect.objectContaining({
        id: "example.note",
        version: "1.0.0",
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    ]);
    expect(collection.getDataContractImplementations("example.note", "1.0.0")).toEqual([
      expect.objectContaining({ type: "personal_note", type_version: 1 }),
      expect.objectContaining({ type: "work_note", type_version: 2 }),
    ]);
    expect(await collection.getContractView("work.md", "example.note", "1.0.0")).toMatchObject({
      valid: true,
      type: "work_note",
      view: { title: "Work note" },
      implementation_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(await collection.validate("invalid.md")).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "data_contract_record_invalid", field: "title" }),
      ]),
    });
    expect((await collection.queryCanonical({})).results.map((row) => row.path)).toEqual([
      "invalid.md",
      "work.md",
    ]);
    await collection.close();
  });

  it("fails closed when a type names a missing exact data contract", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.3.0"\n');
    await write(root, "_types/note.md", `---
kind: mdbase.type
name: note
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties: { title: { type: string } }
implements:
  - contract: example.note
    version: 2.0.0
    fields: { title: title }
---
`);
    expect(await Collection.open(root)).toMatchObject({
      error: { code: "data_contract_not_found" },
    });
  });

  it("registers event and action contracts without treating them as record implementations", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.3.0"\n');
    await write(root, "_contracts/example.changed.md", `---
kind: mdbase.contract
contract_type: event
id: example.changed
version: 1.0.0
data_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [value]
    properties: { value: { type: string } }
---
`);
    await write(root, "_contracts/example.update.md", `---
kind: mdbase.contract
contract_type: action
id: example.update
version: 1.0.0
input_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [value]
    properties: { value: { type: string } }
output_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [updated]
    properties: { updated: { type: boolean } }
behavior:
  idempotency: optional
  cancellation: cooperative
---
`);

    const collection = await open(root);
    expect(collection.listDataContracts()).toEqual([
      expect.objectContaining({
        contract_type: "event",
        id: "example.changed",
        data_schema: expect.any(Object),
      }),
      expect.objectContaining({
        contract_type: "action",
        id: "example.update",
        input_schema: expect.any(Object),
        output_schema: expect.any(Object),
        behavior: {
          idempotency: "optional",
          cancellation: "cooperative",
        },
      }),
    ]);
    expect(collection.getDataContractImplementations("example.changed", "1.0.0")).toEqual([]);
    await collection.close();
  });

  it("rejects a type-file implements entry for an event contract", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", 'spec_version: "0.3.0"\n');
    await write(root, "_contracts/example.changed.md", `---
kind: mdbase.contract
contract_type: event
id: example.changed
version: 1.0.0
data_schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
`);
    await write(root, "_types/note.md", `---
kind: mdbase.type
name: note
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties: { title: { type: string } }
implements:
  - contract: example.changed
    version: 1.0.0
    fields: {}
---
`);
    expect(await Collection.open(root)).toMatchObject({
      error: {
        code: "data_contract_field_invalid",
        message: expect.stringContaining("cannot implement event contract"),
      },
    });
  });
});
