import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { inspectClaudeCodePluginOverlap } from "../lifecycle.js";

import {
  readClaudePluginContext,
  readClaudePluginContextObservation,
} from "./claude-plugin-context.js";

import {
  createClaudeContextFixtures,
  hooks,
  capabilities,
} from "./__tests__/discovery-fixture.js";

const { cachedContext } = createClaudeContextFixtures();

it("refuses a selected local source that is not an observed directory", async () => {
  const value = await cachedContext();
  const local = join(value.catalog, "ordinary");
  await writeFile(local, "not a directory");
  await writeFile(
    join(value.home, ".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({
      market: {
        source: { source: "directory", path: value.catalog },
        installLocation: value.catalog,
      },
    }),
  );
  await expect(
    readClaudePluginContext(capabilities, {
      homeDirectory: value.home,
      projectDirectory: value.project,
      platform: "linux",
    }),
  ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
});

describe("raw array selections cross the real settings and loading boundary", () => {
  it.each([{ state: [] }, { state: ["unresolved-selector"] }])(
    "loads the selected entry without inventing boolean hook enablement (%j)",
    async ({ state }) => {
      const value = await cachedContext();
      await writeFile(
        join(value.home, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { "ordinary@market": state } }),
      );
      await writeFile(
        join(value.plugin, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "ordinary" }),
      );
      await writeFile(
        join(value.plugin, "hooks", "hooks.json"),
        JSON.stringify({ hooks: hooks("Stop") }),
      );
      const observed = await value.read();
      expect(
        observed.pluginInventory.settingsLayers[0]?.enabledPlugins,
      ).toEqual({
        "ordinary@market": state,
      });
      expect(observed.pluginInventory.installedPlugins).toHaveLength(1);
      // An absent projection preserves identity; do not fabricate a rename.
      expect(observed.pluginInventory.loadSelections).toBeUndefined();
      expect(inspectClaudeCodePluginOverlap(observed.pluginInventory)).toEqual({
        status: "absent",
      });
    },
  );
});

describe("alternative plugin context failures remain branch-local", () => {
  it.each([
    [".claude-plugin", "plugin.json", false],
    ["hooks", "hooks.json", false],
    [".claude-plugin", "plugin.json", true],
    ["hooks", "hooks.json", true],
  ])(
    "retains branch-local failure for malformed %s/%s (%s)",
    async (directory, file, canonicalEnabled) => {
      const value = await cachedContext();
      await writeFile(join(value.plugin, directory, file), "{");
      await writeFile(
        join(value.home, ".claude", "settings.json"),
        JSON.stringify({
          enabledPlugins: { "ordinary@market": !canonicalEnabled },
        }),
      );
      const canonicalRoot = join(value.root, "canonical");
      await mkdir(join(canonicalRoot, ".claude"), { recursive: true });
      await writeFile(
        join(canonicalRoot, ".claude", "settings.local.json"),
        JSON.stringify({
          enabledPlugins: { "ordinary@market": canonicalEnabled },
        }),
      );
      const input = {
        homeDirectory: value.home,
        projectDirectory: value.project,
        platform: "linux" as const,
      };
      if (!canonicalEnabled)
        await expect(
          readClaudePluginContext(capabilities, input),
        ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
      const fallback = await readClaudePluginContextObservation(
        capabilities,
        input,
      );
      if (canonicalEnabled)
        expect(fallback.pluginInventory?.installedPlugins).toEqual([]);
      else expect(fallback.pluginInventory).toBeNull();
      expect(fallback.readGuards).toContainEqual(
        expect.objectContaining({
          targetPath: join(
            value.home,
            ".claude",
            "plugins",
            "installed_plugins.json",
          ),
          exists: true,
        }),
      );
      const canonical = await readClaudePluginContextObservation(capabilities, {
        ...input,
        localSettingsRoot: canonicalRoot,
      });
      if (canonicalEnabled) expect(canonical.pluginInventory).toBeNull();
      else expect(canonical.pluginInventory?.installedPlugins).toEqual([]);
      expect(Object.isFrozen(fallback)).toBe(true);
    },
  );

  it("does not fabricate an empty inventory for shared registry corruption", async () => {
    const value = await cachedContext();
    await writeFile(
      join(value.home, ".claude", "plugins", "installed_plugins.json"),
      "{",
    );
    const input = {
      homeDirectory: value.home,
      projectDirectory: value.project,
      platform: "linux" as const,
    };
    for (const localSettingsRoot of [value.project, value.home]) {
      const observed = await readClaudePluginContextObservation(capabilities, {
        ...input,
        localSettingsRoot,
      });
      expect(observed.pluginInventory).toBeNull();
    }
  });
});

describe("same-root cache registry observations", () => {
  it.each(["cache", "cowork"])(
    "reads both registries from %s, not defaults",
    async (control) => {
      const value = await cachedContext();
      const override =
        control === "cache"
          ? join(value.root, "registry-override")
          : join(value.home, ".claude", "cowork_plugins");
      await mkdir(override);
      if (control === "cowork") {
        const original = join(value.home, ".claude", "settings.json");
        await rename(
          original,
          join(value.home, ".claude", "cowork_settings.json"),
        );
        await writeFile(original, "not-json");
      }
      for (const name of [
        "installed_plugins.json",
        "known_marketplaces.json",
      ]) {
        const original = join(value.home, ".claude", "plugins", name);
        await rename(original, join(override, name));
        await writeFile(original, "not-json");
      }
      await writeFile(
        join(value.plugin, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "ordinary" }),
      );
      const context = await value.read(
        control === "cache"
          ? { CLAUDE_CODE_PLUGIN_CACHE_DIR: override }
          : { CLAUDE_CODE_USE_COWORK_PLUGINS: "1" },
      );
      expect(context.pluginInventory.installedPlugins).toMatchObject([
        { pluginId: "ordinary@market", hookEvents: ["Stop"] },
      ]);
      for (const name of ["installed_plugins.json", "known_marketplaces.json"])
        expect(context.readGuards.map((guard) => guard.targetPath)).toContain(
          join(override, name),
        );
    },
  );
});

describe("recorded-cache exact-version seed loading", () => {
  it("does not consult seed controls when the recorded cache already has content", async () => {
    const value = await cachedContext();
    let reads = 0;
    const environment = Object.defineProperty(
      {},
      "CLAUDE_CODE_PLUGIN_SEED_DIR",
      {
        get: () => {
          reads++;
          throw new Error("unconsulted-seed");
        },
      },
    );
    expect(
      (await value.read(environment)).cacheElections[0]?.candidates[0]?.loading
        ?.selectedPath,
    ).toBe(value.plugin);
    expect(reads).toBe(0);
  });
  it("observes seed documents only after the recorded cache and earlier seed are empty", async () => {
    const value = await cachedContext();
    const first = join(value.root, "seed-first"),
      second = join(value.root, "seed-second");
    const seed = join(second, "cache", "market", "ordinary", "cache");
    await mkdir(join(second, "cache", "market", "ordinary"), {
      recursive: true,
    });
    await rename(value.plugin, seed);
    await mkdir(join(value.plugin, "node_modules"), { recursive: true });
    const context = await value.read({
      CLAUDE_CODE_PLUGIN_SEED_DIR: `${first}:${second}`,
    });
    expect(context.cacheElections[0]?.candidates[0]?.loading).toEqual({
      paths: [
        value.plugin,
        join(first, "cache", "market", "ordinary", "cache"),
        seed,
      ],
      selectedPath: seed,
    });
    expect(
      context.readGuards.some((guard) =>
        guard.targetPath.startsWith(`${seed}/`),
      ),
    ).toBe(true);
    expect(
      context.readGuards.some((guard) =>
        guard.targetPath.startsWith(`${value.plugin}/`),
      ),
    ).toBe(false);
    expect(context.pluginInventory.installedPlugins).toMatchObject([
      { pluginId: "ordinary@market", hookEvents: ["Stop"] },
    ]);
  });
});

describe("recorded-cache alternate-version seed loading", () => {
  it("uses one nonempty alternate version and does not parse a temporary canary", async () => {
    const value = await cachedContext();
    const root = join(value.root, "seed"),
      parentPath = join(root, "cache", "market", "ordinary");
    const seed = join(parentPath, "alternate");
    await mkdir(parentPath, { recursive: true });
    await rename(value.plugin, seed);
    await mkdir(join(value.plugin, "node_modules"), { recursive: true });
    const temp = join(parentPath, "temp.tmp~deadbeef");
    await writeFile(temp, "UNCONSULTED-TEMP-CANARY");
    const context = await value.read({ CLAUDE_CODE_PLUGIN_SEED_DIR: root });
    expect(context.cacheElections[0]?.candidates[0]?.loading).toEqual({
      paths: [value.plugin, join(parentPath, "cache")],
      selectedPath: seed,
      versionRoots: [{ parentPath, paths: [seed] }],
    });
    expect(context.cacheElections[0]?.directoryPaths).toContain(parentPath);
    expect(context.readGuards.some((guard) => guard.targetPath === temp)).toBe(
      false,
    );
  });
});

describe("recorded object-source plugin loading", () => {
  it("does not resurrect unnamed malformed catalog entries or reject an unrelated valid cache", async () => {
    const value = await cachedContext();
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "market",
        plugins: [
          null,
          1,
          { source: { source: "unknown" } },
          {
            name: "ordinary",
            source: { source: "github", repo: "example/plugins" },
            hooks: hooks("Stop"),
          },
        ],
      }),
    );
    expect((await value.read()).pluginInventory.installedPlugins).toMatchObject(
      [{ pluginId: "ordinary@market", hookEvents: ["Stop"] }],
    );
  });
  it.each([
    { source: "github", repo: "example/plugins" },
    { source: "url", url: "https://example.invalid/plugins.git" },
    { source: "git-subdir", url: "example/plugins", path: "plugin" },
    { source: "npm", package: "example-plugin" },
    { source: "command", command: "never-executed" },
    { source: "archive", url: "https://example.invalid/plugin.zip" },
  ])(
    "observes the installed cache without acquiring its $source",
    async (source) => {
      const value = await cachedContext();
      await writeFile(
        join(value.catalog, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "market",
          plugins: [{ name: "ordinary", source, hooks: hooks("Stop") }],
        }),
      );
      expect(
        (await value.read()).pluginInventory.installedPlugins,
      ).toMatchObject([{ pluginId: "ordinary@market", hookEvents: ["Stop"] }]);
    },
  );
  it("loads an unknown named-entry stub from the recorded cache but discards only its raw catalog hooks", async () => {
    const value = await cachedContext();
    await writeFile(
      join(value.plugin, "hooks", "hooks.json"),
      JSON.stringify({ hooks: hooks("PostToolUse") }),
    );
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "market",
        plugins: [
          {
            name: "ordinary",
            source: {
              source: "git",
              url: "https://example.invalid/plugins.git",
            },
            hooks: hooks("Stop"),
            strict: false,
          },
        ],
      }),
    );
    expect((await value.read()).pluginInventory.installedPlugins).toMatchObject(
      [
        {
          pluginId: "ordinary@market",
          hookEvents: ["PostToolUse"],
          manifestName: null,
        },
      ],
    );
  });
  it("does not use string-source seed fallback for a missing recorded object cache", async () => {
    const value = await cachedContext();
    const seedRoot = join(value.root, "seed"),
      parent = join(seedRoot, "cache", "market", "ordinary");
    await mkdir(parent, { recursive: true });
    await rename(value.plugin, join(parent, "cache"));
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "market",
        plugins: [
          {
            name: "ordinary",
            source: { source: "github", repo: "example/plugins" },
          },
        ],
      }),
    );
    await expect(
      value.read({ CLAUDE_CODE_PLUGIN_SEED_DIR: seedRoot }),
    ).rejects.toThrow("plugin-inventory-unavailable");
  });
});
