import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { LEGACY_SPEC_VERSION, loadConfigAsync } from "../src/config/loader.js";

describe("config loader", () => {
  it("normalizes short spec_version to current supported patch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-config-"));
    await fs.writeFile(path.join(root, "mdbase.yaml"), 'spec_version: "0.2"\n');

    const result = await loadConfigAsync(root);

    expect(result.valid).toBe(true);
    expect(result.config?.spec_version).toBe(LEGACY_SPEC_VERSION);
    expect(result.warnings?.some(w => w.includes(`normalizing to "${LEGACY_SPEC_VERSION}"`))).toBe(true);
  });
});
