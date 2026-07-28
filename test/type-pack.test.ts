import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  Collection,
  installTypePack,
  type TypePackManifest,
  type TypePackSourceResource,
} from "../src/index.js";

async function collection(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-type-pack-test-"));
  await fs.writeFile(
    path.join(root, "mdbase.yaml"),
    "spec_version: 0.3.0\nsettings:\n  validation: error\n",
  );
  return root;
}

function definitions(): Array<{
  kind: "schema" | "contract" | "type";
  source: string;
  target: string;
  document: string;
}> {
  return [
    {
      kind: "schema",
      source: "task-contract.schema.json",
      target: "schemas/task-contract.schema.json",
      document: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["title"],"additionalProperties":false,"properties":{"title":{"type":"string"}}}',
    },
    {
      kind: "contract",
      source: "contract.md",
      target: "_contracts/example.task.md",
      document: `---
kind: mdbase.contract
contract_type: record
id: example.task
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  ref: ../schemas/task-contract.schema.json
---
`,
    },
    {
      kind: "type",
      source: "task.md",
      target: "_types/task.md",
      document: `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    additionalProperties: true
    properties:
      title: { type: string }
implements:
  - contract: example.task
    version: 1.0.0
    fields:
      title: title
---
`,
    },
  ];
}

function pack(items = definitions()): {
  manifest: TypePackManifest;
  resources: TypePackSourceResource[];
} {
  return {
    manifest: {
      kind: "mdbase.type-pack",
      id: "example.tasks",
      version: "1.0.0",
      resources: items.map(({ kind, source, target, document }) => ({
        kind,
        source,
        target,
        digest: `sha256:${createHash("sha256").update(document).digest("hex")}`,
      })),
    },
    resources: items.map(({ source, document }) => ({ source, document })),
  };
}

describe("transactional type packs", () => {
  it("installs a complete pack and reports deterministic create/unchanged diffs", async () => {
    const root = await collection();
    const input = pack();
    const dryRun = await installTypePack(root, input.manifest, input.resources, { dryRun: true });
    expect(dryRun.valid).toBe(true);
    expect(dryRun.result.resources.map(({ action }) => action)).toEqual([
      "create",
      "create",
      "create",
    ]);
    await expect(fs.stat(path.join(root, "_types/task.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const installed = await installTypePack(root, input.manifest, input.resources);
    expect(installed, JSON.stringify(installed)).toMatchObject({ valid: true });
    expect(installed.result.resources).toEqual(dryRun.result.resources);

    const opened = await Collection.open(root);
    expect(opened.error).toBeUndefined();
    expect(opened.collection?.getDataContractImplementations("example.task", "1.0.0")).toHaveLength(1);
    await opened.collection?.close();

    const repeated = await installTypePack(root, input.manifest, input.resources);
    expect(repeated.valid).toBe(true);
    expect(repeated.result.resources.every(({ action }) => action === "unchanged")).toBe(true);
  });

  it("rejects conflicts, digest failures, and invalid staged registries without partial writes", async () => {
    const root = await collection();
    const valid = pack();
    const badDigest = structuredClone(valid.manifest);
    badDigest.resources[1]!.digest = `sha256:${"0".repeat(64)}`;
    expect((await installTypePack(root, badDigest, valid.resources)).diagnostics[0]?.code)
      .toBe("invalid_type_pack");
    await expect(fs.stat(path.join(root, "_types/task.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const invalidItems = definitions();
    invalidItems[2]!.document = invalidItems[2]!.document.replace("example.task", "missing.task");
    const invalid = pack(invalidItems);
    expect((await installTypePack(root, invalid.manifest, invalid.resources)).valid).toBe(false);
    await expect(fs.stat(path.join(root, "_contracts/example.task.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const validInstall = await installTypePack(root, valid.manifest, valid.resources);
    expect(validInstall, JSON.stringify(validInstall)).toMatchObject({ valid: true });
    const before = await fs.readFile(path.join(root, "_contracts/example.task.md"), "utf8");
    const changedItems = definitions();
    changedItems[1]!.document = changedItems[1]!.document.replace("1.0.0", "2.0.0");
    const changed = pack(changedItems);
    const conflict = await installTypePack(root, changed.manifest, changed.resources);
    expect(conflict.diagnostics[0]?.code).toBe("type_pack_conflict");
    expect(await fs.readFile(path.join(root, "_contracts/example.task.md"), "utf8")).toBe(before);
  });

  it("recovers an interrupted applying transaction before collection open", async () => {
    const root = await collection();
    const target = path.join(root, "_types/task.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "new partial bytes");
    const transactionId = randomUUID();
    const transactionRoot = path.join(root, ".mdbase/type-pack-transactions", transactionId);
    await fs.mkdir(path.join(transactionRoot, "backups/_types"), { recursive: true });
    await fs.writeFile(path.join(transactionRoot, "backups/_types/task.md"), "old bytes");
    await fs.writeFile(
      path.join(transactionRoot, "journal.json"),
      `${JSON.stringify({
        version: 1,
        transaction_id: transactionId,
        status: "applying",
        entries: [{
          target: "_types/task.md",
          existed: true,
          backup_path: "backups/_types/task.md",
        }],
      })}\n`,
    );

    const opened = await Collection.open(root);
    expect(opened.error).toBeDefined();
    expect(await fs.readFile(target, "utf8")).toBe("old bytes");
    await expect(fs.stat(transactionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not make an unrelated pre-existing record error a pack conflict", async () => {
    const root = await collection();
    await fs.mkdir(path.join(root, "_types"), { recursive: true });
    await fs.mkdir(path.join(root, "broken"), { recursive: true });
    await fs.writeFile(
      path.join(root, "_types/broken.md"),
      `---
kind: mdbase.type
name: broken
version: 1
match:
  path_glob: broken/*.md
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [required_value]
    properties:
      required_value: { type: string }
---
`,
    );
    await fs.writeFile(path.join(root, "broken/one.md"), "---\ntitle: Already invalid\n---\n");
    const input = pack();

    const installed = await installTypePack(root, input.manifest, input.resources);
    expect(installed, JSON.stringify(installed)).toMatchObject({ valid: true });
  });
});
