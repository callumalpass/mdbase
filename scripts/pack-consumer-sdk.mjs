import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

const destinationIndex = process.argv.indexOf("--destination");
if (destinationIndex === -1 || !process.argv[destinationIndex + 1]) {
  throw new Error(
    "Usage: npm run package:consumer -- --destination <vendor-directory>",
  );
}

const destination = resolve(process.argv[destinationIndex + 1]);
const revision = command("git", ["rev-parse", "HEAD"]).trim();
const shortRevision = revision.slice(0, 12);
const dirtyPackage = command("git", [
  "status",
  "--porcelain",
  "--",
  "package.json",
  "package-lock.json",
  "scripts",
  "src",
  "tsconfig.json",
]).trim();
if (dirtyPackage) {
  throw new Error(
    "Commit SDK package changes before packing consumer artifacts. Immutable artifacts must identify committed source.",
  );
}

command("npm", ["run", "build"]);
const temporary = await mkdtemp(resolve(tmpdir(), "mdbase-sdk-"));
try {
  const packed = JSON.parse(
    command("npm", ["pack", "--pack-destination", temporary, "--json"]),
  )[0];
  if (!packed?.filename) throw new Error("npm did not report a packed artifact");

  const source = resolve(temporary, basename(packed.filename));
  const extension = ".tgz";
  const targetName = `${basename(source).slice(0, -extension.length)}-${shortRevision}${extension}`;
  const bytes = await readFile(source);
  await cp(source, resolve(destination, targetName));
  await writeFile(
    resolve(destination, "mdbase-sdk.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        repository: "https://github.com/callumalpass/mdbase",
        revision,
        artifact: {
          file: targetName,
          bytes: bytes.length,
          sha512: createHash("sha512").update(bytes).digest("base64"),
        },
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  process.stdout.write(`${targetName}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function command(executable, arguments_) {
  const result = spawnSync(executable, arguments_, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${arguments_.join(" ")} failed with exit ${result.status}.`,
    );
  }
  return result.stdout;
}
