import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const tempRoot = mkdtempSync(join(tmpdir(), "mdbase-package-smoke-"));
let tarball;

function runNpm(args, options) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return execFileSync("npm", args, { ...options, shell: process.platform === "win32" });
}

try {
  const packed = JSON.parse(
    runNpm(["pack", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  tarball = resolve(packageRoot, packed[0].filename);

  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify({ name: "mdbase-package-smoke", private: true, type: "module" }),
  );
  writeFileSync(
    join(tempRoot, "smoke.mjs"),
    [
      'import { Collection, SUPPORTED_SPEC_VERSION } from "@callumalpass/mdbase";',
      'if (typeof Collection !== "function") throw new Error("Collection export is unavailable");',
      'if (SUPPORTED_SPEC_VERSION !== "0.3.0") throw new Error(`Unexpected spec version: ${SUPPORTED_SPEC_VERSION}`);',
    ].join("\n"),
  );

  runNpm(["install", "--ignore-scripts", tarball], {
    cwd: tempRoot,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: tempRoot, stdio: "inherit" });

  const installed = JSON.parse(
    readFileSync(join(tempRoot, "node_modules", "@callumalpass", "mdbase", "package.json"), "utf8"),
  );
  if (installed.version !== "0.3.0-rc.1") {
    throw new Error(`Unexpected installed package version: ${installed.version}`);
  }

} finally {
  if (tarball) rmSync(tarball, { force: true });
  rmSync(tempRoot, { recursive: true, force: true });
}
