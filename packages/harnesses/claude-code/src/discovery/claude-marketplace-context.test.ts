import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectClaudeCodePluginOverlap } from "../lifecycle.js";
import { readClaudePluginContext } from "./claude-plugin-context.js";
import {
  createClaudeContextFixtures,
  hooks,
  capabilities,
} from "./__tests__/discovery-fixture.js";
const { cachedContext } = createClaudeContextFixtures();

describe("whole catalog entry normalization before hook observation", () => {
  it.each([
    { version: 1 },
    { author: { name: "" } },
    { keywords: [1] },
    { defaultEnabled: "true" },
    { commands: { invalid: { source: "./command.md", content: "both" } } },
    { agents: ["absolute.md"] },
    {
      userConfig: {
        "invalid-key": { type: "string", title: "", description: "" },
      },
    },
    { channels: [{ server: "", extra: true }] },
    { headers: { authorization: 1 } },
    { headersHelper: "bad\ncommand" },
    { strict: "false" },
    { relevance: { signals: { cli: [1] } } },
    { mcpServers: { invalid: { type: "stdio", command: "" } } },
    { dependencies: ["invalid dependency"] },
  ])(
    "discards malformed entry hooks but retains the real cache for %j",
    async (invalid) => {
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
              source: "./ordinary",
              hooks: hooks("Stop"),
              ...invalid,
            },
          ],
        }),
      );
      expect(
        (await value.read()).pluginInventory.installedPlugins,
      ).toMatchObject([
        {
          pluginId: "ordinary@market",
          hookEvents: ["PostToolUse"],
          manifestName: null,
        },
      ]);
    },
  );
});

describe("strict-false marketplace components", () => {
  it("uses catalog hooks without inventing an absent cache manifest", async () => {
    const value = await cachedContext();
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "market",
        plugins: [
          {
            name: "ordinary",
            source: "./ordinary",
            strict: false,
            hooks: hooks("Stop"),
          },
        ],
      }),
    );
    expect((await value.read()).pluginInventory.installedPlugins).toMatchObject(
      [{ manifestName: null, manifestVersion: null, hookEvents: ["Stop"] }],
    );
  });
  it("accepts a real manifest when strict-false catalog declares no components", async () => {
    const value = await cachedContext();
    await writeFile(
      join(value.plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ordinary", version: "1.2.3" }),
    );
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "market",
        plugins: [{ name: "ordinary", source: "./ordinary", strict: false }],
      }),
    );
    expect((await value.read()).pluginInventory.installedPlugins).toMatchObject(
      [{ manifestName: "ordinary", manifestVersion: "1.2.3", hookEvents: [] }],
    );
  });
  it.each([{}, hooks("Stop")])(
    "rejects native's real-manifest/catalog-component conflict even for %j",
    async (declaration) => {
      const value = await cachedContext();
      await writeFile(
        join(value.plugin, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "ordinary" }),
      );
      await writeFile(
        join(value.catalog, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "market",
          plugins: [
            {
              name: "ordinary",
              source: "./ordinary",
              strict: false,
              hooks: declaration,
            },
          ],
        }),
      );
      await expect(value.read()).rejects.toThrow(
        "plugin-inventory-unavailable",
      );
    },
  );
});

describe("local marketplace plugin loading", () => {
  it.each(["directory", "file"])(
    "loads %s marketplace contents rather than an unrelated recorded cache",
    async (source) => {
      const value = await cachedContext();
      const local = join(value.catalog, "ordinary");
      await mkdir(join(local, "hooks"), { recursive: true });
      await writeFile(
        join(local, "hooks", "hooks.json"),
        JSON.stringify({ hooks: hooks("PostToolUse") }),
      );
      const catalogPath =
        source === "file"
          ? join(value.catalog, "marketplace.json")
          : join(value.catalog, ".claude-plugin", "marketplace.json");
      await writeFile(
        catalogPath,
        JSON.stringify({
          name: "market",
          plugins: [{ name: "ordinary", source: "./ordinary" }],
        }),
      );
      await writeFile(
        join(value.home, ".claude", "plugins", "known_marketplaces.json"),
        JSON.stringify({
          market: {
            source: {
              source,
              path: source === "file" ? catalogPath : value.catalog,
            },
            installLocation: source === "file" ? catalogPath : value.catalog,
          },
        }),
      );
      const context = await value.read();
      expect(context.pluginInventory.installedPlugins).toMatchObject([
        { pluginId: "ordinary@market", hookEvents: ["PostToolUse"] },
      ]);
      expect(context.cacheElections[0]!.candidates[0]!.loading).toEqual({
        paths: [local],
        selectedPath: local,
        localPath: local,
      });
      expect(context.readGuards.map((guard) => guard.targetPath)).not.toContain(
        join(value.plugin, "hooks", "hooks.json"),
      );
    },
  );
  it("retains a genuinely empty local directory and refuses missing local contents", async () => {
    const value = await cachedContext(),
      local = join(value.catalog, "ordinary");
    await mkdir(local);
    await writeFile(
      join(value.home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({
        market: {
          source: { source: "directory", path: value.catalog },
          installLocation: value.catalog,
        },
      }),
    );
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "market",
        plugins: [{ name: "ordinary", source: "./ordinary" }],
      }),
    );
    expect((await value.read()).pluginInventory.installedPlugins).toMatchObject(
      [{ manifestName: null, hookEvents: [] }],
    );
    await rm(local, { recursive: true });
    await expect(value.read()).rejects.toThrow("plugin-inventory-unavailable");
  });
});

describe("same-file Claude settings contexts", () => {
  it("preserves user/project aliases but retains one physical read preimage", async () => {
    const value = await cachedContext();
    const path = join(value.home, ".claude", "settings.json");
    await writeFile(path, JSON.stringify({ enabledPlugins: {} }));
    const context = await readClaudePluginContext(capabilities, {
      homeDirectory: value.home,
      projectDirectory: value.home,
      platform: "linux",
    });
    const layers = context.pluginInventory.settingsLayers;
    expect(layers.map((layer) => layer.scope)).toEqual([
      "user",
      "project",
      "local",
      "managed",
    ]);
    expect(layers.slice(0, 2)).toMatchObject([
      { scope: "user", targetPath: path, targetExists: true },
      { scope: "project", targetPath: path, targetExists: true },
    ]);
    expect(layers[0]?.targetDigest).toBe(layers[1]?.targetDigest);
    expect(
      context.readGuards.filter((guard) => guard.targetPath === path),
    ).toHaveLength(1);
    expect(context.readGuards).toHaveLength(4);
    expect(inspectClaudeCodePluginOverlap(context.pluginInventory)).toEqual({
      status: "absent",
    });
  });
});

describe("selected cached marketplace applicability", () => {
  it("matches a linked worktree without an invented HEAD prerequisite", async () => {
    const value = await cachedContext();
    await writeFile(
      join(value.plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ordinary" }),
    );
    const gitdir = join(value.root, ".git", "worktrees", "linked");
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(value.project, ".git"), `gitdir: ${gitdir}\n`);
    await writeFile(join(gitdir, "commondir"), "../..\n");
    await writeFile(join(gitdir, "gitdir"), `${join(value.project, ".git")}\n`);
    await writeFile(
      join(value.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ordinary@market": [
            {
              scope: "project",
              projectPath: value.root,
              installPath: value.plugin,
            },
          ],
        },
      }),
    );
    const context = await value.read();
    expect(context.pluginInventory.installedPlugins[0]?.pluginId).toBe(
      "ordinary@market",
    );
    expect(context.readGuards.map((guard) => guard.targetPath)).toEqual(
      expect.arrayContaining([
        join(value.project, ".git"),
        join(gitdir, "commondir"),
        join(gitdir, "gitdir"),
      ]),
    );
    expect(context.readGuards).toHaveLength(12);
    expect(context.readGuards.map((guard) => guard.targetPath)).not.toContain(
      join(value.root, ".git", "HEAD"),
    );
    expect(context.settingsDirectorySelections).toContainEqual({
      directoryPath: join(value.root, ".git"),
      exists: true,
    });
  });
});

describe("selected ordinary marketplace metadata", () => {
  it("retains ordinary manifest metadata and marketplace hooks in one guard set", async () => {
    const value = await cachedContext();
    await writeFile(
      join(value.plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ordinary", version: "" }),
    );
    const result = await value.read();
    expect(result.pluginInventory.installedPlugins).toMatchObject([
      {
        pluginId: "ordinary@market",
        manifestName: "ordinary",
        manifestVersion: "",
        hooksDigest: null,
        hookEvents: ["Stop"],
        directTraceExporter: null,
      },
    ]);
    expect(result.readGuards.map((guard) => guard.targetPath)).toContain(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
    );
    expect(result.readGuards.map((guard) => guard.targetPath)).toContain(
      join(value.plugin, ".claude-plugin", "plugin.json"),
    );
    expect(result.readGuards.length).toBeLessThanOrEqual(13);
  });

  it("supports an absent manifest with positive default hooks and marketplace hooks", async () => {
    const value = await cachedContext();
    await writeFile(
      join(value.plugin, "hooks", "hooks.json"),
      JSON.stringify({ hooks: hooks("PreToolUse") }),
    );
    const result = await value.read();
    expect(result.pluginInventory.installedPlugins[0]).toMatchObject({
      manifestName: null,
      manifestVersion: null,
      manifestDigest: null,
      hookEvents: ["Stop"],
      directTraceExporter: null,
    });
    expect(result.pluginInventory.installedPlugins[0]?.hooksDigest).toMatch(
      /^sha256-/u,
    );
  });

  it("defers cache-content election to Core rather than requiring a manifest sentinel", async () => {
    const value = await cachedContext();
    const collected = await value.read();
    expect(collected.cacheElections[0]?.candidates[0]).toMatchObject({
      installPath: value.plugin,
      plugin: { manifestName: null, hooksDigest: null },
    });
    await writeFile(
      join(value.plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ordinary" }),
    );
    await writeFile(
      join(value.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ordinary@market": [
            {
              scope: "project",
              installPath: value.plugin,
              projectPath: "/unresolved-worktree",
            },
          ],
        },
      }),
    );
    await expect(value.read()).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });
});
