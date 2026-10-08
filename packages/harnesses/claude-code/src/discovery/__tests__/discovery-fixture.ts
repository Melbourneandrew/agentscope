// Synthetic application read capabilities for package-native unit vectors.
// This is not the CLI held-descriptor reader or native/Core admission evidence.
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import type { ClaudeCodeDiscoveryReadCapabilities } from "../capabilities.js";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const unavailable = () => new Error("cli.harness.plugin-inventory-unavailable");
export const capabilities: ClaudeCodeDiscoveryReadCapabilities = {
  readTextDocument: async (path) => {
    let state;
    try {
      state = await lstat(path);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw unavailable();
      return Object.freeze({
        guard: Object.freeze({
          targetPath: path,
          exists: false,
          digest: digest(new Uint8Array()),
          mode: null,
        }),
        text: undefined,
      });
    }
    if (!state.isFile() || state.isSymbolicLink() || state.size > 1_048_576)
      throw unavailable();
    const bytes = await readFile(path);
    if (bytes.byteLength > 1_048_576) throw unavailable();
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw unavailable();
    }
    return Object.freeze({
      guard: Object.freeze({
        targetPath: path,
        exists: true,
        digest: digest(bytes),
        mode: state.mode & 0o777,
      }),
      text,
    });
  },
  readDirectoryEntries: async (path) => {
    try {
      return Object.freeze(await readdir(path));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
  },
  inspectPath: async (path) => {
    const state = await lstat(path);
    return Object.freeze({
      kind: state.isFile()
        ? "file"
        : state.isDirectory()
          ? "directory"
          : "other",
      symbolicLink: state.isSymbolicLink(),
      dev: state.dev,
      ino: state.ino,
      mtimeMs: state.mtimeMs,
      ctimeMs: state.ctimeMs,
    });
  },
  realpath,
  canonicalFutureDirectory: (path) => Promise.resolve(path),
  executableCandidates: () => Promise.resolve({ kind: "unavailable" }),
  authenticateExecutable: () => Promise.reject(unavailable()),
};

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
      (capabilities, path, scope) => {
        if (scope !== "managed") return original(capabilities, path, scope);
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
        readClaudePluginContext(capabilities, {
          homeDirectory: home,
          projectDirectory: project,
          platform: "linux",
          environment,
        }),
    };
  };

  return { cachedContext };
};
