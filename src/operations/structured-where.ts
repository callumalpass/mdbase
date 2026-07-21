import * as path from "node:path";

import { evaluateMdbaseCel } from "../expressions/cel.js";
import { evaluateWhere } from "../expressions/evaluator.js";

export type SpecProfile = "v0.2" | "v0.3";

export interface StructuredWhereContext {
  frontmatter: Record<string, unknown>;
  filePath: string;
  types: string[];
  body?: string | null;
  specProfile: SpecProfile;
}

export function evaluateStructuredWhere(
  where: string | Record<string, unknown>,
  context: StructuredWhereContext,
): boolean {
  if (typeof where === "string") return evaluateStringWhere(where, context);

  if ("and" in where) {
    return conditions(where.and).every((condition) => evaluateStructuredWhere(condition, context));
  }
  if ("or" in where) {
    return conditions(where.or).some((condition) => evaluateStructuredWhere(condition, context));
  }
  if ("not" in where) {
    return !evaluateStructuredWhere(where.not as string | Record<string, unknown>, context);
  }
  if (typeof where.expression === "string") {
    return evaluateWhere(where.expression, legacyContext(context));
  }
  return matchesFieldConditions(context.frontmatter, where, context.specProfile);
}

export function matchesFieldConditions(
  frontmatter: Record<string, unknown>,
  where: Record<string, unknown>,
  specProfile: SpecProfile,
): boolean {
  for (const [field, condition] of Object.entries(where)) {
    const selected = getFieldPathValue(frontmatter, field);
    if (!isOperatorSet(condition)) {
      if (!selected.present || !deepEqual(selected.value, condition)) return false;
      continue;
    }
    for (const [operator, expected] of Object.entries(condition)) {
      if (!evaluateOperator(selected.value, selected.present, operator, expected, specProfile)) {
        return false;
      }
    }
  }
  return true;
}

function evaluateStringWhere(expression: string, context: StructuredWhereContext): boolean {
  if (context.specProfile === "v0.2") {
    return evaluateWhere(expression, legacyContext(context));
  }
  const folder = path.dirname(context.filePath) === "." ? "" : path.dirname(context.filePath);
  const result = evaluateMdbaseCel(expression, {
    record: context.frontmatter,
    raw: context.frontmatter,
    file: {
      path: context.filePath,
      name: path.basename(context.filePath),
      folder,
      body: context.body ?? "",
    },
  });
  return result.diagnostics.length === 0 && result.value === true;
}

function legacyContext(context: StructuredWhereContext) {
  return {
    frontmatter: context.frontmatter,
    path: context.filePath,
    types: context.types,
    body: context.body,
  };
}

function conditions(value: unknown): Array<string | Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is string | Record<string, unknown> =>
      typeof item === "string" || isRecord(item))
    : [];
}

function isOperatorSet(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function evaluateOperator(
  value: unknown,
  present: boolean,
  operator: string,
  expected: unknown,
  specProfile: SpecProfile,
): boolean {
  switch (operator) {
    case "eq":
    case "const":
      return present && value !== null && value !== undefined && deepEqual(value, expected);
    case "neq":
      return present && value !== null && value !== undefined && !deepEqual(value, expected);
    case "gt":
      return compare(value, expected, (left, right) => left > right);
    case "gte":
      return compare(value, expected, (left, right) => left >= right);
    case "lt":
      return compare(value, expected, (left, right) => left < right);
    case "lte":
      return compare(value, expected, (left, right) => left <= right);
    case "exists":
      return specProfile === "v0.3"
        ? expected === true ? present : !present
        : expected === true
          ? present && value !== null && value !== undefined
          : !present || value === null || value === undefined;
    case "contains":
      return Array.isArray(value)
        ? value.some((item) => deepEqual(item, expected))
        : typeof value === "string" && value.includes(String(expected));
    case "containsAll":
      return Array.isArray(value) && Array.isArray(expected) &&
        expected.every((entry) => value.some((item) => deepEqual(item, entry)));
    case "containsAny":
      return Array.isArray(value) && Array.isArray(expected) &&
        expected.some((entry) => value.some((item) => deepEqual(item, entry)));
    case "in":
      return value !== null && value !== undefined && Array.isArray(expected) &&
        expected.some((item) => deepEqual(item, value));
    case "startsWith":
    case "starts_with":
      return typeof value === "string" && value.startsWith(String(expected));
    case "endsWith":
    case "ends_with":
      return typeof value === "string" && value.endsWith(String(expected));
    case "matches":
      try {
        return value !== null && value !== undefined &&
          new RegExp(String(expected).replace(/\\\\/g, "\\")).test(String(value));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function compare(
  left: unknown,
  right: unknown,
  predicate: (left: number | string, right: number | string) => boolean,
): boolean {
  if (typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right)) {
    return predicate(left, right);
  }
  return typeof left === "string" && typeof right === "string" && predicate(left, right);
}

function getFieldPathValue(
  frontmatter: Record<string, unknown>,
  fieldPath: string,
): { present: boolean; value: unknown } {
  let current: unknown[] = [frontmatter];
  for (const segment of fieldPath.split(".").filter(Boolean)) {
    const arraySegment = segment.endsWith("[]");
    const key = arraySegment ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const value of current) {
      if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) continue;
      const child = value[key];
      if (arraySegment) {
        if (Array.isArray(child)) next.push(...child);
      } else {
        next.push(child);
      }
    }
    current = next;
    if (current.length === 0) return { present: false, value: undefined };
  }
  return { present: true, value: current[0] };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
