import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export type LogAttribute = string | number | boolean;

export interface PerformanceLoggingOptions {
  /** Only emit operations at or above this duration. Defaults to zero. */
  threshold_ms?: number;
  /** Emit child operations such as reads performed by a query. Defaults to false. */
  include_nested?: boolean;
}

export interface ErrorLoggingOptions {
  /** Include Error stack traces. Disabled by default to avoid leaking local paths. */
  include_stack?: boolean;
}

export interface ObservabilityOptions {
  performance?: boolean | PerformanceLoggingOptions;
  errors?: boolean | ErrorLoggingOptions;
  /** Receives structured events. The default logger writes one JSON object per line to stderr. */
  logger?: (event: MdbaseLogEvent) => void;
}

export interface CollectionOptions {
  observability?: ObservabilityOptions;
  /** Internal: recovery has already been completed by a staged transaction. */
  skipTypePackRecovery?: boolean;
}

interface LogEventBase {
  timestamp: string;
  operation: string;
  attributes?: Record<string, LogAttribute>;
}

export interface PerformanceLogEvent extends LogEventBase {
  kind: "performance";
  duration_ms: number;
  outcome: "success" | "error";
}

export interface ErrorLogEvent extends LogEventBase {
  kind: "error";
  error: {
    code?: string;
    name?: string;
    message: string;
    stack?: string;
  };
}

export type MdbaseLogEvent = PerformanceLogEvent | ErrorLogEvent;

interface OperationFailure {
  code?: string;
  name?: string;
  message: string;
  stack?: string;
}

interface ObserverRuntime {
  now?: () => number;
  timestamp?: () => string;
}

export class OperationObserver {
  private readonly operationDepth = new AsyncLocalStorage<number>();
  private readonly performanceEnabled: boolean;
  private readonly errorEnabled: boolean;
  private readonly performanceThreshold: number;
  private readonly includeNested: boolean;
  private readonly includeStack: boolean;
  private readonly logger: (event: MdbaseLogEvent) => void;
  private readonly now: () => number;
  private readonly timestamp: () => string;

  constructor(options: ObservabilityOptions = {}, runtime: ObserverRuntime = {}) {
    this.performanceEnabled = options.performance !== undefined && options.performance !== false;
    this.errorEnabled = options.errors !== undefined && options.errors !== false;
    this.performanceThreshold = typeof options.performance === "object"
      ? Math.max(0, options.performance.threshold_ms ?? 0)
      : 0;
    this.includeNested = typeof options.performance === "object"
      ? options.performance.include_nested === true
      : false;
    this.includeStack = typeof options.errors === "object"
      ? options.errors.include_stack === true
      : false;
    this.logger = options.logger ?? defaultLogger;
    this.now = runtime.now ?? (() => performance.now());
    this.timestamp = runtime.timestamp ?? (() => new Date().toISOString());
  }

  get enabled(): boolean {
    return this.performanceEnabled || this.errorEnabled;
  }

  async trace<T>(
    operation: string,
    attributes: Record<string, LogAttribute | undefined>,
    task: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return await task();

    const depth = this.operationDepth.getStore() ?? 0;
    const shouldEmit = depth === 0 || this.includeNested;
    if (!shouldEmit) return await task();

    return await this.operationDepth.run(depth + 1, async () => {
      const startedAt = this.now();
      let failure: OperationFailure | undefined;
      try {
        const result = await task();
        failure = getReturnedFailure(result);
        if (failure && this.errorEnabled) {
          this.emitError(operation, attributes, failure);
        }
        return result;
      } catch (error) {
        failure = normalizeFailure(error, this.includeStack);
        if (this.errorEnabled) {
          this.emitError(operation, attributes, failure);
        }
        throw error;
      } finally {
        const duration = this.now() - startedAt;
        if (this.performanceEnabled && duration >= this.performanceThreshold) {
          this.emit({
            kind: "performance",
            timestamp: this.timestamp(),
            operation,
            duration_ms: duration,
            outcome: failure ? "error" : "success",
            ...withAttributes(attributes),
          });
        }
      }
    });
  }

  private emitError(
    operation: string,
    attributes: Record<string, LogAttribute | undefined>,
    failure: OperationFailure,
  ): void {
    this.emit({
      kind: "error",
      timestamp: this.timestamp(),
      operation,
      error: failure,
      ...withAttributes(attributes),
    });
  }

  private emit(event: MdbaseLogEvent): void {
    try {
      this.logger(event);
    } catch {
      // Diagnostics must never change collection behavior.
    }
  }
}

function getReturnedFailure(value: unknown): OperationFailure | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.error)) return normalizeFailure(value.error, false);
  if (value.valid === false) {
    for (const collection of [value.diagnostics, value.issues]) {
      if (!Array.isArray(collection)) continue;
      const failure = collection.find(
        (item): item is Record<string, unknown> =>
          isRecord(item) && (item.severity === "error" || item.severity === undefined),
      );
      if (failure) return normalizeFailure(failure, false);
    }
    return { code: "operation_invalid", message: "Operation returned valid: false" };
  }
  if (isRecord(value.batch_result) && typeof value.batch_result.failed === "number" && value.batch_result.failed > 0) {
    const details = value.batch_result.details;
    if (Array.isArray(details)) {
      const failedDetail = details.find((detail) => isRecord(detail) && detail.status === "failed");
      if (isRecord(failedDetail) && isRecord(failedDetail.error)) {
        return normalizeFailure(failedDetail.error, false);
      }
    }
    return {
      code: "batch_partial_failure",
      message: `Batch operation failed for ${value.batch_result.failed} item(s)`,
    };
  }
  return undefined;
}

function normalizeFailure(value: unknown, includeStack: boolean): OperationFailure {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(includeStack && value.stack ? { stack: value.stack } : {}),
    };
  }
  if (isRecord(value)) {
    return {
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      message: typeof value.message === "string" ? value.message : String(value),
    };
  }
  return { message: String(value) };
}

function withAttributes(
  attributes: Record<string, LogAttribute | undefined>,
): { attributes?: Record<string, LogAttribute> } {
  const entries = Object.entries(attributes).filter(
    (entry): entry is [string, LogAttribute] => entry[1] !== undefined,
  );
  return entries.length > 0 ? { attributes: Object.fromEntries(entries) } : {};
}

function defaultLogger(event: MdbaseLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
