import * as fs from "node:fs/promises";
import matter from "gray-matter";
import { dump } from "js-yaml";

export interface TypeMigrationMapping {
  from: string;
  to: string | string[];
}

export interface TypeMigrationWarning {
  code: string;
  message: string;
}

export interface TypeMigrationReport {
  source?: string;
  target?: string;
  source_version: string;
  target_version: string;
  detected_generator?: string;
  summary: {
    fields_converted: number;
    required_fields: string[];
    defaults_moved_to_read_defaults: string[];
    generated_fields_moved_to_lifecycle: string[];
    link_fields_moved_to_collection_links: string[];
    tasknotes_annotations_moved?: boolean;
    unsupported_features?: string[];
  };
  mappings: TypeMigrationMapping[];
  warnings: TypeMigrationWarning[];
  unsupported: string[];
}

export interface TypeMigrationResult {
  valid: boolean;
  typeFile?: Record<string, unknown>;
  renderedTypeFile?: string;
  report?: TypeMigrationReport;
  error?: { code: string; message: string };
}

export interface TypeMigrationOptions {
  sourcePath?: string;
  targetPath?: string;
  sourceVersion?: string;
  targetVersion?: string;
  generator?: string;
}

type Dict = Record<string, unknown>;

const TASKNOTES_ADDITIONAL_FIELDS: Record<string, Dict> = {
  occurrenceMaterialization: {
    enum: ["manual", "on_completion", "rolling"],
    default: "manual",
    role: "occurrenceMaterialization",
    read_default: true,
  },
  occurrenceNextTrigger: {
    enum: ["completion", "completion_or_skip"],
    default: "completion",
    role: "occurrenceNextTrigger",
    read_default: true,
  },
  occurrenceTemplate: {
    type: "string",
    role: "occurrenceTemplate",
    link: { target_type: "any", validate_exists: false },
  },
  occurrencePastHorizon: {
    type: "string",
    role: "occurrencePastHorizon",
  },
  occurrenceFutureHorizon: {
    type: "string",
    role: "occurrenceFutureHorizon",
  },
  reminders: {
    schema: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            required: ["id", "type", "absoluteTime"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              type: { const: "absolute" },
              description: { type: "string" },
              absoluteTime: { type: "string", format: "date-time" },
            },
          },
          {
            type: "object",
            required: ["id", "type", "relatedTo", "offset"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              type: { const: "relative" },
              description: { type: "string" },
              relatedTo: { enum: ["due", "scheduled"] },
              offset: { type: "string" },
            },
          },
        ],
      },
    },
    role: "reminders",
  },
};

export async function migrateV02TypeFileToV03(
  filePath: string,
  options: TypeMigrationOptions = {},
): Promise<TypeMigrationResult> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = matter(content);
    const result = migrateV02TypeToV03(parsed.data as Dict, options);
    if (result.valid && result.typeFile) {
      result.renderedTypeFile = renderV03TypeFile(result.typeFile, parsed.content);
    }
    return result;
  } catch (error) {
    return {
      valid: false,
      error: {
        code: "invalid_type_migration",
        message: error instanceof Error ? error.message : "Failed to read source type file.",
      },
    };
  }
}

export function migrateV02TypeToV03(
  oldType: Dict,
  options: TypeMigrationOptions = {},
): TypeMigrationResult {
  if (oldType.kind === "mdbase.type" || oldType.schema !== undefined) {
    return {
      valid: false,
      error: {
        code: "invalid_type_migration",
        message: "Source already looks like a v0.3 type file.",
      },
    };
  }
  if (typeof oldType.name !== "string" || !isPlainObject(oldType.fields)) {
    return {
      valid: false,
      error: {
        code: "invalid_type_migration",
        message: "Source must be a v0.2 type file with name and fields.",
      },
    };
  }

  const detectedGenerator = options.generator ?? detectGenerator(oldType);
  const isTaskNotes = detectedGenerator === "tasknotes";
  const migrated = buildV03Type(oldType, { isTaskNotes });
  const report = buildMigrationReport(oldType, migrated, {
    sourcePath: options.sourcePath,
    targetPath: options.targetPath,
    sourceVersion: options.sourceVersion ?? "0.2.1",
    targetVersion: options.targetVersion ?? "0.3.0",
    detectedGenerator,
    isTaskNotes,
  });

  return {
    valid: true,
    typeFile: migrated,
    renderedTypeFile: renderV03TypeFile(migrated),
    report,
  };
}

export function renderV03TypeFile(typeFile: Dict, body = "# Type\n\nGenerated v0.3 mdbase type.\n"): string {
  return `---\n${dump(typeFile, {
    sortKeys: false,
    noRefs: true,
    lineWidth: 100,
  }).trimEnd()}\n---\n\n${body}`;
}

function buildV03Type(oldType: Dict, options: { isTaskNotes: boolean }): Dict {
  const fields = oldType.fields as Record<string, Dict>;
  const typeName = String(oldType.name).toLowerCase();
  const properties: Dict = { type: { const: typeName } };
  const required: string[] = [];
  const readDefaults: Dict = {};
  const lifecycle: Dict = {};
  const links: Dict = {};
  const unique: unknown[] = [];
  const fieldRoles: Record<string, string> = {};
  const statusMetadata: Dict = {};
  const priorityMetadata: Dict = {};

  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    const converted = convertField(fieldName, fieldDef, { isTaskNotes: options.isTaskNotes });
    properties[fieldName] = converted.schema;
    Object.assign(links, converted.links);

    if (fieldDef.unique === true) {
      unique.push({ field: fieldName, scope: "collection" });
    }

    if (fieldDef.required === true) {
      required.push(fieldName);
    }
    if (Object.prototype.hasOwnProperty.call(fieldDef, "default")) {
      (properties[fieldName] as Dict).default = cloneJsonLike(fieldDef.default);
      readDefaults[fieldName] = cloneJsonLike(fieldDef.default);
    }
    if (typeof fieldDef.tn_role === "string") {
      fieldRoles[fieldDef.tn_role] = fieldName;
    }
    if (Array.isArray(fieldDef.tn_completed_values)) {
      statusMetadata.completed_values = cloneJsonLike(fieldDef.tn_completed_values);
    }
    if (fieldDef.generated !== undefined) {
      addGeneratedLifecycle(lifecycle, fieldName, fieldDef.generated);
    }
  }

  if (options.isTaskNotes) {
    for (const [fieldName, info] of Object.entries(TASKNOTES_ADDITIONAL_FIELDS)) {
      if (isPlainObject(info.schema)) {
        properties[fieldName] = cloneJsonLike(info.schema);
      } else if (Array.isArray(info.enum)) {
        properties[fieldName] = { enum: cloneJsonLike(info.enum) };
      } else if (typeof info.type === "string") {
        properties[fieldName] = { type: info.type };
      }
      if (Object.prototype.hasOwnProperty.call(info, "default")) {
        (properties[fieldName] as Dict).default = cloneJsonLike(info.default);
        if (info.read_default === true) {
          readDefaults[fieldName] = cloneJsonLike(info.default);
        }
      }
      if (typeof info.role === "string") {
        fieldRoles[info.role] = fieldName;
      }
      if (isPlainObject(info.link)) {
        links[fieldName] = cloneJsonLike(info.link);
      }
    }
  }

  if (readDefaults.status !== undefined) {
    statusMetadata.default = cloneJsonLike(readDefaults.status);
  }
  if (readDefaults.priority !== undefined) {
    priorityMetadata.default = cloneJsonLike(readDefaults.priority);
  }

  const schema: Dict = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: oldType.strict !== true,
    properties,
  };
  if (required.length > 0) {
    schema.required = dedupe(required);
  }

  const requestedDisplayField = typeof oldType.display_name_key === "string" ? oldType.display_name_key : "title";
  const displayField = Object.prototype.hasOwnProperty.call(fields, requestedDisplayField)
    ? requestedDisplayField
    : undefined;
  const collection: Dict = {
    ...(displayField ? { display: { name_field: displayField } } : {}),
    read_defaults: readDefaults,
    links,
    unique,
  };

  if (typeof oldType.path_pattern === "string") {
    collection.path = options.isTaskNotes
      ? migrateTaskNotesPathPolicy(oldType.path_pattern)
      : { pattern: oldType.path_pattern };
  }

  const migrated: Dict = {
    kind: "mdbase.type",
    name: typeName,
    version: 1,
    description: typeof oldType.description === "string" ? oldType.description : undefined,
    match: isPlainObject(oldType.match) ? oldType.match : undefined,
    schema: {
      dialect: "json-schema-2020-12",
      value: schema,
    },
    collection,
    lifecycle,
  };

  if (options.isTaskNotes) {
    migrated.implements = [{
      contract: "tasknotes.task",
      version: "0.2.0",
      fields: fieldRoles,
      binding: {
        status: statusMetadata,
        priority: priorityMetadata,
        archive: { archived_tag: "archived" },
      },
    }];
  }

  const legacy = collectLegacyMetadata(oldType, { isTaskNotes: options.isTaskNotes });
  if (Object.keys(legacy).length > 0) {
    migrated["x-legacy-v0.2"] = legacy;
  }

  return pruneEmpty(migrated) as Dict;
}

function convertField(
  selector: string,
  fieldDef: Dict,
  options: { isTaskNotes: boolean },
): { schema: Dict; links: Dict } {
  const links: Dict = {};
  let schema: Dict;
  const fieldType = fieldDef.type;

  switch (fieldType) {
    case "any":
      schema = {};
      break;
    case "string":
      schema = { type: "string" };
      break;
    case "integer":
      schema = { type: "integer" };
      break;
    case "number":
      schema = { type: "number" };
      break;
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "date":
      schema = { type: "string", format: "date" };
      break;
    case "datetime":
      schema = { type: "string", format: "date-time" };
      break;
    case "time":
      schema = { type: "string", format: "time" };
      break;
    case "enum":
      schema = { enum: Array.isArray(fieldDef.values) ? cloneJsonLike(fieldDef.values) : [] };
      break;
    case "link":
      schema = { type: "string" };
      links[selector] = {
        target_type: typeof fieldDef.target === "string"
          ? fieldDef.target
          : selector.endsWith("Parent") || selector.endsWith("uid") ? "task" : "any",
        validate_exists: fieldDef.validate_exists === true,
      };
      break;
    case "list": {
      const itemDef = isPlainObject(fieldDef.items) ? fieldDef.items : {};
      const converted = convertField(`${selector}[]`, itemDef, options);
      schema = { type: "array", items: converted.schema };
      Object.assign(links, converted.links);
      break;
    }
    case "object": {
      const properties: Dict = {};
      const required: string[] = [];
      for (const [childName, childDef] of Object.entries(isPlainObject(fieldDef.fields) ? fieldDef.fields : {})) {
        const converted = convertField(`${selector}.${childName}`, childDef as Dict, options);
        properties[childName] = converted.schema;
        Object.assign(links, converted.links);
        if ((childDef as Dict).required === true) {
          required.push(childName);
        }
      }
      if (options.isTaskNotes && selector === "blockedBy[]") {
        required.push("uid");
      }
      schema = {
        type: "object",
        additionalProperties: Object.keys(properties).length === 0,
        properties,
        ...(required.length > 0 ? { required: dedupe(required) } : {}),
      };
      break;
    }
    default:
      schema = {};
      break;
  }

  if (selector === "title" && options.isTaskNotes) {
    schema.minLength = 1;
    schema.description = "Short summary of the task.";
  }
  if (typeof fieldDef.description === "string") {
    schema.description = fieldDef.description;
  }
  if (typeof fieldDef.min === "number") {
    if (fieldType === "string") schema.minLength = fieldDef.min;
    else if (fieldType === "list") schema.minItems = fieldDef.min;
    else schema.minimum = fieldDef.min;
  }
  if (typeof fieldDef.max === "number") {
    if (fieldType === "string") schema.maxLength = fieldDef.max;
    else if (fieldType === "list") schema.maxItems = fieldDef.max;
    else schema.maximum = fieldDef.max;
  }
  if (typeof fieldDef.pattern === "string") schema.pattern = fieldDef.pattern;
  if (fieldDef.deprecated === true) schema.deprecated = true;

  return { schema, links };
}

function addGeneratedLifecycle(lifecycle: Dict, fieldName: string, strategy: unknown): void {
  if (strategy === "now") {
    lifecycleSet(lifecycle, "on_create", fieldName, { now: true });
    return;
  }
  if (strategy === "now_on_write") {
    lifecycleSet(lifecycle, "on_update", fieldName, { now: true });
    return;
  }
  if (strategy === "uuid") {
    lifecycleSet(lifecycle, "on_create", fieldName, { uuid: true });
    return;
  }
  if (strategy === "ulid") {
    lifecycleSet(lifecycle, "on_create", fieldName, { ulid: true });
    return;
  }
  if (isPlainObject(strategy) && strategy.transform === "slugify" && typeof strategy.from === "string") {
    lifecycleSet(lifecycle, "on_create", fieldName, { slugify: strategy.from });
  }
}

function lifecycleSet(lifecycle: Dict, event: string, fieldName: string, value: Dict): void {
  const action = isPlainObject(lifecycle[event]) ? lifecycle[event] : {};
  const set = isPlainObject(action.set) ? action.set : {};
  set[fieldName] = value;
  action.set = set;
  lifecycle[event] = action;
}

function migrateTaskNotesPathPolicy(pathPattern: string): Dict {
  const match = pathPattern.match(/^(.*\/)?\{title\}\.md$/);
  if (match) {
    return {
      runtime: "tasknotes",
      template: "{{title}}",
      folder: (match[1] ?? "").replace(/\/$/, ""),
      generated_by: "tasknotes.filename.create",
    };
  }
  return {
    runtime: "tasknotes",
    template: pathPattern,
    generated_by: "tasknotes.filename.create",
  };
}

function buildMigrationReport(
  oldType: Dict,
  migrated: Dict,
  options: {
    sourcePath?: string;
    targetPath?: string;
    sourceVersion: string;
    targetVersion: string;
    detectedGenerator?: string;
    isTaskNotes: boolean;
  },
): TypeMigrationReport {
  const fields = oldType.fields as Record<string, Dict>;
  const schema = ((migrated.schema as Dict).value as Dict);
  const readDefaults = ((migrated.collection as Dict)?.read_defaults ?? {}) as Dict;
  const lifecycle = (migrated.lifecycle ?? {}) as Dict;
  const links = ((migrated.collection as Dict)?.links ?? {}) as Dict;
  const generatedFields: string[] = [];
  for (const event of ["on_create", "on_update"]) {
    const set = ((lifecycle[event] as Dict | undefined)?.set ?? {}) as Dict;
    for (const fieldName of Object.keys(set)) {
      if (!generatedFields.includes(fieldName)) generatedFields.push(fieldName);
    }
  }

  return {
    source: options.sourcePath,
    target: options.targetPath,
    source_version: options.sourceVersion,
    target_version: options.targetVersion,
    detected_generator: options.detectedGenerator,
    summary: {
      fields_converted: Object.keys(fields).length,
      required_fields: Array.isArray(schema.required) ? schema.required.map(String).filter((field) => field !== "type") : [],
      defaults_moved_to_read_defaults: Object.keys(readDefaults),
      generated_fields_moved_to_lifecycle: generatedFields,
      link_fields_moved_to_collection_links: Object.keys(links),
      ...(options.isTaskNotes ? { tasknotes_annotations_moved: true } : {}),
    },
    mappings: buildMappings(options.isTaskNotes, isPlainObject((migrated.collection as Dict)?.display)),
    warnings: buildWarnings(options.isTaskNotes, schema, oldType),
    unsupported: collectUnsupportedFeatures(oldType),
  };
}

function buildMappings(isTaskNotes: boolean, displayMigrated: boolean): TypeMigrationMapping[] {
  const mappings: TypeMigrationMapping[] = [
    { from: "fields", to: "schema.value.properties" },
    ...(displayMigrated
      ? [{ from: "display_name_key", to: "collection.display.name_field" } satisfies TypeMigrationMapping]
      : []),
    { from: "path_pattern", to: "collection.path" },
  ];
  if (!isTaskNotes) return mappings;
  return [
    { from: "fields.title", to: ["schema.value.properties.title", "implements.0.fields.title"] },
    { from: "fields.status.values", to: "schema.value.properties.status.enum" },
    {
      from: "fields.status.default",
      to: ["schema.value.properties.status.default", "collection.read_defaults.status", "implements.0.binding.status.default"],
    },
    { from: "fields.status.tn_completed_values", to: "implements.0.binding.status.completed_values" },
    { from: "fields.dateCreated.generated", to: "lifecycle.on_create.set.dateCreated" },
    { from: "fields.dateModified.generated", to: "lifecycle.on_update.set.dateModified" },
    { from: "fields.projects.items.type", to: ["schema.value.properties.projects.items.type", "collection.links.projects[]"] },
    {
      from: "fields.blockedBy.items.fields.uid.type",
      to: ["schema.value.properties.blockedBy.items.properties.uid.type", "collection.links.blockedBy[].uid"],
    },
    ...(displayMigrated
      ? [{ from: "display_name_key", to: "collection.display.name_field" } satisfies TypeMigrationMapping]
      : []),
    { from: "path_pattern", to: "collection.path" },
  ];
}

function buildWarnings(isTaskNotes: boolean, schema: Dict, oldType: Dict): TypeMigrationWarning[] {
  const warnings: TypeMigrationWarning[] = [];
  if (isTaskNotes) {
    warnings.push({
      code: "path_policy_runtime_owned",
      message: "TaskNotes filename templates may use runtime values that are not schema fields, so the v0.3 target records the path policy as TaskNotes runtime metadata rather than only collection.path.pattern.",
    });
  }
  if (schema.additionalProperties === true) {
    warnings.push({
      code: "additional_properties_true",
      message: isTaskNotes
        ? "The migrated schema allows additional properties because TaskNotes supports user-defined fields."
        : "The migrated schema allows additional properties because the source type was not strict.",
    });
  }
  if (
    typeof oldType.display_name_key === "string"
    && !Object.prototype.hasOwnProperty.call(oldType.fields as Dict, oldType.display_name_key)
  ) {
    warnings.push({
      code: "display_field_missing",
      message: `The source display_name_key '${oldType.display_name_key}' is not a declared field, so collection.display was omitted.`,
    });
  }
  if (isTaskNotes) {
    warnings.push({
      code: "reminders_added_as_v03_shape_example",
      message: "The v0.3 target includes reminder discriminated unions to show the intended post-v0.3 shape even though the representative v0.2 source did not model reminders accurately.",
    });
  }
  return warnings;
}

function detectGenerator(oldType: Dict): string | undefined {
  const fields = isPlainObject(oldType.fields) ? oldType.fields : {};
  for (const fieldDef of Object.values(fields)) {
    if (
      isPlainObject(fieldDef)
      && (typeof fieldDef.tn_role === "string" || Array.isArray(fieldDef.tn_completed_values))
    ) {
      return "tasknotes";
    }
  }
  return undefined;
}

const KNOWN_TYPE_KEYS = new Set([
  "name",
  "description",
  "display_name_key",
  "strict",
  "path_pattern",
  "match",
  "fields",
  "extends",
]);

const KNOWN_FIELD_KEYS = new Set([
  "type",
  "required",
  "default",
  "description",
  "values",
  "items",
  "fields",
  "min",
  "max",
  "pattern",
  "unique",
  "deprecated",
  "generated",
  "computed",
  "target",
  "validate_exists",
  "tn_role",
  "tn_completed_values",
]);

function collectLegacyMetadata(oldType: Dict, options: { isTaskNotes: boolean }): Dict {
  const legacy: Dict = {};
  for (const [key, value] of Object.entries(oldType)) {
    if (!KNOWN_TYPE_KEYS.has(key)) {
      legacy[key] = cloneJsonLike(value);
    }
  }

  const fieldMetadata: Dict = {};
  const fields = isPlainObject(oldType.fields) ? oldType.fields : {};
  for (const [fieldName, rawField] of Object.entries(fields)) {
    collectLegacyFieldMetadata(rawField, `fields.${fieldName}`, fieldMetadata, options);
  }
  if (Object.keys(fieldMetadata).length > 0) {
    legacy.fields = fieldMetadata;
  }
  return legacy;
}

function collectLegacyFieldMetadata(
  rawField: unknown,
  path: string,
  target: Dict,
  options: { isTaskNotes: boolean },
): void {
  if (!isPlainObject(rawField)) return;
  for (const [key, value] of Object.entries(rawField)) {
    const handledTaskNotesKey = options.isTaskNotes && (key === "tn_role" || key === "tn_completed_values");
    if (!KNOWN_FIELD_KEYS.has(key) || ((key === "tn_role" || key === "tn_completed_values") && !handledTaskNotesKey)) {
      target[`${path}.${key}`] = cloneJsonLike(value);
    }
  }
  if (isPlainObject(rawField.items)) {
    collectLegacyFieldMetadata(rawField.items, `${path}.items`, target, options);
  }
  if (isPlainObject(rawField.fields)) {
    for (const [childName, child] of Object.entries(rawField.fields)) {
      collectLegacyFieldMetadata(child, `${path}.fields.${childName}`, target, options);
    }
  }
}

function collectUnsupportedFeatures(oldType: Dict): string[] {
  const unsupported = new Set<string>();
  if (oldType.extends !== undefined) unsupported.add("extends");

  const walkField = (rawField: unknown, fieldPath: string): void => {
    if (!isPlainObject(rawField)) return;
    const supportedTypes = new Set(["any", "string", "integer", "number", "boolean", "date", "datetime", "time", "enum", "link", "list", "object"]);
    if (typeof rawField.type !== "string" || !supportedTypes.has(rawField.type)) {
      unsupported.add(`${fieldPath}.type`);
    }
    if (rawField.computed !== undefined) unsupported.add(`${fieldPath}.computed`);
    if (isPlainObject(rawField.items)) walkField(rawField.items, `${fieldPath}.items`);
    if (isPlainObject(rawField.fields)) {
      for (const [childName, child] of Object.entries(rawField.fields)) {
        walkField(child, `${fieldPath}.fields.${childName}`);
      }
    }
  };
  const fields = isPlainObject(oldType.fields) ? oldType.fields : {};
  for (const [fieldName, field] of Object.entries(fields)) {
    walkField(field, `fields.${fieldName}`);
  }
  return [...unsupported].sort();
}

function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneEmpty);
  }
  if (isPlainObject(value)) {
    const result: Dict = {};
    for (const [key, item] of Object.entries(value)) {
      const pruned = pruneEmpty(item);
      if (pruned === undefined || pruned === null) continue;
      if (isPlainObject(pruned) && Object.keys(pruned).length === 0) continue;
      if (Array.isArray(pruned) && pruned.length === 0) continue;
      result[key] = pruned;
    }
    return result;
  }
  return value;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function cloneJsonLike<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
