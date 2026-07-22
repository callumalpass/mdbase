import type { MdbaseError } from "../errors.js";
import type { V03Migration } from "../types/loader.js";

export interface OperationError {
  code: string;
  message: string;
}

export interface OperationWarning extends OperationError {}

export interface ReadResult {
  valid?: boolean;
  frontmatter?: Record<string, unknown>;
  rawFrontmatter?: Record<string, unknown>;
  body?: string | null;
  types?: string[];
  file?: Record<string, unknown>;
  revision?: string;
  warnings?: OperationWarning[];
  error?: OperationError;
}

export interface ValidateResult {
  valid: boolean;
  issues: MdbaseError[];
  warnings?: string[];
  error?: OperationError;
}

export interface WriteResult {
  valid?: boolean;
  frontmatter?: Record<string, unknown>;
  body?: string;
  path?: string;
  revision?: string;
  types?: string[];
  warnings?: string[];
  issues?: MdbaseError[];
  error?: OperationError;
}

export interface CreateResult extends WriteResult {}

export interface UpdateResult extends WriteResult {}

export interface DeleteResult {
  valid?: boolean;
  broken_links?: Array<{ path: string }>;
  error?: OperationError;
}

export interface QueryResultRow {
  path: string;
  file: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
  types: string[];
  body?: string | null;
}

export interface QueryGroupResult {
  key: unknown;
  results: QueryResultRow[];
  summaries?: Record<string, unknown>;
}

export interface QueryResult {
  results?: QueryResultRow[];
  groups?: QueryGroupResult[];
  summaries?: Record<string, unknown>;
  meta?: {
    total_count: number;
    has_more?: boolean;
  };
  diagnostics?: Array<Record<string, unknown>>;
}

export interface BatchResultDetail {
  path: string;
  status: "success" | "failed" | "skipped";
  error?: OperationError;
}

export interface BatchResult {
  batch_result: {
    total: number;
    succeeded: number;
    failed: number;
    skipped?: number;
    details: BatchResultDetail[];
  };
  broken_links?: Array<{ target: string; referrer: string }>;
  error?: OperationError;
}

export interface CacheOpResult {
  success: boolean;
  error?: OperationError;
}

export interface CreateInput {
  type?: string;
  types?: string[];
  path?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
}

export interface UpdateInput {
  path: string;
  fields?: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
  body?: string;
  if_revision?: string;
}

export interface DeleteOptions {
  check_backlinks?: boolean;
  if_revision?: string;
}

export interface CreateTypeInput {
  name: string;
  description?: string;
  extends?: string;
  parent?: string;
  strict?: boolean | "warn";
  fields?: Record<string, unknown>;
  path_pattern?: string;
  filename_pattern?: string;
}

export interface RenameInput {
  from: string;
  to: string;
  update_refs?: boolean;
  if_revision?: string;
}

export interface BatchDeleteInput {
  where: string;
  dry_run?: boolean;
  check_backlinks?: boolean;
}

export interface BatchUpdateInput {
  where?: string;
  fields?: Record<string, unknown>;
  updates?: Array<{ path: string; fields: Record<string, unknown> }>;
  dry_run?: boolean;
}

export interface BackfillInput {
  type?: string;
  where?: string | Record<string, unknown>;
  fields?: string[];
  apply?: { defaults?: boolean; generated?: boolean };
  dry_run?: boolean;
}

export interface TypeMigrationEntry {
  type: string;
  source_path?: string;
  migration: V03Migration;
}

export interface V03Diagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  path?: string;
  field?: string;
  type?: string;
  schema_location?: string;
  details?: unknown;
}

export interface V03OperationResult<T = Record<string, unknown>> {
  valid: boolean;
  result: T;
  diagnostics: V03Diagnostic[];
}

export interface V03ReadInput {
  path: string;
}

export interface V03ValidateInput {
  path?: string;
}

export interface V03CreateInput {
  type?: string;
  types?: string[];
  path?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
}

export interface V03UpdateInput {
  path: string;
  fields?: Record<string, unknown>;
  body?: string;
  if_revision?: string;
}

export interface V03DeleteInput {
  path: string;
  check_backlinks?: boolean;
  if_revision?: string;
}

export interface V03RenameInput {
  from: string;
  to: string;
  update_refs?: boolean;
  if_revision?: string;
}
