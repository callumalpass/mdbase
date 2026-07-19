import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { MdbaseError } from "../errors.js";
import type { TypeDefinition } from "../types/loader.js";

let ajv: Ajv2020 | null = null;

export function validateJsonSchemaFrontmatter(
  frontmatter: Record<string, unknown>,
  typeDef: TypeDefinition,
): MdbaseError[] {
  if (!typeDef.schema) return [];

  if (typeDef.schema.ref && !typeDef.schema.value) {
    return [{
      code: "unsupported_schema_ref",
      message: `Type "${typeDef.name}" uses external schema ref "${typeDef.schema.ref}", which this validator does not resolve yet`,
      severity: "warning",
    }];
  }

  if (!typeDef.schema.value) return [];

  try {
    const validate = getAjv().compile(typeDef.schema.value);
    if (validate(frontmatter)) return [];

    return (validate.errors ?? []).map((error) => ajvErrorToIssue(error, typeDef.name));
  } catch (error) {
    return [{
      code: "invalid_type_definition",
      message: `Type "${typeDef.name}" contains an invalid JSON Schema: ${(error as Error).message}`,
      severity: "error",
    }];
  }
}

function getAjv(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  });
  const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => void;
  addFormats(ajv);
  return ajv;
}

function ajvErrorToIssue(error: ErrorObject, typeName: string): MdbaseError {
  const field = error.instancePath ? jsonPointerToFieldPath(error.instancePath) : undefined;
  const params = error.params as Record<string, unknown>;
  const missingProperty = typeof params.missingProperty === "string" ? params.missingProperty : undefined;
  const additionalProperty = typeof params.additionalProperty === "string" ? params.additionalProperty : undefined;

  switch (error.keyword) {
    case "required":
      return {
        code: "schema_required",
        message: `Required field "${missingProperty ?? field ?? "<root>"}" is missing for type "${typeName}"`,
        field: joinField(field, missingProperty),
        severity: "error",
      };
    case "additionalProperties":
      return {
        code: "schema_additional_properties",
        message: `Unknown field "${additionalProperty ?? field ?? "<root>"}" for type "${typeName}"`,
        field: joinField(field, additionalProperty),
        severity: "error",
      };
    case "type":
      return {
        code: "schema_type",
        message: `Type mismatch at "${field ?? "<root>"}" for type "${typeName}": ${error.message ?? "invalid type"}`,
        field,
        severity: "error",
      };
    case "enum":
      return {
        code: "schema_enum",
        message: `Invalid enum value at "${field ?? "<root>"}" for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "const":
      return {
        code: "schema_const",
        message: `Invalid const value at "${field ?? "<root>"}" for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "format":
      return {
        code: "format_invalid",
        message: `Invalid ${params.format ?? "format"} at "${field ?? "<root>"}" for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "minLength":
      return {
        code: "schema_min_length",
        message: `String at "${field ?? "<root>"}" is too short for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "maxLength":
      return {
        code: "schema_max_length",
        message: `String at "${field ?? "<root>"}" is too long for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "minimum":
    case "exclusiveMinimum":
      return {
        code: `schema_${snakeCaseKeyword(error.keyword)}`,
        message: `Number at "${field ?? "<root>"}" is too small for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "maximum":
    case "exclusiveMaximum":
      return {
        code: `schema_${snakeCaseKeyword(error.keyword)}`,
        message: `Number at "${field ?? "<root>"}" is too large for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "minItems":
      return {
        code: "schema_min_items",
        message: `Array at "${field ?? "<root>"}" has too few items for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "maxItems":
      return {
        code: "schema_max_items",
        message: `Array at "${field ?? "<root>"}" has too many items for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "uniqueItems":
      return {
        code: "schema_unique_items",
        message: `Array at "${field ?? "<root>"}" contains duplicate items for type "${typeName}"`,
        field,
        severity: "error",
      };
    case "pattern":
      return {
        code: "schema_pattern",
        message: `String at "${field ?? "<root>"}" does not match required pattern for type "${typeName}"`,
        field,
        severity: "error",
      };
    default:
      return {
        code: `schema_${snakeCaseKeyword(error.keyword)}`,
        message: `JSON Schema validation failed for type "${typeName}" at "${field ?? "<root>"}": ${error.message ?? error.keyword}`,
        field,
        severity: "error",
      };
  }
}

function snakeCaseKeyword(keyword: string): string {
  return keyword.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function jsonPointerToFieldPath(pointer: string): string {
  return pointer
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

function joinField(parent: string | undefined, child: string | undefined): string | undefined {
  if (!parent) return child;
  if (!child) return parent;
  return `${parent}.${child}`;
}
