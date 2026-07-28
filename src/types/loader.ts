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
  generated?: string | { from: string; transform: string } | { random: number } | { sequence: unknown };
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
  path_glob?: string | string[];
  fields_present?: string[];
  where?: Record<string, unknown>;
  expr?: { $expr: string };
}

export interface V03SchemaWrapper {
  dialect: "json-schema-2020-12";
  value?: Record<string, unknown>;
  ref?: string;
}

export interface V03LinkRule {
  target_type?: string | string[];
  validate_exists?: boolean;
  format?: "wikilink" | "markdown" | "path" | "any";
}

export interface V03UniqueRule {
  field: string;
  scope?: "collection" | "type" | "path_glob";
  path_glob?: string;
}

export interface V03CollectionSemantics {
  display?: {
    name_field?: string;
    description_field?: string;
    icon?: string;
    color_field?: string;
  };
  read_defaults?: Record<string, unknown>;
  links?: Record<string, V03LinkRule>;
  unique?: V03UniqueRule[];
  path?: {
    pattern?: string;
    runtime?: string;
    template?: string;
    folder?: string;
    generated_by?: string;
  };
  projections?: Record<string, { expr: string; description?: string }>;
}

export type V03LifecycleValue =
  | { now: true }
  | { today: true }
  | { uuid: true }
  | { ulid: true }
  | { slugify: string }
  | { copy: string }
  | { literal: unknown };

export interface V03LifecycleAction {
  if?: string;
  set: Record<string, V03LifecycleValue>;
}

export interface V03Lifecycle {
  on_create?: V03LifecycleAction | V03LifecycleAction[];
  on_update?: V03LifecycleAction | V03LifecycleAction[];
  on_delete?: V03LifecycleAction | V03LifecycleAction[];
  on_rename?: V03LifecycleAction | V03LifecycleAction[];
}

export interface V03Migration {
  from: number;
  to: number;
  steps?: Array<Record<string, unknown>>;
  action?: string;
  description?: string;
}

export interface V03DataContractImplementation {
  contract: string;
  version: string;
  fields: Record<string, string>;
  binding?: Record<string, unknown>;
  [extension: `x-${string}`]: unknown;
}

export interface TypeDefinition {
  name: string;
  kind?: "mdbase.type";
  version?: number;
  description?: string;
  extends?: string;
  strict?: boolean | "warn";
  fields?: Record<string, FieldDefinition>;
  path_pattern?: string;
  validation?: string;
  match?: MatchRules;
  display_name_key?: string;
  schema?: V03SchemaWrapper;
  collection?: V03CollectionSemantics;
  lifecycle?: V03Lifecycle;
  runtime?: Record<string, unknown>;
  migrations?: V03Migration[];
  implements?: V03DataContractImplementation[];
  source_path?: string;
  domain?: Record<string, unknown>;
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
  const migrationsFolder = path.resolve(collectionRoot, config.settings.migrations_folder);
  const rawTypes = new Map<string, TypeDefinition>();

  try {
    await fs.promises.access(typesFolder);
  } catch {
    return { valid: true, types: new Map(), warnings };
  }

  // Read all .md files from the types folder (recursively)
  let typeFiles = await findMarkdownFilesAsync(typesFolder);
  // Exclude migration manifests from type loading
  typeFiles = typeFiles.filter((filePath) => {
    const normalized = path.resolve(filePath);
    if (normalized === migrationsFolder) return false;
    return !normalized.startsWith(migrationsFolder + path.sep);
  });

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
    const isV03Type = data.kind === "mdbase.type";

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
    const nameError = validateTypeName(typeName, isV03Type ? 1 : 0);
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
      source_path: path.relative(collectionRoot, filePath).replaceAll("\\", "/"),
    };

    if (isV03Type) {
      typeDef.kind = "mdbase.type";
      if (data.version !== undefined) {
        const version = Number(data.version);
        if (!Number.isInteger(version) || version < 1) {
          return {
            valid: false,
            error: {
              code: "invalid_type_definition",
              message: `Type "${typeName}" has invalid version "${data.version}"`,
            },
          };
        }
        typeDef.version = version;
      }
      if (data.description !== undefined) {
        typeDef.description = String(data.description);
      }
      const shapeError = validateV03TypeFileShape(data, typeName);
      if (shapeError) {
        return {
          valid: false,
          error: shapeError,
        };
      }
      if (!data.schema || typeof data.schema !== "object" || Array.isArray(data.schema)) {
        return {
          valid: false,
          error: {
            code: "invalid_type_definition",
            message: `Type "${typeName}" is missing required v0.3 schema wrapper`,
          },
        };
      }
      const schema = data.schema as Record<string, unknown>;
      if (schema.dialect !== "json-schema-2020-12") {
        return {
          valid: false,
          error: {
            code: "invalid_type_definition",
            message: `Type "${typeName}" must use schema.dialect json-schema-2020-12`,
          },
        };
      }
      if ((schema.value === undefined) === (schema.ref === undefined)) {
        return {
          valid: false,
          error: {
            code: "invalid_type_definition",
            message: `Type "${typeName}" must define exactly one of schema.value or schema.ref`,
          },
        };
      }
      if (schema.ref !== undefined && String(schema.ref).length === 0) {
        return {
          valid: false,
          error: {
            code: "invalid_type_definition",
            message: `Type "${typeName}" schema.ref must not be empty`,
          },
        };
      }
      if (schema.value !== undefined && (typeof schema.value !== "object" || schema.value === null || Array.isArray(schema.value))) {
        return {
          valid: false,
          error: {
            code: "invalid_type_definition",
            message: `Type "${typeName}" schema.value must be a mapping`,
          },
        };
      }
      let resolvedSchemaValue = schema.value as Record<string, unknown> | undefined;
      if (schema.ref !== undefined) {
        const resolved = await resolveV03SchemaRef(String(schema.ref), filePath, collectionRoot, typeName);
        if (!resolved.valid) {
          return {
            valid: false,
            error: resolved.error,
          };
        }
        resolvedSchemaValue = resolved.schema;
      }
      const embeddedRefError = findUnsupportedV03EmbeddedSchemaRef(resolvedSchemaValue);
      if (embeddedRefError) {
        return {
          valid: false,
          error: {
            code: embeddedRefError.forbidden ? "schema_ref_forbidden" : "unsupported_profile",
            message: embeddedRefError.forbidden
              ? `Type "${typeName}" contains forbidden JSON Schema reference "${embeddedRefError.ref}"`
              : `Type "${typeName}" requires the optional external_schema_refs feature for "${embeddedRefError.ref}"`,
          },
        };
      }
      typeDef.schema = {
        dialect: "json-schema-2020-12",
        ...(resolvedSchemaValue !== undefined ? { value: resolvedSchemaValue } : {}),
        ...(schema.ref !== undefined ? { ref: String(schema.ref) } : {}),
      };

      if (data.match !== undefined && data.match !== null && typeof data.match === "object" && !Array.isArray(data.match)) {
        const matchData = data.match as Record<string, unknown>;
        const match: MatchRules = {};
        if (matchData.path_glob !== undefined) {
          match.path_glob = Array.isArray(matchData.path_glob)
            ? matchData.path_glob.map(String)
            : String(matchData.path_glob);
        }
        if (matchData.fields_present !== undefined && Array.isArray(matchData.fields_present)) {
          match.fields_present = matchData.fields_present.map(String);
        }
        if (matchData.where !== undefined && typeof matchData.where === "object" && matchData.where !== null && !Array.isArray(matchData.where)) {
          match.where = matchData.where as Record<string, unknown>;
        }
        if (matchData.expr !== undefined && typeof matchData.expr === "object" && matchData.expr !== null && !Array.isArray(matchData.expr)) {
          const expr = matchData.expr as Record<string, unknown>;
          if (typeof expr.$expr === "string") {
            match.expr = { $expr: expr.$expr };
          }
        }
        typeDef.match = match;
      }

      if (data.collection !== undefined && data.collection !== null && typeof data.collection === "object" && !Array.isArray(data.collection)) {
        typeDef.collection = data.collection as V03CollectionSemantics;
        if (typeDef.collection.display?.name_field) {
          typeDef.display_name_key = typeDef.collection.display.name_field;
        }
        if (typeDef.collection.path?.pattern) {
          typeDef.path_pattern = typeDef.collection.path.pattern;
        }
      }
      if (data.lifecycle !== undefined && data.lifecycle !== null && typeof data.lifecycle === "object" && !Array.isArray(data.lifecycle)) {
        typeDef.lifecycle = data.lifecycle as V03Lifecycle;
      }
      if (data.runtime !== undefined && data.runtime !== null && typeof data.runtime === "object" && !Array.isArray(data.runtime)) {
        typeDef.runtime = data.runtime as Record<string, unknown>;
      }
      if (data.migrations !== undefined) {
        const migrations = parseV03Migrations(data.migrations, typeName);
        if (!migrations.valid) {
          return {
            valid: false,
            error: migrations.error,
          };
        }
        typeDef.migrations = migrations.migrations;
      }
      if (data.implements !== undefined) {
        typeDef.implements = (data.implements as V03DataContractImplementation[]).map((implementation) => ({
          ...implementation,
          fields: { ...implementation.fields },
          ...(implementation.binding ? { binding: { ...implementation.binding } } : {}),
        }));
      }
      const domain: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("x-")) {
          domain[key] = value;
        }
      }
      if (Object.keys(domain).length > 0) {
        typeDef.domain = domain;
      }

      rawTypes.set(typeName, typeDef);
      continue;
    }

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
        // Validate enum values are strings and non-empty
        if (fieldDef.type === "enum" && fieldDef.values) {
          if (fieldDef.values.length === 0) {
            return {
              valid: false,
              error: {
                code: "invalid_type_definition",
                message: `Type "${typeName}" field "${fieldName}": enum values list must not be empty`,
              },
            };
          }
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
        // Validate random generation length
        if (typeof fieldDef.generated === "object" && fieldDef.generated !== null && "random" in fieldDef.generated) {
          const len = (fieldDef.generated as Record<string, unknown>).random;
          if (typeof len !== "number" || len <= 0 || !Number.isInteger(len)) {
            return { valid: false, error: { code: "invalid_type_definition", message: `Type "${typeName}" field "${fieldName}": random length must be a positive integer` } };
          }
        }
        // Validate sequence requires integer type
        if (fieldDef.generated === "sequence" || (typeof fieldDef.generated === "object" && fieldDef.generated !== null && "sequence" in fieldDef.generated)) {
          if (fieldDef.type !== "integer") {
            return { valid: false, error: { code: "invalid_type_definition", message: `Type "${typeName}" field "${fieldName}": sequence generation requires integer type` } };
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
        // Reject match.where that references a computed field
        if (typeDef.fields) {
          for (const whereField of Object.keys(match.where)) {
            const fieldDef = typeDef.fields[whereField];
            if (fieldDef && fieldDef.computed) {
              return { valid: false, error: { code: "invalid_type_definition", message: `Type "${typeName}": match.where references computed field "${whereField}"` } };
            }
          }
        }
      }
      typeDef.match = match;
    }

    // Parse display_name_key
    if (data.display_name_key !== undefined) {
      typeDef.display_name_key = String(data.display_name_key);
    }

    // Warn about unknown field references in path_pattern, and reject circular deps
    if (typeDef.path_pattern && typeDef.fields) {
      const fieldNames = new Set(Object.keys(typeDef.fields));
      const re = /\{(\w+)\}/g;
      let m;
      while ((m = re.exec(typeDef.path_pattern)) !== null) {
        if (!fieldNames.has(m[1])) {
          warnings.push(`Type "${typeName}": path_pattern references unknown field "${m[1]}"`);
        } else {
          const referencedField = typeDef.fields[m[1]];
          // Reject if path_pattern references a field generated from file.* (circular)
          if (referencedField && typeof referencedField.generated === "object" && referencedField.generated !== null) {
            const genObj = referencedField.generated as Record<string, unknown>;
            if ("from" in genObj && typeof genObj.from === "string" && genObj.from.startsWith("file.")) {
              return { valid: false, error: { code: "invalid_type_definition", message: `Type "${typeName}": path_pattern references field "${m[1]}" which is generated from "${genObj.from}" (circular dependency)` } };
            }
          }
          // Reject if path_pattern references a computed field (circular)
          if (referencedField && referencedField.computed) {
            return { valid: false, error: { code: "invalid_type_definition", message: `Type "${typeName}": path_pattern references computed field "${m[1]}"` } };
          }
        }
      }
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

function findUnsupportedV03EmbeddedSchemaRef(
  value: unknown,
): { ref: string; forbidden: boolean } | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUnsupportedV03EmbeddedSchemaRef(item);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  const reference = value.$ref;
  if (typeof reference === "string" && !reference.startsWith("#")) {
    const forbidden = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference) || path.isAbsolute(reference);
    return { ref: reference, forbidden };
  }
  for (const child of Object.values(value)) {
    const found = findUnsupportedV03EmbeddedSchemaRef(child);
    if (found) return found;
  }
  return null;
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

interface SchemaRefResolveResult {
  valid: boolean;
  schema?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function resolveV03SchemaRef(
  ref: string,
  typeFilePath: string,
  collectionRoot: string,
  typeName: string,
): Promise<SchemaRefResolveResult> {
  const parsed = splitJsonRef(ref);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(parsed.pathPart)) {
    return {
      valid: false,
      error: {
        code: "schema_ref_forbidden",
        message: `Type "${typeName}" schema.ref uses unsupported non-local reference "${ref}"`,
      },
    };
  }
  if (parsed.pathPart.length === 0) {
    return {
      valid: false,
      error: {
        code: "invalid_type_definition",
        message: `Type "${typeName}" schema.ref must reference a local schema file`,
      },
    };
  }

  const root = path.resolve(collectionRoot);
  const resolvedPath = path.resolve(path.dirname(typeFilePath), parsed.pathPart);
  const allowedRoots = await getAllowedV03SchemaRefRoots(root);
  if (!isInsideAnyRoot(resolvedPath, allowedRoots)) {
    return {
      valid: false,
      error: {
        code: "schema_ref_forbidden",
        message: `Type "${typeName}" schema.ref "${ref}" escapes allowed schema roots`,
      },
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = await fs.promises.realpath(resolvedPath);
  } catch (error) {
    return {
      valid: false,
      error: {
        code: "schema_ref_unresolved",
        message: `Type "${typeName}" schema.ref "${ref}" could not be resolved: ${(error as Error).message}`,
      },
    };
  }

  const canonicalRoots = await Promise.all(allowedRoots.map(async (root) => {
    try {
      return await fs.promises.realpath(root);
    } catch {
      return path.resolve(root);
    }
  }));
  if (!isInsideAnyRoot(canonicalPath, canonicalRoots)) {
    return {
      valid: false,
      error: {
        code: "schema_ref_forbidden",
        message: `Type "${typeName}" schema.ref "${ref}" escapes allowed schema roots after symlink resolution`,
      },
    };
  }

  let schemaDocument: unknown;
  try {
    schemaDocument = JSON.parse(await fs.promises.readFile(canonicalPath, "utf-8"));
  } catch (error) {
    return {
      valid: false,
      error: {
        code: "invalid_embedded_schema",
        message: `Type "${typeName}" schema.ref "${ref}" is not valid JSON: ${(error as Error).message}`,
      },
    };
  }

  const selected = parsed.fragment ? resolveJsonPointer(schemaDocument, parsed.fragment) : schemaDocument;
  if (selected === undefined) {
    return {
      valid: false,
      error: {
        code: "schema_ref_unresolved",
        message: `Type "${typeName}" schema.ref "${ref}" points to a missing JSON Pointer target`,
      },
    };
  }
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
    return {
      valid: false,
      error: {
        code: "invalid_embedded_schema",
        message: `Type "${typeName}" schema.ref "${ref}" must resolve to a JSON Schema object`,
      },
    };
  }

  return {
    valid: true,
    schema: selected as Record<string, unknown>,
  };
}

async function getAllowedV03SchemaRefRoots(collectionRoot: string): Promise<string[]> {
  const roots = [path.resolve(collectionRoot)];
  let current = path.resolve(collectionRoot);

  while (true) {
    const schemaRoot = path.join(current, "schemas", "v0.3");
    try {
      const stat = await fs.promises.stat(schemaRoot);
      if (stat.isDirectory()) {
        roots.push(schemaRoot);
        break;
      }
    } catch {
      // Keep walking toward the filesystem root.
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

function isInsideAnyRoot(candidate: string, roots: string[]): boolean {
  const resolvedCandidate = path.resolve(candidate);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
  });
}

function splitJsonRef(ref: string): { pathPart: string; fragment?: string } {
  const hashIndex = ref.indexOf("#");
  if (hashIndex === -1) {
    return { pathPart: ref };
  }
  const pathPart = ref.slice(0, hashIndex);
  const fragment = ref.slice(hashIndex + 1);
  return { pathPart, fragment };
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  let current = document;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof current !== "object" || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      const object = current as Record<string, unknown>;
      if (!(segment in object)) return undefined;
      current = object[segment];
    }
  }
  return current;
}

function validateV03TypeFileShape(data: Record<string, unknown>, typeName: string): { code: string; message: string } | null {
  const topLevelKeys = new Set([
    "kind",
    "name",
    "version",
    "description",
    "match",
    "schema",
    "collection",
    "lifecycle",
    "runtime",
    "migrations",
    "implements",
  ]);

  for (const [key, value] of Object.entries(data)) {
    if (topLevelKeys.has(key)) continue;
    if (isV03ExtensionKey(key)) {
      if (!isPlainObject(value)) return invalidV03TypeShape(typeName, `extension section "${key}" must be a mapping`);
      continue;
    }
    return invalidV03TypeShape(typeName, `unknown top-level key "${key}"`);
  }

  if (data.match !== undefined) {
    const error = validateV03MatchShape(data.match, typeName);
    if (error) return error;
  }
  if (data.collection !== undefined) {
    const error = validateV03CollectionShape(data.collection, typeName);
    if (error) return error;
  }
  if (data.lifecycle !== undefined) {
    const error = validateV03LifecycleShape(data.lifecycle, typeName);
    if (error) return error;
  }
  if (data.runtime !== undefined && !isPlainObject(data.runtime)) {
    return invalidV03TypeShape(typeName, "runtime section must be a mapping");
  }
  if (data.implements !== undefined) {
    const error = validateV03ImplementationsShape(data.implements, typeName);
    if (error) return error;
  }
  return null;
}

function validateV03ImplementationsShape(
  value: unknown,
  typeName: string,
): { code: string; message: string } | null {
  if (!Array.isArray(value) || value.length === 0) {
    return invalidV03TypeShape(typeName, "implements must be a non-empty list");
  }
  const identities = new Set<string>();
  const contractPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
  const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const fieldPathPattern = /^[A-Za-z_][A-Za-z0-9_-]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_-]*(?:\[\])?)*$/;
  for (const [index, candidate] of value.entries()) {
    if (!isPlainObject(candidate)) {
      return invalidV03TypeShape(typeName, `implements[${index}] must be a mapping`);
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (["contract", "version", "fields", "binding"].includes(key)) continue;
      if (isV03ExtensionKey(key) && isPlainObject(child)) continue;
      return invalidV03TypeShape(typeName, `implements[${index}] has invalid key "${key}"`);
    }
    if (typeof candidate.contract !== "string" || !contractPattern.test(candidate.contract)) {
      return invalidV03TypeShape(typeName, `implements[${index}].contract is not a valid contract ID`);
    }
    if (typeof candidate.version !== "string" || !semverPattern.test(candidate.version)) {
      return invalidV03TypeShape(typeName, `implements[${index}].version must be an exact semantic version`);
    }
    if (!isPlainObject(candidate.fields)) {
      return invalidV03TypeShape(typeName, `implements[${index}].fields must be a mapping`);
    }
    for (const [contractField, recordField] of Object.entries(candidate.fields)) {
      if (!fieldPathPattern.test(contractField) || typeof recordField !== "string" || !fieldPathPattern.test(recordField)) {
        return invalidV03TypeShape(typeName, `implements[${index}].fields contains an invalid field path`);
      }
    }
    if (candidate.binding !== undefined && !isPlainObject(candidate.binding)) {
      return invalidV03TypeShape(typeName, `implements[${index}].binding must be a mapping`);
    }
    const identity = `${candidate.contract}\0${candidate.version}`;
    if (identities.has(identity)) {
      return invalidV03TypeShape(
        typeName,
        `implements contains duplicate contract identity "${candidate.contract}" ${candidate.version}`,
      );
    }
    identities.add(identity);
  }
  return null;
}

function validateV03MatchShape(value: unknown, typeName: string): { code: string; message: string } | null {
  if (!isPlainObject(value)) return invalidV03TypeShape(typeName, "match section must be a mapping");
  const allowed = new Set(["path_glob", "fields_present", "where", "expr"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return invalidV03TypeShape(typeName, `match has unknown key "${key}"`);
  }
  if (value.path_glob !== undefined) {
    const validPathGlob = typeof value.path_glob === "string" ||
      (Array.isArray(value.path_glob) && value.path_glob.every((entry) => typeof entry === "string" && entry.length > 0));
    if (!validPathGlob) return invalidV03TypeShape(typeName, "match.path_glob must be a string or non-empty string list");
  }
  if (value.fields_present !== undefined) {
    if (!Array.isArray(value.fields_present) || !value.fields_present.every((entry) => typeof entry === "string" && entry.length > 0)) {
      return invalidV03TypeShape(typeName, "match.fields_present must be a non-empty string list");
    }
  }
  if (value.where !== undefined && !isPlainObject(value.where)) {
    return invalidV03TypeShape(typeName, "match.where must be a mapping");
  }
  if (value.expr !== undefined) {
    if (!isPlainObject(value.expr) || typeof value.expr.$expr !== "string" || value.expr.$expr.length === 0) {
      return invalidV03TypeShape(typeName, "match.expr must be an expression object with a non-empty $expr");
    }
    for (const key of Object.keys(value.expr)) {
      if (key !== "$expr") return invalidV03TypeShape(typeName, `match.expr has unknown key "${key}"`);
    }
  }
  return null;
}

function validateV03CollectionShape(value: unknown, typeName: string): { code: string; message: string } | null {
  if (!isPlainObject(value)) return invalidV03TypeShape(typeName, "collection section must be a mapping");
  const allowed = new Set(["display", "read_defaults", "links", "unique", "path", "projections"]);
  for (const [key, child] of Object.entries(value)) {
    if (allowed.has(key)) continue;
    if (isV03ExtensionKey(key)) {
      if (!isPlainObject(child)) return invalidV03TypeShape(typeName, `collection extension "${key}" must be a mapping`);
      continue;
    }
    return invalidV03TypeShape(typeName, `collection has unknown key "${key}"`);
  }

  if (value.display !== undefined) {
    const error = validateV03ObjectKeys(typeName, "collection.display", value.display, ["name_field", "description_field", "icon", "color_field"]);
    if (error) return error;
  }
  if (value.read_defaults !== undefined && !isPlainObject(value.read_defaults)) {
    return invalidV03TypeShape(typeName, "collection.read_defaults must be a mapping");
  }
  if (value.path !== undefined) {
    const error = validateV03ObjectKeys(typeName, "collection.path", value.path, ["pattern", "runtime", "template", "folder", "generated_by"]);
    if (error) return error;
  }
  if (value.projections !== undefined) {
    if (!isPlainObject(value.projections)) return invalidV03TypeShape(typeName, "collection.projections must be a mapping");
    for (const [projectionName, projection] of Object.entries(value.projections)) {
      if (!isPlainObject(projection) || typeof projection.expr !== "string" || projection.expr.length === 0) {
        return invalidV03TypeShape(typeName, `collection.projections.${projectionName} must define a non-empty expr`);
      }
      const error = validateV03ObjectKeys(typeName, `collection.projections.${projectionName}`, projection, ["expr", "description"]);
      if (error) return error;
    }
  }
  if (value.links !== undefined) {
    const error = validateV03LinksShape(value.links, typeName);
    if (error) return error;
  }
  if (value.unique !== undefined) {
    const error = validateV03UniqueShape(value.unique, typeName);
    if (error) return error;
  }
  return null;
}

function validateV03LinksShape(value: unknown, typeName: string): { code: string; message: string } | null {
  if (!isPlainObject(value)) return invalidV03TypeShape(typeName, "collection.links must be a mapping");
  for (const [fieldPath, rule] of Object.entries(value)) {
    if (typeof fieldPath !== "string" || fieldPath.length === 0) {
      return invalidV03TypeShape(typeName, "collection.links field paths must be non-empty strings");
    }
    if (!isPlainObject(rule)) return invalidV03TypeShape(typeName, `collection.links.${fieldPath} must be a mapping`);
    const error = validateV03ObjectKeys(typeName, `collection.links.${fieldPath}`, rule, ["target_type", "validate_exists", "format"]);
    if (error) return error;
    if (rule.target_type !== undefined) {
      const validTarget = typeof rule.target_type === "string" ||
        (Array.isArray(rule.target_type) && rule.target_type.every((entry) => typeof entry === "string" && entry.length > 0));
      if (!validTarget) return invalidV03TypeShape(typeName, `collection.links.${fieldPath}.target_type must be a string or string list`);
    }
    if (rule.validate_exists !== undefined && typeof rule.validate_exists !== "boolean") {
      return invalidV03TypeShape(typeName, `collection.links.${fieldPath}.validate_exists must be a boolean`);
    }
    if (rule.format !== undefined && !["wikilink", "markdown", "path", "any"].includes(String(rule.format))) {
      return invalidV03TypeShape(typeName, `collection.links.${fieldPath}.format has invalid value "${rule.format}"`);
    }
  }
  return null;
}

function validateV03UniqueShape(value: unknown, typeName: string): { code: string; message: string } | null {
  if (!Array.isArray(value)) return invalidV03TypeShape(typeName, "collection.unique must be a list");
  for (const [index, rule] of value.entries()) {
    if (!isPlainObject(rule)) return invalidV03TypeShape(typeName, `collection.unique[${index}] must be a mapping`);
    const error = validateV03ObjectKeys(typeName, `collection.unique[${index}]`, rule, ["field", "scope", "path_glob"]);
    if (error) return error;
    if (typeof rule.field !== "string" || rule.field.length === 0) {
      return invalidV03TypeShape(typeName, `collection.unique[${index}].field must be a non-empty string`);
    }
    if (rule.scope !== undefined && !["collection", "type", "path_glob"].includes(String(rule.scope))) {
      return invalidV03TypeShape(typeName, `collection.unique[${index}].scope has invalid value "${rule.scope}"`);
    }
    if (rule.scope === "path_glob" && (typeof rule.path_glob !== "string" || rule.path_glob.length === 0)) {
      return invalidV03TypeShape(typeName, `collection.unique[${index}].path_glob is required for path_glob scope`);
    }
  }
  return null;
}

function validateV03LifecycleShape(value: unknown, typeName: string): { code: string; message: string } | null {
  if (!isPlainObject(value)) return invalidV03TypeShape(typeName, "lifecycle section must be a mapping");
  const allowed = new Set(["on_create", "on_update", "on_delete", "on_rename"]);
  for (const [key, eventValue] of Object.entries(value)) {
    if (!allowed.has(key)) return invalidV03TypeShape(typeName, `lifecycle has unknown key "${key}"`);
    const actions = Array.isArray(eventValue) ? eventValue : [eventValue];
    for (const [index, action] of actions.entries()) {
      if (!isPlainObject(action)) return invalidV03TypeShape(typeName, `lifecycle.${key}[${index}] must be a mapping`);
      const error = validateV03ObjectKeys(typeName, `lifecycle.${key}[${index}]`, action, ["if", "set"]);
      if (error) return error;
      if (action.if !== undefined && typeof action.if !== "string") {
        return invalidV03TypeShape(typeName, `lifecycle.${key}[${index}].if must be a string`);
      }
      if (!isPlainObject(action.set) || Object.keys(action.set).length === 0) {
        return invalidV03TypeShape(typeName, `lifecycle.${key}[${index}].set must be a non-empty mapping`);
      }
      for (const [fieldPath, lifecycleValue] of Object.entries(action.set)) {
        if (fieldPath.length === 0) return invalidV03TypeShape(typeName, `lifecycle.${key}[${index}].set contains an empty field path`);
        if (!isValidV03LifecycleValue(lifecycleValue)) {
          return invalidV03TypeShape(typeName, `lifecycle.${key}[${index}].set.${fieldPath} has invalid lifecycle value`);
        }
      }
    }
  }
  return null;
}

function validateV03ObjectKeys(
  typeName: string,
  pathName: string,
  value: unknown,
  allowedKeys: string[],
): { code: string; message: string } | null {
  if (!isPlainObject(value)) return invalidV03TypeShape(typeName, `${pathName} must be a mapping`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return invalidV03TypeShape(typeName, `${pathName} has unknown key "${key}"`);
  }
  return null;
}

function isValidV03LifecycleValue(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0];
  if (key === "now" || key === "today" || key === "uuid" || key === "ulid") return value[key] === true;
  if (key === "slugify" || key === "copy") return typeof value[key] === "string" && value[key].length > 0;
  if (key === "literal") return true;
  return false;
}

function isV03ExtensionKey(key: string): boolean {
  return /^x-[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidV03TypeShape(typeName: string, message: string): { code: string; message: string } {
  return {
    code: "invalid_type_definition",
    message: `Type "${typeName}" ${message}`,
  };
}

function parseV03Migrations(
  value: unknown,
  typeName: string,
): { valid: boolean; migrations?: V03Migration[]; error?: { code: string; message: string } } {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      error: {
        code: "invalid_type_definition",
        message: `Type "${typeName}" migrations must be a list`,
      },
    };
  }

  const migrations: V03Migration[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return invalidV03Migration(typeName, index, "must be a mapping");
    }
    const migration = entry as Record<string, unknown>;
    const allowedKeys = new Set(["from", "to", "steps", "action", "description"]);
    for (const key of Object.keys(migration)) {
      if (!allowedKeys.has(key)) {
        return invalidV03Migration(typeName, index, `has unknown key "${key}"`);
      }
    }

    const from = migration.from;
    const to = migration.to;
    if (!Number.isInteger(from) || (from as number) < 0) {
      return invalidV03Migration(typeName, index, "from must be an integer >= 0");
    }
    if (!Number.isInteger(to) || (to as number) < 1) {
      return invalidV03Migration(typeName, index, "to must be an integer >= 1");
    }
    const hasSteps = migration.steps !== undefined;
    const hasAction = migration.action !== undefined;
    if (hasSteps === hasAction) {
      return invalidV03Migration(typeName, index, "must define exactly one of steps or action");
    }

    const parsed: V03Migration = {
      from: from as number,
      to: to as number,
    };
    if (migration.description !== undefined) {
      if (typeof migration.description !== "string") {
        return invalidV03Migration(typeName, index, "description must be a string");
      }
      parsed.description = migration.description;
    }
    if (hasAction) {
      if (typeof migration.action !== "string" || migration.action.length === 0) {
        return invalidV03Migration(typeName, index, "action must be a non-empty string");
      }
      parsed.action = migration.action;
    }
    if (hasSteps) {
      if (!Array.isArray(migration.steps)) {
        return invalidV03Migration(typeName, index, "steps must be a list");
      }
      parsed.steps = [];
      for (const [stepIndex, step] of migration.steps.entries()) {
        if (typeof step !== "object" || step === null || Array.isArray(step) || Object.keys(step).length === 0) {
          return invalidV03Migration(typeName, index, `steps[${stepIndex}] must be a non-empty mapping`);
        }
        parsed.steps.push(step as Record<string, unknown>);
      }
    }
    migrations.push(parsed);
  }

  return { valid: true, migrations };
}

function invalidV03Migration(
  typeName: string,
  index: number,
  message: string,
): { valid: false; error: { code: string; message: string } } {
  return {
    valid: false,
    error: {
      code: "invalid_type_definition",
      message: `Type "${typeName}" migrations[${index}] ${message}`,
    },
  };
}

function validateTypeName(name: string, specMajor: 0 | 1 = 0): { code: string; message: string } | null {
  const maxLength = specMajor === 1 ? 128 : MAX_TYPE_NAME_LENGTH;
  if (name.length > maxLength) {
    return {
      code: "invalid_type_definition",
      message: `Type name "${name}" exceeds maximum length of ${maxLength}`,
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
  entries.sort((a, b) => a.name.localeCompare(b.name));
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
    // Inherit display_name_key from parent if not set
    if (resolvedType.display_name_key === undefined && parent.display_name_key !== undefined) {
      resolvedType.display_name_key = parent.display_name_key;
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
