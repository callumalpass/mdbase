import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  MdbaseLogEvent,
  OperationObserver,
} from "../src/observability.js";
import { Collection } from "../src/operations/collection.js";

function deterministicRuntime(times: number[]) {
  let index = 0;
  return {
    now: () => times[index++],
    timestamp: () => "2026-07-22T00:00:00.000Z",
  };
}

describe("OperationObserver", () => {
  it("has a zero-logging disabled path", async () => {
    const events: MdbaseLogEvent[] = [];
    const observer = new OperationObserver({ logger: (event) => events.push(event) });

    await expect(observer.trace("read", { path: "a.md" }, async () => 42)).resolves.toBe(42);
    expect(events).toEqual([]);
  });

  it("emits structured performance events at the configured threshold", async () => {
    const events: MdbaseLogEvent[] = [];
    const observer = new OperationObserver(
      { performance: { threshold_ms: 5 }, logger: (event) => events.push(event) },
      deterministicRuntime([10, 17]),
    );

    await observer.trace("collection.read", { path: "a.md", empty: undefined }, async () => true);

    expect(events).toEqual([{
      kind: "performance",
      timestamp: "2026-07-22T00:00:00.000Z",
      operation: "collection.read",
      attributes: { path: "a.md" },
      duration_ms: 7,
      outcome: "success",
    }]);
  });

  it("logs returned operation failures without changing their value", async () => {
    const events: MdbaseLogEvent[] = [];
    const observer = new OperationObserver(
      { errors: true, logger: (event) => events.push(event) },
      deterministicRuntime([0, 1]),
    );
    const failure = { error: { code: "file_not_found", message: "Missing" } };

    await expect(observer.trace("collection.read", { path: "missing.md" }, async () => failure))
      .resolves.toBe(failure);
    expect(events).toMatchObject([{
      kind: "error",
      operation: "collection.read",
      error: { code: "file_not_found", message: "Missing" },
    }]);
  });

  it("logs and rethrows unexpected errors, omitting stacks by default", async () => {
    const events: MdbaseLogEvent[] = [];
    const observer = new OperationObserver(
      { errors: true, logger: (event) => events.push(event) },
      deterministicRuntime([0, 1]),
    );

    await expect(observer.trace("collection.query", {}, async () => {
      throw new TypeError("bad query");
    })).rejects.toThrow("bad query");
    expect(events).toMatchObject([{
      kind: "error",
      error: { name: "TypeError", message: "bad query" },
    }]);
    expect(events[0].kind === "error" && events[0].error.stack).toBeUndefined();
  });

  it("suppresses nested events unless explicitly enabled", async () => {
    const events: MdbaseLogEvent[] = [];
    const observer = new OperationObserver(
      { performance: true, logger: (event) => events.push(event) },
      deterministicRuntime([0, 10]),
    );

    await observer.trace("collection.query", {}, async () => {
      await observer.trace("collection.read", { path: "a.md" }, async () => undefined);
    });

    expect(events.map((event) => event.operation)).toEqual(["collection.query"]);
  });

  it("does not suppress operations owned by an independent observer", async () => {
    const events: MdbaseLogEvent[] = [];
    const runtime = deterministicRuntime([0, 5, 10, 20]);
    const outer = new OperationObserver(
      { performance: true, logger: (event) => events.push(event) },
      runtime,
    );
    const independent = new OperationObserver(
      { performance: true, logger: (event) => events.push(event) },
      runtime,
    );

    await outer.trace("outer", {}, async () => {
      await independent.trace("independent", {}, async () => undefined);
    });

    expect(events.map((event) => event.operation).sort()).toEqual(["independent", "outer"]);
  });

  it("isolates collection behavior from logger failures", async () => {
    const observer = new OperationObserver({
      performance: true,
      logger: () => {
        throw new Error("logger unavailable");
      },
    });

    await expect(observer.trace("collection.read", {}, async () => "ok")).resolves.toBe("ok");
  });

  it("observes real collection operations while suppressing internal reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-observability-"));
    await fs.writeFile(path.join(root, "mdbase.yaml"), 'spec_version: "0.3.0"\n', "utf8");
    await fs.writeFile(path.join(root, "a.md"), "---\ntitle: A\n---\n", "utf8");
    const events: MdbaseLogEvent[] = [];
    const options = {
      observability: {
        performance: true,
        errors: true,
        logger: (event: MdbaseLogEvent) => events.push(event),
      },
    };

    const opened = await Collection.open(root, options);
    expect(opened.error).toBeUndefined();
    const collection = opened.collection!;
    await collection.queryCanonical({ where: 'title == "A"' });
    await collection.read("missing.md");
    await collection.close();

    expect(events.filter((event) => event.kind === "performance").map((event) => event.operation)).toEqual([
      "collection.open",
      "collection.query_canonical",
      "collection.read",
      "collection.close",
    ]);
    expect(events.filter((event) => event.kind === "error")).toMatchObject([{
      operation: "collection.read",
      error: { code: "file_not_found" },
    }]);
  });
});
