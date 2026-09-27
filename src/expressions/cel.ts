import { Environment, serialize } from "@marcbachmann/cel-js";
import { rewriteLinkProvenance, type CelNode } from "./link-provenance.js";

import { extractBodyLinks, extractBodyTags } from "../links/parser.js";

export interface MdbaseCelDiagnostic {
  code: string;
  message: string;
  expression: string;
}

/** Resolves link values for `asFile()`, `hasLink()`, and `file.backlinks`. */
export interface MdbaseCelLinks {
  resolve(link: string, fromPath: string): MdbaseCelLinkedRecord | null;
  backlinks(path: string): string[];
}

export interface MdbaseCelLinkedRecord {
  path: string;
  record: Record<string, unknown>;
  raw: Record<string, unknown>;
  body: string;
  declaredLinkSelectors?: string[];
}

export interface MdbaseCelContext {
  record?: Record<string, unknown>;
  raw?: Record<string, unknown>;
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
  temporal?: MdbaseCelTemporalContext;
  /** Top-level fields that every matched schema declares `format: date-time`. */
  dateTimeFields?: Iterable<string>;
  /** Link selectors declared in `collection.links` by the matched types. */
  declaredLinkSelectors?: string[];
  links?: MdbaseCelLinks;
}

export interface MdbaseCelTemporalContext {
  now: Date;
  timezone: string;
}

export interface MdbaseCelResult {
  value: unknown;
  diagnostics: MdbaseCelDiagnostic[];
}

/** System names a frontmatter field never shadows (spec Chapter 10). */
export const MDBASE_CEL_RESERVED_NAMES = new Set([
  "record",
  "raw",
  "file",
  "projection",
  "this",
  "values",
  "old",
  "operation",
  "event",
  "workflow",
  "trigger",
  "steps",
  "vars",
  "item",
]);

const MACROS = new Set(["all", "exists", "exists_one", "map", "filter"]);
const BODY_FACTS = new Set(["tags", "links", "embeds", "backlinks"]);
const MAX_LINK_TRAVERSALS = 10_000;

export const MDBASE_CEL_PROGRAM_CACHE_LIMIT = 512;

interface AstNode {
  op: string;
  args: unknown;
}

/** Static facts about an expression that hosts use to plan evaluation. */
export interface MdbaseCelFacts {
  freeIdentifiers: Set<string>;
  projectionReferences: Set<string>;
  needsBodyFacts: boolean;
  needsLinkGraph: boolean;
}

interface CompiledProgram {
  run: (bindings: Record<string, unknown>) => unknown;
  facts: MdbaseCelFacts;
}

interface EvaluationHost {
  now: Date;
  timezone: string;
  links?: MdbaseCelLinks;
  source: string;
  needsFacts: boolean;
  traversals: number;
}

// Host functions read the active evaluation. Evaluation is synchronous, so a
// module-level slot scoped by evaluateMdbaseCel is sufficient.
let active: EvaluationHost | undefined;

function host(): EvaluationHost {
  if (!active) throw new Error("no CEL evaluation is active");
  return active;
}

const environment = new Environment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
  homogeneousAggregateLiterals: false,
  limits: { maxDepth: 250 },
})
  .registerFunction("now(): google.protobuf.Timestamp", () => new Date(host().now.getTime()))
  .registerFunction("today(): string", () => dateOf(host().now, host().timezone))
  .registerFunction("date(string): string", (value: string) => (parseFullDate(value), value))
  .registerFunction("date(google.protobuf.Timestamp): string", (value: Date) =>
    dateOf(value, host().timezone))
  .registerFunction("startOfDay(string): google.protobuf.Timestamp", (value: string) =>
    startOfDay(value, host().timezone))
  .registerFunction("string.addDays(int): string", (value: string, days: bigint) =>
    addDays(value, Number(days)))
  .registerFunction("string.addMonths(int): string", (value: string, months: bigint) =>
    addMonths(value, Number(months)))
  .registerFunction("string.addYears(int): string", (value: string, years: bigint) =>
    addMonths(value, Number(years) * 12))
  .registerFunction("string.daysUntil(string): int", (value: string, other: string) =>
    BigInt(epochDay(parseFullDate(other)) - epochDay(parseFullDate(value))))
  .registerFunction("string.year(): int", (value: string) => BigInt(parseFullDate(value).year))
  .registerFunction("string.month(): int", (value: string) => BigInt(parseFullDate(value).month))
  .registerFunction("string.day(): int", (value: string) => BigInt(parseFullDate(value).day))
  .registerFunction("string.dayOfWeek(): int", (value: string) => {
    const weekday = new Date(epochDay(parseFullDate(value)) * 86_400_000).getUTCDay();
    return BigInt(weekday === 0 ? 7 : weekday);
  })
  // Unicode default full case mappings, without locale tailoring.
  .registerFunction("string.lower(): string", (value: string) => value.toLowerCase())
  .registerFunction("string.upper(): string", (value: string) => value.toUpperCase())
  .registerFunction("map.inFolder(string): bool", (file: Record<string, unknown>, folder: string) => {
    const actual = typeof file.folder === "string" ? file.folder : "";
    const wanted = folder.replace(/^\/+|\/+$/g, "");
    return actual === wanted || actual.startsWith(`${wanted}/`);
  })
  .registerFunction("map.hasTag(string): bool", (file: Record<string, unknown>, tag: string) => {
    const wanted = tag.replace(/^#/, "");
    return strings(file.tags).some((existing) => existing === wanted || existing.startsWith(`${wanted}/`));
  })
  .registerFunction("map.hasLink(string): bool", (file: Record<string, unknown>, link: string) =>
    hasLink(file, link, typeof file.path === "string" ? file.path : ""))
  // Internal overloads that link provenance rewriting produces (see
  // link-provenance.ts): the link was read from the record at `sourcePath`.
  .registerFunction("map.hasLink(string, string): bool", (file: Record<string, unknown>, link: string, sourcePath: string) =>
    hasLink(file, link, sourcePath))
  .registerFunction("map.asLink(): string", (file: Record<string, unknown>) => {
    if (typeof file.path !== "string") throw new Error("the value has no path");
    return `[[${file.path}]]`;
  })
  .registerFunction("link(string): string", (value: string) => value)
  .registerFunction("string.asFile(): dyn", (link: string) => asFile(link, host().source))
  .registerFunction("string.asFile(string): dyn", (link: string, sourcePath: string) => asFile(link, sourcePath));

/** Whether `file` links to `link`, which was read from the record at `linkSource`. */
function hasLink(file: Record<string, unknown>, link: string, linkSource: string): boolean {
  const source = typeof file.path === "string" ? file.path : "";
  const links = host().links;
  const wanted = links?.resolve(link, linkSource)?.path;
  return strings(file.links).some((candidate) => {
    const actual = links?.resolve(candidate, source)?.path;
    return wanted !== undefined && actual !== undefined
      ? wanted === actual
      : linkTarget(candidate) === linkTarget(link);
  });
}

/** Resolve a link read from the record at `sourcePath` to its target record. */
function asFile(link: string, sourcePath: string): unknown {
  const current = host();
  current.traversals += 1;
  if (current.traversals > MAX_LINK_TRAVERSALS) {
    throw new Error(`link traversal limit of ${MAX_LINK_TRAVERSALS} exceeded`);
  }
  const target = current.links?.resolve(link, sourcePath);
  if (!target) return null;
  const file = fileValue(target.path, target.record, target.body, target.declaredLinkSelectors ?? [], {});
  return recordValue(target.record, target.raw, file);
}

const programCache = new Map<string, CompiledProgram>();

function compileMdbaseCel(expression: string): CompiledProgram {
  const cached = programCache.get(expression);
  if (cached) {
    // Refresh insertion order so the bounded map behaves as an LRU cache.
    programCache.delete(expression);
    programCache.set(expression, cached);
    return cached;
  }
  const parsed = environment.parse(expression);
  const provenance = rewriteLinkProvenance(parsed.ast as unknown as CelNode);
  const executable = provenance ? environment.parse(serialize(provenance as never)) : parsed;
  const compiled: CompiledProgram = {
    run: (bindings) => executable(bindings),
    facts: analyze(parsed.ast as AstNode),
  };
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

/** Static facts about an expression, or throw its parse error. */
export function mdbaseCelFacts(expression: string): MdbaseCelFacts {
  return compileMdbaseCel(expression).facts;
}

export function evaluateMdbaseCel(expression: string, context: MdbaseCelContext): MdbaseCelResult {
  let program: CompiledProgram;
  try {
    program = compileMdbaseCel(expression);
  } catch (error) {
    return {
      value: null,
      diagnostics: [{ code: "expression_compile_error", message: messageOf(error), expression }],
    };
  }
  const previous = active;
  active = {
    now: context.temporal?.now ?? new Date(),
    timezone: context.temporal?.timezone ?? "UTC",
    links: context.links,
    source: typeof context.file?.path === "string" ? context.file.path : "",
    needsFacts: program.facts.needsBodyFacts,
    traversals: 0,
  };
  try {
    const value = program.run(withMissingFieldsAsNull(buildMdbaseCelBindings(context), context));
    return { value: normalizeCelValue(value), diagnostics: [] };
  } catch (error) {
    // Chapter 10: a top-level evaluation error yields null plus a diagnostic;
    // the embedding context decides what that means.
    return {
      value: null,
      diagnostics: [{ code: "expression_evaluation_error", message: messageOf(error), expression }],
    };
  } finally {
    active = previous;
  }
}

/** Parse a CEL expression without evaluating it against an arbitrary record. */
export function validateMdbaseCelSyntax(expression: string): MdbaseCelDiagnostic[] {
  try {
    compileMdbaseCel(expression);
    return [];
  } catch (error) {
    return [{ code: "expression_parse_error", message: messageOf(error), expression }];
  }
}

/** Return named-projection references from the parsed CEL syntax tree. */
export function collectMdbaseCelProjectionReferences(expression: string): Set<string> {
  return new Set(compileMdbaseCel(expression).facts.projectionReferences);
}

export function buildMdbaseCelBindings(context: MdbaseCelContext): Record<string, unknown> {
  const dateTimes = new Set(context.dateTimeFields ?? []);
  const record = typeFields(context.record ?? {}, dateTimes);
  const raw = typeFields(context.raw ?? context.record ?? {}, dateTimes);
  const bindings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!MDBASE_CEL_RESERVED_NAMES.has(key)) bindings[key] = value;
  }
  Object.assign(bindings, {
    record,
    raw,
    old: context.old ?? {},
    event: context.event ?? {},
    steps: context.steps ?? {},
    vars: context.vars ?? {},
    operation: context.operation ?? {},
    projection: context.projection ?? {},
    values: context.values ?? [],
    this: context.thisRecord ?? null,
  });
  if (context.file) {
    const path = typeof context.file.path === "string" ? context.file.path : "";
    const body = typeof context.file.body === "string" ? context.file.body : "";
    bindings.file = fileValue(path, context.record ?? {}, body, context.declaredLinkSelectors ?? [], context.file);
  }
  if (context.item !== undefined) bindings.item = context.item;
  return bindings;
}

/**
 * An unreserved top-level identifier naming a missing record field is null;
 * map selection keeps CEL's no-such-key behavior (spec Chapter 10).
 */
function withMissingFieldsAsNull(
  bindings: Record<string, unknown>,
  context: MdbaseCelContext,
): Record<string, unknown> {
  if (!context.record) return bindings;
  return new Proxy(bindings, {
    get(target, key) {
      if (typeof key !== "string" || Object.prototype.hasOwnProperty.call(target, key)) {
        return Reflect.get(target, key);
      }
      return MDBASE_CEL_RESERVED_NAMES.has(key) ? undefined : null;
    },
  });
}

function fileValue(
  path: string,
  record: Record<string, unknown>,
  body: string,
  declaredLinkSelectors: string[],
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const file: Record<string, unknown> = {
    ...metadata,
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot + 1) : "",
    folder,
    body,
  };
  for (const key of ["mtime", "ctime"]) {
    if (typeof file[key] === "string") {
      const instant = new Date(file[key] as string);
      if (!Number.isNaN(instant.getTime())) file[key] = instant;
    }
  }
  if (typeof file.size === "number") file.size = BigInt(file.size);
  if (active?.needsFacts) {
    const bodyLinks = extractBodyLinks(body);
    file.tags = tags(record, body);
    file.links = [
      ...frontmatterLinks(record, declaredLinkSelectors),
      // Body wikilinks, then body markdown links (spec Chapter 08).
      ...bodyLinks.filter((link) => !link.is_embed && link.format === "wikilink").map((link) => linkValue(link.target, true)),
      ...bodyLinks.filter((link) => !link.is_embed && link.format !== "wikilink").map((link) => linkValue(link.target, false)),
    ];
    file.embeds = bodyLinks
      .filter((link) => link.is_embed)
      .map((link) => linkValue(link.target, link.format === "wikilink"));
    const sources = [...new Set(active.links?.backlinks(path) ?? [])].sort();
    file.backlinks = sources.map((source) => `[[${source}]]`);
  }
  return file;
}

function recordValue(
  record: Record<string, unknown>,
  raw: Record<string, unknown>,
  file: Record<string, unknown>,
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    if (!MDBASE_CEL_RESERVED_NAMES.has(key)) value[key] = field;
  }
  return { ...value, record, raw, file };
}

/** `file.tags`: frontmatter `tags` followed by inline body tags. */
function tags(record: Record<string, unknown>, body: string): string[] {
  const value = record.tags;
  const result = Array.isArray(value)
    ? value.filter((tag): tag is string => typeof tag === "string")
    : typeof value === "string" && value !== "" ? [value] : [];
  const normalized = result.map((tag) => tag.replace(/^#/, ""));
  for (const tag of extractBodyTags(body)) {
    if (!normalized.includes(tag)) normalized.push(tag);
  }
  return normalized;
}

/** Declared link fields, then other frontmatter values that are exactly one wikilink. */
function frontmatterLinks(record: Record<string, unknown>, declared: string[]): string[] {
  const links: string[] = [];
  const declaredKeys = new Set<string>();
  for (const selector of declared) {
    const key = selector.startsWith("/")
      ? selector.slice(1).split("/")[0].replace(/~1/g, "/").replace(/~0/g, "~")
      : selector.split(".")[0].replace(/\[\]$/, "");
    declaredKeys.add(key);
    pushLinks(record[key], links, true);
  }
  for (const [key, value] of Object.entries(record)) {
    if (!declaredKeys.has(key)) pushLinks(value, links, false);
  }
  return links;
}

function pushLinks(value: unknown, links: string[], declared: boolean): void {
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === "string") pushLinks(item, links, declared);
    return;
  }
  if (typeof value !== "string") return;
  const text = value.trim();
  const isWikilink = text.startsWith("[[") && text.endsWith("]]") && !text.slice(2, -2).includes("]]");
  if (!declared && !isWikilink) return;
  const target = linkTarget(text);
  if (target) links.push(linkValue(target, isWikilink));
}

/**
 * The link value exposed in `file.links` and `file.embeds` (spec Chapter
 * 08): a wikilink as `[[target]]`, and a markdown or bare-path target as an
 * explicit relative or rooted path, so it resolves exactly as the original.
 * Aliases and anchors are dropped.
 */
function linkValue(target: string, wikilink: boolean): string {
  if (target.startsWith("/") || target.startsWith("./") || target.startsWith("../")) return target;
  return wikilink ? `[[${target}]]` : `./${target}`;
}

/** The target of a wikilink, Markdown link, or bare path. */
function linkTarget(text: string): string | null {
  const trimmed = text.trim();
  let target = trimmed;
  if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
    target = trimmed.slice(2, -2).split("|")[0];
  } else {
    const markdown = /^\[[^\]]*\]\((.*)\)$/.exec(trimmed);
    if (markdown) target = markdown[1];
  }
  target = target.split("#")[0].trim();
  return target === "" ? null : target;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Convert `format: date-time` strings to timestamps; other values are unchanged. */
function typeFields(fields: Record<string, unknown>, dateTimes: Set<string>): Record<string, unknown> {
  if (dateTimes.size === 0) return fields;
  const typed = { ...fields };
  for (const field of dateTimes) {
    const value = typed[field];
    if (typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
      const instant = new Date(value);
      if (!Number.isNaN(instant.getTime())) typed[field] = instant;
    }
  }
  return typed;
}

function analyze(root: AstNode): MdbaseCelFacts {
  const facts: MdbaseCelFacts = {
    freeIdentifiers: new Set(),
    projectionReferences: new Set(),
    needsBodyFacts: false,
    needsLinkGraph: false,
  };
  const visit = (node: unknown, bound: Set<string>): void => {
    if (!isNode(node)) {
      if (Array.isArray(node)) for (const child of node) visit(child, bound);
      return;
    }
    const args = Array.isArray(node.args) ? node.args : [node.args];
    switch (node.op) {
      case "id":
        if (typeof node.args === "string" && !bound.has(node.args)) facts.freeIdentifiers.add(node.args);
        return;
      case "value":
        return;
      case ".":
      case ".?": {
        const [object, field] = args as [unknown, string];
        if (isNode(object) && object.op === "id" && object.args === "projection") {
          facts.projectionReferences.add(field);
        }
        if (BODY_FACTS.has(field)) facts.needsBodyFacts = true;
        if (field === "backlinks") facts.needsLinkGraph = true;
        visit(object, bound);
        return;
      }
      case "[]": {
        const [object, key] = args as [unknown, unknown];
        if (isNode(object) && object.op === "id" && object.args === "projection" &&
          isNode(key) && key.op === "value" && typeof key.args === "string") {
          facts.projectionReferences.add(key.args);
        }
        visit(object, bound);
        visit(key, bound);
        return;
      }
      case "rcall": {
        const [name, receiver, callArgs] = args as [string, unknown, unknown[]];
        if (name === "hasTag" || name === "hasLink") facts.needsBodyFacts = true;
        if (name === "asFile" || name === "hasLink") facts.needsLinkGraph = true;
        visit(receiver, bound);
        const variable = MACROS.has(name) && isNode(callArgs?.[0]) && callArgs[0].op === "id"
          ? callArgs[0].args as string
          : undefined;
        const scope = variable ? new Set([...bound, variable]) : bound;
        for (const argument of variable ? callArgs.slice(1) : callArgs ?? []) visit(argument, scope);
        return;
      }
      default:
        for (const child of args) visit(child, bound);
    }
  };
  visit(root, new Set());
  return facts;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "op" in value;
}

/** Serialize a CEL result using the Chapter 10 serialization rules. */
function normalizeCelValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString().replace(/\.000Z$/, "Z");
  if (Array.isArray(value)) return value.map(normalizeCelValue);
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, child]) => [String(key), normalizeCelValue(child)]));
  }
  if (value !== null && typeof value === "object") {
    if (value.constructor?.name === "Duration") return String(value);
    if (value.constructor?.name === "Optional") {
      const optional = value as { hasValue(): boolean; value(): unknown };
      return optional.hasValue() ? normalizeCelValue(optional.value()) : null;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeCelValue(child)]));
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function parseFullDate(value: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : undefined;
  if (!date || date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
    throw new Error(`"${value}" is not an RFC 3339 full-date`);
  }
  return date;
}

function formatDate(date: CivilDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function epochDay(date: CivilDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(value: string, days: number): string {
  const date = new Date((epochDay(parseFullDate(value)) + days) * 86_400_000);
  return formatDate({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

/** Calendar month arithmetic that clamps to the last day of the target month. */
function addMonths(value: string, months: number): string {
  const date = parseFullDate(value);
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return formatDate({ year, month, day: Math.min(date.day, daysInMonth(year, month)) });
}

function zonedParts(instant: Date, timezone: string): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

/** Calendar date of an instant in an IANA timezone. */
function dateOf(instant: Date, timezone: string): string {
  const parts = zonedParts(instant, timezone);
  return formatDate({ year: parts.year, month: parts.month, day: parts.day });
}

/** First instant of a calendar date in an IANA timezone. */
function startOfDay(value: string, timezone: string): Date {
  const date = parseFullDate(value);
  const utcMidnight = Date.UTC(date.year, date.month - 1, date.day);
  let guess = utcMidnight;
  // The offset at local midnight can differ from the offset at the UTC guess.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(guess), timezone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const next = utcMidnight - (asUtc - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}
