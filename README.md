# @callumalpass/mdbase

TypeScript implementation of the [mdbase specification](https://mdbase.dev): structured Markdown collections with JSON Schema types, collection semantics, validation, queries, links, lifecycle hooks, and runtime contracts.

The v0.3 implementation is pre-1.0 and intentionally breaking. It also includes a v0.2 compatibility adapter and reviewed migration tooling.

## Features

- JSON Schema 2020-12 type wrappers with canonical diagnostics
- Collection-level matching, defaults, links, uniqueness, paths, and lifecycle
- Canonical CEL queries with invocation context, named projections, grouping,
  summaries, and selected result values
- Ordinary Markdown view records with headless named-view execution
- Legacy query support with formulas and traversal for v0.2 compatibility
- Link parsing + resolution (wikilinks, markdown links, bare paths)
- Backlinks, tags, and embeds extraction from content
- Batch operations and rename with optional reference updates
- Cache support via a SQLite worker (async API)
- Portable runtime contracts, provider registries, policy, and validation
- Safe, report-first v0.2-to-v0.3 collection migration

## Install

```bash
npm install
```

## Build and test

```bash
npm run build
npm test
```

## Performance profiling

Run the synthetic profiler with default workload:

```bash
./scripts/profile.sh
```

Write results to a JSON file with custom sizing:

```bash
./scripts/profile.sh --files 5000 --query-iters 500 --output .ops/profile/latest.json
```

The profiler reports latency percentiles (`p50`, `p95`, `p99`), averages, and throughput for core operations (`open`, `read`, `query_basic`, `query_formula`, `update`, `rename_update_refs`, `create`, `delete`, `cache_rebuild`).

## Usage

Initialize a new v0.3 collection, open it, and use the canonical v0.3 operation facade:

```ts
import { Collection } from "@callumalpass/mdbase";

await Collection.init("/path/to/new-collection", {
  config: { name: "Example" },
});

const opened = await Collection.open("/path/to/collection");
if (opened.error) throw new Error(opened.error.message);
const collection = opened.collection!;

const operations = collection.v03Operations();
const read = await operations.read({ path: "notes/example.md" });
if (!read.valid) throw new Error(read.diagnostics[0]?.message);

const query = await operations.query({
  types: ["task"],
  where: "status == \"open\" && priority >= 2",
  projections: {
    urgent: { expr: "priority >= 4" },
  },
  select: ["title", "projection.urgent"],
  order_by: [{ field: "priority", direction: "desc" }],
});

const savedView = await operations.executeView({
  path: "views/tasks.md",
  view: "open",
  context: { path: "projects/alpha.md" },
});

await collection.close();
```

### Optional performance and error logging

Collection diagnostics are disabled by default. Enable structured performance
and/or error events when opening a collection:

```ts
const opened = await Collection.open("/path/to/collection", {
  observability: {
    performance: { threshold_ms: 10 },
    errors: true,
    logger: (event) => telemetry.write(event),
  },
});
```

Events contain operation names, durations, outcomes, and safe scalar metadata;
record bodies and frontmatter are never logged. Without a custom logger,
newline-delimited JSON is written to stderr. Nested operations are suppressed
unless `performance.include_nested` is enabled. Error stack traces are omitted
unless `errors.include_stack` is enabled.

## Operations

The canonical v0.3 facade returns `{ valid, result, diagnostics }` envelopes:

- `collection.v03Operations().read({ path, effective? })`
- `validate({ path? })`
- `query({ types?, context?, projections?, where?, select?, order_by?, group_by?, summaries? })`
- `executeView({ path, view, context?, limit?, offset?, render? })`
- `create({ type|types, path?, frontmatter, body? })`
- `update({ path, fields?, body?, if_revision? })`
- `delete({ path, if_revision? })`
- `rename({ from, to, if_revision? })`

The broader direct `Collection` API remains available for v0.2 compatibility and implementation-specific features:

- `read(path)`
- `validate(path?)`
- `create({ path, frontmatter|fields, body, type|types })`
- `update({ path, fields|frontmatter, body })`
- `delete(path, { check_backlinks? })`
- `rename({ from, to, update_refs? })`
- `query({ types?, where?, order_by?, limit?, offset?, include_body?, context_file?, formulas? })`
- `queryCanonical(query)`
- `executeView({ path, view, context?, limit?, offset?, render? })`
- `batchDelete({ where, dry_run?, check_backlinks? })`
- `batchUpdate({ where?, fields?, updates?, dry_run? })`
- `backfill({ type?, where?, fields?, apply?, dry_run? })`
- `migrate({ id, dry_run? })`
- `cacheRebuild()`
- `cacheClear()`
- `close()`

Public operation and observability contracts are exported from the package.

## Config

Collections are configured with `mdbase.yaml`:

```yaml
spec_version: "0.3.0"
settings:
  types_folder: "_types"
  validation: "warn" # off | warn | error
  explicit_type_keys: [type, types]
  include_subfolders: true
```

Type definitions live in the types folder (default `_types/`) as markdown files with frontmatter:

```md
---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    $schema: "https://json-schema.org/draft/2020-12/schema"
    type: object
    required: [type, title]
    properties:
      type: { const: task }
      title: { type: string, minLength: 1 }
      status: { enum: [open, closed] }
      parent: { type: string }
collection:
  display:
    name_field: title
  read_defaults:
    status: open
  links:
    parent:
      target_type: task
      validate_exists: true
---
```

Pass `spec_version: "0.2.1"` explicitly to `Collection.init` to create a legacy collection. Existing v0.2 collections continue to open through the compatibility adapter.

## Migration

Use `mdbase-cli migrate v0.3 analyze` before changing a v0.2 collection. The migration flow produces an exact report and diff, requires explicit approval to apply, writes a durable backup manifest, verifies source hashes, validates the result, and supports recovery.

## Cache

Cache is async and backed by SQLite. It is used opportunistically to speed up
reads; correctness does not depend on cache presence. Use `cacheRebuild()` and
`cacheClear()` for tests or maintenance.

## Conformance

The package ships its machine-readable v0.3 conformance claim under `conformance/`. Shared v0.3 fixtures live in `mdbase-spec/tests/v0.3`; the legacy suite remains active to protect v0.2 compatibility.

## Example applications

| Project | Description |
|---------|-------------|
| [mdbase-workouts](https://github.com/callumalpass/mdbase-workouts) | Workout tracker with chat interface, built on mdbase |

## Repository layout

- `src/operations/collection.ts` collection facade and operation orchestration
- `src/operations/contracts.ts` public operation contracts
- `src/observability.ts` opt-in structured diagnostics
- `src/expressions/` query language + evaluation
- `src/links/` link parsing and body extraction
- `src/config/` config loading
- `src/types/` type loading and validation helpers
- `src/cache/` async cache store + worker
- `test/` conformance test runner
