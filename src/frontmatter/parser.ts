/**
 * Frontmatter parsing.
 * Reads markdown files and extracts YAML frontmatter + body.
 * Implements §3 of the mdbase specification.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";

export interface ParsedFile {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  error?: { code: string; message: string };
}

/**
 * Parse a markdown file's frontmatter and body.
 */
export function parseFile(filePath: string): ParsedFile {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = matter(raw);

  // Check for non-mapping frontmatter
  if (parsed.data !== null && parsed.data !== undefined) {
    if (Array.isArray(parsed.data)) {
      return {
        frontmatter: {},
        body: parsed.content,
        raw,
        error: {
          code: "invalid_frontmatter",
          message: "Frontmatter must be a YAML mapping, got list",
        },
      };
    }
    if (typeof parsed.data !== "object") {
      return {
        frontmatter: {},
        body: parsed.content,
        raw,
        error: {
          code: "invalid_frontmatter",
          message: `Frontmatter must be a YAML mapping, got ${typeof parsed.data}`,
        },
      };
    }
  }

  return {
    frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
    body: parsed.content,
    raw,
  };
}

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
