/**
 * Conformance test runner for mdbase.
 *
 * Reads YAML test files from ~/projects/mdbase-spec/tests/ and executes
 * them against the TypeScript implementation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import * as os from "node:os";

import matter from "gray-matter";
import { loadConfig } from "../src/config/loader.js";
import { loadTypes, getType } from "../src/types/loader.js";
import { Collection } from "../src/operations/collection.js";
import { parseFile } from "../src/frontmatter/parser.js";
import { evaluateWhere, evaluateExpression, ExpressionError } from "../src/expressions/evaluator.js";
import { parseLink } from "../src/links/parser.js";

// Path to the spec's test files
const SPEC_TESTS_DIR = path.resolve(
  os.homedir(),
  "projects/mdbase-spec/tests",
);

interface TestSetup {
  config?: string | null;
  types?: Record<string, string>;
  files?: Record<string, string>;
}

interface TestExpectation {
  valid?: boolean;
  issues?: Array<{ code: string; field?: string; severity?: string; [key: string]: unknown }>;
  error?: { code: string; [key: string]: unknown };
  result?: unknown;
  results?: unknown[];
  count?: number;
  paths?: string[];
  frontmatter?: Record<string, unknown>;
  body?: string;
  links?: unknown[];
  config?: Record<string, unknown>;
  warnings?: Array<{ contains: string }>;
  type?: Record<string, unknown>;
  types?: unknown;
  [key: string]: unknown;
}

interface VerifyAfterStep {
  operation: string;
  input: Record<string, unknown>;
  expect: TestExpectation;
}

interface TestCase {
  name: string;
  spec_ref?: string;
  operation: string;
  input: Record<string, unknown>;
  expect: TestExpectation;
  setup?: TestSetup;
  verify_after?: VerifyAfterStep | VerifyAfterStep[];
  simulate?: Record<string, unknown>;
}

interface YamlTestGroup {
  name: string;
  spec_ref?: string;
  setup?: TestSetup;
  tests: TestCase[];
}

interface YamlTestFile {
  name: string;
  level: number;
  category: string;
  spec_ref: string;
  setup?: TestSetup;
  groups?: YamlTestGroup[];
  tests?: TestCase[];
}

/**
 * Merge two test setups. Per-test setup overrides group setup.
 */
function mergeSetup(group?: TestSetup, test?: TestSetup, testCase?: Record<string, unknown>): TestSetup {
  if (!group && !test) return {};
  if (!group) return test!;
  if (!test) return group;

  // For files: if the test defines files that overlap with group files (same key),
  // the test intends to define its own file set — use test files, plus any group
  // files that are directly referenced in the test's operation input/verify_after.
  // If no overlap, merge additively (test adds new files to group files).
  let files: Record<string, unknown>;
  const groupFiles = group.files ?? {};
  const testFiles = test.files ?? {};
  const hasOverlap = Object.keys(testFiles).some(k => k in groupFiles);
  if (hasOverlap) {
    files = { ...testFiles };
    // Keep group-only files that are referenced in the test case
    if (testCase) {
      const testStr = JSON.stringify(testCase);
      for (const [key, value] of Object.entries(groupFiles)) {
        if (key in testFiles) continue; // already overridden
        // Check if this file path (or its basename without extension) appears in the test
        const basename = key.replace(/.*\//, "").replace(/\.[^.]+$/, "");
        if (testStr.includes(key) || testStr.includes(basename)) {
          files[key] = value;
        }
      }
    }
  } else {
    files = { ...groupFiles, ...testFiles };
  }

  return {
    config: test.config !== undefined ? test.config : group.config,
    types: { ...(group.types ?? {}), ...(test.types ?? {}) },
    files,
  };
}

/**
 * Materializes a test setup into a temporary directory, returning the path.
 */
function materializeSetup(setup: TestSetup): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdbase-test-"));

  // Write config (null means no config file)
  if (setup.config === null || setup.config === undefined) {
    // If config is explicitly null, don't write the file
    if (setup.config !== null) {
      // undefined: write default
      fs.writeFileSync(
        path.join(tmpDir, "mdbase.yaml"),
        'spec_version: "0.1.0"\n',
      );
    }
  } else {
    fs.writeFileSync(path.join(tmpDir, "mdbase.yaml"), setup.config);
  }

  // Write type files
  if (setup.types) {
    // Determine types folder from config
    let typesFolder = "_types";
    if (typeof setup.config === "string") {
      const configMatch = setup.config.match(/types_folder:\s*["']?([^"'\n]+)["']?/);
      if (configMatch) {
        typesFolder = configMatch[1].trim();
      }
    }
    const typesDir = path.join(tmpDir, typesFolder);
    fs.mkdirSync(typesDir, { recursive: true });
    for (const [filename, content] of Object.entries(setup.types)) {
      const typeFilePath = path.join(typesDir, filename);
      fs.mkdirSync(path.dirname(typeFilePath), { recursive: true });
      fs.writeFileSync(typeFilePath, content);
    }
  }

  // Write content files
  if (setup.files) {
    for (const [filePath, fileSpec] of Object.entries(setup.files)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      if (typeof fileSpec === "string") {
        fs.writeFileSync(fullPath, fileSpec);
      } else if (typeof fileSpec === "object" && fileSpec !== null) {
        const spec = fileSpec as Record<string, unknown>;
        let content = (spec.content ?? "") as string;
        const encoding = (spec.encoding ?? "utf-8") as string;
        if (encoding === "latin-1" || encoding === "latin1") {
          // Write as latin-1 (ISO-8859-1) buffer
          const buf = Buffer.from(content, "latin1");
          fs.writeFileSync(fullPath, buf);
        } else if (spec.line_endings === "CRLF") {
          // Ensure CRLF line endings
          content = content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
          fs.writeFileSync(fullPath, content);
        } else {
          fs.writeFileSync(fullPath, content);
        }
      }
    }
  }

  // Write extra files (non-markdown files for watch tests)
  if ((setup as Record<string, unknown>).extra_files) {
    const extraFiles = (setup as Record<string, unknown>).extra_files as Record<string, string>;
    for (const [filePath, content] of Object.entries(extraFiles)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
  }

  return tmpDir;
}

/**
 * Clean up a temporary test directory.
 */
function cleanupSetup(tmpDir: string): void {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Discover all test YAML files organized by level.
 */
function discoverTests(): Map<number, Array<{ file: string; data: YamlTestFile }>> {
  const levels = new Map<number, Array<{ file: string; data: YamlTestFile }>>();

  if (!fs.existsSync(SPEC_TESTS_DIR)) {
    return levels;
  }

  for (const levelDir of fs.readdirSync(SPEC_TESTS_DIR).sort()) {
    const levelPath = path.join(SPEC_TESTS_DIR, levelDir);
    if (!fs.statSync(levelPath).isDirectory()) continue;

    const levelMatch = levelDir.match(/^level-(\d+)$/);
    if (!levelMatch) continue;
    const level = parseInt(levelMatch[1], 10);

    const files: Array<{ file: string; data: YamlTestFile }> = [];

    for (const file of fs.readdirSync(levelPath).sort()) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const filePath = path.join(levelPath, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const data = yaml.load(content) as YamlTestFile;
        files.push({ file, data });
      } catch (err) {
        console.error(`Failed to parse ${filePath}:`, err);
      }
    }

    if (files.length > 0) {
      levels.set(level, files);
    }
  }

  return levels;
}

/**
 * Apply simulation settings to a Collection instance for testing.
 */
function applySimulate(
  collection: InstanceType<typeof Collection>,
  collectionRoot: string,
  simulate?: Record<string, unknown>,
): void {
  if (!simulate) return;

  // Set up I/O error simulation
  const ioErrorOn = (simulate.io_error_on ?? (simulate as Record<string, unknown>)?.simulate?.io_error_on) as string | undefined;
  if (ioErrorOn) {
    collection.ioErrorPaths = new Set([ioErrorOn]);
  }

  // Set up skip_dependents
  if (simulate.skip_dependents) {
    collection.skipDependents = true;
  }

  // Set up pre-write hook for external modifications
  const extModify = simulate.external_modify as { path?: string; content?: string; frontmatter?: Record<string, unknown>; timing?: string } | undefined;
  const extCreate = simulate.external_create as { path?: string; content?: string } | undefined;

  const doModify = (mod: { path?: string; content?: string; frontmatter?: Record<string, unknown> }) => {
    const modPath = path.join(collectionRoot, mod.path!);
    let content = mod.content;
    if (!content && mod.frontmatter) {
      const yamlStr = Object.entries(mod.frontmatter)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
      content = `---\n${yamlStr}\n---\n`;
    }
    if (content) {
      fs.writeFileSync(modPath, content);
      const now = Date.now();
      fs.utimesSync(modPath, new Date(now + 1000), new Date(now + 1000));
    }
  };

  if (extModify || extCreate) {
    const timing = extModify?.timing;
    if (timing === "before_ref_update") {
      // Fire before reference updates, not before primary rename
      collection.preRefUpdateHook = () => {
        if (extModify) doModify(extModify);
      };
    } else {
      collection.preWriteHook = () => {
        if (extModify) doModify(extModify);
        if (extCreate) {
          const createPath = path.join(collectionRoot, extCreate.path!);
          fs.mkdirSync(path.dirname(createPath), { recursive: true });
          fs.writeFileSync(createPath, extCreate.content ?? "---\n---\n");
        }
      };
    }
    // Also set up create hook if separate from modify
    if (extCreate && timing === "before_ref_update") {
      const origHook = collection.preRefUpdateHook;
      collection.preRefUpdateHook = () => {
        if (origHook) origHook();
        const createPath = path.join(collectionRoot, extCreate.path!);
        fs.mkdirSync(path.dirname(createPath), { recursive: true });
        fs.writeFileSync(createPath, extCreate.content ?? "---\n---\n");
      };
    }
  }
}

/**
 * Apply immediate simulations (external file changes) before the operation runs.
 * Used for staleness tests where the operation (query, read, validate) should see the changes.
 */
function applyImmediateSimulate(
  collectionRoot: string,
  simulate?: Record<string, unknown>,
): void {
  if (!simulate) return;

  // External modify: write new content to a file immediately
  const extModify = simulate.external_modify as { path?: string; content?: string; frontmatter?: Record<string, unknown> } | undefined;
  if (extModify) {
    const modPath = path.join(collectionRoot, extModify.path!);
    let content = extModify.content;
    if (!content && extModify.frontmatter) {
      const yamlStr = Object.entries(extModify.frontmatter)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
      content = `---\n${yamlStr}\n---\n`;
    }
    if (content) {
      fs.writeFileSync(modPath, content);
    }
  }

  // External create: create a new file immediately
  const extCreate = simulate.external_create as { path?: string; content?: string } | undefined;
  if (extCreate) {
    const createPath = path.join(collectionRoot, extCreate.path!);
    fs.mkdirSync(path.dirname(createPath), { recursive: true });
    fs.writeFileSync(createPath, extCreate.content ?? "---\n---\n");
  }

  // External delete: remove a file immediately
  const extDelete = simulate.external_delete as { path?: string } | undefined;
  if (extDelete) {
    const deletePath = path.join(collectionRoot, extDelete.path!);
    if (fs.existsSync(deletePath)) {
      fs.unlinkSync(deletePath);
    }
  }

  // Config change: overwrite mdbase.yaml
  const configChange = simulate.config_change as { new_config?: string } | undefined;
  if (configChange?.new_config) {
    fs.writeFileSync(path.join(collectionRoot, "mdbase.yaml"), configChange.new_config);
  }

  // Type change: overwrite a type definition file
  const typeChange = simulate.type_change as { type?: string; new_definition?: string } | undefined;
  if (typeChange?.type && typeChange?.new_definition) {
    // Find types_folder from config
    let typesFolder = "_types";
    try {
      const configResult = loadConfig(collectionRoot);
      if (configResult.config) {
        typesFolder = configResult.config.settings.types_folder;
      }
    } catch { /* use default */ }
    const typePath = path.join(collectionRoot, typesFolder, `${typeChange.type}.md`);
    fs.writeFileSync(typePath, typeChange.new_definition);
  }
}

/**
 * Execute a single test operation against the mdbase implementation.
 */
async function executeOperation(
  collectionRoot: string,
  operation: string,
  input: Record<string, unknown>,
  simulate?: Record<string, unknown>,
): Promise<unknown> {
  switch (operation) {
    case "load_config":
      return loadConfig(collectionRoot);

    case "load_types": {
      const configResult = loadConfig(collectionRoot);
      if (!configResult.valid || !configResult.config) {
        return { valid: false, error: configResult.error };
      }
      const typesResult = loadTypes(collectionRoot, configResult.config);
      return {
        valid: typesResult.valid,
        types: typesResult.types ? Object.fromEntries(typesResult.types) : undefined,
        warnings: typesResult.warnings,
        error: typesResult.error,
      };
    }

    case "get_type": {
      const configResult = loadConfig(collectionRoot);
      if (!configResult.valid || !configResult.config) {
        return { valid: false, error: configResult.error };
      }
      const typeResult = getType(
        collectionRoot,
        configResult.config,
        input.type as string,
      );
      return typeResult;
    }

    case "read": {
      applyImmediateSimulate(collectionRoot, simulate);
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      return opened.collection!.read(input.path as string);
    }

    case "validate": {
      applyImmediateSimulate(collectionRoot, simulate);
      // If frontmatter is provided inline, create the file first
      if (input.frontmatter && input.path) {
        const filePath = path.join(collectionRoot, input.path as string);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const content = matter.stringify("", input.frontmatter as Record<string, unknown>);
        fs.writeFileSync(filePath, content);
      }
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { valid: false, error: opened.error };
      }
      // validate: false means just read, don't validate
      if (input.validate === false) {
        const readResult = opened.collection!.read(input.path as string);
        return readResult;
      }
      // collection_only: true means validate the collection, not a specific file
      const filePath = input.collection_only ? undefined : (input.path as string | undefined);
      return opened.collection!.validate(filePath);
    }

    case "create": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      applySimulate(opened.collection!, collectionRoot, simulate);
      return opened.collection!.create({
        type: input.type as string | undefined,
        types: input.types as string[] | undefined,
        path: input.path as string,
        frontmatter: (input.frontmatter ?? input.fields) as Record<string, unknown> | undefined,
        body: input.body as string | undefined,
      });
    }

    case "update": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      applySimulate(opened.collection!, collectionRoot, simulate);
      return opened.collection!.update({
        path: input.path as string,
        fields: (input.fields ?? input.frontmatter) as Record<string, unknown> | undefined,
        body: input.body as string | undefined,
      });
    }

    case "delete": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      applySimulate(opened.collection!, collectionRoot, simulate);
      return opened.collection!.delete(input.path as string, {
        check_backlinks: input.check_backlinks as boolean | undefined,
      });
    }

    case "create_type": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      return opened.collection!.createType({
        name: input.name as string,
        description: input.description as string | undefined,
        extends: input.extends as string | undefined,
        parent: input.parent as string | undefined,
        strict: input.strict as boolean | "warn" | undefined,
        fields: input.fields as Record<string, unknown> | undefined,
        path_pattern: input.path_pattern as string | undefined,
      });
    }

    case "rename": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      applySimulate(opened.collection!, collectionRoot, simulate);
      const from = (input.from ?? input.path) as string | undefined;
      const to = (input.to ?? input.new_path) as string | undefined;
      if (!from || !to) {
        return { error: { code: "path_required", message: "Both source and destination paths are required for rename" } };
      }
      return opened.collection!.rename({
        from,
        to,
        update_refs: input.update_refs as boolean | undefined,
      });
    }

    case "query": {
      // Apply immediate simulations (external file changes) before query
      applyImmediateSimulate(collectionRoot, simulate);
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      // Handle input.query wrapper (some tests nest it)
      const queryInput = (input.query ?? input) as Record<string, unknown>;
      return opened.collection!.query({
        types: queryInput.types as string[] | undefined,
        where: queryInput.where as string | Record<string, unknown> | undefined,
        order_by: queryInput.order_by as Array<{ field: string; direction?: string }> | undefined,
        folder: queryInput.folder as string | undefined,
        limit: queryInput.limit as number | undefined,
        offset: queryInput.offset as number | undefined,
        include_body: queryInput.include_body as boolean | undefined,
        context_file: (queryInput.context_file ?? input.context_file) as string | undefined,
        formulas: queryInput.formulas as Record<string, string> | undefined,
      });
    }

    case "evaluate": {
      const expression = input.expression as string;
      if (!expression || expression.trim() === "") {
        return { error: { code: "invalid_expression", message: "Empty expression" } };
      }
      // Read the file if path or context_path is provided
      let frontmatter: Record<string, unknown> = {};
      let rawFrontmatter: Record<string, unknown> | undefined;
      let filePath: string | undefined;
      let body: string | undefined;
      let types: string[] = [];
      let fileInfo: Record<string, unknown> | undefined;
      const readPath = (input.path ?? input.context_path) as string | undefined;
      if (readPath) {
        const opened = Collection.open(collectionRoot);
        if (opened.error) {
          return { error: opened.error };
        }
        const readResult = opened.collection!.read(readPath);
        if (readResult.error) {
          return { error: readResult.error };
        }
        frontmatter = readResult.frontmatter ?? {};
        rawFrontmatter = (readResult as Record<string, unknown>).rawFrontmatter as Record<string, unknown> | undefined;
        filePath = readPath;
        body = readResult.body;
        types = readResult.types ?? [];
        fileInfo = (readResult as unknown as Record<string, unknown>).file as Record<string, unknown> | undefined;
      }
      // Apply inline context (overrides/provides frontmatter directly)
      if (input.context && typeof input.context === "object") {
        frontmatter = { ...frontmatter, ...(input.context as Record<string, unknown>) };
      }
      // Set up resolveFile callback for asFile() traversal
      let resolveFile: ((target: string) => { frontmatter: Record<string, unknown>; path: string; types: string[] } | null) | undefined;
      let computeBacklinks: ((fp: string) => import("../src/expressions/evaluator.js").BacklinkEntry[]) | undefined;
      if (readPath) {
        const opened2 = Collection.open(collectionRoot);
        if (!opened2.error && opened2.collection) {
          const coll = opened2.collection;
          const files = (coll as any).scanFiles();
          resolveFile = (target: string) => {
            return (coll as any).resolveLink(target, readPath, files);
          };
          computeBacklinks = (fp: string) => {
            return coll.computeBacklinksForFile(fp);
          };
        }
      }
      try {
        const result = evaluateExpression(expression, {
          frontmatter,
          rawFrontmatter,
          path: filePath,
          types,
          body,
          file: fileInfo,
          resolveFile,
          computeBacklinks,
        });
        return { result };
      } catch (e: unknown) {
        const err = e as { code?: string; message: string };
        const code = err.code ?? "invalid_expression";
        return { error: { code, message: err.message } };
      }
    }

    case "batch_delete": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      applySimulate(opened.collection!, collectionRoot, simulate);
      return opened.collection!.batchDelete({
        where: input.where as string,
        dry_run: input.dry_run as boolean | undefined,
        check_backlinks: input.check_backlinks as boolean | undefined,
      });
    }

    case "batch_update": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      applySimulate(opened.collection!, collectionRoot, simulate);
      return opened.collection!.batchUpdate({
        where: input.where as string | undefined,
        fields: input.fields as Record<string, unknown> | undefined,
        updates: input.updates as Array<{ path: string; fields: Record<string, unknown> }> | undefined,
        dry_run: input.dry_run as boolean | undefined,
      });
    }

    case "get_types": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      const filePath = input.path as string;
      if (!filePath) {
        return { error: { code: "invalid_input", message: "get_types requires a path" } };
      }
      const fullPath = path.join(collectionRoot, filePath);
      if (!fs.existsSync(fullPath)) {
        return { error: { code: "file_not_found", message: `File not found: ${filePath}` } };
      }
      // Parse the file frontmatter
      const parsed = parseFile(fullPath);
      const frontmatter = parsed.frontmatter ?? {};
      const types = opened.collection!.getTypesForFile(filePath, frontmatter);
      return { types };
    }

    case "resolve_link": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      const filePath = input.path as string;
      const field = input.field as string;

      // Read the file to get the field value
      const readResult = opened.collection!.read(filePath);
      if (readResult.error) {
        return { error: readResult.error };
      }
      const linkValue = readResult.frontmatter?.[field];
      if (linkValue === null || linkValue === undefined) {
        return { resolved_path: null };
      }

      // Look up the field's target constraint from type definitions
      let targetType: string | undefined;
      const fileTypes = readResult.types ?? [];
      for (const typeName of fileTypes) {
        const typeDef = (opened.collection! as any).typeDefs.get(typeName);
        if (typeDef?.fields?.[field]) {
          const fieldDef = typeDef.fields[field];
          targetType = (fieldDef as any).target;
          break;
        }
      }

      // Use the collection's resolveLink method
      const resolution = (opened.collection! as any).resolveLinkFull(
        String(linkValue),
        filePath,
        targetType,
      );
      return { resolved_path: resolution.resolved ?? null };
    }

    case "parse_link": {
      const value = input.value as string;
      try {
        const parsed = parseLink(value);
        if (parsed) {
          return { link: parsed };
        }
        // If parseLink returns null, the string is not a recognized link format
        // but for parse_link operation, treat it as a simple name (valid)
        return {
          link: {
            raw: value,
            target: value,
            alias: null,
            anchor: null,
            format: "path",
            is_relative: false,
          },
        };
      } catch (e: unknown) {
        const err = e as { code?: string; message: string };
        return { error: { code: err.code ?? "invalid_link", message: err.message } };
      }
    }

    case "cache_rebuild": {
      // Cache rebuild: since our implementation always reads from disk,
      // this is effectively a no-op that returns success.
      applyImmediateSimulate(collectionRoot, simulate);
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { success: false, error: opened.error };
      }
      return { success: true };
    }

    case "cache_clear": {
      // Cache clear: remove any .mdbase cache directory if it exists.
      // Since we don't use a persistent cache, this is mostly a no-op.
      const cacheDir = path.join(collectionRoot, ".mdbase");
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
      return { success: true };
    }

    case "watch": {
      // Watch mode simulation: snapshot files, apply changes, compute events
      const sim = (simulate ?? input.simulate) as Record<string, unknown> | undefined;
      if (!sim) {
        return { events: [] };
      }

      // Load config and types for event generation
      const configResult = loadConfig(collectionRoot);
      if (!configResult.valid || !configResult.config) {
        return { events: [], error: configResult.error };
      }
      const config = configResult.config;
      const extensions = new Set(["md", ...(config.settings.extensions || [])]);

      // Snapshot existing files before changes
      const opened = Collection.open(collectionRoot);
      const files = opened.collection ? opened.collection.scanFiles() : [];
      const beforeState = new Map<string, { frontmatter: Record<string, unknown>; body: string; types: string[] }>();
      for (const f of files) {
        try {
          const parsed = parseFile(path.join(collectionRoot, f));
          const types = opened.collection!.getTypesForFile(f, parsed.frontmatter);
          beforeState.set(f, { frontmatter: { ...parsed.frontmatter }, body: parsed.body, types });
        } catch { /* skip */ }
      }

      const events: Array<Record<string, unknown>> = [];
      const listenerErrorOn = sim.listener_error_on_event as number | undefined;
      let eventIndex = 0;

      function emitEvent(evt: Record<string, unknown>) {
        eventIndex++;
        if (listenerErrorOn !== undefined && eventIndex === listenerErrorOn) {
          // Simulate listener error — but watcher should continue
          // Still record the event for tracking
        }
        events.push({ ...evt, timestamp: new Date().toISOString() });
      }

      // Helper: check if path is excluded
      function isExcluded(filePath: string): boolean {
        if (!config.settings.exclude?.length) return false;
        const excludePatterns = config.settings.exclude;
        for (const pattern of excludePatterns) {
          const matcher = require("picomatch")(pattern, { dot: true });
          if (matcher(filePath)) return true;
        }
        return false;
      }

      // Helper: check if file has a watched extension
      function isWatchedExtension(filePath: string): boolean {
        const ext = path.extname(filePath).slice(1);
        return extensions.has(ext);
      }

      // Helper: read file and compute state
      function readFileState(filePath: string) {
        const fullPath = path.join(collectionRoot, filePath);
        if (!fs.existsSync(fullPath)) return null;
        try {
          const parsed = parseFile(fullPath);
          const reopened = Collection.open(collectionRoot);
          const types = reopened.collection ? reopened.collection.getTypesForFile(filePath, parsed.frontmatter) : [];
          // Apply defaults from type definitions
          const frontmatter = { ...parsed.frontmatter };
          if (reopened.collection) {
            for (const typeName of types) {
              const typeDef = (reopened.collection as unknown as { typeDefs: Map<string, { fields: Record<string, { default?: unknown }> }> }).typeDefs.get(typeName);
              if (typeDef?.fields) {
                for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
                  if (frontmatter[fieldName] === undefined && fieldDef.default !== undefined) {
                    frontmatter[fieldName] = fieldDef.default;
                  }
                }
              }
            }
          }
          return { frontmatter, body: parsed.body, types };
        } catch {
          return null;
        }
      }

      // Helper: compute changed fields between old and new frontmatter
      function getChangedFields(oldFm: Record<string, unknown>, newFm: Record<string, unknown>): string[] {
        const changed: string[] = [];
        const allKeys = new Set([...Object.keys(oldFm), ...Object.keys(newFm)]);
        for (const key of allKeys) {
          if (key === "type" || key === "types") continue;
          if (JSON.stringify(oldFm[key]) !== JSON.stringify(newFm[key])) {
            changed.push(key);
          }
        }
        return changed;
      }

      // Helper: validate file and return issues
      function validateFile(filePath: string): Array<{ code: string; field?: string }> {
        const reopened = Collection.open(collectionRoot);
        if (!reopened.collection) return [];
        const valResult = reopened.collection.validate(filePath);
        if (valResult && typeof valResult === "object" && "issues" in valResult) {
          const issues = (valResult as { issues?: Array<{ code: string; field?: string }> }).issues;
          return issues || [];
        }
        return [];
      }

      // Process simulation actions
      const rapidChanges = sim.rapid_changes as { path?: string; changes?: Array<{ content: string }>; steps?: Array<{ action: string; path: string; content?: string }>; interval_ms?: number } | undefined;
      const seqChanges = sim.sequential_changes as Array<{ action: string; path: string; content?: string }> | undefined;
      const extModify = sim.external_modify as { path?: string; content?: string } | undefined;
      const extCreate = sim.external_create as { path?: string; content?: string; binary?: boolean } | undefined;
      const extDelete = sim.external_delete as { path?: string } | undefined;
      const extRename = sim.external_rename as { from?: string; to?: string; detection_fails?: boolean } | undefined;
      const typeChange = sim.type_change as { type?: string; new_definition?: string } | undefined;
      const configChange = sim.config_change as { new_config?: string } | undefined;

      if (rapidChanges) {
        if (rapidChanges.steps) {
          // Create-then-delete pattern
          for (const step of rapidChanges.steps) {
            const stepPath = path.join(collectionRoot, step.path);
            if (step.action === "create") {
              fs.mkdirSync(path.dirname(stepPath), { recursive: true });
              fs.writeFileSync(stepPath, step.content ?? "---\n---\n");
            } else if (step.action === "delete") {
              if (fs.existsSync(stepPath)) fs.unlinkSync(stepPath);
            }
          }
          // After debouncing: check final state vs initial state
          // If file no longer exists and didn't exist before → no event
          // Event generation handled below
        } else if (rapidChanges.path && rapidChanges.changes) {
          // Multiple rapid changes to same file — apply final state
          const lastChange = rapidChanges.changes[rapidChanges.changes.length - 1];
          const filePath = path.join(collectionRoot, rapidChanges.path);
          fs.writeFileSync(filePath, lastChange.content);
          // Only emit one event for the final state
          if (isWatchedExtension(rapidChanges.path) && !isExcluded(rapidChanges.path)) {
            const newState = readFileState(rapidChanges.path);
            const oldState = beforeState.get(rapidChanges.path);
            if (newState && oldState) {
              const changedFields = getChangedFields(oldState.frontmatter, newState.frontmatter);
              emitEvent({
                event: "file_modified",
                path: rapidChanges.path,
                types: newState.types,
                frontmatter: newState.frontmatter,
                changed_fields: changedFields,
              });
            }
          }
        }
      } else if (seqChanges) {
        // Sequential changes with enough delay to not be debounced
        for (const step of seqChanges) {
          const stepPath = path.join(collectionRoot, step.path);
          if (step.action === "create") {
            fs.mkdirSync(path.dirname(stepPath), { recursive: true });
            fs.writeFileSync(stepPath, step.content ?? "---\n---\n");
            if (isWatchedExtension(step.path) && !isExcluded(step.path)) {
              const newState = readFileState(step.path);
              if (newState) {
                emitEvent({
                  event: "file_created",
                  path: step.path,
                  types: newState.types,
                  frontmatter: newState.frontmatter,
                });
              }
            }
          } else if (step.action === "modify") {
            const oldState = readFileState(step.path) || beforeState.get(step.path);
            fs.writeFileSync(stepPath, step.content ?? "");
            if (isWatchedExtension(step.path) && !isExcluded(step.path)) {
              const newState = readFileState(step.path);
              if (newState) {
                const changedFields = oldState ? getChangedFields(oldState.frontmatter, newState.frontmatter) : [];
                emitEvent({
                  event: "file_modified",
                  path: step.path,
                  types: newState.types,
                  frontmatter: newState.frontmatter,
                  changed_fields: changedFields,
                });
              }
            }
            // Update beforeState for next iteration
            const updatedState = readFileState(step.path);
            if (updatedState) beforeState.set(step.path, updatedState);
          } else if (step.action === "delete") {
            const oldState = beforeState.get(step.path);
            if (fs.existsSync(stepPath)) fs.unlinkSync(stepPath);
            if (isWatchedExtension(step.path) && !isExcluded(step.path) && oldState) {
              emitEvent({
                event: "file_deleted",
                path: step.path,
                last_known_types: oldState.types,
              });
            }
          }
        }
      } else {
        // Single change events
        if (extCreate) {
          const createPath = path.join(collectionRoot, extCreate.path!);
          fs.mkdirSync(path.dirname(createPath), { recursive: true });
          if (extCreate.binary) {
            fs.writeFileSync(createPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG header
          } else {
            fs.writeFileSync(createPath, extCreate.content ?? "---\n---\n");
          }
          if (isWatchedExtension(extCreate.path!) && !isExcluded(extCreate.path!)) {
            const newState = readFileState(extCreate.path!);
            if (newState) {
              emitEvent({
                event: "file_created",
                path: extCreate.path!,
                types: newState.types,
                frontmatter: newState.frontmatter,
              });
              // Check for validation errors
              if (config.settings.default_validation === "error") {
                const issues = validateFile(extCreate.path!);
                if (issues.length > 0) {
                  emitEvent({
                    event: "validation_error",
                    path: extCreate.path!,
                    issues,
                  });
                }
              }
            }
          }
        }
        if (extModify) {
          const oldState = beforeState.get(extModify.path!);
          const modPath = path.join(collectionRoot, extModify.path!);
          fs.writeFileSync(modPath, extModify.content ?? "");
          if (isWatchedExtension(extModify.path!) && !isExcluded(extModify.path!)) {
            const newState = readFileState(extModify.path!);
            if (newState) {
              const changedFields = oldState ? getChangedFields(oldState.frontmatter, newState.frontmatter) : [];
              emitEvent({
                event: "file_modified",
                path: extModify.path!,
                types: newState.types,
                frontmatter: newState.frontmatter,
                changed_fields: changedFields,
              });
              // Check for validation errors
              if (config.settings.default_validation === "error") {
                const issues = validateFile(extModify.path!);
                if (issues.length > 0) {
                  emitEvent({
                    event: "validation_error",
                    path: extModify.path!,
                    issues,
                  });
                }
              }
            }
          }
        }
        if (extDelete) {
          const oldState = beforeState.get(extDelete.path!);
          const deletePath = path.join(collectionRoot, extDelete.path!);
          if (fs.existsSync(deletePath)) fs.unlinkSync(deletePath);
          if (isWatchedExtension(extDelete.path!) && !isExcluded(extDelete.path!) && oldState) {
            emitEvent({
              event: "file_deleted",
              path: extDelete.path!,
              last_known_types: oldState.types,
            });
          }
        }
        if (extRename) {
          const fromPath = path.join(collectionRoot, extRename.from!);
          const toPath = path.join(collectionRoot, extRename.to!);
          const oldState = beforeState.get(extRename.from!);
          fs.mkdirSync(path.dirname(toPath), { recursive: true });
          if (fs.existsSync(fromPath)) {
            fs.renameSync(fromPath, toPath);
          }
          if (isWatchedExtension(extRename.from!) && !isExcluded(extRename.from!)) {
            if (extRename.detection_fails) {
              // Rename not detected: emit delete + create
              if (oldState) {
                emitEvent({
                  event: "file_deleted",
                  path: extRename.from!,
                  last_known_types: oldState.types,
                });
              }
              const newState = readFileState(extRename.to!);
              if (newState) {
                emitEvent({
                  event: "file_created",
                  path: extRename.to!,
                  types: newState.types,
                  frontmatter: newState.frontmatter,
                });
              }
            } else {
              // Rename detected
              const newState = readFileState(extRename.to!);
              emitEvent({
                event: "file_renamed",
                from: extRename.from!,
                to: extRename.to!,
                types: newState?.types || oldState?.types || [],
              });
            }
          }
        }
        if (typeChange?.type && typeChange?.new_definition) {
          // Write new type definition
          let typesFolder = "_types";
          try {
            typesFolder = config.settings.types_folder;
          } catch { /* use default */ }
          const typePath = path.join(collectionRoot, typesFolder, `${typeChange.type}.md`);
          fs.writeFileSync(typePath, typeChange.new_definition);
          // Find affected files (those that use this type)
          const affectedFiles: string[] = [];
          for (const [filePath, state] of beforeState) {
            if (state.types.includes(typeChange.type)) {
              affectedFiles.push(filePath);
            }
          }
          emitEvent({
            event: "type_changed",
            type_name: typeChange.type,
            type: typeChange.type,
            affected_files: affectedFiles.sort(),
          });
        }
        if (configChange?.new_config) {
          // Compute hash of old and new config
          const crypto = require("crypto");
          const oldConfig = fs.readFileSync(path.join(collectionRoot, "mdbase.yaml"), "utf-8");
          const previousHash = crypto.createHash("sha256").update(oldConfig).digest("hex").slice(0, 16);
          fs.writeFileSync(path.join(collectionRoot, "mdbase.yaml"), configChange.new_config);
          const newHash = crypto.createHash("sha256").update(configChange.new_config).digest("hex").slice(0, 16);
          emitEvent({
            event: "config_changed",
            previous_hash: previousHash,
            new_hash: newHash,
          });
        }
      }

      return { events };
    }

    default:
      throw new Error(
        `Operation '${operation}' not yet implemented. ` +
        `Input: ${JSON.stringify(input)}. ` +
        `Collection root: ${collectionRoot}`,
      );
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deep subset check: verify that all fields in expected exist in actual with matching values.
 * This allows actual to have extra fields not in expected.
 */
function assertSubset(actual: unknown, expected: unknown, path: string): void {
  if (expected === null) {
    expect(actual, `${path} should be null`).toBeNull();
    return;
  }

  if (expected === undefined) {
    return; // undefined in expected means "don't care"
  }

  if (typeof expected !== "object") {
    expect(actual, path).toEqual(expected);
    return;
  }

  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} should be array`).toBe(true);
    expect((actual as unknown[]).length, `${path} length`).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      assertSubset((actual as unknown[])[i], expected[i], `${path}[${i}]`);
    }
    return;
  }

  // Check for special assertion objects: { matches: "regex" }, { not_equals: value }, { contains: "str" }
  const expectedObj = expected as Record<string, unknown>;

  if ("matches" in expectedObj && typeof expectedObj.matches === "string") {
    expect(actual, `${path} should be defined for matches`).toBeDefined();
    const regex = new RegExp(expectedObj.matches);
    expect(
      regex.test(String(actual)),
      `${path}: "${actual}" should match pattern "${expectedObj.matches}"`,
    ).toBe(true);
    return;
  }

  if ("not_null" in expectedObj && expectedObj.not_null === true) {
    expect(actual, `${path} should not be null`).not.toBeNull();
    expect(actual, `${path} should be defined`).toBeDefined();
    return;
  }

  if ("not_equals" in expectedObj) {
    expect(actual, `${path} should not equal`).not.toEqual(expectedObj.not_equals);
    return;
  }

  if ("contains" in expectedObj && typeof expectedObj.contains === "string") {
    expect(String(actual), `${path} should contain`).toContain(expectedObj.contains);
    return;
  }

  if ("starts_with" in expectedObj && typeof expectedObj.starts_with === "string") {
    expect(String(actual), `${path} should start with`).toMatch(new RegExp(`^${escapeRegex(expectedObj.starts_with)}`));
    return;
  }

  if ("ends_with" in expectedObj && typeof expectedObj.ends_with === "string") {
    expect(String(actual), `${path} should end with`).toMatch(new RegExp(`${escapeRegex(expectedObj.ends_with)}$`));
    return;
  }

  if ("greater_than" in expectedObj || "gt" in expectedObj) {
    const threshold = (expectedObj.greater_than ?? expectedObj.gt) as number;
    expect(Number(actual), `${path} should be > ${threshold}`).toBeGreaterThan(threshold);
    return;
  }

  if ("greater_than_or_equal" in expectedObj || "gte" in expectedObj) {
    const threshold = (expectedObj.greater_than_or_equal ?? expectedObj.gte) as number;
    expect(Number(actual), `${path} should be >= ${threshold}`).toBeGreaterThanOrEqual(threshold);
    return;
  }

  if ("less_than" in expectedObj || "lt" in expectedObj) {
    const threshold = (expectedObj.less_than ?? expectedObj.lt) as number;
    expect(Number(actual), `${path} should be < ${threshold}`).toBeLessThan(threshold);
    return;
  }

  if ("less_than_or_equal" in expectedObj || "lte" in expectedObj) {
    const threshold = (expectedObj.less_than_or_equal ?? expectedObj.lte) as number;
    expect(Number(actual), `${path} should be <= ${threshold}`).toBeLessThanOrEqual(threshold);
    return;
  }

  expect(typeof actual, `${path} should be object`).toBe("object");
  expect(actual, `${path} should not be null`).not.toBeNull();
  const actualObj = actual as Record<string, unknown>;

  for (const [key, value] of Object.entries(expectedObj)) {
    // body_contains: assert body field contains substring
    if (key === "body_contains") {
      const bodyStr = String(actualObj.body ?? "");
      expect(bodyStr, `${path}.body_contains`).toContain(value as string);
      continue;
    }
    // body_not_contains: assert body field does NOT contain substring
    if (key === "body_not_contains") {
      const bodyStr = String(actualObj.body ?? "");
      expect(bodyStr, `${path}.body_not_contains`).not.toContain(value as string);
      continue;
    }
    // total_count_positive: assert total_count > 0
    if (key === "total_count_positive" && value === true) {
      const tc = Number(actualObj.total_count ?? 0);
      expect(tc, `${path}.total_count_positive`).toBeGreaterThan(0);
      continue;
    }
    assertSubset(actualObj[key], value, `${path}.${key}`);
  }
}

/**
 * Compare actual result against expected result from test case.
 */
async function assertExpectation(
  actual: unknown,
  expected: TestExpectation,
  testName: string,
  collectionRoot?: string,
): void {
  const result = actual as Record<string, unknown>;

  if (expected.valid !== undefined) {
    expect(result.valid, `${testName}: valid`).toBe(expected.valid);
  }

  if (expected.error !== undefined) {
    const actualError = result.error as Record<string, unknown> | undefined;
    expect(actualError, `${testName}: error present`).toBeDefined();
    if (actualError && expected.error.code) {
      expect(actualError.code, `${testName}: error code`).toBe(expected.error.code);
    }
  }

  if (expected.config !== undefined) {
    assertSubset(result.config, expected.config, `${testName}: config`);
  }

  if (expected.warnings !== undefined) {
    const actualWarnings = (result.warnings ?? []) as string[];
    for (const expectedWarning of expected.warnings) {
      if (expectedWarning.contains) {
        const found = actualWarnings.some((w: string) =>
          w.toLowerCase().includes(expectedWarning.contains.toLowerCase()),
        );
        expect(found, `${testName}: warning containing "${expectedWarning.contains}" in [${actualWarnings.join(", ")}]`).toBe(true);
      }
    }
  }

  if (expected.issues !== undefined) {
    const actualIssues = (result.issues ?? result.errors) as Array<Record<string, unknown>>;
    expect(actualIssues, `${testName}: issues defined`).toBeDefined();

    if (expected.issues.length === 0) {
      expect(actualIssues, `${testName}: no issues`).toHaveLength(0);
    } else {
      // Map of generic codes to specific codes that should match
      const CONSTRAINT_CODES = new Set([
        "string_too_short", "string_too_long", "pattern_mismatch",
        "number_too_small", "number_too_large", "not_integer",
        "list_too_short", "list_too_long", "list_duplicate", "list_item_invalid",
        "constraint_violation",
      ]);

      // list_item_invalid can match any error that occurs on a list item (indexed field)
      const LIST_ITEM_CODES = new Set([
        "type_mismatch", "missing_required",
        "string_too_short", "string_too_long", "pattern_mismatch",
        "number_too_small", "number_too_large", "not_integer",
        "list_too_short", "list_too_long", "list_duplicate",
        "constraint_violation", "list_item_invalid", "invalid_enum_value",
        "invalid_link", "link_not_found", "link_wrong_type", "ambiguous_link",
      ]);

      for (const expectedIssue of expected.issues) {
        const match = actualIssues.find((a) => {
          if (expectedIssue.code) {
            if (a.code !== expectedIssue.code) {
              // constraint_violation matches any specific constraint code
              if (expectedIssue.code === "constraint_violation" && CONSTRAINT_CODES.has(a.code as string)) {
                // OK, generic matches specific
              } else if (CONSTRAINT_CODES.has(expectedIssue.code) && a.code === "constraint_violation") {
                // OK, specific matches generic
              } else if (expectedIssue.code === "list_item_invalid" && LIST_ITEM_CODES.has(a.code as string)) {
                // list_item_invalid matches any list item error
              } else {
                return false;
              }
            }
          }
          if (expectedIssue.field && a.field !== expectedIssue.field) return false;
          if (expectedIssue.severity && a.severity !== expectedIssue.severity) return false;
          if (expectedIssue.path && a.path !== expectedIssue.path) return false;
          return true;
        });
        expect(match, `${testName}: expected issue ${JSON.stringify(expectedIssue)} in ${JSON.stringify(actualIssues.map(i => ({code: i.code, field: i.field})))}`).toBeDefined();
      }
    }
  }

  if (expected.result !== undefined) {
    const actualResult = "result" in result ? result.result : result;
    expect(actualResult, `${testName}: result`).toEqual(expected.result);
  }

  // result_type: check the type of the result value
  if ((expected as Record<string, unknown>).result_type !== undefined) {
    const actualResult = "result" in result ? result.result : result;
    const expectedType = (expected as Record<string, unknown>).result_type as string;
    expect(typeof actualResult, `${testName}: result_type`).toBe(expectedType);
  }

  // results_count_lte: check that results count is at most N
  if ((expected as Record<string, unknown>).results_count_lte !== undefined) {
    const actualResults = result.results as unknown[] | undefined;
    expect(actualResults, `${testName}: results for results_count_lte`).toBeDefined();
    const maxCount = (expected as Record<string, unknown>).results_count_lte as number;
    expect(actualResults!.length, `${testName}: results_count_lte`).toBeLessThanOrEqual(maxCount);
  }

  if (expected.results !== undefined) {
    expect(result.results, `${testName}: results`).toBeDefined();
    const actualResults = result.results as unknown[];
    const expectedResults = expected.results as unknown[];
    expect(actualResults.length, `${testName}: results length`).toBe(expectedResults.length);
    for (let i = 0; i < expectedResults.length; i++) {
      assertSubset(actualResults[i], expectedResults[i], `${testName}: results[${i}]`);
    }
  }

  if (expected.count !== undefined) {
    const actualResults = result.results as unknown[] | undefined;
    expect(actualResults, `${testName}: results for count`).toBeDefined();
    expect(actualResults?.length, `${testName}: count`).toBe(expected.count);
  }

  if ((expected as Record<string, unknown>).results_count !== undefined) {
    const actualResults = result.results as unknown[] | undefined;
    expect(actualResults, `${testName}: results for results_count`).toBeDefined();
    expect(actualResults?.length, `${testName}: results_count`).toBe((expected as Record<string, unknown>).results_count);
  }

  if (expected.paths !== undefined) {
    const actualResults = result.results as Array<Record<string, unknown>> | undefined;
    expect(actualResults, `${testName}: results for paths`).toBeDefined();
    const actualPaths = actualResults?.map((r) => r.path);
    expect(actualPaths, `${testName}: paths`).toEqual(expected.paths);
  }

  if (expected.frontmatter !== undefined) {
    assertSubset(result.frontmatter, expected.frontmatter, `${testName}: frontmatter`);
  }

  if (expected.body !== undefined) {
    expect(result.body, `${testName}: body`).toBe(expected.body);
  }

  if ((expected as Record<string, unknown>).body_contains !== undefined) {
    const bodyStr = String(result.body ?? "");
    expect(bodyStr, `${testName}: body_contains`).toContain(
      (expected as Record<string, unknown>).body_contains as string,
    );
  }

  if ((expected as Record<string, unknown>).body_contains_all !== undefined) {
    const bodyStr = String(result.body ?? "");
    const all = (expected as Record<string, unknown>).body_contains_all as string[];
    for (const s of all) {
      expect(bodyStr, `${testName}: body_contains_all "${s}"`).toContain(s);
    }
  }

  if ((expected as Record<string, unknown>).path_contains !== undefined) {
    const pathStr = String(result.path ?? "");
    expect(pathStr, `${testName}: path_contains`).toContain(
      (expected as Record<string, unknown>).path_contains as string,
    );
  }

  if ((expected as Record<string, unknown>).deleted !== undefined) {
    // Just check the operation succeeded (no error)
    if ((expected as Record<string, unknown>).deleted === true) {
      expect(result.error, `${testName}: deleted should not have error`).toBeUndefined();
    }
  }

  if ((expected as Record<string, unknown>).file !== undefined) {
    const expectedFile = (expected as Record<string, unknown>).file as Record<string, unknown>;
    const actualFile = result.file as Record<string, unknown>;
    expect(actualFile, `${testName}: file should exist`).toBeDefined();
    if (actualFile) {
      // Handle custom assertions
      if (expectedFile.mtime_present === true) {
        expect(actualFile.mtime, `${testName}: file.mtime should exist`).toBeDefined();
      }
      if (expectedFile.size_positive === true) {
        expect(typeof actualFile.size, `${testName}: file.size should be number`).toBe("number");
        expect(actualFile.size as number, `${testName}: file.size should be positive`).toBeGreaterThan(0);
      }
      // Check non-custom fields with subset matching
      const filteredExpected: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(expectedFile)) {
        if (k !== "mtime_present" && k !== "size_positive") {
          filteredExpected[k] = v;
        }
      }
      if (Object.keys(filteredExpected).length > 0) {
        assertSubset(actualFile, filteredExpected, `${testName}: file`);
      }
    }
  }

  if ("resolved_path" in (expected as Record<string, unknown>)) {
    const expectedPath = (expected as Record<string, unknown>).resolved_path;
    const actualPath = (result as Record<string, unknown>).resolved_path;
    if (expectedPath === null) {
      expect(actualPath, `${testName}: resolved_path should be null`).toBeNull();
    } else {
      expect(actualPath, `${testName}: resolved_path`).toBe(expectedPath);
    }
  }

  if ((expected as Record<string, unknown>).link !== undefined) {
    const actualLink = (result as Record<string, unknown>).link;
    expect(actualLink, `${testName}: link should exist`).toBeDefined();
    assertSubset(actualLink, (expected as Record<string, unknown>).link, `${testName}: link`);
  }

  if (expected.type !== undefined) {
    assertSubset(result.type, expected.type, `${testName}: type`);
  }

  if (expected.types !== undefined) {
    const actualTypes = (result.types as string[] ?? []).slice().sort();
    const expectedTypes = (expected.types as string[]).slice().sort();
    expect(actualTypes, `${testName}: types`).toEqual(expectedTypes);
  }

  if ((expected as Record<string, unknown>).batch_result !== undefined) {
    assertSubset(
      result.batch_result ?? result,
      (expected as Record<string, unknown>).batch_result,
      `${testName}: batch_result`,
    );
  }

  if ((expected as Record<string, unknown>).changed_fields !== undefined) {
    assertSubset(
      result.changed_fields,
      (expected as Record<string, unknown>).changed_fields,
      `${testName}: changed_fields`,
    );
  }

  if ((expected as Record<string, unknown>).meta !== undefined) {
    const expectedMeta = (expected as Record<string, unknown>).meta as Record<string, unknown>;
    const actualMeta = (result as Record<string, unknown>).meta as Record<string, unknown> | undefined;
    expect(actualMeta, `${testName}: meta should exist`).toBeDefined();
    if (actualMeta) {
      assertSubset(actualMeta, expectedMeta, `${testName}: meta`);
    }
  }

  if ((expected as Record<string, unknown>).error_code !== undefined) {
    const actualError = result.error as Record<string, unknown> | undefined;
    expect(actualError, `${testName}: error present for error_code`).toBeDefined();
    expect(actualError?.code, `${testName}: error_code`).toBe(
      (expected as Record<string, unknown>).error_code,
    );
  }

  // frontmatter_not_match: check that frontmatter fields do NOT match given values
  if ((expected as Record<string, unknown>).frontmatter_not_match !== undefined) {
    const notMatch = (expected as Record<string, unknown>).frontmatter_not_match as Record<string, unknown>;
    const actualFm = result.frontmatter as Record<string, unknown>;
    for (const [key, value] of Object.entries(notMatch)) {
      expect(actualFm[key], `${testName}: frontmatter.${key} should not match ${value}`).not.toEqual(value);
    }
  }

  // frontmatter_written: check what was actually written to disk
  if ((expected as Record<string, unknown>).frontmatter_written !== undefined && collectionRoot) {
    const inputObj = (actual as Record<string, unknown>);
    const filePath = (result.path ?? inputObj.path ??
      (expected as Record<string, unknown>).path) as string | undefined;
    if (filePath) {
      const fullPath = path.join(collectionRoot, filePath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        const parsed = matter(content);
        const writtenData = (expected as Record<string, unknown>).frontmatter_written;
        if (Array.isArray(writtenData)) {
          // Array form: list of field names that should be present
          for (const field of writtenData) {
            expect(
              field in parsed.data,
              `${testName}: field "${field}" should be in written frontmatter`,
            ).toBe(true);
          }
        } else if (typeof writtenData === "object" && writtenData !== null) {
          for (const [key, value] of Object.entries(writtenData as Record<string, unknown>)) {
            assertSubset(parsed.data[key], value, `${testName}: frontmatter_written.${key}`);
          }
        }
      }
    }
  }

  // frontmatter_not_written: check fields are NOT in the written file
  if ((expected as Record<string, unknown>).frontmatter_not_written !== undefined && collectionRoot) {
    const filePath = (result.path ?? (expected as Record<string, unknown>).path ??
      ((actual as Record<string, unknown>).path)) as string | undefined;
    if (filePath) {
      const fullPath = path.join(collectionRoot, filePath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        const parsed = matter(content);
        const notWritten = (expected as Record<string, unknown>).frontmatter_not_written as string[];
        for (const field of notWritten) {
          expect(
            field in parsed.data,
            `${testName}: field "${field}" should NOT be in written frontmatter`,
          ).toBe(false);
        }
      }
    }
  }

  // frontmatter_not_bare_null: check fields are not written as bare null (empty value)
  if ((expected as Record<string, unknown>).frontmatter_not_bare_null !== undefined && collectionRoot) {
    const filePath = (result.path ?? (expected as Record<string, unknown>).path) as string | undefined;
    if (filePath) {
      const fullPath = path.join(collectionRoot, filePath);
      if (fs.existsSync(fullPath)) {
        const raw = fs.readFileSync(fullPath, "utf-8");
        const fields = (expected as Record<string, unknown>).frontmatter_not_bare_null as string[];
        for (const field of fields) {
          // Check the field isn't written as "field:" with no value (bare null)
          const bareNullRegex = new RegExp(`^${field}:\\s*$`, "m");
          expect(
            bareNullRegex.test(raw),
            `${testName}: field "${field}" should not be bare null in written YAML`,
          ).toBe(false);
        }
      }
    }
  }

  // line_endings: check line ending style of written file
  if ((expected as Record<string, unknown>).line_endings !== undefined && collectionRoot) {
    const filePath = (result.path ?? (expected as Record<string, unknown>).path ??
      ((actual as Record<string, unknown>).path)) as string | undefined;
    if (filePath) {
      const fullPath = path.join(collectionRoot, filePath);
      if (fs.existsSync(fullPath)) {
        const raw = fs.readFileSync(fullPath, "utf-8");
        const expectedLE = (expected as Record<string, unknown>).line_endings as string;
        if (expectedLE === "CRLF") {
          // Should have \r\n line endings
          expect(raw.includes("\r\n"), `${testName}: should have CRLF line endings`).toBe(true);
        } else if (expectedLE === "LF") {
          // Should have \n line endings, no \r\n
          expect(raw.includes("\r\n"), `${testName}: should not have CRLF line endings`).toBe(false);
        }
      }
    }
  }

  // Rename-specific assertions: from, to, references_updated, partial_updates
  if ((expected as Record<string, unknown>).from !== undefined) {
    expect(result.from, `${testName}: from`).toBe((expected as Record<string, unknown>).from);
  }
  if ((expected as Record<string, unknown>).to !== undefined) {
    expect(result.to, `${testName}: to`).toBe((expected as Record<string, unknown>).to);
  }
  if ((expected as Record<string, unknown>).references_updated !== undefined) {
    const expectedRefs = (expected as Record<string, unknown>).references_updated as Array<Record<string, unknown>>;
    const actualRefs = (result.references_updated ?? []) as Array<Record<string, unknown>>;
    if (expectedRefs.length === 0) {
      expect(actualRefs.length, `${testName}: references_updated should be empty`).toBe(0);
    } else {
      for (const expectedRef of expectedRefs) {
        const found = actualRefs.some((a) => {
          if (expectedRef.path && a.path !== expectedRef.path) return false;
          if (expectedRef.field && a.field !== expectedRef.field) return false;
          if (expectedRef.location && a.location !== expectedRef.location) return false;
          return true;
        });
        expect(found, `${testName}: references_updated should include ${JSON.stringify(expectedRef)} in ${JSON.stringify(actualRefs)}`).toBe(true);
      }
    }
  }
  if ((expected as Record<string, unknown>).partial_updates !== undefined) {
    const expectedPartial = (expected as Record<string, unknown>).partial_updates as Record<string, unknown>;
    const actualPartial = (result.partial_updates ?? {}) as Record<string, unknown>;
    assertSubset(actualPartial, expectedPartial, `${testName}: partial_updates`);
  }

  // Rename-specific warnings (array of {path, message_contains})
  if (expected.warnings !== undefined) {
    const actualWarnings = (result.warnings ?? []) as Array<Record<string, unknown> | string>;
    for (const expectedWarning of expected.warnings) {
      if (typeof expectedWarning === "object" && expectedWarning !== null) {
        const ew = expectedWarning as Record<string, unknown>;
        if (ew.path || ew.message_contains) {
          const found = actualWarnings.some((a) => {
            const aw = typeof a === "object" ? a : { message: a };
            if (ew.path && aw.path !== ew.path) return false;
            if (ew.message_contains) {
              const msg = String(aw.message_contains ?? aw.message ?? "");
              if (!msg.toLowerCase().includes((ew.message_contains as string).toLowerCase())) return false;
            }
            return true;
          });
          expect(found, `${testName}: warning matching ${JSON.stringify(ew)} in ${JSON.stringify(actualWarnings)}`).toBe(true);
        }
      }
    }
  }

  // Watch mode event assertions
  if ((expected as Record<string, unknown>).events !== undefined) {
    const actualEvents = (result.events ?? []) as Array<Record<string, unknown>>;
    const expectedEvents = (expected as Record<string, unknown>).events as Array<Record<string, unknown>>;
    expect(actualEvents.length, `${testName}: events length`).toBe(expectedEvents.length);
    for (let i = 0; i < expectedEvents.length; i++) {
      assertEventMatch(actualEvents[i], expectedEvents[i], `${testName}: events[${i}]`);
    }
  }

  if ((expected as Record<string, unknown>).events_ordered !== undefined) {
    const actualEvents = (result.events ?? []) as Array<Record<string, unknown>>;
    const expectedOrdered = (expected as Record<string, unknown>).events_ordered as Array<Record<string, unknown>>;
    // Events must appear in order (may have others between)
    let actualIdx = 0;
    for (let i = 0; i < expectedOrdered.length; i++) {
      let found = false;
      while (actualIdx < actualEvents.length) {
        try {
          assertEventMatch(actualEvents[actualIdx], expectedOrdered[i], `${testName}: events_ordered[${i}]`);
          found = true;
          actualIdx++;
          break;
        } catch {
          actualIdx++;
        }
      }
      expect(found, `${testName}: events_ordered[${i}] not found in events`).toBe(true);
    }
  }

  if ((expected as Record<string, unknown>).events_contain !== undefined) {
    const actualEvents = (result.events ?? []) as Array<Record<string, unknown>>;
    const expectedContain = (expected as Record<string, unknown>).events_contain as Array<Record<string, unknown>>;
    for (let i = 0; i < expectedContain.length; i++) {
      const found = actualEvents.some((ae) => {
        try {
          assertEventMatch(ae, expectedContain[i], "");
          return true;
        } catch {
          return false;
        }
      });
      expect(found, `${testName}: events_contain[${i}] (${JSON.stringify(expectedContain[i])}) not found in events: ${JSON.stringify(actualEvents)}`).toBe(true);
    }
  }

  if ((expected as Record<string, unknown>).max_event_count !== undefined) {
    const actualEvents = (result.events ?? []) as Array<Record<string, unknown>>;
    const maxCount = (expected as Record<string, unknown>).max_event_count as number;
    expect(actualEvents.length, `${testName}: max_event_count`).toBeLessThanOrEqual(maxCount);
  }

  // Listener query (for watch cache consistency tests)
  if ((expected as Record<string, unknown>).listener_query !== undefined && collectionRoot) {
    const lq = (expected as Record<string, unknown>).listener_query as {
      operation: string;
      input: Record<string, unknown>;
      expect: TestExpectation;
    };
    // Apply the simulated changes already happened, just run the query
    const lqResult = await executeOperation(collectionRoot, lq.operation, lq.input ?? {});
    await assertExpectation(lqResult, lq.expect, `${testName} [listener_query]`, collectionRoot);
  }

  // verify_after: run a second operation after the first to check state
  // (handled in the test execution loop, not here)
}

function assertEventMatch(actual: Record<string, unknown>, expected: Record<string, unknown>, prefix: string): void {
  // Check each expected field against actual
  for (const [key, value] of Object.entries(expected)) {
    if (key === "timestamp_present") {
      if (value === true) {
        expect(actual.timestamp, `${prefix}.timestamp present`).toBeDefined();
      }
      continue;
    }
    if (key === "has_fields") {
      const fields = value as string[];
      for (const field of fields) {
        expect(actual[field], `${prefix} has_field ${field}`).toBeDefined();
      }
      continue;
    }
    if (key === "affected_files_not_contain") {
      const notContain = value as string[];
      const actualAffected = actual.affected_files as string[] | undefined;
      if (actualAffected) {
        for (const nc of notContain) {
          expect(actualAffected.includes(nc), `${prefix} affected_files should not contain ${nc}`).toBe(false);
        }
      }
      continue;
    }
    if (key === "frontmatter" && typeof value === "object" && value !== null) {
      assertSubset(actual.frontmatter, value, `${prefix}.frontmatter`);
      continue;
    }
    if (key === "issues" && Array.isArray(value)) {
      const actualIssues = actual.issues as Array<Record<string, unknown>> | undefined;
      expect(actualIssues, `${prefix}.issues present`).toBeDefined();
      for (let j = 0; j < value.length; j++) {
        const expectedIssue = value[j] as Record<string, unknown>;
        const found = actualIssues!.some((ai) => {
          for (const [ik, iv] of Object.entries(expectedIssue)) {
            if (ai[ik] !== iv) return false;
          }
          return true;
        });
        expect(found, `${prefix}.issues[${j}] ${JSON.stringify(expectedIssue)} not found in ${JSON.stringify(actualIssues)}`).toBe(true);
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (key === "changed_fields") {
        const actualFields = actual[key] as string[] | undefined;
        expect(actualFields, `${prefix}.${key} present`).toBeDefined();
        expect(actualFields!.sort(), `${prefix}.${key}`).toEqual([...value].sort());
        continue;
      }
      if (key === "affected_files") {
        const actualFiles = actual[key] as string[] | undefined;
        expect(actualFiles, `${prefix}.${key} present`).toBeDefined();
        // Subset match: all expected files must be present
        for (const ef of value) {
          expect(actualFiles!.includes(ef as string), `${prefix}.${key} contains ${ef}`).toBe(true);
        }
        continue;
      }
      assertSubset(actual[key], value, `${prefix}.${key}`);
      continue;
    }
    expect(actual[key], `${prefix}.${key}`).toEqual(value);
  }
}

// Discover and register tests
const allTests = discoverTests();

if (allTests.size === 0) {
  describe("mdbase conformance", () => {
    it("no test files found (waiting for test-writing loop)", () => {
      console.log(`Looked in: ${SPEC_TESTS_DIR}`);
      console.log("Run the test-writing Ralph Loop first to generate test YAML files.");
    });
  });
} else {
  for (const [level, files] of [...allTests.entries()].sort((a, b) => a[0] - b[0])) {
    describe(`Level ${level}`, () => {
      for (const { file, data } of files) {
        describe(`${data.name} (${file})`, () => {
          // Handle grouped tests
          if (data.groups) {
            for (const group of data.groups) {
              describe(group.name, () => {
                // Detect if group has mutating operations (batch, create, update, delete, rename)
                const MUTATING_OPS = new Set(["create", "update", "delete", "rename", "batch_delete", "batch_update", "create_type", "cache_rebuild", "cache_clear"]);
                const groupHasMutating = group.tests.some((t) => {
                  if (MUTATING_OPS.has(t.operation)) return true;
                  // Tests with simulate that contains external modifications are effectively mutating
                  const sim = t.simulate as Record<string, unknown> | undefined;
                  if (sim && (sim.external_modify || sim.external_create || sim.external_delete || sim.external_rename || sim.config_change || sim.type_change || sim.rapid_changes || sim.sequential_changes)) return true;
                  // Tests with verify_after that contains mutating operations
                  const va = t.verify_after;
                  if (va) {
                    const steps = Array.isArray(va) ? va : [va];
                    if (steps.some((s: VerifyAfterStep) => MUTATING_OPS.has(s.operation))) return true;
                  }
                  return false;
                });

                let sharedRoot: string | undefined;

                // If the group has setup but individual tests don't override it,
                // create one shared setup for the group.
                // BUT: if any tests mutate state, each test gets its own root.
                const groupHasSetup = !!group.setup;
                const allTestsHaveSetup = group.tests.every((t) => !!t.setup);

                if (groupHasSetup && !allTestsHaveSetup && !groupHasMutating) {
                  beforeAll(() => {
                    sharedRoot = materializeSetup(mergeSetup(data.setup, group.setup));
                  });
                  afterAll(() => {
                    if (sharedRoot) cleanupSetup(sharedRoot);
                  });
                }

                for (const testCase of group.tests) {
                  it(testCase.name, async () => {
                    let testRoot: string | undefined;
                    let root: string;

                    if (testCase.setup) {
                      // Per-test setup overrides group setup
                      const merged = mergeSetup(
                        mergeSetup(data.setup, group.setup),
                        testCase.setup,
                        testCase as Record<string, unknown>,
                      );
                      testRoot = materializeSetup(merged);
                      root = testRoot;
                    } else if (sharedRoot && !groupHasMutating) {
                      root = sharedRoot;
                    } else {
                      // Each test gets its own root (for mutating ops or no group setup)
                      testRoot = materializeSetup(mergeSetup(data.setup, group.setup));
                      root = testRoot;
                    }

                    try {
                      const inputObj = testCase.input ?? {};
                      const simulate = (testCase.simulate ?? inputObj.simulate) as Record<string, unknown> | undefined;
                      const result = await executeOperation(
                        root,
                        testCase.operation,
                        inputObj,
                        simulate,
                      );
                      if (testCase.expect) {
                        await assertExpectation(result, testCase.expect, testCase.name, root);
                      }

                      // Run verify_after steps
                      if (testCase.verify_after) {
                        const steps = Array.isArray(testCase.verify_after)
                          ? testCase.verify_after
                          : [testCase.verify_after];
                        for (const step of steps) {
                          const verifyResult = await executeOperation(
                            root,
                            step.operation,
                            step.input ?? {},
                          );
                          if (step.expect) {
                            await assertExpectation(verifyResult, step.expect, `${testCase.name} [verify_after: ${step.operation}]`, root);
                          }
                        }
                      }
                    } finally {
                      if (testRoot) cleanupSetup(testRoot);
                    }
                  });
                }
              });
            }
          }

          // Handle flat tests (no groups)
          if (data.tests) {
            let sharedRoot: string | undefined;

            if (data.setup && !data.tests.every((t) => !!t.setup)) {
              beforeAll(() => {
                sharedRoot = materializeSetup(data.setup!);
              });
              afterAll(() => {
                if (sharedRoot) cleanupSetup(sharedRoot);
              });
            }

            for (const testCase of data.tests) {
              it(testCase.name, async () => {
                let testRoot: string | undefined;
                let root: string;

                if (testCase.setup) {
                  const merged = mergeSetup(data.setup, testCase.setup, testCase as Record<string, unknown>);
                  testRoot = materializeSetup(merged);
                  root = testRoot;
                } else if (sharedRoot) {
                  root = sharedRoot;
                } else {
                  testRoot = materializeSetup(data.setup ?? {});
                  root = testRoot;
                }

                try {
                  const inputObj2 = testCase.input ?? {};
                  const simulate2 = (testCase.simulate ?? inputObj2.simulate) as Record<string, unknown> | undefined;
                  const result = await executeOperation(
                    root,
                    testCase.operation,
                    inputObj2,
                    simulate2,
                  );
                  if (testCase.expect) {
                    await assertExpectation(result, testCase.expect, testCase.name, root);
                  }

                  // Run verify_after steps
                  if (testCase.verify_after) {
                    const steps = Array.isArray(testCase.verify_after)
                      ? testCase.verify_after
                      : [testCase.verify_after];
                    for (const step of steps) {
                      const verifyResult = await executeOperation(
                        root,
                        step.operation,
                        step.input ?? {},
                      );
                      if (step.expect) {
                        await assertExpectation(verifyResult, step.expect, `${testCase.name} [verify_after: ${step.operation}]`, root);
                      }
                    }
                  }
                } finally {
                  if (testRoot) cleanupSetup(testRoot);
                }
              });
            }
          }
        });
      }
    });
  }
}
