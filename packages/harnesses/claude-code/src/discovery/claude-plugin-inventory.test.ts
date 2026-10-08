import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { HarnessDirectoryInspection } from "@agentscope/harnesses-core";

import {
  readClaudePluginManifest,
  readClaudePluginSettingsLayer,
  selectClaudePluginCacheRecord,
  selectClaudePluginLoadingPath,
} from "./claude-plugin-inventory.js";

describe("native ordered cache-record election from Core inspections", () => {
  const inspection = (
    directoryPath: string,
    entries: readonly string[],
    exists = true,
  ): HarnessDirectoryInspection =>
    Object.freeze({
      directoryPath,
      entries,
      exists,
      mode: exists ? 0o755 : null,
    });
  const paths = ["/cache/first", "/cache/second", "/cache/third"];

  it("keeps empty and singleton applicability independent of nonempty election", () => {
    expect(selectClaudePluginCacheRecord([], [])).toBeUndefined();
    expect(selectClaudePluginCacheRecord([paths[0]!], [])).toBe(0);
  });

  it("ignores exactly the vendor marker set, not ordinary hidden content", () => {
    const markers = [
      "node_modules",
      ".orphaned_at",
      ".in_use",
      ".links_materialized",
    ];
    expect(
      selectClaudePluginCacheRecord(paths, [
        inspection(paths[0]!, markers),
        inspection(paths[1]!, [".ordinary"]),
        inspection(paths[2]!, ["hooks"]),
      ]),
    ).toBe(1);
  });

  it("uses registry order rather than inspection order and retains first fallback", () => {
    expect(
      selectClaudePluginCacheRecord(paths, [
        inspection(paths[2]!, ["skills"]),
        inspection(paths[1]!, ["commands"]),
        inspection(paths[0]!, [], false),
      ]),
    ).toBe(1);
    expect(
      selectClaudePluginCacheRecord(
        paths,
        paths.map((path) => inspection(path, [])),
      ),
    ).toBe(0);
  });

  it("rejects incomplete, duplicate, or non-directory election observations", () => {
    const first = inspection(paths[0]!, ["node_modules"]);
    expect(() => selectClaudePluginCacheRecord(paths, [first])).toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    expect(() => selectClaudePluginCacheRecord(paths, [first, first])).toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    expect(() =>
      selectClaudePluginCacheRecord([paths[0]!, "/cache/packed.zip"], [first]),
    ).toThrow("cli.harness.plugin-inventory-unavailable");
  });
  it("does not inspect records after the first nonempty cache", () => {
    expect(
      selectClaudePluginCacheRecord(paths, [inspection(paths[0]!, ["skills"])]),
    ).toBe(0);
  });
  it("re-elects cache-before-seed loading from fresh Core observations", () => {
    const cache = "/cache/recorded",
      first = "/seed/first",
      second = "/seed/second";
    const observed = [
      inspection(cache, ["node_modules"]),
      inspection(first, [], false),
      inspection(second, ["hooks"]),
    ];
    expect(
      selectClaudePluginLoadingPath([cache, first, second], observed),
    ).toBe(second);
    expect(() =>
      selectClaudePluginLoadingPath(
        [cache, first, second],
        observed.slice(0, 1),
      ),
    ).toThrow("plugin-inventory-unavailable");
    expect(
      selectClaudePluginLoadingPath(
        [cache, first, second],
        [inspection(cache, ["new-content"])],
      ),
    ).toBe(cache);
    expect(
      selectClaudePluginLoadingPath([cache], [inspection(cache, [])]),
    ).toBeUndefined();
    expect(() =>
      selectClaudePluginLoadingPath([cache], [observed[0]!, observed[0]!]),
    ).toThrow("plugin-inventory-unavailable");
  });
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("plugin manifest metadata stays observed rather than fabricated", () => {
  it("keeps missing manifest and missing version distinct from metadata", async () => {
    const value = await fixture();
    const absent = await readClaudePluginManifest(capabilities, value.root);
    expect(absent).toMatchObject({
      guard: { exists: false },
      manifestName: null,
      manifestVersion: null,
      hasDeclaredHooks: false,
      hooksDeclarationJson: null,
    });
    await mkdir(join(value.root, ".claude-plugin"));
    await writeFile(
      join(value.root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ordinary", unrelated: "SECRET-CANARY" }),
    );
    const present = await readClaudePluginManifest(capabilities, value.root);
    expect(present).toMatchObject({
      guard: { exists: true },
      manifestName: "ordinary",
      manifestVersion: null,
      hasDeclaredHooks: false,
      hooksDeclarationJson: null,
    });
    expect(JSON.stringify(present)).not.toContain("SECRET-CANARY");
    expect(Object.isFrozen(present)).toBe(true);
  });

  it("does not mistake a custom or inline hooks declaration for no hooks", async () => {
    const value = await fixture();
    await mkdir(join(value.root, ".claude-plugin"));
    const path = join(value.root, ".claude-plugin", "plugin.json");
    for (const hooks of ["./custom.json", { hooks: {} }, [], null]) {
      await writeFile(
        path,
        JSON.stringify({ name: "ordinary", version: "1.0.0", hooks }),
      );
      expect(
        await readClaudePluginManifest(capabilities, value.root),
      ).toMatchObject({
        manifestName: "ordinary",
        manifestVersion: "1.0.0",
        hasDeclaredHooks: true,
        hooksDeclarationJson: JSON.stringify(hooks),
      });
    }
  });

  it("preserves an observed empty version and the exact ASCII-space name rule", async () => {
    const value = await fixture();
    await mkdir(join(value.root, ".claude-plugin"));
    const path = join(value.root, ".claude-plugin", "plugin.json");
    await writeFile(path, JSON.stringify({ name: "tab\tname", version: "" }));
    expect(
      await readClaudePluginManifest(capabilities, value.root),
    ).toMatchObject({
      manifestName: "tab\tname",
      manifestVersion: "",
    });
  });

  it.each([
    null,
    [],
    {},
    { name: 7 },
    { name: "" },
    { name: "ascii space" },
    { name: "ordinary", version: null },
  ])("refuses malformed present metadata", async (manifest) => {
    const value = await fixture();
    await mkdir(join(value.root, ".claude-plugin"));
    await writeFile(
      join(value.root, ".claude-plugin", "plugin.json"),
      JSON.stringify(manifest),
    );
    await expect(
      readClaudePluginManifest(capabilities, value.root),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
  });
});

describe("scoped settings observations for the existing plugin inventory", () => {
  it("projects only bounded plugin selections, not unrelated settings content", async () => {
    const value = await fixture();
    const bytes = Buffer.from(
      JSON.stringify({
        enabledPlugins: { "ordinary@market": true, "disabled@market": false },
        unrelated: "SECRET-CANARY",
      }),
    );
    await writeFile(value.path, bytes);
    const observed = await readClaudePluginSettingsLayer(
      capabilities,
      value.path,
      "project",
    );
    expect(observed.layer).toEqual({
      scope: "project",
      targetPath: value.path,
      targetDigest: hash(bytes),
      targetExists: true,
      enabledPlugins: { "ordinary@market": true, "disabled@market": false },
    });
    expect(JSON.stringify(observed)).not.toContain("SECRET-CANARY");
    expect(Object.isFrozen(observed.layer.enabledPlugins)).toBe(true);
  });

  it("preserves absence versus an existing settings file without selections", async () => {
    const value = await fixture();
    expect(
      (await readClaudePluginSettingsLayer(capabilities, value.path, "user"))
        .layer,
    ).toMatchObject({ targetExists: false, enabledPlugins: {} });
    await writeFile(value.path, "{}\n");
    expect(
      (await readClaudePluginSettingsLayer(capabilities, value.path, "user"))
        .layer,
    ).toMatchObject({ targetExists: true, enabledPlugins: {} });
  });

  it.each([
    { enabledPlugins: { "": true } },
    { enabledPlugins: { ["é".repeat(257)]: true } },
    {
      enabledPlugins: Object.fromEntries(
        Array.from({ length: 257 }, (_, i) => [`plugin-${i}`, true]),
      ),
    },
    null,
    [],
  ])("refuses unresolved or out-of-contract selections", async (settings) => {
    const value = await fixture();
    await writeFile(value.path, JSON.stringify(settings));
    await expect(
      readClaudePluginSettingsLayer(capabilities, value.path, "user"),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
  });
});

describe("native parsed settings reach the actual guarded layer reader", () => {
  it.each(["user", "managed"] as const)(
    "applies whole-source versus per-field rejection before the actual %s layer",
    async (scope) => {
      const value = await fixture();
      const bytes = Buffer.from(
        JSON.stringify({
          enabledPlugins: { "ordinary@market": true },
          blockedMarketplaces: 17,
        }),
      );
      await writeFile(value.path, bytes);
      const observed = await readClaudePluginSettingsLayer(
        capabilities,
        value.path,
        scope,
      );
      expect(observed.layer.enabledPlugins).toEqual(
        scope === "user" ? {} : { "ordinary@market": true },
      );
      expect(observed.guard.digest).toBe(hash(bytes));
      expect(observed.layer.targetExists).toBe(true);
    },
  );
  it("preserves raw string arrays without collapsing them to true", async () => {
    const value = await fixture();
    const selections = ["first", "first", "second"];
    const bytes = Buffer.from(
      JSON.stringify({
        enabledPlugins: { "ordinary@market": selections, "empty@market": [] },
      }),
    );
    await writeFile(value.path, bytes);
    const observed = await readClaudePluginSettingsLayer(
      capabilities,
      value.path,
      "user",
    );
    expect(observed.layer.enabledPlugins).toEqual({
      "ordinary@market": ["first", "first", "second"],
      "empty@market": [],
    });
    expect(
      Object.isFrozen(observed.layer.enabledPlugins["ordinary@market"]),
    ).toBe(true);
    expect(observed.guard.digest).toBe(hash(bytes));
  });
  it.each(["user", "managed"] as const)(
    "does not partially apply a bad native field from %s settings",
    async (scope) => {
      const value = await fixture();
      const bytes = Buffer.from(
        JSON.stringify({
          enabledPlugins: { "good@market": true, "bad@market": 17 },
        }),
      );
      await writeFile(value.path, bytes);
      const observed = await readClaudePluginSettingsLayer(
        capabilities,
        value.path,
        scope,
      );
      expect(observed.layer.enabledPlugins).toEqual({});
      expect(observed.layer.targetExists).toBe(true);
      expect(observed.guard.digest).toBe(hash(bytes));
    },
  );
});
const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-plugin-document-")),
  );
  roots.push(root);
  return { root, path: join(root, "document.json") };
};
const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

import { capabilities } from "./__tests__/discovery-fixture.js";
