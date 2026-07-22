import { describe, expect, it } from "vitest";

import {
  evaluateStructuredWhere,
  matchesFieldConditions,
} from "../src/operations/structured-where.js";

describe("structured where evaluation", () => {
  it("preserves profile-specific exists semantics", () => {
    const frontmatter = { title: null };
    expect(matchesFieldConditions(frontmatter, { title: { exists: true } }, "v0.3")).toBe(true);
    expect(matchesFieldConditions(frontmatter, { title: { exists: true } }, "v0.2")).toBe(false);
  });

  it("supports nested fields, collections, comparisons, and regular expressions", () => {
    const frontmatter = {
      meta: { priority: 3 },
      tags: ["alpha", "beta"],
      title: "Task 42",
    };
    expect(matchesFieldConditions(frontmatter, {
      "meta.priority": { gte: 3, lt: 4 },
      tags: { containsAll: ["alpha", "beta"] },
      title: { matches: "^Task \\d+$" },
    }, "v0.3")).toBe(true);
  });

  it("combines logical operation clauses recursively", () => {
    expect(evaluateStructuredWhere({
      and: [
        { status: "open" },
        { or: [{ priority: { gt: 2 } }, { urgent: true }] },
        { not: { archived: true } },
      ],
    }, {
      frontmatter: { status: "open", priority: 3, archived: false },
      filePath: "tasks/a.md",
      types: ["task"],
      specProfile: "v0.3",
    })).toBe(true);
  });
});
