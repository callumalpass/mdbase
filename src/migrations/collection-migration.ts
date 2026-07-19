import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { dump, load } from "js-yaml";
import { Collection } from "../operations/collection.js";
import { migrateV02TypeToV03, renderV03TypeFile, type TypeMigrationReport } from "./type-migration.js";

type Dict = Record<string, unknown>;

export interface CollectionMigrationDiagnostic {
  code: string;
  message: string;
  path?: string;
  field?: string;
  severity?: string;
}

export interface CollectionMigrationOperation {
  path: string;
  operation: "replace" | "delete";
  source_sha256: string;
  target_sha256?: string;
}

export interface CollectionMigrationReport {
  report_version: "0.1.0";
  analysis_id: string;
  source_version: string;
  target_version: "0.3.0";
  applicable: boolean;
  operations: CollectionMigrationOperation[];
  type_migrations: TypeMigrationReport[];
  generated_file_evidence: Array<{
    path: string;
    recognized: boolean;
    reasons: string[];
  }>;
  warnings: CollectionMigrationDiagnostic[];
  unsupported: Array<{ path: string; feature: string }>;
  invalid_records: Array<{ path: string; diagnostics: CollectionMigrationDiagnostic[] }>;
  target_diagnostics: CollectionMigrationDiagnostic[];
  backup: {
    required: true;
    location: string;
  };
  post_apply_validation: {
    status: "not_run" | "passed" | "failed" | "passed_with_invalid_records";
    diagnostics: CollectionMigrationDiagnostic[];
  };
}

export interface CollectionMigrationAnalysis {
  valid: boolean;
  report?: CollectionMigrationReport;
  proposedFiles?: Record<string, string | null>;
  error?: { code: string; message: string };
}

export interface CollectionMigrationApplyResult {
  valid: boolean;
  report?: CollectionMigrationReport;
  restored?: boolean;
  manual_recovery_paths?: string[];
  error?: { code: string; message: string };
}

export interface CollectionMigrationRecoveryResult {
  valid: boolean;
  restored_paths?: string[];
  manual_recovery_paths?: string[];
  error?: { code: string; message: string };
}

interface CollectionMigrationBackupManifest {
  report_version: typeof REPORT_VERSION;
  analysis_id: string;
  created_at: string;
  status: "prepared" | "applying" | "applied" | "rolled_back" | "recovery_required";
  written: string[];
  current?: string;
  files: Array<{ path: string; sha256: string; backup_path: string }>;
}

const TARGET_VERSION = "0.3.0" as const;
const REPORT_VERSION = "0.1.0" as const;
const KNOWN_CONFIG_KEYS = new Set([
  "spec_version",
  "name",
  "description",
  "settings",
  "runtime",
  "id_field",
  "default_validation",
]);
const KNOWN_SETTINGS_KEYS = new Set([
  "record_extensions",
  "extensions",
  "exclude",
  "include_subfolders",
  "types_folder",
  "migrations_folder",
  "explicit_type_keys",
  "default_validation",
  "default_strict",
  "id_field",
  "write_nulls",
  "write_empty_lists",
  "write_defaults",
  "rename_update_refs",
  "cache_folder",
  "validation",
]);

export async function analyzeV02CollectionMigration(
  collectionRoot: string,
): Promise<CollectionMigrationAnalysis> {
  const root = path.resolve(collectionRoot);
  const configPath = path.join(root, "mdbase.yaml");
  let configText: string;
  let rawConfig: Dict;
  try {
    configText = await fs.readFile(configPath, "utf8");
    const parsed = load(configText);
    if (!isPlainObject(parsed)) throw new Error("mdbase.yaml must be a mapping");
    rawConfig = parsed;
  } catch (error) {
    return failure("invalid_config", error);
  }

  const sourceVersion = String(rawConfig.spec_version ?? "");
  if (sourceVersion === TARGET_VERSION) {
    return {
      valid: false,
      error: { code: "already_migrated", message: `Collection already declares mdbase ${TARGET_VERSION}.` },
    };
  }
  if (!/^0\.2(?:\.\d+)?$/.test(sourceVersion)) {
    return {
      valid: false,
      error: {
        code: "unsupported_source_version",
        message: `Expected a v0.2.x collection, found spec_version ${JSON.stringify(sourceVersion)}.`,
      },
    };
  }

  const proposedFiles: Record<string, string | null> = {};
  const targetConfig = migrateConfig(rawConfig);
  proposedFiles["mdbase.yaml"] = `${dump(targetConfig, { noRefs: true, lineWidth: 100, sortKeys: false }).trimEnd()}\n`;

  const settings = isPlainObject(rawConfig.settings) ? rawConfig.settings : {};
  const typesFolder = typeof settings.types_folder === "string" ? settings.types_folder : "_types";
  const migrationsFolder = typeof settings.migrations_folder === "string"
    ? settings.migrations_folder
    : `${typesFolder}/_migrations`;
  const typeFiles = await findMarkdownFiles(path.join(root, typesFolder));
  const typeReports: TypeMigrationReport[] = [];
  const unsupported: Array<{ path: string; feature: string }> = [];
  const warnings: CollectionMigrationDiagnostic[] = [];
  const generatedEvidence: CollectionMigrationReport["generated_file_evidence"] = [];

  for (const fullPath of typeFiles) {
    const relativePath = normalizeRelative(root, fullPath);
    if (relativePath === migrationsFolder || relativePath.startsWith(`${migrationsFolder}/`)) continue;

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(await fs.readFile(fullPath, "utf8"));
    } catch (error) {
      return failure("invalid_type_migration", error);
    }
    if (isGeneratedLegacyMetaType(relativePath, typesFolder, parsed.data as Dict)) {
      proposedFiles[relativePath] = null;
      generatedEvidence.push({
        path: relativePath,
        recognized: true,
        reasons: ["legacy_generated_meta_type"],
      });
      continue;
    }
    const migrated = migrateV02TypeToV03(parsed.data as Dict, {
      sourcePath: relativePath,
      targetPath: relativePath,
      sourceVersion,
      targetVersion: TARGET_VERSION,
    });
    if (!migrated.valid || !migrated.typeFile || !migrated.report) {
      return {
        valid: false,
        error: migrated.error ?? { code: "invalid_type_migration", message: `Could not migrate ${relativePath}.` },
      };
    }
    proposedFiles[relativePath] = renderV03TypeFile(migrated.typeFile, parsed.content);
    typeReports.push(migrated.report);
    unsupported.push(...migrated.report.unsupported.map((feature) => ({ path: relativePath, feature })));
    warnings.push(...migrated.report.warnings.map((warning) => ({ ...warning, path: relativePath, severity: "warning" })));
    generatedEvidence.push(detectGeneratedFile(relativePath, parsed.data as Dict, parsed.content));
  }

  const operations = await buildOperations(root, proposedFiles);
  const staged = await validateProposedCollection(root, proposedFiles);
  const invalidRecords = groupInvalidRecords(staged.recordDiagnostics);
  const backupLocation = `.mdbase/migrations/v0.3-${analysisFingerprint({
    sourceVersion,
    operations,
    unsupported,
    invalidRecords,
    targetDiagnostics: staged.targetDiagnostics,
  }).slice(0, 12)}`;
  const analysisId = analysisFingerprint({
    sourceVersion,
    operations,
    typeReports,
    generatedEvidence,
    warnings,
    unsupported,
    invalidRecords,
    targetDiagnostics: staged.targetDiagnostics,
    backupLocation,
  });
  const applicable = staged.targetDiagnostics.length === 0 && unsupported.length === 0 && invalidRecords.length === 0;

  return {
    valid: true,
    proposedFiles,
    report: {
      report_version: REPORT_VERSION,
      analysis_id: analysisId,
      source_version: sourceVersion,
      target_version: TARGET_VERSION,
      applicable,
      operations,
      type_migrations: typeReports,
      generated_file_evidence: generatedEvidence,
      warnings,
      unsupported,
      invalid_records: invalidRecords,
      target_diagnostics: staged.targetDiagnostics,
      backup: { required: true, location: backupLocation },
      post_apply_validation: { status: "not_run", diagnostics: [] },
    },
  };
}

export async function applyV02CollectionMigration(
  collectionRoot: string,
  expectedReport: CollectionMigrationReport,
  options: { allowPartial?: boolean } = {},
): Promise<CollectionMigrationApplyResult> {
  if (expectedReport.report_version !== REPORT_VERSION || expectedReport.target_version !== TARGET_VERSION) {
    return {
      valid: false,
      error: { code: "invalid_migration_report", message: "The report version or target version is not supported." },
    };
  }

  const analysis = await analyzeV02CollectionMigration(collectionRoot);
  if (!analysis.valid || !analysis.report || !analysis.proposedFiles) {
    return { valid: false, error: analysis.error };
  }
  if (analysis.report.analysis_id !== expectedReport.analysis_id) {
    return {
      valid: false,
      error: {
        code: "migration_inputs_changed",
        message: "Collection inputs no longer match the supplied analysis report. Run analyze again.",
      },
    };
  }
  if (analysis.report.target_diagnostics.length > 0) {
    return {
      valid: false,
      report: analysis.report,
      error: { code: "invalid_migration_target", message: "Generated config or type files are invalid." },
    };
  }
  if (!options.allowPartial && (analysis.report.unsupported.length > 0 || analysis.report.invalid_records.length > 0)) {
    return {
      valid: false,
      report: analysis.report,
      error: {
        code: "partial_migration_required",
        message: "Analysis contains unsupported features or invalid records; re-run apply with explicit partial mode.",
      },
    };
  }

  const root = path.resolve(collectionRoot);
  const backupRoot = resolveInside(root, analysis.report.backup.location);
  try {
    await fs.mkdir(path.dirname(backupRoot), { recursive: true });
    await fs.mkdir(backupRoot, { recursive: false });
  } catch (error) {
    return failureApply("backup_failed", error, analysis.report);
  }

  const written: string[] = [];
  const backupManifest: CollectionMigrationBackupManifest = {
    report_version: REPORT_VERSION,
    analysis_id: analysis.report.analysis_id,
    created_at: new Date().toISOString(),
    status: "prepared",
    written: [],
    files: [],
  };
  const manifestPath = path.join(backupRoot, "manifest.json");
  try {
    for (const operation of analysis.report.operations) {
      const sourcePath = resolveInside(root, operation.path);
      const backupPath = resolveInside(backupRoot, path.join("files", operation.path));
      const source = await fs.readFile(sourcePath);
      if (sha256(source) !== operation.source_sha256) {
        throw new MigrationApplyError("migration_inputs_changed", `${operation.path} changed after analysis.`);
      }
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, source);
      backupManifest.files.push({
        path: operation.path,
        sha256: operation.source_sha256,
        backup_path: normalizeRelative(backupRoot, backupPath),
      });
    }
    await writeBackupManifest(manifestPath, backupManifest);
    backupManifest.status = "applying";
    await writeBackupManifest(manifestPath, backupManifest);

    for (const operation of analysis.report.operations) {
      const targetPath = resolveInside(root, operation.path);
      backupManifest.current = operation.path;
      await writeBackupManifest(manifestPath, backupManifest);
      if (operation.operation === "delete") {
        if (analysis.proposedFiles[operation.path] !== null || operation.target_sha256 !== undefined) {
          throw new MigrationApplyError("invalid_migration_report", `Invalid delete operation for ${operation.path}.`);
        }
        await fs.rm(targetPath);
      } else {
        const targetContent = analysis.proposedFiles[operation.path];
        if (typeof targetContent !== "string" || sha256(targetContent) !== operation.target_sha256) {
          throw new MigrationApplyError("invalid_migration_report", `Missing or mismatched target content for ${operation.path}.`);
        }
        await atomicWrite(targetPath, targetContent);
      }
      written.push(operation.path);
      backupManifest.written.push(operation.path);
      delete backupManifest.current;
      await writeBackupManifest(manifestPath, backupManifest);
    }

    const validation = await validateCollection(root);
    const invalidRecords = groupInvalidRecords(validation.recordDiagnostics);
    if (validation.targetDiagnostics.length > 0 || (!options.allowPartial && invalidRecords.length > 0)) {
      throw new MigrationApplyError("post_apply_validation_failed", "Migrated collection failed post-apply validation.");
    }

    const finalReport: CollectionMigrationReport = {
      ...analysis.report,
      post_apply_validation: {
        status: invalidRecords.length > 0 ? "passed_with_invalid_records" : "passed",
        diagnostics: [...validation.targetDiagnostics, ...validation.recordDiagnostics],
      },
    };
    await atomicWrite(path.join(backupRoot, "applied-report.json"), `${JSON.stringify(finalReport, null, 2)}\n`);
    backupManifest.status = "applied";
    await writeBackupManifest(manifestPath, backupManifest);
    return { valid: true, report: finalReport, restored: false };
  } catch (error) {
    const recoveryPaths = [...written];
    if (backupManifest.current) {
      const operation = analysis.report.operations.find((item) => item.path === backupManifest.current);
      try {
        const current = await fs.readFile(resolveInside(root, backupManifest.current));
        if (!operation || sha256(current) !== operation.source_sha256) recoveryPaths.push(backupManifest.current);
      } catch {
        recoveryPaths.push(backupManifest.current);
      }
    }
    const recovery = await restoreBackups(root, backupRoot, recoveryPaths, backupManifest);
    backupManifest.status = recovery.manual.length === 0 ? "rolled_back" : "recovery_required";
    delete backupManifest.current;
    backupManifest.written = recovery.manual;
    try {
      await writeBackupManifest(manifestPath, backupManifest);
    } catch {
      // The returned manual paths remain the recovery source of truth if journaling also failed.
    }
    const code = error instanceof MigrationApplyError ? error.code : "migration_apply_failed";
    const message = error instanceof Error ? error.message : String(error);
    const failedReport: CollectionMigrationReport = {
      ...analysis.report,
      post_apply_validation: {
        status: "failed",
        diagnostics: [{ code, message, severity: "error" }],
      },
    };
    return {
      valid: false,
      report: failedReport,
      restored: recovery.manual.length === 0,
      manual_recovery_paths: recovery.manual.length > 0 ? recovery.manual : undefined,
      error: { code, message },
    };
  }
}

export async function recoverV02CollectionMigration(
  collectionRoot: string,
  backupLocation: string,
): Promise<CollectionMigrationRecoveryResult> {
  const root = path.resolve(collectionRoot);
  let backupRoot: string;
  try {
    backupRoot = resolveInside(root, backupLocation);
    const migrationsRoot = resolveInside(root, ".mdbase/migrations");
    if (backupRoot === migrationsRoot || !backupRoot.startsWith(`${migrationsRoot}${path.sep}`)) {
      throw new Error("Backup location must be a child of .mdbase/migrations.");
    }
  } catch (error) {
    return recoveryFailure("invalid_backup_path", error);
  }

  const manifestPath = path.join(backupRoot, "manifest.json");
  let manifest: CollectionMigrationBackupManifest;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!isBackupManifest(parsed)) throw new Error("Backup manifest is malformed.");
    manifest = parsed;
  } catch (error) {
    return recoveryFailure("invalid_backup_manifest", error);
  }

  const recoveryPaths = manifest.status === "applied"
    ? manifest.files.map((file) => file.path)
    : [...manifest.written, ...(manifest.current ? [manifest.current] : [])];
  const recovery = await restoreBackups(root, backupRoot, recoveryPaths, manifest);
  manifest.status = recovery.manual.length === 0 ? "rolled_back" : "recovery_required";
  manifest.written = recovery.manual;
  delete manifest.current;
  try {
    await writeBackupManifest(manifestPath, manifest);
  } catch (error) {
    return {
      valid: false,
      restored_paths: recovery.restored,
      manual_recovery_paths: recovery.manual,
      error: {
        code: "recovery_journal_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (recovery.manual.length > 0) {
    return {
      valid: false,
      restored_paths: recovery.restored,
      manual_recovery_paths: recovery.manual,
      error: { code: "recovery_incomplete", message: "Some migration backups could not be restored." },
    };
  }
  return { valid: true, restored_paths: recovery.restored };
}

function migrateConfig(rawConfig: Dict): Dict {
  const target = cloneJsonLike(rawConfig);
  target.spec_version = TARGET_VERSION;
  const settings = isPlainObject(target.settings) ? target.settings : {};
  target.settings = settings;

  if (!Array.isArray(settings.record_extensions)) {
    const legacyExtensions = Array.isArray(settings.extensions)
      ? settings.extensions.map(String).map((extension) => extension.replace(/^\./, ""))
      : [];
    settings.record_extensions = [...new Set(["md", ...legacyExtensions])];
  }
  if (settings.validation === undefined && settings.default_validation !== undefined) {
    settings.validation = settings.default_validation;
  }
  if (settings.validation === undefined && target.default_validation !== undefined) {
    settings.validation = target.default_validation;
  }
  if (settings.id_field === undefined && target.id_field !== undefined) {
    settings.id_field = target.id_field;
  }

  const legacy: Dict = isPlainObject(target["x-legacy-v0.2"])
    ? cloneJsonLike(target["x-legacy-v0.2"] as Dict)
    : {};
  const unknownTop: Dict = {};
  for (const key of Object.keys(target)) {
    if (!KNOWN_CONFIG_KEYS.has(key) && !key.startsWith("x-")) {
      unknownTop[key] = target[key];
      delete target[key];
    }
  }
  const unknownSettings: Dict = {};
  for (const key of Object.keys(settings)) {
    if (!KNOWN_SETTINGS_KEYS.has(key)) {
      unknownSettings[key] = settings[key];
      delete settings[key];
    }
  }
  if (settings.extensions !== undefined) {
    unknownSettings.extensions = settings.extensions;
    delete settings.extensions;
  }
  delete settings.default_validation;
  delete target.id_field;
  delete target.default_validation;
  if (Object.keys(unknownTop).length > 0) legacy.config = unknownTop;
  if (Object.keys(unknownSettings).length > 0) legacy.settings = unknownSettings;
  if (Object.keys(legacy).length > 0) target["x-legacy-v0.2"] = legacy;
  return target;
}

async function buildOperations(root: string, proposedFiles: Record<string, string | null>): Promise<CollectionMigrationOperation[]> {
  const operations: CollectionMigrationOperation[] = [];
  for (const relativePath of Object.keys(proposedFiles).sort()) {
    const source = await fs.readFile(resolveInside(root, relativePath));
    const proposed = proposedFiles[relativePath];
    operations.push(proposed === null
      ? {
          path: relativePath,
          operation: "delete",
          source_sha256: sha256(source),
        }
      : {
          path: relativePath,
          operation: "replace",
          source_sha256: sha256(source),
          target_sha256: sha256(proposed),
        });
  }
  return operations;
}

async function validateProposedCollection(
  root: string,
  proposedFiles: Record<string, string | null>,
): Promise<{ targetDiagnostics: CollectionMigrationDiagnostic[]; recordDiagnostics: CollectionMigrationDiagnostic[] }> {
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-v03-migration-"));
  try {
    await fs.cp(root, stageRoot, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(root, source);
        if (!relative) return true;
        const first = relative.split(path.sep)[0];
        return first !== ".git" && first !== "node_modules" && first !== ".mdbase";
      },
    });
    for (const [relativePath, content] of Object.entries(proposedFiles)) {
      const target = resolveInside(stageRoot, relativePath);
      if (content === null) {
        await fs.rm(target, { force: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    return await validateCollection(stageRoot);
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

async function validateCollection(
  root: string,
): Promise<{ targetDiagnostics: CollectionMigrationDiagnostic[]; recordDiagnostics: CollectionMigrationDiagnostic[] }> {
  const opened = await Collection.open(root);
  if (!opened.collection) {
    return {
      targetDiagnostics: [{
        code: opened.error?.code ?? "invalid_migration_target",
        message: opened.error?.message ?? "Could not open migrated collection.",
        severity: "error",
      }],
      recordDiagnostics: [],
    };
  }
  try {
    const result = await opened.collection.validate();
    return {
      targetDiagnostics: [],
      recordDiagnostics: result.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path,
        field: issue.field,
        severity: issue.severity,
      })),
    };
  } finally {
    await opened.collection.close();
  }
}

function groupInvalidRecords(
  diagnostics: CollectionMigrationDiagnostic[],
): CollectionMigrationReport["invalid_records"] {
  const grouped = new Map<string, CollectionMigrationDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    if ((diagnostic.severity ?? "error") !== "error") continue;
    const recordPath = diagnostic.path ?? "<collection>";
    const existing = grouped.get(recordPath) ?? [];
    existing.push(diagnostic);
    grouped.set(recordPath, existing);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recordPath, recordDiagnostics]) => ({ path: recordPath, diagnostics: recordDiagnostics }));
}

function detectGeneratedFile(relativePath: string, data: Dict, body: string): CollectionMigrationReport["generated_file_evidence"][number] {
  const reasons: string[] = [];
  if (typeof data.description === "string" && /generated/i.test(data.description)) reasons.push("description_contains_generated");
  if (/\bgenerated\b/i.test(body)) reasons.push("body_contains_generated");
  const fields = isPlainObject(data.fields) ? data.fields : {};
  if (Object.values(fields).some((field) => isPlainObject(field) && typeof field.tn_role === "string")) {
    reasons.push("tasknotes_export_signature");
  }
  if (typeof data.name === "string" && data.name.startsWith("pickle_") && typeof data.description === "string" && /Pickle/i.test(data.description)) {
    reasons.push("pickle_builtin_signature");
  }
  return { path: relativePath, recognized: reasons.length > 0, reasons };
}

function isGeneratedLegacyMetaType(relativePath: string, typesFolder: string, data: Dict): boolean {
  const expectedPath = `${typesFolder.replaceAll("\\", "/").replace(/\/$/, "")}/meta.md`;
  if (relativePath !== expectedPath || data.name !== "meta") return false;
  const description = typeof data.description === "string" ? data.description : "";
  if (!/schema for type definition files/i.test(description)) return false;
  const match = isPlainObject(data.match) ? data.match : {};
  if (match.path_glob !== `${typesFolder}/**/*.md`) return false;
  const fields = isPlainObject(data.fields) ? data.fields : {};
  const fieldGrammar = isPlainObject(fields.fields) ? fields.fields : {};
  return fieldGrammar.type === "any" &&
    isPlainObject(fields.name) &&
    fields.name.required === true;
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await findMarkdownFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(fullPath);
  }
  return files.sort();
}

async function atomicWrite(targetPath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.mdbase-${process.pid}-${Date.now()}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await fs.stat(targetPath)).mode;
  } catch {
    mode = undefined;
  }
  try {
    await fs.writeFile(temporary, content, mode === undefined ? undefined : { mode });
    await fs.rename(temporary, targetPath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function restoreBackups(
  root: string,
  backupRoot: string,
  paths: string[],
  manifest?: CollectionMigrationBackupManifest,
): Promise<{ restored: string[]; manual: string[] }> {
  const restored: string[] = [];
  const manual: string[] = [];
  for (const relativePath of [...new Set(paths)].reverse()) {
    try {
      const entry = manifest?.files.find((file) => file.path === relativePath);
      if (manifest && !entry) throw new Error(`No backup entry for ${relativePath}.`);
      const backup = resolveInside(backupRoot, entry?.backup_path ?? path.join("files", relativePath));
      const source = await fs.readFile(backup);
      if (entry && sha256(source) !== entry.sha256) throw new Error(`Backup hash mismatch for ${relativePath}.`);
      await atomicWrite(resolveInside(root, relativePath), source);
      restored.push(relativePath);
    } catch {
      manual.push(relativePath);
    }
  }
  return { restored, manual };
}

async function writeBackupManifest(
  manifestPath: string,
  manifest: CollectionMigrationBackupManifest,
): Promise<void> {
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function isBackupManifest(value: unknown): value is CollectionMigrationBackupManifest {
  if (!isPlainObject(value)) return false;
  if (value.report_version !== REPORT_VERSION || typeof value.analysis_id !== "string") return false;
  if (!Array.isArray(value.written) || !value.written.every((entry) => typeof entry === "string")) return false;
  if (!Array.isArray(value.files)) return false;
  return value.files.every((entry) => isPlainObject(entry) &&
    typeof entry.path === "string" &&
    typeof entry.sha256 === "string" &&
    typeof entry.backup_path === "string");
}

function recoveryFailure(code: string, error: unknown): CollectionMigrationRecoveryResult {
  return {
    valid: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
  };
}

function analysisFingerprint(value: unknown): string {
  return sha256(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes collection root: ${relativePath}`);
  }
  return resolved;
}

function normalizeRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function cloneJsonLike<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: string, error: unknown): CollectionMigrationAnalysis {
  return {
    valid: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
  };
}

function failureApply(
  code: string,
  error: unknown,
  report: CollectionMigrationReport,
): CollectionMigrationApplyResult {
  return {
    valid: false,
    report,
    error: { code, message: error instanceof Error ? error.message : String(error) },
  };
}

class MigrationApplyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
