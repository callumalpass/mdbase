/**
 * Conservative, data-free three-way merges for explicitly upgraded seed types
 * (mdbase spec chapter 05a, "seed-type upgrades").
 *
 * `upgrade_from` lists the exact starters a publisher previously shipped. The
 * engine never guesses which one a live type descends from: a byte-identical
 * starter is replaced with the exact desired bytes, and an edited type merges
 * only against the baseline its lock entry records as its origin
 * (`origin_digest`). Anything else is preserved with a reason.
 *
 * The merge is a port of mdbase-rs `src/v03/type_pack_seed_upgrade.rs`; its
 * rules, conflict conditions, and conflict messages match the Rust engine.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** One exact starter a publisher previously shipped for a seed type, pinned by digest. */
export interface SeedUpgradeBaseline {
  digest: string;
  document: string;
  /** The `version` the baseline document declares; presentation only. */
  version?: number;
}

/** A seed type's `upgrade_from`: one baseline, or a non-empty list of them. */
export type SeedUpgradeFrom = SeedUpgradeBaseline | SeedUpgradeBaseline[];

/** The baseline reported for a seed `update`, as `upgrade_baseline`. */
export interface SeedUpgradeBaselineRef {
  digest: string;
  version?: number;
}

/**
 * The planned outcome for a seed type whose target exists, is not an
 * intentionally preserved seed target, and declares `upgrade_from`.
 */
export type SeedUpgradePlan =
  | { action: "preserve"; reason?: string }
  | { action: "update"; bytes: Buffer; baseline: SeedUpgradeBaselineRef }
  | { action: "conflict"; reason: string };

/** A single baseline is equivalent to a list containing it. */
export function seedUpgradeBaselines(value: SeedUpgradeFrom): SeedUpgradeBaseline[] {
  return Array.isArray(value) ? value : [value];
}

export function baselineRef(baseline: SeedUpgradeBaseline): SeedUpgradeBaselineRef {
  return { digest: baseline.digest, ...(baseline.version === undefined ? {} : { version: baseline.version }) };
}

/**
 * Check a schema-valid `upgrade_from` against the rules of chapter 05a. Returns
 * the first problem, or `undefined` when the declaration is valid. `desired` is
 * the resource's own document, already verified against `resource.digest`.
 */
export function verifySeedUpgradeFrom(
  resource: { kind: string; mode: string; digest: string },
  upgradeFrom: SeedUpgradeFrom,
  desired: Buffer,
): string | undefined {
  if (resource.kind !== "type" || resource.mode !== "seed") {
    return ": upgrade_from is only valid on seed type resources.";
  }
  let desiredType: { kind: unknown; name: unknown };
  try {
    desiredType = typeIdentity(utf8(desired));
  } catch (error) {
    return `: the desired seed type cannot be read: ${errorMessage(error)}`;
  }
  const seen = new Set<string>();
  for (const [index, baseline] of seedUpgradeBaselines(upgradeFrom).entries()) {
    const at = Array.isArray(upgradeFrom) ? `/${index}` : "";
    if (revision(Buffer.from(baseline.document, "utf8")) !== baseline.digest) {
      return `${at}: an upgrade baseline's digest is not the SHA-256 of its document.`;
    }
    if (seen.has(baseline.digest)) return `${at}: upgrade baselines must have distinct digests.`;
    seen.add(baseline.digest);
    if (baseline.digest === resource.digest) {
      return `${at}: an upgrade baseline cannot be the resource's own document.`;
    }
    let frontmatter: Record<string, unknown>;
    try {
      const value = parseFrontmatter(baseline.document);
      if (!isObject(value)) throw new SeedMergeConflict("Type must be an object.");
      frontmatter = value;
    } catch (error) {
      return `${at}: an upgrade baseline is not a type document: ${errorMessage(error)}`;
    }
    if (!deepEqual(frontmatter.kind, desiredType.kind) || !deepEqual(frontmatter.name, desiredType.name)) {
      return `${at}: an upgrade baseline must have the same type kind and name as the desired type.`;
    }
    if (baseline.version !== undefined && frontmatter.version !== baseline.version) {
      return `${at}: an upgrade baseline's version differs from the version its document declares.`;
    }
  }
  return undefined;
}

/**
 * Plan an explicit seed-type upgrade (chapter 05a), in the normative order:
 * 1. live equals desired: preserve;
 * 2. live equals a baseline: update to the exact desired bytes;
 * 3. the origin is the desired document: preserve (edited since its upgrade);
 * 4. the origin is a baseline: three-way merge against that baseline;
 * 5. otherwise (unknown or unlisted origin): preserve, with a reason.
 */
export function planSeedUpgrade(input: {
  target: string;
  baselines: readonly SeedUpgradeBaseline[];
  live: Buffer;
  desired: Buffer;
  desiredDigest: string;
  previousOrigin?: string;
}): SeedUpgradePlan {
  const { target, baselines, live, desired, desiredDigest, previousOrigin } = input;
  if (live.equals(desired)) return { action: "preserve" };
  const exact = baselines.find((baseline) => live.equals(Buffer.from(baseline.document, "utf8")));
  if (exact) return { action: "update", bytes: desired, baseline: baselineRef(exact) };
  if (previousOrigin === desiredDigest) return { action: "preserve" };
  const origin = baselines.find((baseline) => baseline.digest === previousOrigin);
  if (!origin) {
    // The origin is unknown, or is not a listed baseline: never guess one.
    return {
      action: "preserve",
      reason: `${target}: no upgrade baseline applies to this type's origin, so it is left as it is.`,
    };
  }
  try {
    const merged = mergeSeedType(origin.document, utf8(live), utf8(desired));
    return { action: "update", bytes: Buffer.from(merged, "utf8"), baseline: baselineRef(origin) };
  } catch (error) {
    return { action: "conflict", reason: `${target}: ${errorMessage(error)}` };
  }
}

function typeIdentity(document: string): { kind: unknown; name: unknown } {
  const value = parseFrontmatter(document);
  if (!isObject(value)) throw new SeedMergeConflict("Type must be an object.");
  return { kind: value.kind, name: value.name };
}

/** Merge `desired` into `current` relative to `base`; throws on conflicts. */
export function mergeSeedType(base: string, current: string, desired: string): string {
  const baseValue = parseFrontmatter(base);
  const currentValue = parseFrontmatter(current);
  const desiredValue = parseFrontmatter(desired);
  for (const key of ["kind", "name"]) {
    const baseField = get(baseValue, key);
    if (
      baseField === undefined
      || !deepEqual(baseField, get(desiredValue, key))
      || !deepEqual(baseField, get(currentValue, key))
    ) {
      throw new SeedMergeConflict(`Seed upgrade requires the same type ${key}.`);
    }
  }
  const merged = mergeValue(baseValue, currentValue, desiredValue, "");
  if (merged === undefined) throw new SeedMergeConflict("Seed upgrade cannot delete a type.");
  if (!isObject(currentValue) || !isObject(merged)) throw new SeedMergeConflict("Type must be an object.");
  if (Object.keys(currentValue).some((key) => !Object.hasOwn(merged, key))) {
    throw new SeedMergeConflict("Removing a top-level type setting requires manual review.");
  }
  // Rewrite only changed top-level nodes. Keep the user's Markdown body and
  // all unrelated YAML (including comments and formatting) byte-for-byte.
  let document = current;
  for (const key of sortedKeys(merged)) {
    const value = merged[key];
    if (!Object.hasOwn(currentValue, key) || !deepEqual(currentValue[key], value)) {
      const [start, end] = frontmatterBounds(document);
      document = replaceYamlNode(document, start, end, key, value);
    }
  }
  return document;
}

/**
 * Three-way merge of one setting. `undefined` is a missing value and is
 * distinct from an explicit `null`.
 */
export function mergeValue(base: unknown, current: unknown, desired: unknown, path: string): unknown {
  if (deepEqual(current, base) || deepEqual(current, desired)) return desired;
  if (deepEqual(desired, base)) return current;
  if (path === "/implements") {
    const merged = mergeValue(
      indexImplementations(base),
      indexImplementations(current),
      indexImplementations(desired),
      "/implementations",
    );
    if (!isObject(merged)) throw new SeedMergeConflict("Missing implementations.");
    return sortedKeys(merged).map((key) => merged[key]);
  }
  if (isObject(base) && isObject(current) && isObject(desired)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(desired)])]
      .sort(compareKeys);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
      const value = mergeValue(get(base, key), get(current, key), get(desired, key), `${path}/${escaped}`);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  throw new SeedMergeConflict(`Seed upgrade conflicts with customized setting ${path}; review it explicitly.`);
}

function indexImplementations(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) throw new SeedMergeConflict("Invalid implements list.");
  const indexed: Record<string, unknown> = {};
  for (const entry of value) {
    const id = isObject(entry) ? entry.contract : undefined;
    if (typeof id !== "string") throw new SeedMergeConflict("Invalid contract identity.");
    if (Object.hasOwn(indexed, id)) {
      throw new SeedMergeConflict(`Multiple versions of ${id} require explicit mapping review.`);
    }
    indexed[id] = entry;
  }
  return indexed;
}

function parseFrontmatter(document: string): unknown {
  const [start, end] = frontmatterBounds(document);
  try {
    return parseYaml(document.slice(start, end));
  } catch (error) {
    throw new SeedMergeConflict(errorMessage(error));
  }
}

/** Byte offsets (as string indices) of the YAML between the frontmatter fences. */
export function frontmatterBounds(document: string): [number, number] {
  const lines = splitInclusive(document);
  const first = lines[0];
  if (first === undefined || trimLineEnding(first).trim() !== "---") {
    throw new SeedMergeConflict("The selected type has no YAML frontmatter.");
  }
  const yamlStart = first.length;
  let cursor = yamlStart;
  for (const line of lines.slice(1)) {
    if (trimLineEnding(line).trim() === "---") return [yamlStart, cursor];
    cursor += line.length;
  }
  throw new SeedMergeConflict("The selected type has unterminated YAML frontmatter.");
}

function replaceYamlNode(document: string, yamlStart: number, yamlEnd: number, key: string, value: unknown): string {
  const yaml = document.slice(yamlStart, yamlEnd);
  const serialized = serializeYaml(value);
  const newline = document.includes("\r\n") ? "\r\n" : "\n";
  const block = `${key}:${newline}${serialized
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => `  ${line.replace(/\r$/, "")}`)
    .join(newline)}`;
  const [nodeStart, nodeEnd] = yamlNodeRange(yaml, key) ?? [yaml.length, yaml.length];
  let nextYaml = yaml.slice(0, nodeStart);
  if (nodeStart === yaml.length && nextYaml.length > 0 && !/[\n\r]$/.test(nextYaml)) nextYaml += newline;
  nextYaml += block + newline + yaml.slice(nodeEnd);
  return document.slice(0, yamlStart) + nextYaml + document.slice(yamlEnd);
}

function yamlNodeRange(yaml: string, key: string): [number, number] | undefined {
  const offsets: Array<[number, string]> = [];
  let cursor = 0;
  for (const line of splitInclusive(yaml)) {
    offsets.push([cursor, line]);
    cursor += line.length;
  }
  if (yaml.length === 0) offsets.push([0, ""]);
  const startIndex = offsets.findIndex(([, line]) => topLevelYamlKey(line) === key);
  if (startIndex < 0) return undefined;
  const start = offsets[startIndex]![0];
  let pendingTrivia: number | undefined;
  for (const [offset, line] of offsets.slice(startIndex + 1)) {
    const trimmed = trimLineEnding(line);
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      pendingTrivia ??= offset;
      continue;
    }
    if (topLevelYamlKey(line) !== undefined) return [start, pendingTrivia ?? offset];
    pendingTrivia = undefined;
  }
  return [start, pendingTrivia ?? yaml.length];
}

function topLevelYamlKey(rawLine: string): string | undefined {
  const line = trimLineEnding(rawLine);
  if (line.length === 0 || /^\s/.test(line) || line.startsWith("#")) return undefined;
  let single = false;
  let double = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && double) escaped = true;
    else if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (character === ":" && !single && !double) {
      try {
        const parsed: unknown = parseYaml(line.slice(0, index).trim());
        return typeof parsed === "string" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Block-style YAML with sorted mapping keys and unindented sequences. */
function serializeYaml(value: unknown): string {
  return stringifyYaml(sortDeep(value), {
    indentSeq: false,
    lineWidth: 0,
    minContentWidth: 0,
    singleQuote: true,
  });
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of sortedKeys(value)) sorted[key] = sortDeep(value[key]);
    return sorted;
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length
      && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function get(value: unknown, key: string): unknown {
  return isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rust `BTreeMap<String, _>` order: by Unicode code point. */
function compareKeys(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort(compareKeys);
}

function splitInclusive(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function trimLineEnding(line: string): string {
  return line.replace(/[\r\n]+$/, "");
}

function utf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function revision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class SeedMergeConflict extends Error {}
