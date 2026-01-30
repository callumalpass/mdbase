/**
 * Collection - the main entry point for mdbase operations.
 * Ties together config loading, type loading, file reading, and validation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";
import { ulid } from "ulid";
import { loadConfig, MdbaseConfig } from "../config/loader.js";
import { loadTypes, getType, TypeDefinition, FieldDefinition } from "../types/loader.js";
import { parseFile, serializeFile } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../validation/validator.js";
import { MdbaseError } from "../errors.js";

export interface ReadResult {
  valid?: boolean;
  frontmatter?: Record<string, unknown>;
  body?: string;
  types?: string[];
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
  error?: { code: string; message: string };
}

export interface QueryResult {
  results: Array<{
    path: string;
    frontmatter: Record<string, unknown>;
    types: string[];
    body?: string;
  }>;
}

export class Collection {
  private config: MdbaseConfig;
  private typeDefs: Map<string, TypeDefinition>;
  private excludeMatchers: ((str: string) => boolean)[];

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
  }

  static open(collectionRoot: string): { collection?: Collection; error?: { code: string; message: string } } {
    const configResult = loadConfig(collectionRoot);
    if (!configResult.valid || !configResult.config) {
      return { error: configResult.error };
    }

    const typesResult = loadTypes(collectionRoot, configResult.config);
    if (!typesResult.valid) {
      return { error: typesResult.error };
    }

    return {
      collection: new Collection(
        collectionRoot,
        configResult.config,
        typesResult.types!,
      ),
    };
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

  /**
   * Get the file types declared in frontmatter.
   */
  private getFileTypes(frontmatter: Record<string, unknown>): string[] {
    for (const key of this.config.settings.explicit_type_keys) {
      if (key in frontmatter) {
        const val = frontmatter[key];
        if (Array.isArray(val)) {
          return val.map((v) => String(v).toLowerCase());
        }
        if (typeof val === "string") {
          return [val.toLowerCase()];
        }
      }
    }
    return [];
  }

  /**
   * Read a file from the collection.
   */
  read(relativePath: string): ReadResult {
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
    if (!fs.existsSync(fullPath)) {
      return {
        error: { code: "file_not_found", message: `File not found: ${relativePath}` },
      };
    }

    // Check for nested collection boundary
    const parts = relativePath.split("/");
    for (let i = 1; i < parts.length; i++) {
      const subdir = path.join(this.root, ...parts.slice(0, i));
      if (fs.existsSync(path.join(subdir, "mdbase.yaml"))) {
        return {
          error: { code: "file_not_found", message: `File is inside nested collection: ${relativePath}` },
        };
      }
    }

    // Check for mdbase.yaml - it's not a record
    if (path.basename(relativePath) === "mdbase.yaml") {
      return {
        error: { code: "file_not_found", message: "mdbase.yaml is not a record" },
      };
    }

    const parsed = parseFile(fullPath);

    // Handle non-mapping frontmatter
    if (parsed.error) {
      if (this.config.settings.default_validation === "off") {
        return {
          valid: true,
          frontmatter: {},
          body: parsed.body,
          types: [],
        };
      }
      if (this.config.settings.default_validation === "warn") {
        return {
          valid: true,
          frontmatter: {},
          body: parsed.body,
          types: [],
          warnings: [parsed.error.message],
        } as unknown as ReadResult;
      }
      return {
        error: parsed.error,
      };
    }

    const types = this.getFileTypes(parsed.frontmatter);

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

    // Coerce remaining Date objects not handled by type definitions
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value instanceof Date) {
        frontmatter[key] = value.toISOString();
      }
    }

    return {
      valid: true,
      frontmatter,
      body: parsed.body,
      types,
    };
  }

  /**
   * Validate a single file or the entire collection.
   */
  validate(relativePath?: string): ValidateResult {
    if (relativePath) {
      return this.validateFile(relativePath);
    }
    return this.validateCollection();
  }

  private validateFile(relativePath: string): ValidateResult {
    const readResult = this.read(relativePath);
    if (readResult.error) {
      return {
        valid: false,
        issues: [],
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
    return result;
  }

  private validateCollection(): ValidateResult {
    const allIssues: MdbaseError[] = [];
    const allFiles = new Map<string, Record<string, unknown>>();

    // Scan all files
    const files = this.scanFiles();
    for (const relativePath of files) {
      const readResult = this.read(relativePath);
      if (readResult.frontmatter) {
        allFiles.set(relativePath, readResult.frontmatter);
      }
    }

    // Validate each file
    for (const [relativePath, frontmatter] of allFiles) {
      const types = this.getFileTypes(frontmatter);
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
  create(input: {
    type?: string;
    types?: string[];
    path?: string;
    frontmatter?: Record<string, unknown>;
    body?: string;
  }): CreateResult {
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
      // Simple template replacement
      relativePath = pattern.replace(/\{(\w+)\}/g, (_, key) => {
        const val = input.frontmatter?.[key];
        return val != null ? String(val) : key;
      });
    }

    // Path traversal check
    if (relativePath.includes("..")) {
      return {
        error: { code: "path_traversal", message: "Path contains '..' traversal" },
      };
    }

    // Check if file already exists
    const fullPath = path.join(this.root, relativePath);
    if (fs.existsSync(fullPath)) {
      return {
        error: { code: "path_conflict", message: `File already exists: ${relativePath}` },
      };
    }

    // Build frontmatter
    const frontmatter: Record<string, unknown> = { ...(input.frontmatter ?? {}) };

    // Set the type key
    if (typeNames.length === 1) {
      const typeKey = this.config.settings.explicit_type_keys[0] ?? "type";
      if (!(typeKey in frontmatter)) {
        frontmatter[typeKey] = typeNames[0];
      }
    } else if (typeNames.length > 1) {
      const typesKey = this.config.settings.explicit_type_keys.find((k) => k.endsWith("s")) ??
                       this.config.settings.explicit_type_keys[0] ?? "types";
      if (!(typesKey in frontmatter)) {
        frontmatter[typesKey] = typeNames;
      }
    }

    // Apply generated fields and defaults
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;

      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldName in frontmatter && frontmatter[fieldName] !== undefined) continue;

        if (fieldDef.generated) {
          const generated = this.generateValue(fieldDef, frontmatter);
          if (generated !== undefined) {
            frontmatter[fieldName] = generated;
          }
        } else if (fieldDef.default !== undefined && !(fieldName in frontmatter)) {
          frontmatter[fieldName] = fieldDef.default;
        }
      }
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

    // Validate before writing (if validation is not off)
    if (this.config.settings.default_validation !== "off") {
      const typeDefs = typeNames.map((t) => this.typeDefs.get(t)!).filter(Boolean);
      const valResult = validateFrontmatter(frontmatter, typeDefs, this.config);
      if (!valResult.valid && this.config.settings.default_validation === "error") {
        return {
          valid: false,
          error: { code: "validation_failed", message: "Validation failed on create" },
          issues: valResult.issues,
        } as unknown as CreateResult;
      }
    }

    // Write file
    const body = input.body ?? "";
    const content = serializeFile(
      frontmatter,
      body,
      this.config.settings.write_nulls,
      this.config.settings.write_empty_lists,
    );
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);

    return {
      valid: true,
      frontmatter,
      body,
      path: relativePath,
      types: typeNames,
    };
  }

  /**
   * Update an existing file in the collection.
   */
  update(input: {
    path: string;
    fields?: Record<string, unknown>;
    body?: string;
  }): UpdateResult {
    const relativePath = input.path;
    const fullPath = path.join(this.root, relativePath);

    if (!fs.existsSync(fullPath)) {
      return {
        error: { code: "file_not_found", message: `File not found: ${relativePath}` },
      };
    }

    const existing = parseFile(fullPath);
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
          };
        }
      }
    }

    // Write file
    const body = input.body ?? existing.body;
    const content = serializeFile(
      frontmatter,
      body,
      this.config.settings.write_nulls,
      this.config.settings.write_empty_lists,
    );
    fs.writeFileSync(fullPath, content);

    return {
      valid: true,
      frontmatter,
      body,
    };
  }

  /**
   * Delete a file from the collection.
   */
  delete(relativePath: string): DeleteResult {
    const fullPath = path.join(this.root, relativePath);
    if (!fs.existsSync(fullPath)) {
      return {
        error: { code: "file_not_found", message: `File not found: ${relativePath}` },
      };
    }
    fs.unlinkSync(fullPath);
    return { valid: true };
  }

  /**
   * Create a new type definition file.
   */
  createType(input: {
    name: string;
    description?: string;
    extends?: string;
    strict?: boolean | "warn";
    fields?: Record<string, unknown>;
    path_pattern?: string;
  }): { valid?: boolean; error?: { code: string; message: string }; type?: Record<string, unknown> } {
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
    if (!TYPE_NAME_REGEX.test(name) || name.length >= 64) {
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

    // Build the type definition frontmatter
    const typeFrontmatter: Record<string, unknown> = { name };
    if (input.description) typeFrontmatter.description = input.description;
    if (input.extends) typeFrontmatter.extends = input.extends;
    if (input.strict !== undefined) typeFrontmatter.strict = input.strict;
    if (input.fields) typeFrontmatter.fields = input.fields;
    if (input.path_pattern) typeFrontmatter.path_pattern = input.path_pattern;

    // Write the type file
    const typesFolder = path.join(this.root, this.config.settings.types_folder);
    fs.mkdirSync(typesFolder, { recursive: true });
    const typeFilePath = path.join(typesFolder, `${name}.md`);

    if (fs.existsSync(typeFilePath)) {
      return {
        valid: false,
        error: {
          code: "path_conflict",
          message: `Type file already exists: ${name}.md`,
        },
      };
    }

    const content = serializeFile(typeFrontmatter, "", "omit", true);
    fs.writeFileSync(typeFilePath, content);

    return {
      valid: true,
      type: typeFrontmatter,
    };
  }

  /**
   * Rename/move a file in the collection.
   */
  rename(input: { from: string; to: string }): { valid?: boolean; error?: { code: string; message: string } } {
    const fromPath = path.join(this.root, input.from);
    const toPath = path.join(this.root, input.to);

    if (!fs.existsSync(fromPath)) {
      return {
        error: { code: "file_not_found", message: `Source not found: ${input.from}` },
      };
    }

    if (fs.existsSync(toPath)) {
      return {
        error: { code: "path_conflict", message: `Target exists: ${input.to}` },
      };
    }

    // Path traversal check
    if (input.to.includes("..")) {
      return {
        error: { code: "path_traversal", message: "Path contains '..' traversal" },
      };
    }

    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.renameSync(fromPath, toPath);

    return { valid: true };
  }

  /**
   * Query the collection.
   */
  query(input: {
    types?: string[];
    where?: string;
    order_by?: Array<{ field: string; direction?: string }>;
  }): QueryResult {
    const files = this.scanFiles();
    let results: Array<{
      path: string;
      frontmatter: Record<string, unknown>;
      types: string[];
      body?: string;
    }> = [];

    for (const relativePath of files) {
      const readResult = this.read(relativePath);
      if (readResult.error) continue;

      const fileTypes = readResult.types ?? [];

      // Filter by type
      if (input.types && input.types.length > 0) {
        const hasMatchingType = input.types.some((t) =>
          fileTypes.includes(t.toLowerCase()),
        );
        if (!hasMatchingType) continue;
      }

      results.push({
        path: relativePath,
        frontmatter: readResult.frontmatter ?? {},
        types: fileTypes,
        body: readResult.body,
      });
    }

    // Sort
    if (input.order_by) {
      for (const orderSpec of [...input.order_by].reverse()) {
        const field = orderSpec.field;
        const desc = orderSpec.direction === "desc";

        results.sort((a, b) => {
          let va: unknown;
          let vb: unknown;

          if (field === "file.path") {
            va = a.path;
            vb = b.path;
          } else {
            va = a.frontmatter[field];
            vb = b.frontmatter[field];
          }

          if (va === vb) return 0;
          if (va === null || va === undefined) return desc ? -1 : 1;
          if (vb === null || vb === undefined) return desc ? 1 : -1;
          if (va < vb) return desc ? 1 : -1;
          return desc ? -1 : 1;
        });
      }
    }

    return { results };
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
    }
    return undefined;
  }

  /**
   * Scan all markdown files in the collection.
   */
  private scanFiles(dir?: string): string[] {
    const scanDir = dir ?? this.root;
    const files: string[] = [];

    for (const entry of fs.readdirSync(scanDir, { withFileTypes: true })) {
      const fullPath = path.join(scanDir, entry.name);
      const relativePath = path.relative(this.root, fullPath).replace(/\\/g, "/");

      if (this.isExcluded(relativePath)) continue;

      // Nested collection boundary
      if (entry.isDirectory()) {
        const nestedConfig = path.join(fullPath, "mdbase.yaml");
        if (fs.existsSync(nestedConfig) && fullPath !== this.root) {
          continue;
        }
        if (this.config.settings.include_subfolders) {
          files.push(...this.scanFiles(fullPath));
        }
      } else if (this.isMarkdownFile(entry.name)) {
        // Skip mdbase.yaml
        if (entry.name === "mdbase.yaml") continue;
        files.push(relativePath);
      }
    }

    return files;
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
        return value.toISOString();
      }
      return value;

    default:
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;
  }
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
