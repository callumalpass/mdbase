import * as path from "node:path";

import { parseLink } from "../links/parser.js";
import { IndexedReadResult } from "./link-index.js";

export interface LinkResolutionIndex {
  fileSet: Set<string>;
  basenameToFiles: Map<string, string[]>;
  idToFiles: Map<string, string[]>;
}

export interface LinkResolutionResult {
  resolved: string | null;
  ambiguous?: boolean;
  wrongType?: boolean;
}

export interface LinkResolverOptions {
  idField?: string;
  recordExtensions: string[];
}

export interface ResolveLinkOptions {
  targetType?: string;
  fileCache?: Map<string, IndexedReadResult>;
  nonMarkdownFiles?: Set<string>;
  knownFileSet?: Set<string>;
  resolutionIndex?: LinkResolutionIndex;
}

/**
 * Resolves links against an already-scanned collection snapshot.
 *
 * Filesystem scanning and cache ownership deliberately remain outside this
 * class so one immutable snapshot can be shared across an entire query or
 * backlink pass.
 */
export class LinkResolver {
  private readonly idField?: string;
  private readonly extensions: string[];

  constructor(options: LinkResolverOptions) {
    this.idField = options.idField;
    const normalized = options.recordExtensions.map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
    this.extensions = normalized.includes(".md")
      ? [".md", ...normalized.filter((extension) => extension !== ".md")]
      : normalized;
  }

  buildIndex(
    files: string[],
    fileCache?: Map<string, IndexedReadResult>,
    fileSet?: Set<string>,
  ): LinkResolutionIndex {
    const basenameToFiles = new Map<string, string[]>();
    const idToFiles = new Map<string, string[]>();

    for (const filePath of files) {
      const basename = path.basename(filePath, path.extname(filePath));
      const existingByName = basenameToFiles.get(basename);
      if (existingByName) {
        existingByName.push(filePath);
      } else {
        basenameToFiles.set(basename, [filePath]);
      }

      if (!this.idField) continue;
      const idValue = fileCache?.get(filePath)?.frontmatter?.[this.idField];
      if (idValue === null || idValue === undefined) continue;
      const key = String(idValue);
      const existingById = idToFiles.get(key);
      if (existingById) {
        existingById.push(filePath);
      } else {
        idToFiles.set(key, [filePath]);
      }
    }

    return {
      fileSet: fileSet ?? new Set(files),
      basenameToFiles,
      idToFiles,
    };
  }

  resolve(
    linkValue: string,
    fromPath: string,
    files: string[],
    options: ResolveLinkOptions = {},
  ): LinkResolutionResult {
    let parsed;
    try {
      parsed = parseLink(linkValue);
    } catch {
      return { resolved: null };
    }

    const target = parsed?.target ?? linkValue;
    const format = parsed?.format ?? "wikilink";
    const isRelative = parsed?.is_relative ?? false;
    const fromDir = path.dirname(fromPath);
    const index = options.resolutionIndex ?? this.buildIndex(
      files,
      options.fileCache,
      options.knownFileSet,
    );
    const fileSet = options.knownFileSet ?? index.fileSet;
    const fileExists = (candidate: string): boolean =>
      fileSet.has(candidate) || options.nonMarkdownFiles?.has(candidate) === true;

    if (format === "markdown" || format === "path") {
      const candidate = target.startsWith("/")
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(fromDir, target));
      return this.resolvePathCandidate(
        candidate.replaceAll("\\", "/"),
        fileExists,
        options.targetType,
        options.fileCache,
      );
    }

    if (format === "wikilink") {
      if (isRelative) {
        const candidate = path.posix.normalize(path.posix.join(fromDir, target)).replaceAll("\\", "/");
        return this.resolvePathCandidate(
          candidate,
          fileExists,
          options.targetType,
          options.fileCache,
          (extended) => fileSet.has(extended),
        );
      }

      if (target.startsWith("/")) {
        return this.resolvePathCandidate(
          target.slice(1),
          fileExists,
          options.targetType,
          options.fileCache,
          (extended) => fileSet.has(extended),
        );
      }

      if (target.includes("/")) {
        return this.resolvePathCandidate(
          target,
          fileExists,
          options.targetType,
          options.fileCache,
        );
      }
    }

    return this.resolveSimpleName(
      target,
      fromPath,
      files,
      options.targetType,
      options.fileCache,
      index,
    );
  }

  private resolvePathCandidate(
    candidate: string,
    fileExists: (candidate: string) => boolean,
    targetType?: string,
    fileCache?: Map<string, IndexedReadResult>,
    extensionExists: (candidate: string) => boolean = fileExists,
  ): LinkResolutionResult {
    if (fileExists(candidate)) {
      return this.checkTargetType(candidate, targetType, fileCache);
    }

    for (const extension of this.extensions) {
      const extended = candidate + extension;
      if (extensionExists(extended)) {
        return this.checkTargetType(extended, targetType, fileCache);
      }
    }
    return { resolved: null };
  }

  private resolveSimpleName(
    name: string,
    fromPath: string,
    files: string[],
    targetType: string | undefined,
    fileCache: Map<string, IndexedReadResult> | undefined,
    index: LinkResolutionIndex,
  ): LinkResolutionResult {
    const scopeSet = targetType
      ? new Set(files.filter((filePath) => fileCache?.get(filePath)?.types?.includes(targetType)))
      : undefined;
    const idCandidates = this.idField ? index.idToFiles.get(name) ?? [] : [];
    const idMatches = scopeSet
      ? idCandidates.filter((filePath) => scopeSet.has(filePath))
      : idCandidates;

    if (idMatches.length === 1) {
      return this.checkTargetType(idMatches[0], targetType, fileCache);
    }
    if (idMatches.length > 1) {
      return { resolved: null, ambiguous: true };
    }

    const basenameCandidates = index.basenameToFiles.get(name) ?? [];
    const filenameMatches = scopeSet
      ? basenameCandidates.filter((filePath) => scopeSet.has(filePath))
      : basenameCandidates;

    if (filenameMatches.length === 0) {
      if (targetType && (basenameCandidates.length > 0 || idCandidates.length > 0)) {
        return { resolved: null, wrongType: true };
      }
      return { resolved: null };
    }

    if (filenameMatches.length === 1) {
      return this.checkTargetType(filenameMatches[0], targetType, fileCache);
    }

    const fromDir = path.dirname(fromPath);
    const sameDirectory = filenameMatches.filter((filePath) => path.dirname(filePath) === fromDir);
    if (sameDirectory.length === 1) {
      return this.checkTargetType(sameDirectory[0], targetType, fileCache);
    }

    const sorted = [...filenameMatches].sort((left, right) => {
      const depthDifference = left.split("/").length - right.split("/").length;
      return depthDifference || left.localeCompare(right);
    });
    const shortestDepth = sorted[0].split("/").length;
    const shortestPaths = sorted.filter((filePath) => filePath.split("/").length === shortestDepth);
    if (shortestPaths.length > 1) {
      return this.checkTargetType(shortestPaths.sort()[0], targetType, fileCache);
    }
    return this.checkTargetType(sorted[0], targetType, fileCache);
  }

  private checkTargetType(
    resolvedPath: string,
    targetType?: string,
    fileCache?: Map<string, IndexedReadResult>,
  ): LinkResolutionResult {
    if (!targetType) return { resolved: resolvedPath };
    const types = fileCache?.get(resolvedPath)?.types;
    return types?.includes(targetType)
      ? { resolved: resolvedPath }
      : { resolved: resolvedPath, wrongType: true };
  }
}
