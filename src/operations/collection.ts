/**
 * Collection - the main entry point for mdbase operations.
 * Ties together config loading, type loading, file reading, and validation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";
import { ulid } from "ulid";
import { loadConfigAsync, MdbaseConfig } from "../config/loader.js";
import { loadTypesAsync, TypeDefinition, FieldDefinition, MatchRules } from "../types/loader.js";
import { parseFileAsync, serializeFile } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../validation/validator.js";
import { MdbaseError } from "../errors.js";
import { evaluateWhere, evaluateExpression, ExpressionError } from "../expressions/evaluator.js";
import { parseLink, extractBodyLinks, ParsedLink } from "../links/parser.js";
import { BacklinkEntry } from "../expressions/evaluator.js";
import { CacheStoreAsync, CachedFile } from "../cache/async-store.js";

function toBoolExternal(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (val === null || val === undefined) return false;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") return val !== "";
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

export interface ReadResult {
  valid?: boolean;
  frontmatter?: Record<string, unknown>;
  rawFrontmatter?: Record<string, unknown>;
  body?: string | null;
  types?: string[];
  file?: Record<string, unknown>;
  warnings?: Array<{ code: string; message: string }>;
  error?: { code: string; message: string };
}

export interface ValidateResult {
  valid: boolean;
  issues: MdbaseError[];
  warnings?: string[];
  error?: { code: string; message: string };
}

export interface CreateResult {
  valid?: boolean;
  frontmatter?: Record<string, unknown>;
  body?: string;
  path?: string;
  error?: { code: string; message: string };
}

export interface UpdateResult {
  valid?: boolean;
  frontmatter?: Record<string, unknown>;
  body?: string;
  error?: { code: string; message: string };
}

export interface DeleteResult {
  valid?: boolean;
  broken_links?: Array<{ path: string }>;
  error?: { code: string; message: string };
}

export interface QueryResult {
  results: Array<{
    path: string;
    frontmatter: Record<string, unknown>;
    types: string[];
    body?: string | null;
  }>;
  meta?: {
    total_count: number;
    has_more?: boolean;
  };
}

export interface BatchResultDetail {
  path: string;
  status: "success" | "failed" | "skipped";
  error?: { code: string; message: string };
}

export interface BatchResult {
  batch_result: {
    total: number;
    succeeded: number;
    failed: number;
    skipped?: number;
    details: BatchResultDetail[];
  };
  broken_links?: Array<{ target: string; referrer: string }>;
  error?: { code: string; message: string };
}

export interface CacheOpResult {
  success: boolean;
  error?: { code: string; message: string };
}

export class Collection {
  private config: MdbaseConfig;
  private typeDefs: Map<string, TypeDefinition>;
  private excludeMatchers: ((str: string) => boolean)[];
  private cache: CacheStoreAsync | null;

  /**
   * Hook called after reading a file but before writing.
   * Used by test runner to simulate concurrent modifications.
   */
  public preWriteHook?: (relativePath: string) => void;

  /**
   * Set of paths that should simulate I/O errors when writing.
   * Used by test runner to simulate I/O failures.
   */
  public ioErrorPaths?: Set<string>;

  /**
   * When true, batch operations skip files that depend on failed files.
   */
  public skipDependents?: boolean;

  constructor(
    private root: string,
    config: MdbaseConfig,
    typeDefs: Map<string, TypeDefinition>,
  ) {
    this.config = config;
    this.typeDefs = typeDefs;
    this.excludeMatchers = config.settings.exclude.flatMap((pattern) => {
      // If the pattern doesn't contain glob characters or /, it's a directory name
      // Match both the directory itself and anything inside it
      if (!pattern.includes("/") && !pattern.includes("*") && !pattern.includes("?")) {
        return [
          picomatch(pattern, { dot: true }),
          picomatch(`${pattern}/**`, { dot: true }),
        ];
      }
      // If it contains no /, use matchBase for basename matching
      if (!pattern.includes("/")) {
        return [picomatch(pattern, { dot: true, matchBase: true })];
      }
      return [picomatch(pattern, { dot: true })];
    });
    this.cache = null;
  }

  static async open(collectionRoot: string): Promise<{ collection?: Collection; error?: { code: string; message: string } }> {
    const configResult = await loadConfigAsync(collectionRoot);
    if (!configResult.valid || !configResult.config) {
      return { error: configResult.error };
    }

    const typesResult = await loadTypesAsync(collectionRoot, configResult.config);
    if (!typesResult.valid) {
      return { error: typesResult.error };
    }

    const collection = new Collection(
      collectionRoot,
      configResult.config,
      typesResult.types!,
    );
    await collection.initCache();
    return { collection };
  }

  private async initCache(): Promise<void> {
    this.cache = await CacheStoreAsync.open(this.root, this.config.settings.cache_folder);
  }

  /**
   * Check if a path is excluded by config.
   */
  private isExcluded(relativePath: string): boolean {
    for (const matcher of this.excludeMatchers) {
      if (matcher(relativePath)) return true;
    }
    // Types folder is always excluded from regular file scan
    if (relativePath.startsWith(this.config.settings.types_folder + "/") ||
        relativePath === this.config.settings.types_folder) {
      return true;
    }
    // Cache folder excluded
    if (relativePath.startsWith(this.config.settings.cache_folder + "/") ||
        relativePath === this.config.settings.cache_folder) {
      return true;
    }
    // Nested collection boundary check: if a subdirectory has mdbase.yaml, don't scan into it
    return false;
  }

  /**
   * Check if a file has a valid markdown extension.
   */
  private isMarkdownFile(filePath: string): boolean {
    const ext = path.extname(filePath).slice(1); // remove dot
    if (ext === "md") return true;
    return this.config.settings.extensions.includes(ext);
  }

  private async fileExists(fullPath: string): Promise<boolean> {
    try {
      await fs.promises.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the file types declared explicitly in frontmatter.
   */
  private getExplicitTypes(frontmatter: Record<string, unknown>): string[] | null {
    // Check array-valued keys first (types takes precedence over type)
    for (const key of this.config.settings.explicit_type_keys) {
      if (key in frontmatter) {
        const val = frontmatter[key];
        if (Array.isArray(val)) {
          return val.map((v) => String(v).toLowerCase());
        }
      }
    }
    // Then check singular string-valued keys
    for (const key of this.config.settings.explicit_type_keys) {
      if (key in frontmatter) {
        const val = frontmatter[key];
        if (typeof val === "string") {
          return [val.toLowerCase()];
        }
      }
    }
    return null;
  }

  /**
   * Get the file types declared in frontmatter (backwards compatible).
   */
  private getFileTypes(frontmatter: Record<string, unknown>): string[] {
    return this.getExplicitTypes(frontmatter) ?? [];
  }

  /**
   * Determine all types for a file, using explicit declarations or match rules.
   * If explicit types are declared, they take precedence and match rules are skipped.
   */
  getTypesForFile(relativePath: string, frontmatter: Record<string, unknown>): string[] {
    // Check for explicit type declaration
    const explicit = this.getExplicitTypes(frontmatter);
    if (explicit !== null) {
      // Explicit types stop all match rule evaluation
      return explicit;
    }

    // Evaluate match rules for all type definitions
    const matchedTypes: string[] = [];
    for (const [typeName, typeDef] of this.typeDefs) {
      if (!typeDef.match) continue;
      if (this.matchesType(relativePath, frontmatter, typeDef.match)) {
        matchedTypes.push(typeName);
      }
    }
    return matchedTypes;
  }

  /**
   * Check if a file matches all conditions in a type's match block.
   * All conditions are AND'd together.
   */
  private matchesType(
    relativePath: string,
    frontmatter: Record<string, unknown>,
    match: MatchRules,
  ): boolean {
    // path_glob
    if (match.path_glob !== undefined) {
      const matcher = picomatch(match.path_glob, { dot: true });
      if (!matcher(relativePath)) return false;
    }

    // fields_present - all listed fields must be present and non-null
    if (match.fields_present !== undefined) {
      for (const field of match.fields_present) {
        if (!(field in frontmatter) || frontmatter[field] === null || frontmatter[field] === undefined) {
          return false;
        }
      }
    }

    // where - all conditions must match
    if (match.where !== undefined) {
      if (!this.matchesWhereConditions(frontmatter, match.where)) return false;
    }

    return true;
  }

  /**
   * Evaluate where conditions from a match block against frontmatter.
   * where is an object where each key is a field name and the value is either:
   *   - a literal value (exact equality)
   *   - an object with operator keys (eq, neq, gt, gte, lt, lte, exists, contains, containsAll, containsAny, startsWith, endsWith, matches)
   */
  private matchesWhereConditions(
    frontmatter: Record<string, unknown>,
    where: Record<string, unknown>,
  ): boolean {
    for (const [field, condition] of Object.entries(where)) {
      const fieldValue = frontmatter[field];

      if (condition === null || condition === undefined) {
        // null condition: field must be null/missing
        if (fieldValue !== null && fieldValue !== undefined) return false;
        continue;
      }

      if (typeof condition !== "object" || Array.isArray(condition)) {
        // Literal value: exact equality
        if (fieldValue === null || fieldValue === undefined) return false;
        if (String(fieldValue) !== String(condition)) return false;
        continue;
      }

      // Object with operators
      const ops = condition as Record<string, unknown>;
      for (const [op, expected] of Object.entries(ops)) {
        if (!this.evalWhereOp(fieldValue, op, expected)) return false;
      }
    }
    return true;
  }

  private evalWhereOp(fieldValue: unknown, op: string, expected: unknown): boolean {
    switch (op) {
      case "eq":
        if (fieldValue === null || fieldValue === undefined) return false;
        return String(fieldValue) === String(expected);
      case "neq":
        if (fieldValue === null || fieldValue === undefined) return true;
        return String(fieldValue) !== String(expected);
      case "gt":
        if (fieldValue === null || fieldValue === undefined) return false;
        return Number(fieldValue) > Number(expected);
      case "gte":
        if (fieldValue === null || fieldValue === undefined) return false;
        return Number(fieldValue) >= Number(expected);
      case "lt":
        if (fieldValue === null || fieldValue === undefined) return false;
        return Number(fieldValue) < Number(expected);
      case "lte":
        if (fieldValue === null || fieldValue === undefined) return false;
        return Number(fieldValue) <= Number(expected);
      case "exists":
        if (expected === true) {
          // Field must be present and non-null
          return fieldValue !== null && fieldValue !== undefined;
        }
        // exists: false — field must be missing or null
        return fieldValue === null || fieldValue === undefined;
      case "contains":
        if (fieldValue === null || fieldValue === undefined) return false;
        if (Array.isArray(fieldValue)) {
          return fieldValue.some((item) => String(item) === String(expected));
        }
        if (typeof fieldValue === "string") {
          return fieldValue.includes(String(expected));
        }
        return false;
      case "containsAll":
        if (!Array.isArray(fieldValue) || !Array.isArray(expected)) return false;
        return expected.every((e) =>
          fieldValue.some((item) => String(item) === String(e)),
        );
      case "containsAny":
        if (!Array.isArray(fieldValue) || !Array.isArray(expected)) return false;
        return expected.some((e) =>
          fieldValue.some((item) => String(item) === String(e)),
        );
      case "startsWith":
        if (fieldValue === null || fieldValue === undefined) return false;
        if (typeof fieldValue === "string") return fieldValue.startsWith(String(expected));
        return false;
      case "endsWith":
        if (fieldValue === null || fieldValue === undefined) return false;
        if (typeof fieldValue === "string") return fieldValue.endsWith(String(expected));
        return false;
      case "matches":
        if (fieldValue === null || fieldValue === undefined) return false;
        try {
          let pattern = String(expected);
          pattern = pattern.replace(/\\\\/g, "\\");
          return new RegExp(pattern).test(String(fieldValue));
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  /**
   * Read a file from the collection.
   */
  async read(relativePath: string): Promise<ReadResult> {
    const normalizedPath = relativePath.replace(/\\/g, "/");
    if (normalizedPath.includes("\0") ||
        path.isAbsolute(relativePath) ||
        normalizedPath.startsWith("/") ||
        normalizedPath.split("/").includes("..")) {
      return {
        error: { code: "invalid_path", message: `Invalid path: ${relativePath}` },
      };
    }

    // Check if excluded
    if (this.isExcluded(relativePath)) {
      return {
        error: { code: "file_not_found", message: `Path is excluded: ${relativePath}` },
      };
    }

    // Check include_subfolders
    if (!this.config.settings.include_subfolders && relativePath.includes("/")) {
      return {
        error: { code: "file_not_found", message: `Subfolders not included: ${relativePath}` },
      };
    }

    // Check if it's a markdown file
    if (!this.isMarkdownFile(relativePath)) {
      return {
        error: { code: "file_not_found", message: `Not a markdown file: ${relativePath}` },
      };
    }

    const fullPath = path.join(this.root, relativePath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      return {
        error: { code: "file_not_found", message: `File not found: ${relativePath}` },
      };
    }

    // Check for nested collection boundary
    const parts = relativePath.split("/");
    for (let i = 1; i < parts.length; i++) {
      const subdir = path.join(this.root, ...parts.slice(0, i));
      try {
        await fs.promises.access(path.join(subdir, "mdbase.yaml"));
        return {
          error: { code: "file_not_found", message: `File is inside nested collection: ${relativePath}` },
        };
      } catch {
        // ok
      }
    }

    // Check for mdbase.yaml - it's not a record
    if (path.basename(relativePath) === "mdbase.yaml") {
      return {
        error: { code: "file_not_found", message: "mdbase.yaml is not a record" },
      };
    }

    let parsed: Awaited<ReturnType<typeof parseFileAsync>>;
    let cached: CachedFile | null = null;
    if (this.cache) {
      cached = await this.cache.getFile(relativePath, stat);
    }
    if (cached) {
      parsed = {
        frontmatter: cached.frontmatter,
        body: cached.body,
        raw: "",
      };
    } else {
      try {
        parsed = await parseFileAsync(fullPath);
      } catch (e: unknown) {
        // YAML parse errors are always errors regardless of validation level
        return {
          error: { code: "invalid_frontmatter", message: (e as Error).message },
        };
      }
    }

    // Handle parse errors
    if (parsed.error) {
      // Fatal YAML syntax errors are always errors regardless of validation level
      if (parsed.fatalError) {
        return { error: parsed.error };
      }
      if (this.config.settings.default_validation === "off") {
        // At "off" level: treat as empty frontmatter, return valid
        const file = {
          name: path.basename(relativePath),
          folder: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
          path: relativePath,
          mtime: stat.mtime.toISOString(),
          size: stat.size,
        };
        return {
          valid: true,
          frontmatter: {},
          body: parsed.body,
          types: [],
          file,
        } as unknown as ReadResult;
      }
      if (this.config.settings.default_validation === "warn") {
        // At "warn" level: treat as empty with warning
        const file = {
          name: path.basename(relativePath),
          folder: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
          path: relativePath,
          mtime: stat.mtime.toISOString(),
          size: stat.size,
        };
        return {
          valid: true,
          frontmatter: {},
          body: parsed.body,
          types: [],
          warnings: [{ code: "invalid_frontmatter", message: parsed.error.message }],
          file,
        } as unknown as ReadResult;
      }
      // At "error" level: return error
      return {
        error: parsed.error,
      };
    }

    const types = this.getTypesForFile(relativePath, parsed.frontmatter);

    // Keep raw frontmatter (before defaults) for hasProperty checks
    const rawFrontmatter = { ...parsed.frontmatter };

    // Apply defaults from type definitions
    const frontmatter = { ...parsed.frontmatter };
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (typeDef?.fields) {
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          if (fieldDef.default !== undefined && !(fieldName in frontmatter)) {
            frontmatter[fieldName] = fieldDef.default;
          }
        }
      }
    }

    // Coerce values based on type definitions
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;

      for (const [key, value] of Object.entries(frontmatter)) {
        if (this.config.settings.explicit_type_keys.includes(key)) continue;
        const fieldDef = typeDef.fields[key];
        if (!fieldDef || value === null || value === undefined) continue;

        frontmatter[key] = coerceForRead(value, fieldDef);
      }
    }

    if (!cached && this.cache) {
      await this.cache.upsertFile(relativePath, stat, parsed.frontmatter, parsed.body ?? "");
    }

    // Coerce remaining Date objects not handled by type definitions
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value instanceof Date) {
        frontmatter[key] = value.toISOString();
      }
    }

    // Evaluate computed fields
    this.evaluateComputedFields(frontmatter, types, relativePath, parsed.body);

    // Get file metadata
    const file = {
      name: path.basename(relativePath),
      folder: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
      path: relativePath,
      mtime: stat.mtime.toISOString(),
      ctime: stat.birthtime.toISOString(),
      size: stat.size,
    };

    return {
      valid: true,
      frontmatter,
      rawFrontmatter,
      body: parsed.body,
      types,
      file,
    };
  }

  /**
   * Evaluate computed fields from type definitions and add to frontmatter.
   * Computed fields are NOT persisted to disk — they exist only in read results.
   * Supports dependency ordering: computed fields can reference other computed fields.
   */
  private evaluateComputedFields(
    frontmatter: Record<string, unknown>,
    types: string[],
    relativePath: string,
    body?: string,
  ): void {
    // Collect all computed fields from types
    const computedDefs: Map<string, string> = new Map();
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.computed) {
          computedDefs.set(fieldName, fieldDef.computed);
        }
      }
    }
    if (computedDefs.size === 0) return;

    // Resolve in dependency order (simple: iterate multiple times until stable)
    const resolved = new Map<string, unknown>();
    const maxPasses = computedDefs.size + 1;
    for (let pass = 0; pass < maxPasses; pass++) {
      let progress = false;
      for (const [fieldName, expr] of computedDefs) {
        if (resolved.has(fieldName)) continue;
        try {
          const result = evaluateExpression(expr, {
            frontmatter: { ...frontmatter, ...Object.fromEntries(resolved) },
            path: relativePath,
            types,
            body,
            computedFields: resolved,
          });
          resolved.set(fieldName, result);
          progress = true;
        } catch {
          // May fail if dependencies not yet resolved, try again next pass
        }
      }
      if (!progress) break;
    }

    // Add resolved computed values to frontmatter
    for (const [fieldName, value] of resolved) {
      frontmatter[fieldName] = value;
    }
  }

  /**
   * Validate a single file or the entire collection.
   */
  async validate(relativePath?: string): Promise<ValidateResult> {
    if (relativePath) {
      return await this.validateFile(relativePath);
    }
    return await this.validateCollection();
  }

  private async validateFile(relativePath: string): Promise<ValidateResult> {
    const readResult = await this.read(relativePath);
    if (readResult.error) {
      return {
        valid: false,
        issues: [{
          code: readResult.error.code,
          message: readResult.error.message,
          path: relativePath,
          severity: "error",
        }],
        error: readResult.error,
      };
    }

    const types = readResult.types ?? [];
    const frontmatter = readResult.frontmatter ?? {};

    // Check for unknown types
    const typeDefs: TypeDefinition[] = [];
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef) {
        return {
          valid: false,
          issues: [{
            code: "unknown_type",
            message: `Unknown type "${typeName}"`,
            severity: "error",
          }],
        };
      }
      typeDefs.push(typeDef);
    }

    const result = validateFrontmatter(frontmatter, typeDefs, this.config);
    // Add path to all issues
    for (const issue of result.issues) {
      if (!issue.path) {
        issue.path = relativePath;
      }
    }

    // Check path_pattern (filename_pattern) match — emit warning if mismatch
    for (const typeDef of typeDefs) {
      if (!typeDef.path_pattern) continue;
      const pattern = typeDef.path_pattern;
      // Expand {field} placeholders using frontmatter values
      const expectedFilename = pattern.replace(/\{(\w+)\}/g, (_, key) => {
        const val = frontmatter[key];
        return val !== null && val !== undefined ? String(val) : "";
      });
      const actualFilename = path.basename(relativePath);
      if (actualFilename !== expectedFilename) {
        result.issues.push({
          code: "filename_mismatch",
          message: `File "${actualFilename}" does not match expected pattern "${expectedFilename}" from type "${typeDef.name}"`,
          path: relativePath,
          severity: "warning",
        });
      }
    }

    // Check link fields: validate_exists, target constraint, ambiguous_link
    await this.validateLinkFields(typeDefs, frontmatter, relativePath, result);

    // Check cross-file uniqueness for this file
    const uniqueFields = new Set<string>();
    for (const typeDef of typeDefs) {
      if (!typeDef.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.unique) uniqueFields.add(fieldName);
      }
    }
    if (uniqueFields.size > 0) {
      const files = await this.scanFiles();
      for (const fieldName of uniqueFields) {
        const myValue = frontmatter[fieldName];
        if (myValue === null || myValue === undefined) continue;
        for (const otherPath of files) {
          if (otherPath === relativePath) continue;
          const otherResult = await this.read(otherPath);
          if (otherResult.frontmatter) {
            const otherValue = otherResult.frontmatter[fieldName];
            if (otherValue !== null && otherValue !== undefined &&
                JSON.stringify(myValue) === JSON.stringify(otherValue)) {
              result.issues.push({
                code: "duplicate_value",
                message: `Duplicate value for unique field "${fieldName}"`,
                field: fieldName,
                path: relativePath,
                severity: "error",
              });
              result.valid = false;
              break;
            }
          }
        }
      }
    }

    return result;
  }

  private async validateCollection(): Promise<ValidateResult> {
    const allIssues: MdbaseError[] = [];
    const allFiles = new Map<string, Record<string, unknown>>();

    // Scan all files
    const files = await this.scanFiles();
    for (const relativePath of files) {
      const readResult = await this.read(relativePath);
      if (readResult.frontmatter) {
        allFiles.set(relativePath, readResult.frontmatter);
      }
    }

    // Validate each file
    for (const [relativePath, frontmatter] of allFiles) {
      const types = this.getTypesForFile(relativePath, frontmatter);
      const typeDefs: TypeDefinition[] = [];
      for (const typeName of types) {
        const typeDef = this.typeDefs.get(typeName);
        if (typeDef) {
          typeDefs.push(typeDef);
        } else {
          allIssues.push({
            code: "unknown_type",
            message: `Unknown type "${typeName}" in ${relativePath}`,
            path: relativePath,
            severity: "error",
          });
        }
      }

      if (typeDefs.length > 0) {
        const result = validateFrontmatter(frontmatter, typeDefs, this.config);
        for (const issue of result.issues) {
          allIssues.push({ ...issue, path: issue.path ?? relativePath });
        }
      }
    }

    // Check cross-file constraints (unique, id uniqueness)
    this.checkCrossFileConstraints(allFiles, allIssues);

    const hasErrors = allIssues.some((i) => i.severity === "error" || !i.severity);
    return {
      valid: !hasErrors,
      issues: allIssues,
    };
  }

  private checkCrossFileConstraints(
    allFiles: Map<string, Record<string, unknown>>,
    issues: MdbaseError[],
  ): void {
    // Check unique field constraints
    for (const [, typeDef] of this.typeDefs) {
      if (!typeDef.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.unique) {
          const seen = new Map<string, string>();
          for (const [filePath, frontmatter] of allFiles) {
            const value = frontmatter[fieldName];
            if (value === null || value === undefined) continue;
            const key = JSON.stringify(value);
            if (seen.has(key)) {
              issues.push({
                code: "duplicate_value",
                message: `Duplicate value for unique field "${fieldName}"`,
                field: fieldName,
                path: filePath,
                severity: "error",
              });
            } else {
              seen.set(key, filePath);
            }
          }
        }
      }
    }

    // Check id_field uniqueness
    const idField = this.config.settings.id_field;
    const seen = new Map<string, string>();
    for (const [filePath, frontmatter] of allFiles) {
      const value = frontmatter[idField];
      if (value === null || value === undefined) continue;
      const key = JSON.stringify(value);
      if (seen.has(key)) {
        issues.push({
          code: "duplicate_id",
          message: `Duplicate id "${value}"`,
          field: idField,
          path: filePath,
          severity: "error",
        });
      } else {
        seen.set(key, filePath);
      }
    }
  }

  /**
   * Create a new file in the collection.
   */
  async create(input: {
    type?: string;
    types?: string[];
    path?: string;
    frontmatter?: Record<string, unknown>;
    body?: string;
  }): Promise<CreateResult> {
    // Determine types from input parameters or frontmatter
    const typeNames: string[] = [];
    if (input.type) typeNames.push(input.type.toLowerCase());
    if (input.types) typeNames.push(...input.types.map((t) => t.toLowerCase()));
    // Also detect types from frontmatter if not explicitly provided
    if (typeNames.length === 0 && input.frontmatter) {
      const inferred = this.getFileTypes(input.frontmatter);
      typeNames.push(...inferred);
    }

    // Check for unknown types
    for (const typeName of typeNames) {
      if (!this.typeDefs.has(typeName)) {
        return {
          error: { code: "unknown_type", message: `Unknown type "${typeName}"` },
        };
      }
    }

    // Build frontmatter
    const frontmatter: Record<string, unknown> = { ...(input.frontmatter ?? {}) };

    // Set the type key (only if explicit_type_keys is configured)
    if (this.config.settings.explicit_type_keys.length > 0) {
      if (typeNames.length === 1) {
        const typeKey = this.config.settings.explicit_type_keys[0];
        if (!(typeKey in frontmatter)) {
          frontmatter[typeKey] = typeNames[0];
        }
      } else if (typeNames.length > 1) {
        const typesKey = this.config.settings.explicit_type_keys.find((k) => k.endsWith("s")) ??
                         this.config.settings.explicit_type_keys[0];
        if (!(typesKey in frontmatter)) {
          frontmatter[typesKey] = typeNames;
        }
      }
    }

    // Track which fields are default-only (not user-provided, not generated)
    const defaultOnlyFields = new Set<string>();

    // Apply generated fields and defaults (before path derivation so generated values are available in path_pattern)
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;

      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldName in frontmatter && frontmatter[fieldName] !== undefined) continue;

        if (fieldDef.generated) {
          const generated = this.generateValue(fieldDef, frontmatter);
          if (generated !== undefined && generated !== null) {
            frontmatter[fieldName] = generated;
          } else if (fieldDef.default !== undefined) {
            // Generated yielded null/undefined, apply default as effective value
            frontmatter[fieldName] = fieldDef.default;
            defaultOnlyFields.add(fieldName);
          } else {
            // Generated field with missing source produces null
            frontmatter[fieldName] = null;
          }
        } else if (fieldDef.default !== undefined && !(fieldName in frontmatter)) {
          frontmatter[fieldName] = fieldDef.default;
          defaultOnlyFields.add(fieldName);
        }
      }
    }

    // Derive path from filename_pattern if not provided
    let relativePath = input.path;
    if (!relativePath) {
      // Try filename_pattern from type definitions
      let pattern: string | undefined;
      for (const typeName of typeNames) {
        const typeDef = this.typeDefs.get(typeName);
        if (typeDef?.path_pattern) {
          pattern = typeDef.path_pattern;
          break;
        }
      }
      if (!pattern) {
        return {
          error: { code: "path_required", message: "No path provided and no filename_pattern defined" },
        };
      }
      // Simple template replacement using enriched frontmatter (includes generated fields)
      let unresolvedKey: string | undefined;
      relativePath = pattern.replace(/\{(\w+)\}/g, (_, key) => {
        const val = frontmatter[key];
        if (val == null || String(val) === "") {
          unresolvedKey ??= key;
          return key; // placeholder, won't be used
        }
        return String(val);
      });
      if (unresolvedKey) {
        return {
          error: { code: "path_required", message: `Cannot derive path: field "${unresolvedKey}" has no value for path_pattern "${pattern}"` },
        };
      }
    }

    // Path validation: traversal, null bytes, and invalid characters
    if (relativePath.includes("..") || relativePath.includes("\0")) {
      return {
        error: { code: "invalid_path", message: `Invalid path: ${relativePath}` },
      };
    }

    // Check if file already exists
    const fullPath = path.join(this.root, relativePath);
    if (await this.fileExists(fullPath)) {
      return {
        error: { code: "path_conflict", message: `File already exists: ${relativePath}` },
      };
    }

    // Coerce values based on type definitions
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [key, value] of Object.entries(frontmatter)) {
        if (this.config.settings.explicit_type_keys.includes(key)) continue;
        const fieldDef = typeDef.fields[key];
        if (!fieldDef || value === null || value === undefined) continue;
        frontmatter[key] = coerceForRead(value, fieldDef);
      }
    }

    // Build the effective frontmatter (includes defaults) and the disk frontmatter
    const effectiveFrontmatter = { ...frontmatter };
    const diskFrontmatter: Record<string, unknown> = {};
    if (this.config.settings.write_defaults) {
      Object.assign(diskFrontmatter, frontmatter);
    } else {
      for (const [key, value] of Object.entries(frontmatter)) {
        if (!defaultOnlyFields.has(key)) {
          diskFrontmatter[key] = value;
        }
      }
    }

    // Verify created file will satisfy match rules for explicit types
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (typeDef?.match) {
        if (!this.matchesType(relativePath, effectiveFrontmatter, typeDef.match)) {
          return {
            error: { code: "match_failed", message: `Created file would not satisfy match rules for type "${typeName}"` },
          };
        }
      }
    }

    // Validate the effective frontmatter (includes defaults)
    if (this.config.settings.default_validation !== "off") {
      const typeDefs = typeNames.map((t) => this.typeDefs.get(t)!).filter(Boolean);
      const valResult = validateFrontmatter(effectiveFrontmatter, typeDefs, this.config);
      if (!valResult.valid) {
        // At "error" level: always reject. At "warn" level: reject if there are error-severity issues
        const hasErrors = valResult.issues.some((i) => i.severity === "error" || !i.severity);
        if (this.config.settings.default_validation === "error" || hasErrors) {
          return {
            valid: false,
            error: { code: "validation_failed", message: "Validation failed on create" },
            issues: valResult.issues,
          } as unknown as CreateResult;
        }
      }
    }

    // Collect warnings (e.g. deprecated fields)
    const warnings: string[] = [];
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.deprecated && fieldName in frontmatter &&
            frontmatter[fieldName] !== null && frontmatter[fieldName] !== undefined) {
          warnings.push(`Field "${fieldName}" is deprecated`);
        }
      }
    }

    // Write file - only disk frontmatter (no default-only fields)
    const body = input.body ?? "";
    const content = serializeFile(
      diskFrontmatter,
      body,
      this.config.settings.write_nulls,
      this.config.settings.write_empty_lists,
    );
    // Call pre-write hook (for testing concurrent modifications)
    if (this.preWriteHook) {
      this.preWriteHook(relativePath);
    }

    // Check if file appeared concurrently after initial check
    if (await this.fileExists(fullPath)) {
      return {
        error: { code: "path_conflict", message: `File appeared concurrently: ${relativePath}` },
      } as unknown as CreateResult;
    }

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content);
    await this.updateCacheForPath(relativePath);

    const result: Record<string, unknown> = {
      valid: true,
      frontmatter: effectiveFrontmatter,
      body,
      path: relativePath,
      types: typeNames,
    };
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    return result as unknown as CreateResult;
  }

  /**
   * Update an existing file in the collection.
   */
  async update(input: {
    path: string;
    fields?: Record<string, unknown>;
    body?: string;
  }): Promise<UpdateResult> {
    const relativePath = input.path;
    const fullPath = path.join(this.root, relativePath);

    if (!await this.fileExists(fullPath)) {
      return {
        error: { code: "file_not_found", message: `File not found: ${relativePath}` },
      };
    }

    // Record mtime for concurrency check
    const readMtime = (await fs.promises.stat(fullPath)).mtimeMs;

    const existing = await parseFileAsync(fullPath);
    const frontmatter: Record<string, unknown> = { ...existing.frontmatter };

    // Apply field updates
    if (input.fields) {
      Object.assign(frontmatter, input.fields);
    }

    // Determine types
    const types = this.getFileTypes(frontmatter);

    // Coerce values based on type definitions
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [key, value] of Object.entries(frontmatter)) {
        if (this.config.settings.explicit_type_keys.includes(key)) continue;
        const fieldDef = typeDef.fields[key];
        if (!fieldDef || value === null || value === undefined) continue;
        frontmatter[key] = coerceForRead(value, fieldDef);
      }
    }

    // Apply now_on_write generated fields
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;

      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.generated === "now_on_write") {
          frontmatter[fieldName] = new Date().toISOString();
        }
      }
    }

    // Validate before writing (if validation is not off)
    if (this.config.settings.default_validation !== "off") {
      const typeDefs = types.map((t) => this.typeDefs.get(t)!).filter(Boolean);
      if (typeDefs.length > 0) {
        const valResult = validateFrontmatter(frontmatter, typeDefs, this.config);
        if (!valResult.valid && this.config.settings.default_validation === "error") {
          return {
            error: { code: "validation_failed", message: "Validation failed on update" },
            issues: valResult.issues,
          } as unknown as UpdateResult;
        }
      }

      // Check cross-file uniqueness constraints on update
      const uniqueIssues = await this.checkUpdateUniqueness(relativePath, frontmatter, types);
      if (uniqueIssues.length > 0 && this.config.settings.default_validation === "error") {
        return {
          error: { code: "validation_failed", message: "Uniqueness constraint violated on update" },
          issues: uniqueIssues,
        } as unknown as UpdateResult;
      }
    }

    // Build effective frontmatter with defaults re-applied for null/missing fields
    const effectiveFrontmatter = { ...frontmatter };
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.default !== undefined) {
          if (!(fieldName in effectiveFrontmatter) ||
              effectiveFrontmatter[fieldName] === null ||
              effectiveFrontmatter[fieldName] === undefined) {
            effectiveFrontmatter[fieldName] = fieldDef.default;
          }
        }
      }
    }

    // Collect warnings (e.g. deprecated fields)
    const warnings: string[] = [];
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.deprecated && fieldName in frontmatter &&
            frontmatter[fieldName] !== null && frontmatter[fieldName] !== undefined) {
          warnings.push(`Field "${fieldName}" is deprecated`);
        }
      }
    }

    // Strip computed fields from disk frontmatter
    const diskFrontmatter = { ...frontmatter };
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.computed) {
          delete diskFrontmatter[fieldName];
        }
      }
    }

    // Write file — use the disk frontmatter (without computed or default-only fields)
    const body = input.body ?? existing.body;
    const content = serializeFile(
      diskFrontmatter,
      body,
      this.config.settings.write_nulls,
      this.config.settings.write_empty_lists,
    );

    // Call pre-write hook (for testing concurrent modifications)
    if (this.preWriteHook) {
      this.preWriteHook(relativePath);
    }

    // Concurrency check: verify mtime hasn't changed since read
    const writeMtime = (await fs.promises.stat(fullPath)).mtimeMs;
    if (writeMtime !== readMtime) {
      return {
        error: { code: "concurrent_modification", message: `File "${relativePath}" was modified externally during update` },
      } as unknown as UpdateResult;
    }

    await fs.promises.writeFile(fullPath, content);
    await this.updateCacheForPath(relativePath);

    // Evaluate computed fields on the effective frontmatter for the return value
    this.evaluateComputedFields(effectiveFrontmatter, types, relativePath, body);

    const result: Record<string, unknown> = {
      valid: true,
      frontmatter: effectiveFrontmatter,
      body,
    };
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    return result as unknown as UpdateResult;
  }

  /**
   * Delete a file from the collection.
   */
  async delete(relativePath: string, input?: { check_backlinks?: boolean }): Promise<DeleteResult> {
    const fullPath = path.join(this.root, relativePath);
    if (!await this.fileExists(fullPath)) {
      return {
        error: { code: "file_not_found", message: `File not found: ${relativePath}` },
      };
    }

    const checkBacklinks = input?.check_backlinks !== false;
    const brokenLinks = checkBacklinks ? await this.findBacklinks([relativePath]) : [];

    // Record mtime for concurrency check
    const readMtime = (await fs.promises.stat(fullPath)).mtimeMs;

    // Call pre-write hook (for testing concurrent modifications)
    if (this.preWriteHook) {
      this.preWriteHook(relativePath);
    }

    // Concurrency check
    const writeMtime = (await fs.promises.stat(fullPath)).mtimeMs;
    if (writeMtime !== readMtime) {
      return {
        error: { code: "concurrent_modification", message: `File "${relativePath}" was modified externally during delete` },
      };
    }

    await fs.promises.unlink(fullPath);
    if (this.cache) {
      await this.cache.deleteFile(relativePath);
    }
    const result: DeleteResult = { valid: true };
    if (checkBacklinks) {
      result.broken_links = brokenLinks.map((entry) => ({ path: entry.referrer }));
    }
    return result;
  }

  /**
   * Create a new type definition file.
   */
  async createType(input: {
    name: string;
    description?: string;
    extends?: string;
    parent?: string;
    strict?: boolean | "warn";
    fields?: Record<string, unknown>;
    path_pattern?: string;
  }): Promise<{ valid?: boolean; error?: { code: string; message: string }; type?: Record<string, unknown> }> {
    const name = input.name.toLowerCase();

    // Validate type name
    if (name.startsWith("_")) {
      return {
        valid: false,
        error: {
          code: "invalid_type_definition",
          message: `Type name "${name}" is reserved (starts with underscore)`,
        },
      };
    }
    const RESERVED = new Set(["file", "formula", "this"]);
    if (RESERVED.has(name)) {
      return {
        valid: false,
        error: {
          code: "invalid_type_definition",
          message: `Type name "${name}" is a reserved keyword`,
        },
      };
    }
    const TYPE_NAME_REGEX = /^[a-z][a-z0-9_-]*$/;
    if (!TYPE_NAME_REGEX.test(name) || name.length > 64) {
      return {
        valid: false,
        error: {
          code: "invalid_type_definition",
          message: `Type name "${name}" is invalid`,
        },
      };
    }

    // Validate field types
    const VALID_FIELD_TYPES = new Set([
      "string", "integer", "number", "boolean", "date", "datetime",
      "time", "enum", "list", "object", "any", "link",
    ]);
    if (input.fields) {
      for (const [fieldName, fieldDef] of Object.entries(input.fields)) {
        const fd = fieldDef as Record<string, unknown>;
        if (fd.type && !VALID_FIELD_TYPES.has(String(fd.type))) {
          return {
            valid: false,
            error: {
              code: "invalid_type_definition",
              message: `Invalid field type "${fd.type}" for field "${fieldName}"`,
            },
          };
        }
      }
    }

    // Validate parent/extends reference
    const parentType = input.extends ?? input.parent;
    if (parentType) {
      if (!this.typeDefs.has(parentType.toLowerCase())) {
        return {
          valid: false,
          error: {
            code: "missing_parent_type",
            message: `Parent type "${parentType}" does not exist`,
          },
        };
      }
    }

    // Build the type definition frontmatter
    const typeFrontmatter: Record<string, unknown> = { name };
    if (input.description) typeFrontmatter.description = input.description;
    if (parentType) typeFrontmatter.extends = parentType;
    if (input.strict !== undefined) typeFrontmatter.strict = input.strict;
    if (input.fields) typeFrontmatter.fields = input.fields;
    if (input.path_pattern) typeFrontmatter.path_pattern = input.path_pattern;

    // Write the type file
    const typesFolder = path.join(this.root, this.config.settings.types_folder);
    await fs.promises.mkdir(typesFolder, { recursive: true });
    const typeFilePath = path.join(typesFolder, `${name}.md`);

    if (await this.fileExists(typeFilePath)) {
      return {
        valid: false,
        error: {
          code: "path_conflict",
          message: `Type file already exists: ${name}.md`,
        },
      };
    }

    const content = serializeFile(typeFrontmatter, "", "omit", true);
    await fs.promises.mkdir(typesFolder, { recursive: true });
    await fs.promises.writeFile(typeFilePath, content);

    return {
      valid: true,
      type: typeFrontmatter,
    };
  }

  /**
   * Pre-ref-update hook for testing concurrent modifications during reference updates.
   */
  preRefUpdateHook?: (refPath: string) => void;

  /**
   * Rename/move a file in the collection, optionally updating references.
   */
  async rename(input: {
    from: string;
    to: string;
    update_refs?: boolean;
  }): Promise<Record<string, unknown>> {
    const fromPath = path.join(this.root, input.from);
    const toPath = path.join(this.root, input.to);

    if (!await this.fileExists(fromPath)) {
      return {
        error: { code: "file_not_found", message: `Source not found: ${input.from}` },
      };
    }

    if (await this.fileExists(toPath)) {
      return {
        error: { code: "path_conflict", message: `Target exists: ${input.to}` },
      };
    }

    // Path validation
    if (input.to.includes("..") || input.to.includes("\0")) {
      return {
        error: { code: "invalid_path", message: `Invalid path: ${input.to}` },
      };
    }

    // Record mtime for concurrency check
    const readMtime = (await fs.promises.stat(fromPath)).mtimeMs;

    // Call pre-write hook (for testing concurrent modifications)
    if (this.preWriteHook) {
      this.preWriteHook(input.from);
    }

    // Concurrency check: source file modified?
    const writeMtime = (await fs.promises.stat(fromPath)).mtimeMs;
    if (writeMtime !== readMtime) {
      return {
        error: { code: "concurrent_modification", message: `Source file "${input.from}" was modified externally during rename` },
      };
    }

    // Check if target appeared concurrently
    if (await this.fileExists(toPath)) {
      return {
        error: { code: "path_conflict", message: `Target appeared concurrently: ${input.to}` },
      };
    }

    await fs.promises.mkdir(path.dirname(toPath), { recursive: true });
    await fs.promises.rename(fromPath, toPath);
    if (this.cache) {
      await this.cache.deleteFile(input.from);
      await this.updateCacheForPath(input.to);
    }

    // Determine if we should update references
    const shouldUpdateRefs = input.update_refs !== undefined
      ? input.update_refs
      : this.config.settings.rename_update_refs;

    if (!shouldUpdateRefs) {
      return { valid: true, from: input.from, to: input.to };
    }

    // Update references across the collection
    return await this.updateReferencesAfterRename(input.from, input.to);
  }

  /**
   * After a file has been renamed, find and update all references to it.
   */
  private async updateReferencesAfterRename(
    oldPath: string,
    newPath: string,
  ): Promise<Record<string, unknown>> {
    const files = await this.scanFiles();
    const fileCache = await this.buildFileCache(files);
    const allFiles = await this.scanAllFiles();
    const nonMdSet = this.buildNonMarkdownSet(allFiles);
    const referencesUpdated: Array<{ path: string; field?: string; location?: string }> = [];
    const warnings: Array<{ path: string; message_contains?: string; message?: string }> = [];
    const partialFailures: Array<{ path: string; reason: string }> = [];

    // Get old and new file basenames (without extension) for wikilink matching
    const oldBase = path.basename(oldPath, path.extname(oldPath));
    const newBase = path.basename(newPath, path.extname(newPath));
    const oldNoExt = oldPath.replace(/\.(md|markdown)$/, "");
    const newNoExt = newPath.replace(/\.(md|markdown)$/, "");

    // Check if the renamed file's id_field is still the same
    // (if so, id-based links don't need rewriting)
    const idField = this.config.settings.id_field;
    let renamedFileId: string | undefined;
    if (idField) {
      const readResult = fileCache.get(newPath);
      if (readResult && !readResult.error && readResult.frontmatter) {
        const idVal = readResult.frontmatter[idField];
        if (typeof idVal === "string") {
          renamedFileId = idVal;
        }
      }
    }

    for (const filePath of files) {
      const fullPath = path.join(this.root, filePath);
      const readResult = fileCache.get(filePath);
      if (!readResult || readResult.error) continue;
      const frontmatter = readResult.frontmatter ?? {};
      const types = readResult.types ?? [];
      const body = readResult.body ?? "";

      let fmUpdated = false;
      let bodyUpdated = false;
      const fmUpdatedFields: string[] = [];
      const updatedFm = { ...frontmatter };

      // Check frontmatter link fields
      for (const typeName of types) {
        const typeDef = this.typeDefs.get(typeName);
        if (!typeDef?.fields) continue;
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          const value = frontmatter[fieldName];
          if (value === null || value === undefined) continue;

          if (fieldDef.type === "link" && typeof value === "string") {
            // ID-based link stability: if id_field is explicitly configured,
            // the link field has a target constraint, and the link is a simple-name
            // wikilink matching the renamed file's ID, skip the update (§12.5 rule 3)
            const fieldTarget = (fieldDef as unknown as Record<string, unknown>).target as string | undefined;
            if (fieldTarget && renamedFileId && this.config.settings.id_field_explicit && this.isIdStableLink(value, renamedFileId)) {
              continue;
            }
            const result = this.updateLinkValue(value, oldPath, newPath, oldBase, newBase, oldNoExt, newNoExt, filePath, renamedFileId, files, fileCache, nonMdSet);
            if (result.warning) {
              warnings.push({ path: filePath, message_contains: "ambiguous", message: result.warning });
            } else if (result.updated && result.newValue !== value) {
              updatedFm[fieldName] = result.newValue;
              fmUpdated = true;
              fmUpdatedFields.push(fieldName);
            }
          } else if (fieldDef.type === "list" && fieldDef.items?.type === "link" && Array.isArray(value)) {
            const itemTarget = (fieldDef.items as unknown as Record<string, unknown>).target as string | undefined;
            const newList = [...value];
            let listUpdated = false;
            for (let i = 0; i < newList.length; i++) {
              const item = newList[i];
              if (typeof item !== "string") continue;
              // ID-based link stability for list items
              if (itemTarget && renamedFileId && this.config.settings.id_field_explicit && this.isIdStableLink(item, renamedFileId)) {
                continue;
              }
              const result = this.updateLinkValue(item, oldPath, newPath, oldBase, newBase, oldNoExt, newNoExt, filePath, renamedFileId, files, fileCache, nonMdSet);
              if (result.warning) {
                warnings.push({ path: filePath, message_contains: "ambiguous", message: result.warning });
              } else if (result.updated && result.newValue !== item) {
                newList[i] = result.newValue;
                listUpdated = true;
                fmUpdatedFields.push(`${fieldName}[${i}]`);
              }
            }
            if (listUpdated) {
              updatedFm[fieldName] = newList;
              fmUpdated = true;
            }
          }
        }
      }

      // Check body links
      const newBody = this.updateBodyLinks(body, oldPath, newPath, oldBase, newBase, oldNoExt, newNoExt, filePath, renamedFileId, files, fileCache, nonMdSet);
      if (newBody !== body) {
        bodyUpdated = true;
      }

      // Write updates if needed
      if (fmUpdated || bodyUpdated) {
        // Record mtime before potential hook
        const beforeHookMtime = (await fs.promises.stat(fullPath)).mtimeMs;

        // Call pre-ref-update hook (for concurrent modification simulation)
        if (this.preRefUpdateHook) {
          this.preRefUpdateHook(filePath);
        }

        // Concurrency check on referring file
        const currentMtime = (await fs.promises.stat(fullPath)).mtimeMs;
        if (currentMtime !== beforeHookMtime) {
          // File was modified externally during ref update
          partialFailures.push({ path: filePath, reason: "concurrent_modification" });
          continue;
        }

        // Write the updated file
        try {
          const updatedContent = serializeFile(
            fmUpdated ? updatedFm : frontmatter,
            bodyUpdated ? newBody : body,
            this.config.settings.write_nulls,
            this.config.settings.write_empty_lists,
          );
          await fs.promises.writeFile(fullPath, updatedContent);
          await this.updateCacheForPath(filePath);

          for (const field of fmUpdatedFields) {
            referencesUpdated.push({ path: filePath, field });
          }
          if (bodyUpdated) {
            referencesUpdated.push({ path: filePath, location: "body" });
          }
        } catch {
          partialFailures.push({ path: filePath, reason: "write_error" });
        }
      }
    }

    const result: Record<string, unknown> = {
      valid: true,
      from: oldPath,
      to: newPath,
      references_updated: referencesUpdated,
    };

    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    if (partialFailures.length > 0) {
      result.error = {
        code: "rename_ref_update_failed",
        message: `Rename succeeded but ${partialFailures.length} reference update(s) failed`,
      };
      result.partial_updates = { failed: partialFailures };
    }

    return result;
  }

  /**
   * Check if a link is a simple-name wikilink that matches an ID value.
   * Used for ID-based link stability during rename (§12.5 rule 3).
   */
  private isIdStableLink(linkValue: string, idValue: string): boolean {
    try {
      const parsed = parseLink(linkValue);
      if (!parsed || parsed.format !== "wikilink") return false;
      const target = parsed.target;
      // Must be a simple name (no path separators, no relative prefixes)
      if (target.includes("/") || target.startsWith("./") || target.startsWith("../")) return false;
      return target === idValue;
    } catch {
      return false;
    }
  }

  /**
   * Check if a link value references the old path and compute the new value.
   * Preserves link style (wikilink, markdown link, bare path).
   */
  private updateLinkValue(
    linkValue: string,
    oldPath: string,
    newPath: string,
    oldBase: string,
    newBase: string,
    oldNoExt: string,
    newNoExt: string,
    fromFile: string,
    renamedFileId?: string,
    knownFiles?: string[],
    knownFileCache?: Map<string, ReadResult>,
    nonMarkdownFiles?: Set<string>,
  ): { updated: boolean; newValue: string; warning?: string } {
    let parsed: ParsedLink | null;
    try {
      parsed = parseLink(linkValue);
    } catch {
      return { updated: false, newValue: linkValue };
    }
    if (!parsed) {
      return { updated: false, newValue: linkValue };
    }

    // Determine if this link references the old path
    const resolution = this.resolveLinkFullWithFiles(linkValue, fromFile, knownFiles ?? [], undefined, knownFileCache, nonMarkdownFiles);

    // Check if the link references the old path
    const target = parsed.target;
    const normalizedTarget = this.normalizeLinkTarget(target);

    // Direct text matching
    const matchesOld = (
      normalizedTarget === oldBase ||
      normalizedTarget === oldPath ||
      normalizedTarget === oldNoExt ||
      target === oldPath ||
      target === oldNoExt
    );

    // Resolve the relative link target to an absolute collection path
    let resolvedOldTarget: string | undefined;
    if (parsed.format === "markdown" || parsed.format === "path") {
      const fromDir = path.dirname(fromFile);
      const resolved = path.normalize(path.join(fromDir, target)).replace(/\\/g, "/");
      if (resolved === oldPath || resolved === oldNoExt || resolved + ".md" === oldPath) {
        resolvedOldTarget = oldPath;
      }
    }

    // Also check via resolution: if the link now resolves to the new path, it was referencing the old file
    const resolvesToNew = resolution.resolved === newPath;

    if (!matchesOld && !resolvedOldTarget && !resolvesToNew) {
      return { updated: false, newValue: linkValue };
    }

    // Check for ambiguous resolution
    if (resolution.ambiguous) {
      return { updated: false, newValue: linkValue, warning: `ambiguous link '${linkValue}' not updated` };
    }

    // Check if the link is ambiguous because other files also match the same simple name
    // (the original link was ambiguous before the rename)
    if (parsed.format === "wikilink" && !target.includes("/") && !target.startsWith("./") && !target.startsWith("../")) {
      const files = knownFiles ?? [];
      const matchingFiles = files.filter((f) => {
        const base = path.basename(f, path.extname(f));
        return base === normalizedTarget && f !== newPath;
      });
      if (matchingFiles.length > 0) {
        // The link was ambiguous before rename — don't update
        return { updated: false, newValue: linkValue, warning: `ambiguous link '${linkValue}' not updated` };
      }
    }

    // Compute new link value preserving style
    if (parsed.format === "wikilink") {
      return this.updateWikilink(linkValue, parsed, oldPath, newPath, oldBase, newBase, fromFile);
    } else if (parsed.format === "markdown") {
      return this.updateMarkdownLink(linkValue, parsed, oldPath, newPath, fromFile);
    } else {
      // Bare path
      return this.updateBarePath(linkValue, parsed, oldPath, newPath, fromFile);
    }
  }

  private updateWikilink(
    _linkValue: string,
    parsed: ParsedLink,
    oldPath: string,
    newPath: string,
    _oldBase: string,
    newBase: string,
    _fromFile: string,
  ): { updated: boolean; newValue: string } {
    const target = parsed.target;
    // Determine new target
    let newTarget: string;
    if (target.includes("/")) {
      // Path-style wikilink: use the new path without extension
      newTarget = newPath.replace(/\.(md|markdown)$/, "");
    } else {
      // Simple name wikilink: check if file moved to a different folder
      const oldDir = path.dirname(oldPath);
      const newDir = path.dirname(newPath);
      if (oldDir !== newDir) {
        // Cross-folder move: upgrade to path-based wikilink
        newTarget = newPath.replace(/\.(md|markdown)$/, "");
      } else {
        // Same folder: use just the new basename
        newTarget = newBase;
      }
    }

    // Rebuild wikilink with anchor and alias preserved
    let result = "[[" + newTarget;
    if (parsed.anchor) result += "#" + parsed.anchor;
    if (parsed.alias) result += "|" + parsed.alias;
    result += "]]";

    // Handle embed prefix
    if ((parsed as unknown as Record<string, unknown>).is_embed) {
      result = "!" + result;
    }

    return { updated: true, newValue: result };
  }

  private updateMarkdownLink(
    _linkValue: string,
    parsed: ParsedLink,
    oldPath: string,
    newPath: string,
    fromFile: string,
  ): { updated: boolean; newValue: string } {
    // Compute new relative path from the referring file to the new target
    const fromDir = path.dirname(fromFile);
    let newRelative = path.relative(fromDir, newPath).replace(/\\/g, "/");
    if (!newRelative.startsWith(".") && !newRelative.startsWith("/")) {
      newRelative = "./" + newRelative;
    }

    // Rebuild markdown link preserving alias (display text) and anchor
    const alias = parsed.alias ?? "";
    let newHref = newRelative;
    if (parsed.anchor) newHref += "#" + parsed.anchor;

    const isEmbed = (parsed as unknown as Record<string, unknown>).is_embed;
    const prefix = isEmbed ? "!" : "";
    const result = `${prefix}[${alias}](${newHref})`;

    return { updated: true, newValue: result };
  }

  private updateBarePath(
    _linkValue: string,
    parsed: ParsedLink,
    _oldPath: string,
    newPath: string,
    fromFile: string,
  ): { updated: boolean; newValue: string } {
    // Compute new relative path
    const fromDir = path.dirname(fromFile);
    let newRelative = path.relative(fromDir, newPath).replace(/\\/g, "/");
    if (!newRelative.startsWith(".") && !newRelative.startsWith("/")) {
      newRelative = "./" + newRelative;
    }
    return { updated: true, newValue: newRelative };
  }

  /**
   * Update links in body text, excluding code blocks and inline code.
   */
  private updateBodyLinks(
    body: string,
    oldPath: string,
    newPath: string,
    oldBase: string,
    newBase: string,
    oldNoExt: string,
    newNoExt: string,
    fromFile: string,
    renamedFileId?: string,
    knownFiles?: string[],
    knownFileCache?: Map<string, ReadResult>,
    nonMarkdownFiles?: Set<string>,
  ): string {
    if (!body) return body;

    const lines = body.split("\n");
    let inFencedCode = false;
    const result: string[] = [];

    for (const line of lines) {
      // Track fenced code blocks
      if (/^```/.test(line.trimStart())) {
        inFencedCode = !inFencedCode;
        result.push(line);
        continue;
      }
      if (inFencedCode) {
        result.push(line);
        continue;
      }
      if (/^(?:\t| {4,})/.test(line)) {
        result.push(line);
        continue;
      }

      // Process line: find inline code spans and protect them
      let processed = "";
      let pos = 0;
      const inlineCodeRegex = /`[^`]+`/g;
      let codeMatch;
      const codeSpans: Array<{ start: number; end: number }> = [];

      while ((codeMatch = inlineCodeRegex.exec(line)) !== null) {
        codeSpans.push({ start: codeMatch.index, end: codeMatch.index + codeMatch[0].length });
      }

      // Process wikilinks and markdown links outside code spans
      const linkRegex = /(?<!\\)(!?\[\[([^\]\n]+)\]\])|(!?\[([^\]]*)\]\(([^)]+)\))/g;
      let linkMatch;
      let lastEnd = 0;

      while ((linkMatch = linkRegex.exec(line)) !== null) {
        const matchStart = linkMatch.index;
        const matchEnd = matchStart + linkMatch[0].length;

        // Skip if inside inline code
        const inCode = codeSpans.some((cs) => matchStart >= cs.start && matchEnd <= cs.end);
        if (inCode) continue;

        // Determine what kind of link this is and try to update it
        const raw = linkMatch[0];
        const updateResult = this.updateLinkValue(
          raw, oldPath, newPath, oldBase, newBase, oldNoExt, newNoExt, fromFile, renamedFileId, knownFiles, knownFileCache, nonMarkdownFiles,
        );

        if (updateResult.updated && updateResult.newValue !== raw) {
          processed += line.slice(lastEnd, matchStart) + updateResult.newValue;
          lastEnd = matchEnd;
        }
      }

      if (lastEnd > 0) {
        processed += line.slice(lastEnd);
        result.push(processed);
      } else {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  /**
   * Query the collection.
   */
  async query(input: {
    types?: string[];
    where?: string | Record<string, unknown>;
    order_by?: Array<{ field: string; direction?: string }>;
    folder?: string;
    limit?: number;
    offset?: number;
    include_body?: boolean;
    context_file?: string;
    formulas?: Record<string, string>;
  }): Promise<QueryResult & { error?: { code: string; message: string } }> {
    // Build thisContext if context_file is provided
    let thisContext: { frontmatter: Record<string, unknown>; path: string; file?: Record<string, unknown> } | undefined;
    if (input.context_file) {
      const ctxResult = await this.read(input.context_file);
      if (!ctxResult.error && ctxResult.frontmatter) {
        thisContext = {
          frontmatter: ctxResult.frontmatter,
          path: input.context_file,
          file: (ctxResult as unknown as Record<string, unknown>).file as Record<string, unknown> | undefined,
        };
      }
    }

    const files = await this.scanFiles();
    const allFiles = await this.scanAllFiles();
    const nonMdSet = this.buildNonMarkdownSet(allFiles);
    const fileCache = new Map<string, ReadResult>();
    for (const relativePath of files) {
      const readResult = await this.read(relativePath);
      if (!readResult.error) {
        fileCache.set(relativePath, readResult);
      }
    }
    let results: Array<{
      path: string;
      frontmatter: Record<string, unknown>;
      types: string[];
      body?: string | null;
      _file?: Record<string, unknown>;
      formulas?: Record<string, unknown>;
    }> = [];

    const backlinksCache = new Map<string, BacklinkEntry[]>();
    const computeBacklinks = (targetPath: string): BacklinkEntry[] => {
      const existing = backlinksCache.get(targetPath);
      if (existing) return existing;
      const backlinks: BacklinkEntry[] = [];
      const seenSources = new Set<string>();
      for (const [sourcePath, sourceRead] of fileCache) {
        if (sourcePath === targetPath) continue;
        const frontmatter = sourceRead.frontmatter ?? {};
        const types = sourceRead.types ?? [];
        const body = sourceRead.body ?? "";

        const allLinkValues: string[] = [];
        for (const typeName of types) {
          const typeDef = this.typeDefs.get(typeName);
          if (!typeDef?.fields) continue;
          for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
            const value = frontmatter[fieldName];
            if (value === null || value === undefined) continue;
            if (fieldDef.type === "link" && typeof value === "string") {
              allLinkValues.push(value);
            } else if (fieldDef.type === "list" && fieldDef.items?.type === "link" && Array.isArray(value)) {
              for (const item of value) {
                if (typeof item === "string") allLinkValues.push(item);
              }
            }
          }
        }
        const bodyLinks = extractBodyLinks(body);
        for (const bl of bodyLinks) {
          allLinkValues.push(bl.raw);
        }

        for (const linkValue of allLinkValues) {
          if (seenSources.has(sourcePath)) break;
          const resolution = this.resolveLinkFullWithFiles(linkValue, sourcePath, files, undefined, fileCache, nonMdSet);
          if (resolution.resolved === targetPath) {
            seenSources.add(sourcePath);
            const name = sourcePath.split("/").pop() ?? "";
            backlinks.push({
              file: {
                path: sourcePath,
                name,
                basename: name.replace(/\.[^.]+$/, ""),
                folder: path.dirname(sourcePath) === "." ? "" : path.dirname(sourcePath),
                extension: path.extname(sourcePath).slice(1),
              },
            });
          }
        }
      }
      backlinksCache.set(targetPath, backlinks);
      return backlinks;
    };

    for (const relativePath of files) {
      const readResult = fileCache.get(relativePath);
      if (!readResult) continue;
      if (readResult.error) continue;

      const fileTypes = readResult.types ?? [];

      // Filter by type
      if (input.types && input.types.length > 0) {
        const hasMatchingType = input.types.some((t) =>
          fileTypes.includes(t.toLowerCase()),
        );
        if (!hasMatchingType) continue;
      }

      // Filter by folder
      if (input.folder) {
        const folder = input.folder.replace(/\/$/, "");
        if (!relativePath.startsWith(folder + "/")) continue;
      }

      // Evaluate formulas (only on first file - detect circular first)
      let formulaValues: Record<string, unknown> | undefined;
      if (input.formulas) {
        // Check for circular formula references (only once)
        if (results.length === 0) {
          const circularError = this.detectCircularFormulas(input.formulas);
          if (circularError) {
            return {
              results: [],
              error: circularError,
            };
          }
        }

        formulaValues = {};
        const fileInfo = (readResult as unknown as Record<string, unknown>).file as Record<string, unknown> | undefined;

        // Resolve formulas in dependency order
        const resolved = new Map<string, unknown>();
        const formulaEntries = Object.entries(input.formulas);
        const maxPasses = formulaEntries.length + 1;
        for (let pass = 0; pass < maxPasses; pass++) {
          let progress = false;
          for (const [name, expr] of formulaEntries) {
            if (resolved.has(name)) continue;
            try {
              const formulaCtx = {
                frontmatter: { ...readResult.frontmatter ?? {}, formula: Object.fromEntries(resolved) },
                rawFrontmatter: readResult.rawFrontmatter,
                path: relativePath,
                types: fileTypes,
                body: readResult.body,
                file: fileInfo,
                thisContext,
                strictArithmetic: true,
              };
              const val = evaluateExpression(expr, formulaCtx);
              resolved.set(name, val);
              progress = true;
            } catch (e: unknown) {
              if (e instanceof ExpressionError) {
                // Map expression errors to formula-specific codes
                let code = e.code;
                if (code === "invalid_expression") code = "invalid_formula";
                else if (code === "type_error" || code === "unknown_function") code = "formula_evaluation_error";
                return {
                  results: [],
                  error: { code, message: e.message },
                };
              }
              // May fail if dependencies not yet resolved, try again
              if (pass === maxPasses - 1) {
                resolved.set(name, null);
              }
            }
          }
          if (!progress && resolved.size < formulaEntries.length) break;
          if (resolved.size === formulaEntries.length) break;
        }
        for (const [name] of formulaEntries) {
          formulaValues[name] = resolved.get(name) ?? null;
        }
      }

      // Build frontmatter context with formula values for WHERE
      const frontmatterWithFormulas = readResult.frontmatter ?? {};

      // Filter by where expression (string or structured)
      if (input.where) {
        if (typeof input.where === "string") {
          const fileInfo = (readResult as unknown as Record<string, unknown>).file as Record<string, unknown> | undefined;
          const resolveFile = (linkTarget: string) => {
            const resolution = this.resolveLinkFullWithFiles(linkTarget, relativePath, files, undefined, fileCache, nonMdSet);
            if (!resolution.resolved) return null;
            const target = fileCache.get(resolution.resolved);
            if (!target || target.error) return null;
            return {
              frontmatter: target.frontmatter ?? {},
              path: resolution.resolved,
              types: target.types ?? [],
            };
          };
          const ctx = {
            frontmatter: { ...frontmatterWithFormulas, formula: formulaValues ?? {} },
            rawFrontmatter: readResult.rawFrontmatter,
            path: relativePath,
            types: fileTypes,
            body: readResult.body,
            file: fileInfo,
            thisContext,
            resolveFile,
            computeBacklinks,
          };
          try {
            const whereResult = evaluateExpression(input.where, ctx);
            if (!toBoolExternal(whereResult)) continue;
          } catch (e: unknown) {
            if (e instanceof ExpressionError) {
              // Structural/deterministic errors abort the query
              const abortCodes = new Set([
                "invalid_expression", "unknown_function", "wrong_argument_count",
                "expression_depth_exceeded",
              ]);
              if (abortCodes.has(e.code)) {
                return {
                  results: [],
                  error: { code: e.code, message: e.message },
                };
              }
              continue; // Other errors → skip file
            }
            continue; // Non-expression errors → skip file
          }
        } else {
          // Structured where clause (YAML object with and/or/not or field conditions)
          if (!this.evaluateStructuredWhere(
            input.where,
            frontmatterWithFormulas,
            relativePath,
            fileTypes,
            readResult.body,
          )) continue;
        }
      }

      const fileInfo = (readResult as unknown as Record<string, unknown>).file as Record<string, unknown> | undefined;
      results.push({
        path: relativePath,
        ...(readResult.frontmatter ?? {}),
        frontmatter: readResult.frontmatter ?? {},
        types: fileTypes,
        body: readResult.body,
        _file: fileInfo,
        formulas: formulaValues,
      });
    }

    // Sort
    if (input.order_by) {
      // Collect enum value orders for enum fields
      const enumOrders = new Map<string, Map<string, number>>();
      for (const [, typeDef] of this.typeDefs) {
        if (!typeDef.fields) continue;
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          if (fieldDef.values && !enumOrders.has(fieldName)) {
            const order = new Map<string, number>();
            fieldDef.values.forEach((v, i) => order.set(v, i));
            enumOrders.set(fieldName, order);
          }
        }
      }

      for (const orderSpec of [...input.order_by].reverse()) {
        const field = orderSpec.field;
        const desc = orderSpec.direction === "desc";
        const enumOrder = enumOrders.get(field);

        results.sort((a, b) => {
          let va: unknown;
          let vb: unknown;

          if (field.startsWith("file.")) {
            const prop = field.slice(5);
            if (prop === "path") { va = a.path; vb = b.path; }
            else if (prop.includes(".")) {
              // Complex file property like file.embeds.length — evaluate as expression
              const backlinksCb = (fp: string) => computeBacklinks(fp);
              try {
                va = evaluateExpression(field, {
                  frontmatter: a.frontmatter, path: a.path, types: a.types,
                  body: a.body ?? undefined, file: a._file,
                  computeBacklinks: backlinksCb,
                });
              } catch { va = null; }
              try {
                vb = evaluateExpression(field, {
                  frontmatter: b.frontmatter, path: b.path, types: b.types,
                  body: b.body ?? undefined, file: b._file,
                  computeBacklinks: backlinksCb,
                });
              } catch { vb = null; }
            }
            else { va = a._file?.[prop]; vb = b._file?.[prop]; }
          } else if (field.startsWith("formula.")) {
            const formulaName = field.slice(8);
            va = a.formulas?.[formulaName];
            vb = b.formulas?.[formulaName];
          } else {
            va = a.frontmatter[field];
            vb = b.frontmatter[field];
          }

          if (va === vb) return 0;
          // null sorts last in asc, first in desc (§10.3)
          if (va === null || va === undefined) return desc ? -1 : 1;
          if (vb === null || vb === undefined) return desc ? 1 : -1;

          // Enum sort by declaration order
          if (enumOrder) {
            const ia = enumOrder.get(String(va)) ?? Infinity;
            const ib = enumOrder.get(String(vb)) ?? Infinity;
            if (ia !== ib) return desc ? ib - ia : ia - ib;
            return 0;
          }

          if (va < vb) return desc ? 1 : -1;
          return desc ? -1 : 1;
        });
      }
    }

    const totalCount = results.length;

    // Apply offset and limit
    if (input.offset !== undefined && input.offset > 0) {
      results = results.slice(input.offset);
    }
    let hasMore = false;
    if (input.limit !== undefined) {
      hasMore = results.length > input.limit;
      results = results.slice(0, input.limit);
    }

    // Strip body if not requested (set to null per spec)
    if (!input.include_body) {
      results = results.map(({ body, ...rest }) => ({ ...rest, body: null }) as typeof results[0]);
    }

    // Strip internal _file metadata from results
    results = results.map(({ _file, ...rest }) => rest as typeof results[0]);

    // Strip formulas if none were defined
    if (!input.formulas) {
      results = results.map(({ formulas, ...rest }) => rest as typeof results[0]);
    }

    return {
      results,
      meta: {
        total_count: totalCount,
        has_more: hasMore,
      },
    };
  }

  /**
   * Detect circular references in query formulas.
   */
  private detectCircularFormulas(formulas: Record<string, string>): { code: string; message: string } | null {
    const formulaNames = new Set(Object.keys(formulas));
    const deps = new Map<string, Set<string>>();

    for (const [name, expr] of Object.entries(formulas)) {
      const fieldDeps = new Set<string>();
      // Find references to formula.X in the expression
      const pattern = /formula\.(\w+)/g;
      let match;
      while ((match = pattern.exec(expr)) !== null) {
        const ref = match[1];
        if (ref === name) {
          return { code: "circular_formula", message: `Self-referencing formula: "${name}"` };
        }
        if (formulaNames.has(ref)) {
          fieldDeps.add(ref);
        }
      }
      deps.set(name, fieldDeps);
    }

    // DFS cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();

    function dfs(node: string): boolean {
      if (inStack.has(node)) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      inStack.add(node);
      for (const dep of deps.get(node) ?? []) {
        if (dfs(dep)) return true;
      }
      inStack.delete(node);
      return false;
    }

    for (const name of formulaNames) {
      if (dfs(name)) {
        return { code: "circular_formula", message: `Circular reference in formulas involving "${name}"` };
      }
    }
    return null;
  }

  /**
   * Evaluate structured where clause (YAML object format).
   */
  private evaluateStructuredWhere(
    where: string | Record<string, unknown>,
    frontmatter: Record<string, unknown>,
    filePath: string,
    types: string[],
    body?: string | null,
  ): boolean {
    // String expression
    if (typeof where === "string") {
      return evaluateWhere(where, { frontmatter, path: filePath, types, body });
    }

    // Handle logical operators
    if ("and" in where) {
      const conditions = where.and as Array<string | Record<string, unknown>>;
      return conditions.every((c) =>
        this.evaluateStructuredWhere(c, frontmatter, filePath, types, body),
      );
    }
    if ("or" in where) {
      const conditions = where.or as Array<string | Record<string, unknown>>;
      return conditions.some((c) =>
        this.evaluateStructuredWhere(c, frontmatter, filePath, types, body),
      );
    }
    if ("not" in where) {
      const condition = where.not as string | Record<string, unknown>;
      return !this.evaluateStructuredWhere(condition, frontmatter, filePath, types, body);
    }

    // Handle explicit expression key
    if ("expression" in where) {
      const expr = where.expression as string;
      return evaluateWhere(expr, { frontmatter, path: filePath, types, body });
    }

    // Handle field conditions (same as type match where)
    return this.matchesWhereConditions(frontmatter, where);
  }

  /**
   * Check uniqueness constraints when updating a file.
   * Returns issues for any violations.
   */
  private async checkUpdateUniqueness(
    updatingPath: string,
    frontmatter: Record<string, unknown>,
    types: string[],
  ): Promise<MdbaseError[]> {
    const issues: MdbaseError[] = [];
    const files = await this.scanFiles();

    // Collect all file frontmatter except the updating file
    const otherFiles = new Map<string, Record<string, unknown>>();
    for (const relativePath of files) {
      if (relativePath === updatingPath) continue;
      const readResult = await this.read(relativePath);
      if (readResult.frontmatter) {
        otherFiles.set(relativePath, readResult.frontmatter);
      }
    }

    // Check id_field uniqueness
    const idField = this.config.settings.id_field;
    const myIdValue = frontmatter[idField];
    if (myIdValue !== null && myIdValue !== undefined) {
      for (const [otherPath, otherFm] of otherFiles) {
        const otherValue = otherFm[idField];
        if (otherValue !== null && otherValue !== undefined &&
            JSON.stringify(myIdValue) === JSON.stringify(otherValue)) {
          issues.push({
            code: "duplicate_id",
            message: `Duplicate id "${myIdValue}" (conflicts with ${otherPath})`,
            field: idField,
            path: updatingPath,
            severity: "error",
          });
          break;
        }
      }
    }

    // Check unique field constraints
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (!fieldDef.unique) continue;
        const myValue = frontmatter[fieldName];
        if (myValue === null || myValue === undefined) continue;
        for (const [otherPath, otherFm] of otherFiles) {
          const otherValue = otherFm[fieldName];
          if (otherValue !== null && otherValue !== undefined &&
              JSON.stringify(myValue) === JSON.stringify(otherValue)) {
            issues.push({
              code: "duplicate_value",
              message: `Duplicate value "${myValue}" for unique field "${fieldName}" (conflicts with ${otherPath})`,
              field: fieldName,
              path: updatingPath,
              severity: "error",
            });
            break;
          }
        }
      }
    }

    return issues;
  }

  /**
   * Batch delete: delete all files matching a where expression.
   */
  async batchDelete(input: {
    where: string;
    dry_run?: boolean;
    check_backlinks?: boolean;
  }): Promise<BatchResult> {
    // Find matching files
    const files = await this.scanFiles();
    const fileCache = await this.buildFileCache(files);
    const matchingPaths: string[] = [];

    for (const relativePath of files) {
      const readResult = fileCache.get(relativePath);
      if (!readResult || readResult.error) continue;
      const ctx = {
        frontmatter: readResult.frontmatter ?? {},
        path: relativePath,
        types: readResult.types ?? [],
        body: readResult.body,
      };
      if (evaluateWhere(input.where, ctx)) {
        matchingPaths.push(relativePath);
      }
    }

    if (matchingPaths.length === 0) {
      return {
        batch_result: {
          total: 0,
          succeeded: 0,
          failed: 0,
          details: [],
        },
      };
    }

    const checkBacklinks = input.check_backlinks !== false;
    const brokenLinks = checkBacklinks ? await this.findBacklinks(matchingPaths) : [];

    // Dry run: return what would be deleted without actually deleting
    if (input.dry_run) {
      const details: BatchResultDetail[] = matchingPaths.map((p) => ({
        path: p,
        status: "success" as const,
      }));
      return {
        batch_result: {
          total: matchingPaths.length,
          succeeded: matchingPaths.length,
          failed: 0,
          details,
        },
        broken_links: checkBacklinks ? brokenLinks : undefined,
      };
    }

    // Actually delete
    let succeeded = 0;
    let failed = 0;
    const details: BatchResultDetail[] = [];

    for (const relativePath of matchingPaths) {
      // Check for simulated I/O error
      if (this.ioErrorPaths?.has(relativePath)) {
        failed++;
        details.push({ path: relativePath, status: "failed", error: { code: "io_error", message: `I/O error deleting ${relativePath}` } });
        continue;
      }
      try {
        const fullPath = path.join(this.root, relativePath);
        await fs.promises.unlink(fullPath);
        if (this.cache) {
          await this.cache.deleteFile(relativePath);
        }
        succeeded++;
        details.push({ path: relativePath, status: "success" });
      } catch {
        failed++;
        details.push({ path: relativePath, status: "failed", error: { code: "io_error", message: `Failed to delete ${relativePath}` } });
      }
    }

    return {
      batch_result: {
        total: matchingPaths.length,
        succeeded,
        failed,
        details,
      },
      broken_links: checkBacklinks ? brokenLinks : undefined,
    };
  }

  /**
   * Batch update: update all files matching a where expression, or update specific files.
   * Two modes:
   *   1. where + fields: update all matching files with the same fields
   *   2. updates[]: array of {path, fields} for per-file updates
   */
  async batchUpdate(input: {
    where?: string;
    fields?: Record<string, unknown>;
    updates?: Array<{ path: string; fields: Record<string, unknown> }>;
    dry_run?: boolean;
  }): Promise<BatchResult> {
    // Mode 1: updates array (pre-validation all-or-nothing)
    if (input.updates) {
      return await this.batchUpdateByList(input.updates, input.dry_run);
    }

    // Mode 2: where + fields
    if (!input.where || !input.fields) {
      return {
        batch_result: { total: 0, succeeded: 0, failed: 0, details: [] },
        error: { code: "invalid_input", message: "batch_update requires where+fields or updates array" },
      };
    }

    // Find matching files
    const files = await this.scanFiles();
    const matchingPaths: string[] = [];

    for (const relativePath of files) {
      const readResult = await this.read(relativePath);
      if (readResult.error) continue;
      const ctx = {
        frontmatter: readResult.frontmatter ?? {},
        path: relativePath,
        types: readResult.types ?? [],
        body: readResult.body,
      };
      if (evaluateWhere(input.where, ctx)) {
        matchingPaths.push(relativePath);
      }
    }

    if (matchingPaths.length === 0) {
      return {
        batch_result: { total: 0, succeeded: 0, failed: 0, details: [] },
      };
    }

    // Pre-validate all files when validation is "error"
    if (this.config.settings.default_validation === "error") {
      for (const relativePath of matchingPaths) {
        const existing = await parseFileAsync(path.join(this.root, relativePath));
        const merged = { ...existing.frontmatter, ...input.fields };
        const types = this.getFileTypes(merged);
        const typeDefs = types.map((t) => this.typeDefs.get(t)!).filter(Boolean);
        if (typeDefs.length > 0) {
          // Coerce before validation
          for (const typeDef of typeDefs) {
            if (!typeDef.fields) continue;
            for (const [key, value] of Object.entries(merged)) {
              if (this.config.settings.explicit_type_keys.includes(key)) continue;
              const fieldDef = typeDef.fields[key];
              if (!fieldDef || value === null || value === undefined) continue;
              merged[key] = coerceForRead(value, fieldDef);
            }
          }
          const valResult = validateFrontmatter(merged, typeDefs, this.config);
          if (!valResult.valid) {
            return {
              batch_result: { total: matchingPaths.length, succeeded: 0, failed: matchingPaths.length, details: [] },
              error: { code: "validation_failed", message: `Validation failed for ${relativePath}` },
            };
          }
        }
      }
    }

    // Dry run
    if (input.dry_run) {
      const details: BatchResultDetail[] = matchingPaths.map((p) => ({
        path: p,
        status: "success" as const,
      }));
      return {
        batch_result: {
          total: matchingPaths.length,
          succeeded: matchingPaths.length,
          failed: 0,
          details,
        },
      };
    }

    // Actually update
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const details: BatchResultDetail[] = [];
    const failedPaths = new Set<string>();
    const fileCache = this.skipDependents ? await this.buildFileCache(files) : undefined;
    const nonMdSet = this.skipDependents ? this.buildNonMarkdownSet(await this.scanAllFiles()) : undefined;

    for (const relativePath of matchingPaths) {
      // Check if this file depends on a failed file (skip_dependents)
      if (this.skipDependents && failedPaths.size > 0) {
        const fullPath = path.join(this.root, relativePath);
        const parsed = await parseFileAsync(fullPath);
        const typeNames = this.getTypesForFile(relativePath, parsed.frontmatter);
        let dependsOnFailed = false;
        // Collect title→path mappings from failed files for link resolution
        const failedTitles = new Map<string, string>();
        for (const fp of failedPaths) {
          const fpFull = path.join(this.root, fp);
          try {
            const fpParsed = await parseFileAsync(fpFull);
            if (fpParsed.frontmatter.title) {
              failedTitles.set(String(fpParsed.frontmatter.title), fp);
            }
          } catch { /* skip */ }
          failedTitles.set(path.basename(fp, path.extname(fp)), fp);
        }
        for (const typeName of typeNames) {
          const typeDef = this.typeDefs.get(typeName);
          if (!typeDef?.fields) continue;
          for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
            if (fieldDef.type === "link" && parsed.frontmatter[fieldName]) {
              const linkVal = String(parsed.frontmatter[fieldName]);
              // Extract wikilink target
              const wikiMatch = linkVal.match(/\[\[([^\]#|]+)/);
              const target = wikiMatch ? wikiMatch[1].trim() : linkVal;
              // Check if target matches any failed file's title or basename
              if (failedTitles.has(target)) {
                dependsOnFailed = true;
              }
              // Also try full link resolution
              if (!dependsOnFailed) {
                try {
                  const resolved = this.resolveLinkFullWithFiles(linkVal, relativePath, files, undefined, fileCache, nonMdSet);
                  if (resolved.resolved && failedPaths.has(resolved.resolved)) {
                    dependsOnFailed = true;
                  }
                } catch { /* skip */ }
              }
            }
            if (dependsOnFailed) break;
          }
          if (dependsOnFailed) break;
        }
        if (dependsOnFailed) {
          skipped++;
          details.push({ path: relativePath, status: "skipped" });
          continue;
        }
      }

      // Check for simulated I/O error
      if (this.ioErrorPaths?.has(relativePath)) {
        failed++;
        failedPaths.add(relativePath);
        details.push({ path: relativePath, status: "failed", error: { code: "io_error", message: `I/O error writing ${relativePath}` } });
        continue;
      }
      try {
        const result = await this.update({
          path: relativePath,
          fields: input.fields,
        });
        if (result.error) {
          failed++;
          failedPaths.add(relativePath);
          details.push({ path: relativePath, status: "failed", error: result.error });
        } else {
          succeeded++;
          details.push({ path: relativePath, status: "success" });
        }
      } catch {
        failed++;
        failedPaths.add(relativePath);
        details.push({ path: relativePath, status: "failed", error: { code: "io_error", message: `Failed to update ${relativePath}` } });
      }
    }

    return {
      batch_result: {
        total: matchingPaths.length,
        succeeded,
        failed,
        ...(skipped > 0 ? { skipped } : {}),
        details,
      },
    };
  }

  /**
   * Batch update by explicit list of file updates. All-or-nothing validation.
   */
  private async batchUpdateByList(
    updates: Array<{ path: string; fields: Record<string, unknown> }>,
    dryRun?: boolean,
  ): Promise<BatchResult> {
    // Pre-validate all files when validation is "error"
    if (this.config.settings.default_validation === "error") {
      for (const upd of updates) {
        const fullPath = path.join(this.root, upd.path);
        if (!await this.fileExists(fullPath)) {
          return {
            batch_result: { total: updates.length, succeeded: 0, failed: updates.length, details: [] },
            error: { code: "file_not_found", message: `File not found: ${upd.path}` },
          };
        }
        const existing = await parseFileAsync(fullPath);
        const merged = { ...existing.frontmatter, ...upd.fields };
        const types = this.getFileTypes(merged);
        const typeDefs = types.map((t) => this.typeDefs.get(t)!).filter(Boolean);
        if (typeDefs.length > 0) {
          for (const typeDef of typeDefs) {
            if (!typeDef.fields) continue;
            for (const [key, value] of Object.entries(merged)) {
              if (this.config.settings.explicit_type_keys.includes(key)) continue;
              const fieldDef = typeDef.fields[key];
              if (!fieldDef || value === null || value === undefined) continue;
              merged[key] = coerceForRead(value, fieldDef);
            }
          }
          const valResult = validateFrontmatter(merged, typeDefs, this.config);
          if (!valResult.valid) {
            return {
              batch_result: { total: updates.length, succeeded: 0, failed: updates.length, details: [] },
              error: { code: "validation_failed", message: `Validation failed for ${upd.path}` },
            };
          }
        }
      }
    }

    if (dryRun) {
      const details: BatchResultDetail[] = updates.map((u) => ({
        path: u.path,
        status: "success" as const,
      }));
      return {
        batch_result: {
          total: updates.length,
          succeeded: updates.length,
          failed: 0,
          details,
        },
      };
    }

    // Execute all updates
    let succeeded = 0;
    let failed = 0;
    const details: BatchResultDetail[] = [];

    for (const upd of updates) {
      try {
        const result = await this.update({ path: upd.path, fields: upd.fields });
        if (result.error) {
          failed++;
          details.push({ path: upd.path, status: "failed", error: result.error });
        } else {
          succeeded++;
          details.push({ path: upd.path, status: "success" });
        }
      } catch {
        failed++;
        details.push({ path: upd.path, status: "failed", error: { code: "io_error", message: `Failed to update ${upd.path}` } });
      }
    }

    return {
      batch_result: {
        total: updates.length,
        succeeded,
        failed,
        details,
      },
    };
  }

  /**
   * Rebuild cache from disk.
   */
  async cacheRebuild(): Promise<CacheOpResult> {
    if (!this.cache) {
      return { success: false, error: { code: "cache_unavailable", message: "Cache store is unavailable" } };
    }
    const cacheRoot = this.config.settings.cache_folder;
    await this.cache.clear();
    this.cache = await CacheStoreAsync.open(this.root, cacheRoot);
    if (!this.cache) {
      return { success: false, error: { code: "cache_unavailable", message: "Cache store is unavailable" } };
    }
    const files = await this.scanFiles();
    for (const relativePath of files) {
      await this.updateCacheForPath(relativePath);
    }
    return { success: true };
  }

  /**
   * Clear cache from disk.
   */
  async cacheClear(): Promise<CacheOpResult> {
    if (!this.cache) {
      return { success: true };
    }
    await this.cache.clear();
    this.cache = null;
    return { success: true };
  }

  async close(): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.close();
    } finally {
      this.cache = null;
    }
  }

  private generateValue(
    fieldDef: FieldDefinition,
    frontmatter: Record<string, unknown>,
  ): unknown {
    const gen = fieldDef.generated;
    if (typeof gen === "string") {
      switch (gen) {
        case "ulid":
          return ulid();
        case "uuid":
          return crypto.randomUUID();
        case "now":
          return new Date().toISOString();
        case "now_on_write":
          return new Date().toISOString();
      }
    } else if (typeof gen === "object" && gen !== null) {
      // Derived field: { from: "field", transform: "slugify" }
      const sourceValue = frontmatter[gen.from];
      if (sourceValue === null || sourceValue === undefined) {
        return null;
      }
      if (gen.transform === "slugify") {
        return slugify(String(sourceValue));
      }
      if (gen.transform === "lowercase") {
        return String(sourceValue).toLowerCase();
      }
      if (gen.transform === "uppercase") {
        return String(sourceValue).toUpperCase();
      }
    }
    return undefined;
  }

  /**
   * Validate link fields in frontmatter: validate_exists, target constraint, ambiguous_link.
   */
  private async validateLinkFields(
    typeDefs: TypeDefinition[],
    frontmatter: Record<string, unknown>,
    relativePath: string,
    result: { valid: boolean; issues: MdbaseError[] },
  ): Promise<void> {
    for (const typeDef of typeDefs) {
      if (!typeDef.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.type === "link") {
          await this.validateSingleLink(fieldName, fieldDef, frontmatter[fieldName], relativePath, result);
        } else if (fieldDef.type === "list" && fieldDef.items?.type === "link") {
          const value = frontmatter[fieldName];
          if (!Array.isArray(value)) continue;
          for (const item of value) {
            await this.validateSingleLink(fieldName, fieldDef.items, item, relativePath, result);
          }
        }
      }
    }
  }

  private async validateSingleLink(
    fieldName: string,
    fieldDef: FieldDefinition,
    value: unknown,
    fromPath: string,
    result: { valid: boolean; issues: MdbaseError[] },
  ): Promise<void> {
    if (value === null || value === undefined) return;
    if (typeof value !== "string") return; // type_mismatch handled by validator

    // Parse the link
    let parsed: ParsedLink | null;
    try {
      parsed = parseLink(value);
    } catch {
      // invalid_link already caught by validator
      return;
    }

    // Check for path traversal before resolution
    const target = parsed ? parsed.target : value;
    const isRelative = parsed ? parsed.is_relative : false;
    if (isRelative || target.includes("..")) {
      const fromDir = path.dirname(fromPath);
      const resolved = path.posix.normalize(path.posix.join(fromDir, target));
      if (resolved.startsWith("..") || resolved.startsWith("/")) {
        result.issues.push({
          code: "path_traversal",
          field: fieldName,
          message: `Link "${value}" escapes collection root`,
          path: fromPath,
          severity: "error",
        });
        result.valid = false;
        return;
      }
      // For wikilinks, also check if the normalized target itself has deep traversal
      // (2+ leading .. segments after normalization = suspicious path)
      if (parsed && parsed.format === "wikilink") {
        const normalizedTarget = path.posix.normalize(target);
        const segs = normalizedTarget.split("/");
        let dotdotCount = 0;
        for (const seg of segs) {
          if (seg === "..") dotdotCount++;
          else break;
        }
        if (dotdotCount >= 2) {
          result.issues.push({
            code: "path_traversal",
            field: fieldName,
            message: `Link "${value}" escapes collection root`,
            path: fromPath,
            severity: "error",
          });
          result.valid = false;
          return;
        }
      }
    }

    // For validate_exists or target constraints, we need to resolve
    const targetConstraint = (fieldDef as unknown as Record<string, unknown>).target as string | undefined;
    const validateExists = (fieldDef as unknown as Record<string, unknown>).validate_exists as boolean | undefined;

    if (!validateExists && !targetConstraint) return;

    // Resolve the link
    const resolution = await this.resolveLinkFull(value, fromPath, targetConstraint);

    if (resolution.ambiguous) {
      result.issues.push({
        code: "ambiguous_link",
        field: fieldName,
        message: `Ambiguous link "${value}": multiple candidates found`,
        path: fromPath,
        severity: "error",
      });
      result.valid = false;
      return;
    }

    if (resolution.wrongType) {
      result.issues.push({
        code: "link_wrong_type",
        field: fieldName,
        message: `Link "${value}" resolves to wrong type (expected ${targetConstraint})`,
        path: fromPath,
        severity: "error",
      });
      result.valid = false;
      return;
    }

    if (validateExists && !resolution.resolved) {
      result.issues.push({
        code: "link_not_found",
        field: fieldName,
        message: `Link target "${value}" not found`,
        path: fromPath,
        severity: "error",
      });
      result.valid = false;
    }
  }

  /**
   * Resolve a link value to a file, with full support for:
   * - Path-based resolution (relative, absolute, root-relative)
   * - Extension fallback
   * - ID field matching
   * - Filename matching with tiebreakers
   * - Target type constraint
   */
  private async resolveLinkFull(
    linkValue: string,
    fromPath: string,
    targetType?: string,
  ): Promise<{ resolved: string | null; ambiguous?: boolean; wrongType?: boolean }> {
    const files = await this.scanFiles();
    const fileCache = await this.buildFileCache(files);
    const allFiles = await this.scanAllFiles();
    const nonMdSet = this.buildNonMarkdownSet(allFiles);
    return this.resolveLinkFullWithFiles(linkValue, fromPath, files, targetType, fileCache, nonMdSet);
  }

  private resolveLinkFullWithFiles(
    linkValue: string,
    fromPath: string,
    files: string[],
    targetType?: string,
    fileCache?: Map<string, ReadResult>,
    nonMarkdownFiles?: Set<string>,
  ): { resolved: string | null; ambiguous?: boolean; wrongType?: boolean } {
    // Parse the link to get the target
    let parsed: ParsedLink | null;
    try {
      parsed = parseLink(linkValue);
    } catch {
      return { resolved: null };
    }

    const target = parsed ? parsed.target : linkValue;
    const format = parsed ? parsed.format : "wikilink";
    const isRelative = parsed ? parsed.is_relative : false;

    const fromDir = path.dirname(fromPath);

    // Strip anchor from target for resolution
    let resolveTarget = target;

    // Helper to check if a file exists (markdown files in scan list, or any file on disk)
    const fileExists = (p: string): boolean => {
      if (files.includes(p)) return true;
      return nonMarkdownFiles ? nonMarkdownFiles.has(p) : false;
    };

    // Step 1: Path-based resolution
    if (format === "markdown" || format === "path") {
      // Markdown/path links resolve relative to containing file directory
      let resolved: string;
      if (resolveTarget.startsWith("/")) {
        // Root-relative
        resolved = resolveTarget.slice(1);
      } else if (isRelative || !resolveTarget.startsWith("/")) {
        // Relative to containing file
        resolved = path.posix.normalize(path.posix.join(fromDir, resolveTarget));
      } else {
        resolved = resolveTarget;
      }
      resolved = resolved.replace(/\\/g, "/");

      // Check if file exists
      if (fileExists(resolved)) {
        return this.checkTargetType(resolved, targetType, fileCache);
      }
      // Try with extensions
      for (const ext of this.getExtensions()) {
        if (fileExists(resolved + ext)) {
          return this.checkTargetType(resolved + ext, targetType, fileCache);
        }
      }
      return { resolved: null };
    }

    // Wikilink resolution
    if (format === "wikilink") {
      // Relative wikilinks (./, ../)
      if (isRelative) {
        let resolved = path.posix.normalize(path.posix.join(fromDir, resolveTarget));
        resolved = resolved.replace(/\\/g, "/");
        if (fileExists(resolved)) {
          return this.checkTargetType(resolved, targetType, fileCache);
        }
        for (const ext of this.getExtensions()) {
          if (files.includes(resolved + ext)) {
            return this.checkTargetType(resolved + ext, targetType, fileCache);
          }
        }
        return { resolved: null };
      }

      // Root-relative (/path)
      if (resolveTarget.startsWith("/")) {
        const resolved = resolveTarget.slice(1);
        if (fileExists(resolved)) {
          return this.checkTargetType(resolved, targetType, fileCache);
        }
        for (const ext of this.getExtensions()) {
          if (files.includes(resolved + ext)) {
            return this.checkTargetType(resolved + ext, targetType, fileCache);
          }
        }
        return { resolved: null };
      }

      // Contains slash (absolute from root)
      if (resolveTarget.includes("/")) {
        if (fileExists(resolveTarget)) {
          return this.checkTargetType(resolveTarget, targetType, fileCache);
        }
        for (const ext of this.getExtensions()) {
          if (fileExists(resolveTarget + ext)) {
            return this.checkTargetType(resolveTarget + ext, targetType, fileCache);
          }
        }
        return { resolved: null };
      }

      // Simple name resolution
      return this.resolveSimpleName(resolveTarget, fromPath, files, targetType, fileCache);
    }

    // Fallback: try as simple name
    return this.resolveSimpleName(resolveTarget, fromPath, files, targetType, fileCache);
  }

  /**
   * Resolve a simple name (no path separators) using ID field match, then filename match.
   */
  private resolveSimpleName(
    name: string,
    fromPath: string,
    files: string[],
    targetType?: string,
    fileCache?: Map<string, ReadResult>,
  ): { resolved: string | null; ambiguous?: boolean; wrongType?: boolean } {
    const fromDir = path.dirname(fromPath);

    // Determine scope: if target constraint, limit to files of that type
    let scopeFiles = files;
    if (targetType) {
      scopeFiles = files.filter((f) => {
        const readResult = fileCache?.get(f);
        if (!readResult?.types) return false;
        return readResult.types.includes(targetType);
      });
    }

    // Step 1: ID field match
    const idField = this.config.settings.id_field;
    const idMatches: string[] = [];
    if (idField) {
      for (const filePath of scopeFiles) {
        const readResult = fileCache?.get(filePath);
        if (!readResult?.frontmatter) continue;
        const idValue = readResult.frontmatter[idField];
        if (idValue !== null && idValue !== undefined && String(idValue) === name) {
          idMatches.push(filePath);
        }
      }
    }

    if (idMatches.length === 1) {
      return this.checkTargetType(idMatches[0], targetType, fileCache);
    }
    if (idMatches.length > 1) {
      return { resolved: null, ambiguous: true };
    }

    // Step 2: Filename match
    const filenameMatches: string[] = [];
    for (const filePath of scopeFiles) {
      const basename = path.basename(filePath, path.extname(filePath));
      if (basename === name) {
        filenameMatches.push(filePath);
      }
    }

    if (filenameMatches.length === 0) {
      // If there's a target constraint and no match found, check if a match exists outside scope
      if (targetType) {
        const allFiles = files;
        for (const filePath of allFiles) {
          const basename = path.basename(filePath, path.extname(filePath));
          if (basename === name) {
            // Found a file but it's wrong type
            return { resolved: null, wrongType: true };
          }
        }
        // Also check ID match outside scope
        if (idField) {
          for (const filePath of allFiles) {
            const readResult = fileCache?.get(filePath);
            if (!readResult?.frontmatter) continue;
            const idValue = readResult.frontmatter[idField];
            if (idValue !== null && idValue !== undefined && String(idValue) === name) {
              return { resolved: null, wrongType: true };
            }
          }
        }
      }
      return { resolved: null };
    }

    if (filenameMatches.length === 1) {
      return this.checkTargetType(filenameMatches[0], targetType, fileCache);
    }

    // Apply tiebreakers
    // 1. Same directory preference
    const sameDir = filenameMatches.filter((f) => path.dirname(f) === fromDir);
    if (sameDir.length === 1) {
      return this.checkTargetType(sameDir[0], targetType);
    }

    // 2. Shortest path
    const sorted = [...filenameMatches].sort((a, b) => {
      const depthA = a.split("/").length;
      const depthB = b.split("/").length;
      if (depthA !== depthB) return depthA - depthB;
      // 3. Alphabetical
      return a.localeCompare(b);
    });

    // If multiple with same depth after sort, check if it's ambiguous
    const shortestDepth = sorted[0].split("/").length;
    const shortestPaths = sorted.filter((f) => f.split("/").length === shortestDepth);
    if (shortestPaths.length > 1) {
      // Alphabetical tiebreaker
      return this.checkTargetType(shortestPaths.sort()[0], targetType, fileCache);
    }

    return this.checkTargetType(sorted[0], targetType, fileCache);
  }

  /**
   * Check if the resolved file matches the target type constraint.
   */
  private checkTargetType(
    resolvedPath: string,
    targetType?: string,
    fileCache?: Map<string, ReadResult>,
  ): { resolved: string; wrongType?: boolean } {
    if (!targetType) {
      return { resolved: resolvedPath };
    }

    const readResult = fileCache?.get(resolvedPath);
    if (!readResult?.types || !readResult.types.includes(targetType)) {
      return { resolved: resolvedPath, wrongType: true };
    }
    return { resolved: resolvedPath };
  }

  /**
   * Get configured file extensions to try for link resolution.
   */
  private getExtensions(): string[] {
    const configExts = this.config.settings?.extensions ?? [];
    const normalizedExtra = configExts.map((e: string) => e.startsWith(".") ? e : `.${e}`);
    // .md is always first, then configured extras
    return [".md", ...normalizedExtra.filter((e: string) => e !== ".md")];
  }

  /**
   * Check if a link target exists in the collection.
   * Searches for files matching the target by filename (without extension) or by path.
   */
  private async linkTargetExists(target: string, fromPath: string): Promise<boolean> {
    const resolution = await this.resolveLinkFull(target, fromPath);
    return resolution.resolved !== null;
  }

  private normalizeLinkTarget(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  private extractLinkTarget(value: string): string {
    const trimmed = value.trim();
    const wikiMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
    return this.normalizeLinkTarget(wikiMatch ? wikiMatch[1] : trimmed);
  }

  private linkTargetMatches(targetPath: string, linkTarget: string): boolean {
    const normalizedTarget = this.normalizeLinkTarget(linkTarget);
    const targetBase = path.basename(targetPath, path.extname(targetPath));
    const targetNoExt = targetPath.replace(/\.(md|markdown)$/, "");
    return (
      normalizedTarget === targetBase ||
      normalizedTarget === targetPath ||
      normalizedTarget === targetNoExt
    );
  }

  private extractLinkTargetsForField(fieldDef: FieldDefinition, value: unknown): string[] {
    if (value === null || value === undefined) return [];
    const targets: string[] = [];

    if (fieldDef.type === "link") {
      if (typeof value === "string") {
        targets.push(this.extractLinkTarget(value));
      }
      return targets;
    }

    if (fieldDef.type === "list" && fieldDef.items?.type === "link") {
      if (!Array.isArray(value)) return targets;
      for (const item of value) {
        if (typeof item === "string") {
          targets.push(this.extractLinkTarget(item));
        }
      }
    }

    return targets;
  }

  private async findBacklinks(targetPaths: string[]): Promise<Array<{ target: string; referrer: string }>> {
    if (targetPaths.length === 0) return [];
    const targetSet = new Set(targetPaths);
    const results: Array<{ target: string; referrer: string }> = [];
    const seen = new Set<string>();

    const files = await this.scanFiles();
    for (const relativePath of files) {
      if (targetSet.has(relativePath)) continue;
      const readResult = await this.read(relativePath);
      if (readResult.error) continue;
      const frontmatter = readResult.frontmatter ?? {};
      const types = readResult.types ?? [];

      for (const typeName of types) {
        const typeDef = this.typeDefs.get(typeName);
        if (!typeDef?.fields) continue;
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          const value = frontmatter[fieldName];
          const targets = this.extractLinkTargetsForField(fieldDef, value);
          if (targets.length === 0) continue;
          for (const linkTarget of targets) {
            for (const targetPath of targetPaths) {
              if (!this.linkTargetMatches(targetPath, linkTarget)) continue;
              const key = `${relativePath}::${targetPath}`;
              if (seen.has(key)) continue;
              seen.add(key);
              results.push({ target: targetPath, referrer: relativePath });
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Compute backlinks for a specific file.
   * Scans all files in the collection for links (frontmatter, body, embeds) that resolve to targetPath.
   * Returns one entry per source file (deduplicated).
   */
  async computeBacklinksForFile(targetPath: string): Promise<BacklinkEntry[]> {
    const files = await this.scanFiles();
    const seenSources = new Set<string>();
    const backlinks: BacklinkEntry[] = [];

    for (const sourcePath of files) {
      const readResult = await this.read(sourcePath);
      if (readResult.error) continue;
      const frontmatter = readResult.frontmatter ?? {};
      const types = readResult.types ?? [];
      const body = readResult.body ?? "";

      // Collect all link values from this source file
      const allLinkValues: string[] = [];

      // 1. Frontmatter link-typed fields
      for (const typeName of types) {
        const typeDef = this.typeDefs.get(typeName);
        if (!typeDef?.fields) continue;
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          const value = frontmatter[fieldName];
          if (value === null || value === undefined) continue;
          if (fieldDef.type === "link" && typeof value === "string") {
            allLinkValues.push(value);
          } else if (fieldDef.type === "list" && fieldDef.items?.type === "link" && Array.isArray(value)) {
            for (const item of value) {
              if (typeof item === "string") allLinkValues.push(item);
            }
          }
        }
      }

      // 2. Body links (including embeds) — all create backlinks
      const bodyLinks = extractBodyLinks(body);
      for (const bl of bodyLinks) {
        allLinkValues.push(bl.raw);
      }

      // Check if any link resolves to the target
      for (const linkValue of allLinkValues) {
        if (seenSources.has(sourcePath)) break;
        try {
          const resolution = await this.resolveLinkFull(linkValue, sourcePath);
          if (resolution.resolved === targetPath) {
            seenSources.add(sourcePath);
            const name = sourcePath.split("/").pop() ?? "";
            backlinks.push({
              file: {
                path: sourcePath,
                name,
                basename: name.replace(/\.[^.]+$/, ""),
                folder: sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "",
                extension: "md",
              },
            });
          }
        } catch {
          // Invalid link, skip
        }
      }
    }

    return backlinks;
  }

  /**
   * Resolve a link target to a file in the collection.
   * Tries: exact path, path + .md, basename match, basename + .md.
   */
  private async resolveLink(
    linkTarget: string,
    fromPath: string,
    _knownFiles: string[],
  ): Promise<{ frontmatter: Record<string, unknown>; path: string; types: string[] } | null> {
    // Use the full link resolution system
    // Wrap as wikilink if not already a link format
    let linkValue = linkTarget;
    if (!linkTarget.startsWith("[[") && !linkTarget.startsWith("[") &&
        !linkTarget.startsWith("./") && !linkTarget.startsWith("../") &&
        !linkTarget.startsWith("/") && !linkTarget.includes("/")) {
      linkValue = `[[${linkTarget}]]`;
    }
    const resolution = await this.resolveLinkFull(linkValue, fromPath);
    if (!resolution.resolved) return null;
    const result = await this.read(resolution.resolved);
    if (result.error) return null;
    return {
      frontmatter: result.frontmatter ?? {},
      path: resolution.resolved,
      types: result.types ?? [],
    };
  }

  private async buildFileCache(files: string[]): Promise<Map<string, ReadResult>> {
    const fileCache = new Map<string, ReadResult>();
    for (const filePath of files) {
      const readResult = await this.read(filePath);
      if (!readResult.error) {
        fileCache.set(filePath, readResult);
      }
    }
    return fileCache;
  }

  private async updateCacheForPath(relativePath: string): Promise<void> {
    if (!this.cache) return;
    const fullPath = path.join(this.root, relativePath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      await this.cache.deleteFile(relativePath);
      return;
    }
    const parsed = await parseFileAsync(fullPath);
    if (parsed.error) {
      await this.cache.deleteFile(relativePath);
      return;
    }
    await this.cache.upsertFile(relativePath, stat, parsed.frontmatter, parsed.body ?? "");
  }

  /**
   * Scan all markdown files in the collection.
   */
  private async scanFiles(dir?: string): Promise<string[]> {
    const scanDir = dir ?? this.root;
    const files: string[] = [];

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(scanDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const entry of entries) {
      const fullPath = path.join(scanDir, entry.name);
      const relativePath = path.relative(this.root, fullPath).replace(/\\/g, "/");

      if (this.isExcluded(relativePath)) continue;

      // Nested collection boundary
      if (entry.isDirectory()) {
        const nestedConfig = path.join(fullPath, "mdbase.yaml");
        if (await this.fileExists(nestedConfig) && fullPath !== this.root) {
          continue;
        }
        if (this.config.settings.include_subfolders) {
          files.push(...await this.scanFiles(fullPath));
        }
      } else if (this.isMarkdownFile(entry.name)) {
        // Skip mdbase.yaml
        if (entry.name === "mdbase.yaml") continue;
        files.push(relativePath);
      }
    }

    return files;
  }

  private async scanAllFiles(dir?: string): Promise<string[]> {
    const scanDir = dir ?? this.root;
    const files: string[] = [];

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(scanDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const entry of entries) {
      const fullPath = path.join(scanDir, entry.name);
      const relativePath = path.relative(this.root, fullPath).replace(/\\/g, "/");

      if (this.isExcluded(relativePath)) continue;

      // Nested collection boundary
      if (entry.isDirectory()) {
        const nestedConfig = path.join(fullPath, "mdbase.yaml");
        if (await this.fileExists(nestedConfig) && fullPath !== this.root) {
          continue;
        }
        if (this.config.settings.include_subfolders) {
          files.push(...await this.scanAllFiles(fullPath));
        }
      } else {
        if (entry.name === "mdbase.yaml") continue;
        files.push(relativePath);
      }
    }

    return files;
  }

  private buildNonMarkdownSet(allFiles: string[]): Set<string> {
    const nonMd = new Set<string>();
    for (const filePath of allFiles) {
      if (!this.isMarkdownFile(filePath)) {
        nonMd.add(filePath);
      }
    }
    return nonMd;
  }
}

function coerceForRead(value: unknown, fieldDef: FieldDefinition): unknown {
  if (value === null || value === undefined) return value;

  switch (fieldDef.type) {
    case "string":
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;

    case "integer":
      if (typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num) && Number.isInteger(num)) return num;
      }
      if (typeof value === "number" && Number.isFinite(value) && value === Math.floor(value)) {
        return Math.floor(value);
      }
      return value;

    case "number":
      if (typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num)) return num;
      }
      return value;

    case "boolean":
      if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (lower === "true" || lower === "yes" || lower === "on") return true;
        if (lower === "false" || lower === "no" || lower === "off") return false;
      }
      return value;

    case "date":
      if (value instanceof Date) {
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, "0");
        const d = String(value.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }
      return value;

    case "datetime":
      if (value instanceof Date) {
        return formatDateTimeLocal(value);
      }
      return value;

    default:
      if (value instanceof Date) {
        return formatDateTimeLocal(value);
      }
      return value;
  }
}

/**
 * Format a Date object to an ISO 8601 datetime string.
 * js-yaml parses YAML dates like "2024-03-15 10:30:00" as Date objects in UTC.
 * We format without milliseconds and without Z for cleaner output that matches
 * the expected spec format.
 */
function formatDateTimeLocal(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
}

function slugify(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, ""); // Trim leading/trailing hyphens
}
