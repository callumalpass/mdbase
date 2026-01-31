/**
 * Link parsing for mdbase §8.2, §8.3.
 *
 * Parses wikilinks ([[target]]), markdown links ([text](url)),
 * and bare path links into a structured ParsedLink object.
 */

export interface ParsedLink {
  raw: string;
  target: string;
  alias: string | null;
  anchor: string | null;
  format: "wikilink" | "markdown" | "path";
  is_relative: boolean;
  is_embed?: boolean;
}

/**
 * Parse a link value string into a structured ParsedLink.
 * Returns null if the value is not a recognizable link format.
 * Throws with code "invalid_link" for malformed link syntax.
 */
export function parseLink(value: string): ParsedLink | null {
  if (typeof value !== "string") return null;

  // Try wikilink first: [[...]] or embed ![[...]]
  const isEmbed = value.startsWith("![[");
  const wikiStart = isEmbed ? "![[" : "[[";
  if (value.startsWith(wikiStart)) {
    return parseWikilink(value, isEmbed);
  }

  // Try markdown link: [text](url) or embed ![alt](url)
  const mdEmbed = value.startsWith("![");
  if (value.startsWith("[") || mdEmbed) {
    const result = parseMarkdownLink(value, mdEmbed);
    if (result) return result;
  }

  // Try bare path: starts with ./, ../, /, or contains / with file extension
  if (isBarePathLink(value)) {
    return parseBarePath(value);
  }

  return null;
}

/**
 * Validate a link value for a link-typed field.
 * Returns issues array (empty if valid).
 */
export function validateLinkValue(value: unknown): { valid: boolean; code?: string } {
  if (value === null || value === undefined) {
    return { valid: true };
  }

  if (typeof value !== "string") {
    return { valid: false, code: "type_mismatch" };
  }

  // Try to parse it
  const parsed = parseLink(value);
  if (!parsed) {
    // It's a string but doesn't look like a link — could be a simple name (valid for wikilink-style)
    // Simple names like "task-002" are valid link values (resolved as simple name)
    // But empty strings are not valid
    if (value.trim() === "") {
      return { valid: false, code: "invalid_link" };
    }
    // A plain string is a valid link value (simple name)
    return { valid: true };
  }

  return { valid: true };
}

function parseWikilink(raw: string, isEmbed: boolean): ParsedLink {
  const prefix = isEmbed ? "![[" : "[[";
  const suffix = "]]";

  // Must end with ]]
  if (!raw.endsWith(suffix)) {
    throw Object.assign(
      new Error(`Malformed wikilink: unclosed brackets in "${raw}"`),
      { code: "invalid_link" },
    );
  }

  const inner = raw.slice(prefix.length, -suffix.length);

  // Empty target
  if (inner.trim() === "") {
    throw Object.assign(
      new Error(`Malformed wikilink: empty target in "${raw}"`),
      { code: "invalid_link" },
    );
  }

  // Embedded newline
  if (inner.includes("\n") || inner.includes("\r")) {
    throw Object.assign(
      new Error(`Malformed wikilink: embedded newline in "${raw}"`),
      { code: "invalid_link" },
    );
  }

  // Only pipe separator (no target before or after)
  if (inner === "|") {
    throw Object.assign(
      new Error(`Malformed wikilink: only pipe separator in "${raw}"`),
      { code: "invalid_link" },
    );
  }

  // Only hash (no target)
  if (inner === "#") {
    throw Object.assign(
      new Error(`Malformed wikilink: only hash in "${raw}"`),
      { code: "invalid_link" },
    );
  }

  // Parse: target#anchor|alias
  // First split on pipe for alias
  let targetPart: string;
  let alias: string | null = null;
  const pipeIdx = inner.indexOf("|");
  if (pipeIdx !== -1) {
    targetPart = inner.slice(0, pipeIdx);
    alias = inner.slice(pipeIdx + 1);
  } else {
    targetPart = inner;
  }

  // Split target on first # for anchor
  let target: string;
  let anchor: string | null = null;
  const hashIdx = targetPart.indexOf("#");
  if (hashIdx !== -1) {
    target = targetPart.slice(0, hashIdx);
    anchor = targetPart.slice(hashIdx + 1);
  } else {
    target = targetPart;
  }

  // Whitespace-only target after stripping anchor/alias
  if (target.trim() === "" && anchor === null) {
    throw Object.assign(
      new Error(`Malformed wikilink: whitespace-only target in "${raw}"`),
      { code: "invalid_link" },
    );
  }

  const is_relative = target.startsWith("./") || target.startsWith("../");

  return {
    raw,
    target,
    alias,
    anchor,
    format: "wikilink",
    is_relative,
    ...(isEmbed ? { is_embed: true } : {}),
  };
}

function parseMarkdownLink(raw: string, isEmbed: boolean): ParsedLink | null {
  // Pattern: [text](url) or ![alt](url)
  const prefix = isEmbed ? "!" : "";

  // Find the opening [ after optional !
  const bracketStart = isEmbed ? 1 : 0;
  if (raw[bracketStart] !== "[") return null;

  // Find matching ]
  let depth = 0;
  let bracketEnd = -1;
  for (let i = bracketStart; i < raw.length; i++) {
    if (raw[i] === "[") depth++;
    else if (raw[i] === "]") {
      depth--;
      if (depth === 0) {
        bracketEnd = i;
        break;
      }
    }
  }

  if (bracketEnd === -1) return null;

  // Must be followed by (
  if (bracketEnd + 1 >= raw.length || raw[bracketEnd + 1] !== "(") return null;

  const alias = raw.slice(bracketStart + 1, bracketEnd);

  // Find matching )
  const parenStart = bracketEnd + 2;
  const parenEnd = raw.lastIndexOf(")");
  if (parenEnd <= parenStart - 1) {
    // Unclosed parenthesis
    throw Object.assign(
      new Error(`Malformed markdown link: unclosed parenthesis in "${raw}"`),
      { code: "invalid_link" },
    );
  }

  const url = raw.slice(parenStart, parenEnd);

  // Empty target
  if (url.trim() === "") {
    throw Object.assign(
      new Error(`Malformed markdown link: empty target in "${raw}"`),
      { code: "invalid_link" },
    );
  }

  // Split url on # for anchor (last # that's not part of a path)
  let target: string;
  let anchor: string | null = null;
  // Find last # that comes after the path
  const hashIdx = url.indexOf("#");
  if (hashIdx !== -1) {
    target = url.slice(0, hashIdx);
    anchor = url.slice(hashIdx + 1);
  } else {
    target = url;
  }

  const is_relative = target.startsWith("./") || target.startsWith("../");

  return {
    raw,
    target,
    alias: alias.length > 0 || !isEmbed ? alias : null,
    anchor,
    format: "markdown",
    is_relative,
    ...(isEmbed ? { is_embed: true } : {}),
  };
}

function isBarePathLink(value: string): boolean {
  // Bare paths start with ./, ../, or /
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) {
    return true;
  }
  // Or contain / and look like a path (has file extension or looks like a path)
  if (value.includes("/") && !value.startsWith("[") && !value.startsWith("!")) {
    return true;
  }
  return false;
}

function parseBarePath(raw: string): ParsedLink {
  const is_relative = raw.startsWith("./") || raw.startsWith("../");

  return {
    raw,
    target: raw,
    alias: null,
    anchor: null,
    format: "path",
    is_relative,
  };
}

/**
 * Extract body links from markdown body text.
 * Returns wikilinks and markdown links found in the body,
 * excluding those inside fenced code blocks and inline code spans.
 */
export function extractBodyLinks(body: string): ParsedLink[] {
  if (!body) return [];

  const links: ParsedLink[] = [];
  const lines = body.split("\n");
  let inFencedCode = false;

  for (const line of lines) {
    // Track fenced code blocks
    if (/^```/.test(line.trimStart())) {
      inFencedCode = !inFencedCode;
      continue;
    }
    if (inFencedCode) continue;
    // Skip indented code blocks (4+ spaces or a tab)
    if (/^(?:\t| {4,})/.test(line)) continue;

    // Remove inline code spans before scanning for links
    const cleaned = removeInlineCode(line);

    // Find wikilinks: [[...]] and embeds ![[...]]
    const wikiRegex = /(?<!\\)(!?\[\[([^\]\n]+)\]\])/g;
    let match;
    while ((match = wikiRegex.exec(cleaned)) !== null) {
      try {
        const parsed = parseLink(match[1]);
        if (parsed) links.push(parsed);
      } catch {
        // Malformed links in body are just ignored
      }
    }

    // Find markdown links: [text](url) and embeds ![alt](url)
    const mdRegex = /(!?\[([^\]]*)\]\(([^)]+)\))/g;
    while ((match = mdRegex.exec(cleaned)) !== null) {
      // Skip if this is inside a wikilink we already matched
      try {
        const parsed = parseLink(match[1]);
        if (parsed) links.push(parsed);
      } catch {
        // Malformed links in body are just ignored
      }
    }
  }

  return links;
}

/**
 * Extract tags from body text.
 * Tags are #word patterns preceded by whitespace or at line start.
 * Excludes tags in fenced code blocks and inline code spans.
 */
export function extractBodyTags(body: string): string[] {
  if (!body) return [];

  const tags: string[] = [];
  const tagSet = new Set<string>();
  const lines = body.split("\n");
  let inFencedCode = false;

  for (const line of lines) {
    // Track fenced code blocks
    if (/^```/.test(line.trimStart())) {
      inFencedCode = !inFencedCode;
      continue;
    }
    if (inFencedCode) continue;
    // Skip indented code blocks (4+ spaces or a tab)
    if (/^(?:\t| {4,})/.test(line)) continue;

    // Remove inline code spans before scanning
    const cleaned = removeInlineCode(line);

    // Find tags: #word preceded by whitespace or at line start
    // Tag can start with letter (any case), digit, or underscore
    // Must not be a hex color (6 hex digits) or URL fragment
    const tagRegex = /(?:^|(?<=\s))#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;
    let match;
    while ((match = tagRegex.exec(cleaned)) !== null) {
      // Check character before # is not ), ", ' (URL fragment)
      const pos = match.index;
      if (pos > 0) {
        const prevChar = cleaned[pos - 1];
        if (prevChar === ")" || prevChar === '"' || prevChar === "'") continue;
      }
      const tag = match[1];
      // Skip hex color codes (#RRGGBB patterns, exactly 6 hex digits)
      if (/^[0-9A-Fa-f]{6}$/.test(tag)) continue;
      if (!tagSet.has(tag)) {
        tagSet.add(tag);
        tags.push(tag);
      }
    }
  }

  return tags;
}

/**
 * Remove inline code spans from a line of text.
 * Replaces `...` content with spaces to preserve positions.
 */
function removeInlineCode(line: string): string {
  // Replace backtick-delimited code spans with spaces
  return line.replace(/`[^`]*`/g, (match) => " ".repeat(match.length));
}
