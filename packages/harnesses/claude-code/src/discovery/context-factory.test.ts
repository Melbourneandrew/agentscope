import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOwnedHarnessHookInvocation } from "@agentscope/harnesses-core";
import {
  claudeCodeDescriptor,
  createClaudeCodeDialectAuthority,
  createClaudeCodeDiscoveryContextFactory,
  prepareClaudeCodeInstallationContext,
} from "../index.js";
import {
  capabilities,
  createClaudeContextFixtures,
} from "./__tests__/discovery-fixture.js";

// Synthetic trusted application capabilities and held DTOs, not Core/native
// admission or an installed-vendor execution.
const { cachedContext } = createClaudeContextFixtures();
const factory = () => createClaudeCodeDiscoveryContextFactory(capabilities);
const inventory = { settingsLayers: [], installedPlugins: [] } as const;
const absentDigest = createHash("sha256")
  .update(new Uint8Array())
  .digest("hex");
const invocation = createOwnedHarnessHookInvocation({
  agentscopeHome: "/agentscope",
  harnessType: claudeCodeDescriptor.harnessType,
  hookDeadlineMilliseconds: 250,
  platform: "posix",
});
const dialect = createClaudeCodeDialectAuthority(
  {
    harnessType: claudeCodeDescriptor.harnessType,
    state: "installed",
    version: "2.1.245",
    reason: "compatible",
    configurationLocations: [{ locationIndex: 0, present: false }],
  },
  "posix",
);
if (dialect === undefined) throw new Error("fixture.dialect");

describe("public factory binds complete native context", () => {
  it("keeps pure installation preparation outside the discovery object", () => {
    expect(Object.keys(factory())).toEqual(["bindInvocation"]);
    expect(typeof prepareClaudeCodeInstallationContext).toBe("function");
  });
  it("snapshots invocation selectors without evaluating accessors", () => {
    const environment = { CLAUDE_CONFIG_DIR: "profile" };
    const bound = factory().bindInvocation({
      environment,
      homeDirectory: "/home",
      projectDirectory: "/work",
      platform: "linux",
      architecture: "x64",
    });
    environment.CLAUDE_CONFIG_DIR = "later";
    expect(bound.configurationPath()).toBe("/work/profile/settings.json");
    let reads = 0;
    const hostile = Object.defineProperty({}, "PATH", {
      get() {
        reads++;
        return "/secret";
      },
    });
    const probe = factory().bindInvocation({
      environment: hostile,
      projectDirectory: "/work",
      platform: "linux",
      architecture: "x64",
    }).probe;
    expect(reads).toBe(0);
    expect(Object.isFrozen(probe)).toBe(true);
  });
  it("keeps missing home unavailable rather than inventing a profile", () => {
    const bound = factory().bindInvocation({
      environment: {},
      projectDirectory: "/work",
      platform: "linux",
      architecture: "x64",
    });
    expect(bound.configurationPath()).toBeUndefined();
    expect(() => bound.observeInstallationContext()).toThrow(
      "plugin-inventory-unavailable",
    );
  });
  it("composes guarded plugin and route observations through the public factory", async () => {
    const value = await cachedContext();
    await mkdir(join(value.project, ".git"));
    const readers = { ...capabilities };
    const complete = createClaudeCodeDiscoveryContextFactory(readers);
    readers.readTextDocument = () => Promise.reject(new Error("substituted"));
    const context = await complete
      .bindInvocation({
        environment: {},
        homeDirectory: value.home,
        projectDirectory: value.project,
        platform: "linux",
        architecture: "x64",
      })
      .observeInstallationContext();
    expect(context.pluginInventory?.installedPlugins[0]?.pluginId).toBe(
      "ordinary@market",
    );
    expect(
      context.readGuards.some((guard) =>
        guard.targetPath.endsWith("installed_plugins.json"),
      ),
    ).toBe(true);
    expect(
      context.settingsDirectorySelections.some(
        (row) => row.directoryPath === join(value.project, ".git"),
      ),
    ).toBe(true);
    expect("localSettingsElection" in context).toBe(false);
  });
  it("retains canonical and cwd alternatives and failed home resolution honestly", async () => {
    const value = await cachedContext();
    const nested = join(value.project, "nested");
    await mkdir(nested);
    await mkdir(join(value.project, ".git"));
    await writeFile(
      join(value.project, ".claude", "settings.local.json"),
      "{}",
    );
    const input = {
      environment: {},
      homeDirectory: value.home,
      projectDirectory: nested,
      platform: "linux" as const,
      architecture: "x64" as const,
    };
    const context = await factory()
      .bindInvocation(input)
      .observeInstallationContext();
    expect(context.localSettingsElection?.candidate).toBe(value.project);
    expect(
      context.readGuards.some(
        (row) =>
          row.targetPath === join(nested, ".claude", "settings.local.json"),
      ),
    ).toBe(true);
    expect(
      context.readGuards.some(
        (row) =>
          row.targetPath ===
          join(value.project, ".claude", "settings.local.json"),
      ),
    ).toBe(true);
    const unresolved = createClaudeCodeDiscoveryContextFactory({
      ...capabilities,
      realpath: () => Promise.reject(new Error("unavailable")),
    });
    const fallback = await unresolved
      .bindInvocation(input)
      .observeInstallationContext();
    expect("localSettingsElection" in fallback).toBe(false);
  });
});

describe("public factory uses held settings and cache elections", () => {
  it("does not let later caller array mutation substitute a held raw selection", () => {
    const states: string[] = [];
    const bytes = new TextEncoder().encode(
      JSON.stringify({ enabledPlugins: { "ordinary@market": [] } }),
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    const prepared = prepareClaudeCodeInstallationContext(
      {
        readGuards: [],
        pluginInventory: {
          settingsLayers: [
            {
              scope: "user",
              targetPath: "/settings.json",
              targetExists: true,
              targetDigest: digest,
              enabledPlugins: { "ordinary@market": states },
            },
          ],
          installedPlugins: [
            {
              pluginId: "ordinary@market",
              installedRegistryId: "ordinary@market",
              cachePluginId: "ordinary@market",
              manifestName: null,
              manifestVersion: null,
              manifestDigest: null,
              hooksDigest: null,
              hookEvents: [],
              directTraceExporter: null,
            },
          ],
        },
      },
      1000,
    );
    const target = {
      targetPath: "/settings.json",
      exists: true,
      bytes,
      digest,
      mode: 0o600,
    };
    expect(
      prepared.configurationPlanner(
        "install",
        invocation,
        dialect,
        [],
        [],
      )(target).kind,
    ).toBe("replace");
    states.push("later-substitution");
    const planner = prepared.configurationPlanner(
      "install",
      invocation,
      dialect,
      [],
      [],
    );
    const decision = planner(target);
    expect(decision.kind).toBe("replace");
    if (decision.kind !== "replace")
      throw new Error("fixture.expected-replacement");
    const written: unknown = JSON.parse(
      new TextDecoder().decode(decision.bytes),
    );
    expect(written).toMatchObject({
      enabledPlugins: { "ordinary@market": [] },
    });
    expect(states).toEqual(["later-substitution"]);
  });
});

describe("public factory retains source snapshots", () => {
  it("uses immutable source snapshots without inventing directory observations", () => {
    const source = {
      pluginInventory: {
        settingsLayers: [
          {
            scope: "user" as const,
            targetPath: "/settings.json",
            targetDigest: absentDigest,
            targetExists: false,
            enabledPlugins: {},
          },
        ],
        installedPlugins: [],
      },
      readGuards: [],
      settingsDirectorySelections: [] as {
        directoryPath: string;
        exists: boolean;
      }[],
    };
    const prepared = prepareClaudeCodeInstallationContext(source, 1000);
    source.settingsDirectorySelections.push({
      directoryPath: "/substituted",
      exists: true,
    });
    expect(prepared.directoryPaths).toEqual([]);
    expect(prepared.settingsDirectoriesAgree([])).toBe(true);
    const planner = prepared.configurationPlanner(
      "install",
      invocation,
      dialect,
      [],
      [],
    );
    expect(
      planner({
        targetPath: "/settings.json",
        exists: false,
        bytes: null,
        digest: absentDigest,
        mode: null,
      }).kind,
    ).toBe("replace");
  });
  it("does not turn an unavailable selected context into an empty inventory", () => {
    const prepared = prepareClaudeCodeInstallationContext(
      { pluginInventory: null, readGuards: [] },
      1000,
    );
    expect(() =>
      prepared.configurationPlanner("install", invocation, dialect, [], []),
    ).toThrow("plugin-inventory-unavailable");
  });
});

describe("public factory re-elects held cache and ownership observations", () => {
  it("refuses empty elections and substituted loaded candidates", () => {
    for (const candidates of [
      [],
      [{ installPath: "/cache", plugin: null }],
      [
        {
          installPath: "/cache",
          plugin: null,
          loading: {
            paths: ["/cache"],
            selectedPath: "/other",
          },
        },
      ],
    ]) {
      const prepared = prepareClaudeCodeInstallationContext(
        {
          pluginInventory: inventory,
          readGuards: [],
          cacheElections: [{ candidates }],
        },
        1000,
      );
      expect(() =>
        prepared.configurationPlanner(
          "install",
          invocation,
          dialect,
          [
            {
              directoryPath: "/cache",
              exists: true,
              entries: ["skills"],
              mode: 0o755,
            },
          ],
          [],
        ),
      ).toThrow("plugin-inventory-unavailable");
    }
  });
  it("re-elects observed cache and loading paths from held directory contents", () => {
    const plugin = {
      pluginId: "ordinary@market",
      installedRegistryId: "ordinary@market",
      cachePluginId: "ordinary@market",
      manifestName: null,
      manifestVersion: null,
      manifestDigest: null,
      hooksDigest: null,
      hookEvents: [],
      directTraceExporter: null,
    } as const;
    const prepared = prepareClaudeCodeInstallationContext(
      {
        pluginInventory: inventory,
        readGuards: [],
        cacheElections: [
          {
            candidates: [
              {
                installPath: "/cache",
                plugin,
                loading: {
                  paths: ["/cache"],
                  selectedPath: "/cache",
                  versionRoots: [{ parentPath: "/seed", paths: ["/seed/v1"] }],
                },
              },
            ],
          },
        ],
      },
      1000,
    );
    expect(prepared.directoryPaths).toEqual(["/cache", "/seed", "/seed/v1"]);
    const held = [
      {
        directoryPath: "/cache",
        exists: true,
        entries: ["skills"],
        mode: 0o755,
      },
    ];
    expect(
      typeof prepared.configurationPlanner(
        "install",
        invocation,
        dialect,
        held,
        [],
      ),
    ).toBe("function");
    expect(() =>
      prepared.configurationPlanner(
        "install",
        invocation,
        dialect,
        [{ ...held[0]!, entries: ["node_modules"] }],
        [],
      ),
    ).toThrow("plugin-inventory-unavailable");
    expect(() =>
      prepared.configurationPlanner("install", invocation, dialect, [], []),
    ).toThrow("plugin-inventory-unavailable");
  });
});

describe("public factory selects canonical ownership", () => {
  it("uses canonical ownership only from held DTOs and refuses changed settings directories", () => {
    const prepared = prepareClaudeCodeInstallationContext(
      {
        pluginInventory: null,
        readGuards: [],
        settingsDirectorySelections: [
          { directoryPath: "/repo/.claude", exists: false },
        ],
        localSettingsElection: {
          cwd: "/repo/nested",
          candidate: "/repo",
          realHome: "/home",
          canonical: { pluginInventory: inventory },
        },
      },
      1000,
    );
    const held = [
      {
        directoryPath: "/repo",
        exists: true,
        entries: [],
        mode: 0o755,
        uid: 1000,
      },
      {
        directoryPath: "/repo/.git",
        exists: true,
        entries: [],
        mode: 0o755,
        uid: 1000,
      },
      {
        directoryPath: "/repo/.claude",
        exists: false,
        entries: [],
        mode: null,
        uid: null,
      },
    ];
    expect(prepared.settingsDirectoriesAgree(held)).toBe(true);
    expect(
      prepared.settingsDirectoriesAgree([
        { ...held[2]!, exists: true, mode: 0o755 },
      ]),
    ).toBe(false);
    expect(
      typeof prepared.configurationPlanner(
        "install",
        invocation,
        dialect,
        held,
        [],
      ),
    ).toBe("function");
    expect(() =>
      prepared.configurationPlanner(
        "install",
        invocation,
        dialect,
        held.map((row) => ({ ...row, uid: 1001 })),
        [],
      ),
    ).toThrow("plugin-inventory-unavailable");
  });
});
