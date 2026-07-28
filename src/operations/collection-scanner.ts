import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";

export interface CollectionScannerOptions {
  root: string;
  exclude: string[];
  recordExtensions: string[];
  includeSubfolders: boolean;
  typesFolder: string;
  contractsFolder: string;
  cacheFolder: string;
  migrationsFolder: string;
}

/** Filesystem traversal and collection-boundary policy for a collection. */
export class CollectionScanner {
  private readonly root: string;
  private readonly includeSubfolders: boolean;
  private readonly recordExtensions: Set<string>;
  private readonly reservedFolders: string[];
  private readonly excludeMatchers: Array<(candidate: string) => boolean>;

  constructor(options: CollectionScannerOptions) {
    this.root = options.root;
    this.includeSubfolders = options.includeSubfolders;
    this.recordExtensions = new Set(options.recordExtensions);
    this.reservedFolders = [
      options.typesFolder,
      options.contractsFolder,
      options.cacheFolder,
      options.migrationsFolder,
    ];
    this.excludeMatchers = options.exclude.flatMap((pattern) => {
      if (!pattern.includes("/") && !pattern.includes("*") && !pattern.includes("?")) {
        return [
          picomatch(pattern, { dot: true }),
          picomatch(`${pattern}/**`, { dot: true }),
        ];
      }
      if (!pattern.includes("/")) {
        return [picomatch(pattern, { dot: true, matchBase: true })];
      }
      return [picomatch(pattern, { dot: true })];
    });
  }

  isExcluded(relativePath: string): boolean {
    if (this.excludeMatchers.some((matcher) => matcher(relativePath))) return true;
    return this.reservedFolders.some((folder) =>
      relativePath === folder || relativePath.startsWith(`${folder}/`),
    );
  }

  isRecordFile(filePath: string): boolean {
    return this.recordExtensions.has(path.extname(filePath).slice(1));
  }

  nonRecordFiles(allFiles: string[]): Set<string> {
    return new Set(allFiles.filter((filePath) => !this.isRecordFile(filePath)));
  }

  async scanRecordFiles(directory = this.root): Promise<string[]> {
    return await this.scan(directory, true);
  }

  async scanAllFiles(directory = this.root): Promise<string[]> {
    return await this.scan(directory, false);
  }

  async scanTypeFiles(typesFolder: string, migrationsFolder: string): Promise<string[]> {
    const typesRoot = path.join(this.root, typesFolder);
    const migrationsRoot = path.resolve(this.root, migrationsFolder);
    const files: string[] = [];

    const walk = async (directory: string): Promise<void> => {
      const entries = await this.readDirectory(directory);
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        const resolved = path.resolve(fullPath);
        if (resolved === migrationsRoot || resolved.startsWith(migrationsRoot + path.sep)) continue;
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && path.extname(entry.name) === ".md") {
          files.push(this.relativePath(fullPath));
        }
      }
    };

    await walk(typesRoot);
    return files;
  }

  private async scan(directory: string, recordsOnly: boolean): Promise<string[]> {
    const files: string[] = [];
    const entries = await this.readDirectory(directory);

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = this.relativePath(fullPath);
      if (this.isExcluded(relativePath)) continue;

      if (entry.isDirectory()) {
        if (await this.isNestedCollection(fullPath)) continue;
        if (this.includeSubfolders) {
          files.push(...await this.scan(fullPath, recordsOnly));
        }
      } else if (entry.name !== "mdbase.yaml" && (!recordsOnly || this.isRecordFile(entry.name))) {
        files.push(relativePath);
      }
    }
    return files;
  }

  private async readDirectory(directory: string): Promise<fs.Dirent[]> {
    try {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      return entries.sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return [];
    }
  }

  private async isNestedCollection(directory: string): Promise<boolean> {
    if (path.resolve(directory) === path.resolve(this.root)) return false;
    try {
      await fs.promises.access(path.join(directory, "mdbase.yaml"));
      return true;
    } catch {
      return false;
    }
  }

  private relativePath(fullPath: string): string {
    return path.relative(this.root, fullPath).replaceAll("\\", "/");
  }
}
