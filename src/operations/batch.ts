/**
 * v0.3 batch support (spec Chapter 12, "Batch"): request checks, the staged
 * collection copy that atomic batches and dry runs prepare against, and the
 * journaled commit of staged changes.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { V03Diagnostic } from "./contracts.js";
import {
  atomicWrite,
  resolveInside,
  restoreTypePackTransaction,
  type TypePackTransactionJournal,
} from "../type-packs/recovery.js";

export const BATCH_TRANSACTIONS_FOLDER = ".mdbase/batch-transactions";
/** Never copied into a staged collection and never part of a staged diff. */
const UNSTAGED_DIRECTORIES = new Set([".git", ".mdbase", "node_modules"]);

export const BATCH_KINDS = ["create", "update", "delete", "rename"] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

export interface V03BatchItem {
  kind: BatchKind;
  input: Record<string, unknown>;
}

export interface V03BatchInput {
  operations: V03BatchItem[];
  dry_run?: boolean;
  allow_partial?: boolean;
}

/** Reject a malformed request or one that names a record path twice. */
export function batchRequestError(input: V03BatchInput): V03Diagnostic | undefined {
  const invalid = (message: string): V03Diagnostic => ({ severity: "error", code: "invalid_request", message });
  if (!Array.isArray(input?.operations)) return invalid("batch requires an operations list");
  for (const flag of ["dry_run", "allow_partial"] as const) {
    if (input[flag] !== undefined && typeof input[flag] !== "boolean") {
      return invalid(`batch ${flag} must be a boolean`);
    }
  }
  const seen = new Set<string>();
  for (const [index, item] of input.operations.entries()) {
    if (!item || typeof item !== "object" || !BATCH_KINDS.includes(item.kind)) {
      return invalid(`batch operation ${index} must name a kind of ${BATCH_KINDS.join(", ")}`);
    }
    if (!item.input || typeof item.input !== "object" || Array.isArray(item.input)) {
      return invalid(`batch operation ${index} requires an input mapping`);
    }
    for (const key of item.kind === "rename" ? ["from", "to"] : ["path"]) {
      const value = item.input[key];
      if (typeof value !== "string") continue;
      const canonical = path.posix.normalize(value.replaceAll("\\", "/"));
      if (seen.has(canonical)) {
        return {
          severity: "error",
          code: "duplicate_batch_path",
          message: `Batch path '${canonical}' is used more than once.`,
          path: canonical,
        };
      }
      seen.add(canonical);
    }
  }
  return undefined;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}

/** Non-record files above this size are staged as empty placeholders when copying. */
const PLACEHOLDER_THRESHOLD = 1024 * 1024;

export interface StagedCollection {
  root: string;
  /** Stamps of the original files when they were staged, for conflict checks. */
  snapshot: Map<string, FileStamp>;
  /** Stamps of the staged files before any operation ran. */
  staged: Map<string, FileStamp>;
  cleanup(): Promise<void>;
}

export interface StageOptions {
  /** Whether a collection-relative file is a record file. */
  isRecordFile(relativePath: string): boolean;
  /** Set false to copy even where hard links are possible. */
  link?: boolean;
}

/**
 * Stage the collection in a private directory outside it, so that file
 * sync and watchers never see batch preparation.
 *
 * On the collection's filesystem the stage uses hard links, which cost one
 * directory entry per file. This is safe because collection writes replace
 * files atomically rather than writing through them. Elsewhere the stage
 * copies files, using reflinks where the filesystem supports them, and
 * stands in empty placeholders for large non-record files such as
 * attachments: operations only need those to exist for link resolution.
 */
export async function stageCollection(collectionRoot: string, options: StageOptions): Promise<StagedCollection> {
  const root = path.resolve(collectionRoot);
  const { parent, linked } = options.link === false
    ? { parent: os.tmpdir(), linked: false }
    : await stagingParent(root);
  const stagingRoot = await fsp.mkdtemp(path.join(parent, "mdbase-batch-"));
  const snapshot = new Map<string, FileStamp>();
  const staged = new Map<string, FileStamp>();
  const cleanup = async () => {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
  };
  try {
    for (const relative of await listFiles(root)) {
      const source = path.join(root, relative);
      const target = path.join(stagingRoot, relative);
      const stat = await fsp.stat(source);
      snapshot.set(relative, stamp(stat));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (!(linked && await tryLink(source, target))) {
        if (stat.size > PLACEHOLDER_THRESHOLD && !options.isRecordFile(relative)) {
          await fsp.writeFile(target, "");
        } else {
          await fsp.copyFile(source, target, fs.constants.COPYFILE_FICLONE);
        }
      }
      staged.set(relative, stamp(await fsp.stat(target)));
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { root: stagingRoot, snapshot, staged, cleanup };
}

/**
 * A staging parent outside the collection: the first of the temporary and
 * user cache directories on the collection's filesystem, which allows hard
 * links, or else the temporary directory.
 */
async function stagingParent(root: string): Promise<{ parent: string; linked: boolean }> {
  const device = (await fsp.stat(root)).dev;
  const candidates = [
    os.tmpdir(),
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "mdbase"),
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) continue;
    try {
      await fsp.mkdir(resolved, { recursive: true });
      if ((await fsp.stat(resolved)).dev === device) return { parent: resolved, linked: true };
    } catch {
      // An unusable candidate falls through to the next one.
    }
  }
  return { parent: os.tmpdir(), linked: false };
}

async function tryLink(source: string, target: string): Promise<boolean> {
  try {
    await fsp.link(source, target);
    return true;
  } catch {
    return false;
  }
}

function stamp(stat: fs.Stats): FileStamp {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

function sameStamp(left: FileStamp | undefined, right: FileStamp | undefined): boolean {
  return !!left && !!right && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

export interface StagedChanges {
  writes: string[];
  deletes: string[];
}

/** Files the staged operations created, rewrote, or removed. */
export async function stagedChanges(staged: StagedCollection): Promise<StagedChanges> {
  const writes: string[] = [];
  const present = new Set<string>();
  for (const relative of await listFiles(staged.root)) {
    present.add(relative);
    if (!sameStamp(staged.staged.get(relative), stamp(await fsp.stat(path.join(staged.root, relative))))) {
      writes.push(relative);
    }
  }
  const deletes = [...staged.staged.keys()].filter((relative) => !present.has(relative));
  return { writes, deletes };
}

/**
 * Apply staged changes to the collection as one recoverable transaction.
 *
 * Every target is checked against its staging-time stamp and backed up before
 * the journal records it. A journal that never reaches `committed` is rolled
 * back when the collection is next opened, restoring the pre-batch state.
 */
export async function commitStagedChanges(
  collectionRoot: string,
  staged: StagedCollection,
  changes: StagedChanges,
): Promise<V03Diagnostic | undefined> {
  const root = path.resolve(collectionRoot);
  const targets = [...changes.writes, ...changes.deletes].sort();
  if (targets.length === 0) return undefined;

  for (const target of targets) {
    const before = staged.snapshot.get(target);
    const current = await fsp.stat(resolveInside(root, target)).catch(() => undefined);
    const unchanged = before ? sameStamp(current && stamp(current), before) : current === undefined;
    if (!unchanged) {
      return {
        severity: "error",
        code: "concurrent_modification",
        message: `'${target}' changed while the batch was being prepared.`,
        path: target,
      };
    }
  }

  const transactionId = randomUUID();
  const transactionRoot = resolveInside(root, `${BATCH_TRANSACTIONS_FOLDER}/${transactionId}`);
  const journalPath = path.join(transactionRoot, "journal.json");
  const journal: TypePackTransactionJournal = {
    version: 1,
    transaction_id: transactionId,
    status: "prepared",
    entries: [],
  };
  // Recovery expects a journal in every transaction directory; an empty
  // prepared journal restores nothing, which is correct before any write.
  await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  for (const [index, target] of targets.entries()) {
    if (!staged.snapshot.has(target)) {
      journal.entries.push({ target, existed: false });
      continue;
    }
    const backupPath = `backup/${index}`;
    await fsp.mkdir(path.join(transactionRoot, "backup"), { recursive: true });
    await fsp.copyFile(resolveInside(root, target), path.join(transactionRoot, backupPath));
    journal.entries.push({ target, existed: true, backup_path: backupPath });
  }

  journal.status = "applying";
  await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  try {
    for (const target of changes.writes) {
      await atomicWrite(resolveInside(root, target), await fsp.readFile(path.join(staged.root, target)));
    }
    for (const target of changes.deletes) {
      await fsp.rm(resolveInside(root, target), { force: true });
    }
  } catch (error) {
    await restoreTypePackTransaction(root, transactionRoot, journal);
    await fsp.rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
  journal.status = "committed";
  await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await fsp.rm(transactionRoot, { recursive: true, force: true });
  return undefined;
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await fsp.readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!UNSTAGED_DIRECTORIES.has(entry.name)) files.push(...await listFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}
