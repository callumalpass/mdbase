import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  Collection,
  applyTypePack,
  assessTypePack,
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
        mode: "managed",
        source,
        target,
        digest: `sha256:${createHash("sha256").update(document).digest("hex")}`,
      })),
    },
    resources: items.map(({ source, document }) => ({ source, document })),
  };
}

describe("transactional type packs", () => {
  it("assesses and applies a complete pack with portable provenance", async () => {
    const root = await collection();
    const input = pack();
    const assessment = await assessTypePack(root, input, { installedBy: "dev.example.tests" });
    expect(assessment.valid).toBe(true);
    expect(assessment.result).toMatchObject({ status: "install", applicable: true });
    expect(assessment.result.resources.map(({ action }) => action)).toEqual([
      "create",
      "create",
      "create",
    ]);
    await expect(fs.stat(path.join(root, "_types/task.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const installed = await applyTypePack(root, input, {
      installedBy: "dev.example.tests",
      expectedAssessmentDigest: assessment.result.assessment_digest,
    });
    expect(installed, JSON.stringify(installed)).toMatchObject({ valid: true });
    expect(installed.result.resources).toEqual(assessment.result.resources);
    expect(JSON.parse(await fs.readFile(path.join(root, "mdbase.lock.yaml"), "utf8")))
      .toMatchObject({ packs: [{ id: "example.tasks", installed_by: "dev.example.tests" }] });

    const opened = await Collection.open(root);
    expect(opened.error).toBeUndefined();
    expect(opened.collection?.getDataContractImplementations("example.task", "1.0.0")).toHaveLength(1);
    await opened.collection?.close();

    const repeated = await assessTypePack(root, input, { installedBy: "dev.example.tests" });
    expect(repeated.valid).toBe(true);
    expect(repeated.result.status).toBe("current");
    expect(repeated.result.resources.every(({ action }) => action === "unchanged")).toBe(true);
  });

  it("rejects conflicts, digest failures, and invalid staged registries without partial writes", async () => {
    const root = await collection();
    const valid = pack();
    const badDigest = structuredClone(valid.manifest);
    badDigest.resources[1]!.digest = `sha256:${"0".repeat(64)}`;
    expect((await assessTypePack(root, { manifest: badDigest, resources: valid.resources }, { installedBy: "dev.example.tests" })).diagnostics[0]?.code)
      .toBe("invalid_type_pack");
    await expect(fs.stat(path.join(root, "_types/task.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const invalidItems = definitions();
    invalidItems[2]!.document = invalidItems[2]!.document.replace("example.task", "missing.task");
    const invalid = pack(invalidItems);
    const invalidAssessment = await assessTypePack(root, invalid, { installedBy: "dev.example.tests" });
    expect(invalidAssessment.valid).toBe(true);
    expect((await applyTypePack(root, invalid, {
      installedBy: "dev.example.tests",
      expectedAssessmentDigest: invalidAssessment.result.assessment_digest,
    })).valid).toBe(false);
    await expect(fs.stat(path.join(root, "_contracts/example.task.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const validAssessment = await assessTypePack(root, valid, { installedBy: "dev.example.tests" });
    const validInstall = await applyTypePack(root, valid, {
      installedBy: "dev.example.tests",
      expectedAssessmentDigest: validAssessment.result.assessment_digest,
    });
    expect(validInstall, JSON.stringify(validInstall)).toMatchObject({ valid: true });
    const before = await fs.readFile(path.join(root, "_contracts/example.task.md"), "utf8");
    const changedItems = definitions();
    changedItems[1]!.document = changedItems[1]!.document.replace("1.0.0", "2.0.0");
    const changed = pack(changedItems);
    changed.manifest.version = "2.0.0";
    await fs.writeFile(
      path.join(root, "_contracts/example.task.md"),
      `${before}\nUser-authored change.\n`,
    );
    const conflict = await assessTypePack(root, changed, { installedBy: "dev.example.tests" });
    expect(conflict.result.status).toBe("conflict");
    expect(conflict.result.resources.some(({ action }) => action === "conflict")).toBe(true);
    expect(await fs.readFile(path.join(root, "_contracts/example.task.md"), "utf8"))
      .toBe(`${before}\nUser-authored change.\n`);
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

    const assessment = await assessTypePack(root, input, { installedBy: "dev.example.tests" });
    const installed = await applyTypePack(root, input, {
      installedBy: "dev.example.tests",
      expectedAssessmentDigest: assessment.result.assessment_digest,
    });
    expect(installed, JSON.stringify(installed)).toMatchObject({ valid: true });
  });

  it("adopts byte-identical legacy definitions automatically and requires digest-pinned consent for replacements", async () => {
    const identicalRoot = await collection();
    const input = pack();
    await fs.mkdir(path.join(identicalRoot, "_contracts"), { recursive: true });
    await fs.writeFile(
      path.join(identicalRoot, "_contracts/example.task.md"),
      definitions()[1]!.document,
    );
    const identical = await assessTypePack(identicalRoot, input, {
      installedBy: "dev.example.tests",
    });
    expect(identical.result.resources.find(({ source }) => source === "contract.md"))
      .toMatchObject({ action: "adopt", adopted_from_digest: input.manifest.resources[1]!.digest });

    const legacyRoot = await collection();
    await fs.mkdir(path.join(legacyRoot, "_contracts"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "_contracts/example.task.md"), "Older unmanaged definition.\n");
    const conflict = await assessTypePack(legacyRoot, input, {
      installedBy: "dev.example.tests",
    });
    const contract = conflict.result.resources.find(({ source }) => source === "contract.md")!;
    expect(contract).toMatchObject({ action: "conflict" });
    const reviewed = await assessTypePack(legacyRoot, input, {
      installedBy: "dev.example.tests",
      adoptResources: { [contract.target]: contract.current_digest! },
    });
    expect(reviewed.result.resources.find(({ source }) => source === "contract.md"))
      .toMatchObject({ action: "update", adopted_from_digest: contract.current_digest });
    const applied = await applyTypePack(legacyRoot, input, {
      installedBy: "dev.example.tests",
      adoptResources: { [contract.target]: contract.current_digest! },
      expectedAssessmentDigest: reviewed.result.assessment_digest,
    });
    expect(applied.valid).toBe(true);
  });

  it("records omitted seeds and safely reconfigures canonical resources to collection-specific targets", async () => {
    const root = await collection();
    const input = pack();
    input.manifest.resources[2]!.mode = "seed";
    const firstOverrides = {
      "schemas/task-contract.schema.json": "definitions/schemas/task-contract.schema.json",
      "_contracts/example.task.md": "definitions/contracts/example.task.md",
      "_types/task.md": "definitions/types/task.md",
    };
    const first = await assessTypePack(root, input, {
      installedBy: "dev.example.tests",
      targetOverrides: firstOverrides,
      preserveSeedTargets: ["definitions/types/task.md"],
    });
    expect(first.result.resources.find(({ source }) => source === "task.md"))
      .toMatchObject({ action: "preserve", mode: "seed" });
    expect((await applyTypePack(root, input, {
      installedBy: "dev.example.tests",
      targetOverrides: firstOverrides,
      preserveSeedTargets: ["definitions/types/task.md"],
      expectedAssessmentDigest: first.result.assessment_digest,
    })).valid).toBe(true);
    await expect(fs.stat(path.join(root, "definitions/types/task.md")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const nextOverrides = {
      ...firstOverrides,
      "schemas/task-contract.schema.json": "next/schemas/task-contract.schema.json",
      "_contracts/example.task.md": "next/contracts/example.task.md",
    };
    const reconfigured = await assessTypePack(root, input, {
      installedBy: "dev.example.tests",
      targetOverrides: nextOverrides,
      preserveSeedTargets: ["definitions/types/task.md"],
    });
    expect(reconfigured.result.status).toBe("reconfigure");
    expect(reconfigured.result.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "contract.md", target: "next/contracts/example.task.md", action: "create" }),
      expect.objectContaining({ source: "contract.md", target: "definitions/contracts/example.task.md", action: "delete" }),
    ]));
    expect((await applyTypePack(root, input, {
      installedBy: "dev.example.tests",
      targetOverrides: nextOverrides,
      preserveSeedTargets: ["definitions/types/task.md"],
      expectedAssessmentDigest: reconfigured.result.assessment_digest,
    })).valid).toBe(true);
    await expect(fs.stat(path.join(root, "definitions/contracts/example.task.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const lock = JSON.parse(await fs.readFile(path.join(root, "mdbase.lock.yaml"), "utf8"));
    expect(lock.packs[0].resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "contract.md", target: "next/contracts/example.task.md" }),
    ]));
  });

  it("rejects immutable same-version drift and a stale reviewed baseline", async () => {
    const root = await collection();
    const input = pack();
    const initial = await assessTypePack(root, input, { installedBy: "dev.example.tests" });
    expect((await applyTypePack(root, input, {
      installedBy: "dev.example.tests",
      expectedAssessmentDigest: initial.result.assessment_digest,
    })).valid).toBe(true);

    const drifted = structuredClone(input);
    drifted.manifest.description = "Changed without publishing a new pack version";
    const immutable = await assessTypePack(root, drifted, { installedBy: "dev.example.tests" });
    expect(immutable.result).toMatchObject({ status: "conflict", applicable: false });

    const current = await assessTypePack(root, input, { installedBy: "dev.example.tests" });
    await fs.writeFile(path.join(root, "_types/task.md"), `${definitions()[2]!.document}\nChanged.\n`);
    const stale = await applyTypePack(root, input, {
      installedBy: "dev.example.tests",
      expectedAssessmentDigest: current.result.assessment_digest,
    });
    expect(stale.diagnostics[0]?.code).toBe("concurrent_modification");
  });
});
