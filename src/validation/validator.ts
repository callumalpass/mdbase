/**
 * Validation orchestrator.
 * Validates frontmatter against type definitions.
 * Implements §9 of the mdbase specification.
 */

import { MdbaseConfig } from "../config/loader.js";
import { TypeDefinition, FieldDefinition } from "../types/loader.js";
import { MdbaseError } from "../errors.js";
import { parseLink } from "../links/parser.js";

export interface ValidationResult {
  valid: boolean;
  issues: MdbaseError[];
}

/**
 * Merge field definitions from multiple types.
 * Returns merged fields and any type_conflict issues.
 */
function mergeTypeFields(
  types: TypeDefinition[],
  prefix?: string,
): { mergedFields: Record<string, FieldDefinition>; conflicts: MdbaseError[] } {
  const mergedFields: Record<string, FieldDefinition> = {};
  const conflicts: MdbaseError[] = [];

  for (const typeDef of types) {
    if (!typeDef.fields) continue;
    for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
      const fullName = prefix ? `${prefix}.${fieldName}` : fieldName;
      if (!(fieldName in mergedFields)) {
        mergedFields[fieldName] = { ...fieldDef };
        // Deep copy items and sub-fields
        if (fieldDef.items) mergedFields[fieldName].items = { ...fieldDef.items };
        if (fieldDef.fields) {
          mergedFields[fieldName].fields = {};
          for (const [k, v] of Object.entries(fieldDef.fields)) {
            mergedFields[fieldName].fields![k] = { ...v };
          }
        }
        if (fieldDef.values) mergedFields[fieldName].values = [...fieldDef.values];
      } else {
        const existing = mergedFields[fieldName];
        // Check base type compatibility
        if (existing.type && fieldDef.type && existing.type !== fieldDef.type) {
          conflicts.push({
            code: "type_conflict",
            message: `Incompatible field types for "${fullName}": ${existing.type} vs ${fieldDef.type}`,
            field: fullName,
            severity: "error",
          });
          continue;
        }

        // Merge required: OR
        if (fieldDef.required) existing.required = true;

        // Merge deprecated: OR
        if (fieldDef.deprecated) existing.deprecated = true;

        // Merge unique: OR
        if (fieldDef.unique) existing.unique = true;

        // Merge min: MAX
        if (fieldDef.min !== undefined) {
          existing.min = existing.min !== undefined ? Math.max(existing.min, fieldDef.min) : fieldDef.min;
        }

        // Merge max: MIN
        if (fieldDef.max !== undefined) {
          existing.max = existing.max !== undefined ? Math.min(existing.max, fieldDef.max) : fieldDef.max;
        }

        // Check merged min > merged max
        if (existing.min !== undefined && existing.max !== undefined && existing.min > existing.max) {
          conflicts.push({
            code: "type_conflict",
            message: `Merged min (${existing.min}) exceeds merged max (${existing.max}) for "${fullName}"`,
            field: fullName,
            severity: "error",
          });
        }

        // Merge min_length: MAX
        if (fieldDef.min_length !== undefined) {
          existing.min_length = existing.min_length !== undefined ? Math.max(existing.min_length, fieldDef.min_length) : fieldDef.min_length;
        }

        // Merge max_length: MIN
        if (fieldDef.max_length !== undefined) {
          existing.max_length = existing.max_length !== undefined ? Math.min(existing.max_length, fieldDef.max_length) : fieldDef.max_length;
        }

        // Merge min_items: MAX
        if (fieldDef.min_items !== undefined) {
          existing.min_items = existing.min_items !== undefined ? Math.max(existing.min_items, fieldDef.min_items) : fieldDef.min_items;
        }

        // Merge max_items: MIN
        if (fieldDef.max_items !== undefined) {
          existing.max_items = existing.max_items !== undefined ? Math.min(existing.max_items, fieldDef.max_items) : fieldDef.max_items;
        }

        // Merge enum values: intersection
        if (fieldDef.values !== undefined && existing.values !== undefined) {
          const intersection = existing.values.filter((v) => fieldDef.values!.includes(v));
          if (intersection.length === 0) {
            conflicts.push({
              code: "type_conflict",
              message: `Empty enum intersection for "${fullName}"`,
              field: fullName,
              severity: "error",
            });
          }
          existing.values = intersection;
        } else if (fieldDef.values !== undefined) {
          existing.values = [...fieldDef.values];
        }

        // Merge pattern: collect all (must match all)
        if (fieldDef.pattern !== undefined) {
          if (existing.pattern !== undefined && existing.pattern !== fieldDef.pattern) {
            // Store multiple patterns as _patterns array
            const existingPatterns = (existing as unknown as Record<string, unknown>)._patterns as string[] | undefined;
            if (existingPatterns) {
              if (!existingPatterns.includes(fieldDef.pattern)) {
                existingPatterns.push(fieldDef.pattern);
              }
            } else {
              (existing as unknown as Record<string, unknown>)._patterns = [existing.pattern, fieldDef.pattern];
            }
          } else if (existing.pattern === undefined) {
            existing.pattern = fieldDef.pattern;
          }
        }

        // Merge default: must be equal or type_conflict
        if (fieldDef.default !== undefined && existing.default !== undefined) {
          if (JSON.stringify(fieldDef.default) !== JSON.stringify(existing.default)) {
            conflicts.push({
              code: "type_conflict",
              message: `Conflicting defaults for "${fullName}": ${JSON.stringify(existing.default)} vs ${JSON.stringify(fieldDef.default)}`,
              field: fullName,
              severity: "error",
            });
          }
        } else if (fieldDef.default !== undefined) {
          existing.default = fieldDef.default;
        }

        // Merge generated: must be same strategy or type_conflict
        if (fieldDef.generated !== undefined && existing.generated !== undefined) {
          const existingGen = typeof existing.generated === "string" ? existing.generated : JSON.stringify(existing.generated);
          const newGen = typeof fieldDef.generated === "string" ? fieldDef.generated : JSON.stringify(fieldDef.generated);
          if (existingGen !== newGen) {
            conflicts.push({
              code: "type_conflict",
              message: `Conflicting generated strategies for "${fullName}"`,
              field: fullName,
              severity: "error",
            });
          }
        } else if (fieldDef.generated !== undefined) {
          existing.generated = fieldDef.generated;
        }

        // Merge link target: must be same or type_conflict
        const existingTarget = (existing as unknown as Record<string, unknown>).target as string | undefined;
        const newTarget = (fieldDef as unknown as Record<string, unknown>).target as string | undefined;
        if (existingTarget !== undefined && newTarget !== undefined && existingTarget !== newTarget) {
          conflicts.push({
            code: "type_conflict",
            message: `Conflicting link targets for "${fullName}": ${existingTarget} vs ${newTarget}`,
            field: fullName,
            severity: "error",
          });
        } else if (newTarget !== undefined) {
          (existing as unknown as Record<string, unknown>).target = newTarget;
        }

        // Merge validate_exists: OR
        const existingVE = (existing as unknown as Record<string, unknown>).validate_exists as boolean | undefined;
        const newVE = (fieldDef as unknown as Record<string, unknown>).validate_exists as boolean | undefined;
        if (newVE) {
          (existing as unknown as Record<string, unknown>).validate_exists = true;
        }

        // Recursively merge list items
        if (fieldDef.items && existing.items) {
          // Merge item-level constraints
          const itemConflicts = mergeFieldDefs(existing.items, fieldDef.items, fullName);
          conflicts.push(...itemConflicts);
        } else if (fieldDef.items) {
          existing.items = { ...fieldDef.items };
        }

        // Recursively merge object sub-fields
        if (fieldDef.fields && existing.fields) {
          const subMerge = mergeTypeFields(
            [{ name: "_a", fields: existing.fields }, { name: "_b", fields: fieldDef.fields }],
            fullName,
          );
          if (subMerge.conflicts.length > 0) {
            conflicts.push(...subMerge.conflicts);
          }
          existing.fields = subMerge.mergedFields;
        } else if (fieldDef.fields) {
          existing.fields = {};
          for (const [k, v] of Object.entries(fieldDef.fields)) {
            existing.fields[k] = { ...v };
          }
        }
      }
    }
  }
  return { mergedFields, conflicts };
}

/**
 * Merge two FieldDefinition objects in place (mutates 'existing').
 * Returns any type_conflict issues.
 */
function mergeFieldDefs(existing: FieldDefinition, incoming: FieldDefinition, fieldPath: string): MdbaseError[] {
  const conflicts: MdbaseError[] = [];

  // Check base type compatibility
  if (existing.type && incoming.type && existing.type !== incoming.type) {
    conflicts.push({
      code: "type_conflict",
      message: `Incompatible item types for "${fieldPath}": ${existing.type} vs ${incoming.type}`,
      field: fieldPath,
      severity: "error",
    });
    return conflicts;
  }
  if (!existing.type && incoming.type) existing.type = incoming.type;

  if (incoming.required) existing.required = true;
  if (incoming.deprecated) existing.deprecated = true;
  if (incoming.unique) existing.unique = true;

  if (incoming.min !== undefined) {
    existing.min = existing.min !== undefined ? Math.max(existing.min, incoming.min) : incoming.min;
  }
  if (incoming.max !== undefined) {
    existing.max = existing.max !== undefined ? Math.min(existing.max, incoming.max) : incoming.max;
  }
  if (incoming.min_length !== undefined) {
    existing.min_length = existing.min_length !== undefined ? Math.max(existing.min_length, incoming.min_length) : incoming.min_length;
  }
  if (incoming.max_length !== undefined) {
    existing.max_length = existing.max_length !== undefined ? Math.min(existing.max_length, incoming.max_length) : incoming.max_length;
  }
  if (incoming.min_items !== undefined) {
    existing.min_items = existing.min_items !== undefined ? Math.max(existing.min_items, incoming.min_items) : incoming.min_items;
  }
  if (incoming.max_items !== undefined) {
    existing.max_items = existing.max_items !== undefined ? Math.min(existing.max_items, incoming.max_items) : incoming.max_items;
  }

  if (incoming.values !== undefined && existing.values !== undefined) {
    const intersection = existing.values.filter((v) => incoming.values!.includes(v));
    if (intersection.length === 0) {
      conflicts.push({ code: "type_conflict", message: `Empty enum intersection for "${fieldPath}"`, field: fieldPath, severity: "error" });
    }
    existing.values = intersection;
  } else if (incoming.values !== undefined) {
    existing.values = [...incoming.values];
  }

  if (incoming.pattern !== undefined) {
    if (existing.pattern !== undefined && existing.pattern !== incoming.pattern) {
      const existingPatterns = (existing as unknown as Record<string, unknown>)._patterns as string[] | undefined;
      if (existingPatterns) {
        if (!existingPatterns.includes(incoming.pattern)) existingPatterns.push(incoming.pattern);
      } else {
        (existing as unknown as Record<string, unknown>)._patterns = [existing.pattern, incoming.pattern];
      }
    } else if (existing.pattern === undefined) {
      existing.pattern = incoming.pattern;
    }
  }

  // Recursively merge items (for nested lists)
  if (incoming.items && existing.items) {
    conflicts.push(...mergeFieldDefs(existing.items, incoming.items, fieldPath));
  } else if (incoming.items) {
    existing.items = { ...incoming.items };
  }

  // Recursively merge object sub-fields
  if (incoming.fields && existing.fields) {
    const subMerge = mergeTypeFields(
      [{ name: "_a", fields: existing.fields }, { name: "_b", fields: incoming.fields }],
      fieldPath,
    );
    conflicts.push(...subMerge.conflicts);
    existing.fields = subMerge.mergedFields;
  } else if (incoming.fields) {
    existing.fields = {};
    for (const [k, v] of Object.entries(incoming.fields)) {
      existing.fields[k] = { ...v };
    }
  }

  return conflicts;
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

  // Merge fields from all types
  const { mergedFields, conflicts } = mergeTypeFields(types);
  issues.push(...conflicts);

  // Determine strictness
  // If any type explicitly sets strict, use the strictest explicit setting.
  // If no type sets strict, use config default.
  let effectiveStrict: boolean | "warn" | undefined;
  let anyExplicitStrict = false;
  for (const typeDef of types) {
    if (typeDef.strict !== undefined) {
      anyExplicitStrict = true;
      if (typeDef.strict === true) {
        effectiveStrict = true;
      } else if (typeDef.strict === "warn" && effectiveStrict !== true) {
        effectiveStrict = "warn";
      } else if (typeDef.strict === false && effectiveStrict === undefined) {
        effectiveStrict = false;
      }
    }
  }
  if (!anyExplicitStrict) {
    effectiveStrict = config.settings.default_strict;
  }

  // Collect all known fields from all types (for strict mode union)
  const allKnownFields = new Set<string>();
  for (const typeDef of types) {
    if (typeDef.fields) {
      for (const fieldName of Object.keys(typeDef.fields)) {
        allKnownFields.add(fieldName);
      }
    }
  }

  // Check required fields from merged definitions
  for (const [fieldName, fieldDef] of Object.entries(mergedFields)) {
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

  // Check field values against merged definitions
  for (const [fieldName, value] of Object.entries(frontmatter)) {
    // Skip type declaration keys
    if (config.settings.explicit_type_keys.includes(fieldName)) continue;

    const fieldDef = mergedFields[fieldName];

    if (!fieldDef) {
      // Unknown field — strictness check uses union of all type fields
      if (!allKnownFields.has(fieldName)) {
        if (effectiveStrict === true) {
          issues.push({
            code: "unknown_field",
            message: `Unknown field "${fieldName}"`,
            field: fieldName,
            severity: "error",
          });
        } else if (effectiveStrict === "warn") {
          issues.push({
            code: "unknown_field",
            message: `Unknown field "${fieldName}"`,
            field: fieldName,
            severity: "warning",
          });
        }
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

  // Check unique constraints across all files
  if (allFiles && types.length > 0) {
    for (const [fieldName, fieldDef] of Object.entries(mergedFields)) {
      if (fieldDef.unique) {
        checkUniqueness(fieldName, allFiles, issues);
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
      if (fieldDef.min_length !== undefined && [...val].length < fieldDef.min_length) {
        issues.push({
          code: "string_too_short",
          message: `String "${fullFieldName}" is too short (${[...val].length} < ${fieldDef.min_length})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.max_length !== undefined && [...val].length > fieldDef.max_length) {
        issues.push({
          code: "string_too_long",
          message: `String "${fullFieldName}" is too long (${[...val].length} > ${fieldDef.max_length})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.pattern) {
        // Check all patterns (may have _patterns array from merge)
        const patterns = (fieldDef as unknown as Record<string, unknown>)._patterns as string[] | undefined;
        const allPatterns = patterns ?? [fieldDef.pattern];
        for (const pat of allPatterns) {
          const regex = new RegExp(pat);
          if (!regex.test(val)) {
            issues.push({
              code: "pattern_mismatch",
              message: `String "${fullFieldName}" doesn't match pattern "${pat}"`,
              field: fullFieldName,
              severity: "error",
            });
            break; // One mismatch is enough
          }
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
      if (fieldDef.min !== undefined && !(val >= fieldDef.min)) {
        issues.push({
          code: "number_too_small",
          message: `Integer "${fullFieldName}" is too small (${val} < ${fieldDef.min})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.max !== undefined && !(val <= fieldDef.max)) {
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
      // NaN fails any min/max constraint
      if (fieldDef.min !== undefined && !(val >= fieldDef.min)) {
        issues.push({
          code: "number_too_small",
          message: `Number "${fullFieldName}" violates min constraint (${val} < ${fieldDef.min})`,
          field: fullFieldName,
          severity: "error",
        });
      }
      if (fieldDef.max !== undefined && !(val <= fieldDef.max)) {
        issues.push({
          code: "number_too_large",
          message: `Number "${fullFieldName}" violates max constraint (${val} > ${fieldDef.max})`,
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
        let hasItemError = false;
        for (let i = 0; i < val.length; i++) {
          const itemIssues = validateFieldValue(
            `${fieldName}[${i}]`,
            val[i],
            fieldDef.items,
            config,
            parentPath,
          );
          if (itemIssues.length > 0 && !hasItemError) {
            hasItemError = true;
            issues.push({
              code: "list_item_invalid",
              message: `Invalid item in list "${fullFieldName}"`,
              field: fullFieldName,
              severity: "error",
            });
          }
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

    case "link":
      if (typeof val !== "string") {
        issues.push({
          code: "type_mismatch",
          message: `Expected link (string) for "${fullFieldName}"`,
          field: fullFieldName,
          severity: "error",
        });
        break;
      }
      // Validate link syntax
      try {
        parseLink(val);
      } catch (e: unknown) {
        const err = e as { code?: string };
        issues.push({
          code: err.code ?? "invalid_link",
          message: `Invalid link value for "${fullFieldName}": ${val}`,
          field: fullFieldName,
          severity: "error",
        });
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
  const pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
  const match = pattern.exec(value);
  if (!match) return false;

  // Validate ranges
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hours = parseInt(match[4], 10);
  const minutes = parseInt(match[5], 10);
  const seconds = parseInt(match[6], 10);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hours > 23 || minutes > 59 || seconds > 59) return false;

  return true;
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
