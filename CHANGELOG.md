# Changelog

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
