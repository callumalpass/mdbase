import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  applyTypePack,
  assessTypePack,
  type TypePackProvision,
} from "../src/index.js";
import { frontmatterBounds, mergeSeedType, mergeValue } from "../src/type-packs/seed-upgrade.js";

// Published mdbase-contracts packs (dist/packs/mdbase.view at 7d3d31e):
// 1.0.0 seeds `_types/view.md` from types/view/1.md; 1.0.1 declares the
// view seed with `upgrade_from` pinned to that exact 1.0.0 starter.
const FIXTURES = path.join(import.meta.dirname, "fixtures/type-packs/mdbase.view");
const VIEW_TARGET = "_types/view.md";
const INSTALLER = "dev.example.tests";

async function loadPack(version: "1.0.0" | "1.0.1"): Promise<TypePackProvision> {
  const { manifest, resources } = JSON.parse(await fs.readFile(path.join(FIXTURES, `${version}.json`), "utf8"));
  return { manifest, resources };
}

function sha256(text: string | Buffer): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function viewDocument(pack: TypePackProvision): string {
  const source = pack.manifest.resources.find(({ target }) => target === VIEW_TARGET)!.source;
  return pack.resources.find((resource) => resource.source === source)!.document;
}

async function collection(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdbase-seed-upgrade-test-"));
  await fs.writeFile(path.join(root, "mdbase.yaml"), "spec_version: 0.3.0\nsettings:\n  validation: error\n");
  return root;
}

async function install(root: string, pack: TypePackProvision, options: { preserveSeedTargets?: string[] } = {}) {
  const assessment = await assessTypePack(root, pack, { installedBy: INSTALLER, ...options });
  expect(assessment.valid, JSON.stringify(assessment.diagnostics)).toBe(true);
  const applied = await applyTypePack(root, pack, {
    installedBy: INSTALLER,
    expectedAssessmentDigest: assessment.result.assessment_digest,
    ...options,
  });
  expect(applied.valid, JSON.stringify(applied.diagnostics)).toBe(true);
  return applied;
}

async function installedView(): Promise<{ root: string; previous: string; desired: string; upgrade: TypePackProvision }> {
  const root = await collection();
  const initial = await loadPack("1.0.0");
  await install(root, initial);
  const upgrade = await loadPack("1.0.1");
  return { root, previous: viewDocument(initial), desired: viewDocument(upgrade), upgrade };
}

const read = (root: string, target: string) => fs.readFile(path.join(root, target), "utf8");
const readLock = async (root: string) => JSON.parse(await read(root, "mdbase.lock.yaml"));
const viewDiff = (resources: Array<{ target: string }>) => resources.find(({ target }) => target === VIEW_TARGET);

describe("seed type-pack upgrades (upgrade_from)", () => {
  it("installs a pack that declares upgrade_from on a fresh collection", async () => {
    const root = await collection();
    const upgrade = await loadPack("1.0.1");
    expect(upgrade.manifest.resources[2]!.upgrade_from).toBeDefined();
    const applied = await install(root, upgrade);
    expect(applied.result.status).toBe("install");
    expect(viewDiff(applied.result.resources)).toMatchObject({ action: "create", mode: "seed" });
    expect(await read(root, VIEW_TARGET)).toBe(viewDocument(upgrade));
  });

  it("replaces an unedited previous starter with the exact desired bytes", async () => {
    const { root, previous, desired, upgrade } = await installedView();
    expect(await read(root, VIEW_TARGET)).toBe(previous);

    const assessment = await assessTypePack(root, upgrade, { installedBy: INSTALLER });
    expect(assessment.valid, JSON.stringify(assessment.diagnostics)).toBe(true);
    expect(assessment.result).toMatchObject({ status: "upgrade", applicable: true });
    expect(viewDiff(assessment.result.resources)).toEqual({
      kind: "type",
      mode: "seed",
      source: "types/view/2.md",
      target: VIEW_TARGET,
      action: "update",
      digest: sha256(desired),
      current_digest: sha256(previous),
      installed_digest: sha256(previous),
    });

    const applied = await applyTypePack(root, upgrade, {
      installedBy: INSTALLER,
      expectedAssessmentDigest: assessment.result.assessment_digest,
    });
    expect(applied.valid, JSON.stringify(applied.diagnostics)).toBe(true);
    expect(await read(root, VIEW_TARGET)).toBe(desired);
    const lock = await readLock(root);
    expect(lock.packs[0]).toMatchObject({ id: "mdbase.view", version: "1.0.1" });
    expect(viewDiff(lock.packs[0].resources)).toEqual({
      kind: "type", mode: "seed", source: "types/view/2.md", target: VIEW_TARGET, digest: sha256(desired),
    });

    const repeated = await assessTypePack(root, upgrade, { installedBy: INSTALLER });
    expect(repeated.result.status).toBe("current");
    expect(repeated.result.lock.action).toBe("unchanged");
    expect(viewDiff(repeated.result.resources)).toMatchObject({ action: "preserve", digest: sha256(desired) });
    const reapplied = await applyTypePack(root, upgrade, {
      installedBy: INSTALLER,
      expectedAssessmentDigest: repeated.result.assessment_digest,
    });
    expect(reapplied.valid).toBe(true);
    expect(await read(root, VIEW_TARGET)).toBe(desired);
  });

  it("preserves a seed that already holds the desired starter", async () => {
    const { root, desired, upgrade } = await installedView();
    await fs.writeFile(path.join(root, VIEW_TARGET), desired);
    const assessment = await assessTypePack(root, upgrade, { installedBy: INSTALLER });
    expect(assessment.result.status).toBe("upgrade");
    expect(viewDiff(assessment.result.resources)).toMatchObject({ action: "preserve", digest: sha256(desired) });
  });

  it("merges publisher changes into an edited seed and keeps customizations", async () => {
    const { root, previous, desired, upgrade } = await installedView();
    const edited = previous
      .replace("description: 'Saved views: shared query scope and stable named views'\n", "description: Our team views\nx-owner:\n  team: docs # ours\n")
      .concat("\nTeam notes stay here.\n");
    expect(edited).not.toBe(previous);
    await fs.writeFile(path.join(root, VIEW_TARGET), edited);

    const assessment = await assessTypePack(root, upgrade, { installedBy: INSTALLER });
    expect(assessment.valid, JSON.stringify(assessment.diagnostics)).toBe(true);
    expect(assessment.result.status).toBe("upgrade");
    const diff = viewDiff(assessment.result.resources)!;
    expect(diff).toMatchObject({ action: "update", current_digest: sha256(edited), installed_digest: sha256(previous) });
    expect(diff).not.toHaveProperty("reason");
    // The diff digest is the merged document; the lock still records the
    // publisher's desired starter digest.
    expect((diff as { digest: string }).digest).not.toBe(sha256(desired));
    expect(viewDiff(assessment.result.desired.resources)).toMatchObject({ digest: sha256(desired) });

    const applied = await applyTypePack(root, upgrade, {
      installedBy: INSTALLER,
      expectedAssessmentDigest: assessment.result.assessment_digest,
    });
    expect(applied.valid, JSON.stringify(applied.diagnostics)).toBe(true);
    const merged = await read(root, VIEW_TARGET);
    expect(sha256(merged)).toBe((diff as { digest: string }).digest);
    expect(merged.endsWith("Team notes stay here.\n")).toBe(true);
    const [start, end] = frontmatterBounds(merged);
    const value = parseYaml(merged.slice(start, end));
    const desiredValue = parseYaml(desired.slice(...frontmatterBounds(desired)));
    expect(value.description).toBe("Our team views");
    expect(value["x-owner"]).toEqual({ team: "docs" });
    expect(value.version).toBe(2);
    expect(value.schema).toEqual(desiredValue.schema);
    expect(value.implements).toEqual(desiredValue.implements);
    // Unchanged top-level nodes keep their exact source text.
    expect(merged).toContain("description: Our team views\nx-owner:\n  team: docs # ours\n");
    expect(viewDiff((await readLock(root)).packs[0].resources)).toMatchObject({ digest: sha256(desired) });

    const repeated = await assessTypePack(root, upgrade, { installedBy: INSTALLER });
    expect(repeated.result.status).toBe("current");
    expect(viewDiff(repeated.result.resources)).toMatchObject({ action: "preserve", digest: sha256(merged) });
  });

  it("reports competing customizations as conflicts and writes nothing", async () => {
    const { root, previous, upgrade } = await installedView();
    const cases: Array<[string, string]> = [
      [previous.replace("version: 1\n", "version: 7\n"), "/version"],
      [previous.replace("    - type\n    - id\n", "    - type\n    - custom\n    - id\n"), "/schema/value/required"],
      [previous.replace("name: view\n", "name: saved-view\n"), "Seed upgrade requires the same type name."],
    ];
    const lock = await read(root, "mdbase.lock.yaml");
    for (const [edited, expected] of cases) {
      expect(edited).not.toBe(previous);
      await fs.writeFile(path.join(root, VIEW_TARGET), edited);
      const assessment = await assessTypePack(root, upgrade, { installedBy: INSTALLER });
      expect(assessment.valid).toBe(true);
      expect(assessment.result).toMatchObject({ status: "conflict", applicable: false });
      const diff = viewDiff(assessment.result.resources) as { action: string; reason: string };
      expect(diff.action).toBe("conflict");
      expect(diff.reason).toContain(`${VIEW_TARGET}: `);
      expect(diff.reason).toContain(expected);
      const applied = await applyTypePack(root, upgrade, {
        installedBy: INSTALLER,
        expectedAssessmentDigest: assessment.result.assessment_digest,
      });
      expect(applied.valid).toBe(false);
      expect(applied.diagnostics[0]?.code).toBe("type_pack_conflict");
      expect(await read(root, VIEW_TARGET)).toBe(edited);
      expect(await read(root, "mdbase.lock.yaml")).toBe(lock);
    }
  });

  it("does not resurrect a user-deleted seed whose source was renamed", async () => {
    const { root, upgrade } = await installedView();
    await fs.rm(path.join(root, VIEW_TARGET));
    const applied = await install(root, upgrade);
    expect(applied.result.resources.filter(({ target }) => target === VIEW_TARGET)).toEqual([
      expect.objectContaining({ action: "preserve", source: "types/view/2.md" }),
    ]);
    await expect(fs.stat(path.join(root, VIEW_TARGET))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not upgrade an intentionally preserved seed target", async () => {
    const { root, previous, upgrade } = await installedView();
    const options = { installedBy: INSTALLER, preserveSeedTargets: [VIEW_TARGET] };
    const assessment = await assessTypePack(root, upgrade, options);
    expect(viewDiff(assessment.result.resources)).toMatchObject({ action: "preserve" });
    await install(root, upgrade, { preserveSeedTargets: [VIEW_TARGET] });
    expect(await read(root, VIEW_TARGET)).toBe(previous);
  });

  it("rejects upgrade_from outside seed types and baselines that do not match their digest", async () => {
    const base = await loadPack("1.0.1");
    const variants: Array<[string, (pack: TypePackProvision) => void, string]> = [
      ["managed type", (pack) => { pack.manifest.resources[2]!.mode = "managed"; }, "/resources/2/upgrade_from"],
      [
        "seed contract",
        (pack) => {
          pack.manifest.resources[1]!.mode = "seed";
          pack.manifest.resources[1]!.upgrade_from = pack.manifest.resources[2]!.upgrade_from;
        },
        "/resources/1/upgrade_from",
      ],
      ["tampered baseline", (pack) => { pack.manifest.resources[2]!.upgrade_from!.document = "tampered"; }, "digest-pinned"],
      ["malformed digest", (pack) => { pack.manifest.resources[2]!.upgrade_from!.digest = "sha256:nope"; }, "upgrade_from/digest"],
      [
        "unknown member",
        (pack) => {
          (pack.manifest.resources[2]!.upgrade_from as unknown as Record<string, unknown>).version = "1.0.0";
        },
        "must NOT have additional properties",
      ],
    ];
    for (const [label, mutate, expected] of variants) {
      const root = await collection();
      const pack: TypePackProvision = structuredClone(base);
      mutate(pack);
      const assessment = await assessTypePack(root, pack, { installedBy: INSTALLER });
      expect(assessment.valid, label).toBe(false);
      expect(assessment.diagnostics[0]?.code, label).toBe("invalid_type_pack");
      expect(assessment.diagnostics[0]?.message, label).toContain(expected);
      const applied = await applyTypePack(root, pack, { installedBy: INSTALLER, expectedAssessmentDigest: "sha256:0" });
      expect(applied.valid, label).toBe(false);
      await expect(fs.stat(path.join(root, VIEW_TARGET)), label).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(root, "mdbase.lock.yaml")), label).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

// Ports of the mdbase-rs `type_pack_seed_upgrade.rs` unit tests.
describe("seed type three-way merge", () => {
  const doc = (value: unknown) => `---\n${stringifyYaml(value)}---\nUser body.\n`;
  const baseType = () => ({
    kind: "mdbase.type",
    name: "task",
    version: 1,
    schema: { value: { properties: { status: { type: "string" } } } },
    implements: [{ contract: "example.task", version: "1.0.0", fields: { status: "status" } }],
  });
  const desiredType = () => {
    const value: any = baseType();
    value.version = 2;
    value.implements[0].version = "2.0.0";
    value.implements[0].fields.assignees = "assignees";
    value.schema.value.properties.assignees = { type: "array", items: { type: "string" } };
    return value;
  };

  it("preserves custom mappings, settings, and body and is idempotent", () => {
    const current: any = baseType();
    current.implements[0].fields.status = "state";
    delete current.schema.value.properties.status;
    current.schema.value.properties.state = { enum: ["todo", "done"] };
    current["x-owner"] = "custom";
    const merged = mergeSeedType(doc(baseType()), doc(current), doc(desiredType()));
    expect(merged.endsWith("---\nUser body.\n")).toBe(true);
    const value = parseYaml(merged.slice(...frontmatterBounds(merged)));
    expect(value.implements[0].fields.status).toBe("state");
    expect(value.implements[0].version).toBe("2.0.0");
    expect(value.implements[0].fields.assignees).toBe("assignees");
    expect(value.schema.value.properties.status).toBeUndefined();
    expect(value["x-owner"]).toBe("custom");
    expect(mergeSeedType(doc(baseType()), merged, doc(desiredType()))).toBe(merged);
  });

  it("does not overwrite a conflicting field addition", () => {
    const current: any = baseType();
    current.schema.value.properties.assignees = { type: "number" };
    expect(() => mergeSeedType(doc(baseType()), doc(current), doc(desiredType()))).toThrow("/assignees");
  });

  it("treats missing and null as distinct and keeps deletions", () => {
    expect(mergeValue(1, undefined, 1, "/x")).toBeUndefined();
    expect(() => mergeValue(undefined, null, 1, "/x")).toThrow("/x");
  });

  it("fails closed on ambiguous implementations and top-level removals", () => {
    const duplicated: any = baseType();
    duplicated.implements.push({ contract: "example.task", version: "0.9.0", fields: {} });
    expect(() => mergeSeedType(doc(baseType()), doc(duplicated), doc(desiredType())))
      .toThrow("Multiple versions of example.task require explicit mapping review.");

    const base: any = { ...baseType(), description: "old" };
    const current: any = { ...base, version: 3 };
    const desired: any = desiredType();
    expect(() => mergeSeedType(doc(base), doc(current), doc(desired))).toThrow("/version");
    const removed: any = { ...base, "x-owner": "me" };
    expect(() => mergeSeedType(doc(base), doc(removed), doc(desired)))
      .toThrow("Removing a top-level type setting requires manual review.");
  });
});
