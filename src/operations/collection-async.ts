import { Collection } from "./collection.js";
import type { CollectionOptions } from "../observability.js";
import type {
  BatchDeleteInput,
  BatchResult,
  BatchUpdateInput,
  CacheOpResult,
  CreateInput,
  CreateResult,
  CreateTypeInput,
  DeleteOptions,
  DeleteResult,
  QueryResult,
  ReadResult,
  RenameInput,
  UpdateInput,
  UpdateResult,
  ValidateResult,
} from "./contracts.js";
import type { QueryInput } from "./query-engine.js";

export interface CollectionAsyncCreateInput extends CreateInput {
  /** Legacy alias for frontmatter. */
  fields?: Record<string, unknown>;
}

/** @deprecated Collection already exposes a fully asynchronous API. */
export class CollectionAsync {
  private readonly inner: Collection;

  private constructor(collection: Collection) {
    this.inner = collection;
  }

  static async open(
    collectionRoot: string,
    options: CollectionOptions = {},
  ): Promise<{ collection?: CollectionAsync; error?: { code: string; message: string } }> {
    const result = await Collection.open(collectionRoot, options);
    if (!result.collection) return { error: result.error };
    return { collection: new CollectionAsync(result.collection) };
  }

  read(relativePath: string): Promise<ReadResult> {
    return this.inner.read(relativePath);
  }

  validate(relativePath?: string): Promise<ValidateResult> {
    return this.inner.validate(relativePath);
  }

  create(input: CollectionAsyncCreateInput): Promise<CreateResult> {
    const { fields, ...createInput } = input;
    return this.inner.create({
      ...createInput,
      frontmatter: createInput.frontmatter ?? fields,
    });
  }

  createType(input: CreateTypeInput): Promise<{ valid?: boolean; error?: { code: string; message: string }; type?: Record<string, unknown> }> {
    return this.inner.createType(input);
  }

  update(input: UpdateInput): Promise<UpdateResult> {
    return this.inner.update(input);
  }

  delete(relativePath: string, input?: DeleteOptions): Promise<DeleteResult> {
    return this.inner.delete(relativePath, input);
  }

  rename(input: RenameInput): Promise<Record<string, unknown>> {
    return this.inner.rename(input);
  }

  query(input: QueryInput): Promise<QueryResult> {
    return this.inner.query(input);
  }

  batchDelete(input: BatchDeleteInput): Promise<BatchResult> {
    return this.inner.batchDelete(input);
  }

  batchUpdate(input: BatchUpdateInput): Promise<BatchResult> {
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
