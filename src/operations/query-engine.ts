import { evaluateExpression, ExpressionError } from "../expressions/evaluator.js";
import { evaluateMdbaseCel } from "../expressions/cel.js";
import { BacklinkEntry } from "../expressions/evaluator.js";
import { TypeDefinition } from "../types/loader.js";

import { buildLinkIndex } from "./link-index.js";
import { IndexedReadResult, LinkResolutionResult } from "./link-index.js";
import { computeLegacyQuerySummaries, detectCircularFormulas } from "./legacy-query-support.js";

export interface QueryInput {
  types?: string[];
  where?: string | Record<string, unknown>;
  order_by?: Array<{ field: string; direction?: string }>;
  folder?: string;
  limit?: number;
  offset?: number;
  include_body?: boolean;
  context_file?: string;
  formulas?: Record<string, string>;
  group_by?: { property: string; direction?: "asc" | "desc" | "ASC" | "DESC" };
  property_summaries?: Record<string, string>;
  summaries?: Record<string, string>;
}

export interface QueryGroupResultOutput {
  key: unknown;
  results: QueryResultRowOutput[];
  summaries?: Record<string, unknown>;
}

export interface QueryResultRowOutput {
  path: string;
  file: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
  types: string[];
  body?: string | null;
  formulas?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface QueryResultOutput {
  results?: QueryResultRowOutput[];
  groups?: QueryGroupResultOutput[];
  summaries?: Record<string, unknown>;
  meta?: {
    total_count: number;
    has_more?: boolean;
  };
  error?: { code: string; message: string };
  diagnostics?: Array<Record<string, unknown>>;
}

interface QueryRow extends QueryResultRowOutput {
  _file?: Record<string, unknown>;
}

interface QueryContext {
  frontmatter: Record<string, unknown>;
  path: string;
  file?: Record<string, unknown>;
}

export interface QueryEngineDeps {
  typeDefs: Map<string, TypeDefinition>;
  scanFiles: () => Promise<string[]>;
  scanAllFiles: () => Promise<string[]>;
  read: (relativePath: string) => Promise<IndexedReadResult>;
  buildFileCache?: (files: string[]) => Promise<Map<string, IndexedReadResult>>;
  buildNonMarkdownSet: (allFiles: string[]) => Set<string>;
  resolveLink: (
    linkValue: string,
    fromPath: string,
    files: string[],
    fileCache: Map<string, IndexedReadResult>,
    nonMarkdownFiles: Set<string>,
  ) => LinkResolutionResult;
  evaluateStructuredWhere: (
    condition: Record<string, unknown>,
    frontmatter: Record<string, unknown>,
    relativePath: string,
    fileTypes: string[],
    body?: string | null,
  ) => boolean;
  useCel?: boolean;
  omitBodyWhenExcluded?: boolean;
}

export async function runQuery(
  input: QueryInput,
  deps: QueryEngineDeps,
): Promise<QueryResultOutput> {
  let thisContext: QueryContext | undefined;
  if (input.context_file) {
    const ctxResult = await deps.read(input.context_file);
    if (!ctxResult.error && ctxResult.frontmatter) {
      thisContext = {
        frontmatter: ctxResult.frontmatter,
        path: input.context_file,
        file: (ctxResult as Record<string, unknown>).file as Record<string, unknown> | undefined,
      };
    }
  }

  const files = await deps.scanFiles();
  const allFiles = await deps.scanAllFiles();
  const nonMdSet = deps.buildNonMarkdownSet(allFiles);
  const fileCache = deps.buildFileCache
    ? await deps.buildFileCache(files)
    : await buildFileCache(files, deps.read);
  let backlinksFor: ((targetPath: string) => BacklinkEntry[]) | undefined;
  const computeBacklinks = (targetPath: string): BacklinkEntry[] => {
    if (!backlinksFor) {
      const linkIndex = buildLinkIndex({
        files,
        fileCache,
        typeDefs: deps.typeDefs,
        resolveLink: (linkValue: string, fromPath: string) =>
          deps.resolveLink(linkValue, fromPath, files, fileCache, nonMdSet),
      });
      backlinksFor = linkIndex.backlinksFor;
    }
    return backlinksFor(targetPath);
  };

  let results: QueryRow[] = [];

  for (const relativePath of files) {
    const readResult = fileCache.get(relativePath);
    if (!readResult || readResult.error) continue;

    const fileTypes = readResult.types ?? [];

    if (input.types && input.types.length > 0) {
      const hasMatchingType = input.types.some((t) => fileTypes.includes(t.toLowerCase()));
      if (!hasMatchingType) continue;
    }

    if (input.folder) {
      const folder = input.folder.replace(/\/$/, "");
      if (!relativePath.startsWith(folder + "/")) continue;
    }

    let formulaValues: Record<string, unknown> | undefined;
    if (input.formulas) {
      if (results.length === 0) {
        const circularError = detectCircularFormulas(input.formulas);
        if (circularError) {
          return {
            results: [],
            error: circularError,
          };
        }
      }

      formulaValues = {};
      const fileInfo = (readResult as Record<string, unknown>).file as Record<string, unknown> | undefined;
      const resolved = new Map<string, unknown>();
      const formulaEntries = Object.entries(input.formulas);
      const maxPasses = formulaEntries.length + 1;

      for (let pass = 0; pass < maxPasses; pass++) {
        let progress = false;
        for (const [name, expr] of formulaEntries) {
          if (resolved.has(name)) continue;
          try {
            const formulaCtx = {
              frontmatter: { ...(readResult.frontmatter ?? {}), formula: Object.fromEntries(resolved) },
              rawFrontmatter: readResult.rawFrontmatter,
              path: relativePath,
              types: fileTypes,
              body: readResult.body,
              file: fileInfo,
              thisContext,
              strictArithmetic: true,
              typeDefs: deps.typeDefs as unknown as Map<string, { display_name_key?: string; [key: string]: unknown }>,
            };
            const val = evaluateExpression(expr, formulaCtx);
            resolved.set(name, val);
            progress = true;
          } catch (e: unknown) {
            if (e instanceof ExpressionError) {
              let code = e.code;
              if (code === "invalid_expression") code = "invalid_formula";
              else if (code === "type_error" || code === "unknown_function") code = "formula_evaluation_error";
              return {
                results: [],
                error: { code, message: e.message },
              };
            }
            if (pass === maxPasses - 1) {
              resolved.set(name, null);
            }
          }
        }
        if (!progress && resolved.size < formulaEntries.length) break;
        if (resolved.size === formulaEntries.length) break;
      }

      for (const [name] of formulaEntries) {
        formulaValues[name] = resolved.get(name) ?? null;
      }
    }

    const frontmatterWithFormulas = readResult.frontmatter ?? {};
    if (input.where) {
      if (typeof input.where === "string") {
        const fileInfo = (readResult as Record<string, unknown>).file as Record<string, unknown> | undefined;
        if (deps.useCel) {
          const whereResult = evaluateMdbaseCel(input.where, {
            record: { ...frontmatterWithFormulas, formula: formulaValues ?? {} },
            raw: readResult.rawFrontmatter ?? {},
            file: buildCelFileInfo(fileInfo, readResult.body, frontmatterWithFormulas),
            thisRecord: thisContext?.frontmatter,
          });
          if (whereResult.diagnostics.length > 0 || !toBoolExternal(whereResult.value)) continue;
        } else {
        const resolveFile = (linkTarget: string) => {
          const resolution = deps.resolveLink(linkTarget, relativePath, files, fileCache, nonMdSet);
          if (!resolution.resolved) return null;
          const target = fileCache.get(resolution.resolved);
          if (!target || target.error) return null;
          return {
            frontmatter: target.frontmatter ?? {},
            path: resolution.resolved,
            types: target.types ?? [],
          };
        };
        const ctx = {
          frontmatter: { ...frontmatterWithFormulas, formula: formulaValues ?? {} },
          rawFrontmatter: readResult.rawFrontmatter,
          path: relativePath,
          types: fileTypes,
          body: readResult.body,
          file: fileInfo,
          thisContext,
          resolveFile,
          computeBacklinks,
          typeDefs: deps.typeDefs as unknown as Map<string, { display_name_key?: string; [key: string]: unknown }>,
        };
        try {
          const whereResult = evaluateExpression(input.where, ctx);
          if (!toBoolExternal(whereResult)) continue;
        } catch (e: unknown) {
          if (e instanceof ExpressionError) {
            const abortCodes = new Set([
              "invalid_expression",
              "unknown_function",
              "wrong_argument_count",
              "expression_depth_exceeded",
            ]);
            if (abortCodes.has(e.code)) {
              return {
                results: [],
                error: { code: e.code, message: e.message },
              };
            }
            continue;
          }
          continue;
        }
        }
      } else {
        if (!deps.evaluateStructuredWhere(
          input.where,
          frontmatterWithFormulas,
          relativePath,
          fileTypes,
          readResult.body,
        )) continue;
      }
    }

    const fileInfo = (readResult as Record<string, unknown>).file as Record<string, unknown> | undefined;
    results.push({
      path: relativePath,
      file: fileInfo ?? { path: relativePath },
      ...(readResult.frontmatter ?? {}),
      frontmatter: readResult.frontmatter ?? {},
      types: fileTypes,
      body: readResult.body,
      _file: fileInfo,
      formulas: formulaValues,
    });
  }

  if (input.order_by) {
    sortQueryRows(results, input.order_by, deps.typeDefs, computeBacklinks);
  }

  const summarySource = [...results];
  const totalCount = results.length;

  if (input.group_by) {
    const groups = groupRows(
      results,
      input.group_by,
      input.include_body ?? false,
      !!input.formulas,
      deps.omitBodyWhenExcluded ?? false,
    );
    const grouped: QueryGroupResultOutput[] = groups.map((group) => {
      const out: QueryGroupResultOutput = {
        key: group.key,
        results: group.rows,
      };
      if (input.property_summaries && Object.keys(input.property_summaries).length > 0) {
        out.summaries = computeLegacyQuerySummaries(
          group.sourceRows,
          input.property_summaries,
          input.summaries ?? {},
        );
      }
      return out;
    });
    return {
      groups: grouped,
      diagnostics: [],
      meta: {
        total_count: totalCount,
        has_more: false,
      },
    };
  }

  if (input.offset !== undefined && input.offset > 0) {
    results = results.slice(input.offset);
  }

  let hasMore = false;
  if (input.limit !== undefined) {
    hasMore = results.length > input.limit;
    results = results.slice(0, input.limit);
  }

  let outputRows = results.map(({ _file, ...rest }) => ({
    ...rest,
    file: _file ?? rest.file ?? { path: rest.path },
  }));
  if (!input.include_body) {
    outputRows = deps.omitBodyWhenExcluded
      ? outputRows.map(({ body, ...rest }) => rest)
      : outputRows.map(({ body, ...rest }) => ({ ...rest, body: null }));
  }
  if (!input.formulas) {
    outputRows = outputRows.map(({ formulas, ...rest }) => rest);
  }

  const out: QueryResultOutput = {
    results: outputRows,
    diagnostics: [],
    meta: {
      total_count: totalCount,
      has_more: hasMore,
    },
  };

  if (input.property_summaries && Object.keys(input.property_summaries).length > 0) {
    out.summaries = computeLegacyQuerySummaries(
      summarySource,
      input.property_summaries,
      input.summaries ?? {},
    );
  }

  return out;
}

async function buildFileCache(
  files: string[],
  read: (relativePath: string) => Promise<IndexedReadResult>,
): Promise<Map<string, IndexedReadResult>> {
  const fileCache = new Map<string, IndexedReadResult>();
  for (const filePath of files) {
    const readResult = await read(filePath);
    if (!readResult.error) {
      fileCache.set(filePath, readResult);
    }
  }
  return fileCache;
}

function sortQueryRows(
  rows: QueryRow[],
  orderBy: Array<{ field: string; direction?: string }>,
  typeDefs: Map<string, TypeDefinition>,
  computeBacklinks: (targetPath: string) => BacklinkEntry[],
): void {
  const enumOrders = new Map<string, Map<string, number>>();
  for (const [, typeDef] of typeDefs) {
    if (!typeDef.fields) continue;
    for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
      if (fieldDef.values && !enumOrders.has(fieldName)) {
        const order = new Map<string, number>();
        fieldDef.values.forEach((v, i) => order.set(v, i));
        enumOrders.set(fieldName, order);
      }
    }
  }

  for (const orderSpec of [...orderBy].reverse()) {
    const field = orderSpec.field;
    const desc = orderSpec.direction === "desc";
    const enumOrder = enumOrders.get(field);

    rows.sort((a, b) => {
      const values = resolveSortValues(field, a, b, typeDefs, computeBacklinks);
      const va = values[0];
      const vb = values[1];

      if (va === vb) return 0;
      if (va === null || va === undefined) return desc ? -1 : 1;
      if (vb === null || vb === undefined) return desc ? 1 : -1;

      if (enumOrder) {
        const ia = enumOrder.get(String(va)) ?? Infinity;
        const ib = enumOrder.get(String(vb)) ?? Infinity;
        if (ia !== ib) return desc ? ib - ia : ia - ib;
        return 0;
      }

      const aIsArray = Array.isArray(va);
      const bIsArray = Array.isArray(vb);
      if (aIsArray || bIsArray) {
        const la = aIsArray ? (va as unknown[]).length : 0;
        const lb = bIsArray ? (vb as unknown[]).length : 0;
        if (la !== lb) return desc ? lb - la : la - lb;
        const pa = (a._file?.path as string | undefined) ?? a.path;
        const pb = (b._file?.path as string | undefined) ?? b.path;
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      }

      const aIsObj = typeof va === "object" && va !== null;
      const bIsObj = typeof vb === "object" && vb !== null;
      if (aIsObj || bIsObj) {
        const ka = aIsObj ? Object.keys(va as Record<string, unknown>).length : 0;
        const kb = bIsObj ? Object.keys(vb as Record<string, unknown>).length : 0;
        if (ka !== kb) return desc ? kb - ka : ka - kb;
        const pa = (a._file?.path as string | undefined) ?? a.path;
        const pb = (b._file?.path as string | undefined) ?? b.path;
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      }

      if (va < vb) return desc ? 1 : -1;
      return desc ? -1 : 1;
    });
  }
}

function resolveSortValues(
  field: string,
  a: QueryRow,
  b: QueryRow,
  typeDefs: Map<string, TypeDefinition>,
  computeBacklinks: (targetPath: string) => BacklinkEntry[],
): [unknown, unknown] {
  let va: unknown;
  let vb: unknown;

  if (field.startsWith("file.")) {
    const prop = field.slice(5);
    if (prop === "path") {
      va = a.path;
      vb = b.path;
    } else if (prop.includes(".")) {
      const backlinksCb = (fp: string) => computeBacklinks(fp);
      try {
        va = evaluateExpression(field, {
          frontmatter: a.frontmatter,
          path: a.path,
          types: a.types,
          body: a.body ?? undefined,
          file: a._file,
          computeBacklinks: backlinksCb,
          typeDefs: typeDefs as unknown as Map<string, { display_name_key?: string; [key: string]: unknown }>,
        });
      } catch {
        va = null;
      }
      try {
        vb = evaluateExpression(field, {
          frontmatter: b.frontmatter,
          path: b.path,
          types: b.types,
          body: b.body ?? undefined,
          file: b._file,
          computeBacklinks: backlinksCb,
          typeDefs: typeDefs as unknown as Map<string, { display_name_key?: string; [key: string]: unknown }>,
        });
      } catch {
        vb = null;
      }
    } else {
      va = a._file?.[prop];
      vb = b._file?.[prop];
    }
  } else if (field.startsWith("formula.")) {
    const formulaName = field.slice(8);
    va = a.formulas?.[formulaName];
    vb = b.formulas?.[formulaName];
  } else {
    va = a.frontmatter[field];
    vb = b.frontmatter[field];
  }

  return [va, vb];
}

function groupRows(
  rows: QueryRow[],
  groupBy: { property: string; direction?: "asc" | "desc" | "ASC" | "DESC" },
  includeBody: boolean,
  includeFormulas: boolean,
  omitBodyWhenExcluded: boolean,
): Array<{ key: unknown; rows: QueryResultRowOutput[]; sourceRows: QueryRow[] }> {
  const property = groupBy.property;
  const direction = (groupBy.direction ?? "ASC").toUpperCase();
  const groupsByKey = new Map<string, { key: unknown; items: QueryRow[] }>();

  for (const row of rows) {
    const key = row.frontmatter[property] ?? null;
    const keyString = key === null ? "\0null" : JSON.stringify(key);
    const existing = groupsByKey.get(keyString);
    if (existing) {
      existing.items.push(row);
    } else {
      groupsByKey.set(keyString, { key, items: [row] });
    }
  }

  const ordered = [...groupsByKey.values()].sort((a, b) => {
    const aNull = a.key === null;
    const bNull = b.key === null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    const sa = typeof a.key === "string" ? a.key : JSON.stringify(a.key);
    const sb = typeof b.key === "string" ? b.key : JSON.stringify(b.key);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  if (direction === "DESC") ordered.reverse();

  const out: Array<{ key: unknown; rows: QueryResultRowOutput[]; sourceRows: QueryRow[] }> = [];
  for (const group of ordered) {
    let groupRowsOut = group.items.map(({ _file, ...rest }) => rest);
    if (!includeBody) {
      groupRowsOut = groupRowsOut.map(({ body, ...rest }) =>
        omitBodyWhenExcluded ? rest : { ...rest, body: null },
      );
    }
    if (!includeFormulas) {
      groupRowsOut = groupRowsOut.map(({ formulas, ...rest }) => rest);
    }
    out.push({
      key: group.key,
      rows: groupRowsOut,
      sourceRows: group.items,
    });
  }
  return out;
}

function buildCelFileInfo(
  fileInfo: Record<string, unknown> | undefined,
  body: string | null | undefined,
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const tagsValue = frontmatter.tags;
  const tags = Array.isArray(tagsValue)
    ? tagsValue.map(String)
    : typeof tagsValue === "string"
      ? [tagsValue]
      : [];
  return {
    ...(fileInfo ?? {}),
    body: body ?? "",
    tags,
  };
}

function toBoolExternal(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (val === null || val === undefined) return false;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") return val !== "";
  if (Array.isArray(val)) return val.length > 0;
  return true;
}
