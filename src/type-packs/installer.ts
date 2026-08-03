import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { compare as compareSemver } from "semver";
import { parse as parseYaml } from "yaml";
import { Collection } from "../operations/collection.js";
import type { V03Diagnostic, V03OperationResult } from "../operations/contracts.js";
import { typePackLockSchema, typePackSchema } from "../generated/v03-schemas.js";
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
  mode: "managed" | "seed";
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

export interface TypePackProvision {
  manifest: TypePackManifest;
  resources: TypePackSourceResource[];
}

export interface TypePackResourceDiff {
  kind: "contract" | "type" | "schema";
  mode: "managed" | "seed";
  source: string;
  target: string;
  action: "create" | "update" | "delete" | "adopt" | "unchanged" | "preserve" | "conflict";
  digest: string;
  current_digest?: string;
  installed_digest?: string;
  adopted_from_digest?: string;
  reason?: string;
}

export interface TypePackReceipt {
  id: string;
  version: string;
  digest: string;
  installed_by: string;
  resources: Array<{
    kind: "contract" | "type" | "schema";
    mode: "managed" | "seed";
    source: string;
    target: string;
    digest: string;
  }>;
}

export interface TypePackAssessment {
  status: "current" | "install" | "upgrade" | "downgrade" | "reconfigure" | "conflict";
  applicable: boolean;
  assessment_digest: string;
  current?: TypePackReceipt;
  desired: TypePackReceipt;
  resources: TypePackResourceDiff[];
  lock: {
    target: typeof TYPE_PACK_LOCK_PATH;
    action: "create" | "update" | "unchanged";
    digest: string;
  };
}

export interface ApplyTypePackOptions {
  installedBy: string;
  expectedAssessmentDigest: string;
  allowDowngrade?: boolean;
  adoptResources?: Record<string, string>;
  preserveSeedTargets?: string[];
  targetOverrides?: Record<string, string>;
}

export interface TypePackApplyResult extends TypePackAssessment {
  receipt: TypePackReceipt;
  cleanup_deferred: boolean;
}

interface PlannedResource extends TypePackResourceDiff {
  bytes?: Buffer;
  before?: Buffer;
}

interface TypePackLock {
  kind: "mdbase.type-pack-lock";
  lock_version: 1;
  packs: TypePackReceipt[];
}

interface PlannedAssessment {
  assessment: TypePackAssessment;
  lock: TypePackLock;
  nextLock: TypePackLock;
  resources: PlannedResource[];
  lockBefore?: Buffer;
  lockAfter: Buffer;
}

export const TYPE_PACK_LOCK_PATH = "mdbase.lock.yaml";

/** Inspect exact managed-pack state without changing collection resources. */
export async function assessTypePack(
  collectionRoot: string,
  provision: TypePackProvision,
  options: {
    installedBy: string;
    adoptResources?: Record<string, string>;
    preserveSeedTargets?: string[];
    targetOverrides?: Record<string, string>;
  },
): Promise<V03OperationResult<TypePackAssessment>> {
  const root = path.resolve(collectionRoot);
  try {
    await recoverInterruptedTypePackTransactions(root);
  } catch (error) {
    return failure("type_pack_apply_failed", `Could not recover an earlier type-pack transaction: ${message(error)}`);
  }

  try {
    const planned = await planAssessment(
      root,
      provision,
      options.installedBy,
      options.adoptResources ?? {},
      new Set(options.preserveSeedTargets ?? []),
      options.targetOverrides ?? {},
    );
    return { valid: true, result: planned.assessment, diagnostics: [] };
  } catch (error) {
    const code = error instanceof TypePackError ? error.code : "invalid_type_pack";
    return failure(code, message(error));
  }
}

/** Apply one reviewed managed-pack assessment as a recoverable transaction. */
export async function applyTypePack(
  collectionRoot: string,
  provision: TypePackProvision,
  options: ApplyTypePackOptions,
): Promise<V03OperationResult<TypePackApplyResult>> {
  const root = path.resolve(collectionRoot);
  try {
    await recoverInterruptedTypePackTransactions(root);
  } catch (error) {
    return failure("type_pack_apply_failed", `Could not recover an earlier type-pack transaction: ${message(error)}`);
  }

  let planned: PlannedAssessment;
  try {
    planned = await planAssessment(
      root,
      provision,
      options.installedBy,
      options.adoptResources ?? {},
      new Set(options.preserveSeedTargets ?? []),
      options.targetOverrides ?? {},
    );
  } catch (error) {
    const code = error instanceof TypePackError ? error.code : "invalid_type_pack";
    return failure(code, message(error));
  }
  if (planned.assessment.assessment_digest !== options.expectedAssessmentDigest) {
    return failure(
      "concurrent_modification",
      "The managed type-pack assessment is stale. Assess the collection again before applying it.",
    );
  }
  if (!planned.assessment.applicable) {
    const conflict = planned.resources.find(({ action }) => action === "conflict");
    return failure("type_pack_conflict", conflict?.reason ?? "The managed type pack has unresolved conflicts.");
  }
  if (planned.assessment.status === "downgrade" && !options.allowDowngrade) {
    return failure("type_pack_downgrade", "A managed type-pack downgrade requires explicit approval.");
  }

  const staged = await validateStagedCollection(root, planned.resources);
  if (!staged.valid) {
    return {
      valid: false,
      result: {} as TypePackApplyResult,
      diagnostics: staged.diagnostics,
    };
  }

  const result: TypePackApplyResult = {
    ...planned.assessment,
    receipt: planned.assessment.desired,
    cleanup_deferred: false,
  };
  const mutations = planned.resources.filter(({ action }) => ["create", "update", "delete"].includes(action));
  const lockChanged = !sameBytes(planned.lockBefore, planned.lockAfter);
  if (mutations.length === 0 && !lockChanged) {
    return { valid: true, result, diagnostics: [] };
  }

  const transactionId = randomUUID();
  const transactionRoot = resolveInside(root, `${TYPE_PACK_TRANSACTIONS_FOLDER}/${transactionId}`);
  const journalPath = resolveInside(transactionRoot, "journal.json");
  const journal: TypePackTransactionJournal = {
    version: 1,
    transaction_id: transactionId,
    status: "prepared",
    entries: [
      ...mutations.map(({ target, before }) => ({
        target,
        existed: before !== undefined,
        ...(before ? { before_digest: digest(before), backup_path: `backups/${target}` } : {}),
      })),
      ...(lockChanged ? [{
        target: TYPE_PACK_LOCK_PATH,
        existed: planned.lockBefore !== undefined,
        ...(planned.lockBefore ? {
          before_digest: digest(planned.lockBefore),
          backup_path: `backups/${TYPE_PACK_LOCK_PATH}`,
        } : {}),
      }] : []),
    ],
  };

  let committed = false;
  try {
    await fs.mkdir(path.dirname(transactionRoot), { recursive: true });
    await fs.mkdir(transactionRoot, { recursive: false });
    for (const entry of journal.entries) {
      if (!entry.backup_path) continue;
      const before = entry.target === TYPE_PACK_LOCK_PATH
        ? planned.lockBefore
        : planned.resources.find(({ target }) => target === entry.target)?.before;
      if (!before) throw new Error(`Missing pre-apply bytes for ${entry.target}.`);
      await atomicWrite(resolveInside(transactionRoot, entry.backup_path), before);
    }
    await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    // Recheck the complete baseline before the first live write.
    for (const resource of planned.resources) {
      const current = await readOptional(resolveInside(root, resource.target));
      if (!sameBytes(current, resource.before)) {
        throw new TypePackError(
          "type_pack_conflict",
          `Type-pack target ${resource.target} changed after preflight.`,
        );
      }
    }
    const currentLock = await readOptional(resolveInside(root, TYPE_PACK_LOCK_PATH));
    if (!sameBytes(currentLock, planned.lockBefore)) {
      throw new TypePackError("concurrent_modification", "The type-pack lock changed after assessment.");
    }
    journal.status = "applying";
    await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    for (const resource of mutations) {
      const target = resolveInside(root, resource.target);
      if (resource.action === "delete") await fs.rm(target, { force: true });
      else if (resource.bytes) await atomicWrite(target, resource.bytes);
    }
    if (lockChanged) await atomicWrite(resolveInside(root, TYPE_PACK_LOCK_PATH), planned.lockAfter);

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

async function planAssessment(
  root: string,
  provision: TypePackProvision,
  installedBy: string,
  adoptResources: Record<string, string>,
  preserveSeedTargets: ReadonlySet<string>,
  targetOverrides: Record<string, string>,
): Promise<PlannedAssessment> {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(installedBy)) {
    throw new TypePackError("invalid_type_pack", "installedBy must be a stable namespaced identifier.");
  }
  const manifestValidation = validateManifest(provision.manifest);
  if (!manifestValidation.valid) {
    throw new TypePackError("invalid_type_pack", `Type-pack manifest is invalid: ${manifestValidation.errors.join("; ")}`);
  }
  const manifest = provision.manifest;
  for (const target of Object.keys(targetOverrides)) {
    if (!manifest.resources.some((resource) => resource.target === target)) {
      throw new TypePackError(
        "invalid_type_pack",
        `Target override ${target} is not a resource in the desired pack.`,
      );
    }
  }
  const resolvedDefinitions = manifest.resources.map((resource) => ({
    ...resource,
    target: targetOverrides[resource.target] ?? resource.target,
  }));
  if (new Set(resolvedDefinitions.map(({ target }) => target)).size !== resolvedDefinitions.length) {
    throw new TypePackError("invalid_type_pack", "Target overrides resolve more than one resource to the same path.");
  }
  for (const target of Object.keys(adoptResources)) {
    if (!resolvedDefinitions.some((resource) =>
      resource.target === target && resource.mode === "managed")) {
      throw new TypePackError(
        "invalid_type_pack",
        `Adoption target ${target} is not a managed resource in the desired pack.`,
      );
    }
  }
  for (const target of preserveSeedTargets) {
    if (!resolvedDefinitions.some((resource) =>
      resource.target === target && resource.mode === "seed")) {
      throw new TypePackError(
        "invalid_type_pack",
        `Preserved seed target ${target} is not a seed resource in the desired pack.`,
      );
    }
  }
  const sources = new Map<string, Buffer>();
  for (const resource of provision.resources) {
    resolveInside(root, resource.source);
    if (sources.has(resource.source)) {
      throw new TypePackError("invalid_type_pack", `Duplicate source resource: ${resource.source}.`);
    }
    sources.set(resource.source, Buffer.from(resource.document, "utf8"));
  }
  if (sources.size !== manifest.resources.length) {
    throw new TypePackError("invalid_type_pack", "The type pack contains undeclared source resources.");
  }
  const lockPath = resolveInside(root, TYPE_PACK_LOCK_PATH);
  const lockBefore = await readOptional(lockPath);
  const lock = parseLock(lockBefore);
  const current = lock.packs.find(({ id }) => id === manifest.id);
  const desired: TypePackReceipt = {
    id: manifest.id,
    version: manifest.version,
    digest: canonicalDigest(manifest),
    installed_by: current?.installed_by ?? installedBy,
    resources: resolvedDefinitions.map(({ kind, mode, source, target, digest: resourceDigest }) => ({
      kind, mode, source, target, digest: resourceDigest,
    })),
  };
  const targets = new Set<string>();
  const desiredBySource = new Map(resolvedDefinitions.map((resource) => [resource.source, resource]));
  const currentBySource = new Map(current?.resources.map((resource) => [resource.source, resource]) ?? []);
  const otherManagedOwners = new Map(
    lock.packs
      .filter(({ id }) => id !== manifest.id)
      .flatMap((receipt) => receipt.resources
        .filter(({ mode }) => mode === "managed")
        .map((resource) => [resource.target, receipt.id] as const)),
  );
  const planned: PlannedResource[] = [];
  for (const definition of resolvedDefinitions) {
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
    const priorResource = currentBySource.get(definition.source);
    const currentResource = priorResource?.target === definition.target ? priorResource : undefined;
    const owner = otherManagedOwners.get(definition.target);
    const currentDigest = before ? digest(before) : undefined;
    let action: TypePackResourceDiff["action"];
    let reason: string | undefined;
    let adoptedFromDigest: string | undefined;
    if (owner) {
      action = "conflict";
      reason = `${definition.target} is managed by ${owner}.`;
    } else if (definition.mode === "seed") {
      action = before === undefined && !currentResource && !preserveSeedTargets.has(definition.target)
        ? "create"
        : "preserve";
    } else if (!currentResource) {
      if (before === undefined) action = "create";
      else if (currentDigest === definition.digest) {
        action = "adopt";
        adoptedFromDigest = currentDigest;
      } else if (adoptResources[definition.target] === currentDigest) {
        action = "update";
        adoptedFromDigest = currentDigest;
      } else {
        action = "conflict";
        reason = `${definition.target} exists but is not managed by ${manifest.id}.`;
      }
    } else if (currentResource.mode !== "managed") {
      action = "conflict";
      reason = `${definition.target} was installed as a seed and cannot be claimed as managed implicitly.`;
    } else if (currentDigest !== currentResource.digest) {
      action = "conflict";
      reason = `${definition.target} changed since ${manifest.id} ${current?.version ?? "unknown"} was applied.`;
    } else {
      action = definition.digest === currentResource.digest ? "unchanged" : "update";
    }
    planned.push({
      kind: definition.kind,
      mode: definition.mode,
      source: definition.source,
      target: definition.target,
      action,
      digest: definition.digest,
      bytes,
      ...(before ? { before, current_digest: currentDigest } : {}),
      ...(currentResource ? { installed_digest: currentResource.digest } : {}),
      ...(adoptedFromDigest ? { adopted_from_digest: adoptedFromDigest } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  for (const prior of current?.resources ?? []) {
    const before = await readOptional(resolveInside(root, prior.target));
    const currentDigest = before ? digest(before) : undefined;
    let action: TypePackResourceDiff["action"] = "preserve";
    let reason: string | undefined;
    const desiredResource = desiredBySource.get(prior.source);
    if (desiredResource?.target === prior.target) continue;
    if (prior.mode === "managed") {
      if (currentDigest === prior.digest) action = "delete";
      else {
        action = "conflict";
        reason = `${prior.target} changed and cannot be retired safely.`;
      }
    }
    planned.push({
      ...prior,
      action,
      ...(before ? { before, current_digest: currentDigest } : {}),
      installed_digest: prior.digest,
      ...(reason ? { reason } : {}),
    });
  }

  let status: TypePackAssessment["status"];
  if (planned.some(({ action }) => action === "conflict")) status = "conflict";
  else if (!current) status = "install";
  else if (current.version === desired.version && current.digest === desired.digest) {
    status = planned.some(({ action }) => !["unchanged", "preserve", "adopt"].includes(action))
      || JSON.stringify(current.resources) !== JSON.stringify(desired.resources)
      ? "reconfigure"
      : "current";
  }
  else if (current.version === desired.version) {
    status = "conflict";
    planned[0] = {
      ...planned[0]!,
      action: "conflict",
      reason: `${manifest.id} ${manifest.version} has a different immutable pack digest. Publish a new version.`,
    };
  } else status = compareSemver(desired.version, current.version) > 0 ? "upgrade" : "downgrade";

  const nextLock: TypePackLock = {
    kind: "mdbase.type-pack-lock",
    lock_version: 1,
    packs: [...lock.packs.filter(({ id }) => id !== desired.id), desired]
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const lockAfter = Buffer.from(`${JSON.stringify(nextLock, null, 2)}\n`, "utf8");
  const lockAction: TypePackAssessment["lock"]["action"] = lockBefore === undefined
    ? "create"
    : sameBytes(lockBefore, lockAfter)
      ? "unchanged"
      : "update";
  const assessmentBase = {
    status,
    applicable: status !== "conflict",
    ...(current ? { current } : {}),
    desired,
    resources: planned.map(({ bytes: _bytes, before: _before, ...resource }) => resource),
    lock: {
      target: TYPE_PACK_LOCK_PATH as typeof TYPE_PACK_LOCK_PATH,
      action: lockAction,
      digest: digest(lockAfter),
    },
  };
  const assessment: TypePackAssessment = {
    ...assessmentBase,
    assessment_digest: canonicalDigest({
      ...assessmentBase,
      lock_digest: lockBefore ? digest(lockBefore) : null,
    }),
  };
  return {
    assessment,
    lock,
    nextLock,
    resources: planned,
    ...(lockBefore ? { lockBefore } : {}),
    lockAfter,
  };
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
      const target = resolveInside(stage, resource.target);
      if (resource.action === "delete") await fs.rm(target, { force: true });
      else if (["create", "update"].includes(resource.action) && resource.bytes) {
        await atomicWrite(target, resource.bytes);
      }
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

function parseLock(bytes: Buffer | undefined): TypePackLock {
  if (!bytes) return { kind: "mdbase.type-pack-lock", lock_version: 1, packs: [] };
  let value: unknown;
  try {
    value = parseYaml(bytes.toString("utf8"));
  } catch (error) {
    throw new TypePackError("invalid_type_pack", `Could not parse ${TYPE_PACK_LOCK_PATH}: ${message(error)}`);
  }
  const validation = validateValue(typePackLockSchema, value);
  if (!validation.valid) {
    throw new TypePackError(
      "invalid_type_pack",
      `${TYPE_PACK_LOCK_PATH} is invalid: ${validation.errors.join("; ")}`,
    );
  }
  const lock = value as TypePackLock;
  const ids = new Set<string>();
  const targets = new Map<string, string>();
  for (const receipt of lock.packs) {
    if (!ids.add(receipt.id)) {
      throw new TypePackError("invalid_type_pack", `${TYPE_PACK_LOCK_PATH} contains duplicate pack ${receipt.id}.`);
    }
    for (const resource of receipt.resources) {
      if (resource.mode !== "managed") continue;
      const owner = targets.get(resource.target);
      if (owner) {
        throw new TypePackError(
          "invalid_type_pack",
          `${TYPE_PACK_LOCK_PATH} assigns ${resource.target} to both ${owner} and ${receipt.id}.`,
        );
      }
      targets.set(resource.target, receipt.id);
    }
  }
  return lock;
}

function canonicalDigest(value: unknown): string {
  return digest(Buffer.from(canonicalJson(value), "utf8"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypePackError("invalid_type_pack", "Pack identity contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypePackError("invalid_type_pack", "Pack identity contains an unsupported value.");
}

function validateValue(
  schema: Record<string, unknown>,
  value: unknown,
): { valid: boolean; errors: string[] } {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => void;
  addFormats(ajv);
  const validate = ajv.compile(schema);
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

function failure<Result>(
  code: string,
  text: string,
): V03OperationResult<Result> {
  return {
    valid: false,
    result: {} as Result,
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
