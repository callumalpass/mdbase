import { describe, expect, it } from "vitest";

import { IndexedReadResult } from "../src/operations/link-index.js";
import { LinkResolver } from "../src/operations/link-resolver.js";

function cache(entries: Record<string, IndexedReadResult>): Map<string, IndexedReadResult> {
  return new Map(Object.entries(entries));
}

describe("LinkResolver", () => {
  it("prefers an exact ID over a filename match", () => {
    const files = ["by-name/TASK-1.md", "by-id/record.md"];
    const fileCache = cache({
      "by-name/TASK-1.md": { frontmatter: { id: "OTHER" }, types: ["task"] },
      "by-id/record.md": { frontmatter: { id: "TASK-1" }, types: ["task"] },
    });
    const resolver = new LinkResolver({ idField: "id", recordExtensions: ["md"] });

    expect(resolver.resolve("[[TASK-1]]", "source.md", files, { fileCache })).toEqual({
      resolved: "by-id/record.md",
    });
  });

  it("reports duplicate IDs as ambiguous", () => {
    const files = ["a.md", "b.md"];
    const fileCache = cache({
      "a.md": { frontmatter: { id: 42 }, types: ["task"] },
      "b.md": { frontmatter: { id: "42" }, types: ["task"] },
    });
    const resolver = new LinkResolver({ idField: "id", recordExtensions: ["md"] });

    expect(resolver.resolve("[[42]]", "source.md", files, { fileCache })).toEqual({
      resolved: null,
      ambiguous: true,
    });
  });

  it("distinguishes missing targets from targets of the wrong type", () => {
    const files = ["notes/record.md"];
    const fileCache = cache({
      "notes/record.md": { frontmatter: {}, types: ["note"] },
    });
    const resolver = new LinkResolver({ recordExtensions: ["md"] });

    expect(resolver.resolve("[[record]]", "source.md", files, {
      targetType: "task",
      fileCache,
    })).toEqual({ resolved: null, wrongType: true });
    expect(resolver.resolve("[[missing]]", "source.md", files, {
      targetType: "task",
      fileCache,
    })).toEqual({ resolved: null });
  });

  it("uses same-directory, shortest-path, and alphabetical tie-breakers deterministically", () => {
    const files = ["deep/a/record.md", "near/record.md", "other/record.md"];
    const resolver = new LinkResolver({ recordExtensions: ["md"] });
    const index = resolver.buildIndex(files);

    expect(resolver.resolve("[[record]]", "near/source.md", files, { resolutionIndex: index })).toEqual({
      resolved: "near/record.md",
    });
    expect(resolver.resolve("[[record]]", "source.md", files, { resolutionIndex: index })).toEqual({
      resolved: "near/record.md",
    });
  });

  it("resolves relative records and path links to non-record assets", () => {
    const files = ["notes/target.md"];
    const nonMarkdownFiles = new Set(["assets/image.png"]);
    const resolver = new LinkResolver({ recordExtensions: ["md", "txt"] });

    expect(resolver.resolve("[[../notes/target]]", "nested/source.md", files)).toEqual({
      resolved: "notes/target.md",
    });
    expect(resolver.resolve("../assets/image.png", "nested/source.md", files, {
      nonMarkdownFiles,
    })).toEqual({ resolved: "assets/image.png" });
  });

  it("treats malformed links as unresolved without throwing", () => {
    const resolver = new LinkResolver({ recordExtensions: ["md"] });
    expect(resolver.resolve("[[unterminated", "source.md", [])).toEqual({ resolved: null });
  });
});
