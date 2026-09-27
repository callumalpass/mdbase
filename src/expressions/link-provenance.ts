/**
 * Link provenance for CEL link helpers (spec Chapter 10): a link value
 * resolves relative to the record it was read from. Link values are plain
 * strings, so the source is recovered statically: a value read from `this`
 * resolves relative to the context record, and a value read from an
 * `asFile()` result resolves relative to that target record. Values read from
 * the candidate need no change.
 *
 * The rewrite passes the source path explicitly, as `link.asFile(sourcePath)`
 * and `file.hasLink(link, sourcePath)`. An `asFile()` result that supplies
 * another link is bound once through a single-element comprehension,
 * `[target].map(r, ...)[0]`, so it is not traversed twice.
 */

export interface CelNode {
  op: string;
  args: unknown;
  [key: string]: unknown;
}

type Source = { kind: "record"; node: CelNode } | { kind: "asFile"; node: CelNode } | null;

const COMPREHENSIONS = new Set(["all", "exists", "exists_one", "map", "filter"]);
const PASS_THROUGH = new Set(["orValue", "value", "or"]);

/**
 * Rewrite link helpers whose link comes from a record other than the
 * candidate. Returns null when the expression needs no change.
 */
export function rewriteLinkProvenance(root: CelNode): CelNode | null {
  let changed = false;
  let fresh = 0;
  const variable = () => `__mdbase_record_${fresh++}`;

  const rewrite = (node: unknown, env: Map<string, Source>): unknown => {
    if (Array.isArray(node)) return node.map((child) => rewrite(child, env));
    if (!isNode(node)) return node;

    if (node.op === "rcall") {
      const [name, receiver, args] = node.args as [string, CelNode, CelNode[]];
      if (name === "asFile" && args.length === 0) {
        const source = sourceOf(receiver, env);
        if (source?.kind === "asFile") {
          changed = true;
          return bindTarget(source.node, node, env);
        }
        if (source?.kind === "record") {
          changed = true;
          return rcall("asFile", rewrite(receiver, env) as CelNode, [pathOf(source.node)]);
        }
      }
      if (name === "hasLink" && args.length === 1) {
        const source = sourceOf(args[0], env);
        if (source?.kind === "asFile") {
          changed = true;
          return bindTarget(source.node, node, env);
        }
        if (source?.kind === "record") {
          changed = true;
          return rcall("hasLink", rewrite(receiver, env) as CelNode, [
            rewrite(args[0], env) as CelNode,
            pathOf(source.node),
          ]);
        }
      }
      if (COMPREHENSIONS.has(name) && isNode(args[0]) && args[0].op === "id") {
        const source = sourceOf(receiver, env);
        if (source?.kind === "asFile") {
          changed = true;
          return bindTarget(source.node, node, env);
        }
        const scoped = new Map(env);
        const variables = [args[0], ...(args.length === 3 && isNode(args[1]) && args[1].op === "id" && name !== "map" ? [args[1]] : [])];
        for (const bound of variables) scoped.set(bound.args as string, source);
        return {
          ...node,
          args: [
            name,
            rewrite(receiver, env),
            args.map((arg, index) => (index < variables.length ? arg : rewrite(arg, scoped))),
          ],
        };
      }
    }

    return { ...node, args: rewrite(node.args, env) };
  };

  /**
   * Replace `target` inside `node` with a fresh variable bound to it once:
   * `[target].map(r, node[target := r])[0]`.
   */
  const bindTarget = (target: CelNode, node: CelNode, env: Map<string, Source>): CelNode => {
    const name = variable();
    const bound: CelNode = { op: "id", args: name };
    const scoped = new Map(env);
    scoped.set(name, { kind: "record", node: bound });
    const body = rewrite(replace(node, target, bound), scoped) as CelNode;
    return {
      op: "[]",
      args: [
        rcall("map", { op: "list", args: [rewrite(target, env) as CelNode] }, [bound, body]),
        { op: "value", args: 0n },
      ],
    };
  };

  const rewritten = rewrite(root, new Map()) as CelNode;
  return changed ? rewritten : null;
}

/** The record an expression's value was read from, or null for the candidate. */
function sourceOf(node: unknown, env: Map<string, Source>): Source {
  if (!isNode(node)) return null;
  switch (node.op) {
    case "id":
      if (node.args === "this") return { kind: "record", node };
      return env.get(node.args as string) ?? null;
    case ".":
    case ".?":
    case "[]":
    case "[?]":
      return sourceOf((node.args as unknown[])[0], env);
    case "rcall": {
      const [name, receiver] = node.args as [string, CelNode];
      if (name === "asFile") return { kind: "asFile", node };
      return PASS_THROUGH.has(name) ? sourceOf(receiver, env) : null;
    }
    case "call": {
      const [name, args] = node.args as [string, unknown[]];
      return name === "link" && args.length === 1 ? sourceOf(args[0], env) : null;
    }
    default:
      return null;
  }
}

function pathOf(record: CelNode): CelNode {
  return { op: ".", args: [{ op: ".", args: [record, "file"] }, "path"] };
}

function rcall(name: string, receiver: CelNode, args: CelNode[]): CelNode {
  return { op: "rcall", args: [name, receiver, args] };
}

function replace(node: unknown, target: CelNode, replacement: CelNode): unknown {
  if (node === target) return replacement;
  if (Array.isArray(node)) return node.map((child) => replace(child, target, replacement));
  if (!isNode(node)) return node;
  return { ...node, args: replace(node.args, target, replacement) };
}

function isNode(value: unknown): value is CelNode {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as CelNode).op === "string";
}
