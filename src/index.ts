/**
 * mdbase - TypeScript implementation of the mdbase specification.
 *
 * Uses SQLite as a backing store for queries, compiling mdbase expressions
 * to SQL WHERE clauses via json_extract().
 */

export { MdbaseOperationError } from "./errors.js";
export type { MdbaseError, ValidationResult, ErrorSeverity } from "./errors.js";
