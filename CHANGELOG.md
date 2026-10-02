# Changelog

## Unreleased

- YAML document records (mdbase spec `b3883f9`): a record's format is fixed by
  its extension, and `.base` files listed in `record_extensions` are records
  whose whole file is the frontmatter, with no body. A body for such a record
  is `invalid_request`. `mdbase.lock.yaml` is never a record.
- `update` accepts `document`, the complete candidate source in the record's
  format; it replaces frontmatter and body, can repair non-mapping
  frontmatter, and is written exactly as supplied when lifecycle policy leaves
  it unchanged. It cannot be combined with `patch`, `unset`, or `body`.

- Identify saved views through the `mdbase.view` record contract. Listing and
  execution resolve a record's single implementing type, project its contract
  view, and validate the canonical view shape, so an implementing type may use
  any name, match rule, and field mapping. `type: view` records without an
  implementing type are no longer views.

- Seed-type upgrades (mdbase spec chapter 05a): a seed `type` resource may
  declare `upgrade_from: { digest, document }`, the exact previous starter
  pinned by digest. Packs using it are no longer rejected as
  `invalid_type_pack`; `upgrade_from` on any other kind or mode, or with a
  digest that does not match its document, is. When the seed target exists
  and is not preserved, assessment plans it like mdbase-rs: a seed already
  holding the desired starter is `preserve`d, an unedited previous starter is
  an `update` to the desired starter byte-for-byte, and an edited seed gets
  the conservative three-way merge (baseline, live, desired) as an `update`,
  or a `conflict` naming the competing setting. The diff `digest` is the
  planned document's digest, so the merge result is covered by the
  assessment digest; the lock records the desired starter's digest.
- A seed whose pack source was renamed keeps its installed target identity,
  so a user-deleted seed type is not recreated, and a retained target is no
  longer also listed for retirement under its old source.

## 0.3.0-rc.7 - 2026-09-27

Implements mdbase spec v0.3.0-rc.4.

- Evaluate expressions with standard CEL (`@marcbachmann/cel-js`): missing
  fields are null, selection on null is an error, optional types, `has()`,
  string dates with the date helpers, and `lower()`/`upper()`.
- Resolve links relative to the record they were read from, including `this`
  and `asFile()` results; `file.links` holds alias-free link values.
- Update takes `patch` and `unset`; the `fields` and `frontmatter` aliases are
  rejected. Structured updates refuse non-mapping frontmatter.
- Add atomic batches with `allow_partial` and `dry_run`, staged outside the
  collection and committed under a recovery journal. Record writes replace
  files atomically.
- Validation defaults to `error`; reads report record issues at the configured
  level and warn-level writes report warnings.
- Ordered lifecycle actions with typed guards; `on_delete`, `on_rename`, and
  type-file `migrations` are rejected.
- v0.3 discovery: built-in exclusions, portable globs, no `include_subfolders`.
  Wikilinks resolve by ID only when `id_field` is configured.
- Version requirements for `implements`, display-free implementation digests,
  one implementation per contract ID, and `unsupported_feature` warnings for
  collection projections.
- v0.2 configuration migration follows spec Chapter 13.
- Claim the `data_contracts` and `type_packs` profiles.

## 0.3.0-rc.6 - 2026-09-14

- Use ordinary deterministic link resolution for rename references instead of
  treating all duplicate basenames as ambiguous.
- Validate all inferred memberships on selected-type creation without forcing
  declaration fields in inference-only collections. Keep ordinary `type` data.
- Check final persisted membership after path derivation and serialization
  filtering; propagate create-time CEL matching errors rather than ignoring them.
- Explicitly declared v0.3 creates no longer also need to satisfy inferred rules.

## 0.3.0-rc.5 - 2026-08-07

- Install and evolve data-contract type packs through reviewed, atomic
  transactions with conflict detection and recovery.
- Execute date and datetime expressions in an explicit query timezone and
  validate durable collection timezone authority.
- Verify shared contract consumption through the specification-owned portable
  testbed and the frozen mdbase `0.3.0-rc.3` artifacts.

## 0.3.0-rc.4 - 2026-07-29

- Remove the parallel runtime contract registry, implicit contracts,
  proprietary event-envelope validation, materialization helpers, and
  collection-level workflow preflight.
- Keep canonical core-schema validation in the core package instead of taking
  a dependency on the runtime companion.
- Remove the superseded `runtime.contract_mode` and type-file runtime section;
  old collection config receives direct runtime 0.2 migration guidance.
- Leave durable admission and execution to the separately claimable runtime
  0.2 companion built on core contracts and event/action interoperability.

## 0.3.0-rc.3 - 2026-07-28

- Make `mdbase.contract` a discriminated `record`, `event`, or `action`
  artifact with subject-specific JSON Schemas.
- Add first-class record data contracts, normalized projections, transactional
  type-pack artifacts, and standard JSON Pointer field mappings.
- Restrict type-file `implements` entries to record contracts while allowing
  several types to implement and expose the same normalized record interface.
- Remove the legacy Runtime Contracts conformance claim pending its rebuild on
  the portable event/action interoperability profile.

## 0.3.0-rc.2 - 2026-07-28

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
- Cache compiled CEL programs in a bounded LRU and skip collection-wide
  uniqueness scans when a write supplies no constrained value.
- Separate query, structured-filter, link-resolution, filesystem-scanning, and
  runtime-cache policy from the public collection facade.
- Add deterministic warm-cache equivalence and focused resolver/scanner/cache
  stress coverage alongside the packaged E2E suite.

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
