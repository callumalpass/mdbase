import { beforeEach, describe, expect, it } from "vitest";

import {
  clearMdbaseCelProgramCache,
  evaluateMdbaseCel,
  getMdbaseCelProgramCacheSize,
  MDBASE_CEL_PROGRAM_CACHE_LIMIT,
} from "../src/expressions/cel.js";

describe("compiled CEL program cache", () => {
  beforeEach(() => clearMdbaseCelProgramCache());

  it("reuses a program while evaluating each call with fresh bindings", () => {
    expect(evaluateMdbaseCel("value + suffix", { record: { value: "a", suffix: "b" } })).toEqual({
      value: "ab",
      diagnostics: [],
    });
    expect(evaluateMdbaseCel("value + suffix", { record: { value: "x", suffix: "y" } })).toEqual({
      value: "xy",
      diagnostics: [],
    });
    expect(getMdbaseCelProgramCacheSize()).toBe(1);
  });

  it("does not retain expressions that fail to parse", () => {
    const result = evaluateMdbaseCel("value +", { record: { value: 3 } });
    expect(result.value).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    expect(getMdbaseCelProgramCacheSize()).toBe(0);
  });

  it("bounds user-controlled expression cardinality", () => {
    for (let index = 0; index < MDBASE_CEL_PROGRAM_CACHE_LIMIT + 25; index++) {
      const result = evaluateMdbaseCel(`value == "v${index}"`, { record: { value: `v${index}` } });
      expect(result.diagnostics).toEqual([]);
    }
    expect(getMdbaseCelProgramCacheSize()).toBe(MDBASE_CEL_PROGRAM_CACHE_LIMIT);
  });
});
