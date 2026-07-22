import * as path from "node:path";

import { BacklinkEntry } from "../expressions/evaluator.js";
import { extractBodyLinks } from "../links/parser.js";
import { TypeDefinition } from "../types/loader.js";

export interface IndexedReadResult {
  frontmatter?: Record<string, unknown>;
  rawFrontmatter?: Record<string, unknown>;
  types?: string[];
  body?: string | null;
  file?: Record<string, unknown>;
  revision?: string;
  error?: { code: string; message: string };
}

export interface LinkResolutionResult {
  resolved: string | null;
}

export interface LinkIndexBuildParams {
  files: string[];
  fileCache: Map<string, IndexedReadResult>;
  typeDefs: Map<string, TypeDefinition>;
  resolveLink: (linkValue: string, fromPath: string) => LinkResolutionResult;
}

export interface LinkIndex {
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, Set<string>>;
  backlinksFor: (targetPath: string) => BacklinkEntry[];
}

export function buildLinkIndex(params: LinkIndexBuildParams): LinkIndex {
  const { files, fileCache, typeDefs, resolveLink } = params;
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const sourcePath of files) {
    const readResult = fileCache.get(sourcePath);
    if (!readResult || readResult.error) continue;

    const frontmatter = readResult.frontmatter ?? {};
    const types = readResult.types ?? [];
    const body = readResult.body ?? "";
    const linkValues: string[] = [];

    for (const typeName of types) {
      const typeDef = typeDefs.get(typeName);
      if (!typeDef?.fields) continue;
      for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
        const value = frontmatter[fieldName];
        if (value === null || value === undefined) continue;
        if (fieldDef.type === "link" && typeof value === "string") {
          linkValues.push(value);
        } else if (fieldDef.type === "list" && fieldDef.items?.type === "link" && Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string") {
              linkValues.push(item);
            }
          }
        }
      }
    }

    const bodyLinks = extractBodyLinks(body);
    for (const bodyLink of bodyLinks) {
      linkValues.push(bodyLink.raw);
    }

    const resolvedTargets = new Set<string>();
    for (const linkValue of linkValues) {
      const resolution = resolveLink(linkValue, sourcePath);
      if (!resolution.resolved) continue;

      const targetPath = resolution.resolved;
      resolvedTargets.add(targetPath);

      if (targetPath === sourcePath) continue;
      let sources = incoming.get(targetPath);
      if (!sources) {
        sources = new Set<string>();
        incoming.set(targetPath, sources);
      }
      sources.add(sourcePath);
    }

    outgoing.set(sourcePath, resolvedTargets);
  }

  const backlinksFor = (targetPath: string): BacklinkEntry[] => {
    const sources = incoming.get(targetPath);
    if (!sources) return [];

    const backlinks: BacklinkEntry[] = [];
    for (const sourcePath of sources) {
      const name = sourcePath.split("/").pop() ?? "";
      backlinks.push({
        file: {
          path: sourcePath,
          name,
          basename: name.replace(/\.[^.]+$/, ""),
          folder: path.dirname(sourcePath) === "." ? "" : path.dirname(sourcePath),
          extension: path.extname(sourcePath).slice(1),
        },
      });
    }
    return backlinks;
  };

  return { outgoing, incoming, backlinksFor };
}
