/**
 * Portable mdbase path globs (spec Chapter 02, "Path Globs").
 *
 * `*` and `?` match within one path component, `[...]` matches one character
 * from a set or range (`[!...]` negates), and `**` as a whole component
 * matches zero or more components. Matching is case-sensitive over Unicode
 * code points and always covers the complete collection-relative path.
 */
export function portableGlobMatch(pattern: string, path: string): boolean {
  return matchComponents(path.split("/"), pattern.split("/"));
}

function matchComponents(path: string[], pattern: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [first, ...rest] = pattern;
  if (first === "**") {
    return matchComponents(path, rest) || (path.length > 0 && matchComponents(path.slice(1), pattern));
  }
  if (path.length === 0) return false;
  return matchSegment([...path[0]], [...first]) && matchComponents(path.slice(1), rest);
}

function matchSegment(text: string[], pattern: string[]): boolean {
  if (pattern.length === 0) return text.length === 0;
  const [head, ...rest] = pattern;
  if (head === "*") {
    return matchSegment(text, rest) || (text.length > 0 && matchSegment(text.slice(1), pattern));
  }
  if (head === "?") return text.length > 0 && matchSegment(text.slice(1), rest);
  if (head === "[") {
    const parsed = parseClass(rest);
    if (parsed) {
      return text.length > 0 && parsed.matches(text[0]) && matchSegment(text.slice(1), parsed.after);
    }
  }
  return text[0] === head && matchSegment(text.slice(1), rest);
}

/** Parse a class body after `[`, returning its matcher and the pattern after `]`. */
function parseClass(body: string[]): { matches: (c: string) => boolean; after: string[] } | undefined {
  const negated = body[0] === "!";
  const ranges: Array<[number, number]> = [];
  let index = negated ? 1 : 0;
  let first = true;
  while (index < body.length) {
    const c = body[index];
    if (c === "]" && !first) {
      const matches = (candidate: string) => {
        const point = candidate.codePointAt(0)!;
        return ranges.some(([low, high]) => low <= point && point <= high) !== negated;
      };
      return { matches, after: body.slice(index + 1) };
    }
    if (index + 2 < body.length && body[index + 1] === "-" && body[index + 2] !== "]") {
      ranges.push([c.codePointAt(0)!, body[index + 2].codePointAt(0)!]);
      index += 3;
    } else {
      ranges.push([c.codePointAt(0)!, c.codePointAt(0)!]);
      index += 1;
    }
    first = false;
  }
  return undefined;
}
