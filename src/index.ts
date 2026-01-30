/**
 * mdbase - TypeScript implementation of the mdbase specification.
 *
 * Uses SQLite as a backing store for queries, compiling mdbase expressions
 * to SQL WHERE clauses via json_extract().
 */

export { MdbaseOperationError } from "./errors.js";
export type { MdbaseError, ValidationResult, ErrorSeverity } from "./errors.js";
export { loadConfig } from "./config/loader.js";
export type { MdbaseConfig, MdbaseSettings, ConfigLoadResult } from "./config/loader.js";
export { loadTypes, getType } from "./types/loader.js";
export type { TypeDefinition, FieldDefinition, TypeLoadResult, GetTypeResult } from "./types/loader.js";
export { Collection } from "./operations/collection.js";
