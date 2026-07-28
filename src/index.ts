/**
 * mdbase - TypeScript implementation of the mdbase specification.
 *
 * Uses SQLite as a backing store for queries, compiling mdbase expressions
 * to SQL WHERE clauses via json_extract().
 */

export { MdbaseOperationError } from "./errors.js";
export type { MdbaseError, ValidationResult, ErrorSeverity } from "./errors.js";
export { OperationObserver } from "./observability.js";
export type {
  CollectionOptions,
  ErrorLogEvent,
  ErrorLoggingOptions,
  MdbaseLogEvent,
  ObservabilityOptions,
  PerformanceLogEvent,
  PerformanceLoggingOptions,
} from "./observability.js";
export {
  isSupportedV03SpecVersion,
  LEGACY_SPEC_VERSION,
  loadConfig,
  loadConfigAsync,
  PRERELEASE_SPEC_VERSIONS,
  SUPPORTED_SPEC_VERSION,
} from "./config/loader.js";
export type { MdbaseConfig, MdbaseSettings, ConfigLoadResult } from "./config/loader.js";
export { loadTypes, loadTypesAsync, getType, getTypeAsync } from "./types/loader.js";
export type {
  FieldDefinition,
  GetTypeResult,
  TypeDefinition,
  TypeLoadResult,
  V03CollectionSemantics,
  V03DataContractImplementation,
  V03Lifecycle,
  V03LifecycleAction,
  V03LifecycleValue,
  V03LinkRule,
  V03Migration,
  V03SchemaWrapper,
  V03UniqueRule,
} from "./types/loader.js";
export { DataContractRegistry, dataContractDigest } from "./data-contracts/registry.js";
export type {
  ContractViewResult,
  DataContractDefinition,
  DataContractDiagnostic,
  DataContractImplementationDescriptor,
  DataContractLoadResult,
} from "./data-contracts/registry.js";
export { validateJsonSchemaFrontmatter } from "./validation/json-schema.js";
export {
  getCanonicalSchemas,
  validateCanonicalSchema,
} from "./validation/canonical.js";
export type {
  CanonicalSchemaName,
  CanonicalSchemaValidationResult,
} from "./validation/canonical.js";
export {
  buildMdbaseCelBindings,
  collectMdbaseCelProjectionReferences,
  evaluateMdbaseCel,
  validateMdbaseCelSyntax,
} from "./expressions/cel.js";
export type { MdbaseCelContext, MdbaseCelDiagnostic, MdbaseCelResult } from "./expressions/cel.js";
export {
  executeCanonicalQuery,
  listCanonicalViews,
  validateCanonicalQueryInput,
  validateCanonicalViewRecord,
} from "./operations/canonical-query.js";
export type {
  CanonicalQueryInput,
  CanonicalQueryResult,
  ExecuteViewInput,
  SavedNamedViewDescriptor,
  SavedViewDescriptor,
  SavedViewListResult,
  SavedViewPropertyDescriptor,
  SavedViewSourceDescriptor,
} from "./operations/canonical-query.js";
export { migrateV02TypeFileToV03, migrateV02TypeToV03, renderV03TypeFile } from "./migrations/type-migration.js";
export type {
  TypeMigrationMapping,
  TypeMigrationOptions,
  TypeMigrationReport,
  TypeMigrationResult,
  TypeMigrationWarning,
} from "./migrations/type-migration.js";
export {
  analyzeV02CollectionMigration,
  applyV02CollectionMigration,
  recoverV02CollectionMigration,
} from "./migrations/collection-migration.js";
export type {
  CollectionMigrationAnalysis,
  CollectionMigrationApplyResult,
  CollectionMigrationDiagnostic,
  CollectionMigrationOperation,
  CollectionMigrationRecoveryResult,
  CollectionMigrationReport,
} from "./migrations/collection-migration.js";
export { Collection, V03Operations, V03ProfileError } from "./operations/collection.js";
export type {
  TypeMigrationEntry,
  V03CreateInput,
  V03DeleteInput,
  V03Diagnostic,
  V03OperationResult,
  V03ReadInput,
  V03RenameInput,
  V03UpdateInput,
  V03ValidateInput,
} from "./operations/collection.js";
export { CollectionAsync } from "./operations/collection-async.js";
export type { CollectionAsyncCreateInput } from "./operations/collection-async.js";
export { installTypePack } from "./type-packs/installer.js";
export type {
  InstallTypePackOptions,
  TypePackInstallResult,
  TypePackManifest,
  TypePackManifestResource,
  TypePackResourceDiff,
  TypePackSourceResource,
} from "./type-packs/installer.js";
export type {
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
  OperationError,
  OperationWarning,
  QueryGroupResult,
  QueryResult,
  QueryResultRow,
  ReadResult,
  RenameInput,
  UpdateInput,
  UpdateResult,
  ValidateResult,
  WriteResult,
} from "./operations/contracts.js";
