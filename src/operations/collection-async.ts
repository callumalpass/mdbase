import { Collection } from "./collection.js";
import type {
  ReadResult,
  ValidateResult,
  CreateResult,
  UpdateResult,
  DeleteResult,
  QueryResult,
  BatchResult,
  CacheOpResult,
} from "./collection.js";

export class CollectionAsync {
  private inner: Collection;

  private constructor(collection: Collection) {
    this.inner = collection;
  }

  static async open(collectionRoot: string): Promise<{ collection?: CollectionAsync; error?: { code: string; message: string } }> {
    const result = await Collection.open(collectionRoot);
    if (!result.collection) return { error: result.error };
    return { collection: new CollectionAsync(result.collection) };
  }

  read(relativePath: string): Promise<ReadResult> {
    return this.inner.read(relativePath);
  }

  validate(relativePath?: string): Promise<ValidateResult> {
    return this.inner.validate(relativePath);
  }

  create(input: {
    path: string;
    frontmatter?: Record<string, unknown>;
    fields?: Record<string, unknown>;
    body?: string;
    types?: string[];
  }): Promise<CreateResult> {
    return this.inner.create(input);
  }

  createType(input: {
    name: string;
    description?: string;
    extends?: string;
    parent?: string;
    strict?: boolean | "warn";
    fields?: Record<string, unknown>;
    path_pattern?: string;
    filename_pattern?: string;
  }): Promise<{ valid?: boolean; error?: { code: string; message: string }; type?: Record<string, unknown> }> {
    return this.inner.createType(input);
  }

  update(input: {
    path: string;
    fields?: Record<string, unknown>;
    frontmatter?: Record<string, unknown>;
    body?: string;
  }): Promise<UpdateResult> {
    return this.inner.update(input);
  }

  delete(relativePath: string, input?: { check_backlinks?: boolean }): Promise<DeleteResult> {
    return this.inner.delete(relativePath, input);
  }

  rename(input: { from: string; to: string; update_refs?: boolean }): Promise<Record<string, unknown>> {
    return this.inner.rename(input);
  }

  query(input: {
    types?: string[];
    where?: string | Record<string, unknown>;
    order_by?: Array<{ field: string; direction?: "asc" | "desc" }>;
    folder?: string;
    limit?: number;
    offset?: number;
    include_body?: boolean;
    context_file?: string;
    formulas?: Record<string, string>;
    group_by?: { property: string; direction?: "asc" | "desc" | "ASC" | "DESC" };
    property_summaries?: Record<string, string>;
    summaries?: Record<string, string>;
  }): Promise<QueryResult> {
    return this.inner.query(input);
  }

  batchDelete(input: { where: string; dry_run?: boolean; check_backlinks?: boolean }): Promise<BatchResult> {
    return this.inner.batchDelete(input);
  }

  batchUpdate(input: {
    where?: string;
    fields?: Record<string, unknown>;
    updates?: Array<{ path: string; fields: Record<string, unknown> }>;
    dry_run?: boolean;
  }): Promise<BatchResult> {
    return this.inner.batchUpdate(input);
  }

  cacheRebuild(): Promise<CacheOpResult> {
    return this.inner.cacheRebuild();
  }

  cacheClear(): Promise<CacheOpResult> {
    return this.inner.cacheClear();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
