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
  computed?: string;
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
  // Link
  validate_exists?: boolean;
  target_type?: string;
}

export interface MatchRules {
  path_glob?: string;
  fields_present?: string[];
  where?: Record<string, unknown>;
}

export interface TypeDefinition {
  name: string;
  description?: string;
  extends?: string;
  strict?: boolean | "warn";
  fields?: Record<string, FieldDefinition>;
  path_pattern?: string;
  validation?: string;
  match?: MatchRules;
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
export async function loadTypes(
  collectionRoot: string,
  config: MdbaseConfig,
): Promise<TypeLoadResult> {
  return await loadTypesAsync(collectionRoot, config);
}

export async function loadTypesAsync(
  collectionRoot: string,
  config: MdbaseConfig,
): Promise<TypeLoadResult> {
  const warnings: string[] = [];
  const typesFolder = path.join(collectionRoot, config.settings.types_folder);
  const rawTypes = new Map<string, TypeDefinition>();

  try {
    await fs.promises.access(typesFolder);
  } catch {
    return { valid: true, types: new Map(), warnings };
  }

  // Read all .md files from the types folder (recursively)
  const typeFiles = await findMarkdownFilesAsync(typesFolder);

  for (const filePath of typeFiles) {
    const relativeName = path.relative(typesFolder, filePath);
    const fileBasename = path.basename(relativeName, path.extname(relativeName));

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
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
      if (Array.isArray(data.extends)) {
        return {
          valid: false,
          error: {
            code: "invalid_type_definition",
            message: `Type "${typeName}" has extends as a list; only single inheritance is allowed`,
          },
        };
      }
      typeDef.extends = String(data.extends).toLowerCase();
    }
    if (data.strict !== undefined) {
      typeDef.strict = data.strict as boolean | "warn";
    }
    if (data.fields !== undefined && data.fields !== null) {
      typeDef.fields = data.fields as Record<string, FieldDefinition>;
      // Validate field definitions
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        // Validate enum values are strings
        if (fieldDef.type === "enum" && fieldDef.values) {
          for (const val of fieldDef.values) {
            if (typeof val !== "string") {
              return {
                valid: false,
                error: {
                  code: "invalid_type_definition",
                  message: `Type "${typeName}" field "${fieldName}" has non-string enum value: ${val}`,
                },
              };
            }
          }
        }
        // Validate computed field constraints
        if (fieldDef.computed) {
          if (fieldDef.required) {
            return {
              valid: false,
              error: {
                code: "invalid_type_definition",
                message: `Type "${typeName}" field "${fieldName}" cannot be both computed and required`,
              },
            };
          }
          if (fieldDef.default !== undefined) {
            return {
              valid: false,
              error: {
                code: "invalid_type_definition",
                message: `Type "${typeName}" field "${fieldName}" cannot be both computed and have a default`,
              },
            };
          }
          if (fieldDef.generated !== undefined) {
            return {
              valid: false,
              error: {
                code: "invalid_type_definition",
                message: `Type "${typeName}" field "${fieldName}" cannot be both computed and generated`,
              },
            };
          }
        }
        // Validate regex patterns are valid
        if (fieldDef.pattern) {
          try {
            new RegExp(fieldDef.pattern);
          } catch {
            return {
              valid: false,
              error: {
                code: "invalid_type_definition",
                message: `Type "${typeName}" field "${fieldName}" has invalid regex pattern: ${fieldDef.pattern}`,
              },
            };
          }
        }
      }
    }
    if (data.path_pattern !== undefined) {
      typeDef.path_pattern = String(data.path_pattern);
    } else if (data.filename_pattern !== undefined) {
      typeDef.path_pattern = String(data.filename_pattern);
    }
    if (data.validation !== undefined) {
      typeDef.validation = String(data.validation);
    }

    // Parse match rules
    if (data.match !== undefined && data.match !== null && typeof data.match === "object") {
      const matchData = data.match as Record<string, unknown>;
      const match: MatchRules = {};
      if (matchData.path_glob !== undefined) {
        match.path_glob = String(matchData.path_glob);
      }
      if (matchData.fields_present !== undefined && Array.isArray(matchData.fields_present)) {
        match.fields_present = matchData.fields_present.map(String);
      }
      if (matchData.where !== undefined && typeof matchData.where === "object" && matchData.where !== null) {
        match.where = matchData.where as Record<string, unknown>;
      }
      typeDef.match = match;
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

  // Check for circular computed field dependencies across all types
  if (resolved.types) {
    for (const [, typeDef] of resolved.types) {
      if (!typeDef.fields) continue;
      const computedFields = new Map<string, string>();
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.computed) {
          computedFields.set(fieldName, fieldDef.computed);
        }
      }
      if (computedFields.size > 0) {
        const circularError = detectCircularComputed(computedFields);
        if (circularError) {
          return { valid: false, error: circularError };
        }
      }
    }
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
export async function getType(
  collectionRoot: string,
  config: MdbaseConfig,
  typeName: string,
): Promise<GetTypeResult> {
  return await getTypeAsync(collectionRoot, config, typeName);
}

export async function getTypeAsync(
  collectionRoot: string,
  config: MdbaseConfig,
  typeName: string,
): Promise<GetTypeResult> {
  const result = await loadTypesAsync(collectionRoot, config);
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
  if (name.length > MAX_TYPE_NAME_LENGTH) {
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

async function findMarkdownFilesAsync(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    await fs.promises.access(dir);
  } catch {
    return files;
  }

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findMarkdownFilesAsync(fullPath));
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".markdown")) {
      files.push(fullPath);
    }
  }
  return files;
}

function detectCircularComputed(computedFields: Map<string, string>): { code: string; message: string } | null {
  // Build dependency graph: for each computed field, find which other computed fields it references
  const deps = new Map<string, Set<string>>();
  const allComputed = new Set(computedFields.keys());

  for (const [fieldName, expr] of computedFields) {
    const fieldDeps = new Set<string>();
    // Simple identifier extraction from expression
    const identPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    let match;
    while ((match = identPattern.exec(expr)) !== null) {
      const ident = match[1];
      if (allComputed.has(ident) && ident !== fieldName) {
        fieldDeps.add(ident);
      }
      // Self-reference
      if (ident === fieldName) {
        return {
          code: "circular_computed",
          message: `Self-referencing computed field: "${fieldName}"`,
        };
      }
    }
    deps.set(fieldName, fieldDeps);
  }

  // DFS cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    if (inStack.has(node)) return true; // cycle
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of deps.get(node) ?? []) {
      if (dfs(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  for (const fieldName of computedFields.keys()) {
    if (dfs(fieldName)) {
      return {
        code: "circular_computed",
        message: `Circular dependency detected in computed fields involving "${fieldName}"`,
      };
    }
  }
  return null;
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
    // Inherit strict from parent if not explicitly set on child
    if (resolvedType.strict === undefined && parent.strict !== undefined) {
      resolvedType.strict = parent.strict;
    }
    // Inherit path_pattern from parent if not set
    if (resolvedType.path_pattern === undefined && parent.path_pattern !== undefined) {
      resolvedType.path_pattern = parent.path_pattern;
    }
    // Inherit match rules from parent if not set
    if (resolvedType.match === undefined && parent.match !== undefined) {
      resolvedType.match = parent.match;
    }
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
