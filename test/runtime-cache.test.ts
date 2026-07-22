import { describe, expect, it } from "vitest";

import { CollectionRuntimeCache } from "../src/operations/runtime-cache.js";

describe("CollectionRuntimeCache", () => {
  it("keys derived caches by their ordered source paths", () => {
    const cache = new CollectionRuntimeCache<{ title: string }>();
    const reads = new Map([["a.md", { title: "A" }]]);
    cache.setFileCache(["a.md"], reads);

    expect(cache.getFileCache(["a.md"])).toBe(reads);
    expect(cache.getFileCache(["b.md"])).toBeUndefined();
    expect(cache.getFileCache(["a.md", "b.md"])).toBeUndefined();
  });

  it("supports precise invalidation after content-only mutations", () => {
    const cache = new CollectionRuntimeCache<object>();
    const files = cache.setFiles(["a.md"]);
    const allFiles = cache.setAllFiles(["a.md", "image.png"]);
    const nonMarkdown = cache.setNonMarkdownFiles(allFiles, new Set(["image.png"]));
    cache.setFileCache(files, new Map([["a.md", {}]]));
    cache.setBacklinkTokens({
      tokenToSources: new Map([["target", new Set(["a.md"])]]),
      sourceToTokens: new Map([["a.md", new Set(["target"])]]),
    });

    cache.invalidate({ fileLists: false, nonMarkdown: false });

    expect(cache.getFiles()).toBe(files);
    expect(cache.getAllFiles()).toBe(allFiles);
    expect(cache.getNonMarkdownFiles(allFiles)).toBe(nonMarkdown);
    expect(cache.getFileCache(files)).toBeUndefined();
    expect(cache.getBacklinkTokens()).toBeUndefined();
  });

  it("updates an existing cached record without discarding the collection index", () => {
    const cache = new CollectionRuntimeCache<{ title: string }>();
    cache.setFileCache(["a.md"], new Map([["a.md", { title: "old" }]]));

    cache.updateFile("a.md", { title: "new" });

    expect(cache.getFileCache(["a.md"])?.get("a.md")).toEqual({ title: "new" });
  });

  it("removes a backlink source from both sides of the token index", () => {
    const cache = new CollectionRuntimeCache<object>();
    cache.setBacklinkTokens({
      tokenToSources: new Map([
        ["shared", new Set(["a.md", "b.md"])],
        ["only-a", new Set(["a.md"])],
      ]),
      sourceToTokens: new Map([
        ["a.md", new Set(["shared", "only-a"])],
        ["b.md", new Set(["shared"])],
      ]),
    });

    cache.removeBacklinkSource("a.md");

    const index = cache.getBacklinkTokens()!;
    expect(index.sourceToTokens.has("a.md")).toBe(false);
    expect(index.tokenToSources.get("shared")).toEqual(new Set(["b.md"]));
    expect(index.tokenToSources.has("only-a")).toBe(false);
  });
});
