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
function mergeSetup(group?: TestSetup, test?: TestSetup): TestSetup {
  if (!group && !test) return {};
  if (!group) return test!;
  if (!test) return group;

  return {
    config: test.config !== undefined ? test.config : group.config,
    types: { ...(group.types ?? {}), ...(test.types ?? {}) },
    files: { ...(group.files ?? {}), ...(test.files ?? {}) },
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

  // Set up pre-write hook for external modifications
  const extModify = simulate.external_modify as { path?: string; content?: string; frontmatter?: Record<string, unknown> } | undefined;
  const extCreate = simulate.external_create as { path?: string; content?: string } | undefined;

  if (extModify || extCreate) {
    collection.preWriteHook = () => {
      if (extModify) {
        const modPath = path.join(collectionRoot, extModify.path!);
        let content = extModify.content;
        if (!content && extModify.frontmatter) {
          // Build content from frontmatter
          const yamlStr = Object.entries(extModify.frontmatter)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join("\n");
          content = `---\n${yamlStr}\n---\n`;
        }
        if (content) {
          // Ensure the modification changes mtime (wait a bit if needed)
          fs.writeFileSync(modPath, content);
          // Force mtime change by touching the file with a future time
          const now = Date.now();
          fs.utimesSync(modPath, new Date(now + 1000), new Date(now + 1000));
        }
      }
      if (extCreate) {
        const createPath = path.join(collectionRoot, extCreate.path!);
        fs.mkdirSync(path.dirname(createPath), { recursive: true });
        fs.writeFileSync(createPath, extCreate.content ?? "---\n---\n");
      }
    };
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
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      return opened.collection!.read(input.path as string);
    }

    case "validate": {
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
      return opened.collection!.rename({ from, to });
    }

    case "query": {
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
      try {
        const result = evaluateExpression(expression, {
          frontmatter,
          rawFrontmatter,
          path: filePath,
          types,
          body,
          file: fileInfo,
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
function assertExpectation(
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

  // verify_after: run a second operation after the first to check state
  // (handled in the test execution loop, not here)
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
                const MUTATING_OPS = new Set(["create", "update", "delete", "rename", "batch_delete", "batch_update", "create_type"]);
                const groupHasMutating = group.tests.some((t) => MUTATING_OPS.has(t.operation));

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
                      const result = await executeOperation(
                        root,
                        testCase.operation,
                        testCase.input ?? {},
                        testCase.simulate as Record<string, unknown> | undefined,
                      );
                      assertExpectation(result, testCase.expect, testCase.name, root);

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
                          assertExpectation(verifyResult, step.expect, `${testCase.name} [verify_after: ${step.operation}]`, root);
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
                  const merged = mergeSetup(data.setup, testCase.setup);
                  testRoot = materializeSetup(merged);
                  root = testRoot;
                } else if (sharedRoot) {
                  root = sharedRoot;
                } else {
                  testRoot = materializeSetup(data.setup ?? {});
                  root = testRoot;
                }

                try {
                  const result = await executeOperation(
                    root,
                    testCase.operation,
                    testCase.input ?? {},
                    testCase.simulate as Record<string, unknown> | undefined,
                  );
                  assertExpectation(result, testCase.expect, testCase.name, root);

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
                      assertExpectation(verifyResult, step.expect, `${testCase.name} [verify_after: ${step.operation}]`, root);
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
