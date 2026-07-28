import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { Collection } from "../operations/collection.js";
import type { V03Diagnostic, V03OperationResult } from "../operations/contracts.js";
import { typePackSchema } from "../generated/v03-schemas.js";
import {
  atomicWrite,
  recoverInterruptedTypePackTransactions,
  resolveInside,
  restoreTypePackTransaction,
  TYPE_PACK_TRANSACTIONS_FOLDER,
  type TypePackTransactionJournal,
} from "./recovery.js";

export interface TypePackManifestResource {
  kind: "contract" | "type" | "schema";
  source: string;
  target: string;
  digest: string;
}

export interface TypePackManifest {
  kind: "mdbase.type-pack";
  id: string;
  version: string;
  name?: string;
  description?: string;
  resources: TypePackManifestResource[];
  [extension: `x-${string}`]: unknown;
}

export interface TypePackSourceResource {
  source: string;
  document: string;
}

export interface InstallTypePackOptions {
  /** Permit exact targets with different bytes to be replaced. */
  replace?: boolean;
  /** Validate and return the exact diff without changing the collection. */
  dryRun?: boolean;
}

export interface TypePackResourceDiff {
  target: string;
  action: "create" | "replace" | "unchanged";
  digest: string;
}

export interface TypePackInstallResult {
  id: string;
  version: string;
  resources: TypePackResourceDiff[];
  cleanup_deferred: boolean;
}

interface PlannedResource extends TypePackResourceDiff {
  bytes: Buffer;
  before?: Buffer;
}

/** Validate and transactionally install one complete mdbase type pack. */
export async function installTypePack(
  collectionRoot: string,
  manifestValue: unknown,
  sourceResources: TypePackSourceResource[],
  options: InstallTypePackOptions = {},
): Promise<V03OperationResult<TypePackInstallResult>> {
  const root = path.resolve(collectionRoot);
  try {
    await recoverInterruptedTypePackTransactions(root);
  } catch (error) {
    return failure("type_pack_apply_failed", `Could not recover an earlier type-pack transaction: ${message(error)}`);
  }

  const manifestValidation = validateManifest(manifestValue);
  if (!manifestValidation.valid) {
    return failure(
      "invalid_type_pack",
      `Type-pack manifest is invalid: ${manifestValidation.errors.join("; ")}`,
    );
  }
  const manifest = manifestValue as TypePackManifest;
  let planned: PlannedResource[];
  try {
    planned = await planResources(root, manifest, sourceResources, options.replace === true);
  } catch (error) {
    if (error instanceof TypePackError) return failure(error.code, error.message);
    return failure("invalid_type_pack", message(error));
  }

  const staged = await validateStagedCollection(root, planned);
  if (!staged.valid) {
    return {
      valid: false,
      result: {} as TypePackInstallResult,
      diagnostics: staged.diagnostics,
    };
  }

  const result: TypePackInstallResult = {
    id: manifest.id,
    version: manifest.version,
    resources: planned.map(({ target, action, digest }) => ({ target, action, digest })),
    cleanup_deferred: false,
  };
  if (options.dryRun || planned.every(({ action }) => action === "unchanged")) {
    return { valid: true, result, diagnostics: [] };
  }

  const transactionId = randomUUID();
  const transactionRoot = resolveInside(root, `${TYPE_PACK_TRANSACTIONS_FOLDER}/${transactionId}`);
  const journalPath = resolveInside(transactionRoot, "journal.json");
  const journal: TypePackTransactionJournal = {
    version: 1,
    transaction_id: transactionId,
    status: "prepared",
    entries: planned
      .filter(({ action }) => action !== "unchanged")
      .map(({ target, before }) => ({
        target,
        existed: before !== undefined,
        ...(before ? { before_digest: digest(before), backup_path: `backups/${target}` } : {}),
      })),
  };

  let committed = false;
  try {
    await fs.mkdir(path.dirname(transactionRoot), { recursive: true });
    await fs.mkdir(transactionRoot, { recursive: false });
    for (const entry of journal.entries) {
      if (!entry.backup_path) continue;
      const resource = planned.find(({ target }) => target === entry.target);
      if (!resource?.before) throw new Error(`Missing pre-install bytes for ${entry.target}.`);
      await atomicWrite(resolveInside(transactionRoot, entry.backup_path), resource.before);
    }
    await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    // Recheck the complete baseline before the first live write.
    for (const resource of planned) {
      const current = await readOptional(resolveInside(root, resource.target));
      if (!sameBytes(current, resource.before)) {
        throw new TypePackError(
          "type_pack_conflict",
          `Type-pack target ${resource.target} changed after preflight.`,
        );
      }
    }
    journal.status = "applying";
    await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    for (const resource of planned) {
      if (resource.action === "unchanged") continue;
      await atomicWrite(resolveInside(root, resource.target), resource.bytes);
    }

    const reopened = await Collection.open(root, { skipTypePackRecovery: true });
    if (!reopened.collection) {
      throw new TypePackError(
        "type_pack_apply_failed",
        reopened.error?.message ?? "The committed collection could not be reopened.",
      );
    }
    try {
      const validated = await reopened.collection.validate();
      const errors = validated.issues.filter(
        (issue) =>
          issue.severity !== "warning" &&
          !staged.baselineErrors.has(issueKey(issue)),
      );
      if (errors.length > 0) {
        throw new TypePackError(
          "type_pack_apply_failed",
          `The committed collection introduced invalid records: ${errors[0]?.message ?? "validation failed"}`,
        );
      }
    } finally {
      await reopened.collection.close();
    }
    journal.status = "committed";
    await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    committed = true;
  } catch (error) {
    try {
      await restoreTypePackTransaction(root, transactionRoot, journal);
      journal.status = "rolled_back";
      await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    } catch (recoveryError) {
      return failure(
        "type_pack_apply_failed",
        `${message(error)} Automatic rollback also failed: ${message(recoveryError)}`,
      );
    }
    const code = error instanceof TypePackError ? error.code : "type_pack_apply_failed";
    return failure(code, message(error));
  } finally {
    if (committed || journal.status === "rolled_back") {
      try {
        await fs.rm(transactionRoot, { recursive: true, force: true });
      } catch {
        result.cleanup_deferred = true;
      }
    }
  }
  return { valid: true, result, diagnostics: [] };
}

async function planResources(
  root: string,
  manifest: TypePackManifest,
  sourceResources: TypePackSourceResource[],
  replace: boolean,
): Promise<PlannedResource[]> {
  const sources = new Map<string, Buffer>();
  for (const resource of sourceResources) {
    resolveInside(root, resource.source);
    if (sources.has(resource.source)) {
      throw new TypePackError("invalid_type_pack", `Duplicate source resource: ${resource.source}.`);
    }
    sources.set(resource.source, Buffer.from(resource.document, "utf8"));
  }
  const targets = new Set<string>();
  const planned: PlannedResource[] = [];
  for (const definition of manifest.resources) {
    resolveInside(root, definition.source);
    const target = resolveInside(root, definition.target);
    if (!targets.add(definition.target)) {
      throw new TypePackError("invalid_type_pack", `Duplicate target resource: ${definition.target}.`);
    }
    const bytes = sources.get(definition.source);
    if (!bytes) {
      throw new TypePackError("invalid_type_pack", `Missing source resource: ${definition.source}.`);
    }
    if (digest(bytes) !== definition.digest) {
      throw new TypePackError(
        "invalid_type_pack",
        `Digest mismatch for source resource ${definition.source}.`,
      );
    }
    const before = await readOptional(target);
    const action = before === undefined
      ? "create"
      : sameBytes(before, bytes)
        ? "unchanged"
        : "replace";
    if (action === "replace" && !replace) {
      throw new TypePackError(
        "type_pack_conflict",
        `Type-pack target ${definition.target} already exists with different bytes.`,
      );
    }
    planned.push({
      target: definition.target,
      action,
      digest: definition.digest,
      bytes,
      ...(before ? { before } : {}),
    });
  }
  if (sources.size !== manifest.resources.length) {
    throw new TypePackError("invalid_type_pack", "The type pack contains undeclared source resources.");
  }
  return planned;
}

async function validateStagedCollection(
  root: string,
  resources: PlannedResource[],
): Promise<{
  valid: boolean;
  diagnostics: V03Diagnostic[];
  baselineErrors: Set<string>;
}> {
  const baseline = await collectionErrors(root);
  if (!baseline.valid) {
    return {
      valid: false,
      diagnostics: baseline.diagnostics,
      baselineErrors: new Set(),
    };
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-type-pack-"));
  try {
    await fs.cp(root, stage, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(root, source);
        if (!relative) return true;
        const first = relative.split(path.sep)[0];
        return first !== ".git" && first !== "node_modules" && first !== ".mdbase";
      },
    });
    for (const resource of resources) {
      await atomicWrite(resolveInside(stage, resource.target), resource.bytes);
    }
    const opened = await Collection.open(stage, { skipTypePackRecovery: true });
    if (!opened.collection) {
      return {
        valid: false,
        diagnostics: [diagnostic(
          opened.error?.code === "data_contract_not_found" ? "data_contract_not_found" : "invalid_type_pack",
          opened.error?.message ?? "The staged type pack could not be loaded.",
        )],
        baselineErrors: baseline.errors,
      };
    }
    try {
      const validation = await opened.collection.validate();
      const errors = validation.issues.filter((issue) => issue.severity !== "warning");
      const introduced = errors.filter((issue) => !baseline.errors.has(issueKey(issue)));
      return introduced.length === 0
        ? { valid: true, diagnostics: [], baselineErrors: baseline.errors }
        : {
            valid: false,
            diagnostics: introduced.map((issue) =>
              diagnostic("invalid_type_pack", issue.message, issue.path, issue.field)
            ),
            baselineErrors: baseline.errors,
          };
    } finally {
      await opened.collection.close();
    }
  } catch (error) {
    return {
      valid: false,
      diagnostics: [diagnostic("invalid_type_pack", message(error))],
      baselineErrors: baseline.errors,
    };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

async function collectionErrors(root: string): Promise<{
  valid: boolean;
  errors: Set<string>;
  diagnostics: V03Diagnostic[];
}> {
  const opened = await Collection.open(root, { skipTypePackRecovery: true });
  if (!opened.collection) {
    return {
      valid: false,
      errors: new Set(),
      diagnostics: [diagnostic(
        "invalid_type_pack",
        opened.error?.message ?? "The live collection could not be opened.",
      )],
    };
  }
  try {
    const validation = await opened.collection.validate();
    return {
      valid: true,
      errors: new Set(
        validation.issues
          .filter((issue) => issue.severity !== "warning")
          .map(issueKey),
      ),
      diagnostics: [],
    };
  } finally {
    await opened.collection.close();
  }
}

function issueKey(issue: {
  code: string;
  message: string;
  path?: string;
  field?: string;
  severity?: unknown;
}): string {
  return JSON.stringify([
    issue.code,
    issue.path ?? null,
    issue.field ?? null,
    issue.message,
  ]);
}

function validateManifest(value: unknown): { valid: boolean; errors: string[] } {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => void;
  addFormats(ajv);
  const validate = ajv.compile(typePackSchema);
  const valid = validate(value);
  return {
    valid,
    errors: valid
      ? []
      : (validate.errors ?? []).map((error) =>
          `${error.instancePath || "/"} ${error.message ?? error.keyword}`
        ),
  };
}

function failure(
  code: string,
  text: string,
): V03OperationResult<TypePackInstallResult> {
  return {
    valid: false,
    result: {} as TypePackInstallResult,
    diagnostics: [diagnostic(code, text)],
  };
}

function diagnostic(code: string, text: string, recordPath?: string, field?: string): V03Diagnostic {
  return {
    severity: "error",
    code,
    message: text,
    path: recordPath ?? "mdbase-pack.yaml",
    ...(field ? { field } : {}),
  };
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readOptional(target: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class TypePackError extends Error {
  constructor(readonly code: string, text: string) {
    super(text);
    this.name = "TypePackError";
  }
}
