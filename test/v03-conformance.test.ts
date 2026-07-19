import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import matter from "gray-matter";
import yaml from "js-yaml";
import picomatch from "picomatch";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { Collection, type V03OperationResult } from "../src/operations/collection.js";
import { loadConfig } from "../src/config/loader.js";
import { getType } from "../src/types/loader.js";
import { evaluateMdbaseCel } from "../src/expressions/cel.js";
import {
  authorizeRuntimeAction,
  composeRuntimeRegistry,
  materializeRuntimeContractRecord,
  validateRuntimeActionInput,
  validateRuntimeActionOutput,
  validateRuntimeEventEnvelope,
  type RuntimeContractRecord,
} from "../src/runtime/contracts.js";
import { migrateV02TypeFileToV03 } from "../src/migrations/type-migration.js";

type Dict = Record<string, unknown>;

interface V03Setup {
  config?: string | null;
  types?: Record<string, string>;
  files?: Record<string, string | { content?: string }>;
  collection?: string;
  source_collection?: string;
  expected_collection?: string;
  expected_report?: string;
  event?: Dict;
  steps?: Dict;
  implicit_contracts?: RuntimeContractRecord[];
}

interface V03TestCase {
  name: string;
  operation: string;
  input?: Dict;
  expect?: Dict;
}

interface V03Group {
  name: string;
  setup?: V03Setup;
  tests: V03TestCase[];
}

interface V03Suite {
  name: string;
  fixture_set: string;
  groups?: V03Group[];
}

interface TestContext {
  root: string;
  cleanup?: () => Promise<void>;
  setup?: V03Setup;
}

const SPEC_REPO = resolveSpecRepo();
const V03_TESTS_DIR = path.join(SPEC_REPO, "tests", "v0.3");
const REQUIRE_V03_CONFORMANCE = process.env.MDBASE_REQUIRE_V03_CONFORMANCE === "1";

function resolveSpecRepo(): string {
  const candidates = [
    process.env.MDBASE_SPEC_REPO_DIR,
    process.env.MDBASE_SPEC_TESTS_DIR ? path.resolve(process.env.MDBASE_SPEC_TESTS_DIR, "..", "..") : undefined,
    path.resolve(process.cwd(), "../mdbase-spec"),
    path.resolve(os.homedir(), "projects/mdbase-spec"),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "tests", "v0.3", "manifest.yaml"))) {
      return candidate;
    }
  }
  return candidates[0] ?? path.resolve(process.cwd(), "../mdbase-spec");
}

function discoverV03Suites(): Array<{ file: string; suite: V03Suite }> {
  const manifestPath = path.join(V03_TESTS_DIR, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = yaml.load(fs.readFileSync(manifestPath, "utf8")) as { fixture_sets?: Array<{ files?: string[] }> };
  const suites: Array<{ file: string; suite: V03Suite }> = [];
  for (const fixtureSet of manifest.fixture_sets ?? []) {
    for (const relativeFile of fixtureSet.files ?? []) {
      const fullPath = path.join(V03_TESTS_DIR, relativeFile);
      const suite = yaml.load(fs.readFileSync(fullPath, "utf8")) as V03Suite;
      suites.push({ file: relativeFile, suite });
    }
  }
  return suites;
}

async function materializeSetup(setup: V03Setup | undefined): Promise<TestContext> {
  if (setup?.collection) {
    return { root: path.join(SPEC_REPO, setup.collection), setup };
  }

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mdbase-v0.3-conf-"));
  if (setup?.config !== null) {
    await write(root, "mdbase.yaml", setup?.config ?? 'spec_version: "0.3.0"\n');
  }

  const typesFolder = extractTypesFolder(setup?.config) ?? "_types";
  for (const [file, content] of Object.entries(setup?.types ?? {})) {
    await write(root, path.join(typesFolder, file), content);
  }
  for (const [file, fileSpec] of Object.entries(setup?.files ?? {})) {
    await write(root, file, typeof fileSpec === "string" ? fileSpec : String(fileSpec.content ?? ""));
  }

  return {
    root,
    setup,
    cleanup: async () => {
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

async function materializeInlineCollection(files: Dict): Promise<TestContext> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mdbase-v0.3-inline-"));
  await write(root, "mdbase.yaml", 'spec_version: "0.3.0"\n');
  for (const [file, content] of Object.entries(files)) {
    await write(root, file, String(content));
  }
  return {
    root,
    cleanup: async () => {
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

function extractTypesFolder(config?: string | null): string | undefined {
  if (!config) return undefined;
  const match = config.match(/types_folder:\s*["']?([^"'\n]+)["']?/);
  return match?.[1]?.trim();
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf8");
}

async function open(root: string): Promise<Collection> {
  const opened = await Collection.open(root);
  if (opened.error || !opened.collection) {
    throw new Error(opened.error?.message ?? `Failed to open ${root}`);
  }
  return opened.collection;
}

async function withOperationRoot<T>(
  context: TestContext,
  input: Dict,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  let inline: TestContext | undefined;
  try {
    if (typeof input.collection === "string") {
      return await fn(path.join(SPEC_REPO, input.collection));
    }
    if (input.collection_inline && typeof input.collection_inline === "object") {
      inline = await materializeInlineCollection(input.collection_inline as Dict);
      return await fn(inline.root);
    }
    return await fn(context.root);
  } finally {
    await inline?.cleanup?.();
  }
}

async function executeOperation(context: TestContext, testCase: V03TestCase): Promise<Dict> {
  const input = testCase.input ?? {};

  switch (testCase.operation) {
    case "read":
      return await withOperationRoot(context, input, async (root) => {
        const collection = await open(root);
        try {
          const envelope = await collection.v03Operations().read({ path: String(input.path) });
          const result = envelope.result as Dict;
          if (input.effective === false && result.raw_frontmatter) {
            return adapterResult(envelope, { ...result, frontmatter: result.raw_frontmatter });
          }
          return adapterResult(envelope, result);
        } finally {
          await collection.close();
        }
      });

    case "validate":
      return await withOperationRoot(context, input, async (root) => {
        const collection = await open(root);
        try {
          const result = await collection.v03Operations().validate({ path: String(input.path) });
          const read = await collection.v03Operations().read({ path: String(input.path) });
          return {
            ...adapterResult(result, result.result as Dict),
            types: (read.result.types as string[] | undefined) ?? [],
            resolved_links: await collectResolvedLinks(collection, String(input.path)),
          };
        } finally {
          await collection.close();
        }
      });

    case "get_types":
      return await withOperationRoot(context, input, async (root) => {
        const collection = await open(root);
        try {
          const read = await collection.v03Operations().read({ path: String(input.path) });
          return adapterResult(read, {
            types: (read.result.types as string[] | undefined) ?? [],
          });
        } finally {
          await collection.close();
        }
      });

    case "get_type":
      return await withOperationRoot(context, input, async (root) => {
        const config = await loadConfig(root);
        if (!config.valid || !config.config) return config as Dict;
        return await getType(root, config.config, String(input.name)) as Dict;
      });

    case "query":
      return await withOperationRoot(context, input, async (root) => {
        const collection = await open(root);
        try {
          const result = await collection.query({
            where: input.where as string | Dict | undefined,
            order_by: input.order_by as Array<{ field: string; direction?: string }> | undefined,
            include_body: input.include_body as boolean | undefined,
          }) as Dict;
          return { valid: true, ...result };
        } finally {
          await collection.close();
        }
      });

    case "create":
      return await withOperationRoot(context, input, async (root) => {
        const collection = await open(root);
        try {
          const result = await collection.v03Operations().create({
            type: input.type as string | undefined,
            types: input.types as string[] | undefined,
            path: input.path as string | undefined,
            frontmatter: input.frontmatter as Dict | undefined,
            body: input.body as string | undefined,
          });
          return adapterResult(result, result.result as Dict);
        } finally {
          await collection.close();
        }
      });

    case "update":
      return await withOperationRoot(context, input, async (root) => {
        const collection = await open(root);
        try {
          const before = await collection.v03Operations().read({ path: String(input.path) });
          const result = await collection.v03Operations().update({
            path: String(input.path),
            fields: (input.patch ?? input.fields ?? input.frontmatter) as Dict | undefined,
            body: input.body as string | undefined,
          });
          const adapted = adapterResult(result, result.result as Dict);
          return {
            ...adapted,
            changed_fields: diffFields(
              before.result.frontmatter as Dict | undefined ?? {},
              result.result.frontmatter as Dict | undefined ?? {},
            ),
          };
        } finally {
          await collection.close();
        }
      });

    case "evaluate_cel":
      return await evaluateCel(context, input);

    case "evaluate_workflow_input":
      return evaluateWorkflowInput(context, input);

    case "runtime_load_contracts":
      return await withRuntimeRegistryInput(context, input, async (root, implicitContracts) => {
        const collection = await open(root);
        try {
          const runtimePackage = await collection.loadRuntimeContracts({ implicitContracts });
          return {
            valid: !hasErrorDiagnostics(runtimePackage.diagnostics),
            diagnostics: runtimePackage.diagnostics,
            counts: {
              type_files: runtimePackage.typeFiles.length,
              providers: runtimePackage.providers.length,
              actions: runtimePackage.actions.length,
              events: runtimePackage.events.length,
              capabilities: runtimePackage.capabilities.length,
              workflows: runtimePackage.workflows.length,
            },
          };
        } finally {
          await collection.close();
        }
      });

    case "runtime_compose_registry":
      return await withRuntimeRegistryInput(context, input, async (root, implicitContracts) => {
        const collection = await open(root);
        try {
          const runtimePackage = await collection.loadRuntimeContracts({ implicitContracts });
          const registry = composeRuntimeRegistry(runtimePackage, implicitContracts);
          return {
            valid: !hasErrorDiagnostics(registry.diagnostics),
            diagnostics: registry.diagnostics,
            registry: {
              providers: [...registry.providerContracts.keys()],
              actions: [...registry.actions.keys()],
              events: [...registry.events.keys()],
              capabilities: [...registry.capabilityIds],
              workflows: [...registry.workflows.keys()],
            },
          };
        } finally {
          await collection.close();
        }
      });

    case "runtime_reference_load":
      return await withRuntimeRegistryInput(context, input, async (root, implicitContracts) => {
        const collection = await open(root);
        try {
          const runtimePackage = await collection.loadRuntimeContracts({ implicitContracts });
          const registry = await collection.getRuntimeRegistry({ implicitContracts });
          const preflight = await collection.preflightRuntimeWorkflows({ implicitContracts });
          const diagnostics = [...registry.diagnostics, ...preflight.diagnostics.filter((item) => !registry.diagnostics.includes(item))];
          return {
            valid: !hasErrorDiagnostics(diagnostics),
            diagnostics,
            counts: {
              providers: runtimePackage.providers.length,
              actions: registry.actions.size,
              events: registry.events.size,
              capabilities: registry.capabilityIds.size,
              workflows: registry.workflows.size,
            },
          };
        } finally {
          await collection.close();
        }
      });

    case "runtime_preflight_workflows":
      return await withRuntimeRegistryInput(context, input, async (root, implicitContracts) => {
        const collection = await open(root);
        try {
          const result = await collection.preflightRuntimeWorkflows({ implicitContracts });
          return result as unknown as Dict;
        } finally {
          await collection.close();
        }
      });

    case "runtime_validate_event":
      return await withRuntimeRegistryInput(context, input, async (root, implicitContracts) => {
        const collection = await open(root);
        try {
          const registry = await collection.getRuntimeRegistry({ implicitContracts });
          const envelope = input.value ?? JSON.parse(fs.readFileSync(path.join(SPEC_REPO, String(input.event)), "utf8"));
          return validateRuntimeEventEnvelope(registry, envelope) as unknown as Dict;
        } finally {
          await collection.close();
        }
      });

    case "runtime_execute_event":
      return await executeRuntimeEvent(context, input);

    case "runtime_validate_action_input":
      return await withRuntimeRegistryInput(context, input, async (root, implicitContracts) => {
        const collection = await open(root);
        try {
          const registry = await collection.getRuntimeRegistry({ implicitContracts });
          return validateRuntimeActionInput(registry, String(input.action), input.value) as unknown as Dict;
        } finally {
          await collection.close();
        }
      });

    case "runtime_validate_action_output":
      return await withRuntimeRegistryInput(context, input, async (root, implicitContracts) => {
        const collection = await open(root);
        try {
          const registry = await collection.getRuntimeRegistry({ implicitContracts });
          return validateRuntimeActionOutput(registry, String(input.action), input.value) as unknown as Dict;
        } finally {
          await collection.close();
        }
      });

    case "runtime_materialize_contract":
      return await withRuntimeRegistryInput(context, input, async (root, implicitContracts) => {
        const collection = await open(root);
        try {
          const registry = await collection.getRuntimeRegistry({ implicitContracts });
          const id = String(input.contract);
          const contract = registry.actions.get(id) ?? registry.events.get(id) ?? registry.capabilities.get(id) ?? registry.workflows.get(id) ?? registry.policies.get(id);
          if (!contract) return { valid: false, diagnostics: [{ code: "unresolved_contract", id }] };
          return { valid: true, markdown: materializeRuntimeContractRecord(contract) };
        } finally {
          await collection.close();
        }
      });

    case "json_schema_meta_validate":
      return validateJsonSchemas(input);

    case "markdown_frontmatter_schema_validate":
      return validateMarkdownFrontmatter(input);

    case "embedded_json_schema_validate":
      return validateEmbeddedJsonSchemas(input);

    case "json_document_schema_validate":
      return validateJsonDocumentsAgainstSchema(input);

    case "yaml_document_schema_validate":
      return validateYamlDocumentsAgainstSchema(input);

    case "json_document_valid":
      return validateJsonDocuments(input);

    case "inspect_yaml":
      return inspectYaml(input);

    case "migrate_type":
      return await inspectTasknotesMigration(context, input);

    default:
      throw new Error(`Unsupported v0.3 conformance operation: ${testCase.operation}`);
  }
}

async function withRuntimeRegistryInput<T>(
  context: TestContext,
  input: Dict,
  fn: (root: string, implicitContracts: RuntimeContractRecord[]) => Promise<T>,
): Promise<T> {
  const implicitContracts = input.include_setup_implicit_contracts === true
    ? context.setup?.implicit_contracts ?? []
    : [];
  return await withOperationRoot(context, input, (root) => fn(root, implicitContracts));
}

function adapterResult(
  envelope: V03OperationResult,
  result: Dict,
): Dict {
  const firstError = envelope.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  const warnings = envelope.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  return {
    valid: envelope.valid,
    ...result,
    diagnostics: envelope.diagnostics,
    issues: envelope.diagnostics,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(firstError ? { error: { code: firstError.code, message: firstError.message } } : {}),
  };
}

async function collectResolvedLinks(collection: Collection, relativePath: string): Promise<Dict> {
  const read = await collection.read(relativePath);
  if (read.error) return {};
  const resolved: Dict = {};
  const frontmatter = read.rawFrontmatter ?? read.frontmatter ?? {};
  const collectionAny = collection as unknown as {
    typeDefs: Map<string, { collection?: { links?: Record<string, { target_type?: string }> } }>;
    resolveLinkFull: (value: string, source: string, target?: string) => Promise<{ resolved?: string | null }>;
  };
  for (const typeName of read.types ?? []) {
    const typeDef = collectionAny.typeDefs.get(typeName);
    for (const [field, rule] of Object.entries(typeDef?.collection?.links ?? {})) {
      const value = frontmatter[field];
      if (typeof value !== "string") continue;
      const link = await collectionAny.resolveLinkFull(value, relativePath, rule.target_type);
      resolved[field] = link.resolved ?? null;
    }
  }
  return resolved;
}

async function evaluateCel(context: TestContext, input: Dict): Promise<Dict> {
  const expression = String(input.expression);
  if (input.context === "workflow") {
    const result = evaluateMdbaseCel(expression, {
      event: context.setup?.event as Dict | undefined,
      steps: context.setup?.steps as Dict | undefined,
    });
    return { valid: true, value: result.value, diagnostics: result.diagnostics };
  }

  const collection = await open(context.root);
  try {
    const read = input.path ? await collection.read(String(input.path)) : undefined;
    const record = read?.frontmatter ?? {};
    const raw = read?.rawFrontmatter ?? record;
    const file = {
      ...(read?.file ?? {}),
      body: read?.body ?? "",
      tags: collectTags(record),
      links: [],
    };
    const result = evaluateMdbaseCel(expression, { record, raw, file });
    return { valid: true, value: result.value, diagnostics: result.diagnostics };
  } finally {
    await collection.close();
  }
}

function evaluateWorkflowInput(context: TestContext, input: Dict): Dict {
  const evaluateValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(evaluateValue);
    if (value && typeof value === "object") {
      const obj = value as Dict;
      if (typeof obj.$expr === "string") {
        return evaluateMdbaseCel(obj.$expr, {
          event: context.setup?.event as Dict | undefined,
          steps: context.setup?.steps as Dict | undefined,
        }).value;
      }
      return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, evaluateValue(item)]));
    }
    return value;
  };
  return { valid: true, value: evaluateValue(input.template) } as Dict;
}

async function executeRuntimeEvent(context: TestContext, input: Dict): Promise<Dict> {
  const sourceRoot = typeof input.collection === "string"
    ? path.join(SPEC_REPO, input.collection)
    : context.root;
  const collection = await open(sourceRoot);
  const recordOverrides = new Map<string, Dict>();
  try {
    const registry = await collection.getRuntimeRegistry();
    const preflight = await collection.preflightRuntimeWorkflows();
    if (!preflight.valid) return preflight as unknown as Dict;
    const event = JSON.parse(fs.readFileSync(path.join(SPEC_REPO, String(input.event)), "utf8")) as Dict;
    const eventValidation = validateRuntimeEventEnvelope(registry, event);
    if (!eventValidation.valid) return eventValidation as unknown as Dict;

    const runs: Dict[] = [];
    for (const workflow of registry.workflows.values()) {
      if (workflow.enabled === false) continue;
      for (const trigger of workflow.triggers ?? []) {
        if (trigger.event !== event.type) continue;
        if (trigger.if) {
          const guard = evaluateMdbaseCel(trigger.if.$expr, { event });
          if (guard.diagnostics.length > 0 || guard.value !== true) continue;
        }

        const stepBindings: Dict = {};
        const runSteps: Dict[] = [];
        let runStatus = "succeeded";
        for (const step of workflow.steps ?? []) {
          if (step.if) {
            const guard = evaluateMdbaseCel(step.if.$expr, { event, steps: stepBindings });
            if (guard.diagnostics.length > 0) {
              return { valid: false, diagnostics: guard.diagnostics };
            }
            if (guard.value !== true) continue;
          }
          const evaluatedInput = evaluateRuntimeTemplate(step.input ?? {}, event, stepBindings) as Dict;
          const inputValidation = validateRuntimeActionInput(registry, step.action, evaluatedInput);
          const authorization = authorizeRuntimeAction(registry, step.action);
          if (!inputValidation.valid || !authorization.valid) {
            return {
              valid: false,
              diagnostics: [...inputValidation.diagnostics, ...authorization.diagnostics],
            };
          }

          let output: unknown;
          if (step.action === "mdbase.record.patch") {
            const recordPath = String(evaluatedInput.path);
            const read = await collection.read(recordPath);
            if (read.error || !read.frontmatter) {
              runStatus = "failed";
              return { valid: false, diagnostics: [{ code: read.error?.code ?? "record_not_found", message: read.error?.message ?? recordPath }] };
            }
            const frontmatter = { ...read.frontmatter, ...(evaluatedInput.patch as Dict) };
            recordOverrides.set(recordPath, frontmatter);
            output = { path: recordPath, frontmatter };
          } else {
            return { valid: false, diagnostics: [{ code: "unresolved_action_handler", id: step.action }] };
          }
          const outputValidation = validateRuntimeActionOutput(registry, step.action, output);
          if (!outputValidation.valid) return outputValidation as unknown as Dict;
          stepBindings[step.id] = { output };
          runSteps.push({ id: step.id, action: step.action, status: "succeeded", input: evaluatedInput });
        }
        runs.push({ workflow: workflow.id, trigger: trigger.id, status: runStatus, steps: runSteps });
      }
    }

    const records: Dict = {};
    for (const recordPath of input.record_store as string[] | undefined ?? []) {
      const read = await collection.read(recordPath);
      records[recordPath] = { frontmatter: recordOverrides.get(recordPath) ?? read.frontmatter, body: read.body };
    }
    return { valid: true, diagnostics: [], runs, records };
  } finally {
    await collection.close();
  }
}

function evaluateRuntimeTemplate(value: unknown, event: Dict, steps: Dict): unknown {
  if (Array.isArray(value)) return value.map((item) => evaluateRuntimeTemplate(item, event, steps));
  if (value && typeof value === "object") {
    const object = value as Dict;
    if (typeof object.$expr === "string") {
      return evaluateMdbaseCel(object.$expr, { event, steps }).value;
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, evaluateRuntimeTemplate(item, event, steps)]),
    );
  }
  return value;
}

function collectTags(record: Dict): string[] {
  const tags = record.tags;
  if (Array.isArray(tags)) return tags.filter((tag): tag is string => typeof tag === "string");
  if (typeof tags === "string") return [tags];
  return [];
}

function diffFields(before: Dict, after: Dict): string[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields].filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

function hasErrorDiagnostics(diagnostics: Array<{ severity?: string }>): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === undefined);
}

function expandSpecGlob(pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/");
  const base = normalized.split("*")[0].replace(/\/?[^/]*$/, "");
  const searchRoot = path.join(SPEC_REPO, base);
  const matcher = picomatch(normalized);
  const matches: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const relative = path.relative(SPEC_REPO, fullPath).replace(/\\/g, "/");
      if (matcher(relative)) matches.push(fullPath);
    }
  };
  walk(searchRoot);
  return matches.sort();
}

function resolveSpecPaths(paths: unknown): string[] {
  return (paths as string[]).flatMap((entry) => entry.includes("*")
    ? expandSpecGlob(entry)
    : [path.join(SPEC_REPO, entry)]);
}

function getAjv(): Ajv2020 {
  const instance = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;
  addFormats(instance);
  return instance;
}

function validateJsonSchemas(input: Dict): Dict {
  const ajv = getAjv();
  const diagnostics: Dict[] = [];
  for (const filePath of resolveSpecPaths(input.paths)) {
    const schema = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!ajv.validateSchema(schema)) {
      diagnostics.push(...(ajv.errors ?? []).map((error) => ({ code: "invalid_json_schema", path: filePath, message: error.message })));
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function validateMarkdownFrontmatter(input: Dict): Dict {
  const ajv = getAjv();
  const schema = JSON.parse(fs.readFileSync(path.join(SPEC_REPO, String(input.schema)), "utf8"));
  const validate = ajv.compile(schema);
  const diagnostics: Dict[] = [];
  for (const filePath of resolveSpecPaths(input.paths)) {
    const frontmatter = matter(fs.readFileSync(filePath, "utf8")).data;
    if (!validate(frontmatter)) {
      diagnostics.push(...(validate.errors ?? []).map((error) => ({ code: schemaDiagnosticCode(error.keyword), path: filePath, field: error.instancePath, message: error.message })));
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function validateEmbeddedJsonSchemas(input: Dict): Dict {
  const ajv = getAjv();
  const diagnostics: Dict[] = [];
  for (const filePath of resolveSpecPaths(input.paths)) {
    const frontmatter = matter(fs.readFileSync(filePath, "utf8")).data as Dict;
    const schema = getPointer(frontmatter, String(input.pointer));
    if (!ajv.validateSchema(schema)) {
      diagnostics.push(...(ajv.errors ?? []).map((error) => ({ code: "invalid_embedded_schema", path: filePath, message: error.message })));
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function validateJsonDocumentsAgainstSchema(input: Dict): Dict {
  const ajv = getAjv();
  const schema = JSON.parse(fs.readFileSync(path.join(SPEC_REPO, String(input.schema)), "utf8"));
  const validate = ajv.compile(schema);
  const diagnostics: Dict[] = [];
  for (const filePath of resolveSpecPaths(input.paths)) {
    const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!validate(document)) {
      diagnostics.push(...(validate.errors ?? []).map((error) => ({ code: schemaDiagnosticCode(error.keyword), path: filePath, field: error.instancePath, message: error.message })));
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function validateYamlDocumentsAgainstSchema(input: Dict): Dict {
  const ajv = getAjv();
  const schema = JSON.parse(fs.readFileSync(path.join(SPEC_REPO, String(input.schema)), "utf8"));
  const validate = ajv.compile(schema);
  const diagnostics: Dict[] = [];
  for (const filePath of resolveSpecPaths(input.paths)) {
    const document = yaml.load(fs.readFileSync(filePath, "utf8"));
    if (!validate(document)) {
      diagnostics.push(...(validate.errors ?? []).map((error) => ({
        code: schemaDiagnosticCode(error.keyword),
        path: filePath,
        field: error.instancePath,
        message: error.message,
      })));
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function validateJsonDocuments(input: Dict): Dict {
  const diagnostics: Dict[] = [];
  for (const filePath of resolveSpecPaths(input.paths)) {
    try {
      JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      diagnostics.push({ code: "invalid_json", path: filePath, message: error instanceof Error ? error.message : "Invalid JSON" });
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function inspectYaml(input: Dict): Dict {
  const filePath = path.join(SPEC_REPO, String(input.path));
  const document = matter(fs.readFileSync(filePath, "utf8")).data as Dict;
  return { valid: true, document };
}

async function inspectTasknotesMigration(context: TestContext, input: Dict): Promise<Dict> {
  const sourcePath = resolveMigrationSourcePath(context, input);
  const result = await migrateV02TypeFileToV03(sourcePath, {
    sourcePath: typeof input.source === "string" ? input.source : undefined,
    targetPath: "v0.3/_types/task.md",
  });
  return {
    ...result,
    detected_source_version: result.report?.source_version,
    detected_generator: result.report?.detected_generator,
    report: result.report,
  } as Dict;
}

function resolveMigrationSourcePath(context: TestContext, input: Dict): string {
  if (typeof input.source !== "string") {
    throw new Error("migrate_type requires input.source");
  }
  const sourceCollection = context.setup?.source_collection;
  if (!sourceCollection) {
    return path.join(SPEC_REPO, input.source);
  }
  const sourceRoot = path.join(SPEC_REPO, sourceCollection);
  const sourceParent = path.dirname(sourceRoot);
  const fromParent = path.join(sourceParent, input.source);
  if (fs.existsSync(fromParent)) return fromParent;
  const sourcePrefix = `${path.basename(sourceRoot)}/`;
  if (input.source.startsWith(sourcePrefix)) {
    return path.join(sourceRoot, input.source.slice(sourcePrefix.length));
  }
  return path.join(sourceRoot, input.source);
}

function getPointer(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return value;
  return pointer
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .reduce((current: unknown, segment) => {
      if (!current || typeof current !== "object") return undefined;
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      return (current as Dict)[key];
    }, value);
}

function assertSubset(actual: unknown, expected: unknown, label: string): void {
  if (expected === null || typeof expected !== "object") {
    expect(actual, label).toEqual(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${label} should be an array`).toBe(true);
    for (const item of expected) {
      expect((actual as unknown[]).some((actualItem) => {
        try {
          assertSubset(actualItem, item, label);
          return true;
        } catch {
          return false;
        }
      }), `${label} should contain ${JSON.stringify(item)}`).toBe(true);
    }
    return;
  }

  const expectedObj = expected as Dict;
  if (typeof expectedObj.matches === "string") {
    expect(String(actual), label).toMatch(new RegExp(expectedObj.matches));
    return;
  }
  if (expectedObj.format === "date-time") {
    expect(Number.isNaN(Date.parse(String(actual))), label).toBe(false);
    return;
  }
  if (expectedObj.format === "date") {
    expect(String(actual), label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    return;
  }

  expect(actual && typeof actual === "object", `${label} should be object`).toBe(true);
  for (const [key, value] of Object.entries(expectedObj)) {
    assertSubset((actual as Dict)[key], value, `${label}.${key}`);
  }
}

async function assertExpectation(actual: Dict, expected: Dict, testName: string, context: TestContext): Promise<void> {
  if ("valid" in expected) {
    expect(actual.valid, `${testName}: valid`).toBe(expected.valid);
  }
  if (expected.error && typeof expected.error === "object") {
    expect((actual.error as Dict | undefined)?.code, `${testName}: error.code`).toBe((expected.error as Dict).code);
  }
  if (Array.isArray(expected.issues)) {
    assertDiagnostics(actual.issues as Dict[] | undefined, expected.issues as Dict[], `${testName}: issues`);
  }
  if (Array.isArray(expected.diagnostics)) {
    assertDiagnostics(actual.diagnostics as Dict[] | undefined, expected.diagnostics as Dict[], `${testName}: diagnostics`);
  }
  if ("value" in expected) {
    expect(actual.value, `${testName}: value`).toEqual(expected.value);
  }
  if (expected.frontmatter) {
    assertSubset(actual.frontmatter, expected.frontmatter, `${testName}: frontmatter`);
  }
  if (expected.frontmatter_contains) {
    assertSubset(actual.frontmatter, expected.frontmatter_contains, `${testName}: frontmatter_contains`);
  }
  if (Array.isArray(expected.frontmatter_not_contains)) {
    let checkedWritten = false;
    if (actual.path && context.root) {
      const fullPath = path.join(context.root, String(actual.path));
      if (fs.existsSync(fullPath)) {
        const raw = matter(fs.readFileSync(fullPath, "utf8")).data as Dict;
        for (const field of expected.frontmatter_not_contains) {
          expect(Object.prototype.hasOwnProperty.call(raw, String(field)), `${testName}: written frontmatter should not contain ${String(field)}`).toBe(false);
        }
        checkedWritten = true;
      }
    }
    if (!checkedWritten) {
      for (const field of expected.frontmatter_not_contains) {
        expect(Object.prototype.hasOwnProperty.call(actual.frontmatter ?? {}, String(field)), `${testName}: frontmatter should not contain ${String(field)}`).toBe(false);
      }
    }
  }
  if (Array.isArray(expected.frontmatter_changed)) {
    for (const field of expected.frontmatter_changed) {
      expect((actual.changed_fields as string[] | undefined ?? []).includes(String(field)), `${testName}: changed field ${String(field)}`).toBe(true);
    }
  }
  if (expected.types) {
    expect((actual.types as string[]).slice().sort(), `${testName}: types`).toEqual((expected.types as string[]).slice().sort());
  }
  if (expected.type) {
    assertSubset(actual.type, expected.type, `${testName}: type`);
  }
  if (expected.results) {
    const actualResults = actual.results as Dict[] | undefined;
    expect(actualResults, `${testName}: results`).toBeDefined();
    expect(actualResults?.length, `${testName}: results length`).toBe((expected.results as unknown[]).length);
    (expected.results as Dict[]).forEach((expectedResult, index) => {
      assertSubset(actualResults?.[index], expectedResult, `${testName}: results[${index}]`);
    });
  }
  if (expected.body_returned === false) {
    for (const result of actual.results as Dict[] | undefined ?? []) {
      expect(Object.prototype.hasOwnProperty.call(result, "body"), `${testName}: result body omitted`).toBe(false);
    }
  }
  if (expected.path) {
    expect(actual.path, `${testName}: path`).toBe(expected.path);
  }
  if (expected.resolved_links) {
    assertSubset(actual.resolved_links, expected.resolved_links, `${testName}: resolved_links`);
  }
  if (expected.counts) {
    assertSubset(actual.counts, expected.counts, `${testName}: counts`);
  }
  if (expected.registry) {
    assertSubset(actual.registry, expected.registry, `${testName}: registry`);
  }
  if (Array.isArray(expected.markdown_contains)) {
    for (const snippet of expected.markdown_contains) {
      expect(String(actual.markdown), `${testName}: markdown contains ${String(snippet)}`).toContain(String(snippet));
    }
  }
  if (expected.report_contains) {
    assertSubset(actual.report, expected.report_contains, `${testName}: report_contains`);
  }
  if (expected.detected_source_version) {
    expect(actual.detected_source_version, `${testName}: detected_source_version`).toBe(expected.detected_source_version);
  }
  if (expected.detected_generator) {
    expect(actual.detected_generator, `${testName}: detected_generator`).toBe(expected.detected_generator);
  }
  if (expected.has) {
    for (const pointer of expected.has as string[]) {
      expect(getPointer(actual.document, pointer), `${testName}: has ${pointer}`).not.toBeUndefined();
    }
  }
  if (expected.not_has) {
    for (const pointer of expected.not_has as string[]) {
      expect(getPointer(actual.document, pointer), `${testName}: not_has ${pointer}`).toBeUndefined();
    }
  }
}

function assertDiagnostics(actual: Dict[] | undefined, expected: Dict[], label: string): void {
  const diagnostics = actual ?? [];
  if (expected.length === 0) {
    expect(diagnostics, label).toHaveLength(0);
    return;
  }
  for (const expectedDiagnostic of expected) {
    const match = diagnostics.find((diagnostic) => {
      for (const [key, value] of Object.entries(expectedDiagnostic)) {
        if (diagnostic[key] !== value) return false;
      }
      return true;
    });
    expect(match, `${label}: expected ${JSON.stringify(expectedDiagnostic)} in ${JSON.stringify(diagnostics)}`).toBeDefined();
  }
}

function schemaDiagnosticCode(keyword: string): string {
  const normalized = keyword.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return `schema_${normalized}`;
}

const suites = discoverV03Suites();

if (suites.length === 0) {
  describe("v0.3 conformance", () => {
    it("finds the v0.3 conformance suite", () => {
      if (REQUIRE_V03_CONFORMANCE || fs.existsSync(path.join(V03_TESTS_DIR, "manifest.yaml"))) {
        throw new Error(`No v0.3 conformance files found under ${V03_TESTS_DIR}`);
      }
    });
  });
} else {
  describe("v0.3 conformance", () => {
    for (const { file, suite } of suites) {
      describe(`${suite.fixture_set}: ${suite.name} (${file})`, () => {
        for (const group of suite.groups ?? []) {
          describe(group.name, () => {
            let sharedContext: TestContext | undefined;
            const useSharedContext = hasReadAfterCreateDependency(group);
            afterAll(async () => {
              await sharedContext?.cleanup?.();
            });
            for (const testCase of group.tests) {
              it(testCase.name, async () => {
                const context = useSharedContext
                  ? sharedContext ??= await materializeSetup(group.setup)
                  : await materializeSetup(group.setup);
                try {
                  const actual = await executeOperation(context, testCase);
                  if (testCase.expect) {
                    await assertExpectation(actual, testCase.expect, testCase.name, context);
                  }
                } finally {
                  if (!useSharedContext) {
                    await context.cleanup?.();
                  }
                }
              });
            }
          });
        }
      });
    }
  });
}

function hasReadAfterCreateDependency(group: V03Group): boolean {
  const created = new Set<string>();
  for (const testCase of group.tests) {
    const input = testCase.input ?? {};
    if (testCase.operation === "read" && typeof input.path === "string" && created.has(input.path)) {
      return true;
    }
    if (testCase.operation === "create" && typeof input.path === "string") {
      created.add(input.path);
    }
  }
  return false;
}
