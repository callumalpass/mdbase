#!/usr/bin/env node

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { serializeFile } from "../frontmatter/parser.js";
import { SUPPORTED_SPEC_VERSION } from "../config/loader.js";
import { Collection } from "../operations/collection.js";

const DEFAULT_SPEC_VERSION = SUPPORTED_SPEC_VERSION;

const TASK_TYPE_DEF = `---
kind: mdbase.type
name: task
version: 1
description: Synthetic task type for profiling
schema:
  dialect: json-schema-2020-12
  value:
    $schema: "https://json-schema.org/draft/2020-12/schema"
    type: object
    additionalProperties: false
    required: [type, title]
    properties:
      type: { const: task }
      title: { type: string, minLength: 1 }
      status: { enum: [open, in-progress, done] }
      priority: { type: integer, minimum: 1, maximum: 5 }
      points: { type: integer, minimum: 0, maximum: 13 }
      project: { type: string }
      id: { type: string }
      tags:
        type: array
        items: { type: string }
collection:
  display:
    name_field: title
  links:
    project:
      target_type: project
      validate_exists: true
---

# Task
`;

const PROJECT_TYPE_DEF = `---
kind: mdbase.type
name: project
version: 1
description: Synthetic project type for profiling
schema:
  dialect: json-schema-2020-12
  value:
    $schema: "https://json-schema.org/draft/2020-12/schema"
    type: object
    additionalProperties: false
    required: [type, title]
    properties:
      type: { const: project }
      title: { type: string, minLength: 1 }
      id: { type: string }
collection:
  display:
    name_field: title
---

# Project
`;

const STATUS_CYCLE = ["open", "in-progress", "done"] as const;

interface ProfileArgs {
  files: number;
  projects: number;
  renameRefs: number;
  openIterations: number;
  readIterations: number;
  queryIterations: number;
  updateIterations: number;
  renameIterations: number;
  createIterations: number;
  deleteIterations: number;
  cacheRebuildIterations: number;
  seed: number;
  fixtureRoot?: string;
  keepFixture: boolean;
  output?: string;
}

interface ProfileConfig {
  files: number;
  projects: number;
  rename_refs: number;
  open_iterations: number;
  read_iterations: number;
  query_iterations: number;
  update_iterations: number;
  rename_iterations: number;
  create_iterations: number;
  delete_iterations: number;
  cache_rebuild_iterations: number;
  seed: number;
}

interface FixtureSummary {
  root: string;
  kept: boolean;
  task_files: number;
  project_files: number;
  rename_reference_files: number;
}

interface OperationSummary {
  name: string;
  iterations: number;
  total_ms: number;
  min_ms: number;
  mean_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  stddev_ms: number;
  ops_per_sec: number;
}

interface ProfileReport {
  tool: "mdbase-profiler";
  version: string;
  generated_at: string;
  total_runtime_ms: number;
  config: ProfileConfig;
  fixture: FixtureSummary;
  operations: OperationSummary[];
}

interface FixtureData {
  root: string;
  taskPaths: string[];
  renameSourceA: string;
  renameSourceB: string;
}

const DEFAULT_ARGS: ProfileArgs = {
  files: 2000,
  projects: 80,
  renameRefs: 100,
  openIterations: 20,
  readIterations: 1000,
  queryIterations: 250,
  updateIterations: 500,
  renameIterations: 50,
  createIterations: 300,
  deleteIterations: 300,
  cacheRebuildIterations: 5,
  seed: 42,
  keepFixture: false,
};

class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 1) return 0;
    return Math.floor(this.next() * maxExclusive);
  }
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  validateArgs(args);

  const fixtureRoot = determineFixtureRoot(args);
  if (await pathExists(fixtureRoot)) {
    throw new Error(`Fixture root already exists: ${fixtureRoot}`);
  }

  const fixture = await buildFixture(fixtureRoot, args);
  const runStart = process.hrtime.bigint();
  const generatedAt = new Date().toISOString();

  let collection: Collection | undefined;
  try {
    const operations: OperationSummary[] = [];

    operations.push(await profileOpen(fixture.root, args.openIterations));

    const opened = await Collection.open(fixture.root);
    if (opened.error || !opened.collection) {
      throw new Error(`Collection.open failed: ${JSON.stringify(opened.error ?? { code: "open_failed" })}`);
    }
    collection = opened.collection;

    operations.push(
      await profileRead(collection, fixture.taskPaths, args.readIterations, args.seed),
    );
    operations.push(await profileQueryBasic(collection, args.queryIterations));
    operations.push(await profileQueryFormula(collection, args.queryIterations));
    operations.push(
      await profileUpdate(
        collection,
        fixture.taskPaths,
        args.updateIterations,
        args.seed + 1,
      ),
    );
    operations.push(
      await profileRename(
        collection,
        fixture.renameSourceA,
        fixture.renameSourceB,
        args.renameIterations,
      ),
    );
    operations.push(await profileCreate(collection, args.createIterations));
    operations.push(await profileDelete(collection, args.deleteIterations));
    operations.push(await profileCacheRebuild(collection, args.cacheRebuildIterations));

    const report: ProfileReport = {
      tool: "mdbase-profiler",
      version: await resolveVersion(),
      generated_at: generatedAt,
      total_runtime_ms: elapsedMs(runStart),
      config: {
        files: args.files,
        projects: args.projects,
        rename_refs: args.renameRefs,
        open_iterations: args.openIterations,
        read_iterations: args.readIterations,
        query_iterations: args.queryIterations,
        update_iterations: args.updateIterations,
        rename_iterations: args.renameIterations,
        create_iterations: args.createIterations,
        delete_iterations: args.deleteIterations,
        cache_rebuild_iterations: args.cacheRebuildIterations,
        seed: args.seed,
      },
      fixture: {
        root: fixture.root,
        kept: args.keepFixture,
        task_files: args.files + 1,
        project_files: args.projects,
        rename_reference_files: args.renameRefs,
      },
      operations,
    };

    const reportJson = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) {
      const outputPath = path.resolve(args.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, reportJson, "utf-8");
    } else {
      process.stdout.write(reportJson);
    }
  } finally {
    if (collection) {
      await collection.close().catch(() => undefined);
    }
    if (!args.keepFixture) {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv: string[]): ProfileArgs {
  const args: ProfileArgs = { ...DEFAULT_ARGS };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }

    const [flag, inlineValue] = splitLongArg(token);
    const needsValue = flag !== "--keep-fixture";
    let value = inlineValue;

    if (needsValue && value === undefined) {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${flag}`);
      }
      value = argv[i];
    }

    switch (flag) {
      case "--files":
        args.files = parseNonNegativeInt(flag, value!);
        break;
      case "--projects":
        args.projects = parseNonNegativeInt(flag, value!);
        break;
      case "--rename-refs":
        args.renameRefs = parseNonNegativeInt(flag, value!);
        break;
      case "--open-iters":
        args.openIterations = parseNonNegativeInt(flag, value!);
        break;
      case "--read-iters":
        args.readIterations = parseNonNegativeInt(flag, value!);
        break;
      case "--query-iters":
        args.queryIterations = parseNonNegativeInt(flag, value!);
        break;
      case "--update-iters":
        args.updateIterations = parseNonNegativeInt(flag, value!);
        break;
      case "--rename-iters":
        args.renameIterations = parseNonNegativeInt(flag, value!);
        break;
      case "--create-iters":
        args.createIterations = parseNonNegativeInt(flag, value!);
        break;
      case "--delete-iters":
        args.deleteIterations = parseNonNegativeInt(flag, value!);
        break;
      case "--cache-rebuild-iters":
        args.cacheRebuildIterations = parseNonNegativeInt(flag, value!);
        break;
      case "--seed":
        args.seed = parseNonNegativeInt(flag, value!);
        break;
      case "--fixture-root":
        args.fixtureRoot = value;
        break;
      case "--output":
        args.output = value;
        break;
      case "--keep-fixture":
        args.keepFixture = inlineValue === undefined ? true : parseBooleanFlag(flag, inlineValue);
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

function splitLongArg(token: string): [string, string | undefined] {
  const index = token.indexOf("=");
  if (index === -1) {
    return [token, undefined];
  }
  return [token.slice(0, index), token.slice(index + 1)];
}

function parseNonNegativeInt(flag: string, rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
}

function parseBooleanFlag(flag: string, rawValue: string): boolean {
  const value = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${flag} must be a boolean (true/false)`);
}

function validateArgs(args: ProfileArgs): void {
  if (args.files === 0) {
    throw new Error("--files must be greater than 0");
  }
  if (args.projects === 0) {
    throw new Error("--projects must be greater than 0");
  }
}

function printHelp(): void {
  const help = `mdb-profile: repeatable performance profiling for core mdbase operations

Usage:
  mdb-profile [options]

Options:
  --files <n>                 Number of task files in fixture (default: 2000)
  --projects <n>              Number of project files in fixture (default: 80)
  --rename-refs <n>           Number of reference files for rename profiling (default: 100)
  --open-iters <n>            Iterations for Collection.open (default: 20)
  --read-iters <n>            Iterations for read operations (default: 1000)
  --query-iters <n>           Iterations for query operations (default: 250)
  --update-iters <n>          Iterations for update operations (default: 500)
  --rename-iters <n>          Iterations for rename operations (default: 50)
  --create-iters <n>          Iterations for create operations (default: 300)
  --delete-iters <n>          Iterations for delete operations (default: 300)
  --cache-rebuild-iters <n>   Iterations for cache rebuild operations (default: 5)
  --seed <n>                  RNG seed for deterministic path selection (default: 42)
  --fixture-root <path>       Optional fixture root path
  --keep-fixture[=bool]       Keep fixture data after profiling (default: false)
  --output <path>             Write JSON report to file (stdout if omitted)
  --help                      Show this help
`;
  process.stdout.write(help);
}

function determineFixtureRoot(args: ProfileArgs): string {
  if (args.fixtureRoot) {
    return path.resolve(args.fixtureRoot);
  }
  return path.join(
    os.tmpdir(),
    `mdbase-profile-${Date.now()}-${process.pid}`,
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveVersion(): Promise<string> {
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const packagePath = path.resolve(here, "../../package.json");
    const raw = await fs.readFile(packagePath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") {
      return parsed.version;
    }
  } catch {
    // Best-effort fallback.
  }

  return "0.0.0";
}

async function buildFixture(root: string, args: ProfileArgs): Promise<FixtureData> {
  await fs.mkdir(path.join(root, "_types"), { recursive: true });

  const config = `spec_version: "${DEFAULT_SPEC_VERSION}"
name: "Profiler"
settings:
  types_folder: "_types"
  validation: "error"
  explicit_type_keys: [type, types]
  id_field: id
  rename_update_refs: true
  exclude:
    - "_types"
`;
  await fs.writeFile(path.join(root, "mdbase.yaml"), config, "utf-8");
  await fs.writeFile(path.join(root, "_types/task.md"), TASK_TYPE_DEF, "utf-8");
  await fs.writeFile(path.join(root, "_types/project.md"), PROJECT_TYPE_DEF, "utf-8");

  const projectIds: string[] = [];
  for (let i = 0; i < args.projects; i++) {
    const projectId = `project-${pad(i, 4)}`;
    const projectPath = path.join(root, `projects/${projectId}.md`);
    await writeMarkdownFile(
      projectPath,
      {
        type: "project",
        id: projectId,
        title: `Project ${pad(i, 4)}`,
      },
      "Synthetic project for profiler.\n",
    );
    projectIds.push(projectId);
  }

  const taskPaths: string[] = [];
  for (let i = 0; i < args.files; i++) {
    const taskId = pad(i, 6);
    const relativePath = `tasks/task-${taskId}.md`;
    const project = projectIds[i % projectIds.length];
    await writeMarkdownFile(
      path.join(root, relativePath),
      {
        type: "task",
        id: `task-${taskId}`,
        title: `Task ${taskId}`,
        status: STATUS_CYCLE[i % STATUS_CYCLE.length],
        priority: (i % 5) + 1,
        points: i % 13,
        project: `[[${project}]]`,
        tags: [`team-${i % 10}`, "profile"],
      },
      `# Task ${taskId}\n\nRelated project: [[${project}]]\n\nSynthetic profiling content.\n`,
    );
    taskPaths.push(relativePath);
  }

  const renameSourceA = "tasks/rename-target-a.md";
  const renameSourceB = "tasks/rename-target-b.md";
  await writeMarkdownFile(
    path.join(root, renameSourceA),
    {
      type: "task",
      id: "rename-target",
      title: "Rename Target",
      status: "open",
      priority: 3,
    },
    "This file is renamed repeatedly during profiling.\n",
  );
  taskPaths.push(renameSourceA);

  for (let i = 0; i < args.renameRefs; i++) {
    const refPath = path.join(root, `refs/ref-${pad(i, 4)}.md`);
    await writePlainMarkdownFile(
      refPath,
      `Reference ${pad(i, 4)}: [[rename-target-a]] and [markdown](../tasks/rename-target-a.md)\n`,
    );
  }

  return {
    root,
    taskPaths,
    renameSourceA,
    renameSourceB,
  };
}

async function writeMarkdownFile(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = serializeFile(frontmatter, body);
  await fs.writeFile(filePath, content, "utf-8");
}

async function writePlainMarkdownFile(filePath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body, "utf-8");
}

async function runTimed(
  name: string,
  iterations: number,
  operation: (iteration: number) => Promise<void>,
): Promise<OperationSummary> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = process.hrtime.bigint();
    try {
      await operation(i);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${name} iteration ${i} failed: ${message}`);
    }
    samples.push(elapsedMs(started));
  }
  return summarize(name, samples);
}

function summarize(name: string, samples: number[]): OperationSummary {
  if (samples.length === 0) {
    return {
      name,
      iterations: 0,
      total_ms: 0,
      min_ms: 0,
      mean_ms: 0,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      max_ms: 0,
      stddev_ms: 0,
      ops_per_sec: 0,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  const meanMs = totalMs / sorted.length;
  const variance = sorted
    .map((value) => {
      const delta = value - meanMs;
      return delta * delta;
    })
    .reduce((sum, value) => sum + value, 0) / sorted.length;
  const stddevMs = Math.sqrt(variance);

  return {
    name,
    iterations: sorted.length,
    total_ms: totalMs,
    min_ms: sorted[0],
    mean_ms: meanMs,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    max_ms: sorted[sorted.length - 1],
    stddev_ms: stddevMs,
    ops_per_sec: meanMs > 0 ? 1000 / meanMs : 0,
  };
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  if (sortedSamples.length === 1) {
    return sortedSamples[0];
  }
  const clamped = Math.min(Math.max(percentileValue, 0), 1);
  const position = clamped * (sortedSamples.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedSamples[lower];
  const weight = position - lower;
  return (sortedSamples[lower] * (1 - weight)) + (sortedSamples[upper] * weight);
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function ensureOperationSuccess(result: Record<string, unknown>): void {
  if ("error" in result && result.error !== undefined && result.error !== null) {
    throw new Error(JSON.stringify(result.error));
  }
  if ("success" in result && result.success === false) {
    const detail = "error" in result && result.error !== undefined
      ? JSON.stringify(result.error)
      : "success=false";
    throw new Error(detail);
  }
}

async function profileOpen(root: string, iterations: number): Promise<OperationSummary> {
  return runTimed("open", iterations, async () => {
    const opened = await Collection.open(root);
    if (opened.error || !opened.collection) {
      throw new Error(JSON.stringify(opened.error ?? { code: "open_failed" }));
    }
    await opened.collection.close();
  });
}

async function profileRead(
  collection: Collection,
  taskPaths: string[],
  iterations: number,
  seed: number,
): Promise<OperationSummary> {
  const rng = new SeededRng(seed);
  const picks = Array.from({ length: iterations }, () => rng.nextInt(taskPaths.length));
  return runTimed("read", iterations, async (iteration) => {
    const pathPick = taskPaths[picks[iteration]];
    const result = await collection.read(pathPick);
    ensureOperationSuccess(result as unknown as Record<string, unknown>);
  });
}

async function profileQueryBasic(
  collection: Collection,
  iterations: number,
): Promise<OperationSummary> {
  const query = {
    types: ["task"],
    where: "priority >= 3 && status != \"done\"",
    order_by: [
      { field: "priority", direction: "desc" as const },
      { field: "points", direction: "asc" as const },
    ],
    limit: 120,
  };

  return runTimed("query_basic", iterations, async () => {
    const result = await collection.query(query);
    ensureOperationSuccess(result as unknown as Record<string, unknown>);
  });
}

async function profileQueryFormula(
  collection: Collection,
  iterations: number,
): Promise<OperationSummary> {
  const query = {
    types: ["task"],
    formulas: {
      weighted: "priority * points",
      is_open: "status == \"open\"",
    },
    where: "formula.weighted >= 8 && formula.is_open",
    limit: 80,
  };

  return runTimed("query_formula", iterations, async () => {
    const result = await collection.query(query);
    ensureOperationSuccess(result as unknown as Record<string, unknown>);
  });
}

async function profileUpdate(
  collection: Collection,
  taskPaths: string[],
  iterations: number,
  seed: number,
): Promise<OperationSummary> {
  const rng = new SeededRng(seed);
  const picks = Array.from({ length: iterations }, () => rng.nextInt(taskPaths.length));
  return runTimed("update", iterations, async (iteration) => {
    const pathPick = taskPaths[picks[iteration]];
    const status = STATUS_CYCLE[iteration % STATUS_CYCLE.length];
    const result = await collection.update({
      path: pathPick,
      fields: {
        status,
        points: iteration % 13,
      },
    });
    ensureOperationSuccess(result as unknown as Record<string, unknown>);
  });
}

async function profileRename(
  collection: Collection,
  sourceA: string,
  sourceB: string,
  iterations: number,
): Promise<OperationSummary> {
  let usingA = true;
  return runTimed("rename_update_refs", iterations, async () => {
    const [from, to] = usingA ? [sourceA, sourceB] : [sourceB, sourceA];
    const result = await collection.rename({
      from,
      to,
      update_refs: true,
    });
    ensureOperationSuccess(result as Record<string, unknown>);
    usingA = !usingA;
  });
}

async function profileCreate(
  collection: Collection,
  iterations: number,
): Promise<OperationSummary> {
  const createPaths = Array.from(
    { length: iterations },
    (_, i) => `scratch/create-${pad(i, 6)}.md`,
  );

  return runTimed("create", iterations, async (iteration) => {
    const result = await collection.create({
      path: createPaths[iteration],
      type: "task",
      frontmatter: {
        title: `Created Task ${pad(iteration, 6)}`,
        status: STATUS_CYCLE[iteration % STATUS_CYCLE.length],
        priority: (iteration % 5) + 1,
        points: iteration % 13,
      },
    });
    ensureOperationSuccess(result as unknown as Record<string, unknown>);
  });
}

async function profileDelete(
  collection: Collection,
  iterations: number,
): Promise<OperationSummary> {
  const deletePaths = Array.from(
    { length: iterations },
    (_, i) => `scratch/delete-${pad(i, 6)}.md`,
  );

  for (let i = 0; i < deletePaths.length; i++) {
    const created = await collection.create({
      path: deletePaths[i],
      type: "task",
      frontmatter: {
        title: `Delete Task ${pad(i, 6)}`,
        status: "open",
        priority: 3,
        points: 1,
      },
    });
    ensureOperationSuccess(created as unknown as Record<string, unknown>);
  }

  return runTimed("delete", iterations, async (iteration) => {
    const result = await collection.delete(deletePaths[iteration]);
    ensureOperationSuccess(result as unknown as Record<string, unknown>);
  });
}

async function profileCacheRebuild(
  collection: Collection,
  iterations: number,
): Promise<OperationSummary> {
  return runTimed("cache_rebuild", iterations, async () => {
    const result = await collection.cacheRebuild();
    ensureOperationSuccess(result as unknown as Record<string, unknown>);
  });
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

await main();
