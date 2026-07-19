import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Collection,
  materializeRuntimeContractRecord,
  validateRuntimeActionInput,
  validateRuntimeActionOutput,
  validateRuntimeEventEnvelope,
} from "../src/index.js";

async function tempCollection(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-v0.3-runtime-"));
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

async function writeRuntimeFixture(root: string): Promise<void> {
  await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
runtime:
  profile_version: "0.1.0"
  policy: policies/local.md
`);
  await write(root, "_types/workflow.md", `---
kind: mdbase.type
name: workflow
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
---
`);
  await write(root, "actions/mdbase.record.patch.md", `---
type: action
id: mdbase.record.patch
version: 1
provider: mdbase
name: Patch record
schemas:
  dialect: json-schema-2020-12
  input:
    type: object
    required: [path, patch]
    additionalProperties: false
    properties:
      path: { type: string }
      patch: { type: object }
  output:
    type: object
    required: [path, frontmatter]
    additionalProperties: false
    properties:
      path: { type: string }
      frontmatter: { type: object }
effects:
  - mdbase.record.write
emits:
  - mdbase.record.modified
---
`);
  await write(root, "events/canvas.drop.md", `---
type: event
id: canvas.drop
version: 1
provider: canvas-bases
name: Canvas drop
schemas:
  dialect: json-schema-2020-12
  payload:
    type: object
    required: [board]
    additionalProperties: false
    properties:
      board: { type: object }
---
`);
  await write(root, "events/mdbase.record.modified.md", `---
type: event
id: mdbase.record.modified
version: 1
provider: mdbase
name: Record modified
schemas:
  dialect: json-schema-2020-12
  payload:
    type: object
---
`);
  await write(root, "capabilities/mdbase.record.write.md", `---
type: capability
id: mdbase.record.write
version: 1
provider: mdbase
name: Write mdbase records
risk: medium
---
`);
  await write(root, "policies/local.md", `---
type: runtime_policy
id: local.policy
version: 1
name: Local policy
capabilities:
  mdbase.record.write:
    mode: allow
executors:
  default: test-runtime
---
`);
  await write(root, "workflows/canvas-zone-set-status.md", `---
type: workflow
id: canvas.zone.set-status
version: 1
name: Canvas zone sets status
enabled: true
requires:
  capabilities:
    - mdbase.record.write
triggers:
  - id: drop
    event: canvas.drop
steps:
  - id: patch
    action: mdbase.record.patch
    input:
      path:
        $expr: event.payload.card.path
      patch:
        status: doing
---
`);
}

describe("v0.3 runtime contracts", () => {
  it("loads the canonical mdbase-spec canvas runtime example when available", async () => {
    const exampleRoot = "/home/calluma/projects/mdbase-spec/examples/v0.3/canvas-runtime";
    if (!fsSync.existsSync(path.join(exampleRoot, "mdbase.yaml"))) {
      return;
    }

    const collection = await open(exampleRoot);
    const runtimePackage = await collection.loadRuntimeContracts();
    expect(runtimePackage.diagnostics).toEqual([]);
    expect(runtimePackage.actions.map((record) => record.frontmatter.id)).toContain("mdbase.record.patch");
    expect(runtimePackage.events.map((record) => record.frontmatter.id)).toContain("canvas.drop");
    expect((await collection.preflightRuntimeWorkflows()).valid).toBe(true);
  });

  it("loads runtime records, composes a registry, and preflights workflows", async () => {
    const root = await tempCollection();
    await writeRuntimeFixture(root);
    const collection = await open(root);

    const runtimePackage = await collection.loadRuntimeContracts();
    expect(runtimePackage.diagnostics).toEqual([]);
    expect(runtimePackage.typeFiles).toHaveLength(1);
    expect(runtimePackage.actions).toHaveLength(1);
    expect(runtimePackage.events).toHaveLength(2);
    expect(runtimePackage.capabilities).toHaveLength(1);
    expect(runtimePackage.workflows).toHaveLength(1);

    const registry = await collection.getRuntimeRegistry();
    expect([...registry.actions.keys()]).toEqual(["mdbase.record.patch"]);
    expect([...registry.events.keys()].sort()).toEqual(["canvas.drop", "mdbase.record.modified"]);
    expect([...registry.capabilities.keys()]).toEqual(["mdbase.record.write"]);
    expect([...registry.workflows.keys()]).toEqual(["canvas.zone.set-status"]);

    const preflight = await collection.preflightRuntimeWorkflows();
    expect(preflight.valid).toBe(true);
    expect(preflight.diagnostics).toEqual([]);
  });

  it("validates runtime event envelopes and action input/output before and after dispatch", async () => {
    const root = await tempCollection();
    await writeRuntimeFixture(root);
    const collection = await open(root);
    const registry = await collection.getRuntimeRegistry();

    const event = validateRuntimeEventEnvelope(registry, {
      type: "canvas.drop",
      contract_version: 1,
      id: "evt_01",
      occurred_at: "2026-06-14T12:00:00Z",
      source: { runtime: "test-runtime", provider: "canvas-bases" },
      payload: { board: { path: "boards/work.md" } },
    });
    expect(event.valid).toBe(true);

    const missingInput = validateRuntimeActionInput(registry, "mdbase.record.patch", {
      patch: { status: "doing" },
    });
    expect(missingInput.valid).toBe(false);
    expect(missingInput.diagnostics.some((diagnostic) => diagnostic.code === "schema_required" && diagnostic.field === "path")).toBe(true);

    const input = validateRuntimeActionInput(registry, "mdbase.record.patch", {
      path: "tasks/card-001.md",
      patch: { status: "doing" },
    });
    expect(input.valid).toBe(true);

    const output = validateRuntimeActionOutput(registry, "mdbase.record.patch", {
      path: "tasks/card-001.md",
      frontmatter: { type: "task", title: "Card" },
    });
    expect(output.valid).toBe(true);

    const markdown = materializeRuntimeContractRecord(registry.actions.get("mdbase.record.patch")!);
    expect(markdown).toContain("type: action");
    expect(markdown).toContain("id: mdbase.record.patch");
  });

  it("preflights implicit runtime contracts without materialized records", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "workflows/timer.md", `---
type: workflow
id: timer.workflow
version: 1
name: Timer workflow
enabled: true
triggers:
  - id: tick
    event: timer.fired
steps:
  - id: patch
    action: mdbase.record.patch
---
`);

    const collection = await open(root);
    const preflight = await collection.preflightRuntimeWorkflows({
      implicitContracts: [
        {
          type: "event",
          id: "timer.fired",
          version: 1,
          provider: "mdbase",
          name: "Timer fired",
          schemas: {
            dialect: "json-schema-2020-12",
            payload: { type: "object" },
          },
        },
        {
          type: "action",
          id: "mdbase.record.patch",
          version: 1,
          provider: "mdbase",
          name: "Patch record",
          schemas: {
            dialect: "json-schema-2020-12",
            input: { type: "object" },
            output: null,
          },
        },
      ],
    });
    expect(preflight.valid).toBe(true);
  });

  it("reports runtime contract structural and embedded schema diagnostics", async () => {
    const root = await tempCollection();
    await write(root, "mdbase.yaml", `spec_version: "0.3.0"
settings:
  validation: error
`);
    await write(root, "actions/bad.md", `---
type: action
id: bad.action
version: 1
provider: mdbase
name: Bad action
typoed: true
schemas:
  dialect: json-schema-2020-12
  input:
    type: strung
---
`);

    const collection = await open(root);
    const runtimePackage = await collection.loadRuntimeContracts();
    expect(runtimePackage.diagnostics.some((diagnostic) => diagnostic.code === "schema_additional_properties")).toBe(true);
    expect(runtimePackage.diagnostics.some((diagnostic) => diagnostic.code === "invalid_embedded_schema")).toBe(true);
  });
});
