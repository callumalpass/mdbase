import { Ajv2020 } from "ajv/dist/2020.js";

import { evaluateMdbaseCel } from "../expressions/cel.js";
import { querySchema, viewSchema } from "../generated/v03-schemas.js";
import type { TypeDefinition } from "../types/loader.js";
import type { IndexedReadResult } from "./link-index.js";

export interface CanonicalProjection {
  expr: string;
  description?: string;
  [extension: `x-${string}`]: unknown;
}

export interface CanonicalSelectionExpression {
  name: string;
  expr: string;
  label?: string;
  description?: string;
  [extension: `x-${string}`]: unknown;
}

export interface CanonicalQueryInput {
  types?: string[];
  context?: { this: { path: string } };
  projections?: Record<string, CanonicalProjection>;
  where?: string;
  select?: Array<string | CanonicalSelectionExpression>;
  order_by?: Array<{ field: string; direction?: "asc" | "desc" }>;
  group_by?: Array<{ field: string; direction?: "asc" | "desc" }>;
  summary_functions?: Record<string, { expr: string; description?: string }>;
  summaries?: Array<{ field: string; function: string; name?: string; label?: string }>;
  limit?: number;
  offset?: number;
  include_body?: boolean;
  frontmatter?: "effective" | "raw" | "both";
  [extension: `x-${string}`]: unknown;
}

export interface ExecuteViewInput {
  path: string;
  view: string;
  context?: { path: string } | null;
  limit?: number;
  offset?: number;
  render?: boolean;
}

export interface CanonicalDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
  field?: string;
  details?: unknown;
}

export interface CanonicalQueryRow {
  path?: string;
  file: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
  raw_frontmatter?: Record<string, unknown>;
  values?: Record<string, unknown>;
  body?: string;
}

export interface CanonicalQueryResult {
  results: CanonicalQueryRow[];
  meta: {
    total_count: number;
    has_more: boolean;
    context?: { path: string };
    view?: { path: string; id: string };
    groups?: Array<{
      values: Record<string, unknown>;
      count: number;
      summaries: Record<string, unknown>;
    }>;
  };
  diagnostics: CanonicalDiagnostic[];
  error?: { code: string; message: string };
}

export interface CanonicalQueryDeps {
  typeDefs: Map<string, TypeDefinition>;
  scanFiles: () => Promise<string[]>;
  read: (relativePath: string) => Promise<IndexedReadResult>;
  buildFileCache?: (files: string[]) => Promise<Map<string, IndexedReadResult>>;
}

export interface CanonicalViewDeps {
  scanFiles: () => Promise<string[]>;
  read: (relativePath: string) => Promise<IndexedReadResult>;
  executeQuery: (input: CanonicalQueryInput) => Promise<CanonicalQueryResult>;
}

interface ContextRecord {
  path: string;
  effective: Record<string, unknown>;
  raw: Record<string, unknown>;
  file: Record<string, unknown>;
  types: string[];
  binding: Record<string, unknown>;
}

interface CandidateRow {
  path: string;
  effective: Record<string, unknown>;
  raw: Record<string, unknown>;
  file: Record<string, unknown>;
  types: string[];
  body: string;
  projection: Record<string, unknown>;
  knownFields: string[];
  values?: Record<string, unknown>;
}

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
const validateQuery = ajv.compile(querySchema);
const validateView = ajv.compile(viewSchema);

export function validateCanonicalQueryInput(input: unknown): CanonicalDiagnostic[] {
  if (validateQuery(input)) return [];
  return [{
    severity: "error",
    code: "invalid_query",
    message: formatSchemaErrors(validateQuery.errors),
  }];
}

export function validateCanonicalViewRecord(
  frontmatter: unknown,
  path?: string,
): CanonicalDiagnostic[] {
  if (validateView(frontmatter)) return [];
  return [{
    severity: "error",
    code: "invalid_view",
    message: formatSchemaErrors(validateView.errors),
    ...(path ? { path } : {}),
  }];
}

/** Resolve and execute an ordinary `type: view` Markdown record. */
export async function executeCanonicalView(
  input: ExecuteViewInput,
  deps: CanonicalViewDeps,
): Promise<CanonicalQueryResult> {
  const resolved = await resolveViewRecord(input.path, deps);
  if (!resolved) {
    return failedView("view_not_found", `View record "${input.path}" was not found`);
  }

  const { path: viewPath, read } = resolved;
  const viewRecord = read.frontmatter ?? {};
  const schemaDiagnostics = validateCanonicalViewRecord(viewRecord, viewPath);
  if (schemaDiagnostics.length > 0) {
    return failedView("invalid_view", schemaDiagnostics[0].message, schemaDiagnostics);
  }

  const views = viewRecord.views as Array<Record<string, unknown>>;
  const ids = views.map((view) => String(view.id));
  if (new Set(ids).size !== ids.length) {
    return failedView(
      "invalid_view",
      `View record "${viewPath}" contains duplicate named-view IDs`,
    );
  }

  const namedView = views.find((view) => view.id === input.view);
  if (!namedView) {
    return failedView(
      "view_not_found",
      `Named view "${input.view}" was not found in "${viewPath}"`,
    );
  }

  if (input.render === true && namedView.presentation) {
    return failedView(
      "unsupported_presentation",
      "The collection library provides headless execution only",
    );
  }

  const sharedQuery = objectValue(viewRecord.query);
  const sharedProjections = objectValue(sharedQuery.projections);
  const localProjections = objectValue(namedView.projections);
  for (const name of Object.keys(sharedProjections)) {
    if (
      Object.prototype.hasOwnProperty.call(localProjections, name) &&
      canonicalJson(sharedProjections[name]) !== canonicalJson(localProjections[name])
    ) {
      return failedView(
        "invalid_view",
        `Projection "${name}" has conflicting shared and named-view definitions`,
      );
    }
  }

  const contextDeclaration = objectValue(
    Object.prototype.hasOwnProperty.call(namedView, "context")
      ? namedView.context
      : sharedQuery.context,
  );
  const thisDeclaration = objectValue(contextDeclaration.this);
  const contextPath = resolveContextPath(input, viewPath, thisDeclaration);
  if (contextPath.error) return contextPath.error;

  if (contextPath.path && Array.isArray(thisDeclaration.types)) {
    const contextRead = await deps.read(contextPath.path);
    if (contextRead.error) {
      return failedView(
        "context_not_found",
        `Invocation context "${contextPath.path}" was not found`,
      );
    }
    const required = thisDeclaration.types.map(String).map((type) => type.toLowerCase());
    const actual = contextRead.types ?? [];
    if (!required.some((type) => actual.includes(type))) {
      return failedView(
        "context_type_mismatch",
        `Invocation context "${contextPath.path}" does not match an allowed context type`,
      );
    }
  }

  const query = buildViewQuery(
    input,
    viewRecord,
    sharedQuery,
    namedView,
    sharedProjections,
    localProjections,
    contextPath.path,
  );
  const result = await deps.executeQuery(query);
  result.meta.view = { path: viewPath, id: input.view };
  return result;
}

async function resolveViewRecord(
  identifier: string,
  deps: Pick<CanonicalViewDeps, "read" | "scanFiles">,
): Promise<{ path: string; read: IndexedReadResult } | undefined> {
  const direct = await deps.read(identifier);
  if (!direct.error && direct.frontmatter?.type === "view") {
    return { path: identifier, read: direct };
  }
  for (const candidate of await deps.scanFiles()) {
    const read = await deps.read(candidate);
    if (!read.error && read.frontmatter?.type === "view" && read.frontmatter.id === identifier) {
      return { path: candidate, read };
    }
  }
  return undefined;
}

function resolveContextPath(
  input: ExecuteViewInput,
  viewPath: string,
  declaration: Record<string, unknown>,
): { path?: string; error?: CanonicalQueryResult } {
  if (input.context && typeof input.context.path === "string") {
    return { path: input.context.path };
  }

  const onMissing = typeof declaration.on_missing === "string" ? declaration.on_missing : "view";
  if (onMissing === "error") {
    return {
      error: failedView(
        "context_required",
        `Named view "${input.view}" requires an invocation context`,
      ),
    };
  }
  return onMissing === "view" ? { path: viewPath } : {};
}

function buildViewQuery(
  input: ExecuteViewInput,
  viewRecord: Record<string, unknown>,
  sharedQuery: Record<string, unknown>,
  namedView: Record<string, unknown>,
  sharedProjections: Record<string, unknown>,
  localProjections: Record<string, unknown>,
  contextPath?: string,
): CanonicalQueryInput {
  const sharedWhere = typeof sharedQuery.where === "string" ? sharedQuery.where : undefined;
  const localWhere = typeof namedView.where === "string" ? namedView.where : undefined;
  return {
    ...(Array.isArray(namedView.types)
      ? { types: namedView.types.map(String) }
      : Array.isArray(sharedQuery.types)
        ? { types: sharedQuery.types.map(String) }
        : {}),
    ...(contextPath ? { context: { this: { path: contextPath } } } : {}),
    ...((Object.keys(sharedProjections).length > 0 || Object.keys(localProjections).length > 0)
      ? { projections: { ...sharedProjections, ...localProjections } as CanonicalQueryInput["projections"] }
      : {}),
    ...(sharedWhere && localWhere
      ? { where: `(${sharedWhere}) && (${localWhere})` }
      : sharedWhere || localWhere
        ? { where: sharedWhere ?? localWhere }
        : {}),
    ...(Array.isArray(namedView.select) ? { select: namedView.select as CanonicalQueryInput["select"] } : {}),
    ...(Array.isArray(namedView.order_by) ? { order_by: namedView.order_by as CanonicalQueryInput["order_by"] } : {}),
    ...(Array.isArray(namedView.group_by) ? { group_by: namedView.group_by as CanonicalQueryInput["group_by"] } : {}),
    ...(Object.keys(objectValue(viewRecord.summary_functions)).length > 0
      ? { summary_functions: objectValue(viewRecord.summary_functions) as CanonicalQueryInput["summary_functions"] }
      : {}),
    ...(Array.isArray(namedView.summaries) ? { summaries: namedView.summaries as CanonicalQueryInput["summaries"] } : {}),
    ...(typeof namedView.limit === "number" ? { limit: namedView.limit } : {}),
    ...(typeof namedView.offset === "number" ? { offset: namedView.offset } : {}),
    ...(typeof namedView.include_body === "boolean" ? { include_body: namedView.include_body } : {}),
    ...(typeof namedView.frontmatter === "string"
      ? { frontmatter: namedView.frontmatter as CanonicalQueryInput["frontmatter"] }
      : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
  };
}

export async function executeCanonicalQuery(
  input: CanonicalQueryInput,
  deps: CanonicalQueryDeps,
): Promise<CanonicalQueryResult> {
  const schemaDiagnostics = validateCanonicalQueryInput(input);
  if (schemaDiagnostics.length > 0) return failedQuery(schemaDiagnostics);

  const selectionError = validateSelectionNames(input.select);
  if (selectionError) return failedQuery([selectionError]);

  const projectionOrder = orderProjectionNames(input.projections ?? {});
  if (projectionOrder.error) return failedQuery([projectionOrder.error]);

  const summaryNameError = validateSummaryNames(input.summaries);
  if (summaryNameError) return failedQuery([summaryNameError]);

  const context = input.context
    ? await readContext(input.context.this.path, deps)
    : undefined;
  if (context && "diagnostic" in context) return failedQuery([context.diagnostic]);
  const contextRecord = context as ContextRecord | undefined;

  const files = await deps.scanFiles();
  const fileCache = deps.buildFileCache
    ? await deps.buildFileCache(files)
    : await buildFileCache(files, deps.read);
  const diagnostics: CanonicalDiagnostic[] = [];
  const candidates: CandidateRow[] = [];

  for (const relativePath of files) {
    const readResult = fileCache.get(relativePath);
    if (!readResult || readResult.error) continue;
    const types = readResult.types ?? [];
    if (input.types && !input.types.some((type) => types.includes(type.toLowerCase()))) continue;

    const effective = readResult.frontmatter ?? {};
    const raw = readResult.rawFrontmatter ?? effective;
    const knownFields = getKnownFieldNames(types, deps.typeDefs, effective, raw);
    const file = buildFileBinding(
      (readResult as Record<string, unknown>).file as Record<string, unknown> | undefined,
      relativePath,
      readResult.body,
      effective,
    );
    const projection: Record<string, unknown> = {};

    for (const name of projectionOrder.names) {
      const definition = input.projections![name];
      const evaluated = evaluateMdbaseCel(definition.expr, {
        record: effective,
        raw,
        knownFields,
        file,
        thisRecord: contextRecord?.binding ?? null,
        projection,
      });
      projection[name] = evaluated.value;
      for (const diagnostic of evaluated.diagnostics) {
        diagnostics.push({
          severity: "warning",
          code: diagnostic.code,
          message: `Projection "${name}": ${diagnostic.message}`,
          path: relativePath,
          field: `projection.${name}`,
        });
      }
    }

    if (input.where) {
      const evaluated = evaluateMdbaseCel(input.where, {
        record: effective,
        raw,
        knownFields,
        file,
        thisRecord: contextRecord?.binding ?? null,
        projection,
      });
      if (evaluated.diagnostics.length > 0 || evaluated.value !== true) {
        for (const diagnostic of evaluated.diagnostics) {
          diagnostics.push({
            severity: "warning",
            code: diagnostic.code,
            message: diagnostic.message,
            path: relativePath,
            field: "where",
          });
        }
        continue;
      }
    }

    const row: CandidateRow = {
      path: relativePath,
      effective,
      raw,
      file,
      types,
      body: readResult.body ?? "",
      projection,
      knownFields,
    };
    if (input.select) {
      row.values = evaluateSelection(input.select, row, contextRecord, diagnostics);
    }
    candidates.push(row);
  }

  if (input.order_by) {
    candidates.sort((left, right) => compareRows(left, right, input.order_by!));
  } else {
    candidates.sort((left, right) => left.path.localeCompare(right.path));
  }

  const totalCount = candidates.length;
  const groups = input.group_by || input.summaries
    ? buildGroups(candidates, input, contextRecord, diagnostics)
    : undefined;
  const offset = input.offset ?? 0;
  const end = input.limit === undefined ? candidates.length : offset + input.limit;
  const page = candidates.slice(offset, end);
  const results = page.map((row) => serializeRow(row, input));

  return {
    results,
    meta: {
      total_count: totalCount,
      has_more: offset + results.length < totalCount,
      ...(contextRecord ? { context: { path: contextRecord.path } } : {}),
      ...(groups ? { groups } : {}),
    },
    diagnostics,
  };
}

function failedQuery(diagnostics: CanonicalDiagnostic[]): CanonicalQueryResult {
  const first = diagnostics[0] ?? {
    severity: "error" as const,
    code: "invalid_query",
    message: "Invalid query",
  };
  return {
    results: [],
    meta: { total_count: 0, has_more: false },
    diagnostics,
    error: { code: first.code, message: first.message },
  };
}

function failedView(
  code: string,
  message: string,
  diagnostics?: CanonicalDiagnostic[],
): CanonicalQueryResult {
  return {
    results: [],
    meta: { total_count: 0, has_more: false },
    diagnostics: diagnostics ?? [{ severity: "error", code, message }],
    error: { code, message },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readContext(
  path: string,
  deps: CanonicalQueryDeps,
): Promise<ContextRecord | { diagnostic: CanonicalDiagnostic }> {
  const read = await deps.read(path);
  if (read.error || !read.frontmatter) {
    return {
      diagnostic: {
        severity: "error",
        code: "context_not_found",
        message: `Invocation context "${path}" was not found`,
        path,
      },
    };
  }
  const effective = read.frontmatter;
  const raw = read.rawFrontmatter ?? effective;
  const types = read.types ?? [];
  const file = buildFileBinding(
    (read as Record<string, unknown>).file as Record<string, unknown> | undefined,
    path,
    read.body,
    effective,
  );
  const known = new Set(getKnownFieldNames(types, deps.typeDefs, effective, raw));
  const binding = {
    ...Object.fromEntries(
      [...known]
        .filter((field) => !Object.prototype.hasOwnProperty.call(effective, field))
        .map((field) => [field, null]),
    ),
    ...effective,
    record: effective,
    note: effective,
    raw,
    present: {
      record: presenceMap(effective, known),
      raw: presenceMap(raw, known),
    },
    file,
  };
  return { path, effective, raw, file, types, binding };
}

function getKnownFieldNames(
  types: string[],
  typeDefs: Map<string, TypeDefinition>,
  effective: Record<string, unknown>,
  raw: Record<string, unknown>,
): string[] {
  const fields = new Set([...Object.keys(effective), ...Object.keys(raw)]);
  for (const typeName of types) {
    const typeDef = typeDefs.get(typeName) ?? typeDefs.get(typeName.toLowerCase());
    for (const name of Object.keys(typeDef?.fields ?? {})) fields.add(name);
    const properties = typeDef?.schema?.value?.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const name of Object.keys(properties)) fields.add(name);
    }
    for (const name of Object.keys(typeDef?.collection?.read_defaults ?? {})) fields.add(name);
    for (const name of Object.keys(typeDef?.collection?.projections ?? {})) fields.add(name);
  }
  return [...fields];
}

function buildFileBinding(
  file: Record<string, unknown> | undefined,
  path: string,
  body: string | null | undefined,
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const tagsValue = frontmatter.tags;
  const tags = Array.isArray(tagsValue)
    ? tagsValue.map(String)
    : typeof tagsValue === "string" ? [tagsValue] : [];
  return { ...(file ?? {}), path, body: body ?? "", tags };
}

function presenceMap(
  value: Record<string, unknown>,
  keys: Set<string>,
): Record<string, boolean> {
  return Object.fromEntries([...keys].map((key) => [
    key,
    Object.prototype.hasOwnProperty.call(value, key),
  ]));
}

function orderProjectionNames(
  projections: Record<string, CanonicalProjection>,
): { names: string[]; error?: CanonicalDiagnostic } {
  const names = Object.keys(projections);
  const nameSet = new Set(names);
  const dependencies = new Map<string, Set<string>>();
  for (const [name, definition] of Object.entries(projections)) {
    const refs = new Set<string>();
    for (const match of definition.expr.matchAll(/\bprojection\.([A-Za-z_][A-Za-z0-9_:-]*)\b/g)) {
      if (nameSet.has(match[1])) refs.add(match[1]);
    }
    dependencies.set(name, refs);
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): boolean => {
    if (visiting.has(name)) return false;
    if (visited.has(name)) return true;
    visiting.add(name);
    for (const dependency of dependencies.get(name) ?? []) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
    return true;
  };
  for (const name of names) {
    if (!visit(name)) {
      return {
        names: [],
        error: {
          severity: "error",
          code: "invalid_query",
          message: "Named projections contain a direct or indirect cycle",
          field: "projections",
        },
      };
    }
  }
  return { names: ordered };
}

function validateSelectionNames(
  select: CanonicalQueryInput["select"],
): CanonicalDiagnostic | undefined {
  if (!select) return undefined;
  const names = select.map(selectionName);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  return duplicate ? {
    severity: "error",
    code: "invalid_query",
    message: `Selection output name "${duplicate}" is duplicated`,
    field: "select",
  } : undefined;
}

function validateSummaryNames(
  summaries: CanonicalQueryInput["summaries"],
): CanonicalDiagnostic | undefined {
  if (!summaries) return undefined;
  const names = summaries.map((summary) => summary.name ?? summary.function);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  return duplicate ? {
    severity: "error",
    code: "invalid_query",
    message: `Summary result name "${duplicate}" is duplicated`,
    field: "summaries",
  } : undefined;
}

function selectionName(selection: string | CanonicalSelectionExpression): string {
  if (typeof selection !== "string") return selection.name;
  const members = selection.split(".");
  return members[members.length - 1];
}

function evaluateSelection(
  select: NonNullable<CanonicalQueryInput["select"]>,
  row: CandidateRow,
  context: ContextRecord | undefined,
  diagnostics: CanonicalDiagnostic[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of select) {
    const name = selectionName(selection);
    if (typeof selection === "string") {
      result[name] = resolveValue(selection, row);
      continue;
    }
    const evaluated = evaluateMdbaseCel(selection.expr, {
      record: row.effective,
      raw: row.raw,
      knownFields: row.knownFields,
      file: row.file,
      thisRecord: context?.binding ?? null,
      projection: row.projection,
    });
    result[name] = evaluated.value;
    for (const diagnostic of evaluated.diagnostics) {
      diagnostics.push({
        severity: "warning",
        code: diagnostic.code,
        message: `Selection "${name}": ${diagnostic.message}`,
        path: row.path,
        field: `select.${name}`,
      });
    }
  }
  return result;
}

function resolveValue(field: string, row: CandidateRow): unknown {
  if (field.startsWith("file.")) return getPath(row.file, field.slice(5));
  if (field.startsWith("projection.")) return getPath(row.projection, field.slice(11));
  if (row.values && Object.prototype.hasOwnProperty.call(row.values, field)) return row.values[field];
  return getPath(row.effective, field);
}

function getPath(object: Record<string, unknown>, path: string): unknown {
  let value: unknown = object;
  for (const member of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[member];
  }
  return value ?? null;
}

function compareRows(
  left: CandidateRow,
  right: CandidateRow,
  orderBy: NonNullable<CanonicalQueryInput["order_by"]>,
): number {
  for (const order of orderBy) {
    const direction = order.direction === "desc" ? -1 : 1;
    const compared = compareValues(resolveValue(order.field, left), resolveValue(order.field, right));
    if (compared !== 0) return compared * direction;
  }
  return left.path.localeCompare(right.path);
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (Array.isArray(left) ? left.length : 0) - (Array.isArray(right) ? right.length : 0);
  }
  if (isObject(left) || isObject(right)) {
    return (isObject(left) ? Object.keys(left).length : 0) - (isObject(right) ? Object.keys(right).length : 0);
  }
  return String(left).localeCompare(String(right));
}

function buildGroups(
  rows: CandidateRow[],
  input: CanonicalQueryInput,
  context: ContextRecord | undefined,
  diagnostics: CanonicalDiagnostic[],
): NonNullable<CanonicalQueryResult["meta"]["groups"]> {
  const groupBy = input.group_by ?? [];
  const buckets = new Map<string, { values: Record<string, unknown>; rows: CandidateRow[] }>();
  for (const row of rows) {
    const values = Object.fromEntries(groupBy.map((group) => [
      selectionName(group.field),
      resolveValue(group.field, row),
    ]));
    const key = JSON.stringify(Object.values(values));
    const bucket = buckets.get(key);
    if (bucket) bucket.rows.push(row);
    else buckets.set(key, { values, rows: [row] });
  }
  if (rows.length === 0 && groupBy.length === 0) {
    buckets.set("[]", { values: {}, rows: [] });
  }
  const groups = [...buckets.values()];
  groups.sort((left, right) => {
    for (const group of groupBy) {
      const name = selectionName(group.field);
      const compared = compareValues(left.values[name], right.values[name]);
      if (compared !== 0) return compared * (group.direction === "desc" ? -1 : 1);
    }
    return 0;
  });
  return groups.map((group) => ({
    values: group.values,
    count: group.rows.length,
    summaries: evaluateSummaries(group.rows, input, context, diagnostics),
  }));
}

function evaluateSummaries(
  rows: CandidateRow[],
  input: CanonicalQueryInput,
  context: ContextRecord | undefined,
  diagnostics: CanonicalDiagnostic[],
): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const summary of input.summaries ?? []) {
    const name = summary.name ?? summary.function;
    const values = rows.map((row) => resolveValue(summary.field, row));
    if (input.summary_functions?.[summary.function]) {
      const evaluated = evaluateMdbaseCel(input.summary_functions[summary.function].expr, {
        thisRecord: context?.binding ?? null,
        values,
      });
      results[name] = evaluated.value;
      for (const diagnostic of evaluated.diagnostics) {
        diagnostics.push({
          severity: "warning",
          code: diagnostic.code,
          message: `Summary "${name}": ${diagnostic.message}`,
          field: `summaries.${name}`,
        });
      }
    } else {
      results[name] = builtInSummary(summary.function, values, diagnostics, name);
    }
  }
  return results;
}

function builtInSummary(
  functionName: string,
  values: unknown[],
  diagnostics: CanonicalDiagnostic[],
  name: string,
): unknown {
  if (functionName === "count") return values.length;
  if (functionName === "empty") return values.filter(isEmptyValue).length;
  if (functionName === "filled") return values.filter((value) => !isEmptyValue(value)).length;
  const populated = values.filter((value) => value !== null && value !== undefined);
  if (populated.length === 0) return null;
  if (functionName === "sum" || functionName === "average") {
    if (!populated.every((value) => typeof value === "number")) {
      diagnostics.push({
        severity: "warning",
        code: "expression_evaluation_error",
        message: `Summary "${name}" received an incompatible non-number value`,
        field: `summaries.${name}`,
      });
      return null;
    }
    const sum = (populated as number[]).reduce((total, value) => total + value, 0);
    return functionName === "average" ? sum / populated.length : sum;
  }
  if (["minimum", "earliest"].includes(functionName)) {
    return populated.reduce((best, value) => compareValues(value, best) < 0 ? value : best);
  }
  if (["maximum", "latest"].includes(functionName)) {
    return populated.reduce((best, value) => compareValues(value, best) > 0 ? value : best);
  }
  diagnostics.push({
    severity: "warning",
    code: "expression_evaluation_error",
    message: `Unknown summary function "${functionName}"`,
    field: `summaries.${name}`,
  });
  return null;
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isObject(value) && Object.keys(value).length === 0);
}

function serializeRow(row: CandidateRow, input: CanonicalQueryInput): CanonicalQueryRow {
  const frontmatterMode = input.frontmatter ?? "effective";
  return {
    path: row.path,
    file: row.file,
    frontmatter: frontmatterMode === "raw" ? row.raw : row.effective,
    ...(frontmatterMode === "both" ? { raw_frontmatter: row.raw } : {}),
    ...(row.values ? { values: row.values } : {}),
    ...(input.include_body ? { body: row.body } : {}),
  };
}

async function buildFileCache(
  files: string[],
  read: CanonicalQueryDeps["read"],
): Promise<Map<string, IndexedReadResult>> {
  const cache = new Map<string, IndexedReadResult>();
  for (const file of files) {
    const result = await read(file);
    if (!result.error) cache.set(file, result);
  }
  return cache;
}

function formatSchemaErrors(errors: typeof validateQuery.errors): string {
  if (!errors || errors.length === 0) return "Schema validation failed";
  return errors.map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message ?? error.keyword}`;
  }).join("; ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
