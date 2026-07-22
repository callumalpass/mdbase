import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const tempRoot = mkdtempSync(join(tmpdir(), "mdbase-package-e2e-"));
const collectionRoot = join(tempRoot, "collection");
let tarball;

function runNpm(args, options) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return execFileSync("npm", args, { ...options, shell: process.platform === "win32" });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runConsumer(mode) {
  const output = execFileSync(process.execPath, ["consumer.mjs", mode, collectionRoot], {
    cwd: tempRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

try {
  const packed = JSON.parse(runNpm(["pack", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }));
  tarball = resolve(packageRoot, packed[0].filename);

  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify({ name: "mdbase-package-e2e", private: true, type: "module" }),
  );
  writeFileSync(join(tempRoot, "consumer.mjs"), consumerSource());

  runNpm(["install", "--ignore-scripts", tarball], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const mutation = runConsumer("mutate");
  assert(mutation.created === 2, `Expected two created records: ${JSON.stringify(mutation)}`);
  assert(mutation.query_count === 2, `Expected warm query to see two records: ${JSON.stringify(mutation)}`);
  assert(mutation.backlinks === 1, `Expected body backlink before rename: ${JSON.stringify(mutation)}`);
  assert(mutation.stale_error === "concurrent_modification", `Expected stale revision failure: ${JSON.stringify(mutation)}`);
  assert(mutation.references_updated === 1, `Expected reference rewrite: ${JSON.stringify(mutation)}`);
  assert(mutation.performance_events >= 8, `Expected operation performance events: ${JSON.stringify(mutation)}`);
  assert(mutation.error_events >= 1, `Expected operation error events: ${JSON.stringify(mutation)}`);

  const verification = runConsumer("verify");
  assert(verification.renamed_title === "Alpha updated", `Renamed record was not persisted: ${JSON.stringify(verification)}`);
  assert(verification.reference_updated === true, `Reference rewrite was not persisted: ${JSON.stringify(verification)}`);
  assert(verification.view_count === 2, `Saved view did not execute after reopen: ${JSON.stringify(verification)}`);
  assert(verification.broken_links === 1, `Delete backlink report was incorrect: ${JSON.stringify(verification)}`);
  assert(verification.remaining_count === 1, `Delete was not visible to the query engine: ${JSON.stringify(verification)}`);

  const binPath = join(
    tempRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "mdb-profile.cmd" : "mdb-profile",
  );
  const help = execFileSync(binPath, ["--help"], { cwd: tempRoot, encoding: "utf8" });
  assert(help.includes("repeatable performance profiling"), "Installed mdb-profile binary did not run");

  process.stdout.write(`${JSON.stringify({ mutation, verification, installed_cli: true }, null, 2)}\n`);
} finally {
  if (tarball) rmSync(tarball, { force: true });
  rmSync(tempRoot, { recursive: true, force: true });
}

function consumerSource() {
  return String.raw`
import { Collection } from "@callumalpass/mdbase";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [mode, root] = process.argv.slice(2);
const events = [];
const options = {
  observability: {
    performance: true,
    errors: true,
    logger: (event) => events.push(event),
  },
};

if (mode === "mutate") {
  await Collection.init(root, { config: { name: "Package E2E" } }, options);
  await mkdir(join(root, "_types"), { recursive: true });
  await writeFile(join(root, "_types", "task.md"), ${JSON.stringify(`---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    properties:
      type: { const: task }
      title: { type: string }
      status: { type: string }
---
`)}, "utf8");
  await writeFile(join(root, "_types", "view.md"), ${JSON.stringify(`---
kind: mdbase.type
name: view
version: 1
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
`)}, "utf8");
  await mkdir(join(root, "views"), { recursive: true });
  await writeFile(join(root, "views", "tasks.md"), ${JSON.stringify(`---
type: view
id: task.views
version: 1
name: Task views
query:
  types: [task]
  where: 'status == "open"'
views:
  - id: open
    name: Open tasks
    order_by:
      - field: title
        direction: asc
---
`)}, "utf8");

  const opened = await Collection.open(root, options);
  if (!opened.collection) throw new Error(opened.error?.message ?? "open failed");
  const collection = opened.collection;
  const alpha = await collection.create({
    type: "task",
    path: "a.md",
    frontmatter: { title: "Alpha", status: "open" },
  });
  const beta = await collection.create({
    type: "task",
    path: "b.md",
    frontmatter: { title: "Beta", status: "open" },
    body: "[[a]]\n",
  });
  if (alpha.error || beta.error) throw new Error(JSON.stringify(alpha.error ?? beta.error));
  const query = await collection.queryCanonical({ types: ["task"] });
  const before = await collection.read("a.md");
  const updated = await collection.update({
    path: "a.md",
    fields: { title: "Alpha updated" },
    if_revision: before.revision,
  });
  if (updated.error) throw new Error(updated.error.message);
  const stale = await collection.update({
    path: "a.md",
    fields: { title: "stale" },
    if_revision: before.revision,
  });
  const backlinks = await collection.computeBacklinksForFile("a.md");
  const renamed = await collection.rename({
    from: "a.md",
    to: "archive/a.md",
    update_refs: true,
    if_revision: updated.revision,
  });
  await collection.cacheRebuild();
  await collection.close();
  process.stdout.write(JSON.stringify({
    created: Number(!alpha.error) + Number(!beta.error),
    query_count: query.meta.total_count,
    backlinks: backlinks.length,
    stale_error: stale.error?.code,
    references_updated: Array.isArray(renamed.references_updated) ? renamed.references_updated.length : 0,
    performance_events: events.filter((event) => event.kind === "performance").length,
    error_events: events.filter((event) => event.kind === "error").length,
  }));
} else if (mode === "verify") {
  const opened = await Collection.open(root, options);
  if (!opened.collection) throw new Error(opened.error?.message ?? "open failed");
  const collection = opened.collection;
  const renamed = await collection.read("archive/a.md");
  const source = await collection.read("b.md");
  const view = await collection.executeView({ path: "views/tasks.md", view: "open" });
  const deleted = await collection.delete("archive/a.md", { check_backlinks: true });
  const remaining = await collection.queryCanonical({ types: ["task"] });
  await collection.close();
  process.stdout.write(JSON.stringify({
    renamed_title: renamed.frontmatter?.title,
    reference_updated: source.body?.includes("[[archive/a]]") === true,
    view_count: view.meta.total_count,
    broken_links: deleted.broken_links?.length ?? 0,
    remaining_count: remaining.meta.total_count,
  }));
} else {
  throw new Error("Unknown mode: " + mode);
}
`;
}
