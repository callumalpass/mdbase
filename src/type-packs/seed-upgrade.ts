/**
 * Conservative, data-free three-way merges for explicitly upgraded seed types
 * (mdbase spec chapter 05a, "seed-type upgrades").
 *
 * This is a port of mdbase-rs `src/v03/type_pack_seed_upgrade.rs`. The merge
 * rules, conflict conditions, and conflict messages match the Rust engine.
 * One deliberate refinement: when the live document is byte-for-byte the
 * previous publisher baseline, the desired document is written exactly as
 * published instead of being re-serialised node by node.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** An explicit, digest-pinned previous publisher baseline for one seed type. */
export interface SeedUpgradeBase {
  digest: string;
  document: string;
}

export type SeedUpgradePlan =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string };

const BASELINE_ERROR = "Seed upgrade requires a digest-pinned type baseline.";

/** Reject a baseline that is not on a seed type or does not match its digest. */
export function verifySeedUpgradeBase(base: SeedUpgradeBase, kind: string, mode: string): string | undefined {
  if (kind !== "type" || mode !== "seed" || revision(Buffer.from(base.document, "utf8")) !== base.digest) {
    return BASELINE_ERROR;
  }
  return undefined;
}

/** The live type merged with the desired publisher changes. */
export function planSeedUpgrade(base: SeedUpgradeBase, current: Buffer, desired: Buffer): SeedUpgradePlan {
  const baseline = Buffer.from(base.document, "utf8");
  // Exact-bytes rules: an already-current seed stays as it is, and an
  // unedited previous starter becomes the desired starter byte-for-byte.
  if (current.equals(desired)) return { ok: true, bytes: current };
  if (current.equals(baseline)) return { ok: true, bytes: desired };
  let currentText: string;
  let desiredText: string;
  try {
    currentText = utf8(current);
    desiredText = utf8(desired);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  try {
    return { ok: true, bytes: Buffer.from(mergeSeedType(base.document, currentText, desiredText), "utf8") };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
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
