import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { readClaudePluginContext } from "../claude-plugin-context.js";
import * as readers from "../claude-plugin-inventory.js";
import * as managed from "../claude-managed-settings.js";

export const hooks = (event: string) => ({
  [event]: [{ matcher: "", hooks: [{ type: "command", command: "unused" }] }],
});

export const createClaudeContextFixtures = () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await rm(root, { recursive: true });
  });

  const fixture = async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "agentscope-claude-hook-context-")),
    );
    roots.push(root);
    await mkdir(join(root, ".claude-plugin"));
    await mkdir(join(root, "hooks"));
    return root;
  };
  const cachedContext = async () => {
    vi.spyOn(managed, "discoverClaudeManagedSettings").mockImplementation(
      (mainPath) =>
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
    const root = await fixture();
    const home = join(root, "home");
    const project = join(root, "project");
    const plugin = join(root, "cache");
    const catalog = join(root, "marketplace");
    for (const path of [
      join(home, ".claude", "plugins"),
      join(project, ".claude"),
      join(plugin, ".claude-plugin"),
      join(plugin, "hooks"),
      join(catalog, ".claude-plugin"),
    ])
      await mkdir(path, { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "ordinary@market": true } }),
    );
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ordinary@market": [{ scope: "user", installPath: plugin }],
        },
      }),
    );
    await writeFile(
      join(home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({
        market: {
          source: { source: "github", repo: "example/plugins" },
          installLocation: catalog,
          lastUpdated: "observed",
        },
      }),
    );
    await writeFile(
      join(catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "market",
        plugins: [
          { name: "ordinary", source: "./ordinary", hooks: hooks("Stop") },
        ],
      }),
    );
    const original = readers.readClaudePluginSettingsLayer;
    vi.spyOn(readers, "readClaudePluginSettingsLayer").mockImplementation(
      (path, scope) => {
        if (scope !== "managed") return original(path, scope);
        return Promise.resolve({
          guard: {
            targetPath: path,
            exists: false,
            digest: "0".repeat(64),
            mode: null,
          },
          layer: {
            scope,
            targetPath: path,
            targetDigest: "0".repeat(64),
            targetExists: false,
            enabledPlugins: {},
          },
        });
      },
    );
    return {
      root,
      home,
      project,
      plugin,
      catalog,
      read: (environment: Readonly<Record<string, string | undefined>> = {}) =>
        readClaudePluginContext({
          homeDirectory: home,
          projectDirectory: project,
          platform: "linux",
          environment,
        }),
    };
  };

  return { cachedContext };
};
