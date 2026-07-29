#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { Collection } from "../dist/index.js";

const implementation = {
  id: "mdbase-ts",
  name: "mdbase TypeScript implementation",
  version: "0.3.0-rc.4",
  language: "TypeScript",
  target: "Node.js"
};

const scenarioId = "core.shared-contract-consumers";
const command = process.argv[2];

if (command === "describe") {
  write({
    kind: "mdbase.testbed.adapter",
    protocol_version: "0.1",
    implementation,
    profiles: ["core_read"],
    roles: ["contract_store", "record_consumer"],
    scenarios: [scenarioId]
  });
} else if (command === "run") {
  try {
    const request = JSON.parse(await readStdin());
    if (
      request.kind !== "mdbase.testbed.run"
      || request.protocol_version !== "0.1"
      || request.scenario?.id !== scenarioId
    ) {
      throw new Error("Unsupported or invalid mdbase testbed run request.");
    }
    write({
      kind: "mdbase.testbed.transcript",
      protocol_version: "0.1",
      scenario_id: scenarioId,
      implementation,
      entries: await sharedContractConsumers(request)
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write("Usage: testbed-adapter.mjs describe|run\n");
  process.exitCode = 2;
}

async function sharedContractConsumers(request) {
  const contract = fixture(request, "contract.example-note");
  const type = fixture(request, "type.shared-note");
  const record = fixture(request, "record.shared-note");
  const root = await mkdtemp(join(tmpdir(), "mdbase-testbed-ts-"));
  let collection;
  try {
    await mkdir(join(root, "_contracts"), { recursive: true });
    await mkdir(join(root, "_types"), { recursive: true });
    await writeFile(
      join(root, "mdbase.yaml"),
      stringify({
        spec_version: "0.3.0",
        settings: {
          types_folder: "_types",
          contracts_folder: "_contracts",
          explicit_type_keys: ["type"],
          cache_folder: ".mdbase"
        }
      }),
      "utf8"
    );
    await writeFile(
      join(root, "_contracts/example.note.md"),
      markdown(contract),
      "utf8"
    );
    await writeFile(
      join(root, "_types/shared-note.md"),
      markdown(type),
      "utf8"
    );
    await writeFile(join(root, "shared.md"), markdown(record), "utf8");

    const opened = await Collection.open(root);
    if (!opened.collection) {
      throw new Error(opened.error?.message ?? "Failed to open the testbed collection.");
    }
    collection = opened.collection;
    const loadedContract = collection.listDataContracts().find(
      ({ id, version }) => id === contract.id && version === contract.version
    );
    const implementationDescriptor = collection
      .getDataContractImplementations(contract.id, contract.version)
      .find(({ type: name }) => name === type.name);
    const alpha = await collection.getContractView(
      "shared.md",
      contract.id,
      contract.version
    );
    const beta = await collection.getContractView(
      "shared.md",
      contract.id,
      contract.version
    );
    if (!loadedContract || !implementationDescriptor || !alpha.valid || !beta.valid) {
      const diagnostics = [...alpha.diagnostics, ...beta.diagnostics]
        .map(({ code, message }) => `${code}: ${message}`)
        .join("; ");
      throw new Error(`Shared contract fixture did not load and project: ${diagnostics}`);
    }

    return [
      entry(1, "arrange", "contract-store", "contract.load", "succeeded", {
        contract: loadedContract.id,
        version: loadedContract.version
      }),
      entry(2, "arrange", "contract-store", "type.load", "succeeded", {
        type: implementationDescriptor.type,
        implements: implementationDescriptor.contract
      }),
      entry(3, "act", "consumer-alpha", "contract-view.read", "succeeded", {
        contract: alpha.contract,
        view: alpha.view
      }),
      entry(4, "act", "consumer-beta", "contract-view.read", "succeeded", {
        contract: beta.contract,
        view: beta.view
      }),
      entry(5, "observe", "testbed", "contract-view.compare", "succeeded", {
        consumers: 2,
        same_contract:
          alpha.contract === beta.contract
          && alpha.contract_digest === beta.contract_digest,
        same_view: JSON.stringify(alpha.view) === JSON.stringify(beta.view)
      })
    ];
  } finally {
    await collection?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function fixture(request, id) {
  const selected = request.fixtures?.[id];
  if (!selected) throw new Error(`Scenario request is missing fixture ${id}.`);
  return structuredClone(selected.value);
}

function markdown(frontmatter) {
  return `---\n${stringify(frontmatter)}---\n`;
}

function entry(sequence, phase, actor, operation, outcome, facts) {
  return { sequence, phase, actor, operation, outcome, facts };
}

async function readStdin() {
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
