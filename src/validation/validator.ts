/**
 * Validation orchestrator.
 * Validates frontmatter against type definitions.
 * Implements §9 of the mdbase specification.
 */

import { MdbaseConfig } from "../config/loader.js";
import { TypeDefinition, FieldDefinition } from "../types/loader.js";
import { MdbaseError } from "../errors.js";

export interface ValidationResult {
  valid: boolean;
  issues: MdbaseError[];
}

/**
 * Validate frontmatter against resolved type definitions.
 */
export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  types: TypeDefinition[],
  config: MdbaseConfig,
  allFiles?: Map<string, Record<string, unknown>>,
): ValidationResult {
  const issues: MdbaseError[] = [];

  for (const typeDef of types) {
    if (!typeDef.fields) continue;

    // Check required fields
    for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
      if (fieldDef.required) {
        const value = frontmatter[fieldName];
        if (!(fieldName in frontmatter) || value === null || value === undefined) {
          issues.push({
            code: "missing_required",
            message: `Required field "${fieldName}" is missing`,
            field: fieldName,
            severity: "error",
          });
        }
      }
    }

    // Check field values
    for (const [fieldName, value] of Object.entries(frontmatter)) {
      // Skip type declaration keys
      if (config.settings.explicit_type_keys.includes(fieldName)) continue;

      const fieldDef = typeDef.fields[fieldName];

      if (!fieldDef) {
        // Unknown field - strictness check
        const strict = typeDef.strict ?? config.settings.default_strict;
        if (strict === true) {
          issues.push({
            code: "unknown_field",
            message: `Unknown field "${fieldName}"`,
            field: fieldName,
            severity: "error",
          });
        } else if (strict === "warn") {
          issues.push({
            code: "unknown_field",
            message: `Unknown field "${fieldName}"`,
            field: fieldName,
            severity: "warning",
          });
        }
        continue;
      }

      // Deprecated field check
      if (fieldDef.deprecated && value !== null && value !== undefined) {
        issues.push({
          code: "deprecated_field",
          message: `Field "${fieldName}" is deprecated`,
          field: fieldName,
          severity: "warning",
        });
      }

      // Skip validation for null values
      if (value === null || value === undefined) continue;

      // Type-specific validation
      const fieldIssues = validateFieldValue(fieldName, value, fieldDef, config);
      issues.push(...fieldIssues);
    }
  }

  // Check unique constraints across all files
  if (allFiles && types.length > 0) {
    for (const typeDef of types) {
      if (!typeDef.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.unique) {
          checkUniqueness(fieldName, allFiles, issues);
        }
      }
    }

    // Check id_field uniqueness
    checkIdUniqueness(config.settings.id_field, allFiles, issues);
  }

  const hasErrors = issues.some((i) => i.severity === "error" || !i.severity);
  return {
    valid: !hasErrors,
    issues,
  };
}

function validateFieldValue(
  fieldName: string,
  value: unknown,
  fieldDef: FieldDefinition,
  config: MdbaseConfig,
  parentPath?: string,
): MdbaseError[] {
  const issues: MdbaseError[] = [];
  const fullFieldName = parentPath ? `${parentPath}.${fieldName}` : fieldName;

  // Coerce value before validation
  const coerced = coerceValue(value, fieldDef);
  if (coerced.error) {
    issues.push({
      code: coerced.error,
      message: `Type mismatch for field "${fullFieldName}"`,
      field: fullFieldName,
      severity: "error",
    });
    return issues;
  }
  const val = coerced.value;

  switch (fieldDef.type) {
    case "string":
      if (typeof val !== "string") {
        issues.push({
          code: "type_mismatch",
          message: `Expected string for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
        break;
      }
      if (fieldDef.min_length !== undefined && val.length < fieldDef.min_length) {
        issues.push({
          code: "string_too_short",
          message: `String "${fullFieldName}" is too short (${val.length} < ${fieldDef.min_length})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.max_length !== undefined && val.length > fieldDef.max_length) {
        issues.push({
          code: "string_too_long",
          message: `String "${fullFieldName}" is too long (${val.length} > ${fieldDef.max_length})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.pattern) {
        const regex = new RegExp(fieldDef.pattern);
        if (!regex.test(val)) {
          issues.push({
            code: "pattern_mismatch",
            message: `String "${fullFieldName}" doesn't match pattern "${fieldDef.pattern}"`,
            field: fullFieldName,
            severity: "error",
          });
        }
      }
      break;

    case "integer":
      if (typeof val !== "number") {
        issues.push({
          code: "type_mismatch",
          message: `Expected integer for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
        break;
      }
      if (!Number.isInteger(val)) {
        issues.push({
          code: "not_integer",
          message: `Expected integer for "${fullFieldName}", got float`,
          field: fullFieldName,
          severity: "error",
        });
        break;
      }
      if (fieldDef.min !== undefined && val < fieldDef.min) {
        issues.push({
          code: "number_too_small",
          message: `Integer "${fullFieldName}" is too small (${val} < ${fieldDef.min})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.max !== undefined && val > fieldDef.max) {
        issues.push({
          code: "number_too_large",
          message: `Integer "${fullFieldName}" is too large (${val} > ${fieldDef.max})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      break;

    case "number":
      if (typeof val !== "number") {
        issues.push({
          code: "type_mismatch",
          message: `Expected number for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
        break;
      }
      if (fieldDef.min !== undefined && val < fieldDef.min) {
        issues.push({
          code: "number_too_small",
          message: `Number "${fullFieldName}" is too small (${val} < ${fieldDef.min})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.max !== undefined && val > fieldDef.max) {
        issues.push({
          code: "number_too_large",
          message: `Number "${fullFieldName}" is too large (${val} > ${fieldDef.max})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      break;

    case "boolean":
      if (typeof val !== "boolean") {
        issues.push({
          code: "type_mismatch",
          message: `Expected boolean for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
      }
      break;

    case "date":
      if (!isValidDate(val)) {
        issues.push({
          code: "invalid_date",
          message: `Invalid date for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
      }
      break;

    case "datetime":
      if (!isValidDatetime(val)) {
        issues.push({
          code: "invalid_datetime",
          message: `Invalid datetime for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
      }
      break;

    case "time":
      if (!isValidTime(val)) {
        issues.push({
          code: "invalid_time",
          message: `Invalid time for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
      }
      break;

    case "enum":
      if (fieldDef.values && !fieldDef.values.includes(String(val))) {
        issues.push({
          code: "invalid_enum",
          message: `Invalid enum value "${val}" for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
      }
      break;

    case "list":
      if (!Array.isArray(val)) {
        issues.push({
          code: "type_mismatch",
          message: `Expected list for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
        break;
      }
      if (fieldDef.min_items !== undefined && val.length < fieldDef.min_items) {
        issues.push({
          code: "list_too_short",
          message: `List "${fullFieldName}" has too few items (${val.length} < ${fieldDef.min_items})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.max_items !== undefined && val.length > fieldDef.max_items) {
        issues.push({
          code: "list_too_long",
          message: `List "${fullFieldName}" has too many items (${val.length} > ${fieldDef.max_items})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.unique) {
        const coercedItems = val.map((item) => {
          if (fieldDef.items) {
            const c = coerceValue(item, fieldDef.items);
            return c.value ?? item;
          }
          return item;
        });
        const seen = new Set();
        for (const item of coercedItems) {
          const key = JSON.stringify(item);
          if (seen.has(key)) {
            issues.push({
              code: "list_duplicate",
              message: `Duplicate item in list "${fullFieldName}"`,
              field: fullFieldName,
              severity: "error",
            });
            break;
          }
          seen.add(key);
        }
      }
      // Validate items
      if (fieldDef.items) {
        for (let i = 0; i < val.length; i++) {
          const itemIssues = validateFieldValue(
            `${fieldName}[${i}]`,
            val[i],
            fieldDef.items,
            config,
            parentPath,
          );
          issues.push(...itemIssues);
        }
      }
      break;

    case "object":
      if (typeof val !== "object" || val === null || Array.isArray(val)) {
        issues.push({
          code: "type_mismatch",
          message: `Expected object for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
        break;
      }
      if (fieldDef.fields) {
        const objVal = val as Record<string, unknown>;
        // Check required nested fields
        for (const [nestedName, nestedDef] of Object.entries(fieldDef.fields)) {
          if (nestedDef.required && !(nestedName in objVal)) {
            issues.push({
              code: "missing_required",
              message: `Required field "${fullFieldName}.${nestedName}" is missing`,
              field: `${fullFieldName}.${nestedName}`,
              severity: "error",
            });
          }
        }
        // Validate nested field values
        for (const [nestedName, nestedValue] of Object.entries(objVal)) {
          const nestedDef = fieldDef.fields[nestedName];
          if (nestedDef && nestedValue !== null && nestedValue !== undefined) {
            const nestedIssues = validateFieldValue(
              nestedName,
              nestedValue,
              nestedDef,
              config,
              fullFieldName,
            );
            issues.push(...nestedIssues);
          }
        }
      }
      break;

    case "any":
      // Any type accepts everything
      break;
  }

  return issues;
}

interface CoercionResult {
  value: unknown;
  error?: string;
}

/**
 * Type coercion per §7.16.
 */
function coerceValue(value: unknown, fieldDef: FieldDefinition): CoercionResult {
  if (value === null || value === undefined) {
    return { value };
  }

  switch (fieldDef.type) {
    case "string":
      // Numbers and booleans can be coerced to string
      if (typeof value === "number" || typeof value === "boolean") {
        return { value: String(value) };
      }
      if (value instanceof Date) {
        return { value: value.toISOString() };
      }
      return { value };

    case "integer":
      // String to integer coercion
      if (typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num) && Number.isInteger(num)) {
          return { value: num };
        }
        if (!isNaN(num)) {
          // It's a valid number but not integer - let validation catch it
          return { value: num };
        }
        return { value, error: "type_mismatch" };
      }
      // Float with no fractional part coerced to integer
      if (typeof value === "number" && Number.isFinite(value)) {
        if (Number.isInteger(value) || value === Math.floor(value)) {
          return { value: Math.floor(value) };
        }
        return { value }; // non-integer float, let validator catch it
      }
      return { value };

    case "number":
      if (typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num)) {
          return { value: num };
        }
        return { value, error: "type_mismatch" };
      }
      return { value };

    case "boolean":
      if (typeof value === "string") {
        if (value.toLowerCase() === "true") return { value: true };
        if (value.toLowerCase() === "false") return { value: false };
        return { value, error: "type_mismatch" };
      }
      return { value };

    case "date":
      // YAML date objects → string
      if (value instanceof Date) {
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, "0");
        const d = String(value.getUTCDate()).padStart(2, "0");
        return { value: `${y}-${m}-${d}` };
      }
      return { value };

    case "datetime":
      if (value instanceof Date) {
        return { value: value.toISOString() };
      }
      return { value };

    default:
      return { value };
  }
}

function isValidDate(value: unknown): boolean {
  let str: string;
  if (value instanceof Date) {
    // YAML auto-parses dates - validate the Date object
    return !isNaN(value.getTime());
  }
  if (typeof value === "string") {
    str = value;
  } else {
    return false;
  }

  // Must match YYYY-MM-DD
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  // Validate the date is real
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidDatetime(value: unknown): boolean {
  if (value instanceof Date) {
    return !isNaN(value.getTime());
  }
  if (typeof value !== "string") return false;

  // ISO 8601 datetime: YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM]
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
  return pattern.test(value);
}

function isValidTime(value: unknown): boolean {
  if (typeof value !== "string") return false;

  // HH:MM or HH:MM:SS
  const pattern = /^\d{2}:\d{2}(:\d{2})?$/;
  if (!pattern.test(value)) return false;

  const parts = value.split(":");
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parts[2] ? parseInt(parts[2], 10) : 0;

  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59 && seconds >= 0 && seconds <= 59;
}

function checkUniqueness(
  fieldName: string,
  allFiles: Map<string, Record<string, unknown>>,
  issues: MdbaseError[],
): void {
  const seen = new Map<string, string>();
  for (const [filePath, frontmatter] of allFiles) {
    const value = frontmatter[fieldName];
    if (value === null || value === undefined) continue;
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      issues.push({
        code: "duplicate_value",
        message: `Duplicate value "${value}" for unique field "${fieldName}" in "${filePath}" (first seen in "${seen.get(key)}")`,
        field: fieldName,
        path: filePath,
        severity: "error",
      });
    } else {
      seen.set(key, filePath);
    }
  }
}

function checkIdUniqueness(
  idField: string,
  allFiles: Map<string, Record<string, unknown>>,
  issues: MdbaseError[],
): void {
  const seen = new Map<string, string>();
  for (const [filePath, frontmatter] of allFiles) {
    const value = frontmatter[idField];
    if (value === null || value === undefined) continue;
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      issues.push({
        code: "duplicate_id",
        message: `Duplicate id "${value}" in "${filePath}" (first seen in "${seen.get(key)}")`,
        field: idField,
        path: filePath,
        severity: "error",
      });
    } else {
      seen.set(key, filePath);
    }
  }
}
