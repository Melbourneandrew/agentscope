import { describe, expect, it, vi } from "vitest";
import {
  createClaudeCodeDiscoveryContextFactory,
  type ClaudeCodeDiscoveryReadCapabilities,
} from "../index.js";
import { capabilities } from "./__tests__/discovery-fixture.js";
import { discoverClaudeCacheRecord } from "./capabilities.js";
import { delimiter, join } from "node:path";
import {
  claudeUserConfiguration,
  captureClaudeEnvironment,
  claudePluginSeedDirectories,
  selectClaudePluginLoadingPath,
  claudeMarketplaceLoadingSource,
} from "./claude-discovery.js";

const probeInput = {
  environment: {},
  homeDirectory: "/home",
  projectDirectory: "/work",
  platform: "linux" as const,
  architecture: "x64" as const,
  policy: {
    version: "2.1.245",
    platforms: { "linux-x64": { bytes: 7, sha256: "a".repeat(64) } },
  },
};

describe("non-usable captured environment and archive cache routes", () => {
  it("captures a fixed unavailable PATH without reading revoked caller state", () => {
    const input = Proxy.revocable({}, {});
    input.revoke();
    expect(captureClaudeEnvironment(input.proxy)).toEqual({ PATH: undefined });
  });
  it("refuses archive candidates rather than inspecting them as directories", async () => {
    const read = vi.fn(() => Promise.resolve(["plugin.json"]));
    await expect(
      discoverClaudeCacheRecord(
        { ...capabilities, readDirectoryEntries: read },
        ["/cache/plugin.zip"],
        false,
      ),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    expect(read).not.toHaveBeenCalled();
  });
});
const injectedProbe = (
  overrides: Partial<ClaudeCodeDiscoveryReadCapabilities> = {},
) =>
  createClaudeCodeDiscoveryContextFactory({
    ...capabilities,
    ...overrides,
  }).bindInvocation(probeInput).probe;

describe("public discovery probe delegates trusted application observations", () => {
  it("locates only the declared executable and refuses failed readers", async () => {
    const locate = vi.fn(() =>
      Promise.resolve({
        kind: "found" as const,
        candidates: [{ path: "/claude" }],
      }),
    );
    const probe = injectedProbe({ executableCandidates: locate });
    expect(await probe.locateExecutable(["claude"])).toEqual({
      kind: "found",
      candidates: [{ path: "/claude" }],
    });
    expect(locate).toHaveBeenCalledWith(["claude"], {});
    for (const names of [[], ["other"], ["claude", "other"]])
      expect(await probe.locateExecutable(names)).toEqual({
        kind: "unavailable",
      });
    expect(locate).toHaveBeenCalledTimes(1);
    expect(
      await injectedProbe({
        executableCandidates: () => Promise.reject(new Error("reader")),
      }).locateExecutable(["claude"]),
    ).toEqual({ kind: "unavailable" });
  });
  it("projects a version only after the exact trusted authentication callback", async () => {
    const authenticate = vi.fn(() => Promise.resolve());
    const probe = injectedProbe({
      realpath: () => Promise.resolve("/canonical/claude"),
      authenticateExecutable: authenticate,
    });
    expect(await probe.readVersion("/claude", ["--version"])).toEqual({
      kind: "observed",
      output: "2.1.245 (Claude Code)\n",
    });
    expect(authenticate).toHaveBeenCalledWith(
      "/canonical/claude",
      probeInput.policy.platforms["linux-x64"],
      0o755,
    );
    for (const args of [
      [],
      ["--help"],
      ["--version", "extra"],
      Object.setPrototypeOf(["--version"], null) as string[],
    ])
      expect(await probe.readVersion("/claude", args)).toEqual({
        kind: "unavailable",
      });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(
      await injectedProbe({
        authenticateExecutable: () => Promise.reject(new Error("identity")),
      }).readVersion("/claude", ["--version"]),
    ).toEqual({ kind: "unavailable" });
    expect(await probe.readVersion("relative", ["--version"])).toEqual({
      kind: "unavailable",
    });
    const unsupported = createClaudeCodeDiscoveryContextFactory(
      capabilities,
    ).bindInvocation({ ...probeInput, architecture: "arm64" }).probe;
    expect(await unsupported.readVersion("/claude", ["--version"])).toEqual({
      kind: "unavailable",
    });
  });
});

describe("public discovery configuration callback", () => {
  const metadata = {
    kind: "file" as const,
    symbolicLink: false,
    dev: 1,
    ino: 2,
    mtimeMs: 3,
    ctimeMs: 4,
  };
  const locations = [[".claude", "settings.json"]];
  it("observes only the canonical selected profile and regular file", async () => {
    const inspect = vi.fn(() => Promise.resolve(metadata));
    expect(
      await injectedProbe({ inspectPath: inspect }).inspectConfiguration(
        locations,
      ),
    ).toEqual([{ locationIndex: 0, present: true }]);
    expect(inspect).toHaveBeenCalledWith("/home/.claude/settings.json");
    for (const invalid of [
      [],
      [["foreign"]],
      [Object.setPrototypeOf([".claude", "settings.json"], null) as string[]],
    ])
      await expect(
        injectedProbe().inspectConfiguration(invalid),
      ).rejects.toThrow("probe-unavailable");
    const missingHome = createClaudeCodeDiscoveryContextFactory(
      capabilities,
    ).bindInvocation({
      environment: {},
      projectDirectory: "/work",
      platform: "linux",
      architecture: "x64",
    });
    await expect(
      missingHome.probe.inspectConfiguration(locations),
    ).rejects.toThrow("probe-unavailable");
    await expect(
      injectedProbe({
        canonicalFutureDirectory: () => Promise.resolve("/substituted"),
      }).inspectConfiguration(locations),
    ).rejects.toThrow("probe-unavailable");
  });
  it("distinguishes declared absence from wrong kinds, symlinks and unreadable paths", async () => {
    for (const code of ["ENOENT", "ENOTDIR"])
      expect(
        await injectedProbe({
          inspectPath: () =>
            Promise.reject(Object.assign(new Error("missing"), { code })),
        }).inspectConfiguration(locations),
      ).toEqual([{ locationIndex: 0, present: false }]);
    for (const state of [
      { ...metadata, symbolicLink: true },
      { ...metadata, kind: "directory" as const },
    ])
      await expect(
        injectedProbe({
          inspectPath: () => Promise.resolve(state),
        }).inspectConfiguration(locations),
      ).rejects.toThrow("probe-unavailable");
    await expect(
      injectedProbe({
        inspectPath: () => Promise.reject(new Error("permission")),
      }).inspectConfiguration(locations),
    ).rejects.toThrow("permission");
  });
});

describe("pinned Claude user settings selection", () => {
  it("captures only the consulted controls before later environment mutation", () => {
    const environment = {
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "original",
      SECRET: "unused",
    };
    const captured = captureClaudeEnvironment(environment);
    environment.CLAUDE_CONFIG_DIR = "changed";
    expect(captured).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "original" });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(
      claudeUserConfiguration("/home/user", "/work", captured).settingsPath,
    ).toBe("/work/original/settings.json");
  });
  it.each([
    [undefined, undefined, "/home/user/.claude/settings.json"],
    ["", undefined, "/work/project/settings.json"],
    ["relative", undefined, "/work/project/relative/settings.json"],
    ["~/literal", undefined, "/work/project/~/literal/settings.json"],
    ["/custom/root", undefined, "/custom/root/settings.json"],
    ["/custom/cafe\u0301", undefined, "/custom/caf\u00e9/settings.json"],
    [undefined, "", "/home/user/.claude/settings.json"],
    [undefined, "false", "/home/user/.claude/cowork_settings.json"],
    ["/custom/root", "1", "/custom/root/cowork_settings.json"],
  ])(
    "resolves nullish/NFC/cowork controls %s/%s",
    (config, cowork, expected) => {
      const value = claudeUserConfiguration("/home/user", "/work/project", {
        ...(config === undefined ? {} : { CLAUDE_CONFIG_DIR: config }),
        ...(cowork === undefined
          ? {}
          : { CLAUDE_CODE_USE_COWORK_PLUGINS: cowork }),
      });
      expect(value.settingsPath).toBe(expected);
      expect(Object.isFrozen(value)).toBe(true);
    },
  );
  it.each(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_COWORK_PLUGINS"])(
    "does not invoke accessor selection %s",
    (key) => {
      let reads = 0;
      const environment = Object.defineProperty({}, key, {
        get: () => {
          reads++;
          return "/foreign";
        },
      });
      expect(() =>
        claudeUserConfiguration("/home/user", "/work/project", environment),
      ).toThrow("probe-unavailable");
      expect(reads).toBe(0);
    },
  );
});

describe("pinned Claude seed directory controls", () => {
  it("preserves seed order and duplicates, omits empty entries, and expands only home prefixes", () => {
    const selected = ["", "~/first", "relative", "~other", "~", "~/first", ""];
    const paths = claudePluginSeedDirectories("/home/user", "/work", {
      CLAUDE_CODE_PLUGIN_SEED_DIR: selected.join(delimiter),
    });
    expect(paths).toEqual([
      "/home/user/first",
      "/work/relative",
      "/work/~other",
      "/home/user",
      "/home/user/first",
    ]);
    expect(Object.isFrozen(paths)).toBe(true);
  });
  it.each([{}, { CLAUDE_CODE_PLUGIN_SEED_DIR: "" }])(
    "has no implicit seed root",
    (environment) => {
      expect(
        claudePluginSeedDirectories("/home/user", "/work", environment),
      ).toEqual([]);
    },
  );
  it("snapshots seed selection before mutation without reading unrelated controls", () => {
    const environment = { CLAUDE_CODE_PLUGIN_SEED_DIR: "~/original" };
    const captured = captureClaudeEnvironment(environment);
    environment.CLAUDE_CODE_PLUGIN_SEED_DIR = "~/changed";
    expect(
      claudePluginSeedDirectories("/home/user", "/work", captured),
    ).toEqual(["/home/user/original"]);
  });
  it("rejects accessor and malformed seed paths without invoking their getter", () => {
    let reads = 0;
    const environment = Object.defineProperty(
      {},
      "CLAUDE_CODE_PLUGIN_SEED_DIR",
      {
        get: () => {
          reads++;
          return "/foreign";
        },
      },
    );
    expect(() =>
      claudePluginSeedDirectories(
        "/home/user",
        "/work",
        captureClaudeEnvironment(environment),
      ),
    ).toThrow("probe-unavailable");
    expect(reads).toBe(0);
    expect(() =>
      claudePluginSeedDirectories("/home/user", "/work", {
        CLAUDE_CODE_PLUGIN_SEED_DIR: "bad\0path",
      }),
    ).toThrow("probe-unavailable");
  });
});

describe("marketplace loading refuses incomplete declarations", () => {
  it.each([
    { entry: { source: "./plugin" }, source: { source: "github" } },
    {
      entry: { name: "plugin", source: "./plugin" },
      source: { source: "file" },
    },
    {
      entry: { name: "plugin", source: "./plugin" },
      source: { source: "directory" },
    },
  ])(
    "does not fabricate a named entry or local path from %j",
    ({ entry, source }) => {
      expect(() =>
        claudeMarketplaceLoadingSource(entry, source, "/catalog"),
      ).toThrow("cli.harness.plugin-inventory-unavailable");
    },
  );
});

describe("alternate seed version selection from Core snapshots", () => {
  const inspect = (directoryPath: string, entries: readonly string[]) => ({
    directoryPath,
    entries,
    exists: true,
    mode: 0o755,
  });
  const cache = "/recorded",
    parentPath = "/seed/cache/market/plugin";
  const version = join(parentPath, "v9"),
    other = join(parentPath, "v10");
  const roots = [{ parentPath, paths: [version] }];
  it("excludes only the exact temporary suffix and selects the one nonempty version", () => {
    const observed = [
      inspect(cache, []),
      inspect(parentPath, ["v9", "v10.tmp~deadbeef"]),
      inspect(version, ["hooks"]),
    ];
    expect(selectClaudePluginLoadingPath([cache], observed, roots)).toBe(
      version,
    );
    expect(() =>
      selectClaudePluginLoadingPath(
        [cache],
        [
          observed[0]!,
          inspect(parentPath, ["v9", "v10.tmp~DEADBEEF"]),
          observed[2]!,
        ],
        roots,
      ),
    ).toThrow("plugin-inventory-unavailable");
  });
  it("rejects a substituted parent projection and missing child observation", () => {
    const observed = [
      inspect(cache, []),
      inspect(parentPath, ["v9", "v10"]),
      inspect(version, ["hooks"]),
    ];
    expect(() =>
      selectClaudePluginLoadingPath([cache], observed, roots),
    ).toThrow("plugin-inventory-unavailable");
    // Equal cardinality must not make a substituted child authoritative.
    expect(() =>
      selectClaudePluginLoadingPath(
        [cache],
        [observed[0]!, inspect(parentPath, ["v10"]), inspect(other, ["hooks"])],
        roots,
      ),
    ).toThrow("plugin-inventory-unavailable");
    expect(() =>
      selectClaudePluginLoadingPath(
        [cache],
        [observed[0]!, inspect(parentPath, ["v9"])],
        roots,
      ),
    ).toThrow("plugin-inventory-unavailable");
  });
  it("does not choose arbitrarily between two nonempty versions", () => {
    const observed = [
      inspect(cache, []),
      inspect(parentPath, ["v9", "v10"]),
      inspect(version, ["hooks"]),
      inspect(other, ["skills"]),
    ];
    expect(
      selectClaudePluginLoadingPath([cache], observed, [
        { parentPath, paths: [version, other] },
      ]),
    ).toBeUndefined();
    expect(
      selectClaudePluginLoadingPath(
        [cache],
        [inspect(cache, ["current"])],
        roots,
      ),
    ).toBe(cache);
  });
});

describe("local plugin selection from Core snapshots", () => {
  it("requires the exact local directory existence, not cached content", () => {
    const path = "/market/ordinary";
    const directory = {
      directoryPath: path,
      exists: true,
      mode: 0o755,
      entries: [],
    };
    expect(selectClaudePluginLoadingPath([path], [directory], [], path)).toBe(
      path,
    );
    expect(
      selectClaudePluginLoadingPath(
        [path],
        [{ ...directory, exists: false }],
        [],
        path,
      ),
    ).toBeUndefined();
    expect(() => selectClaudePluginLoadingPath([path], [], [], path)).toThrow(
      "plugin-inventory-unavailable",
    );
    expect(() =>
      selectClaudePluginLoadingPath([path, "/cache"], [directory], [], path),
    ).toThrow("plugin-inventory-unavailable");
    expect(() =>
      selectClaudePluginLoadingPath(
        [path],
        [directory],
        [{ parentPath: "/seed", paths: [] }],
        path,
      ),
    ).toThrow("plugin-inventory-unavailable");
  });
});
