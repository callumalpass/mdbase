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

import { loadConfig } from "../src/config/loader.js";
import { loadTypes, getType } from "../src/types/loader.js";
import { Collection } from "../src/operations/collection.js";

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

interface TestCase {
  name: string;
  spec_ref?: string;
  operation: string;
  input: Record<string, unknown>;
  expect: TestExpectation;
  setup?: TestSetup;
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
    const typesDir = path.join(tmpDir, "_types");
    fs.mkdirSync(typesDir, { recursive: true });
    for (const [filename, content] of Object.entries(setup.types)) {
      fs.writeFileSync(path.join(typesDir, filename), content);
    }
  }

  // Write content files
  if (setup.files) {
    for (const [filePath, content] of Object.entries(setup.files)) {
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
 * Execute a single test operation against the mdbase implementation.
 */
async function executeOperation(
  collectionRoot: string,
  operation: string,
  input: Record<string, unknown>,
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
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { valid: false, error: opened.error };
      }
      return opened.collection!.validate(input.path as string | undefined);
    }

    case "create": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      return opened.collection!.create({
        type: input.type as string | undefined,
        types: input.types as string[] | undefined,
        path: input.path as string,
        frontmatter: input.frontmatter as Record<string, unknown> | undefined,
        body: input.body as string | undefined,
      });
    }

    case "update": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      return opened.collection!.update({
        path: input.path as string,
        fields: input.fields as Record<string, unknown> | undefined,
        body: input.body as string | undefined,
      });
    }

    case "delete": {
      const opened = Collection.open(collectionRoot);
      if (opened.error) {
        return { error: opened.error };
      }
      return opened.collection!.delete(input.path as string);
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
      return opened.collection!.rename({
        from: input.from as string,
        to: input.to as string,
      });
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
        where: queryInput.where as string | undefined,
        order_by: queryInput.order_by as Array<{ field: string; direction?: string }> | undefined,
      });
    }

    default:
      throw new Error(
        `Operation '${operation}' not yet implemented. ` +
        `Input: ${JSON.stringify(input)}. ` +
        `Collection root: ${collectionRoot}`,
      );
  }
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

  if ("not_equals" in expectedObj) {
    expect(actual, `${path} should not equal`).not.toEqual(expectedObj.not_equals);
    return;
  }

  if ("contains" in expectedObj && typeof expectedObj.contains === "string") {
    expect(String(actual), `${path} should contain`).toContain(expectedObj.contains);
    return;
  }

  expect(typeof actual, `${path} should be object`).toBe("object");
  expect(actual, `${path} should not be null`).not.toBeNull();
  const actualObj = actual as Record<string, unknown>;

  for (const [key, value] of Object.entries(expectedObj)) {
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
      for (const expectedIssue of expected.issues) {
        const match = actualIssues.find((a) => {
          if (expectedIssue.code && a.code !== expectedIssue.code) return false;
          if (expectedIssue.field && a.field !== expectedIssue.field) return false;
          if (expectedIssue.severity && a.severity !== expectedIssue.severity) return false;
          return true;
        });
        expect(match, `${testName}: expected issue ${JSON.stringify(expectedIssue)}`).toBeDefined();
      }
    }
  }

  if (expected.result !== undefined) {
    expect(result.result ?? result, `${testName}: result`).toEqual(expected.result);
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

  if (expected.type !== undefined) {
    assertSubset(result.type, expected.type, `${testName}: type`);
  }

  if (expected.types !== undefined) {
    expect(result.types, `${testName}: types`).toEqual(expected.types);
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
                let sharedRoot: string | undefined;

                // If the group has setup but individual tests don't override it,
                // create one shared setup for the group
                const groupHasSetup = !!group.setup;
                const allTestsHaveSetup = group.tests.every((t) => !!t.setup);

                if (groupHasSetup && !allTestsHaveSetup) {
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
                    } else if (sharedRoot) {
                      root = sharedRoot;
                    } else {
                      // No group setup, no test setup - use file-level setup
                      testRoot = materializeSetup(mergeSetup(data.setup, group.setup));
                      root = testRoot;
                    }

                    try {
                      const result = await executeOperation(
                        root,
                        testCase.operation,
                        testCase.input ?? {},
                      );
                      assertExpectation(result, testCase.expect, testCase.name);
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
                  );
                  assertExpectation(result, testCase.expect, testCase.name);
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
