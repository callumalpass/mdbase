/**
 * Collection - the main entry point for mdbase operations.
 * Ties together config loading, type loading, file reading, and validation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { dump } from "js-yaml";
import { validateCanonicalSchema } from "@callumalpass/mdbase-runtime";
import picomatch from "picomatch";
import { ulid } from "ulid";
import {
  getFieldReferenceValue,
  getFieldReferenceValues,
  setFieldReferenceValue,
} from "../field-references.js";
import {
  isSupportedV03SpecVersion,
  LEGACY_SPEC_VERSION,
  loadConfigAsync,
  MdbaseConfig,
  SUPPORTED_SPEC_VERSION,
} from "../config/loader.js";
import { loadTypesAsync, TypeDefinition, FieldDefinition, MatchRules } from "../types/loader.js";
import {
  DataContractRegistry,
  type ContractViewResult,
  type DataContractDefinition,
  type DataContractImplementationDescriptor,
} from "../data-contracts/registry.js";
import { parseFileAsync, serializeFile } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../validation/validator.js";
import { MdbaseError } from "../errors.js";
import { evaluateExpression } from "../expressions/evaluator.js";
import { evaluateMdbaseCel } from "../expressions/cel.js";
import { extractBodyLinks, parseLink, ParsedLink } from "../links/parser.js";
import { BacklinkEntry } from "../expressions/evaluator.js";
import { CacheStoreAsync, CachedFile } from "../cache/async-store.js";
import { QueryInput, runQuery } from "./query-engine.js";
import { CollectionOptions, OperationObserver } from "../observability.js";
import type {
  BackfillInput,
  BatchDeleteInput,
  BatchResult,
  BatchResultDetail,
  BatchUpdateInput,
  CacheOpResult,
  CreateInput,
  CreateResult,
  CreateTypeInput,
  DeleteOptions,
  DeleteResult,
  QueryGroupResult,
  QueryResult,
  ReadResult,
  RenameInput,
  TypeMigrationEntry,
  UpdateResult,
  UpdateInput,
  V03CreateInput,
  V03DeleteInput,
  V03Diagnostic,
  V03OperationResult,
  V03ReadInput,
  V03RenameInput,
  V03UpdateInput,
  V03ValidateInput,
  ValidateResult,
} from "./contracts.js";
import {
  CanonicalQueryInput,
  CanonicalQueryResult,
  ExecuteViewInput,
  SavedViewListResult,
  executeCanonicalQuery,
  executeCanonicalView,
  listCanonicalViews,
} from "./canonical-query.js";
import { buildLinkIndex, IndexedReadResult } from "./link-index.js";
import { LinkResolutionIndex, LinkResolver } from "./link-resolver.js";
import { CollectionScanner } from "./collection-scanner.js";
import {
  BacklinkTokenIndex,
  CollectionRuntimeCache,
  RuntimeCacheInvalidation,
} from "./runtime-cache.js";
import {
  evaluateStructuredWhere as evaluateWhereClause,
  matchesFieldConditions,
} from "./structured-where.js";
import {
  buildRuntimePackage,
  composeRuntimeRegistry,
  LoadRuntimeContractsOptions,
  preflightRuntimeWorkflows,
  RuntimeMarkdownRecord,
  RuntimePackage,
  RuntimeRegistry,
  RuntimeValidationResult,
} from "../runtime/contracts.js";
import { recoverInterruptedTypePackTransactions } from "../type-packs/recovery.js";

export type {
  BatchResult,
  BatchResultDetail,
  CacheOpResult,
  CreateResult,
  DeleteResult,
  QueryGroupResult,
  QueryResult,
  ReadResult,
  TypeMigrationEntry,
  UpdateResult,
  V03CreateInput,
  V03DeleteInput,
  V03Diagnostic,
  V03OperationResult,
  V03ReadInput,
  V03RenameInput,
  V03UpdateInput,
  V03ValidateInput,
  ValidateResult,
} from "./contracts.js";

const DEFAULT_SPEC_VERSION = SUPPORTED_SPEC_VERSION;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeInitTypesFolder(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const invalid = normalized.length === 0 ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..");
  if (invalid) {
    throw new Error("settings.types_folder must be a non-empty relative path without traversal segments");
  }
  return segments.join("/");
}

export class Collection {
  private config: MdbaseConfig;
  private typeDefs: Map<string, TypeDefinition>;
  private cache: CacheStoreAsync | null;
  private readonly runtimeCache: CollectionRuntimeCache<ReadResult>;
  private readonly observer: OperationObserver;
  private readonly linkResolver: LinkResolver;
  private readonly scanner: CollectionScanner;
  private readonly dataContracts: DataContractRegistry;

  /**
   * Hook called after reading a file but before writing.
   * Used by test runner to simulate concurrent modifications.
   */
  public preWriteHook?: (relativePath: string) => void;

  /**
   * Set of paths that should simulate I/O errors when writing.
   * Used by test runner to simulate I/O failures.
   */
  public ioErrorPaths?: Set<string>;

  /**
   * When true, batch operations skip files that depend on failed files.
   */
  public skipDependents?: boolean;

  constructor(
    private root: string,
    config: MdbaseConfig,
    typeDefs: Map<string, TypeDefinition>,
    options: CollectionOptions = {},
    dataContracts: DataContractRegistry = DataContractRegistry.empty(),
  ) {
    this.config = config;
    this.typeDefs = typeDefs;
    this.dataContracts = dataContracts;
    this.cache = null;
    this.runtimeCache = new CollectionRuntimeCache();
    this.observer = new OperationObserver(options.observability);
    this.linkResolver = new LinkResolver({
      idField: config.settings.id_field,
      recordExtensions: config.settings.record_extensions,
    });
    this.scanner = new CollectionScanner({
      root,
      exclude: config.settings.exclude,
      recordExtensions: config.settings.record_extensions,
      includeSubfolders: config.settings.include_subfolders,
      typesFolder: config.settings.types_folder,
      contractsFolder: config.settings.contracts_folder,
      cacheFolder: config.settings.cache_folder,
      migrationsFolder: config.settings.migrations_folder,
    });
  }

  /** Return the canonical v0.3 operation surface for this collection. */
  v03Operations(): V03Operations {
    if (this.config.spec_profile !== "v0.3") {
      throw new V03ProfileError({
        severity: "error",
        code: "unsupported_profile",
        message: "The v0.3 operation facade requires a v0.3 collection.",
        path: "mdbase.yaml",
      });
    }
    return new V03Operations(this);
  }

  private isInvalidRelativePath(relativePath: string): boolean {
    const normalizedPath = relativePath.replace(/\\/g, "/");
    return normalizedPath.includes("\0") ||
      path.isAbsolute(relativePath) ||
      normalizedPath.startsWith("/") ||
      normalizedPath.split("/").includes("..");
  }

  private invalidateRuntimeCaches(options?: RuntimeCacheInvalidation): void {
    this.runtimeCache.invalidate(options);
  }

  static async init(
    collectionRoot: string,
    input?: Record<string, unknown>,
    options: CollectionOptions = {},
  ): Promise<Record<string, unknown>> {
    const observer = new OperationObserver(options.observability);
    return await observer.trace(
      "collection.init",
      { root: path.resolve(collectionRoot) },
      () => this.initUnobserved(collectionRoot, input),
    );
  }

  private static async initUnobserved(
    collectionRoot: string,
    input?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const suppliedConfig = input?.config;
    if (suppliedConfig !== undefined && !isPlainObject(suppliedConfig)) {
      throw new Error("config must be a mapping");
    }

    const config: Record<string, unknown> = suppliedConfig
      ? { ...suppliedConfig }
      : {};
    const suppliedSettings = config.settings;
    if (suppliedSettings !== undefined && !isPlainObject(suppliedSettings)) {
      throw new Error("config.settings must be a mapping");
    }
    const settings: Record<string, unknown> = suppliedSettings
      ? { ...suppliedSettings }
      : {};

    const requestedVersion = config.spec_version === undefined
      ? DEFAULT_SPEC_VERSION
      : String(config.spec_version);
    const isLegacyV02 = /^0\.2(?:\.\d+)?$/.test(requestedVersion);
    if (!isSupportedV03SpecVersion(requestedVersion) && !isLegacyV02) {
      throw new Error(
        `Unsupported spec version: ${requestedVersion} (supported: ${SUPPORTED_SPEC_VERSION}; legacy adapter: 0.2.x)`,
      );
    }
    config.spec_version = requestedVersion === "0.2" ? LEGACY_SPEC_VERSION : requestedVersion;

    const requestedTypesFolder = input?.types_folder ?? settings.types_folder ?? "_types";
    if (typeof requestedTypesFolder !== "string") {
      throw new Error("settings.types_folder must be a string");
    }
    const typesFolder = normalizeInitTypesFolder(requestedTypesFolder);
    if (input?.types_folder !== undefined || settings.types_folder !== undefined || typesFolder !== "_types") {
      settings.types_folder = typesFolder;
    }
    const requestedContractsFolder = input?.contracts_folder ?? settings.contracts_folder ?? "_contracts";
    if (typeof requestedContractsFolder !== "string") {
      throw new Error("settings.contracts_folder must be a string");
    }
    const contractsFolder = normalizeInitTypesFolder(requestedContractsFolder);
    if (contractsFolder === typesFolder) {
      throw new Error("settings.contracts_folder must differ from settings.types_folder");
    }
    if (
      input?.contracts_folder !== undefined ||
      settings.contracts_folder !== undefined ||
      contractsFolder !== "_contracts"
    ) {
      settings.contracts_folder = contractsFolder;
    }
    if (Object.keys(settings).length > 0) {
      config.settings = settings;
    }

    if (!isLegacyV02) {
      const canonicalConfig = requestedVersion === SUPPORTED_SPEC_VERSION
        ? config
        : { ...config, spec_version: SUPPORTED_SPEC_VERSION };
      const validation = validateCanonicalSchema("config", canonicalConfig);
      if (!validation.valid) {
        const details = validation.errors
          .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
          .join("; ");
        throw new Error(`Invalid v0.3 config: ${details}`);
      }
    }

    const configPath = path.join(collectionRoot, "mdbase.yaml");
    const typesFolderPath = path.join(collectionRoot, ...typesFolder.split("/"));
    const contractsFolderPath = path.join(collectionRoot, ...contractsFolder.split("/"));
    const metaTypePath = path.join(typesFolderPath, "meta.md");
    const configContent = `${dump(config, {
      noRefs: true,
      lineWidth: 100,
      sortKeys: false,
      quotingType: '"',
    }).trimEnd()}\n`;

    await fs.promises.mkdir(collectionRoot, { recursive: true });
    try {
      await fs.promises.writeFile(configPath, configContent, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`mdbase.yaml already exists in ${collectionRoot}`);
      }
      throw error;
    }

    await fs.promises.mkdir(typesFolderPath, { recursive: true });
    await fs.promises.mkdir(contractsFolderPath, { recursive: true });
    if (!isLegacyV02) {
      return {
        config_path: "mdbase.yaml",
        types_folder: typesFolder,
        contracts_folder: contractsFolder,
      };
    }

    // v0.2 collections retain the generated meta type required by that profile.
    const metaContent = `---
name: meta
description: >
  Schema for type definition files. Each markdown file in the types folder
  defines a type with match rules, field definitions, and validation settings.

match:
  path_glob: "${typesFolder}/**/*.md"

strict: false

fields:
  name:
    type: string
    required: true
    description: >
      Type name. Must be lowercase alphanumeric with hyphens/underscores,
      matching pattern ^[a-z][a-z0-9_-]{0,63}$. Cannot be "file", "formula",
      or "this". Should match the filename without extension.

  description:
    type: string
    description: Human-readable description of the type's purpose.

  version:
    type: integer
    description: Positive integer for schema versioning (informational only).

  extends:
    type: string
    description: >
      Parent type name for inheritance. Child inherits fields, strictness,
      display_name_key, path_pattern, and match rules from parent. Child
      properties fully override (no merging) when explicitly set.

  strict:
    type: enum
    values: ["true", "false", "warn"]
    description: >
      Validation strictness for unknown fields. "true" rejects unknown fields,
      "warn" allows but warns, "false" allows silently. Inherited from parent
      if not set, otherwise falls back to settings.default_strict.

  display_name_key:
    type: string
    description: >
      Field name to use as human-readable label for files of this type.
      Falls back to file.basename if missing or empty. Inherited from parent.

  match:
    type: object
    description: >
      Rules for automatically matching files to this type. All conditions
      are combined with AND logic. Only path_glob, fields_present, and where
      are valid — other properties are silently ignored.
    fields:
      path_glob:
        type: string
        description: >
          Glob pattern matched against file paths relative to collection root.
          Supports * (any chars except /), ** (any chars including /), and ?
          (single char). Example: "plans/**".
      fields_present:
        type: list
        description: >
          List of frontmatter field names that must all be present and non-null
          for a file to match this type.
      where:
        type: object
        description: >
          Field-value conditions that must all match. Keys are field names,
          values are either direct values (exact equality) or operator objects
          with keys like eq, neq, gt, gte, lt, lte, contains, containsAll,
          containsAny, startsWith, endsWith, matches, exists. Computed fields
          are not available for matching.

  path_pattern:
    type: string
    description: >
      Pattern for validating and generating file paths. Uses {fieldName}
      placeholders. Cannot reference computed fields or file.* generated
      fields.

  filename_pattern:
    type: string
    deprecated: true
    description: Deprecated alias for path_pattern. Use path_pattern instead.

  fields:
    type: any
    description: >
      Mapping of field names to field definitions. Each field definition is an
      object with: type (required — string, integer, number, boolean, date,
      datetime, time, enum, list, object, link, any), required (boolean),
      default (value), description (string), deprecated (boolean), unique
      (boolean), computed (expression string, mutually exclusive with required/
      default/generated), generated (strategy — "ulid", "uuid", "sequence",
      "now", "now_on_write", or object with random/sequence/from+transform).
      Type-specific constraints: string (min_length, max_length, pattern),
      integer/number (min, max), enum (values — required, non-empty string
      list), list (items — required field definition, min_items, max_items,
      unique), object (fields — required nested field mapping), link (target
      type name, validate_exists).
---
`;
    await fs.promises.writeFile(metaTypePath, metaContent);

    return {
      config_path: "mdbase.yaml",
      types_folder: typesFolder,
      meta_type_path: path.posix.join(typesFolder.replaceAll("\\", "/"), "meta.md"),
    };
  }

  static async open(
    collectionRoot: string,
    options: CollectionOptions = {},
  ): Promise<{ collection?: Collection; error?: { code: string; message: string } }> {
    const observer = new OperationObserver(options.observability);
    return await observer.trace(
      "collection.open",
      { root: path.resolve(collectionRoot) },
      async () => {
        if (!options.skipTypePackRecovery) {
          await recoverInterruptedTypePackTransactions(collectionRoot);
        }
        const configResult = await loadConfigAsync(collectionRoot, { allowFutureMinor: true });
        if (!configResult.valid || !configResult.config) {
          return { error: configResult.error };
        }

        const typesResult = await loadTypesAsync(collectionRoot, configResult.config);
        if (!typesResult.valid) {
          return { error: typesResult.error };
        }

        const dataContractsResult = await DataContractRegistry.load(
          collectionRoot,
          configResult.config,
          typesResult.types!,
        );
        if (!dataContractsResult.valid || !dataContractsResult.registry) {
          return { error: dataContractsResult.error };
        }

        const collection = new Collection(
          collectionRoot,
          configResult.config,
          typesResult.types!,
          options,
          dataContractsResult.registry,
        );
        await collection.initCache();
        return { collection };
      },
    );
  }

  private async initCache(): Promise<void> {
    this.cache = await CacheStoreAsync.open(this.root, this.config.settings.cache_folder);
  }

  /** List every local data contract in canonical ID/version order. */
  listDataContracts(): DataContractDefinition[] {
    return this.dataContracts.listContracts();
  }

  /** Return the explicit, canonically ordered implementation set for one exact contract. */
  getDataContractImplementations(
    contract: string,
    version: string,
  ): DataContractImplementationDescriptor[] {
    return this.dataContracts.getImplementations(contract, version);
  }

  /** Project one record through one exact implementing type and validate the normalized view. */
  async getContractView(
    relativePath: string,
    contract: string,
    version: string,
    typeName?: string,
  ): Promise<ContractViewResult> {
    const readResult = await this.read(relativePath);
    if (readResult.error) {
      return {
        valid: false,
        contract,
        version,
        contract_digest: "",
        type: typeName ?? "",
        implementation_digest: "",
        view: {},
        diagnostics: [{
          code: readResult.error.code,
          message: readResult.error.message,
          severity: "error",
          path: relativePath,
        }],
      };
    }
    const candidates = (readResult.types ?? []).filter((candidate) =>
      this.dataContracts
        .getImplementations(contract, version)
        .some((implementation) => implementation.type === candidate),
    );
    const selectedType = typeName ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!selectedType) {
      return {
        valid: false,
        contract,
        version,
        contract_digest: "",
        type: "",
        implementation_digest: "",
        view: {},
        diagnostics: [{
          code: candidates.length === 0
            ? "data_contract_implementation_not_found"
            : "data_contract_implementation_ambiguous",
          message: candidates.length === 0
            ? `Record "${relativePath}" has no type implementing "${contract}" ${version}`
            : `Record "${relativePath}" matches multiple implementations of "${contract}" ${version}; select one type explicitly: ${candidates.join(", ")}`,
          severity: "error",
          path: relativePath,
        }],
      };
    }
    if (!candidates.includes(selectedType)) {
      return {
        valid: false,
        contract,
        version,
        contract_digest: "",
        type: selectedType,
        implementation_digest: "",
        view: {},
        diagnostics: [{
          code: "data_contract_implementation_not_found",
          message: `Record "${relativePath}" does not match implementing type "${selectedType}"`,
          severity: "error",
          path: relativePath,
        }],
      };
    }
    const result = this.dataContracts.project(
      selectedType,
      contract,
      version,
      readResult.frontmatter ?? {},
    );
    for (const diagnostic of result.diagnostics) diagnostic.path = relativePath;
    return result;
  }

  /**
   * Check if a path is excluded by config.
   */
  private isExcluded(relativePath: string): boolean {
    return this.scanner.isExcluded(relativePath);
  }

  /**
   * Check if a file has a valid markdown extension.
   */
  private isMarkdownFile(filePath: string): boolean {
    return this.scanner.isRecordFile(filePath);
  }

  private async fileExists(fullPath: string): Promise<boolean> {
    try {
      await fs.promises.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the file types declared explicitly in frontmatter.
   */
  private getExplicitTypes(frontmatter: Record<string, unknown>): string[] | null {
    // Check array-valued keys first (types takes precedence over type)
    for (const key of this.config.settings.explicit_type_keys) {
      if (key in frontmatter) {
        const val = frontmatter[key];
        if (Array.isArray(val)) {
          return val.map((v) => String(v).toLowerCase());
        }
      }
    }
    // Then check singular string-valued keys
    for (const key of this.config.settings.explicit_type_keys) {
      if (key in frontmatter) {
        const val = frontmatter[key];
        if (typeof val === "string") {
          return [val.toLowerCase()];
        }
      }
    }
    return null;
  }

  /**
   * Get the file types declared in frontmatter (backwards compatible).
   */
  private getFileTypes(frontmatter: Record<string, unknown>): string[] {
    return this.getExplicitTypes(frontmatter) ?? [];
  }

  /**
   * Determine all types for a file, using explicit declarations or match rules.
   * If explicit types are declared, they take precedence and match rules are skipped.
   */
  getTypesForFile(relativePath: string, frontmatter: Record<string, unknown>): string[] {
    // Check for explicit type declaration
    const explicit = this.getExplicitTypes(frontmatter);
    if (explicit !== null) {
      // Explicit types stop all match rule evaluation
      return explicit;
    }

    // Evaluate match rules for all type definitions
    const matchedTypes: string[] = [];
    for (const [typeName, typeDef] of this.typeDefs) {
      if (!typeDef.match) continue;
      if (this.matchesType(relativePath, frontmatter, typeDef)) {
        matchedTypes.push(typeName);
      }
    }
    return matchedTypes;
  }

  /**
   * Check if a file matches all conditions in a type's match block.
   * All conditions are AND'd together.
   */
  private matchesType(
    relativePath: string,
    frontmatter: Record<string, unknown>,
    typeDef: TypeDefinition,
  ): boolean {
    const match = typeDef.match!;
    // path_glob
    if (match.path_glob !== undefined) {
      const patterns = Array.isArray(match.path_glob) ? match.path_glob : [match.path_glob];
      if (!patterns.some((pattern) => picomatch(pattern, { dot: true })(relativePath))) {
        return false;
      }
    }

    // fields_present - all listed fields must be present and non-null
    if (match.fields_present !== undefined) {
      for (const field of match.fields_present) {
        const value = getFieldReferenceValue(frontmatter, field);
        if (!value.present || value.value === null || value.value === undefined) {
          return false;
        }
      }
    }

    // where - all conditions must match
    if (match.where !== undefined) {
      if (!matchesFieldConditions(frontmatter, match.where, this.config.spec_profile)) return false;
    }

    if (match.expr !== undefined) {
      const result = evaluateMdbaseCel(match.expr.$expr, {
        record: frontmatter,
        raw: frontmatter,
        knownFields: this.getTypeFieldNames(typeDef),
        file: this.buildMatchFileBinding(relativePath),
      });
      if (result.diagnostics.length > 0) return false;
      return result.value === true;
    }

    return true;
  }

  private getTypeFieldNames(typeDef: TypeDefinition): string[] {
    const schemaProperties = typeDef.schema?.value?.properties;
    return [
      ...Object.keys(typeDef.fields ?? {}),
      ...(schemaProperties !== null && typeof schemaProperties === "object" && !Array.isArray(schemaProperties)
        ? Object.keys(schemaProperties)
        : []),
    ];
  }

  private buildMatchFileBinding(relativePath: string): Record<string, unknown> {
    const name = path.posix.basename(relativePath);
    const extension = path.posix.extname(name).replace(/^\./, "");
    const folder = path.posix.dirname(relativePath);
    return {
      path: relativePath,
      name,
      basename: extension ? name.slice(0, -(extension.length + 1)) : name,
      extension,
      folder: folder === "." ? "" : folder,
    };
  }

  /**
   * Read a file from the collection.
   */
  async read(relativePath: string): Promise<ReadResult> {
    return await this.observer.trace(
      "collection.read",
      { path: relativePath },
      () => this.readUnobserved(relativePath),
    );
  }

  private async readUnobserved(relativePath: string): Promise<ReadResult> {
    if (this.isInvalidRelativePath(relativePath)) {
      return {
        error: { code: "invalid_path", message: `Invalid path: ${relativePath}` },
      };
    }

    // Check if excluded
    if (this.isExcluded(relativePath)) {
      return {
        error: { code: "file_not_found", message: `Path is excluded: ${relativePath}` },
      };
    }

    // Check include_subfolders
    if (!this.config.settings.include_subfolders && relativePath.includes("/")) {
      return {
        error: { code: "file_not_found", message: `Subfolders not included: ${relativePath}` },
      };
    }

    // Check if it's a markdown file
    if (!this.isMarkdownFile(relativePath)) {
      return {
        error: { code: "file_not_found", message: `Not a markdown file: ${relativePath}` },
      };
    }

    const fullPath = path.join(this.root, relativePath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      return {
        error: { code: "file_not_found", message: `File not found: ${relativePath}` },
      };
    }

    // Check for nested collection boundary
    const parts = relativePath.split("/");
    for (let i = 1; i < parts.length; i++) {
      const subdir = path.join(this.root, ...parts.slice(0, i));
      try {
        await fs.promises.access(path.join(subdir, "mdbase.yaml"));
        return {
          error: { code: "file_not_found", message: `File is inside nested collection: ${relativePath}` },
        };
      } catch {
        // ok
      }
    }

    // Check for mdbase.yaml - it's not a record
    if (path.basename(relativePath) === "mdbase.yaml") {
      return {
        error: { code: "file_not_found", message: "mdbase.yaml is not a record" },
      };
    }

    const revision = await computeRevision(fullPath);

    let parsed: Awaited<ReturnType<typeof parseFileAsync>>;
    let cached: CachedFile | null = null;
    if (this.cache) {
      cached = await this.cache.getFile(relativePath, stat);
    }
    if (cached) {
      parsed = {
        frontmatter: cached.frontmatter,
        body: cached.body,
        raw: "",
      };
    } else {
      try {
        parsed = await parseFileAsync(fullPath);
      } catch (e: unknown) {
        // YAML parse errors are always errors regardless of validation level
        return {
          error: { code: "invalid_frontmatter", message: (e as Error).message },
        };
      }
    }

    // Handle parse errors
    if (parsed.error) {
      // Fatal YAML syntax errors are always errors regardless of validation level
      if (parsed.fatalError) {
        return { error: parsed.error };
      }
      if (this.config.settings.default_validation === "off") {
        // At "off" level: treat as empty frontmatter, return valid
        const file = {
          name: path.basename(relativePath),
          folder: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
          path: relativePath,
          mtime: stat.mtime.toISOString(),
          size: stat.size,
        };
        return {
          valid: true,
          frontmatter: {},
          body: parsed.body,
          types: [],
          file,
          revision,
        };
      }
      if (this.config.settings.default_validation === "warn") {
        // At "warn" level: treat as empty with warning
        const file = {
          name: path.basename(relativePath),
          folder: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
          path: relativePath,
          mtime: stat.mtime.toISOString(),
          size: stat.size,
        };
        return {
          valid: true,
          frontmatter: {},
          body: parsed.body,
          types: [],
          warnings: [{ code: "invalid_frontmatter", message: parsed.error.message }],
          file,
          revision,
        };
      }
      // At "error" level: return error
      return {
        error: parsed.error,
      };
    }

    const types = this.getTypesForFile(relativePath, parsed.frontmatter);

    // Keep raw frontmatter (before defaults) for hasProperty checks
    const rawFrontmatter = { ...parsed.frontmatter };

    // Apply defaults from type definitions
    const frontmatter = { ...parsed.frontmatter };
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (typeDef?.fields) {
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          if (fieldDef.default !== undefined && !(fieldName in frontmatter)) {
            frontmatter[fieldName] = fieldDef.default;
          }
        }
      }
    }
    this.applyV03ReadDefaults(frontmatter, types);

    // Coerce values based on type definitions
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;

      for (const [key, value] of Object.entries(frontmatter)) {
        if (this.config.settings.explicit_type_keys.includes(key)) continue;
        const fieldDef = typeDef.fields[key];
        if (!fieldDef || value === null || value === undefined) continue;

        frontmatter[key] = coerceForRead(value, fieldDef);
      }
    }

    if (!cached && this.cache) {
      await this.cache.upsertFile(relativePath, stat, parsed.frontmatter, parsed.body ?? "");
    }

    // Coerce remaining Date objects not handled by type definitions
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value instanceof Date) {
        frontmatter[key] = value.toISOString();
      }
    }

    // Evaluate computed fields
    this.evaluateComputedFields(frontmatter, types, relativePath, parsed.body);

    // Get file metadata
    const file = {
      name: path.basename(relativePath),
      folder: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
      path: relativePath,
      mtime: stat.mtime.toISOString(),
      ctime: stat.birthtime.toISOString(),
      size: stat.size,
    };

    return {
      valid: true,
      frontmatter,
      rawFrontmatter,
      body: parsed.body,
      types,
      file,
      revision,
    };
  }

  /**
   * Evaluate computed fields from type definitions and add to frontmatter.
   * Computed fields are NOT persisted to disk — they exist only in read results.
   * Supports dependency ordering: computed fields can reference other computed fields.
   */
  private evaluateComputedFields(
    frontmatter: Record<string, unknown>,
    types: string[],
    relativePath: string,
    body?: string,
  ): void {
    // Collect all computed fields from types
    const computedDefs: Map<string, string> = new Map();
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.computed) {
          computedDefs.set(fieldName, fieldDef.computed);
        }
      }
    }
    if (computedDefs.size === 0) return;

    // Resolve in dependency order (simple: iterate multiple times until stable)
    const resolved = new Map<string, unknown>();
    const maxPasses = computedDefs.size + 1;
    for (let pass = 0; pass < maxPasses; pass++) {
      let progress = false;
      for (const [fieldName, expr] of computedDefs) {
        if (resolved.has(fieldName)) continue;
        try {
          const result = evaluateExpression(expr, {
            frontmatter: { ...frontmatter, ...Object.fromEntries(resolved) },
            path: relativePath,
            types,
            body,
            computedFields: resolved,
            typeDefs: this.typeDefs as unknown as Map<string, { display_name_key?: string; [key: string]: unknown }>,
          });
          resolved.set(fieldName, result);
          progress = true;
        } catch {
          // May fail if dependencies not yet resolved, try again next pass
        }
      }
      if (!progress) break;
    }

    // Add resolved computed values to frontmatter
    for (const [fieldName, value] of resolved) {
      frontmatter[fieldName] = value;
    }
  }

  private applyV03ReadDefaults(frontmatter: Record<string, unknown>, types: string[]): void {
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      const defaults = typeDef?.collection?.read_defaults;
      if (!defaults) continue;
      for (const [fieldName, value] of Object.entries(defaults)) {
        if (!(fieldName in frontmatter)) {
          frontmatter[fieldName] = cloneJsonLike(value);
        }
      }
    }
  }

  private applyV03Lifecycle(
    types: string[],
    event: "on_create" | "on_update",
    frontmatter: Record<string, unknown>,
    context: { oldFrontmatter?: Record<string, unknown>; relativePath?: string } = {},
  ): MdbaseError[] {
    const issues: MdbaseError[] = [];
    const assignments = new Map<string, {
      value: unknown;
      typeName: string;
      lifecyclePath: string;
    }>();

    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      const eventPolicy = typeDef?.lifecycle?.[event];
      if (!eventPolicy) continue;
      const actions = Array.isArray(eventPolicy) ? eventPolicy : [eventPolicy];
      for (const [index, action] of actions.entries()) {
        if (action.if) {
          const guard = evaluateMdbaseCel(action.if, {
            record: frontmatter,
            raw: frontmatter,
            old: context.oldFrontmatter ?? {},
            operation: {
              event,
              path: context.relativePath,
            },
          });
          if (guard.diagnostics.length > 0) {
            issues.push({
              code: "lifecycle_expression_error",
              message: `Lifecycle guard on ${typeName}.${event}[${index}] failed: ${guard.diagnostics[0].message}`,
              severity: "error",
            });
            continue;
          }
          if (guard.value !== true) {
            continue;
          }
        }
        for (const [fieldPath, lifecycleValue] of Object.entries(action.set)) {
          const value = this.evaluateLifecycleValue(lifecycleValue, frontmatter, context);
          const lifecyclePath = `${typeName}.lifecycle.${event}[${index}].set.${fieldPath}`;
          if (assignments.has(fieldPath)) {
            const previous = assignments.get(fieldPath)!;
            if (JSON.stringify(previous.value) !== JSON.stringify(value)) {
              issues.push({
                code: "type_conflict",
                message: `Conflicting lifecycle assignments for "${fieldPath}": ${previous.lifecyclePath} and ${lifecyclePath}`,
                field: fieldPath,
                type: `${previous.typeName},${typeName}`,
                severity: "error",
              });
              continue;
            }
          }
          assignments.set(fieldPath, { value, typeName, lifecyclePath });
        }
      }
    }

    if (issues.some((issue) => issue.severity === "error" || !issue.severity)) {
      return issues;
    }

    for (const [fieldPath, assignment] of assignments) {
      try {
        setFieldReferenceValue(frontmatter, fieldPath, assignment.value);
      } catch (error) {
        issues.push({
          code: "invalid_lifecycle_path",
          message: (error as Error).message,
          field: fieldPath,
          severity: "error",
        });
      }
    }
    return issues;
  }

  private evaluateLifecycleValue(
    lifecycleValue: unknown,
    frontmatter: Record<string, unknown>,
    context: { oldFrontmatter?: Record<string, unknown>; relativePath?: string },
  ): unknown {
    if (!lifecycleValue || typeof lifecycleValue !== "object" || Array.isArray(lifecycleValue)) {
      return lifecycleValue;
    }
    const value = lifecycleValue as Record<string, unknown>;
    if (value.now === true) return new Date().toISOString();
    if (value.today === true) return new Date().toISOString().slice(0, 10);
    if (value.uuid === true) return crypto.randomUUID();
    if (value.ulid === true) return ulid();
    if (typeof value.slugify === "string") {
      const source = getFieldReferenceValue(frontmatter, value.slugify).value;
      return source === null || source === undefined ? null : slugify(String(source));
    }
    if (typeof value.copy === "string") {
      return cloneJsonLike(getFieldReferenceValue(frontmatter, value.copy).value);
    }
    if ("literal" in value) return cloneJsonLike(value.literal);
    return undefined;
  }

  /**
   * Validate a single file or the entire collection.
   */
  async validate(relativePath?: string): Promise<ValidateResult> {
    return await this.observer.trace(
      "collection.validate",
      { path: relativePath },
      () => this.validateUnobserved(relativePath),
    );
  }

  private async validateUnobserved(relativePath?: string): Promise<ValidateResult> {
    if (relativePath) {
      return await this.validateFile(relativePath);
    }
    return await this.validateCollection();
  }

  private async validateFile(relativePath: string): Promise<ValidateResult> {
    const readResult = await this.read(relativePath);
    if (readResult.error) {
      return {
        valid: false,
        issues: [{
          code: readResult.error.code,
          message: readResult.error.message,
          path: relativePath,
          severity: "error",
        }],
        error: readResult.error,
      };
    }

    const types = readResult.types ?? [];
    const frontmatter = readResult.frontmatter ?? {};

    // Check for unknown types
    const typeDefs: TypeDefinition[] = [];
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef) {
        return {
          valid: false,
          issues: [{
            code: "unknown_type",
            message: `Unknown type "${typeName}"`,
            severity: "error",
          }],
        };
      }
      typeDefs.push(typeDef);
    }
    const rawFrontmatter = readResult.rawFrontmatter ?? frontmatter;
    const v03TypeDefs = typeDefs.filter((typeDef) => typeDef.schema);
    const legacyTypeDefs = typeDefs.filter((typeDef) => !typeDef.schema);
    const result: ValidateResult = {
      valid: true,
      issues: [],
    };

    if (v03TypeDefs.length > 0) {
      const v03Result = validateFrontmatter(rawFrontmatter, v03TypeDefs, this.config);
      result.issues.push(...v03Result.issues);
    }
    if (legacyTypeDefs.length > 0) {
      const legacyResult = validateFrontmatter(frontmatter, legacyTypeDefs, this.config);
      result.issues.push(...legacyResult.issues);
    }
    for (const typeDef of v03TypeDefs) {
      for (const implementation of typeDef.implements ?? []) {
        const contractResult = this.dataContracts.project(
          typeDef.name,
          implementation.contract,
          implementation.version,
          frontmatter,
        );
        result.issues.push(...contractResult.diagnostics);
      }
    }
    // Add path to all issues
    for (const issue of result.issues) {
      if (!issue.path) {
        issue.path = relativePath;
      }
    }

    // Check path_pattern (filename_pattern) match — emit warning if mismatch
    for (const typeDef of typeDefs) {
      if (!typeDef.path_pattern) continue;
      const pattern = typeDef.path_pattern;
      // Expand {field} placeholders using frontmatter values
      const expectedFilename = pattern.replace(/\{(\w+)\}/g, (_, key) => {
          const val = frontmatter[key];
        return val !== null && val !== undefined ? String(val) : "";
      });
      const actualFilename = path.basename(relativePath);
      if (actualFilename !== expectedFilename) {
        result.issues.push({
          code: "filename_mismatch",
          message: `File "${actualFilename}" does not match expected pattern "${expectedFilename}" from type "${typeDef.name}"`,
          path: relativePath,
          severity: "warning",
        });
      }
    }

    // Check link fields: validate_exists, target constraint, ambiguous_link
    await this.validateLinkFields(legacyTypeDefs, frontmatter, relativePath, result);
    await this.validateLinkFields(v03TypeDefs, rawFrontmatter, relativePath, result);

    // Check cross-file uniqueness for this file
    const uniqueFields = new Set<string>();
    for (const typeDef of legacyTypeDefs) {
      if (!typeDef.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.unique) uniqueFields.add(fieldName);
      }
    }
    if (uniqueFields.size > 0) {
      const files = await this.scanFiles();
      for (const fieldName of uniqueFields) {
        const myValue = frontmatter[fieldName];
        if (myValue === null || myValue === undefined) continue;
        for (const otherPath of files) {
          if (otherPath === relativePath) continue;
          const otherResult = await this.read(otherPath);
          if (otherResult.frontmatter) {
            const otherValue = otherResult.frontmatter[fieldName];
            if (otherValue !== null && otherValue !== undefined &&
                JSON.stringify(myValue) === JSON.stringify(otherValue)) {
              result.issues.push({
                code: "duplicate_value",
                message: `Duplicate value for unique field "${fieldName}"`,
                field: fieldName,
                path: relativePath,
                severity: "error",
              });
              result.valid = false;
              break;
            }
          }
        }
      }
    }

    await this.checkV03UniqueForFile(relativePath, rawFrontmatter, v03TypeDefs, result.issues);
    result.valid = !result.issues.some((issue) => issue.severity === "error" || !issue.severity);

    return result;
  }

  private validateForWrite(
    v03Frontmatter: Record<string, unknown>,
    legacyFrontmatter: Record<string, unknown>,
    typeNames: string[],
  ): ValidateResult {
    const typeDefs = typeNames.map((typeName) => this.typeDefs.get(typeName)!).filter(Boolean);
    const v03TypeDefs = typeDefs.filter((typeDef) => typeDef.schema);
    const legacyTypeDefs = typeDefs.filter((typeDef) => !typeDef.schema);
    const result: ValidateResult = {
      valid: true,
      issues: [],
    };

    if (v03TypeDefs.length > 0) {
      const v03Result = validateFrontmatter(v03Frontmatter, v03TypeDefs, this.config);
      result.issues.push(...v03Result.issues);
    }
    if (legacyTypeDefs.length > 0) {
      const legacyResult = validateFrontmatter(legacyFrontmatter, legacyTypeDefs, this.config);
      result.issues.push(...legacyResult.issues);
    }

    result.valid = !result.issues.some((issue) => issue.severity === "error" || !issue.severity);
    return result;
  }

  private async validateCollectionPoliciesForWrite(
    relativePath: string,
    v03Frontmatter: Record<string, unknown>,
    legacyFrontmatter: Record<string, unknown>,
    typeNames: string[],
  ): Promise<MdbaseError[]> {
    const typeDefs = typeNames.map((typeName) => this.typeDefs.get(typeName)!).filter(Boolean);
    const v03TypeDefs = typeDefs.filter((typeDef) => typeDef.schema);
    const legacyTypeDefs = typeDefs.filter((typeDef) => !typeDef.schema);
    const result: ValidateResult = {
      valid: true,
      issues: [],
    };

    await this.validateLinkFields(legacyTypeDefs, legacyFrontmatter, relativePath, result);
    await this.validateLinkFields(v03TypeDefs, v03Frontmatter, relativePath, result);
    result.issues.push(...await this.checkUpdateUniqueness(relativePath, v03Frontmatter, typeNames));
    return result.issues;
  }

  private async validateCollection(): Promise<ValidateResult> {
    const allIssues: MdbaseError[] = [];
    const allFiles = new Map<string, Record<string, unknown>>();

    // Scan all files
    const files = await this.scanFiles();
    for (const relativePath of files) {
      const readResult = await this.read(relativePath);
      if (readResult.frontmatter) {
        allFiles.set(
          relativePath,
          this.config.spec_profile === "v0.3"
            ? (readResult.rawFrontmatter ?? readResult.frontmatter)
            : readResult.frontmatter,
        );
      }
    }

    // Validate each file
    for (const [relativePath, frontmatter] of allFiles) {
      const types = this.getTypesForFile(relativePath, frontmatter);
      const typeDefs: TypeDefinition[] = [];
      for (const typeName of types) {
        const typeDef = this.typeDefs.get(typeName);
        if (typeDef) {
          typeDefs.push(typeDef);
        } else {
          allIssues.push({
            code: "unknown_type",
            message: `Unknown type "${typeName}" in ${relativePath}`,
            path: relativePath,
            severity: "error",
          });
        }
      }

      if (typeDefs.length > 0) {
        const result = validateFrontmatter(frontmatter, typeDefs, this.config);
        for (const issue of result.issues) {
          allIssues.push({ ...issue, path: issue.path ?? relativePath });
        }
      }
    }

    // Check cross-file constraints (unique, id uniqueness)
    this.checkCrossFileConstraints(allFiles, allIssues);

    const hasErrors = allIssues.some((i) => i.severity === "error" || !i.severity);
    return {
      valid: !hasErrors,
      issues: allIssues,
    };
  }

  async loadRuntimeContracts(options: LoadRuntimeContractsOptions = {}): Promise<RuntimePackage> {
    return await this.observer.trace(
      "collection.load_runtime_contracts",
      { include_type_files: options.includeTypeFiles },
      () => this.loadRuntimeContractsUnobserved(options),
    );
  }

  private async loadRuntimeContractsUnobserved(options: LoadRuntimeContractsOptions): Promise<RuntimePackage> {
    const records: RuntimeMarkdownRecord[] = [];

    if (options.includeTypeFiles !== false) {
      for (const relativePath of await this.scanTypeFilesForRuntime()) {
        const parsed = await parseFileAsync(path.join(this.root, relativePath));
        if (parsed.error) {
          records.push({
            path: relativePath,
            frontmatter: {},
            body: parsed.body,
          });
          continue;
        }
        records.push({
          path: relativePath,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
        });
      }
    }

    for (const relativePath of await this.scanFiles()) {
      const parsed = await parseFileAsync(path.join(this.root, relativePath));
      if (parsed.error) continue;
      records.push({
        path: relativePath,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      });
    }

    const runtimePackage = buildRuntimePackage(this.root, records, options);
    const profileVersion = this.config.runtime?.profile_version;
    if (profileVersion !== undefined && profileVersion !== "0.1.0") {
      runtimePackage.diagnostics.push({
        severity: "error",
        code: "unsupported_profile",
        message: `Unsupported runtime profile ${String(profileVersion)}; supported: 0.1.0.`,
      });
    }
    return runtimePackage;
  }

  async getRuntimeRegistry(options: LoadRuntimeContractsOptions = {}): Promise<RuntimeRegistry> {
    return await this.observer.trace(
      "collection.get_runtime_registry",
      {},
      () => this.getRuntimeRegistryUnobserved(options),
    );
  }

  private async getRuntimeRegistryUnobserved(options: LoadRuntimeContractsOptions): Promise<RuntimeRegistry> {
    const runtimePackage = await this.loadRuntimeContracts(options);
    const selectedPath = typeof this.config.runtime?.policy === "string"
      ? this.config.runtime.policy.replace(/\\/g, "/").replace(/^\.\//, "")
      : undefined;
    const selectedPolicyId = options.selectedPolicyId
      ?? runtimePackage.policies.find((policy) => policy.path === selectedPath)?.frontmatter.id;
    if (selectedPath && !selectedPolicyId) {
      runtimePackage.diagnostics.push({
        severity: "error",
        code: "policy_not_selected",
        message: `Selected runtime policy ${selectedPath} was not found.`,
        path: selectedPath,
      });
    }
    return composeRuntimeRegistry(runtimePackage, options.implicitContracts, selectedPolicyId);
  }

  async preflightRuntimeWorkflows(
    options: LoadRuntimeContractsOptions = {},
  ): Promise<RuntimeValidationResult> {
    return await this.observer.trace(
      "collection.preflight_runtime_workflows",
      {},
      () => this.preflightRuntimeWorkflowsUnobserved(options),
    );
  }

  private async preflightRuntimeWorkflowsUnobserved(
    options: LoadRuntimeContractsOptions,
  ): Promise<RuntimeValidationResult> {
    const registry = await this.getRuntimeRegistry(options);
    return preflightRuntimeWorkflows(registry);
  }

  listTypeMigrations(options: { type?: string; from?: number; to?: number } = {}): TypeMigrationEntry[] {
    const requestedType = options.type?.toLowerCase();
    const entries: TypeMigrationEntry[] = [];
    for (const [typeName, typeDef] of this.typeDefs) {
      if (requestedType && typeName !== requestedType) continue;
      for (const migration of typeDef.migrations ?? []) {
        if (options.from !== undefined && migration.from !== options.from) continue;
        if (options.to !== undefined && migration.to !== options.to) continue;
        entries.push({
          type: typeName,
          source_path: typeDef.source_path,
          migration,
        });
      }
    }
    return entries.sort((a, b) => {
      const typeCompare = a.type.localeCompare(b.type);
      if (typeCompare !== 0) return typeCompare;
      if (a.migration.from !== b.migration.from) return a.migration.from - b.migration.from;
      return a.migration.to - b.migration.to;
    });
  }

  private checkCrossFileConstraints(
    allFiles: Map<string, Record<string, unknown>>,
    issues: MdbaseError[],
  ): void {
    // Check unique field constraints
    for (const [, typeDef] of this.typeDefs) {
      if (!typeDef.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.unique) {
          const seen = new Map<string, string>();
          for (const [filePath, frontmatter] of allFiles) {
            const value = frontmatter[fieldName];
            if (value === null || value === undefined) continue;
            const key = JSON.stringify(value);
            if (seen.has(key)) {
              issues.push({
                code: "duplicate_value",
                message: `Duplicate value for unique field "${fieldName}"`,
                field: fieldName,
                path: filePath,
                severity: "error",
              });
            } else {
              seen.set(key, filePath);
            }
          }
        }
      }
    }

    // v0.3 collection.unique constraints
    for (const [, typeDef] of this.typeDefs) {
      if (!typeDef.collection?.unique) continue;
      for (const rule of typeDef.collection.unique) {
        const seen = new Map<string, string>();
        for (const [filePath, frontmatter] of allFiles) {
          const fileTypes = this.getTypesForFile(filePath, frontmatter);
          if (!fileTypes.includes(typeDef.name)) continue;
          if (!this.v03UniqueRuleApplies(rule, typeDef.name, filePath, fileTypes)) continue;
          const fieldValue = getFieldReferenceValue(frontmatter, rule.field);
          if (!fieldValue.present || fieldValue.value === null || fieldValue.value === undefined) continue;
          const key = JSON.stringify(fieldValue.value);
          if (seen.has(key)) {
            issues.push({
              code: "duplicate_value",
              message: `Duplicate value "${String(fieldValue.value)}" for unique field "${rule.field}"`,
              field: rule.field,
              path: filePath,
              severity: "error",
            });
          } else {
            seen.set(key, filePath);
          }
        }
      }
    }

    // Check id_field uniqueness
    const idField = this.config.settings.id_field;
    const seen = new Map<string, string>();
    for (const [filePath, frontmatter] of allFiles) {
      const value = frontmatter[idField];
      if (value === null || value === undefined) continue;
      const key = JSON.stringify(value);
      if (seen.has(key)) {
        issues.push({
          code: "duplicate_id",
          message: `Duplicate id "${value}"`,
          field: idField,
          path: filePath,
          severity: "error",
        });
      } else {
        seen.set(key, filePath);
      }
    }
  }

  /**
   * Create a new file in the collection.
   */
  async create(input: CreateInput): Promise<CreateResult> {
    return await this.observer.trace(
      "collection.create",
      { path: input.path, type: input.type, type_count: input.types?.length },
      () => this.createUnobserved(input),
    );
  }

  private async createUnobserved(input: CreateInput): Promise<CreateResult> {
    // Determine types from input parameters or frontmatter
    const typeNames: string[] = [];
    if (input.type) typeNames.push(input.type.toLowerCase());
    if (input.types) typeNames.push(...input.types.map((t) => t.toLowerCase()));
    // Also detect types from frontmatter if not explicitly provided
    if (typeNames.length === 0 && input.frontmatter) {
      const inferred = this.getFileTypes(input.frontmatter);
      typeNames.push(...inferred);
    }

    // Check for unknown types
    for (const typeName of typeNames) {
      if (!this.typeDefs.has(typeName)) {
        return {
          error: { code: "unknown_type", message: `Unknown type "${typeName}"` },
        };
      }
    }

    // Build frontmatter
    const frontmatter: Record<string, unknown> = { ...(input.frontmatter ?? {}) };

    // Set the type key (only if explicit_type_keys is configured)
    if (this.config.settings.explicit_type_keys.length > 0) {
      if (typeNames.length === 1) {
        const typeKey = this.config.settings.explicit_type_keys[0];
        if (!(typeKey in frontmatter)) {
          frontmatter[typeKey] = typeNames[0];
        }
      } else if (typeNames.length > 1) {
        const typesKey = this.config.settings.explicit_type_keys.find((k) => k.endsWith("s")) ??
                         this.config.settings.explicit_type_keys[0];
        if (!(typesKey in frontmatter)) {
          frontmatter[typesKey] = typeNames;
        }
      }
    }

    const createLifecycleIssues = this.applyV03Lifecycle(typeNames, "on_create", frontmatter, {
      relativePath: input.path,
    });
    if (createLifecycleIssues.some((issue) => issue.severity === "error" || !issue.severity)) {
      return {
        valid: false,
        error: { code: "validation_failed", message: "Lifecycle validation failed on create" },
        issues: createLifecycleIssues,
      };
    }
    const postLifecycleTypes = this.getTypesForFile(input.path ?? "", frontmatter);
    if (this.config.spec_profile === "v0.3" && !sameStringSet(typeNames, postLifecycleTypes)) {
      return {
        valid: false,
        error: { code: "type_membership_changed", message: "Lifecycle changed type membership during create" },
      };
    }

    // Track which fields are default-only (not user-provided, not generated)
    const defaultOnlyFields = new Set<string>();

    // Apply generated fields and defaults (before path derivation so generated values are available in path_pattern)
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;

      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldName in frontmatter && frontmatter[fieldName] !== undefined) continue;

        if (fieldDef.generated) {
          // Sequence generation needs collection scan — handle inline
          if (fieldDef.generated === "sequence" || (typeof fieldDef.generated === "object" && fieldDef.generated !== null && "sequence" in fieldDef.generated)) {
            const files = await this.scanFiles();
            let max = -Infinity;
            const startConfig = typeof fieldDef.generated === "object" ? (fieldDef.generated as Record<string, unknown>).sequence : undefined;
            const start = (typeof startConfig === "object" && startConfig !== null) ? ((startConfig as Record<string, unknown>).start as number ?? 1) : 1;
            for (const f of files) {
              const r = await this.read(f);
              if (r.error || !r.types?.includes(typeName)) continue;
              const val = r.frontmatter?.[fieldName];
              if (typeof val === "number" && Number.isFinite(val)) {
                max = Math.max(max, val);
              }
            }
            frontmatter[fieldName] = max === -Infinity ? start : max + 1;
            continue;
          }
          const generated = this.generateValue(fieldDef, frontmatter, { typeName, fieldName, relativePath: input.path });
          if (generated !== undefined && generated !== null) {
            frontmatter[fieldName] = generated;
          } else if (fieldDef.default !== undefined) {
            // Generated yielded null/undefined, apply default as effective value
            frontmatter[fieldName] = fieldDef.default;
            defaultOnlyFields.add(fieldName);
          } else {
            // Generated field with missing source produces null
            frontmatter[fieldName] = null;
          }
        } else if (fieldDef.default !== undefined && !(fieldName in frontmatter)) {
          frontmatter[fieldName] = fieldDef.default;
          defaultOnlyFields.add(fieldName);
        }
      }
    }

    // Derive path from filename_pattern if not provided
    let relativePath = input.path;
    if (!relativePath) {
      // Try filename_pattern from type definitions
      let pattern: string | undefined;
      for (const typeName of typeNames) {
        const typeDef = this.typeDefs.get(typeName);
        if (typeDef?.path_pattern) {
          pattern = typeDef.path_pattern;
          break;
        }
      }
      if (!pattern) {
        return {
          error: { code: "path_required", message: "No path provided and no filename_pattern defined" },
        };
      }
      // Simple template replacement using enriched frontmatter (includes generated fields)
      let unresolvedKey: string | undefined;
      relativePath = pattern.replace(/\{(\w+)\}/g, (_, key) => {
        const val = frontmatter[key];
        if (val == null || String(val) === "") {
          unresolvedKey ??= key;
          return key; // placeholder, won't be used
        }
        return String(val);
      });
      if (unresolvedKey) {
        return {
          error: { code: "path_required", message: `Cannot derive path: field "${unresolvedKey}" has no value for path_pattern "${pattern}"` },
        };
      }
    }

    // Second pass: resolve file.*-sourced generated fields now that path is known
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (frontmatter[fieldName] !== null && frontmatter[fieldName] !== undefined) continue;
        if (typeof fieldDef.generated === "object" && fieldDef.generated !== null && "from" in (fieldDef.generated as Record<string, unknown>)) {
          const genObj = fieldDef.generated as { from: string; transform: string };
          if (genObj.from && genObj.from.startsWith("file.")) {
            const generated = this.generateValue(fieldDef, frontmatter, { typeName, fieldName, relativePath });
            if (generated !== undefined && generated !== null) {
              frontmatter[fieldName] = generated;
            }
          }
        }
      }
    }

    // Path validation: traversal, null bytes, and invalid characters
    if (this.isInvalidRelativePath(relativePath)) {
      const normalizedPath = relativePath.replace(/\\/g, "/");
      return {
        error: {
          code: this.config.spec_profile === "v0.3" && normalizedPath.split("/").includes("..") ? "path_traversal" : "invalid_path",
          message: `Invalid path: ${relativePath}`,
        },
      };
    }

    // Check if file already exists
    const fullPath = path.join(this.root, relativePath);
    if (await this.fileExists(fullPath)) {
      return {
        error: { code: "path_conflict", message: `File already exists: ${relativePath}` },
      };
    }

    // Coerce values based on type definitions
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [key, value] of Object.entries(frontmatter)) {
        if (this.config.settings.explicit_type_keys.includes(key)) continue;
        const fieldDef = typeDef.fields[key];
        if (!fieldDef || value === null || value === undefined) continue;
        frontmatter[key] = coerceForRead(value, fieldDef);
      }
    }

    // Build the effective frontmatter (includes defaults) and the disk frontmatter
    const effectiveFrontmatter = { ...frontmatter };

    const diskFrontmatter: Record<string, unknown> = {};
    if (this.config.settings.write_defaults) {
      Object.assign(diskFrontmatter, frontmatter);
    } else {
      for (const [key, value] of Object.entries(frontmatter)) {
        if (!defaultOnlyFields.has(key)) {
          diskFrontmatter[key] = value;
        }
      }
    }

    // Verify created file will satisfy match rules for explicit types
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (typeDef?.match) {
        if (!this.matchesType(relativePath, effectiveFrontmatter, typeDef)) {
          return {
            error: { code: "match_failed", message: `Created file would not satisfy match rules for type "${typeName}"` },
          };
        }
      }
    }

    // Validate before writing. v0.3 JSON Schema sees persisted/lifecycle values;
    // legacy validation keeps the previous effective-default behavior.
    if (this.config.settings.default_validation !== "off") {
      const valResult = this.validateForWrite(frontmatter, effectiveFrontmatter, typeNames);
      if (!valResult.valid) {
        // At "error" level: always reject. At "warn" level: reject if there are error-severity issues
        const hasErrors = valResult.issues.some((i) => i.severity === "error" || !i.severity);
        if (this.config.settings.default_validation === "error" || hasErrors) {
          return {
            valid: false,
            error: { code: "validation_failed", message: "Validation failed on create" },
            issues: valResult.issues,
          };
        }
      }
      const policyIssues = await this.validateCollectionPoliciesForWrite(relativePath, frontmatter, effectiveFrontmatter, typeNames);
      if (hasValidationErrors(policyIssues) && this.config.settings.default_validation === "error") {
        return {
          valid: false,
          error: { code: "validation_failed", message: "Collection policy validation failed on create" },
          issues: policyIssues,
        };
      }
    }
    this.applyV03ReadDefaults(effectiveFrontmatter, typeNames);

    // Collect warnings (e.g. deprecated fields)
    const warnings: string[] = [];
    for (const typeName of typeNames) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.deprecated && fieldName in frontmatter &&
            frontmatter[fieldName] !== null && frontmatter[fieldName] !== undefined) {
          warnings.push(`Field "${fieldName}" is deprecated`);
        }
      }
    }

    // Write file - only disk frontmatter (no default-only fields)
    const body = input.body ?? "";
    const content = serializeFile(
      diskFrontmatter,
      body,
      this.config.settings.write_nulls,
      this.config.settings.write_empty_lists,
    );
    // Call pre-write hook (for testing concurrent modifications)
    if (this.preWriteHook) {
      this.preWriteHook(relativePath);
    }

    // Check if file appeared concurrently after initial check
    if (await this.fileExists(fullPath)) {
      return {
        error: { code: "path_conflict", message: `File appeared concurrently: ${relativePath}` },
      };
    }

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content);
    await this.updateCacheForPath(relativePath);
    this.invalidateRuntimeCaches();

    const result: CreateResult = {
      valid: true,
      frontmatter: effectiveFrontmatter,
      body,
      path: relativePath,
      types: typeNames,
      revision: await computeRevision(fullPath),
    };
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    return result;
  }

  /**
   * Update an existing file in the collection.
   */
  async update(input: UpdateInput): Promise<UpdateResult> {
    return await this.observer.trace(
      "collection.update",
      { path: input.path, field_count: Object.keys(input.fields ?? input.frontmatter ?? {}).length },
      () => this.updateUnobserved(input),
    );
  }

  private async updateUnobserved(input: UpdateInput): Promise<UpdateResult> {
    const relativePath = input.path;
    if (this.isInvalidRelativePath(relativePath)) {
      return {
        error: { code: "invalid_path", message: `Invalid path: ${relativePath}` },
      };
    }
    const fullPath = path.join(this.root, relativePath);

    if (!await this.fileExists(fullPath)) {
      return {
        error: { code: "file_not_found", message: `File not found: ${relativePath}` },
      };
    }

    const readRevision = await computeRevision(fullPath);
    if (input.if_revision !== undefined && input.if_revision !== readRevision) {
      return {
        valid: false,
        error: { code: "concurrent_modification", message: `Revision mismatch for "${relativePath}"` },
      };
    }

    // Record mtime for concurrency check
    const readMtime = (await fs.promises.stat(fullPath)).mtimeMs;

    const existing = await parseFileAsync(fullPath);
    const originalFrontmatter: Record<string, unknown> = { ...existing.frontmatter };
    const frontmatter: Record<string, unknown> = { ...existing.frontmatter };

    // Apply field updates
    const updates = input.fields ?? input.frontmatter;
    if (updates) {
      Object.assign(frontmatter, updates);
    }

    // Determine types
    const types = this.getTypesForFile(relativePath, frontmatter);

    // Coerce values based on type definitions
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [key, value] of Object.entries(frontmatter)) {
        if (this.config.settings.explicit_type_keys.includes(key)) continue;
        const fieldDef = typeDef.fields[key];
        if (!fieldDef || value === null || value === undefined) continue;
        frontmatter[key] = coerceForRead(value, fieldDef);
      }
    }

    const updateLifecycleIssues = this.applyV03Lifecycle(types, "on_update", frontmatter, {
      oldFrontmatter: originalFrontmatter,
      relativePath,
    });
    if (updateLifecycleIssues.some((issue) => issue.severity === "error" || !issue.severity)) {
      return {
        error: { code: "validation_failed", message: "Lifecycle validation failed on update" },
        issues: updateLifecycleIssues,
      };
    }
    const postLifecycleTypes = this.getTypesForFile(relativePath, frontmatter);
    if (this.config.spec_profile === "v0.3" && !sameStringSet(types, postLifecycleTypes)) {
      return {
        valid: false,
        error: { code: "type_membership_changed", message: "Lifecycle changed type membership during update" },
      };
    }

    // Apply now_on_write generated fields
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;

      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.generated === "now_on_write") {
          frontmatter[fieldName] = new Date().toISOString();
        }
      }
    }

    // Validate before writing (if validation is not off)
    if (this.config.settings.default_validation !== "off") {
      if (types.length > 0) {
        const valResult = this.validateForWrite(frontmatter, frontmatter, types);
        if (!valResult.valid && this.config.settings.default_validation === "error") {
          return {
            error: { code: "validation_failed", message: "Validation failed on update" },
            issues: valResult.issues,
          };
        }
      }

      const policyIssues = await this.validateCollectionPoliciesForWrite(relativePath, frontmatter, frontmatter, types);
      const changedUniqueness = this.shouldCheckUniquenessOnUpdate(originalFrontmatter, frontmatter, types);
      const effectivePolicyIssues = changedUniqueness
        ? policyIssues
        : policyIssues.filter((issue) => issue.code !== "duplicate_id" && issue.code !== "duplicate_value");
      if (hasValidationErrors(effectivePolicyIssues) && this.config.settings.default_validation === "error") {
        return {
          error: { code: "validation_failed", message: "Collection policy validation failed on update" },
          issues: effectivePolicyIssues,
        };
      }
    }

    // Build effective frontmatter with defaults re-applied for null/missing fields
    const effectiveFrontmatter = { ...frontmatter };
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.default !== undefined) {
          if (!(fieldName in effectiveFrontmatter) ||
              effectiveFrontmatter[fieldName] === null ||
              effectiveFrontmatter[fieldName] === undefined) {
            effectiveFrontmatter[fieldName] = fieldDef.default;
          }
        }
      }
    }
    this.applyV03ReadDefaults(effectiveFrontmatter, types);

    // Collect warnings (e.g. deprecated fields)
    const warnings: string[] = [];
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.deprecated && fieldName in frontmatter &&
            frontmatter[fieldName] !== null && frontmatter[fieldName] !== undefined) {
          warnings.push(`Field "${fieldName}" is deprecated`);
        }
      }
    }

    // Strip computed fields from disk frontmatter
    const diskFrontmatter = { ...frontmatter };
    if (this.config.spec_profile === "v0.2" && this.config.settings.write_defaults) {
      for (const typeName of types) {
        const typeDef = this.typeDefs.get(typeName);
        for (const [fieldName, fieldDef] of Object.entries(typeDef?.fields ?? {})) {
          if (!(fieldName in diskFrontmatter) && fieldDef.default !== undefined) {
            diskFrontmatter[fieldName] = cloneJsonLike(fieldDef.default);
          }
        }
      }
    }
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        if (fieldDef.computed) {
          delete diskFrontmatter[fieldName];
        }
      }
    }

    // Write file — use the disk frontmatter (without computed or default-only fields)
    const body = input.body ?? existing.body;
    const content = serializeFile(
      diskFrontmatter,
      body,
      this.config.settings.write_nulls,
      this.config.settings.write_empty_lists,
    );

    // Call pre-write hook (for testing concurrent modifications)
    if (this.preWriteHook) {
      this.preWriteHook(relativePath);
    }

    // Concurrency check: verify mtime hasn't changed since read
    const writeMtime = (await fs.promises.stat(fullPath)).mtimeMs;
    if (writeMtime !== readMtime) {
      return {
        error: { code: "concurrent_modification", message: `File "${relativePath}" was modified externally during update` },
      };
    }

    await fs.promises.writeFile(fullPath, content);
    await this.updateCacheForPath(relativePath);

    // Evaluate computed fields on the effective frontmatter for the return value
    this.evaluateComputedFields(effectiveFrontmatter, types, relativePath, body);

    const result: UpdateResult = {
      valid: true,
      frontmatter: effectiveFrontmatter,
      body,
      path: relativePath,
      types,
      revision: await computeRevision(fullPath),
    };
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    this.runtimeCache.updateFile(relativePath, {
      valid: true,
      frontmatter: effectiveFrontmatter,
      rawFrontmatter: diskFrontmatter,
      body,
      types,
      revision: result.revision,
    });
    this.invalidateRuntimeCaches({
      fileLists: false,
      fileCache: false,
      nonMarkdown: false,
    });
    return result;
  }

  /**
   * Delete a file from the collection.
   */
  async delete(relativePath: string, input?: DeleteOptions): Promise<DeleteResult> {
    return await this.observer.trace(
      "collection.delete",
      { path: relativePath, check_backlinks: input?.check_backlinks },
      () => this.deleteUnobserved(relativePath, input),
    );
  }

  private async deleteUnobserved(relativePath: string, input?: DeleteOptions): Promise<DeleteResult> {
    if (this.isInvalidRelativePath(relativePath)) {
      return {
        error: { code: "invalid_path", message: `Invalid path: ${relativePath}` },
      };
    }
    const fullPath = path.join(this.root, relativePath);
    if (!await this.fileExists(fullPath)) {
      return {
        error: { code: "file_not_found", message: `File not found: ${relativePath}` },
      };
    }
    if (input?.if_revision !== undefined && input.if_revision !== await computeRevision(fullPath)) {
      return {
        valid: false,
        error: { code: "concurrent_modification", message: `Revision mismatch for "${relativePath}"` },
      };
    }

    const checkBacklinks = input?.check_backlinks !== false;
    const brokenLinks = checkBacklinks ? await this.findBacklinks([relativePath]) : [];

    // Record mtime for concurrency check
    const readMtime = (await fs.promises.stat(fullPath)).mtimeMs;

    // Call pre-write hook (for testing concurrent modifications)
    if (this.preWriteHook) {
      this.preWriteHook(relativePath);
    }

    // Concurrency check
    const writeMtime = (await fs.promises.stat(fullPath)).mtimeMs;
    if (writeMtime !== readMtime) {
      return {
        error: { code: "concurrent_modification", message: `File "${relativePath}" was modified externally during delete` },
      };
    }

    await fs.promises.unlink(fullPath);
    if (this.cache) {
      await this.cache.deleteFile(relativePath);
    }
    this.removeSourceFromBacklinkTokenIndex(relativePath);
    this.invalidateRuntimeCaches({ backlinks: false });
    const result: DeleteResult = { valid: true };
    if (checkBacklinks) {
      result.broken_links = brokenLinks.map((entry) => ({ path: entry.referrer }));
    }
    return result;
  }

  /**
   * Create a new type definition file.
   */
  async createType(input: CreateTypeInput): Promise<{ valid?: boolean; error?: { code: string; message: string }; type?: Record<string, unknown> }> {
    return await this.observer.trace(
      "collection.create_type",
      { type: input.name },
      () => this.createTypeUnobserved(input),
    );
  }

  private async createTypeUnobserved(input: CreateTypeInput): Promise<{ valid?: boolean; error?: { code: string; message: string }; type?: Record<string, unknown> }> {
    const name = input.name.toLowerCase();

    // Validate type name
    if (name.startsWith("_")) {
      return {
        valid: false,
        error: {
          code: "invalid_type_definition",
          message: `Type name "${name}" is reserved (starts with underscore)`,
        },
      };
    }
    const RESERVED = new Set(["file", "formula", "this"]);
    if (RESERVED.has(name)) {
      return {
        valid: false,
        error: {
          code: "invalid_type_definition",
          message: `Type name "${name}" is a reserved keyword`,
        },
      };
    }
    const TYPE_NAME_REGEX = /^[a-z][a-z0-9_-]*$/;
    if (!TYPE_NAME_REGEX.test(name) || name.length > 64) {
      return {
        valid: false,
        error: {
          code: "invalid_type_definition",
          message: `Type name "${name}" is invalid`,
        },
      };
    }

    // Validate field types
    const VALID_FIELD_TYPES = new Set([
      "string", "integer", "number", "boolean", "date", "datetime",
      "time", "enum", "list", "object", "any", "link",
    ]);
    if (input.fields) {
      for (const [fieldName, fieldDef] of Object.entries(input.fields)) {
        const fd = fieldDef as Record<string, unknown>;
        if (fd.type && !VALID_FIELD_TYPES.has(String(fd.type))) {
          return {
            valid: false,
            error: {
              code: "invalid_type_definition",
              message: `Invalid field type "${fd.type}" for field "${fieldName}"`,
            },
          };
        }
      }
    }

    // Validate parent/extends reference
    const parentType = input.extends ?? input.parent;
    if (parentType) {
      if (!this.typeDefs.has(parentType.toLowerCase())) {
        return {
          valid: false,
          error: {
            code: "missing_parent_type",
            message: `Parent type "${parentType}" does not exist`,
          },
        };
      }
    }

    // Build the type definition frontmatter
    const typeFrontmatter: Record<string, unknown> = { name };
    if (input.description) typeFrontmatter.description = input.description;
    if (parentType) typeFrontmatter.extends = parentType;
    if (input.strict !== undefined) typeFrontmatter.strict = input.strict;
    if (input.fields) typeFrontmatter.fields = input.fields;
    const pathPattern = input.path_pattern ?? input.filename_pattern;
    if (pathPattern) typeFrontmatter.path_pattern = pathPattern;

    // Write the type file
    const typesFolder = path.join(this.root, this.config.settings.types_folder);
    await fs.promises.mkdir(typesFolder, { recursive: true });
    const typeFilePath = path.join(typesFolder, `${name}.md`);

    if (await this.fileExists(typeFilePath)) {
      return {
        valid: false,
        error: {
          code: "path_conflict",
          message: `Type file already exists: ${name}.md`,
        },
      };
    }

    const content = serializeFile(typeFrontmatter, "", "omit", true);
    await fs.promises.mkdir(typesFolder, { recursive: true });
    await fs.promises.writeFile(typeFilePath, content);

    return {
      valid: true,
      type: typeFrontmatter,
    };
  }

  /**
   * Pre-ref-update hook for testing concurrent modifications during reference updates.
   */
  preRefUpdateHook?: (refPath: string) => void;

  /**
   * Rename/move a file in the collection, optionally updating references.
   */
  async rename(input: RenameInput): Promise<Record<string, unknown>> {
    return await this.observer.trace(
      "collection.rename",
      { from: input.from, to: input.to, update_refs: input.update_refs },
      () => this.renameUnobserved(input),
    );
  }

  private async renameUnobserved(input: RenameInput): Promise<Record<string, unknown>> {
    const fromPath = path.join(this.root, input.from);
    const toPath = path.join(this.root, input.to);

    if (this.isInvalidRelativePath(input.from) || this.isInvalidRelativePath(input.to)) {
      return {
        error: { code: "invalid_path", message: `Invalid path: ${input.from} -> ${input.to}` },
      };
    }

    if (!await this.fileExists(fromPath)) {
      return {
        error: { code: "file_not_found", message: `Source not found: ${input.from}` },
      };
    }
    if (input.if_revision !== undefined && input.if_revision !== await computeRevision(fromPath)) {
      return {
        valid: false,
        error: { code: "concurrent_modification", message: `Revision mismatch for "${input.from}"` },
      };
    }

    if (await this.fileExists(toPath)) {
      return {
        error: { code: "path_conflict", message: `Target exists: ${input.to}` },
      };
    }

    // Record mtime for concurrency check
    const readMtime = (await fs.promises.stat(fromPath)).mtimeMs;

    // Call pre-write hook (for testing concurrent modifications)
    if (this.preWriteHook) {
      this.preWriteHook(input.from);
    }

    // Concurrency check: source file modified?
    const writeMtime = (await fs.promises.stat(fromPath)).mtimeMs;
    if (writeMtime !== readMtime) {
      return {
        error: { code: "concurrent_modification", message: `Source file "${input.from}" was modified externally during rename` },
      };
    }

    // Check if target appeared concurrently
    if (await this.fileExists(toPath)) {
      return {
        error: { code: "path_conflict", message: `Target appeared concurrently: ${input.to}` },
      };
    }

    await fs.promises.mkdir(path.dirname(toPath), { recursive: true });
    await fs.promises.rename(fromPath, toPath);
    if (this.cache) {
      await this.cache.deleteFile(input.from);
      await this.updateCacheForPath(input.to);
    }

    // Determine if we should update references
    const shouldUpdateRefs = input.update_refs !== undefined
      ? input.update_refs
      : this.config.settings.rename_update_refs;

    if (!shouldUpdateRefs) {
      this.invalidateRuntimeCaches();
      return { valid: true, from: input.from, to: input.to };
    }

    // Update references across the collection
    const renameResult = await this.updateReferencesAfterRename(input.from, input.to);
    this.invalidateRuntimeCaches();
    return renameResult;
  }

  /**
   * After a file has been renamed, find and update all references to it.
   */
  private async updateReferencesAfterRename(
    oldPath: string,
    newPath: string,
  ): Promise<Record<string, unknown>> {
    const files = await this.scanFiles();
    const fileCache = await this.buildFileCache(files);
    const allFiles = await this.scanAllFiles();
    const nonMdSet = this.buildNonMarkdownSet(allFiles);
    const basenameCounts = new Map<string, number>();
    for (const filePath of files) {
      const basename = path.basename(filePath, path.extname(filePath));
      basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
    }
    const referencesUpdated: Array<{ path: string; field?: string; location?: string }> = [];
    const warnings: Array<{ path: string; message_contains?: string; message?: string }> = [];
    const partialFailures: Array<{ path: string; reason: string }> = [];

    // Get old and new file basenames (without extension) for wikilink matching
    const oldBase = path.basename(oldPath, path.extname(oldPath));
    const newBase = path.basename(newPath, path.extname(newPath));
    const oldNoExt = oldPath.replace(/\.(md|markdown)$/, "");
    const newNoExt = newPath.replace(/\.(md|markdown)$/, "");

    // Check if the renamed file's id_field is still the same
    // (if so, id-based links don't need rewriting)
    const idField = this.config.settings.id_field;
    let renamedFileId: string | undefined;
    if (idField) {
      const readResult = fileCache.get(newPath);
      if (readResult && !readResult.error && readResult.frontmatter) {
        const idVal = readResult.frontmatter[idField];
        if (typeof idVal === "string") {
          renamedFileId = idVal;
        }
      }
    }

    for (const filePath of files) {
      const fullPath = path.join(this.root, filePath);
      const readResult = fileCache.get(filePath);
      if (!readResult || readResult.error) continue;
      const frontmatter = readResult.frontmatter ?? {};
      const types = readResult.types ?? [];
      const body = readResult.body ?? "";

      let fmUpdated = false;
      let bodyUpdated = false;
      const fmUpdatedFields: string[] = [];
      const updatedFm = { ...frontmatter };

      // Check frontmatter link fields
      for (const typeName of types) {
        const typeDef = this.typeDefs.get(typeName);
        if (!typeDef?.fields) continue;
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          const value = frontmatter[fieldName];
          if (value === null || value === undefined) continue;

          if (fieldDef.type === "link" && typeof value === "string") {
            if (!this.mightReferenceRenamedPath(value, oldPath, oldBase, oldNoExt)) {
              continue;
            }
            // ID-based link stability: if id_field is explicitly configured,
            // the link field has a target constraint, and the link is a simple-name
            // wikilink matching the renamed file's ID, skip the update (§12.5 rule 3)
            const fieldTarget = (fieldDef as unknown as Record<string, unknown>).target as string | undefined;
            if (this.config.settings.id_field_explicit && fieldTarget && renamedFileId && this.isIdStableLink(value, renamedFileId)) {
              continue;
            }
            const result = this.updateLinkValue(
              value,
              oldPath,
              newPath,
              oldBase,
              newBase,
              oldNoExt,
              newNoExt,
              filePath,
              renamedFileId,
              files,
              fileCache,
              nonMdSet,
              basenameCounts,
            );
            if (result.warning) {
              warnings.push({ path: filePath, message_contains: "ambiguous", message: result.warning });
            } else if (result.updated && result.newValue !== value) {
              updatedFm[fieldName] = result.newValue;
              fmUpdated = true;
              fmUpdatedFields.push(fieldName);
            }
          } else if (fieldDef.type === "list" && fieldDef.items?.type === "link" && Array.isArray(value)) {
            const itemTarget = (fieldDef.items as unknown as Record<string, unknown>).target as string | undefined;
            const newList = [...value];
            let listUpdated = false;
            for (let i = 0; i < newList.length; i++) {
              const item = newList[i];
              if (typeof item !== "string") continue;
              if (!this.mightReferenceRenamedPath(item, oldPath, oldBase, oldNoExt)) {
                continue;
              }
              // ID-based link stability for list items
              if (this.config.settings.id_field_explicit && itemTarget && renamedFileId && this.isIdStableLink(item, renamedFileId)) {
                continue;
              }
              const result = this.updateLinkValue(
                item,
                oldPath,
                newPath,
                oldBase,
                newBase,
                oldNoExt,
                newNoExt,
                filePath,
                renamedFileId,
                files,
                fileCache,
                nonMdSet,
                basenameCounts,
              );
              if (result.warning) {
                warnings.push({ path: filePath, message_contains: "ambiguous", message: result.warning });
              } else if (result.updated && result.newValue !== item) {
                newList[i] = result.newValue;
                listUpdated = true;
                fmUpdatedFields.push(`${fieldName}[${i}]`);
              }
            }
            if (listUpdated) {
              updatedFm[fieldName] = newList;
              fmUpdated = true;
            }
          }
        }
      }

      // Check body links
      const newBody = this.mightReferenceRenamedPath(body, oldPath, oldBase, oldNoExt)
        ? this.updateBodyLinks(
          body,
          oldPath,
          newPath,
          oldBase,
          newBase,
          oldNoExt,
          newNoExt,
          filePath,
          renamedFileId,
          files,
          fileCache,
          nonMdSet,
          basenameCounts,
        )
        : body;
      if (newBody !== body) {
        bodyUpdated = true;
      }

      // Write updates if needed
      if (fmUpdated || bodyUpdated) {
        if (this.preRefUpdateHook) {
          // Record mtime only when simulation hook is active.
          const beforeHookMtime = (await fs.promises.stat(fullPath)).mtimeMs;
          this.preRefUpdateHook(filePath);
          const currentMtime = (await fs.promises.stat(fullPath)).mtimeMs;
          if (currentMtime !== beforeHookMtime) {
            // File was modified externally during ref update
            partialFailures.push({ path: filePath, reason: "concurrent_modification" });
            continue;
          }
        }

        // Write the updated file
        try {
          const nextFrontmatter = fmUpdated ? updatedFm : frontmatter;
          const nextBody = bodyUpdated ? newBody : body;
          const updatedContent = serializeFile(
            nextFrontmatter,
            nextBody,
            this.config.settings.write_nulls,
            this.config.settings.write_empty_lists,
          );
          await fs.promises.writeFile(fullPath, updatedContent);
          await this.upsertCacheFromData(filePath, nextFrontmatter, nextBody);

          for (const field of fmUpdatedFields) {
            referencesUpdated.push({ path: filePath, field });
          }
          if (bodyUpdated) {
            referencesUpdated.push({ path: filePath, location: "body" });
          }
        } catch {
          partialFailures.push({ path: filePath, reason: "write_error" });
        }
      }
    }

    const result: Record<string, unknown> = {
      valid: true,
      from: oldPath,
      to: newPath,
      references_updated: referencesUpdated,
    };

    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    if (partialFailures.length > 0) {
      result.error = {
        code: "rename_ref_update_failed",
        message: `Rename succeeded but ${partialFailures.length} reference update(s) failed`,
      };
      result.partial_updates = { failed: partialFailures };
    }

    return result;
  }

  /**
   * Check if a link is a simple-name wikilink that matches an ID value.
   * Used for ID-based link stability during rename (§12.5 rule 3).
   */
  private isIdStableLink(linkValue: string, idValue: string): boolean {
    try {
      const parsed = parseLink(linkValue);
      if (!parsed || parsed.format !== "wikilink") return false;
      const target = parsed.target;
      // Must be a simple name (no path separators, no relative prefixes)
      if (target.includes("/") || target.startsWith("./") || target.startsWith("../")) return false;
      return target === idValue;
    } catch {
      return false;
    }
  }

  /**
   * Check if a link value references the old path and compute the new value.
   * Preserves link style (wikilink, markdown link, bare path).
   */
  private updateLinkValue(
    linkValue: string,
    oldPath: string,
    newPath: string,
    oldBase: string,
    newBase: string,
    oldNoExt: string,
    newNoExt: string,
    fromFile: string,
    renamedFileId?: string,
    knownFiles?: string[],
    knownFileCache?: Map<string, ReadResult>,
    nonMarkdownFiles?: Set<string>,
    basenameCounts?: Map<string, number>,
  ): { updated: boolean; newValue: string; warning?: string } {
    let parsed: ParsedLink | null;
    try {
      parsed = parseLink(linkValue);
    } catch {
      return { updated: false, newValue: linkValue };
    }
    if (!parsed) {
      return { updated: false, newValue: linkValue };
    }

    const target = parsed.target;
    const normalizedTarget = this.normalizeLinkTarget(target);

    // Direct text matching
    const matchesOld = (
      normalizedTarget === oldBase ||
      normalizedTarget === oldPath ||
      normalizedTarget === oldNoExt ||
      target === oldPath ||
      target === oldNoExt
    );

    // Resolve the relative link target to an absolute collection path
    let resolvedOldTarget: string | undefined;
    if (parsed.format === "markdown" || parsed.format === "path") {
      const fromDir = path.dirname(fromFile);
      const resolved = path.normalize(path.join(fromDir, target)).replace(/\\/g, "/");
      if (resolved === oldPath || resolved === oldNoExt || resolved + ".md" === oldPath) {
        resolvedOldTarget = oldPath;
      }
    }

    if (!matchesOld && !resolvedOldTarget) {
      return { updated: false, newValue: linkValue };
    }

    // ID-based link stability for links without field-level target constraint:
    // If id_field is explicitly configured and the link matches the renamed file's id,
    // but does NOT match the old filename (case-sensitive), the link resolves via id
    // and is stable — don't rewrite it. (§12.5)
    // Links that match both the id AND the old filename are ambiguous and get rewritten.
    if (this.config.settings.id_field_explicit && renamedFileId && this.isIdStableLink(linkValue, renamedFileId)) {
      const oldBasename = path.basename(oldPath, path.extname(oldPath));
      if (parsed.target !== oldBasename) {
        return { updated: false, newValue: linkValue };
      }
    }

    // Check if the link is ambiguous because other files also match the same simple name
    // (the original link was ambiguous before the rename)
    if (parsed.format === "wikilink" && !target.includes("/") && !target.startsWith("./") && !target.startsWith("../")) {
      if (basenameCounts) {
        const newPathBase = path.basename(newPath, path.extname(newPath));
        const matchingCount = (basenameCounts.get(normalizedTarget) ?? 0) - (newPathBase === normalizedTarget ? 1 : 0);
        if (matchingCount > 0) {
          return { updated: false, newValue: linkValue, warning: `ambiguous link '${linkValue}' not updated` };
        }
      } else {
        const files = knownFiles ?? [];
        const matchingFiles = files.filter((f) => {
          const base = path.basename(f, path.extname(f));
          return base === normalizedTarget && f !== newPath;
        });
        if (matchingFiles.length > 0) {
          return { updated: false, newValue: linkValue, warning: `ambiguous link '${linkValue}' not updated` };
        }
      }
    }

    // Compute new link value preserving style
    if (parsed.format === "wikilink") {
      return this.updateWikilink(linkValue, parsed, oldPath, newPath, oldBase, newBase, fromFile);
    } else if (parsed.format === "markdown") {
      return this.updateMarkdownLink(linkValue, parsed, oldPath, newPath, fromFile);
    } else {
      // Bare path
      return this.updateBarePath(linkValue, parsed, oldPath, newPath, fromFile);
    }
  }

  private updateWikilink(
    _linkValue: string,
    parsed: ParsedLink,
    oldPath: string,
    newPath: string,
    _oldBase: string,
    newBase: string,
    _fromFile: string,
  ): { updated: boolean; newValue: string } {
    const target = parsed.target;
    // Determine new target
    let newTarget: string;
    if (target.includes("/")) {
      // Path-style wikilink: use the new path without extension
      newTarget = newPath.replace(/\.(md|markdown)$/, "");
    } else {
      // Simple name wikilink: check if file moved to a different folder
      const oldDir = path.dirname(oldPath);
      const newDir = path.dirname(newPath);
      if (oldDir !== newDir) {
        // Cross-folder move: upgrade to path-based wikilink
        newTarget = newPath.replace(/\.(md|markdown)$/, "");
      } else {
        // Same folder: use just the new basename
        newTarget = newBase;
      }
    }

    // Rebuild wikilink with anchor and alias preserved
    let result = "[[" + newTarget;
    if (parsed.anchor) result += "#" + parsed.anchor;
    if (parsed.alias) result += "|" + parsed.alias;
    result += "]]";

    // Handle embed prefix
    if ((parsed as unknown as Record<string, unknown>).is_embed) {
      result = "!" + result;
    }

    return { updated: true, newValue: result };
  }

  private updateMarkdownLink(
    _linkValue: string,
    parsed: ParsedLink,
    oldPath: string,
    newPath: string,
    fromFile: string,
  ): { updated: boolean; newValue: string } {
    // Compute new relative path from the referring file to the new target
    const fromDir = path.dirname(fromFile);
    let newRelative = path.relative(fromDir, newPath).replace(/\\/g, "/");
    if (!newRelative.startsWith(".") && !newRelative.startsWith("/")) {
      newRelative = "./" + newRelative;
    }

    // Rebuild markdown link preserving alias (display text) and anchor
    const alias = parsed.alias ?? "";
    let newHref = newRelative;
    if (parsed.anchor) newHref += "#" + parsed.anchor;

    const isEmbed = (parsed as unknown as Record<string, unknown>).is_embed;
    const prefix = isEmbed ? "!" : "";
    const result = `${prefix}[${alias}](${newHref})`;

    return { updated: true, newValue: result };
  }

  private updateBarePath(
    _linkValue: string,
    parsed: ParsedLink,
    _oldPath: string,
    newPath: string,
    fromFile: string,
  ): { updated: boolean; newValue: string } {
    // Compute new relative path
    const fromDir = path.dirname(fromFile);
    let newRelative = path.relative(fromDir, newPath).replace(/\\/g, "/");
    if (!newRelative.startsWith(".") && !newRelative.startsWith("/")) {
      newRelative = "./" + newRelative;
    }
    return { updated: true, newValue: newRelative };
  }

  /**
   * Update links in body text, excluding code blocks and inline code.
   */
  private updateBodyLinks(
    body: string,
    oldPath: string,
    newPath: string,
    oldBase: string,
    newBase: string,
    oldNoExt: string,
    newNoExt: string,
    fromFile: string,
    renamedFileId?: string,
    knownFiles?: string[],
    knownFileCache?: Map<string, ReadResult>,
    nonMarkdownFiles?: Set<string>,
    basenameCounts?: Map<string, number>,
  ): string {
    if (!body) return body;

    const lines = body.split("\n");
    let inFencedCode = false;
    const result: string[] = [];

    for (const line of lines) {
      // Track fenced code blocks
      if (/^```/.test(line.trimStart())) {
        inFencedCode = !inFencedCode;
        result.push(line);
        continue;
      }
      if (inFencedCode) {
        result.push(line);
        continue;
      }
      if (/^(?:\t| {4,})/.test(line)) {
        result.push(line);
        continue;
      }

      // Process line: find inline code spans and protect them
      let processed = "";
      let pos = 0;
      const inlineCodeRegex = /`[^`]+`/g;
      let codeMatch;
      const codeSpans: Array<{ start: number; end: number }> = [];

      while ((codeMatch = inlineCodeRegex.exec(line)) !== null) {
        codeSpans.push({ start: codeMatch.index, end: codeMatch.index + codeMatch[0].length });
      }

      // Process wikilinks and markdown links outside code spans
      const linkRegex = /(?<!\\)(!?\[\[([^\]\n]+)\]\])|(!?\[([^\]]*)\]\(([^)]+)\))/g;
      let linkMatch;
      let lastEnd = 0;

      while ((linkMatch = linkRegex.exec(line)) !== null) {
        const matchStart = linkMatch.index;
        const matchEnd = matchStart + linkMatch[0].length;

        // Skip if inside inline code
        const inCode = codeSpans.some((cs) => matchStart >= cs.start && matchEnd <= cs.end);
        if (inCode) continue;

        // Determine what kind of link this is and try to update it
        const raw = linkMatch[0];
        const updateResult = this.updateLinkValue(
          raw,
          oldPath,
          newPath,
          oldBase,
          newBase,
          oldNoExt,
          newNoExt,
          fromFile,
          renamedFileId,
          knownFiles,
          knownFileCache,
          nonMarkdownFiles,
          basenameCounts,
        );

        if (updateResult.updated && updateResult.newValue !== raw) {
          processed += line.slice(lastEnd, matchStart) + updateResult.newValue;
          lastEnd = matchEnd;
        }
      }

      if (lastEnd > 0) {
        processed += line.slice(lastEnd);
        result.push(processed);
      } else {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  /**
   * Query the collection.
   */
  async query(input: QueryInput): Promise<QueryResult & { error?: { code: string; message: string } }> {
    return await this.observer.trace(
      "collection.query",
      { limit: input.limit, offset: input.offset, type_count: input.types?.length },
      () => this.queryUnobserved(input),
    );
  }

  private async queryUnobserved(input: QueryInput): Promise<QueryResult & { error?: { code: string; message: string } }> {
    const resolutionIndexByCache = new WeakMap<Map<string, IndexedReadResult>, LinkResolutionIndex>();
    const result = await runQuery(input, {
      typeDefs: this.typeDefs,
      scanFiles: () => this.scanFiles(),
      scanAllFiles: () => this.scanAllFiles(),
      read: (relativePath: string) => this.read(relativePath),
      buildFileCache: async (files: string[]) => {
        const built = await this.buildFileCache(files);
        return built as Map<string, IndexedReadResult>;
      },
      buildNonMarkdownSet: (allFiles: string[]) => this.buildNonMarkdownSet(allFiles),
      resolveLink: (
        linkValue: string,
        fromPath: string,
        files: string[],
        fileCache: Map<string, IndexedReadResult>,
        nonMarkdownFiles: Set<string>,
      ) => {
        let resolutionIndex = resolutionIndexByCache.get(fileCache);
        if (!resolutionIndex) {
          resolutionIndex = this.linkResolver.buildIndex(files, fileCache);
          resolutionIndexByCache.set(fileCache, resolutionIndex);
        }
        return this.linkResolver.resolve(
          linkValue,
          fromPath,
          files,
          {
            fileCache,
            nonMarkdownFiles,
            knownFileSet: resolutionIndex.fileSet,
            resolutionIndex,
          },
        );
      },
      evaluateStructuredWhere: (
        condition: Record<string, unknown>,
        frontmatter: Record<string, unknown>,
        relativePath: string,
        fileTypes: string[],
        body?: string | null,
      ) => this.evaluateStructuredWhere(condition, frontmatter, relativePath, fileTypes, body),
      useCel: this.config.spec_profile === "v0.3",
      omitBodyWhenExcluded: this.config.spec_profile === "v0.3",
    });
    return result as QueryResult & { error?: { code: string; message: string } };
  }

  /** Execute the strict portable v0.3 query-object contract. */
  async queryCanonical(input: CanonicalQueryInput): Promise<CanonicalQueryResult> {
    return await this.observer.trace(
      "collection.query_canonical",
      { limit: input.limit, offset: input.offset, type_count: input.types?.length },
      () => this.queryCanonicalUnobserved(input),
    );
  }

  private async queryCanonicalUnobserved(input: CanonicalQueryInput): Promise<CanonicalQueryResult> {
    return await executeCanonicalQuery(input, {
      typeDefs: this.typeDefs,
      scanFiles: () => this.scanFiles(),
      read: (relativePath: string) => this.read(relativePath),
      buildFileCache: async (files: string[]) => {
        const built = await this.buildFileCache(files);
        return built as Map<string, IndexedReadResult>;
      },
    });
  }

  /** Discover valid canonical saved-view records. */
  async listViews(): Promise<SavedViewListResult> {
    return await this.observer.trace(
      "collection.list_views",
      {},
      async () => await listCanonicalViews({
        scanFiles: () => this.scanFiles(),
        read: (relativePath) => this.read(relativePath),
        buildFileCache: async (files) => {
          const built = await this.buildFileCache(files);
          return built as Map<string, IndexedReadResult>;
        },
      }),
    );
  }

  /** Resolve and execute an ordinary `type: view` Markdown record. */
  async executeView(input: ExecuteViewInput): Promise<CanonicalQueryResult> {
    return await this.observer.trace(
      "collection.execute_view",
      { path: input.path, view: input.view, render: input.render },
      () => this.executeViewUnobserved(input),
    );
  }

  private async executeViewUnobserved(input: ExecuteViewInput): Promise<CanonicalQueryResult> {
    return await executeCanonicalView(input, {
      scanFiles: () => this.scanFiles(),
      read: (relativePath) => this.read(relativePath),
      buildFileCache: async (files) => {
        const built = await this.buildFileCache(files);
        return built as Map<string, IndexedReadResult>;
      },
      executeQuery: (query) => this.queryCanonical(query),
    });
  }

  /**
   * Evaluate structured where clause (YAML object format).
   */
  private evaluateStructuredWhere(
    where: string | Record<string, unknown>,
    frontmatter: Record<string, unknown>,
    filePath: string,
    types: string[],
    body?: string | null,
  ): boolean {
    return evaluateWhereClause(where, {
      frontmatter,
      filePath,
      types,
      body,
      specProfile: this.config.spec_profile,
    });
  }

  /**
   * Check uniqueness constraints when updating a file.
   * Returns issues for any violations.
   */
  private valuesEqualForUniqueness(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) return a === b;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  private async checkV03UniqueForFile(
    relativePath: string,
    frontmatter: Record<string, unknown>,
    typeDefs: TypeDefinition[],
    issues: MdbaseError[],
  ): Promise<void> {
    const files = await this.scanFiles();
    for (const typeDef of typeDefs) {
      if (!typeDef.collection?.unique) continue;
      const currentTypes = typeDefs.map((t) => t.name);
      for (const rule of typeDef.collection.unique) {
        const fieldValue = getFieldReferenceValue(frontmatter, rule.field);
        if (!fieldValue.present || fieldValue.value === null || fieldValue.value === undefined) continue;
        if (!this.v03UniqueRuleApplies(rule, typeDef.name, relativePath, currentTypes)) continue;
        const key = JSON.stringify(fieldValue.value);
        for (const otherPath of files) {
          if (otherPath === relativePath) continue;
          const other = await this.read(otherPath);
          const otherFrontmatter = other.rawFrontmatter ?? other.frontmatter;
          if (!otherFrontmatter) continue;
          const otherTypes = other.types ?? this.getTypesForFile(otherPath, otherFrontmatter);
          if (!otherTypes.includes(typeDef.name)) continue;
          if (!this.v03UniqueRuleApplies(rule, typeDef.name, otherPath, otherTypes)) continue;
          const otherValue = getFieldReferenceValue(otherFrontmatter, rule.field);
          if (!otherValue.present || otherValue.value === null || otherValue.value === undefined) continue;
          if (JSON.stringify(otherValue.value) === key) {
            issues.push({
              code: "duplicate_value",
              message: `Duplicate value "${String(fieldValue.value)}" for unique field "${rule.field}"`,
              field: rule.field,
              path: relativePath,
              severity: "error",
            });
            break;
          }
        }
      }
    }
  }

  private v03UniqueRuleApplies(
    rule: { scope?: "collection" | "type" | "path_glob"; path_glob?: string },
    typeName: string,
    relativePath: string,
    fileTypes: string[],
  ): boolean {
    const scope = rule.scope ?? "type";
    if (scope === "collection") return true;
    if (scope === "type") return fileTypes.includes(typeName);
    if (scope === "path_glob") {
      return typeof rule.path_glob === "string" && picomatch(rule.path_glob, { dot: true })(relativePath);
    }
    return false;
  }

  private shouldCheckUniquenessOnUpdate(
    originalFrontmatter: Record<string, unknown>,
    updatedFrontmatter: Record<string, unknown>,
    types: string[],
  ): boolean {
    const idField = this.config.settings.id_field;
    if (!this.valuesEqualForUniqueness(originalFrontmatter[idField], updatedFrontmatter[idField])) {
      return true;
    }

    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (typeDef?.fields) {
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          if (!fieldDef.unique) continue;
          if (!this.valuesEqualForUniqueness(originalFrontmatter[fieldName], updatedFrontmatter[fieldName])) {
            return true;
          }
        }
      }
      for (const rule of typeDef?.collection?.unique ?? []) {
        const before = getFieldReferenceValue(originalFrontmatter, rule.field).value;
        const after = getFieldReferenceValue(updatedFrontmatter, rule.field).value;
        if (!this.valuesEqualForUniqueness(before, after)) {
          return true;
        }
      }
    }

    return false;
  }

  private async checkUpdateUniqueness(
    updatingPath: string,
    frontmatter: Record<string, unknown>,
    types: string[],
  ): Promise<MdbaseError[]> {
    const issues: MdbaseError[] = [];
    if (!this.hasUniquenessValues(updatingPath, frontmatter, types)) {
      return issues;
    }
    const files = await this.scanFiles();
    const fileCache = await this.buildFileCache(files);

    // Collect all file frontmatter except the updating file
    const otherFiles = new Map<string, Record<string, unknown>>();
    for (const relativePath of files) {
      if (relativePath === updatingPath) continue;
      const readResult = fileCache.get(relativePath);
      if (readResult?.frontmatter) {
        otherFiles.set(relativePath, readResult.rawFrontmatter ?? readResult.frontmatter);
      }
    }

    // Check id_field uniqueness
    const idField = this.config.settings.id_field;
    const myIdValue = frontmatter[idField];
    if (myIdValue !== null && myIdValue !== undefined) {
      for (const [otherPath, otherFm] of otherFiles) {
        const otherValue = otherFm[idField];
        if (otherValue !== null && otherValue !== undefined &&
            JSON.stringify(myIdValue) === JSON.stringify(otherValue)) {
          issues.push({
            code: "duplicate_id",
            message: `Duplicate id "${myIdValue}" (conflicts with ${otherPath})`,
            field: idField,
            path: updatingPath,
            severity: "error",
          });
          break;
        }
      }
    }

    // Check unique field constraints
    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      if (typeDef?.fields) {
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          if (!fieldDef.unique) continue;
          const myValue = frontmatter[fieldName];
          if (myValue === null || myValue === undefined) continue;
          for (const [otherPath, otherFm] of otherFiles) {
            const otherValue = otherFm[fieldName];
            if (otherValue !== null && otherValue !== undefined &&
                JSON.stringify(myValue) === JSON.stringify(otherValue)) {
              issues.push({
                code: "duplicate_value",
                message: `Duplicate value "${myValue}" for unique field "${fieldName}" (conflicts with ${otherPath})`,
                field: fieldName,
                path: updatingPath,
                severity: "error",
              });
              break;
            }
          }
        }
      }
      for (const rule of typeDef?.collection?.unique ?? []) {
        const myValue = getFieldReferenceValue(frontmatter, rule.field);
        if (!myValue.present || myValue.value === null || myValue.value === undefined) continue;
        for (const [otherPath, otherFm] of otherFiles) {
          const otherTypes = this.getTypesForFile(otherPath, otherFm);
          if (!otherTypes.includes(typeName)) continue;
          if (!this.v03UniqueRuleApplies(rule, typeName, otherPath, otherTypes)) continue;
          const otherValue = getFieldReferenceValue(otherFm, rule.field);
          if (!otherValue.present || otherValue.value === null || otherValue.value === undefined) continue;
          if (JSON.stringify(myValue.value) === JSON.stringify(otherValue.value)) {
            issues.push({
              code: "duplicate_value",
              message: `Duplicate value "${String(myValue.value)}" for unique field "${rule.field}" (conflicts with ${otherPath})`,
              field: rule.field,
              path: updatingPath,
              severity: "error",
            });
            break;
          }
        }
      }
    }

    return issues;
  }

  /** Avoid a collection scan when the candidate supplies no constrained value. */
  private hasUniquenessValues(
    relativePath: string,
    frontmatter: Record<string, unknown>,
    types: string[],
  ): boolean {
    const idValue = frontmatter[this.config.settings.id_field];
    if (idValue !== null && idValue !== undefined) return true;

    for (const typeName of types) {
      const typeDef = this.typeDefs.get(typeName);
      for (const [fieldName, fieldDef] of Object.entries(typeDef?.fields ?? {})) {
        const value = frontmatter[fieldName];
        if (fieldDef.unique && value !== null && value !== undefined) return true;
      }
      for (const rule of typeDef?.collection?.unique ?? []) {
        if (!this.v03UniqueRuleApplies(rule, typeName, relativePath, types)) continue;
        const value = getFieldReferenceValue(frontmatter, rule.field);
        if (value.present && value.value !== null && value.value !== undefined) return true;
      }
    }
    return false;
  }

  /**
   * Batch delete: delete all files matching a where expression.
   */
  async batchDelete(input: BatchDeleteInput): Promise<BatchResult> {
    return await this.observer.trace(
      "collection.batch_delete",
      { dry_run: input.dry_run, check_backlinks: input.check_backlinks },
      () => this.batchDeleteUnobserved(input),
    );
  }

  private async batchDeleteUnobserved(input: BatchDeleteInput): Promise<BatchResult> {
    // Find matching files
    const files = await this.scanFiles();
    const fileCache = await this.buildFileCache(files);
    const matchingPaths: string[] = [];

    for (const relativePath of files) {
      const readResult = fileCache.get(relativePath);
      if (!readResult || readResult.error) continue;
      const ctx = {
        frontmatter: readResult.frontmatter ?? {},
        path: relativePath,
        types: readResult.types ?? [],
        body: readResult.body,
      };
      if (this.evaluateStructuredWhere(input.where, ctx.frontmatter, ctx.path, ctx.types, ctx.body)) {
        matchingPaths.push(relativePath);
      }
    }

    if (matchingPaths.length === 0) {
      return {
        batch_result: {
          total: 0,
          succeeded: 0,
          failed: 0,
          details: [],
        },
      };
    }

    const checkBacklinks = input.check_backlinks !== false;
    const brokenLinks = checkBacklinks ? await this.findBacklinks(matchingPaths) : [];

    // Dry run: return what would be deleted without actually deleting
    if (input.dry_run) {
      const details: BatchResultDetail[] = matchingPaths.map((p) => ({
        path: p,
        status: "success" as const,
      }));
      return {
        batch_result: {
          total: matchingPaths.length,
          succeeded: matchingPaths.length,
          failed: 0,
          details,
        },
        broken_links: checkBacklinks ? brokenLinks : undefined,
      };
    }

    // Actually delete
    let succeeded = 0;
    let failed = 0;
    const details: BatchResultDetail[] = [];

    for (const relativePath of matchingPaths) {
      // Check for simulated I/O error
      if (this.ioErrorPaths?.has(relativePath)) {
        failed++;
        details.push({ path: relativePath, status: "failed", error: { code: "io_error", message: `I/O error deleting ${relativePath}` } });
        continue;
      }
      try {
        const fullPath = path.join(this.root, relativePath);
        await fs.promises.unlink(fullPath);
        if (this.cache) {
          await this.cache.deleteFile(relativePath);
        }
        succeeded++;
        details.push({ path: relativePath, status: "success" });
      } catch {
        failed++;
        details.push({ path: relativePath, status: "failed", error: { code: "io_error", message: `Failed to delete ${relativePath}` } });
      }
    }

    this.invalidateRuntimeCaches();

    return {
      batch_result: {
        total: matchingPaths.length,
        succeeded,
        failed,
        details,
      },
      broken_links: checkBacklinks ? brokenLinks : undefined,
    };
  }

  /**
   * Batch update: update all files matching a where expression, or update specific files.
   * Two modes:
   *   1. where + fields: update all matching files with the same fields
   *   2. updates[]: array of {path, fields} for per-file updates
   */
  async batchUpdate(input: BatchUpdateInput): Promise<BatchResult> {
    return await this.observer.trace(
      "collection.batch_update",
      { dry_run: input.dry_run, update_count: input.updates?.length },
      () => this.batchUpdateUnobserved(input),
    );
  }

  private async batchUpdateUnobserved(input: BatchUpdateInput): Promise<BatchResult> {
    // Mode 1: updates array (pre-validation all-or-nothing)
    if (input.updates) {
      return await this.batchUpdateByList(input.updates, input.dry_run);
    }

    // Mode 2: where + fields
    if (!input.where || !input.fields) {
      return {
        batch_result: { total: 0, succeeded: 0, failed: 0, details: [] },
        error: { code: "invalid_input", message: "batch_update requires where+fields or updates array" },
      };
    }

    // Find matching files
    const files = await this.scanFiles();
    const matchingPaths: string[] = [];

    for (const relativePath of files) {
      const readResult = await this.read(relativePath);
      if (readResult.error) continue;
      const ctx = {
        frontmatter: readResult.frontmatter ?? {},
        path: relativePath,
        types: readResult.types ?? [],
        body: readResult.body,
      };
      if (this.evaluateStructuredWhere(input.where, ctx.frontmatter, ctx.path, ctx.types, ctx.body)) {
        matchingPaths.push(relativePath);
      }
    }

    if (matchingPaths.length === 0) {
      return {
        batch_result: { total: 0, succeeded: 0, failed: 0, details: [] },
      };
    }

    // Pre-validate all files when validation is "error"
    if (this.config.settings.default_validation === "error") {
      for (const relativePath of matchingPaths) {
        const existing = await parseFileAsync(path.join(this.root, relativePath));
        const merged = { ...existing.frontmatter, ...input.fields };
        const types = this.getTypesForFile(relativePath, merged);
        if (types.length > 0) {
          // Coerce before validation
          for (const typeName of types) {
            const typeDef = this.typeDefs.get(typeName);
            if (!typeDef?.fields) continue;
            for (const [key, value] of Object.entries(merged)) {
              if (this.config.settings.explicit_type_keys.includes(key)) continue;
              const fieldDef = typeDef.fields[key];
              if (!fieldDef || value === null || value === undefined) continue;
              merged[key] = coerceForRead(value, fieldDef);
            }
          }
          const valResult = this.validateForWrite(merged, merged, types);
          if (!valResult.valid) {
            return {
              batch_result: { total: matchingPaths.length, succeeded: 0, failed: matchingPaths.length, details: [] },
              error: { code: "validation_failed", message: `Validation failed for ${relativePath}` },
            };
          }
          const policyIssues = await this.validateCollectionPoliciesForWrite(relativePath, merged, merged, types);
          if (hasValidationErrors(policyIssues)) {
            return {
              batch_result: { total: matchingPaths.length, succeeded: 0, failed: matchingPaths.length, details: [] },
              error: { code: "validation_failed", message: `Collection policy validation failed for ${relativePath}` },
            };
          }
        }
      }
    }

    // Dry run
    if (input.dry_run) {
      const details: BatchResultDetail[] = matchingPaths.map((p) => ({
        path: p,
        status: "success" as const,
      }));
      return {
        batch_result: {
          total: matchingPaths.length,
          succeeded: matchingPaths.length,
          failed: 0,
          details,
        },
      };
    }

    // Actually update
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const details: BatchResultDetail[] = [];
    const failedPaths = new Set<string>();
    const fileCache = this.skipDependents ? await this.buildFileCache(files) : undefined;
    const nonMdSet = this.skipDependents ? this.buildNonMarkdownSet(await this.scanAllFiles()) : undefined;
    const resolutionIndex = this.skipDependents && fileCache
      ? this.linkResolver.buildIndex(files, fileCache)
      : undefined;

    for (const relativePath of matchingPaths) {
      // Check if this file depends on a failed file (skip_dependents)
      if (this.skipDependents && failedPaths.size > 0) {
        const fullPath = path.join(this.root, relativePath);
        const parsed = await parseFileAsync(fullPath);
        const typeNames = this.getTypesForFile(relativePath, parsed.frontmatter);
        let dependsOnFailed = false;
        // Collect title→path mappings from failed files for link resolution
        const failedTitles = new Map<string, string>();
        for (const fp of failedPaths) {
          const fpFull = path.join(this.root, fp);
          try {
            const fpParsed = await parseFileAsync(fpFull);
            if (fpParsed.frontmatter.title) {
              failedTitles.set(String(fpParsed.frontmatter.title), fp);
            }
          } catch { /* skip */ }
          failedTitles.set(path.basename(fp, path.extname(fp)), fp);
        }
        for (const typeName of typeNames) {
          const typeDef = this.typeDefs.get(typeName);
          if (!typeDef?.fields) continue;
          for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
            if (fieldDef.type === "link" && parsed.frontmatter[fieldName]) {
              const linkVal = String(parsed.frontmatter[fieldName]);
              // Extract wikilink target
              const wikiMatch = linkVal.match(/\[\[([^\]#|]+)/);
              const target = wikiMatch ? wikiMatch[1].trim() : linkVal;
              // Check if target matches any failed file's title or basename
              if (failedTitles.has(target)) {
                dependsOnFailed = true;
              }
              // Also try full link resolution
              if (!dependsOnFailed) {
                try {
                  const resolved = this.linkResolver.resolve(
                    linkVal,
                    relativePath,
                    files,
                    {
                      fileCache,
                      nonMarkdownFiles: nonMdSet,
                      knownFileSet: resolutionIndex?.fileSet,
                      resolutionIndex,
                    },
                  );
                  if (resolved.resolved && failedPaths.has(resolved.resolved)) {
                    dependsOnFailed = true;
                  }
                } catch { /* skip */ }
              }
            }
            if (dependsOnFailed) break;
          }
          if (dependsOnFailed) break;
        }
        if (dependsOnFailed) {
          skipped++;
          details.push({ path: relativePath, status: "skipped" });
          continue;
        }
      }

      // Check for simulated I/O error
      if (this.ioErrorPaths?.has(relativePath)) {
        failed++;
        failedPaths.add(relativePath);
        details.push({ path: relativePath, status: "failed", error: { code: "io_error", message: `I/O error writing ${relativePath}` } });
        continue;
      }
      try {
        const result = await this.update({
          path: relativePath,
          fields: input.fields,
        });
        if (result.error) {
          failed++;
          failedPaths.add(relativePath);
          details.push({ path: relativePath, status: "failed", error: result.error });
        } else {
          succeeded++;
          details.push({ path: relativePath, status: "success" });
        }
      } catch {
        failed++;
        failedPaths.add(relativePath);
        details.push({ path: relativePath, status: "failed", error: { code: "io_error", message: `Failed to update ${relativePath}` } });
      }
    }

    return {
      batch_result: {
        total: matchingPaths.length,
        succeeded,
        failed,
        ...(skipped > 0 ? { skipped } : {}),
        details,
      },
    };
  }

  /**
   * Batch update by explicit list of file updates. All-or-nothing validation.
   */
  private async batchUpdateByList(
    updates: Array<{ path: string; fields: Record<string, unknown> }>,
    dryRun?: boolean,
  ): Promise<BatchResult> {
    // Pre-validate all files when validation is "error"
    if (this.config.settings.default_validation === "error") {
      for (const upd of updates) {
        const fullPath = path.join(this.root, upd.path);
        if (!await this.fileExists(fullPath)) {
          return {
            batch_result: { total: updates.length, succeeded: 0, failed: updates.length, details: [] },
            error: { code: "file_not_found", message: `File not found: ${upd.path}` },
          };
        }
        const existing = await parseFileAsync(fullPath);
        const merged = { ...existing.frontmatter, ...upd.fields };
        const types = this.getTypesForFile(upd.path, merged);
        if (types.length > 0) {
          for (const typeName of types) {
            const typeDef = this.typeDefs.get(typeName);
            if (!typeDef?.fields) continue;
            for (const [key, value] of Object.entries(merged)) {
              if (this.config.settings.explicit_type_keys.includes(key)) continue;
              const fieldDef = typeDef.fields[key];
              if (!fieldDef || value === null || value === undefined) continue;
              merged[key] = coerceForRead(value, fieldDef);
            }
          }
          const valResult = this.validateForWrite(merged, merged, types);
          if (!valResult.valid) {
            return {
              batch_result: { total: updates.length, succeeded: 0, failed: updates.length, details: [] },
              error: { code: "validation_failed", message: `Validation failed for ${upd.path}` },
            };
          }
          const policyIssues = await this.validateCollectionPoliciesForWrite(upd.path, merged, merged, types);
          if (hasValidationErrors(policyIssues)) {
            return {
              batch_result: { total: updates.length, succeeded: 0, failed: updates.length, details: [] },
              error: { code: "validation_failed", message: `Collection policy validation failed for ${upd.path}` },
            };
          }
        }
      }
    }

    if (dryRun) {
      const details: BatchResultDetail[] = updates.map((u) => ({
        path: u.path,
        status: "success" as const,
      }));
      return {
        batch_result: {
          total: updates.length,
          succeeded: updates.length,
          failed: 0,
          details,
        },
      };
    }

    // Execute all updates
    let succeeded = 0;
    let failed = 0;
    const details: BatchResultDetail[] = [];

    for (const upd of updates) {
      try {
        const result = await this.update({ path: upd.path, fields: upd.fields });
        if (result.error) {
          failed++;
          details.push({ path: upd.path, status: "failed", error: result.error });
        } else {
          succeeded++;
          details.push({ path: upd.path, status: "success" });
        }
      } catch {
        failed++;
        details.push({ path: upd.path, status: "failed", error: { code: "io_error", message: `Failed to update ${upd.path}` } });
      }
    }

    if (succeeded > 0) {
      this.invalidateRuntimeCaches({ fileLists: false, nonMarkdown: false });
    }

    return {
      batch_result: {
        total: updates.length,
        succeeded,
        failed,
        details,
      },
    };
  }

  /**
   * Backfill defaults and/or generated fields for matching files.
   */
  async backfill(input: BackfillInput): Promise<BatchResult> {
    return await this.observer.trace(
      "collection.backfill",
      { type: input.type, dry_run: input.dry_run, field_count: input.fields?.length },
      () => this.backfillUnobserved(input),
    );
  }

  private async backfillUnobserved(input: BackfillInput): Promise<BatchResult> {
    const applyDefaults = input.apply?.defaults !== false;
    const applyGenerated = input.apply?.generated !== false;
    const typeName = input.type ? String(input.type).toLowerCase() : undefined;

    if (!typeName && !input.where) {
      return {
        error: { code: "invalid_request", message: "backfill requires type or where" },
        batch_result: { total: 0, succeeded: 0, failed: 0, details: [] },
      };
    }

    if (typeName && !this.typeDefs.has(typeName)) {
      return {
        error: { code: "unknown_type", message: `Unknown type "${typeName}"` },
        batch_result: { total: 0, succeeded: 0, failed: 0, details: [] },
      };
    }

    const files = await this.scanFiles();
    const fileCache = await this.buildFileCache(files);

    const candidates: Array<{
      path: string;
      rawFrontmatter: Record<string, unknown>;
      frontmatter: Record<string, unknown>;
      types: string[];
      body?: string | null;
    }> = [];

    for (const relativePath of files) {
      const readResult = fileCache.get(relativePath);
      if (!readResult || readResult.error) continue;
      const types = readResult.types ?? [];
      if (typeName && !types.includes(typeName)) continue;
      if (input.where) {
        const ctx = {
          frontmatter: readResult.frontmatter ?? {},
          path: relativePath,
          types,
          body: readResult.body,
        };
        const matches = this.evaluateStructuredWhere(
          input.where,
          ctx.frontmatter,
          ctx.path,
          ctx.types,
          ctx.body,
        );
        if (!matches) continue;
      }
      candidates.push({
        path: relativePath,
        rawFrontmatter: (readResult.rawFrontmatter ?? readResult.frontmatter ?? {}) as Record<string, unknown>,
        frontmatter: (readResult.frontmatter ?? {}) as Record<string, unknown>,
        types,
        body: readResult.body,
      });
    }

    if (candidates.length === 0) {
      return {
        batch_result: { total: 0, succeeded: 0, failed: 0, details: [] },
      };
    }

    const fieldFilter = input.fields ? new Set(input.fields.map(String)) : null;

    // Precompute sequence counters for generated sequence fields
    const sequenceCounters = new Map<string, Map<string, number>>();
    if (applyGenerated) {
      const relevantTypes = typeName
        ? [typeName]
        : Array.from(new Set(candidates.flatMap((c) => c.types)));

      for (const tName of relevantTypes) {
        const typeDef = this.typeDefs.get(tName);
        if (!typeDef?.fields) continue;
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          if (fieldFilter && !fieldFilter.has(fieldName)) continue;
          const gen = fieldDef.generated;
          const isSequence = gen === "sequence" || (typeof gen === "object" && gen !== null && "sequence" in gen);
          if (!isSequence) continue;
          const startConfig = typeof gen === "object" ? (gen as Record<string, unknown>).sequence : undefined;
          const start = (typeof startConfig === "object" && startConfig !== null)
            ? ((startConfig as Record<string, unknown>).start as number ?? 1)
            : 1;
          let max = -Infinity;
          for (const [filePath, readResult] of fileCache) {
            const fileTypes = readResult.types ?? [];
            if (!fileTypes.includes(tName)) continue;
            const rawFm = (readResult.rawFrontmatter ?? readResult.frontmatter ?? {}) as Record<string, unknown>;
            const val = rawFm[fieldName];
            if (typeof val === "number" && Number.isFinite(val)) {
              max = Math.max(max, val);
            }
          }
          const next = max === -Infinity ? start : max + 1;
          if (!sequenceCounters.has(tName)) sequenceCounters.set(tName, new Map());
          sequenceCounters.get(tName)!.set(fieldName, next);
        }
      }
    }

    const updates: Array<{
      path: string;
      body: string | null | undefined;
      updated: Record<string, unknown>;
      types: string[];
    }> = [];
    const details: BatchResultDetail[] = [];
    const detailByPath = new Map<string, BatchResultDetail>();
    let skipped = 0;
    let noopSucceeded = 0;

    // Deterministic order for sequence assignment
    candidates.sort((a, b) => a.path.localeCompare(b.path));

    for (const candidate of candidates) {
      const updated: Record<string, unknown> = { ...candidate.rawFrontmatter };
      let changed = false;
      let sawExplicitNull = false;

      const typeNamesToApply = typeName ? [typeName] : candidate.types;
      for (const tName of typeNamesToApply) {
        const typeDef = this.typeDefs.get(tName);
        if (!typeDef?.fields) continue;
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          if (fieldFilter && !fieldFilter.has(fieldName)) continue;
          if (fieldDef.computed) continue;
          if (fieldName in updated) {
            if (updated[fieldName] === null) {
              sawExplicitNull = true;
            }
            continue; // treat null as present
          }

          if (applyGenerated && fieldDef.generated) {
            let generated: unknown;
            const gen = fieldDef.generated;
            const isSequence = gen === "sequence" || (typeof gen === "object" && gen !== null && "sequence" in gen);
            if (isSequence) {
              const counter = sequenceCounters.get(tName)?.get(fieldName);
              if (counter !== undefined) {
                generated = counter;
                sequenceCounters.get(tName)!.set(fieldName, counter + 1);
              }
            } else {
              generated = this.generateValue(fieldDef, updated, {
                typeName: tName,
                fieldName,
                relativePath: candidate.path,
              });
            }

            if (generated === undefined || generated === null) {
              if (applyDefaults && fieldDef.default !== undefined) {
                updated[fieldName] = fieldDef.default;
              } else {
                updated[fieldName] = null;
              }
            } else {
              updated[fieldName] = generated;
            }
            if (updated[fieldName] !== null && updated[fieldName] !== undefined) {
              updated[fieldName] = coerceForRead(updated[fieldName], fieldDef);
            }
            changed = true;
            continue;
          }

          if (applyDefaults && fieldDef.default !== undefined) {
            updated[fieldName] = fieldDef.default;
            if (updated[fieldName] !== null && updated[fieldName] !== undefined) {
              updated[fieldName] = coerceForRead(updated[fieldName], fieldDef);
            }
            changed = true;
          }
        }
      }

      if (!changed) {
        if (sawExplicitNull) {
          skipped++;
          const detail = { path: candidate.path, status: "skipped" as const };
          details.push(detail);
          detailByPath.set(candidate.path, detail);
        } else {
          noopSucceeded++;
          const detail = { path: candidate.path, status: "success" as const };
          details.push(detail);
          detailByPath.set(candidate.path, detail);
        }
        continue;
      }

      updates.push({
        path: candidate.path,
        body: candidate.body,
        updated,
        types: candidate.types,
      });
      const detail = { path: candidate.path, status: "success" as const };
      details.push(detail);
      detailByPath.set(candidate.path, detail);
    }

    if (updates.length === 0) {
      return {
        batch_result: {
          total: candidates.length,
          succeeded: noopSucceeded,
          failed: 0,
          skipped: skipped > 0 ? skipped : undefined,
          details,
        },
      };
    }

    // Pre-validate all updates when validation is "error"
    if (this.config.settings.default_validation === "error") {
      for (const upd of updates) {
        if (upd.types.length > 0) {
          const valResult = this.validateForWrite(upd.updated, upd.updated, upd.types);
          if (!valResult.valid) {
            return {
              error: { code: "validation_failed", message: "Validation failed on backfill" },
              batch_result: { total: 0, succeeded: 0, failed: 0, details: [] },
            };
          }
        }
        const policyIssues = await this.validateCollectionPoliciesForWrite(upd.path, upd.updated, upd.updated, upd.types);
        if (hasValidationErrors(policyIssues)) {
          return {
            error: { code: "validation_failed", message: "Collection policy validation failed on backfill" },
            batch_result: { total: 0, succeeded: 0, failed: 0, details: [] },
          };
        }
      }
    }

    if (input.dry_run) {
      return {
        batch_result: {
          total: candidates.length,
          succeeded: updates.length + noopSucceeded,
          failed: 0,
          skipped: skipped > 0 ? skipped : undefined,
          details,
        },
      };
    }

    // Apply updates
    let succeeded = 0;
    let failed = 0;

    for (const upd of updates) {
      if (this.ioErrorPaths?.has(upd.path)) {
        failed++;
        const detail = detailByPath.get(upd.path);
        if (detail) {
          detail.status = "failed";
          detail.error = { code: "io_error", message: `I/O error updating ${upd.path}` };
        }
        continue;
      }
      try {
        const diskFrontmatter = { ...upd.updated };
        // Strip computed fields from disk frontmatter
        for (const typeNameForStrip of upd.types) {
          const typeDef = this.typeDefs.get(typeNameForStrip);
          if (!typeDef?.fields) continue;
          for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
            if (fieldDef.computed) {
              delete diskFrontmatter[fieldName];
            }
          }
        }
        const content = serializeFile(
          diskFrontmatter,
          upd.body ?? "",
          this.config.settings.write_nulls,
          this.config.settings.write_empty_lists,
        );
        const fullPath = path.join(this.root, upd.path);
        await fs.promises.writeFile(fullPath, content);
        await this.updateCacheForPath(upd.path);
        succeeded++;
      } catch {
        failed++;
        const detail = detailByPath.get(upd.path);
        if (detail) {
          detail.status = "failed";
          detail.error = { code: "io_error", message: `Failed to update ${upd.path}` };
        }
      }
    }

    return {
      batch_result: {
        total: candidates.length,
        succeeded: succeeded + noopSucceeded,
        failed,
        skipped: skipped > 0 ? skipped : undefined,
        details,
      },
    };
  }

  /**
   * Run a migration manifest by id.
   */
  async migrate(input: { id?: string; dry_run?: boolean }): Promise<Record<string, unknown>> {
    return await this.observer.trace(
      "collection.migrate",
      { migration: input.id, dry_run: input.dry_run },
      () => this.migrateUnobserved(input),
    );
  }

  private async migrateUnobserved(input: { id?: string; dry_run?: boolean }): Promise<Record<string, unknown>> {
    if (!input.id) {
      return { error: { code: "invalid_request", message: "migrate requires id" } };
    }

    const migrationsRoot = path.join(this.root, this.config.settings.migrations_folder);
    const manifest = await this.loadMigrationManifest(migrationsRoot, input.id);
    if (!manifest) {
      return { error: { code: "invalid_migration", message: `Migration "${input.id}" not found` } };
    }

    if (!Array.isArray(manifest.steps)) {
      return { error: { code: "invalid_migration", message: "Migration manifest missing steps" } };
    }

    const stepsResult: Array<Record<string, unknown>> = [];
    for (const step of manifest.steps) {
      if (!step || typeof step !== "object") {
        return { error: { code: "invalid_migration", message: "Invalid migration step" } };
      }
      const stepObj = step as Record<string, unknown>;
      const op = String(stepObj.op ?? "");
      const stepId = stepObj.id !== undefined ? String(stepObj.id) : undefined;

      if (op === "add_field") {
        stepsResult.push({ id: stepId, op, status: "manual" });
        continue;
      }

      if (op === "backfill") {
        const backfillResult = await this.backfill({
          type: stepObj.type as string | undefined,
          where: stepObj.where as string | Record<string, unknown> | undefined,
          fields: Array.isArray(stepObj.fields) ? stepObj.fields.map(String) : undefined,
          apply: stepObj.apply as { defaults?: boolean; generated?: boolean } | undefined,
          dry_run: input.dry_run ?? false,
        });
        if (backfillResult.error) {
          return { error: { code: "migration_failed", message: "Migration failed" } };
        }
        stepsResult.push({ id: stepId, op, status: "success" });
        continue;
      }

      return { error: { code: "invalid_migration", message: `Unknown migration op "${op}"` } };
    }

    return {
      migration_result: {
        id: manifest.id,
        steps: stepsResult,
      },
    };
  }

  private async loadMigrationManifest(
    migrationsRoot: string,
    migrationId: string,
  ): Promise<Record<string, unknown> | null> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(migrationsRoot, { withFileTypes: true });
    } catch {
      return null;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(migrationsRoot, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.loadMigrationManifest(fullPath, migrationId);
        if (nested) return nested;
        continue;
      }
      if (!entry.name.endsWith(".md") && !entry.name.endsWith(".markdown")) continue;
      const parsed = await parseFileAsync(fullPath);
      if (parsed.error) continue;
      const data = parsed.frontmatter as Record<string, unknown>;
      if (!data || typeof data !== "object") continue;
      if (data.id && String(data.id) === migrationId) {
        return data;
      }
    }

    return null;
  }

  /**
   * Rebuild cache from disk.
   */
  async cacheRebuild(): Promise<CacheOpResult> {
    return await this.observer.trace(
      "collection.cache_rebuild",
      {},
      () => this.cacheRebuildUnobserved(),
    );
  }

  private async cacheRebuildUnobserved(): Promise<CacheOpResult> {
    if (!this.cache) {
      return { success: false, error: { code: "cache_unavailable", message: "Cache store is unavailable" } };
    }
    const cacheRoot = this.config.settings.cache_folder;
    await this.cache.clear();
    this.cache = await CacheStoreAsync.open(this.root, cacheRoot);
    if (!this.cache) {
      return { success: false, error: { code: "cache_unavailable", message: "Cache store is unavailable" } };
    }
    this.invalidateRuntimeCaches();
    const files = await this.scanFiles();
    for (const relativePath of files) {
      await this.updateCacheForPath(relativePath);
    }
    await this.cache.flush();
    this.invalidateRuntimeCaches({ fileLists: false, nonMarkdown: false });
    return { success: true };
  }

  /**
   * Clear cache from disk.
   */
  async cacheClear(): Promise<CacheOpResult> {
    return await this.observer.trace(
      "collection.cache_clear",
      {},
      () => this.cacheClearUnobserved(),
    );
  }

  private async cacheClearUnobserved(): Promise<CacheOpResult> {
    if (!this.cache) {
      return { success: true };
    }
    await this.cache.clear();
    this.cache = null;
    this.invalidateRuntimeCaches({ fileLists: false, nonMarkdown: false });
    return { success: true };
  }

  async close(): Promise<void> {
    return await this.observer.trace(
      "collection.close",
      {},
      () => this.closeUnobserved(),
    );
  }

  private async closeUnobserved(): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.close();
    } finally {
      this.cache = null;
    }
  }

  private generateValue(
    fieldDef: FieldDefinition,
    frontmatter: Record<string, unknown>,
    context?: { typeName?: string; fieldName?: string; relativePath?: string },
  ): unknown {
    const gen = fieldDef.generated;
    if (typeof gen === "string") {
      switch (gen) {
        case "ulid":
          return ulid();
        case "uuid":
          return crypto.randomUUID();
        case "now":
          return new Date().toISOString();
        case "now_on_write":
          return new Date().toISOString();
        case "sequence":
          // Handled inline in create() flow
          return undefined;
      }
    } else if (typeof gen === "object" && gen !== null) {
      // Random strategy: { random: length }
      if ("random" in gen) {
        const length = (gen as Record<string, unknown>).random as number;
        const charset = "abcdefghijklmnopqrstuvwxyz0123456789";
        let result = "";
        for (let i = 0; i < length; i++) {
          result += charset[Math.floor(Math.random() * charset.length)];
        }
        return result;
      }
      // Sequence strategy: { sequence: ... } — handled inline in create()
      if ("sequence" in gen) {
        return undefined;
      }
      // Derived field: { from: "field", transform: "slugify" }
      const genObj = gen as { from: string; transform: string };
      let sourceValue: unknown;
      if (genObj.from && genObj.from.startsWith("file.")) {
        const prop = genObj.from.slice(5);
        if ((prop === "name" || prop === "basename") && context?.relativePath) {
          sourceValue = path.basename(context.relativePath, path.extname(context.relativePath));
        }
      } else if (genObj.from) {
        sourceValue = frontmatter[genObj.from];
      }
      if (sourceValue === null || sourceValue === undefined) {
        return null;
      }
      if (genObj.transform === "slugify") {
        return slugify(String(sourceValue));
      }
      if (genObj.transform === "lowercase") {
        return String(sourceValue).toLowerCase();
      }
      if (genObj.transform === "uppercase") {
        return String(sourceValue).toUpperCase();
      }
      // No transform or unrecognized transform: return source value as-is
      return String(sourceValue);
    }
    return undefined;
  }

  /**
   * Validate link fields in frontmatter: validate_exists, target constraint, ambiguous_link.
   */
  private async validateLinkFields(
    typeDefs: TypeDefinition[],
    frontmatter: Record<string, unknown>,
    relativePath: string,
    result: { valid: boolean; issues: MdbaseError[] },
  ): Promise<void> {
    for (const typeDef of typeDefs) {
      if (typeDef.fields) {
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          if (fieldDef.type === "link") {
            await this.validateSingleLink(fieldName, fieldDef, frontmatter[fieldName], relativePath, result);
          } else if (fieldDef.type === "list" && fieldDef.items?.type === "link") {
            const value = frontmatter[fieldName];
            if (!Array.isArray(value)) continue;
            for (const item of value) {
              await this.validateSingleLink(fieldName, fieldDef.items, item, relativePath, result);
            }
          }
        }
      }
      if (typeDef.collection?.links) {
        for (const [fieldPath, rule] of Object.entries(typeDef.collection.links)) {
          const selected = getFieldReferenceValues(frontmatter, fieldPath);
          for (const selectedValue of selected) {
            const values = Array.isArray(selectedValue) && fieldPath.startsWith("/")
              ? selectedValue
              : [selectedValue];
            for (const value of values) {
              if (value === null || value === undefined) continue;
              const targetType = Array.isArray(rule.target_type)
                ? rule.target_type.find((entry) => entry !== "any")
                : rule.target_type === "any"
                  ? undefined
                  : rule.target_type;
              await this.validateSingleLink(
                fieldPath,
                {
                  type: "link",
                  validate_exists: rule.validate_exists,
                  target: targetType,
                } as unknown as FieldDefinition,
                value,
                relativePath,
                result,
              );
            }
          }
        }
      }
    }
  }

  private async validateSingleLink(
    fieldName: string,
    fieldDef: FieldDefinition,
    value: unknown,
    fromPath: string,
    result: { valid: boolean; issues: MdbaseError[] },
  ): Promise<void> {
    if (value === null || value === undefined) return;
    if (typeof value !== "string") return; // type_mismatch handled by validator

    // Parse the link
    let parsed: ParsedLink | null;
    try {
      parsed = parseLink(value);
    } catch {
      // invalid_link already caught by validator
      return;
    }

    // Check for path traversal before resolution
    const target = parsed ? parsed.target : value;
    const isRelative = parsed ? parsed.is_relative : false;
    if (isRelative || target.includes("..")) {
      const fromDir = path.dirname(fromPath);
      const resolved = path.posix.normalize(path.posix.join(fromDir, target));
      if (resolved.startsWith("..") || resolved.startsWith("/")) {
        result.issues.push({
          code: "path_traversal",
          field: fieldName,
          message: `Link "${value}" escapes collection root`,
          path: fromPath,
          severity: "error",
        });
        result.valid = false;
        return;
      }
      // For wikilinks, also check if the normalized target itself has deep traversal
      // (2+ leading .. segments after normalization = suspicious path)
      if (parsed && parsed.format === "wikilink") {
        const normalizedTarget = path.posix.normalize(target);
        const segs = normalizedTarget.split("/");
        let dotdotCount = 0;
        for (const seg of segs) {
          if (seg === "..") dotdotCount++;
          else break;
        }
        if (dotdotCount >= 2) {
          result.issues.push({
            code: "path_traversal",
            field: fieldName,
            message: `Link "${value}" escapes collection root`,
            path: fromPath,
            severity: "error",
          });
          result.valid = false;
          return;
        }
      }
    }

    // For validate_exists or target constraints, we need to resolve
    const targetConstraint = (fieldDef as unknown as Record<string, unknown>).target as string | undefined;
    const validateExists = (fieldDef as unknown as Record<string, unknown>).validate_exists as boolean | undefined;

    if (!validateExists && !targetConstraint) return;

    // Resolve the link
    const resolution = await this.resolveLinkFull(value, fromPath, targetConstraint);

    if (resolution.ambiguous) {
      result.issues.push({
        code: "ambiguous_link",
        field: fieldName,
        message: `Ambiguous link "${value}": multiple candidates found`,
        path: fromPath,
        severity: "error",
      });
      result.valid = false;
      return;
    }

    if (resolution.wrongType) {
      result.issues.push({
        code: "link_wrong_type",
        field: fieldName,
        message: `Link "${value}" resolves to wrong type (expected ${targetConstraint})`,
        path: fromPath,
        severity: "error",
      });
      result.valid = false;
      return;
    }

    if (validateExists && !resolution.resolved) {
      result.issues.push({
        code: "link_not_found",
        field: fieldName,
        message: `Link target "${value}" not found`,
        path: fromPath,
        severity: "error",
      });
      result.valid = false;
    }
  }

  /**
   * Resolve a link value to a file, with full support for:
   * - Path-based resolution (relative, absolute, root-relative)
   * - Extension fallback
   * - ID field matching
   * - Filename matching with tiebreakers
   * - Target type constraint
   */
  private async resolveLinkFull(
    linkValue: string,
    fromPath: string,
    targetType?: string,
  ): Promise<{ resolved: string | null; ambiguous?: boolean; wrongType?: boolean }> {
    const files = await this.scanFiles();
    const fileCache = await this.buildFileCache(files);
    const allFiles = await this.scanAllFiles();
    const nonMdSet = this.buildNonMarkdownSet(allFiles);
    const resolutionIndex = this.linkResolver.buildIndex(files, fileCache);
    return this.linkResolver.resolve(
      linkValue,
      fromPath,
      files,
      {
        targetType,
        fileCache,
        nonMarkdownFiles: nonMdSet,
        knownFileSet: resolutionIndex.fileSet,
        resolutionIndex,
      },
    );
  }

  /**
   * Snapshot adapter retained for internal evaluators and the conformance
   * harness. Resolution policy lives in LinkResolver.
   */
  private resolveLinkFullWithFiles(
    linkValue: string,
    fromPath: string,
    files: string[],
    targetType?: string,
    fileCache?: Map<string, ReadResult>,
    nonMarkdownFiles?: Set<string>,
    knownFileSet?: Set<string>,
    resolutionIndex?: LinkResolutionIndex,
  ): { resolved: string | null; ambiguous?: boolean; wrongType?: boolean } {
    return this.linkResolver.resolve(linkValue, fromPath, files, {
      targetType,
      fileCache,
      nonMarkdownFiles,
      knownFileSet,
      resolutionIndex,
    });
  }

  /**
   * Check if a link target exists in the collection.
   * Searches for files matching the target by filename (without extension) or by path.
   */
  private async linkTargetExists(target: string, fromPath: string): Promise<boolean> {
    const resolution = await this.resolveLinkFull(target, fromPath);
    return resolution.resolved !== null;
  }

  private normalizeLinkTarget(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  private mightReferenceRenamedPath(
    rawValue: string,
    oldPath: string,
    oldBase: string,
    oldNoExt: string,
  ): boolean {
    if (!rawValue) return false;
    const normalized = rawValue.replace(/\\/g, "/");
    return normalized.includes(oldBase) ||
      normalized.includes(oldPath) ||
      normalized.includes(oldNoExt);
  }

  private extractLinkTarget(value: string): string {
    const trimmed = value.trim();
    const wikiMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
    return this.normalizeLinkTarget(wikiMatch ? wikiMatch[1] : trimmed);
  }

  private linkTargetMatches(targetPath: string, linkTarget: string): boolean {
    const normalizedTarget = this.normalizeLinkTarget(linkTarget);
    const targetBase = path.basename(targetPath, path.extname(targetPath));
    const targetNoExt = targetPath.replace(/\.(md|markdown)$/, "");
    return (
      normalizedTarget === targetBase ||
      normalizedTarget === targetPath ||
      normalizedTarget === targetNoExt
    );
  }

  private extractLinkTargetsForField(fieldDef: FieldDefinition, value: unknown): string[] {
    if (value === null || value === undefined) return [];
    const targets: string[] = [];

    if (fieldDef.type === "link") {
      if (typeof value === "string") {
        targets.push(this.extractLinkTarget(value));
      }
      return targets;
    }

    if (fieldDef.type === "list" && fieldDef.items?.type === "link") {
      if (!Array.isArray(value)) return targets;
      for (const item of value) {
        if (typeof item === "string") {
          targets.push(this.extractLinkTarget(item));
        }
      }
    }

    return targets;
  }

  private getBacklinkLookupTokens(targetPath: string): string[] {
    const normalizedPath = this.normalizeLinkTarget(targetPath);
    const noExt = normalizedPath.replace(/\.(md|markdown)$/, "");
    const base = path.basename(noExt);
    return [base, normalizedPath, noExt];
  }

  private async getBacklinkTokenIndex(): Promise<BacklinkTokenIndex> {
    const cached = this.runtimeCache.getBacklinkTokens();
    if (cached) return cached;

    const files = await this.scanFiles();
    const fileCache = await this.buildFileCache(files);
    const tokenToSources = new Map<string, Set<string>>();
    const sourceToTokens = new Map<string, Set<string>>();

    for (const sourcePath of files) {
      const readResult = fileCache.get(sourcePath);
      if (!readResult || readResult.error) continue;

      const frontmatter = readResult.frontmatter ?? {};
      const types = readResult.types ?? [];
      const tokens = new Set<string>();

      for (const typeName of types) {
        const typeDef = this.typeDefs.get(typeName);
        if (!typeDef?.fields) continue;
        for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
          const value = frontmatter[fieldName];
          const linkTargets = this.extractLinkTargetsForField(fieldDef, value);
          for (const target of linkTargets) {
            tokens.add(target);
          }
        }
      }

      for (const bodyLink of extractBodyLinks(readResult.body ?? "")) {
        tokens.add(this.extractLinkTarget(bodyLink.raw));
      }

      sourceToTokens.set(sourcePath, tokens);
      for (const token of tokens) {
        let sources = tokenToSources.get(token);
        if (!sources) {
          sources = new Set<string>();
          tokenToSources.set(token, sources);
        }
        sources.add(sourcePath);
      }
    }

    return this.runtimeCache.setBacklinkTokens({
      tokenToSources,
      sourceToTokens,
    });
  }

  private removeSourceFromBacklinkTokenIndex(sourcePath: string): void {
    this.runtimeCache.removeBacklinkSource(sourcePath);
  }

  private async findBacklinks(targetPaths: string[]): Promise<Array<{ target: string; referrer: string }>> {
    if (targetPaths.length === 0) return [];
    const targetSet = new Set(targetPaths);
    const results: Array<{ target: string; referrer: string }> = [];
    const seen = new Set<string>();

    const backlinkIndex = await this.getBacklinkTokenIndex();
    for (const targetPath of targetPaths) {
      for (const token of this.getBacklinkLookupTokens(targetPath)) {
        const sources = backlinkIndex.tokenToSources.get(token);
        if (!sources) continue;
        for (const sourcePath of sources) {
          if (targetSet.has(sourcePath)) continue;
          const key = `${sourcePath}::${targetPath}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ target: targetPath, referrer: sourcePath });
        }
      }
    }

    return results;
  }

  /**
   * Compute backlinks for a specific file.
   * Scans all files in the collection for links (frontmatter, body, embeds) that resolve to targetPath.
   * Returns one entry per source file (deduplicated).
   */
  async computeBacklinksForFile(targetPath: string): Promise<BacklinkEntry[]> {
    return await this.observer.trace(
      "collection.compute_backlinks",
      { path: targetPath },
      () => this.computeBacklinksForFileUnobserved(targetPath),
    );
  }

  private async computeBacklinksForFileUnobserved(targetPath: string): Promise<BacklinkEntry[]> {
    const files = await this.scanFiles();
    const allFiles = await this.scanAllFiles();
    const nonMdSet = this.buildNonMarkdownSet(allFiles);
    const fileCache = await this.buildFileCache(files);
    const resolutionIndex = this.linkResolver.buildIndex(files, fileCache);
    const linkIndex = buildLinkIndex({
      files,
      fileCache,
      typeDefs: this.typeDefs,
      resolveLink: (linkValue: string, fromPath: string) =>
        this.linkResolver.resolve(
          linkValue,
          fromPath,
          files,
          {
            fileCache,
            nonMarkdownFiles: nonMdSet,
            knownFileSet: resolutionIndex.fileSet,
            resolutionIndex,
          },
        ),
    });
    return linkIndex.backlinksFor(targetPath);
  }

  /**
   * Resolve a link target to a file in the collection.
   * Tries: exact path, path + .md, basename match, basename + .md.
   */
  private async resolveLink(
    linkTarget: string,
    fromPath: string,
    _knownFiles: string[],
  ): Promise<{ frontmatter: Record<string, unknown>; path: string; types: string[] } | null> {
    // Use the full link resolution system
    // Wrap as wikilink if not already a link format
    let linkValue = linkTarget;
    if (!linkTarget.startsWith("[[") && !linkTarget.startsWith("[") &&
        !linkTarget.startsWith("./") && !linkTarget.startsWith("../") &&
        !linkTarget.startsWith("/") && !linkTarget.includes("/")) {
      linkValue = `[[${linkTarget}]]`;
    }
    const resolution = await this.resolveLinkFull(linkValue, fromPath);
    if (!resolution.resolved) return null;
    const result = await this.read(resolution.resolved);
    if (result.error) return null;
    return {
      frontmatter: result.frontmatter ?? {},
      path: resolution.resolved,
      types: result.types ?? [],
    };
  }

  private async buildFileCache(files: string[]): Promise<Map<string, ReadResult>> {
    const cached = this.runtimeCache.getFileCache(files);
    if (cached) return cached;

    const fileCache = new Map<string, ReadResult>();
    const workerCount = Math.max(1, Math.min(16, files.length));
    let cursor = 0;
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= files.length) break;
        const filePath = files[index];
        const readResult = await this.read(filePath);
        if (!readResult.error) {
          fileCache.set(filePath, readResult);
        }
      }
    });
    await Promise.all(workers);

    return this.runtimeCache.setFileCache(files, fileCache);
  }

  private async updateCacheForPath(relativePath: string): Promise<void> {
    if (!this.cache) return;
    const fullPath = path.join(this.root, relativePath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      await this.cache.deleteFile(relativePath);
      return;
    }
    const parsed = await parseFileAsync(fullPath);
    if (parsed.error) {
      await this.cache.deleteFile(relativePath);
      return;
    }
    await this.cache.upsertFile(relativePath, stat, parsed.frontmatter, parsed.body ?? "");
  }

  private async upsertCacheFromData(
    relativePath: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    if (!this.cache) return;
    const fullPath = path.join(this.root, relativePath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      await this.cache.deleteFile(relativePath);
      return;
    }
    await this.cache.upsertFile(relativePath, stat, frontmatter, body);
  }

  private async scanTypeFilesForRuntime(): Promise<string[]> {
    return await this.scanner.scanTypeFiles(
      this.config.settings.types_folder,
      this.config.settings.migrations_folder,
    );
  }

  /**
   * Scan all markdown files in the collection.
   */
  private async scanFiles(dir?: string): Promise<string[]> {
    if (dir && path.resolve(dir) !== path.resolve(this.root)) {
      return await this.scanner.scanRecordFiles(dir);
    }
    const cached = this.runtimeCache.getFiles();
    if (cached) return cached;
    return this.runtimeCache.setFiles(await this.scanner.scanRecordFiles());
  }

  private async scanAllFiles(dir?: string): Promise<string[]> {
    if (dir && path.resolve(dir) !== path.resolve(this.root)) {
      return await this.scanner.scanAllFiles(dir);
    }
    const cached = this.runtimeCache.getAllFiles();
    if (cached) return cached;
    return this.runtimeCache.setAllFiles(await this.scanner.scanAllFiles());
  }

  private buildNonMarkdownSet(allFiles: string[]): Set<string> {
    const cached = this.runtimeCache.getNonMarkdownFiles(allFiles);
    if (cached) return cached;

    const nonMd = this.scanner.nonRecordFiles(allFiles);
    return this.runtimeCache.setNonMarkdownFiles(allFiles, nonMd);
  }
}

export class V03ProfileError extends Error {
  constructor(public readonly diagnostic: V03Diagnostic) {
    super(diagnostic.message);
    this.name = "V03ProfileError";
  }
}

/** Canonical `{ valid, result, diagnostics }` operations for v0.3 collections. */
export class V03Operations {
  constructor(private readonly collection: Collection) {}

  async read(input: V03ReadInput): Promise<V03OperationResult> {
    return await this.normalize("read", input, await this.collection.read(input.path));
  }

  async validate(input: V03ValidateInput = {}): Promise<V03OperationResult> {
    return await this.normalize("validate", input, await this.collection.validate(input.path));
  }

  async query(input: CanonicalQueryInput): Promise<V03OperationResult> {
    return canonicalQueryOperationResult(await this.collection.queryCanonical(input));
  }

  async listViews(): Promise<V03OperationResult> {
    const listed = await this.collection.listViews();
    return {
      valid: !listed.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      result: { views: listed.views, meta: listed.meta },
      diagnostics: listed.diagnostics,
    };
  }

  async getDataContracts(input: { contract?: string; version?: string } = {}): Promise<V03OperationResult> {
    const contracts = this.collection.listDataContracts().filter((contract) =>
      (input.contract === undefined || contract.id === input.contract) &&
      (input.version === undefined || contract.version === input.version),
    );
    const implementations = input.contract !== undefined && input.version !== undefined
      ? this.collection.getDataContractImplementations(input.contract, input.version)
      : contracts.flatMap((contract) =>
          this.collection.getDataContractImplementations(contract.id, contract.version),
        );
    return {
      valid: true,
      result: { contracts, implementations },
      diagnostics: [],
    };
  }

  async getContractView(input: {
    path: string;
    contract: string;
    version: string;
    type?: string;
  }): Promise<V03OperationResult> {
    const projected = await this.collection.getContractView(
      input.path,
      input.contract,
      input.version,
      input.type,
    );
    return {
      valid: projected.valid,
      result: {
        contract: projected.contract,
        version: projected.version,
        contract_digest: projected.contract_digest,
        type: projected.type,
        implementation_digest: projected.implementation_digest,
        view: projected.view,
      },
      diagnostics: projected.diagnostics,
    };
  }

  async executeView(input: ExecuteViewInput): Promise<V03OperationResult> {
    return canonicalQueryOperationResult(await this.collection.executeView(input));
  }

  async create(input: V03CreateInput): Promise<V03OperationResult> {
    return await this.normalize("create", input, await this.collection.create(input));
  }

  async update(input: V03UpdateInput): Promise<V03OperationResult> {
    return await this.normalize("update", input, await this.collection.update(input));
  }

  async delete(input: V03DeleteInput): Promise<V03OperationResult> {
    return await this.normalize(
      "delete",
      input,
      await this.collection.delete(input.path, {
        check_backlinks: input.check_backlinks,
        if_revision: input.if_revision,
      }),
    );
  }

  async rename(input: V03RenameInput): Promise<V03OperationResult> {
    return await this.normalize("rename", input, await this.collection.rename(input));
  }

  private async normalize(
    operation: "read" | "validate" | "create" | "update" | "delete" | "rename",
    input: V03ReadInput | V03ValidateInput | V03CreateInput | V03UpdateInput | V03DeleteInput | V03RenameInput,
    rawValue: unknown,
  ): Promise<V03OperationResult> {
    const raw = isObjectRecord(rawValue) ? rawValue : {};
    const fallbackPath = operation === "rename"
      ? (input as V03RenameInput).from
      : "path" in input && typeof input.path === "string"
        ? input.path
        : undefined;
    const diagnostics = collectV03Diagnostics(raw, fallbackPath);
    const result: Record<string, unknown> = { ...raw };
    for (const key of ["valid", "error", "issues", "warnings", "validation", "diagnostics"]) {
      delete result[key];
    }

    delete result.rawFrontmatter;
    if (operation === "read" && fallbackPath && !result.path) {
      result.path = fallbackPath;
    }

    let valid = typeof raw.valid === "boolean" ? raw.valid : raw.error === undefined;
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      valid = false;
    }

    if (valid && operation !== "validate" && operation !== "delete") {
      const persistedPath = operation === "rename"
        ? (input as V03RenameInput).to
        : typeof result.path === "string"
          ? result.path
          : fallbackPath;
      if (persistedPath) {
        const persisted = await this.collection.read(persistedPath);
        if (persisted.error) {
          diagnostics.push(toV03Diagnostic(persisted.error, "error", persistedPath));
          valid = false;
        } else {
          result.path = persistedPath;
          result.frontmatter = persisted.rawFrontmatter ?? {};
          result.effective_frontmatter = persisted.frontmatter ?? persisted.rawFrontmatter ?? {};
          result.types = persisted.types ?? [];
          if (persisted.revision) result.revision = persisted.revision;
        }
      }
    }

    if (operation === "validate" && fallbackPath) {
      result.path = fallbackPath;
    }

    return {
      valid: valid && !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      result,
      diagnostics: deduplicateV03Diagnostics(diagnostics),
    };
  }
}

function canonicalQueryOperationResult(query: CanonicalQueryResult): V03OperationResult {
  const { error, ...result } = query;
  return {
    valid: error === undefined && !query.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    result,
    diagnostics: query.diagnostics,
  };
}

function collectV03Diagnostics(raw: Record<string, unknown>, fallbackPath?: string): V03Diagnostic[] {
  const diagnostics: V03Diagnostic[] = [];
  for (const value of arrayValue(raw.issues)) {
    diagnostics.push(toV03Diagnostic(value, "error", fallbackPath));
  }
  const validation = isObjectRecord(raw.validation) ? raw.validation : undefined;
  for (const value of arrayValue(validation?.issues)) {
    diagnostics.push(toV03Diagnostic(value, "error", fallbackPath));
  }
  const error = isObjectRecord(raw.error) ? raw.error : undefined;
  for (const value of arrayValue(error?.issues)) {
    diagnostics.push(toV03Diagnostic(value, "error", fallbackPath));
  }
  if (error) {
    diagnostics.push(toV03Diagnostic(error, "error", fallbackPath));
  }
  for (const warning of arrayValue(raw.warnings)) {
    diagnostics.push(toV03Diagnostic(warning, "warning", fallbackPath));
  }
  for (const diagnostic of arrayValue(raw.diagnostics)) {
    diagnostics.push(toV03Diagnostic(diagnostic, "error", fallbackPath));
  }
  return deduplicateV03Diagnostics(diagnostics);
}

function toV03Diagnostic(
  value: unknown,
  defaultSeverity: V03Diagnostic["severity"],
  fallbackPath?: string,
): V03Diagnostic {
  const item = isObjectRecord(value) ? value : { message: String(value) };
  const rawPath = typeof item.path === "string" ? item.path : fallbackPath;
  const pathValue = rawPath && isSafeDiagnosticPath(rawPath) ? rawPath : undefined;
  const details = isObjectRecord(item.details) ? { ...item.details } : {};
  for (const key of ["expected", "actual", "line", "column", "end_line", "end_column"]) {
    if (item[key] !== undefined) details[key] = item[key];
  }
  if (rawPath && !pathValue) details.input_path = rawPath;

  let code = typeof item.code === "string" ? item.code : "operation_failed";
  if (code === "invalid_path" && rawPath?.replace(/\\/g, "/").split("/").includes("..")) {
    code = "path_traversal";
  }
  code = code.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "") || "operation_failed";

  const severity = item.severity === "info" || item.severity === "warning" || item.severity === "error"
    ? item.severity
    : defaultSeverity;
  return {
    severity,
    code,
    message: typeof item.message === "string" && item.message ? item.message : "Operation failed.",
    ...(pathValue ? { path: pathValue } : {}),
    ...(typeof item.field === "string" ? { field: item.field } : {}),
    ...(typeof item.type === "string"
      ? { type: item.type }
      : typeof item.type_name === "string"
        ? { type: item.type_name }
        : {}),
    ...(typeof item.schema_location === "string" ? { schema_location: item.schema_location } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function isSafeDiagnosticPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return !path.isAbsolute(value)
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && !value.includes("\\");
}

function deduplicateV03Diagnostics(diagnostics: V03Diagnostic[]): V03Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = canonicalJson(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coerceForRead(value: unknown, fieldDef: FieldDefinition): unknown {
  if (value === null || value === undefined) return value;

  switch (fieldDef.type) {
    case "string":
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;

    case "integer":
      if (typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num) && Number.isInteger(num)) return num;
      }
      if (typeof value === "number" && Number.isFinite(value) && value === Math.floor(value)) {
        return Math.floor(value);
      }
      return value;

    case "number":
      if (typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num)) return num;
      }
      return value;

    case "boolean":
      if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (lower === "true" || lower === "yes" || lower === "on") return true;
        if (lower === "false" || lower === "no" || lower === "off") return false;
      }
      return value;

    case "date":
      if (value instanceof Date) {
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, "0");
        const d = String(value.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }
      return value;

    case "datetime":
      if (value instanceof Date) {
        return formatDateTimeLocal(value);
      }
      return value;

    default:
      if (value instanceof Date) {
        return formatDateTimeLocal(value);
      }
      return value;
  }
}

/**
 * Format a Date object to an ISO 8601 datetime string.
 * js-yaml parses YAML dates like "2024-03-15 10:30:00" as Date objects in UTC.
 * We format without milliseconds and without Z for cleaner output that matches
 * the expected spec format.
 */
function formatDateTimeLocal(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
}

function slugify(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, ""); // Trim leading/trailing hyphens
}

function hasValidationErrors(issues: MdbaseError[]): boolean {
  return issues.some((issue) => issue.severity === "error" || !issue.severity);
}

function cloneJsonLike<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

async function computeRevision(filePath: string): Promise<string> {
  const content = await fs.promises.readFile(filePath);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
