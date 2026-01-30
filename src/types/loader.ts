/**
 * Type definition loader.
 * Loads type definitions from the types folder, validates names,
 * resolves inheritance chains, and detects circular inheritance.
 * Implements §5 of the mdbase specification.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { MdbaseConfig } from "../config/loader.js";

export interface FieldDefinition {
  type: string;
  required?: boolean;
  default?: unknown;
  deprecated?: boolean;
  unique?: boolean;
  generated?: string | { from: string; transform: string };
  // String constraints
  min_length?: number;
  max_length?: number;
  pattern?: string;
  // Number/integer constraints
  min?: number;
  max?: number;
  // Enum
  values?: string[];
  // List constraints
  items?: FieldDefinition;
  min_items?: number;
  max_items?: number;
  // Object
  fields?: Record<string, FieldDefinition>;
}

export interface TypeDefinition {
  name: string;
  description?: string;
  extends?: string;
  strict?: boolean | "warn";
  fields?: Record<string, FieldDefinition>;
  path_pattern?: string;
  validation?: string;
}

export interface TypeLoadResult {
  valid: boolean;
  types?: Map<string, TypeDefinition>;
  warnings?: string[];
  error?: { code: string; message: string };
}

export interface GetTypeResult {
  valid: boolean;
  type?: TypeDefinition;
  warnings?: string[];
  error?: { code: string; message: string };
}

const RESERVED_NAMES = new Set(["file", "formula", "this"]);
const TYPE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const MAX_TYPE_NAME_LENGTH = 64;

/**
 * Load all type definitions from the types folder.
 */
export function loadTypes(
  collectionRoot: string,
  config: MdbaseConfig,
): TypeLoadResult {
  const warnings: string[] = [];
  const typesFolder = path.join(collectionRoot, config.settings.types_folder);
  const rawTypes = new Map<string, TypeDefinition>();

  if (!fs.existsSync(typesFolder)) {
    return { valid: true, types: new Map(), warnings };
  }

  // Read all .md files from the types folder (recursively)
  const typeFiles = findMarkdownFiles(typesFolder);

  for (const filePath of typeFiles) {
    const relativeName = path.relative(typesFolder, filePath);
    const fileBasename = path.basename(relativeName, path.extname(relativeName));

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return {
        valid: false,
        error: {
          code: "invalid_type_definition",
          message: `Failed to read type file: ${relativeName}`,
        },
      };
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(content);
    } catch {
      return {
        valid: false,
        error: {
          code: "invalid_type_definition",
          message: `Failed to parse frontmatter in type file: ${relativeName}`,
        },
      };
    }

    const data = parsed.data as Record<string, unknown>;

    // Name is required
    if (!data.name || typeof data.name !== "string") {
      return {
        valid: false,
        error: {
          code: "invalid_type_definition",
          message: `Type file ${relativeName} is missing required 'name' field`,
        },
      };
    }

    const typeName = String(data.name).toLowerCase();

    // Validate type name
    const nameError = validateTypeName(typeName);
    if (nameError) {
      return {
        valid: false,
        error: nameError,
      };
    }

    // Warn if name doesn't match filename
    if (typeName !== fileBasename.toLowerCase()) {
      warnings.push(
        `Type name "${typeName}" in ${relativeName} does not match filename "${fileBasename}"`,
      );
    }

    const typeDef: TypeDefinition = {
      name: typeName,
    };

    if (data.description !== undefined) {
      typeDef.description = String(data.description);
    }
    if (data.extends !== undefined) {
      typeDef.extends = String(data.extends).toLowerCase();
    }
    if (data.strict !== undefined) {
      typeDef.strict = data.strict as boolean | "warn";
    }
    if (data.fields !== undefined && data.fields !== null) {
      typeDef.fields = data.fields as Record<string, FieldDefinition>;
    }
    if (data.path_pattern !== undefined) {
      typeDef.path_pattern = String(data.path_pattern);
    }
    if (data.validation !== undefined) {
      typeDef.validation = String(data.validation);
    }

    rawTypes.set(typeName, typeDef);
  }

  // Resolve inheritance
  const resolved = resolveInheritance(rawTypes);
  if (!resolved.valid) {
    return {
      valid: false,
      error: resolved.error,
    };
  }

  return {
    valid: true,
    types: resolved.types,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Get a single resolved type by name.
 */
export function getType(
  collectionRoot: string,
  config: MdbaseConfig,
  typeName: string,
): GetTypeResult {
  const result = loadTypes(collectionRoot, config);
  if (!result.valid) {
    return {
      valid: false,
      error: result.error,
    };
  }

  const normalizedName = typeName.toLowerCase();
  const type = result.types!.get(normalizedName);
  if (!type) {
    return {
      valid: false,
      error: {
        code: "unknown_type",
        message: `Type "${typeName}" not found`,
      },
    };
  }

  return {
    valid: true,
    type,
    warnings: result.warnings,
  };
}

function validateTypeName(name: string): { code: string; message: string } | null {
  if (name.length >= MAX_TYPE_NAME_LENGTH) {
    return {
      code: "invalid_type_definition",
      message: `Type name "${name}" exceeds maximum length of ${MAX_TYPE_NAME_LENGTH}`,
    };
  }

  if (name.startsWith("_")) {
    return {
      code: "invalid_type_definition",
      message: `Type name "${name}" is reserved (starts with underscore)`,
    };
  }

  if (RESERVED_NAMES.has(name)) {
    return {
      code: "invalid_type_definition",
      message: `Type name "${name}" is a reserved keyword`,
    };
  }

  if (!TYPE_NAME_PATTERN.test(name)) {
    return {
      code: "invalid_type_definition",
      message: `Type name "${name}" is invalid (must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores)`,
    };
  }

  return null;
}

function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(fullPath));
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".markdown")) {
      files.push(fullPath);
    }
  }
  return files;
}

interface InheritanceResult {
  valid: boolean;
  types?: Map<string, TypeDefinition>;
  error?: { code: string; message: string };
}

function resolveInheritance(types: Map<string, TypeDefinition>): InheritanceResult {
  const resolved = new Map<string, TypeDefinition>();
  const resolving = new Set<string>();

  function resolve(name: string): TypeDefinition | { error: { code: string; message: string } } {
    if (resolved.has(name)) {
      return resolved.get(name)!;
    }

    const type = types.get(name);
    if (!type) {
      return {
        error: {
          code: "missing_parent_type",
          message: `Parent type "${name}" not found`,
        },
      };
    }

    if (resolving.has(name)) {
      return {
        error: {
          code: "circular_inheritance",
          message: `Circular inheritance detected involving type "${name}"`,
        },
      };
    }

    resolving.add(name);

    if (!type.extends) {
      // No parent - just resolve as-is
      const resolvedType = { ...type };
      resolved.set(name, resolvedType);
      resolving.delete(name);
      return resolvedType;
    }

    // Resolve parent first
    const parent = resolve(type.extends);
    if ("error" in parent) {
      return parent;
    }

    // Merge: parent fields first, child fields override
    const mergedFields: Record<string, FieldDefinition> = {};
    if (parent.fields) {
      Object.assign(mergedFields, parent.fields);
    }
    if (type.fields) {
      Object.assign(mergedFields, type.fields);
    }

    const resolvedType: TypeDefinition = {
      ...type,
      fields: Object.keys(mergedFields).length > 0 ? mergedFields : undefined,
    };
    // Don't carry extends into the resolved type
    delete resolvedType.extends;

    resolved.set(name, resolvedType);
    resolving.delete(name);
    return resolvedType;
  }

  // Resolve all types
  for (const name of types.keys()) {
    const result = resolve(name);
    if ("error" in result) {
      return { valid: false, error: result.error };
    }
  }

  return { valid: true, types: resolved };
}
