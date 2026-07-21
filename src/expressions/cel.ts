import {
  CelScalar,
  celEnv,
  celMethod,
  isCelError,
  isCelList,
  mapType,
  parse,
  plan,
  type CelResult,
  type CelValue,
  type CelInput,
} from "@bufbuild/cel";
import { strings } from "@bufbuild/cel/ext";

export interface MdbaseCelDiagnostic {
  code: string;
  message: string;
  expression: string;
}

export interface MdbaseCelContext {
  record?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  knownFields?: Iterable<string>;
  old?: Record<string, unknown>;
  file?: Record<string, unknown>;
  event?: Record<string, unknown>;
  steps?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  item?: unknown;
  thisRecord?: Record<string, unknown> | null;
  projection?: Record<string, unknown>;
  values?: unknown[];
  operation?: Record<string, unknown>;
}

export interface MdbaseCelResult {
  value: unknown;
  diagnostics: MdbaseCelDiagnostic[];
}

const mapDyn = mapType(CelScalar.STRING, CelScalar.DYN);

const mdbaseCelFuncs = [
  ...strings,
  celMethod("inFolder", mapDyn, [CelScalar.STRING], CelScalar.BOOL, function inFolder(folder) {
    const filePath = this.get("path");
    if (typeof filePath !== "string") return false;
    const normalizedFolder = folder.replace(/^\/+|\/+$/g, "");
    return filePath === normalizedFolder || filePath.startsWith(`${normalizedFolder}/`);
  }),
  celMethod("hasTag", mapDyn, [CelScalar.STRING], CelScalar.BOOL, function hasTag(tag) {
    const tags = this.get("tags");
    if (!isCelList(tags)) return false;
    const expected = tag.replace(/^#/, "");
    for (const value of tags) {
      if (typeof value !== "string") continue;
      const actual = value.replace(/^#/, "");
      if (actual === expected || actual.startsWith(`${expected}/`)) {
        return true;
      }
    }
    return false;
  }),
  celMethod("hasLink", mapDyn, [CelScalar.STRING], CelScalar.BOOL, function hasLink(linkValue) {
    const links = this.get("links");
    if (!isCelList(links)) return false;
    for (const value of links) {
      if (typeof value === "string" && value === linkValue) return true;
      if (isObjectWithRaw(value) && value.raw === linkValue) return true;
    }
    return false;
  }),
  celMethod("asLink", mapDyn, [], CelScalar.STRING, function asLink() {
    const filePath = this.get("path");
    return typeof filePath === "string" ? `[[${filePath}]]` : "";
  }),
];

export const MDBASE_CEL_PROGRAM_CACHE_LIMIT = 512;

type CelProgram = (bindings: Record<string, CelInput>) => CelResult;

const mdbaseCelEnvironment = celEnv({ funcs: mdbaseCelFuncs });
const programCache = new Map<string, CelProgram>();

function compileMdbaseCel(expression: string): CelProgram {
  const cached = programCache.get(expression);
  if (cached) {
    // Refresh insertion order so the bounded map behaves as an LRU cache.
    programCache.delete(expression);
    programCache.set(expression, cached);
    return cached;
  }

  const compiled = plan(mdbaseCelEnvironment, parse(expression)) as CelProgram;
  if (programCache.size >= MDBASE_CEL_PROGRAM_CACHE_LIMIT) {
    const leastRecentlyUsed = programCache.keys().next().value;
    if (leastRecentlyUsed !== undefined) programCache.delete(leastRecentlyUsed);
  }
  programCache.set(expression, compiled);
  return compiled;
}

/** Clear process-local compiled CEL programs, primarily for deterministic tests. */
export function clearMdbaseCelProgramCache(): void {
  programCache.clear();
}

/** Return the current bounded cache size without exposing cached expressions. */
export function getMdbaseCelProgramCacheSize(): number {
  return programCache.size;
}

export function evaluateMdbaseCel(expression: string, context: MdbaseCelContext): MdbaseCelResult {
  try {
    const value = compileMdbaseCel(expression)(
      buildMdbaseCelBindings(context) as Record<string, CelInput>,
    );
    if (isCelError(value)) {
      return {
        value: null,
        diagnostics: [{
          code: "expression_evaluation_error",
          message: value.message,
          expression,
        }],
      };
    }
    return { value: normalizeCelValue(value), diagnostics: [] };
  } catch (error) {
    return {
      value: null,
      diagnostics: [{
        code: "expression_evaluation_error",
        message: error instanceof Error ? error.message : "CEL expression failed",
        expression,
      }],
    };
  }
}

export function buildMdbaseCelBindings(context: MdbaseCelContext): Record<string, unknown> {
  const record = context.record ?? {};
  const raw = context.raw ?? record;
  const old = context.old ?? {};
  const knownFields = new Set([
    ...Object.keys(record),
    ...Object.keys(raw),
    ...Object.keys(old),
    ...(context.knownFields ?? []),
  ]);
  const missingTopLevelFields = Object.fromEntries(
    [...knownFields]
      .filter((field) => !Object.prototype.hasOwnProperty.call(record, field))
      .map((field) => [field, null]),
  );
  const bindings: Record<string, unknown> = {
    ...missingTopLevelFields,
    ...record,
    record,
    raw,
    note: record,
    old,
    file: context.file ?? {},
    event: context.event ?? {},
    steps: context.steps ?? {},
    vars: context.vars ?? {},
    operation: context.operation ?? {},
    projection: context.projection ?? {},
    values: context.values ?? [],
    this: context.thisRecord ?? null,
    present: {
      record: buildPresenceMap(record, knownFields),
      raw: buildPresenceMap(raw, knownFields),
      old: buildPresenceMap(old, knownFields),
    },
  };
  if (context.item !== undefined) {
    bindings.item = context.item;
  }
  return bindings;
}

function buildPresenceMap(value: Record<string, unknown>, knownFields: Set<string>): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const key of knownFields) {
    result[key] = Object.prototype.hasOwnProperty.call(value, key);
  }
  return result;
}

function normalizeCelValue(value: CelValue): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function isObjectWithRaw(value: unknown): value is { raw: string } {
  return typeof value === "object" && value !== null && "raw" in value && typeof (value as { raw?: unknown }).raw === "string";
}
