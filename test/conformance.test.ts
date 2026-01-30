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

// Path to the spec's test files
const SPEC_TESTS_DIR = path.resolve(
  os.homedir(),
  "projects/mdbase-spec/tests",
);

interface TestSetup {
  config?: string;
  types?: Record<string, string>;
  files?: Record<string, string>;
}

interface TestExpectation {
  valid?: boolean;
  issues?: Array<{ code: string; field?: string; [key: string]: unknown }>;
  error?: { code: string; [key: string]: unknown };
  result?: unknown;
  results?: unknown[];
  count?: number;
  paths?: string[];
  frontmatter?: Record<string, unknown>;
  body?: string;
  links?: unknown[];
  [key: string]: unknown;
}

interface TestCase {
  name: string;
  spec_ref?: string;
  operation: string;
  input: Record<string, unknown>;
  expect: TestExpectation;
}

interface TestGroup {
  name: string;
  level: number;
  category: string;
  spec_ref: string;
  setup: TestSetup;
  tests: TestCase[];
}

/**
 * Materializes a test setup into a temporary directory, returning the path.
 */
function materializeSetup(setup: TestSetup): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdbase-test-"));

  // Write config
  if (setup.config) {
    fs.writeFileSync(path.join(tmpDir, "mdbase.yaml"), setup.config);
  } else {
    fs.writeFileSync(
      path.join(tmpDir, "mdbase.yaml"),
      'spec_version: "0.1.0"\n',
    );
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
function discoverTests(): Map<number, Array<{ file: string; group: TestGroup }>> {
  const levels = new Map<number, Array<{ file: string; group: TestGroup }>>();

  if (!fs.existsSync(SPEC_TESTS_DIR)) {
    return levels;
  }

  for (const levelDir of fs.readdirSync(SPEC_TESTS_DIR).sort()) {
    const levelPath = path.join(SPEC_TESTS_DIR, levelDir);
    if (!fs.statSync(levelPath).isDirectory()) continue;

    const levelMatch = levelDir.match(/^level-(\d+)$/);
    if (!levelMatch) continue;
    const level = parseInt(levelMatch[1], 10);

    const groups: Array<{ file: string; group: TestGroup }> = [];

    for (const file of fs.readdirSync(levelPath).sort()) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const filePath = path.join(levelPath, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const group = yaml.load(content) as TestGroup;
        groups.push({ file, group });
      } catch (err) {
        console.error(`Failed to parse ${filePath}:`, err);
      }
    }

    if (groups.length > 0) {
      levels.set(level, groups);
    }
  }

  return levels;
}

/**
 * Execute a single test operation against the mdbase implementation.
 *
 * This is the bridge between test YAML and the TypeScript API.
 * Each operation maps to a specific mdbase API call.
 */
async function executeOperation(
  collectionRoot: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  // TODO: Import and call the actual mdbase API
  // For now, throw to indicate unimplemented operations
  throw new Error(
    `Operation '${operation}' not yet implemented. ` +
    `Input: ${JSON.stringify(input)}. ` +
    `Collection root: ${collectionRoot}`,
  );
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
          return true;
        });
        expect(match, `${testName}: expected issue ${JSON.stringify(expectedIssue)}`).toBeDefined();
      }
    }
  }

  if (expected.error !== undefined) {
    const actualError = result.error as Record<string, unknown> | undefined;
    expect(actualError, `${testName}: error present`).toBeDefined();
    if (actualError && expected.error.code) {
      expect(actualError.code, `${testName}: error code`).toBe(expected.error.code);
    }
  }

  if (expected.result !== undefined) {
    expect(result.result ?? result, `${testName}: result`).toEqual(expected.result);
  }

  if (expected.results !== undefined) {
    expect(result.results, `${testName}: results`).toBeDefined();
    expect(result.results, `${testName}: results match`).toEqual(expected.results);
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
    expect(result.frontmatter, `${testName}: frontmatter`).toEqual(expected.frontmatter);
  }

  if (expected.body !== undefined) {
    expect(result.body, `${testName}: body`).toBe(expected.body);
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
  for (const [level, groups] of [...allTests.entries()].sort((a, b) => a[0] - b[0])) {
    describe(`Level ${level}`, () => {
      for (const { file, group } of groups) {
        describe(`${group.name} (${file})`, () => {
          let collectionRoot: string;

          beforeAll(() => {
            collectionRoot = materializeSetup(group.setup);
          });

          afterAll(() => {
            if (collectionRoot) {
              cleanupSetup(collectionRoot);
            }
          });

          for (const testCase of group.tests) {
            it(testCase.name, async () => {
              const result = await executeOperation(
                collectionRoot,
                testCase.operation,
                testCase.input,
              );
              assertExpectation(result, testCase.expect, testCase.name);
            });
          }
        });
      }
    });
  }
}
