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

  it("gives migration guidance for the superseded runtime 0.1 config section", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-config-runtime-"));
    await fs.writeFile(
      path.join(root, "mdbase.yaml"),
      'spec_version: "0.3.0"\nruntime:\n  profile_version: "0.1.0"\n  contract_mode: runtime\n',
    );

    const result = await loadConfigAsync(root);

    expect(result.valid).toBe(true);
    expect(result.config).not.toHaveProperty("runtime");
    expect(result.warnings).toContain(
      "The mdbase runtime 0.1 config section is superseded. Runtime 0.2 host enablement and policy selection belong in host settings; install the standard runtime pack for portable records.",
    );
  });
});
