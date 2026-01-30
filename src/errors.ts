/**
 * Error codes from Appendix C of the mdbase specification.
 */

// C.1 Validation Error Codes

// Field Errors
export const MISSING_REQUIRED = "missing_required";
export const TYPE_MISMATCH = "type_mismatch";
export const CONSTRAINT_VIOLATION = "constraint_violation";
export const INVALID_ENUM = "invalid_enum";
export const UNKNOWN_FIELD = "unknown_field";
export const DEPRECATED_FIELD = "deprecated_field";
export const DUPLICATE_ID = "duplicate_id";
export const DUPLICATE_VALUE = "duplicate_value";

// List Errors
export const LIST_TOO_SHORT = "list_too_short";
export const LIST_TOO_LONG = "list_too_long";
export const LIST_DUPLICATE = "list_duplicate";
export const LIST_ITEM_INVALID = "list_item_invalid";

// String Errors
export const STRING_TOO_SHORT = "string_too_short";
export const STRING_TOO_LONG = "string_too_long";
export const PATTERN_MISMATCH = "pattern_mismatch";

// Number Errors
export const NUMBER_TOO_SMALL = "number_too_small";
export const NUMBER_TOO_LARGE = "number_too_large";
export const NOT_INTEGER = "not_integer";

// Link Errors
export const INVALID_LINK = "invalid_link";
export const LINK_NOT_FOUND = "link_not_found";
export const LINK_WRONG_TYPE = "link_wrong_type";
export const AMBIGUOUS_LINK = "ambiguous_link";

// Date/Time Errors
export const INVALID_DATE = "invalid_date";
export const INVALID_DATETIME = "invalid_datetime";
export const INVALID_TIME = "invalid_time";

// C.2 Type System Errors
export const UNKNOWN_TYPE = "unknown_type";
export const CIRCULAR_INHERITANCE = "circular_inheritance";
export const MISSING_PARENT_TYPE = "missing_parent_type";
export const TYPE_CONFLICT = "type_conflict";
export const INVALID_TYPE_DEFINITION = "invalid_type_definition";
export const CIRCULAR_COMPUTED = "circular_computed";

// C.3 Operation Errors - File Operations
export const FILE_NOT_FOUND = "file_not_found";
export const PATH_CONFLICT = "path_conflict";
export const PATH_REQUIRED = "path_required";
export const INVALID_PATH = "invalid_path";
export const INVALID_FRONTMATTER = "invalid_frontmatter";
export const VALIDATION_FAILED = "validation_failed";
export const PERMISSION_DENIED = "permission_denied";
export const CONCURRENT_MODIFICATION = "concurrent_modification";
export const PATH_TRAVERSAL = "path_traversal";

// Rename Operations
export const RENAME_REF_UPDATE_FAILED = "rename_ref_update_failed";

// Configuration Errors
export const INVALID_CONFIG = "invalid_config";
export const MISSING_CONFIG = "missing_config";
export const UNSUPPORTED_VERSION = "unsupported_version";

// C.4 Expression Errors
export const INVALID_EXPRESSION = "invalid_expression";
export const UNKNOWN_FUNCTION = "unknown_function";
export const WRONG_ARGUMENT_COUNT = "wrong_argument_count";
export const TYPE_ERROR = "type_error";
export const EXPRESSION_DEPTH_EXCEEDED = "expression_depth_exceeded";

// C.5 Formula Errors
export const CIRCULAR_FORMULA = "circular_formula";
export const INVALID_FORMULA = "invalid_formula";
export const FORMULA_EVALUATION_ERROR = "formula_evaluation_error";

// Error severity levels (C.7)
export type ErrorSeverity = "error" | "warning" | "info";

// Structured error types
export interface MdbaseError {
  code: string;
  message: string;
  path?: string;
  field?: string;
  severity?: ErrorSeverity;
  expected?: unknown;
  actual?: unknown;
  type?: string;
  line?: number;
  column?: number;
  end_line?: number;
  end_column?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: MdbaseError[];
  warnings: number;
  errorCount: number;
}

export interface ErrorResponse {
  error: MdbaseError;
}

export class MdbaseOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MdbaseOperationError";
  }
}
