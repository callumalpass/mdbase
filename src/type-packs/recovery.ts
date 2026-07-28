import * as fs from "node:fs/promises";
import * as path from "node:path";

export const TYPE_PACK_TRANSACTIONS_FOLDER = ".mdbase/type-pack-transactions";

export interface TypePackTransactionEntry {
  target: string;
  existed: boolean;
  before_digest?: string;
  backup_path?: string;
}

export interface TypePackTransactionJournal {
  version: 1;
  transaction_id: string;
  status: "prepared" | "applying" | "committed" | "rolled_back";
  entries: TypePackTransactionEntry[];
}

/**
 * Complete recovery before a collection is opened.
 *
 * A pack transaction is committed only after the complete collection has
 * reopened successfully. Any earlier journal therefore restores every target
 * to its pre-install state. Restoring every entry also covers a crash between
 * an atomic resource write and its journal update.
 */
export async function recoverInterruptedTypePackTransactions(
  collectionRoot: string,
): Promise<void> {
  const root = path.resolve(collectionRoot);
  const transactionsRoot = resolveInside(root, TYPE_PACK_TRANSACTIONS_FOLDER);
  let directories: string[];
  try {
    directories = (await fs.readdir(transactionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    // Legacy collections may use a regular `.mdbase` file to disable the
    // cache. Such a collection cannot contain a transaction directory.
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }

  for (const directory of directories) {
    const transactionRoot = resolveInside(transactionsRoot, directory);
    const journalPath = resolveInside(transactionRoot, "journal.json");
    const journal = parseJournal(JSON.parse(await fs.readFile(journalPath, "utf8")));
    if (journal.transaction_id !== directory) {
      throw new Error(`Type-pack recovery journal identity mismatch in ${directory}.`);
    }
    if (journal.status === "committed" || journal.status === "rolled_back") {
      await fs.rm(transactionRoot, { recursive: true, force: true });
      continue;
    }
    await restoreTypePackTransaction(root, transactionRoot, journal);
    journal.status = "rolled_back";
    await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await fs.rm(transactionRoot, { recursive: true, force: true });
  }
}

export async function restoreTypePackTransaction(
  collectionRoot: string,
  transactionRoot: string,
  journal: TypePackTransactionJournal,
): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    const target = resolveInside(collectionRoot, entry.target);
    if (!entry.existed) {
      await fs.rm(target, { force: true });
      continue;
    }
    if (!entry.backup_path) {
      throw new Error(`Type-pack recovery has no backup for ${entry.target}.`);
    }
    const backup = await fs.readFile(resolveInside(transactionRoot, entry.backup_path));
    await atomicWrite(target, backup);
  }
}

export async function atomicWrite(target: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.mdbase-pack-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export function resolveInside(root: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(relativePath) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe type-pack path: ${JSON.stringify(relativePath)}.`);
  }
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, ...segments);
  if (!absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Type-pack path escapes the collection: ${JSON.stringify(relativePath)}.`);
  }
  return absolute;
}

function parseJournal(value: unknown): TypePackTransactionJournal {
  if (!isObject(value) || value.version !== 1 || typeof value.transaction_id !== "string") {
    throw new Error("Invalid type-pack recovery journal.");
  }
  if (!["prepared", "applying", "committed", "rolled_back"].includes(String(value.status))) {
    throw new Error("Invalid type-pack recovery status.");
  }
  if (!Array.isArray(value.entries)) {
    throw new Error("Invalid type-pack recovery entries.");
  }
  for (const entry of value.entries) {
    if (
      !isObject(entry) ||
      typeof entry.target !== "string" ||
      typeof entry.existed !== "boolean" ||
      (entry.before_digest !== undefined && typeof entry.before_digest !== "string") ||
      (entry.backup_path !== undefined && typeof entry.backup_path !== "string")
    ) {
      throw new Error("Invalid type-pack recovery entry.");
    }
  }
  return value as unknown as TypePackTransactionJournal;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
