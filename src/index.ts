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
  V03Lifecycle,
  V03LifecycleAction,
  V03LifecycleValue,
  V03LinkRule,
  V03Migration,
  V03SchemaWrapper,
  V03UniqueRule,
} from "./types/loader.js";
export { validateJsonSchemaFrontmatter } from "./validation/json-schema.js";
export { buildMdbaseCelBindings, evaluateMdbaseCel } from "./expressions/cel.js";
export type { MdbaseCelContext, MdbaseCelDiagnostic, MdbaseCelResult } from "./expressions/cel.js";
export {
  executeCanonicalQuery,
  validateCanonicalQueryInput,
  validateCanonicalViewRecord,
} from "./operations/canonical-query.js";
export type {
  CanonicalQueryInput,
  CanonicalQueryResult,
  ExecuteViewInput,
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
export {
  buildRuntimePackage,
  authorizeRuntimeAction,
  composeRuntimeRegistry,
  isRuntimeRecordType,
  materializeRuntimeContractRecord,
  preflightRuntimeWorkflows,
  validateRuntimeActionInput,
  validateRuntimeActionOutput,
  validateRuntimeContractRecord,
  validateRuntimeEventEnvelope,
  validateRuntimeValueAgainstSchema,
} from "./runtime/contracts.js";
export type {
  LoadRuntimeContractsOptions,
  RuntimeActionContract,
  RuntimeCapabilityContract,
  RuntimeContractRecord,
  RuntimeDiagnostic,
  RuntimeEventContract,
  RuntimeExpressionObject,
  RuntimeMarkdownRecord,
  RuntimePackage,
  RuntimePolicyContract,
  RuntimeProviderContract,
  RuntimeProviderRequirement,
  RuntimeRecordType,
  RuntimeRegistry,
  RuntimeRequires,
  RuntimeSeverity,
  RuntimeValidationResult,
  RuntimeWorkflowContract,
  RuntimeWorkflowStep,
  RuntimeWorkflowTrigger,
} from "./runtime/contracts.js";
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
