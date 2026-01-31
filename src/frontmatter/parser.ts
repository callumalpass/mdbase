/**
 * Frontmatter parsing.
 * Reads markdown files and extracts YAML frontmatter + body.
 * Implements §3 of the mdbase specification.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import * as yaml from "js-yaml";

/**
 * Custom YAML schema that keeps timestamps as strings instead of converting to Date objects.
 * This preserves timezone offset information (e.g., +05:30).
 */
const timestampAsString = new yaml.Type("tag:yaml.org,2002:timestamp", {
  kind: "scalar",
  resolve: (data: string) =>
    /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(data),
  construct: (data: string) => {
    // Normalize space separator to T for ISO 8601, but keep date-only as-is
    if (/^\d{4}-\d{2}-\d{2} /.test(data)) {
      return data.replace(" ", "T");
    }
    return data;
  },
  instanceOf: String,
  represent: (data: unknown) => String(data),
});

const MDBASE_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend({ implicit: [timestampAsString] });

export interface ParsedFile {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  error?: { code: string; message: string };
  /** If true, this is a YAML syntax error (always fatal regardless of validation level) */
  fatalError?: boolean;
}

/**
 * Extract frontmatter YAML string and body from raw markdown content.
 * Returns null if no frontmatter delimiters are found.
 */
function extractFrontmatter(raw: string): { yamlStr: string; body: string } | null {
  // Must start with ---
  if (!raw.startsWith("---")) return null;
  const lineEnd = raw.indexOf("\n", 3);
  if (lineEnd < 0) return null;
  // Check that first line is just ---
  const firstLine = raw.slice(0, lineEnd).trim();
  if (firstLine !== "---") return null;

  const afterFirst = raw.slice(lineEnd + 1);
  // Find closing --- at start of a line
  const closingMatch = afterFirst.match(/^---\s*$/m);
  if (!closingMatch || closingMatch.index === undefined) return null;

  const yamlStr = afterFirst.slice(0, closingMatch.index);
  const body = afterFirst.slice(closingMatch.index + closingMatch[0].length);
  // Strip leading newline from body
  return { yamlStr, body: body.startsWith("\n") ? body.slice(1) : body };
}

/**
 * Parse a markdown file's frontmatter and body.
 */
function parseContent(rawBuffer: Buffer): ParsedFile {
  // Validate UTF-8: check for invalid sequences (bytes that don't match UTF-8 patterns)
  if (!isValidUtf8(rawBuffer)) {
    return {
      frontmatter: {},
      body: "",
      raw: "",
      fatalError: true,
      error: {
        code: "invalid_frontmatter",
        message: "File contains invalid UTF-8 sequences",
      },
    };
  }
  const raw = rawBuffer.toString("utf-8");

  // Check for blank line before --- (means no frontmatter)
  if (raw.startsWith("\n") || !raw.startsWith("---")) {
    return {
      frontmatter: {},
      body: raw,
      raw,
    };
  }

  const extracted = extractFrontmatter(raw);
  if (!extracted) {
    return {
      frontmatter: {},
      body: raw,
      raw,
    };
  }

  const { yamlStr, body } = extracted;
  const trimmedYaml = yamlStr.trim();

  // Empty frontmatter
  if (trimmedYaml === "") {
    return {
      frontmatter: {},
      body,
      raw,
    };
  }

  // Parse YAML using js-yaml (proper YAML 1.2 with correct chomping/indentation support)
  let data: unknown;
  try {
    data = yaml.load(yamlStr, { schema: MDBASE_YAML_SCHEMA });
  } catch (e: unknown) {
    return {
      frontmatter: {},
      body,
      raw,
      fatalError: true,
      error: {
        code: "invalid_frontmatter",
        message: `Failed to parse frontmatter YAML: ${(e as Error).message}`,
      },
    };
  }

  // Check for non-mapping frontmatter
  if (data === null || data === undefined) {
    // Explicit null/tilde or empty-ish content
    if (trimmedYaml === "null" || trimmedYaml === "~" || trimmedYaml === "Null" || trimmedYaml === "NULL") {
      return {
        frontmatter: {},
        body,
        raw,
        error: {
          code: "invalid_frontmatter",
          message: "Frontmatter must be a YAML mapping, got null",
        },
      };
    }
    // js-yaml returns null for empty content
    return {
      frontmatter: {},
      body,
      raw,
    };
  }

  if (Array.isArray(data)) {
    return {
      frontmatter: {},
      body,
      raw,
      error: {
        code: "invalid_frontmatter",
        message: "Frontmatter must be a YAML mapping, got list",
      },
    };
  }

  if (typeof data !== "object") {
    return {
      frontmatter: {},
      body,
      raw,
      error: {
        code: "invalid_frontmatter",
        message: `Frontmatter must be a YAML mapping, got ${typeof data}`,
      },
    };
  }

  return {
    frontmatter: data as Record<string, unknown>,
    body,
    raw,
  };
}

export async function parseFileAsync(filePath: string): Promise<ParsedFile> {
  const rawBuffer = await fs.promises.readFile(filePath);
  return parseContent(rawBuffer);
}

export const parseFile = parseFileAsync;

/**
 * Serialize frontmatter and body back to a markdown string.
 */
export function serializeFile(
  frontmatter: Record<string, unknown>,
  body: string,
  writeNulls: "omit" | "explicit" = "omit",
  writeEmptyLists: boolean = true,
): string {
  const filtered = filterFrontmatter(frontmatter, writeNulls, writeEmptyLists);
  const result = matter.stringify(body, filtered);
  return result;
}

function filterFrontmatter(
  data: Record<string, unknown>,
  writeNulls: "omit" | "explicit",
  writeEmptyLists: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      if (writeNulls === "explicit") {
        result[key] = null;
      }
      continue;
    }
    if (Array.isArray(value) && value.length === 0 && !writeEmptyLists) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Check if a Buffer contains valid UTF-8.
 * Detects invalid byte sequences that indicate non-UTF-8 encoding.
 */
function isValidUtf8(buf: Buffer): boolean {
  // Node's TextDecoder can validate UTF-8
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buf);
    return true;
  } catch {
    return false;
  }
}
