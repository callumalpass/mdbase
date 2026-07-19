# @callumalpass/mdbase

TypeScript implementation of the [mdbase specification](https://mdbase.dev): structured Markdown collections with JSON Schema types, collection semantics, validation, queries, links, lifecycle hooks, and runtime contracts.

The v0.3 implementation is pre-1.0 and intentionally breaking. It also includes a v0.2 compatibility adapter and reviewed migration tooling.

## Features

- JSON Schema 2020-12 type wrappers with canonical diagnostics
- Collection-level matching, defaults, links, uniqueness, paths, and lifecycle
- CEL plus legacy query support with filters, ordering, formulas, and traversal
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

const query = await collection.query({
  types: ["task"],
  where: "status == \"open\" && priority >= 2",
  order_by: [{ field: "priority", direction: "desc" }],
});

await collection.close();
```

## Operations

The canonical v0.3 facade returns `{ valid, result, diagnostics }` envelopes:

- `collection.v03Operations().read({ path, effective? })`
- `validate({ path? })`
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
- `batchDelete({ where, dry_run?, check_backlinks? })`
- `batchUpdate({ where?, fields?, updates?, dry_run? })`
- `backfill({ type?, where?, fields?, apply?, dry_run? })`
- `migrate({ id, dry_run? })`
- `cacheRebuild()`
- `cacheClear()`
- `close()`

See `src/operations/collection.ts` for the authoritative behavior.

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

Cache is async and backed by SQLite in a worker (`src/cache/worker.js`). It is used opportunistically to speed up reads; correctness does not depend on cache presence. Use `cacheRebuild()` and `cacheClear()` for tests or maintenance.

## Conformance

The package ships its machine-readable v0.3 conformance claim under `conformance/`. Shared v0.3 fixtures live in `mdbase-spec/tests/v0.3`; the legacy suite remains active to protect v0.2 compatibility.

## Example applications

| Project | Description |
|---------|-------------|
| [mdbase-workouts](https://github.com/callumalpass/mdbase-workouts) | Workout tracker with chat interface, built on mdbase |

## Repository layout

- `src/operations/collection.ts` main implementation
- `src/expressions/` query language + evaluation
- `src/links/` link parsing and body extraction
- `src/config/` config loading
- `src/types/` type loading and validation helpers
- `src/cache/` async cache store + worker
- `test/` conformance test runner
