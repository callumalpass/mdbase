export interface BacklinkTokenIndex {
  tokenToSources: Map<string, Set<string>>;
  sourceToTokens: Map<string, Set<string>>;
}

export interface RuntimeCacheInvalidation {
  fileLists?: boolean;
  fileCache?: boolean;
  nonMarkdown?: boolean;
  backlinks?: boolean;
}

/**
 * Owns the in-memory collection indexes and their invalidation relationships.
 * Disk-backed cache lifetime remains the responsibility of CacheStoreAsync.
 */
export class CollectionRuntimeCache<TRead> {
  private files: string[] | undefined;
  private allFiles: string[] | undefined;
  private nonMarkdownFiles: Set<string> | undefined;
  private nonMarkdownSource: string[] | undefined;
  private fileCache: Map<string, TRead> | undefined;
  private fileCacheSource: string[] | undefined;
  private backlinkTokens: BacklinkTokenIndex | undefined;

  invalidate(options: RuntimeCacheInvalidation = {}): void {
    if (options.fileLists ?? true) {
      this.files = undefined;
      this.allFiles = undefined;
    }
    if (options.fileCache ?? true) {
      this.fileCache = undefined;
      this.fileCacheSource = undefined;
    }
    if (options.nonMarkdown ?? true) {
      this.nonMarkdownFiles = undefined;
      this.nonMarkdownSource = undefined;
    }
    if (options.backlinks ?? true) {
      this.backlinkTokens = undefined;
    }
  }

  getFiles(): string[] | undefined {
    return this.files;
  }

  setFiles(files: string[]): string[] {
    this.files = files;
    return files;
  }

  getAllFiles(): string[] | undefined {
    return this.allFiles;
  }

  setAllFiles(files: string[]): string[] {
    this.allFiles = files;
    return files;
  }

  getFileCache(files: string[]): Map<string, TRead> | undefined {
    return this.fileCache && samePaths(files, this.fileCacheSource)
      ? this.fileCache
      : undefined;
  }

  setFileCache(files: string[], cache: Map<string, TRead>): Map<string, TRead> {
    this.fileCacheSource = [...files];
    this.fileCache = cache;
    return cache;
  }

  updateFile(path: string, value: TRead): void {
    if (this.fileCache?.has(path)) this.fileCache.set(path, value);
  }

  getNonMarkdownFiles(files: string[]): Set<string> | undefined {
    return this.nonMarkdownFiles && samePaths(files, this.nonMarkdownSource)
      ? this.nonMarkdownFiles
      : undefined;
  }

  setNonMarkdownFiles(files: string[], values: Set<string>): Set<string> {
    this.nonMarkdownSource = [...files];
    this.nonMarkdownFiles = values;
    return values;
  }

  getBacklinkTokens(): BacklinkTokenIndex | undefined {
    return this.backlinkTokens;
  }

  setBacklinkTokens(index: BacklinkTokenIndex): BacklinkTokenIndex {
    this.backlinkTokens = index;
    return index;
  }

  removeBacklinkSource(sourcePath: string): void {
    const index = this.backlinkTokens;
    if (!index) return;
    const tokens = index.sourceToTokens.get(sourcePath);
    if (!tokens) return;

    for (const token of tokens) {
      const sources = index.tokenToSources.get(token);
      if (!sources) continue;
      sources.delete(sourcePath);
      if (sources.size === 0) index.tokenToSources.delete(token);
    }
    index.sourceToTokens.delete(sourcePath);
  }
}

function samePaths(left: string[], right: string[] | undefined): boolean {
  if (!right || left.length !== right.length) return false;
  if (left === right) return true;
  return left.every((value, index) => value === right[index]);
}
