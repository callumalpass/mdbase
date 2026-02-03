# mdbase

TypeScript implementation of the [mdbase spec](https://mdbase.dev): a structured markdown collection with typed frontmatter, validation, queries, links, and watch/caching semantics.

This repo is a reference implementation used to run the conformance suite in `~/projects/mdbase-spec/tests`.

## Features

- Typed frontmatter with validation, defaults, coercion, and constraints
- Type definitions in `_types/` with inheritance
- Query language with filters, ordering, formulas, and link traversal
- Link parsing + resolution (wikilinks, markdown links, bare paths)
- Backlinks, tags, and embeds extraction from content
- Batch operations and rename with optional reference updates
- Cache support via a SQLite worker (async API)
- Watch-mode simulation for conformance tests

## Install

```bash
npm install
```

## Build and test

```bash
npm run build
npm test
```

## Usage

The public API is async. Open a collection, run operations, then close it.

```ts
import { Collection } from "mdbase";

const opened = await Collection.open("/path/to/collection");
if (opened.error) throw new Error(opened.error.message);
const collection = opened.collection!;

const read = await collection.read("notes/example.md");
const query = await collection.query({
  types: ["task"],
  where: "status == \"open\" && priority >= 2",
  order_by: [{ field: "priority", direction: "desc" }],
});

await collection.close();
```

## Operations

All operations are methods on `Collection`:

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
spec_version: "0.2.0"
settings:
  types_folder: "_types"
  migrations_folder: "_types/_migrations"
  default_validation: "warn" # off | warn | error
  default_strict: false
  include_subfolders: true
  rename_update_refs: true
  cache_folder: ".mdbase"
```

Type definitions live in the types folder (default `_types/`) as markdown files with frontmatter:

```md
---
name: task
fields:
  title:
    type: string
    required: true
  status:
    type: enum
    values: [open, closed]
  parent:
    type: link
    target: task
---
```

## Cache

Cache is async and backed by SQLite in a worker (`src/cache/worker.js`). It is used opportunistically to speed up reads; correctness does not depend on cache presence. Use `cacheRebuild()` and `cacheClear()` for tests or maintenance.

## Conformance

The conformance runner is in `test/conformance.test.ts`. It reads YAML test files from `~/projects/mdbase-spec/tests` and executes them against this implementation.

## Repository layout

- `src/operations/collection.ts` main implementation
- `src/expressions/` query language + evaluation
- `src/links/` link parsing and body extraction
- `src/config/` config loading
- `src/types/` type loading and validation helpers
- `src/cache/` async cache store + worker
- `test/` conformance test runner
