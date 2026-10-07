import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createClaudeDiscoveryProbe,
  claudeUserConfiguration,
  captureClaudeEnvironment,
  claudePluginSeedDirectories,
  selectClaudePluginLoadingPath,
  type ClaudeDiscoveryPolicy,
} from "./claude-discovery.js";
import {
  authenticateExactFile,
  executableCandidates,
  revalidateAuthenticatedFile,
} from "./product-harness-probe-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const bytes = Buffer.from("synthetic-native-artifact-not-executed");
const identity = {
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const policy: ClaudeDiscoveryPolicy = {
  version: "2.1.245",
  platforms: { "linux-x64": identity, "darwin-arm64": identity },
};
const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-claude-discovery-")),
  );
  roots.push(root);
  const path = join(root, "claude");
  await writeFile(path, bytes, { mode: 0o755 });
  const environment = { PATH: root };
  const input = {
    environment,
    homeDirectory: root,
    projectDirectory: root,
    platform: "linux" as const,
    architecture: "x64" as const,
    policy,
  };
  return { root, path, input, probe: createClaudeDiscoveryProbe(input) };
};

describe("exact Claude native discovery", () => {
  it("observes exact native bytes without execution and inspects the selected profile", async () => {
    const { root, path, probe } = await fixture();
    expect(await probe.locateExecutable(["claude"])).toEqual({
      kind: "found",
      candidates: [{ path }],
    });
    expect(await probe.readVersion(path, ["--version"])).toEqual({
      kind: "observed",
      output: "2.1.245 (Claude Code)\n",
    });
    expect(
      await probe.inspectConfiguration([[".claude", "settings.json"]]),
    ).toEqual([{ locationIndex: 0, present: false }]);
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude", "settings.json"), "{}");
    expect(
      await probe.inspectConfiguration([[".claude", "settings.json"]]),
    ).toEqual([{ locationIndex: 0, present: true }]);
  });
  it.each(["", "relative", "~/literal-root"])(
    "inspects defined override %s without substituting the default profile",
    async (value) => {
      const { input, path, root } = await fixture();
      await mkdir(join(root, ".claude"));
      await writeFile(join(root, ".claude", "settings.json"), "default-poison");
      const environment = { ...input.environment, CLAUDE_CONFIG_DIR: value };
      const probe = createClaudeDiscoveryProbe({
        ...input,
        environment,
      });
      expect((await probe.locateExecutable(["claude"])).kind).toBe("found");
      expect((await probe.readVersion(path, ["--version"])).kind).toBe(
        "observed",
      );
      expect(
        await probe.inspectConfiguration([[".claude", "settings.json"]]),
      ).toEqual([{ locationIndex: 0, present: false }]);
      const selected = claudeUserConfiguration(root, root, environment);
      await mkdir(selected.directory, { recursive: true });
      await writeFile(selected.settingsPath, "{}");
      expect(
        await probe.inspectConfiguration([[".claude", "settings.json"]]),
      ).toEqual([{ locationIndex: 0, present: true }]);
    },
  );
  it("does not execute accessor environment controls", async () => {
    const { input } = await fixture();
    let reads = 0;
    const environment = Object.defineProperty({}, "PATH", {
      get: () => {
        reads++;
        throw Error("must-not-read");
      },
    });
    expect(
      await createClaudeDiscoveryProbe({
        ...input,
        environment,
      }).locateExecutable(["claude"]),
    ).toEqual({ kind: "unavailable" });
    expect(reads).toBe(0);
  });
  it.each(["wrapper", "failure-stub", "wrong-native"])(
    "never projects version from %s alone",
    async (content) => {
      const { path, probe } = await fixture();
      await writeFile(path, content);
      expect(await probe.readVersion(path, ["--version"])).toEqual({
        kind: "unavailable",
      });
    },
  );
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

describe("Claude discovery hostile filesystem boundaries", () => {
  it("supports npm replaced bin/claude.exe via the canonical executable", async () => {
    const { root, path, probe } = await fixture();
    await mkdir(join(root, "bin"));
    const native = join(root, "bin", "claude.exe");
    await rename(path, native);
    await symlink(native, path);
    expect(await probe.locateExecutable(["claude"])).toEqual({
      kind: "found",
      candidates: [{ path: native }],
    });
    expect((await probe.readVersion(native, ["--version"])).kind).toBe(
      "observed",
    );
  });
  it("rejects mode, platform, argument and configuration substitution", async () => {
    const { input, path, probe } = await fixture();
    expect((await probe.readVersion(path, ["--version", "extra"])).kind).toBe(
      "unavailable",
    );
    expect(
      (
        await createClaudeDiscoveryProbe({
          ...input,
          platform: "win32",
        }).readVersion(path, ["--version"])
      ).kind,
    ).toBe("unavailable");
    await chmod(path, 0o644);
    expect((await probe.readVersion(path, ["--version"])).kind).toBe(
      "unavailable",
    );
    await expect(
      probe.inspectConfiguration([[".claude", "other.json"]]),
    ).rejects.toThrow("probe-unavailable");
    expect((await probe.locateExecutable(["codex"])).kind).toBe("unavailable");
  });
  it("proves closed names, invalid PATH and genuine absence", async () => {
    const { root } = await fixture();
    expect((await executableCandidates(["other"], { PATH: root })).kind).toBe(
      "unavailable",
    );
    expect((await executableCandidates(["claude"], { PATH: "." })).kind).toBe(
      "unavailable",
    );
    expect((await executableCandidates(["codex"], { PATH: root })).kind).toBe(
      "absent",
    );
  });
  it("rejects file replacement after held-descriptor authentication", async () => {
    const { root, path } = await fixture();
    const authenticated = await authenticateExactFile(path, identity, 0o755);
    try {
      const replacement = join(root, "replacement");
      await writeFile(replacement, bytes, { mode: 0o755 });
      await rename(replacement, path);
      await expect(revalidateAuthenticatedFile(authenticated)).rejects.toThrow(
        "probe-unavailable",
      );
    } finally {
      await authenticated.handle.close();
    }
  });

  it("rejects in-place modification and a same-size substituted digest", async () => {
    const { path, probe } = await fixture();
    const authenticated = await authenticateExactFile(path, identity, 0o755);
    try {
      await writeFile(path, Buffer.alloc(bytes.length, 120));
      await expect(revalidateAuthenticatedFile(authenticated)).rejects.toThrow(
        "probe-unavailable",
      );
      expect((await probe.readVersion(path, ["--version"])).kind).toBe(
        "unavailable",
      );
    } finally {
      await authenticated.handle.close();
    }
  });

  it("rejects aliased configuration parent and symlink target rather than reporting absent", async () => {
    const { root, probe } = await fixture();
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "settings.json"), "{}");
    await symlink(external, join(root, ".claude"));
    await expect(
      probe.inspectConfiguration([[".claude", "settings.json"]]),
    ).rejects.toThrow("probe-unavailable");
    await rm(join(root, ".claude"));
    await mkdir(join(root, ".claude"));
    await symlink(
      join(external, "settings.json"),
      join(root, ".claude", "settings.json"),
    );
    await expect(
      probe.inspectConfiguration([[".claude", "settings.json"]]),
    ).rejects.toThrow("probe-unavailable");
  });
});
