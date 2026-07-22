import { describe, expect, it } from "vitest";

import {
  computeLegacyQuerySummaries,
  detectCircularFormulas,
} from "../src/operations/legacy-query-support.js";

describe("legacy query support", () => {
  it("detects direct and indirect formula cycles", () => {
    expect(detectCircularFormulas({ a: "formula.a + 1" })?.code).toBe("circular_formula");
    expect(detectCircularFormulas({ a: "formula.b", b: "formula.c", c: "formula.a" })?.code)
      .toBe("circular_formula");
    expect(detectCircularFormulas({ a: "1", b: "formula.a + 1" })).toBeNull();
  });

  it("computes built-in and custom summaries without mutating rows", () => {
    const rows = [
      { frontmatter: { points: 1, done: true, title: "B" } },
      { frontmatter: { points: 3, done: false, title: "A" } },
      { frontmatter: { points: null, title: "" } },
    ];

    expect(computeLegacyQuerySummaries(rows, {
      points: "Average",
      done: "Checked",
      title: "Filled",
    }, {})).toEqual({ points: 2, done: 1, title: 2 });
    expect(computeLegacyQuerySummaries(rows.slice(0, 2), { points: "total" }, {
      total: "values.reduce(acc + value, 0)",
    })).toEqual({ points: 4 });
  });
});
