import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
  CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
} from "../lifecycle.js";

import {
  readClaudePluginContext,
  discoverClaudeCanonicalSettingsRoot,
  mergeClaudePluginReadGuards,
} from "./claude-plugin-context.js";
import * as readers from "./claude-plugin-inventory.js";
import * as files from "./capabilities.js";
import * as managed from "./claude-managed-settings.js";
import { captureClaudeEnvironment } from "./claude-discovery.js";

import {
  createClaudeContextFixtures,
  hooks,
  capabilities,
} from "./__tests__/discovery-fixture.js";

const { cachedContext } = createClaudeContextFixtures();

describe("canonical route fallback and contradictory observations", () => {
  it("refuses different raw preimages for the same consulted file", () => {
    const guard = {
      targetPath: "/settings",
      exists: true,
      digest: "a",
      mode: 0o600,
    };
    expect(() =>
      mergeClaudePluginReadGuards([[guard], [{ ...guard, digest: "b" }]]),
    ).toThrow("cli.harness.plugin-inventory-unavailable");
  });
  it.each([undefined, "../../other/.git"])(
    "keeps the worktree root when its backlink is missing or different: %s",
    async (backlink) => {
      const value = await cachedContext();
      const gitdir = join(
        value.root,
        "canonical",
        ".git",
        "worktrees",
        "linked",
      );
      await mkdir(gitdir, { recursive: true });
      await writeFile(join(value.project, ".git"), `gitdir: ${gitdir}`);
      await writeFile(join(gitdir, "commondir"), "../..");
      if (backlink !== undefined)
        await writeFile(join(gitdir, "gitdir"), backlink);
      const observed = await discoverClaudeCanonicalSettingsRoot(
        capabilities,
        value.project,
        "/home",
      );
      expect(observed.candidate).toBe(value.project);
      expect(observed.readGuards.map((guard) => guard.targetPath)).toContain(
        join(gitdir, "gitdir"),
      );
    },
  );
  it("retains a genuinely absent optional canonical .claude directory", async () => {
    const value = await cachedContext();
    const candidate = join(value.root, "canonical");
    const gitdir = join(candidate, ".git", "worktrees", "linked");
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(value.project, ".git"), `gitdir: ${gitdir}`);
    await writeFile(join(gitdir, "commondir"), "../..");
    await writeFile(join(gitdir, "gitdir"), join(value.project, ".git"));
    const observed = await discoverClaudeCanonicalSettingsRoot(
      capabilities,
      value.project,
      "/home",
    );
    expect(observed.candidate).toBe(candidate);
    expect(observed.settingsDirectorySelections).toContainEqual({
      directoryPath: join(candidate, ".claude"),
      exists: false,
    });
  });
  it.each(["other", "missing"])(
    "refuses a canonical ownership route with %s root observation",
    async (kind) => {
      const value = await cachedContext();
      const cwd = join(value.project, "nested");
      await mkdir(cwd);
      await mkdir(join(value.project, ".git"));
      await expect(
        discoverClaudeCanonicalSettingsRoot(
          {
            ...capabilities,
            inspectPath: async (path) => {
              if (path !== value.project) return capabilities.inspectPath(path);
              if (kind === "missing")
                throw Object.assign(new Error("absent"), { code: "ENOENT" });
              return {
                ...(await capabilities.inspectPath(path)),
                kind: "other" as const,
              };
            },
          },
          cwd,
          "/home",
        ),
      ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    },
  );
});

describe("canonical settings routes remain preliminary observations", () => {
  it("refuses a marker that disappears between route and ownership collection", async () => {
    const value = await cachedContext();
    const cwd = join(value.project, "nested");
    const marker = join(value.project, ".git");
    await mkdir(cwd);
    await mkdir(marker);
    let visits = 0;
    await expect(
      discoverClaudeCanonicalSettingsRoot(
        {
          ...capabilities,
          inspectPath: async (path) => {
            if (path === marker && ++visits === 2)
              throw Object.assign(new Error("disappeared"), { code: "ENOENT" });
            return capabilities.inspectPath(path);
          },
        },
        cwd,
        "/home",
      ),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    expect(visits).toBe(2);
  });
  it.each([".git", ".claude"])(
    "refuses a %s alias rather than borrowing its ownership",
    async (name) => {
      const value = await cachedContext();
      const cwd = join(value.project, "nested");
      await mkdir(cwd);
      if (name === ".claude") {
        await mkdir(join(value.project, ".git"));
        await rename(
          join(value.project, ".claude"),
          join(value.project, "original-claude"),
        );
      }
      await symlink(value.root, join(value.project, name));
      await expect(
        discoverClaudeCanonicalSettingsRoot(capabilities, cwd, "/home"),
      ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    },
  );
  it("collects the root and directory markers without electing ownership", async () => {
    const value = await cachedContext();
    const cwd = join(value.project, "nested");
    await mkdir(cwd);
    const marker = join(value.project, ".git");
    await mkdir(marker);
    const observed = await discoverClaudeCanonicalSettingsRoot(
      capabilities,
      cwd,
      "/home",
    );
    expect(observed.candidate).toBe(value.project);
    expect(observed.readGuards).toContainEqual(
      expect.objectContaining({ targetPath: join(cwd, ".git"), exists: false }),
    );
    expect(observed.settingsDirectorySelections).toEqual([
      { directoryPath: marker, exists: true },
      { directoryPath: value.project, exists: true },
      { directoryPath: join(value.project, ".claude"), exists: true },
    ]);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.keys(observed)).not.toContain("uid");
  });
  it("retains a file marker through the existing guarded text reader", async () => {
    const value = await cachedContext();
    const cwd = join(value.project, "nested");
    await mkdir(cwd);
    const marker = join(value.project, ".git");
    await writeFile(marker, "native-non-gitdir-marker");
    const observed = await discoverClaudeCanonicalSettingsRoot(
      capabilities,
      cwd,
      "/home",
    );
    expect(observed.candidate).toBe(value.project);
    expect(observed.readGuards).toContainEqual(
      expect.objectContaining({ targetPath: marker, exists: true }),
    );
    expect(observed.settingsDirectorySelections).not.toContainEqual(
      expect.objectContaining({ directoryPath: marker }),
    );
  });
});

describe("managed settings preserve individual consulted preimages", () => {
  it("retains ignored managed subdirectories as existence guards, not settings layers", async () => {
    const value = await cachedContext();
    const ignored = join(value.root, "ignored-managed-directory");
    vi.spyOn(managed, "discoverClaudeManagedSettings").mockResolvedValue({
      paths: [],
      ignoredDirectories: [ignored],
      selection: {
        directoryPath: join(value.root, "managed-settings.d"),
        exists: true,
        entries: ["ignored-managed-directory"],
      },
    });
    const context = await value.read();
    expect(context.settingsDirectorySelections).toContainEqual({
      directoryPath: ignored,
      exists: true,
    });
    expect(
      context.pluginInventory.settingsLayers.some(
        (layer) => layer.targetPath === ignored,
      ),
    ).toBe(false);
    expect(
      context.readGuards.some((guard) => guard.targetPath === ignored),
    ).toBe(false);
  });
  it("retains cwd and candidate-root local layers as separate guarded inputs", async () => {
    const value = await cachedContext();
    const canonicalRoot = join(value.root, "canonical");
    await mkdir(join(canonicalRoot, ".claude"), { recursive: true });
    const cwdPath = join(value.project, ".claude", "settings.local.json");
    const rootPath = join(canonicalRoot, ".claude", "settings.local.json");
    await writeFile(
      cwdPath,
      JSON.stringify({ enabledPlugins: { "cwd@market": false } }),
    );
    await writeFile(
      rootPath,
      JSON.stringify({ enabledPlugins: { "root@market": false } }),
    );
    const context = await readClaudePluginContext(capabilities, {
      homeDirectory: value.home,
      projectDirectory: value.project,
      platform: "linux",
      localSettingsRoot: canonicalRoot,
    });
    const local = context.pluginInventory.settingsLayers.filter(
      (layer) => layer.scope === "local",
    );
    expect(local.map((layer) => layer.targetPath)).toEqual([cwdPath, rootPath]);
    expect(local.map((layer) => layer.enabledPlugins)).toEqual([
      { "cwd@market": false },
      { "root@market": false },
    ]);
    for (const layer of local)
      expect(context.readGuards).toContainEqual(
        expect.objectContaining({
          targetPath: layer.targetPath,
          exists: true,
          digest: layer.targetDigest,
        }),
      );
  });
  it("retains main and drop-in layers and their same-plan directory selection", async () => {
    const value = await cachedContext();
    const main = "/etc/claude-code/managed-settings.json";
    const dropin = "/etc/claude-code/managed-settings.d/a.json";
    const directoryPath = "/etc/claude-code/managed-settings.d";
    vi.mocked(managed.discoverClaudeManagedSettings).mockResolvedValue({
      paths: [main, dropin],
      ignoredDirectories: [],
      selection: { directoryPath, exists: true, entries: ["a.json"] },
    });
    const prior = vi
      .mocked(readers.readClaudePluginSettingsLayer)
      .getMockImplementation()!;
    vi.mocked(readers.readClaudePluginSettingsLayer).mockImplementation(
      (capabilities, path, scope) => {
        if (scope !== "managed") return prior(capabilities, path, scope);
        const digest = (path === main ? "a" : "b").repeat(64);
        return Promise.resolve({
          guard: { targetPath: path, exists: true, digest, mode: 0o644 },
          layer: {
            scope,
            targetPath: path,
            targetExists: true,
            targetDigest: digest,
            enabledPlugins: {
              [path === main ? "first@market" : "second@market"]: false,
            },
          },
        });
      },
    );
    const context = await value.read();
    const layers = context.pluginInventory.settingsLayers.filter(
      (layer) => layer.scope === "managed",
    );
    expect(layers.map((layer) => layer.targetPath)).toEqual([main, dropin]);
    expect(layers.map((layer) => layer.enabledPlugins)).toEqual([
      { "first@market": false },
      { "second@market": false },
    ]);
    expect(
      context.readGuards
        .filter((guard) => [main, dropin].includes(guard.targetPath))
        .map((guard) => guard.digest),
    ).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(context.settingsDirectorySelections).toEqual([
      { directoryPath, exists: true, entries: ["a.json"] },
    ]);
  });
});

describe("provider selector capture, not policy inference", () => {
  it.each([
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  ])("preserves the exact descriptor for %s without evaluating it", (key) => {
    let invoked = false;
    const get = () => {
      invoked = true;
      return "must-not-evaluate";
    };
    const environment = Object.defineProperty({}, key, { get });
    const captured = captureClaudeEnvironment(environment);
    expect(Object.getOwnPropertyDescriptor(captured, key)).toEqual({
      get,
      set: undefined,
      enumerable: false,
      configurable: false,
    });
    expect(invoked).toBe(false);
    expect(() => files.exactEnvironmentValue(captured, key)).toThrow();
    expect(invoked).toBe(false);
  });
  it("snapshots selector values but never captures credential keys", () => {
    const environment = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      CLAUDE_CODE_USE_BEDROCK: "false",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/original/store",
      ANTHROPIC_API_KEY: "synthetic-credential-not-consulted",
    };
    const captured = captureClaudeEnvironment(environment);
    environment.ANTHROPIC_BASE_URL = "changed";
    environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/changed/store";
    expect(captured).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      CLAUDE_CODE_USE_BEDROCK: "false",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/original/store",
    });
    expect(Object.isFrozen(captured)).toBe(true);
  });
});

describe("current-context composition signature", () => {
  it.each([
    [undefined, undefined, "/home/user/.claude/plugins"],
    ["", undefined, "/home/user/.claude/plugins"],
    ["/private/cache", undefined, "/private/cache"],
    ["relative-cache", undefined, "/work/project/relative-cache"],
    ["~/cache", undefined, "/home/user/cache"],
    ["~", undefined, "/home/user"],
    [undefined, "", "/home/user/.claude/plugins"],
    [undefined, "false", "/home/user/.claude/cowork_plugins"],
    ["", "1", "/home/user/.claude/cowork_plugins"],
    ["/private/cache", "1", "/private/cache"],
  ])(
    "derives settings and registry for cache/cowork controls %s/%s",
    async (override, cowork, root) => {
      vi.spyOn(managed, "discoverClaudeManagedSettings").mockImplementation(
        (_capabilities, mainPath) =>
          Promise.resolve({
            paths: [mainPath],
            ignoredDirectories: [],
            selection: {
              directoryPath: join(mainPath, "..", "managed-settings.d"),
              exists: false,
              entries: [],
            },
          }),
      );
      const paths: string[] = [];
      vi.spyOn(readers, "readClaudePluginSettingsLayer").mockImplementation(
        (_capabilities, path, scope) => {
          paths.push(path);
          const guard = Object.freeze({
            targetPath: path,
            exists: false,
            digest: "0".repeat(64),
            mode: null,
          });
          return Promise.resolve({
            guard,
            layer: {
              scope,
              targetPath: path,
              targetDigest: guard.digest,
              targetExists: false,
              enabledPlugins: {},
            },
          });
        },
      );
      vi.spyOn(readers, "readClaudeInstalledPluginRegistry").mockImplementation(
        (_capabilities, path) => {
          paths.push(path);
          return Promise.resolve({
            guard: {
              targetPath: path,
              exists: false,
              digest: "0".repeat(64),
              mode: null,
            },
            locations: [],
          });
        },
      );
      const context = await readClaudePluginContext(capabilities, {
        homeDirectory: "/home/user",
        projectDirectory: "/work/project",
        platform: "linux",
        environment: {
          ...(override === undefined
            ? {}
            : { CLAUDE_CODE_PLUGIN_CACHE_DIR: override }),
          ...(cowork === undefined
            ? {}
            : { CLAUDE_CODE_USE_COWORK_PLUGINS: cowork }),
        },
      });
      expect(paths).toEqual([
        `/home/user/.claude/${cowork ? "cowork_settings.json" : "settings.json"}`,
        "/work/project/.claude/settings.json",
        "/work/project/.claude/settings.local.json",
        "/etc/claude-code/managed-settings.json",
        join(root, "installed_plugins.json"),
      ]);
      expect(
        context.pluginInventory.settingsLayers.map((layer) => layer.scope),
      ).toEqual(["user", "project", "local", "managed"]);
      expect(context.pluginInventory.installedPlugins).toEqual([]);
      expect(context.readGuards).toHaveLength(5);
      expect(Object.isFrozen(context.pluginInventory)).toBe(true);
    },
  );
  it.each(["CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_USE_COWORK_PLUGINS"])(
    "refuses accessor control %s without executing it",
    async (key) => {
      let invoked = false;
      const environment = Object.defineProperty({}, key, {
        get: () => {
          invoked = true;
          return "/private/cache";
        },
      });
      await expect(
        readClaudePluginContext(capabilities, {
          homeDirectory: "/home/user",
          projectDirectory: "/work/project",
          platform: "linux",
          environment,
        }),
      ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
      expect(invoked).toBe(false);
    },
  );
});

describe("existing catalog name before rename metadata", () => {
  it("rejects an unselected catalog before consulting any recorded cache", async () => {
    const value = await cachedContext();
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "market", plugins: [] }),
    );
    const discover = vi.spyOn(files, "discoverClaudeCacheRecord");
    await expect(value.read()).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    expect(discover).not.toHaveBeenCalled();
  });
  it.each([{ ordinary: "replacement" }, { old: "ordinary" }, null, false])(
    "keeps an existing catalog name ahead of rename metadata %j",
    async (renames) => {
      const value = await cachedContext();
      await writeFile(
        join(value.catalog, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "market",
          renames,
          plugins: [
            { name: "ordinary", source: "./ordinary", hooks: hooks("Stop") },
          ],
        }),
      );
      expect(
        (await value.read()).pluginInventory.installedPlugins,
      ).toMatchObject([{ pluginId: "ordinary@market", hookEvents: ["Stop"] }]);
    },
  );
});

describe("synthetic official exporter classification", () => {
  it("classifies only the exact official reader observations, without treating a digest as runtime admission", async () => {
    const value = await cachedContext();
    const id = CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID;
    await writeFile(
      join(value.home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { [id]: true } }),
    );
    await writeFile(
      join(value.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { [id]: [{ scope: "user", installPath: value.plugin }] },
      }),
    );
    await writeFile(
      join(value.home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({
        "claude-plugins-official": {
          source: {
            source: "github",
            repo: "anthropics/claude-plugins-official",
          },
          installLocation: value.catalog,
        },
      }),
    );
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "langfuse-observability", source: "./ordinary" }],
      }),
    );
    // Synthetic first-party reader outputs test the curated classification only.
    vi.spyOn(readers, "readClaudePluginManifest").mockResolvedValue({
      guard: {
        targetPath: join(value.plugin, ".claude-plugin", "plugin.json"),
        exists: true,
        mode: 0o600,
        digest: CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST.slice(7),
      },
      manifestName: "langfuse-observability",
      manifestVersion: "1.0.0",
      hasDeclaredHooks: false,
      hooksDeclarationJson: null,
    });
    const hookReader = vi.spyOn(readers, "readClaudePluginHooks");
    const observation = {
      hookEvents: ["Stop", "SessionEnd"],
      hooksDigest: CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
      directTraceExporter: null,
      readGuards: [],
    } as const;
    hookReader.mockResolvedValue(observation);
    expect(
      (await value.read()).pluginInventory.installedPlugins[0]
        ?.directTraceExporter,
    ).toBe(true);
    hookReader.mockResolvedValue({
      ...observation,
      hookEvents: ["Stop", "PreToolUse"],
    });
    expect(
      (await value.read()).pluginInventory.installedPlugins[0]
        ?.directTraceExporter,
    ).toBeNull();
  });
});
