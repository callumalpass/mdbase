# Changelog

## Unreleased

- Implement the canonical v0.3 query-object schema, invocation-context `this`
  binding, named projections, selection, grouping, and summaries.
- Add headless execution of ordinary Markdown view records and advertise the
  optional `view_records` feature.
- Bundle the canonical query and view schemas with generated v0.3 artifacts.
- Add opt-in structured performance and error logging for collection operations.
- Add a packed-package, two-process E2E suite covering persistence, queries,
  views, backlinks, rename reference updates, cache rebuilds, concurrency, and
  the installed CLI.
- Preserve the parsed-file cache across coherent updates and include body links
  in the delete backlink candidate index.

## 0.3.0-rc.1 - 2026-07-19
- Publish the first v0.3 release candidate against the registry-hosted mdbase runtime package.
- Verify the installable package on Linux, macOS, and Windows, including a fresh-tarball import smoke test.

## 0.3.0-alpha.1 - 2026-07-16
- Add the v0.3 JSON Schema type profile, collection semantics, lifecycle behavior, CEL bindings, canonical diagnostics, and canonical operation envelopes.
- Add portable runtime contracts, provider registry composition, policy checks, event/action validation, and materialization helpers.
- Add report-first v0.2-to-v0.3 type and collection migration with source hashes, backups, validation, and recovery.
- Retain explicit v0.2 loading and initialization through a compatibility adapter.
- Make new collections and the built-in profiler use v0.3 by default.
- Ship a machine-readable conformance claim and shared-fixture evidence.

## 0.2.2 - 2026-02-28
- Add a built-in performance profiler (`mdb-profile`, `npm run profile`, `scripts/profile.sh`) for repeatable latency/throughput benchmarking on synthetic large collections.
- Refactor query execution into a dedicated query engine with shared file caches to reduce repeated parsing and resolver setup.
- Add link/backlink indexing and token-based backlink acceleration to cut repeated collection-wide scans during query/filter evaluation.
- Speed up rename/update_refs and uniqueness validation paths with precomputed lookup indexes and cache-aware scans.
- Tighten runtime cache invalidation paths so mutating operations invalidate only the necessary layers.

## 0.2.0 - 2026-02-03
- Update config/version handling for mdbase spec 0.2.x, including `migrations_folder`.
- Add `backfill` and `migrate` operations for v0.2.0 migrations.
- Allow collection open to tolerate future minor versions with warnings (conformance harness).
- Exclude migration manifests from type loading and record scans.
- Refresh docs and conformance defaults for 0.2.0.
