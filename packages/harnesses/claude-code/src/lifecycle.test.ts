import { describe, expect, it } from "vitest";

import {
  createOwnedHarnessHookInvocation,
  type HarnessInstallationPlanner,
  type HarnessTargetDecision,
  type HarnessTargetInspection,
} from "@agentscope/harnesses-core";

import {
  CLAUDE_CODE_LIFECYCLE_EVENTS,
  CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
  CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
  createClaudeCodeInstallationPlanner,
  inspectClaudeCodePluginOverlap,
  type ClaudeCodeInstalledPlugin,
  type ClaudeCodePluginInventory,
} from "./lifecycle.js";
import { runClaudeCodeHook } from "./testing.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const targetDigest = "0".repeat(64);
const targetPathByScope = {
  user: "/isolated/.claude/settings.json",
  project: "/isolated/project/.claude/settings.json",
  local: "/isolated/project/.claude/settings.local.json",
  managed: "/isolated/managed-settings.json",
} as const;

const invocation = createOwnedHarnessHookInvocation({
  agentscopeHome: "/opt/agentscope",
  harnessType: "@agentscope/harness-claude-code",
  hookDeadlineMilliseconds: 2_000,
  platform: "posix",
});

const target = (
  text?: string,
  targetPath: string = targetPathByScope.user,
  digest: string = targetDigest,
): HarnessTargetInspection => ({
  targetPath,
  exists: text !== undefined,
  bytes: text === undefined ? null : encoder.encode(text),
  digest,
  mode: text === undefined ? null : 0o600,
});

const binaryTarget = (bytes: Uint8Array): HarnessTargetInspection => ({
  targetPath: "/isolated/.claude/settings.json",
  exists: true,
  bytes,
  digest: targetDigest,
  mode: 0o600,
});

const decisionText = (decision: HarnessTargetDecision): string => {
  if (decision.kind !== "replace" && decision.kind !== "replace-overlap")
    throw new Error("expected replacement");
  return decoder.decode(decision.bytes);
};

const parseRecord = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected settings record");
  return value as Record<string, unknown>;
};

const installedHookCommand = (text: string): string => {
  const settings = parseRecord(text);
  const hooks = parseRecord(JSON.stringify(settings.hooks));
  const sessionStart = hooks.SessionStart;
  if (!Array.isArray(sessionStart) || sessionStart.length !== 1)
    throw new Error("expected one SessionStart matcher");
  const matcher = parseRecord(JSON.stringify(sessionStart[0]));
  if (!Array.isArray(matcher.hooks) || matcher.hooks.length !== 1)
    throw new Error("expected one owned hook");
  const hook = parseRecord(JSON.stringify(matcher.hooks[0]));
  if (typeof hook.command !== "string") throw new Error("expected command");
  return hook.command;
};

const decodeSingleQuotedShellWord = (command: string): string => {
  if (!command.startsWith("'") || !command.endsWith("'"))
    throw new Error("expected one single-quoted shell word");
  const segments = command.slice(1, -1).split("'\\''");
  if (segments.some((segment) => segment.includes("'")))
    throw new Error("unexpected shell syntax");
  return segments.join("'");
};

const officialPlugin = (
  overrides: Partial<ClaudeCodeInstalledPlugin> = {},
): ClaudeCodeInstalledPlugin => ({
  pluginId: CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
  installedRegistryId: CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
  cachePluginId: CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
  manifestName: "langfuse-observability",
  manifestVersion: "1.0.0",
  manifestDigest: CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  hooksDigest: CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
  hookEvents: ["Stop", "SessionEnd"],
  directTraceExporter: true,
  ...overrides,
});

const orphanPlugin = (
  pluginId: string,
  overrides: Partial<ClaudeCodeInstalledPlugin> = {},
): ClaudeCodeInstalledPlugin => ({
  pluginId,
  installedRegistryId: pluginId,
  cachePluginId: pluginId,
  manifestName: pluginId,
  manifestVersion: "1.0.0",
  manifestDigest: `sha256-${"a".repeat(64)}`,
  hooksDigest: `sha256-${"b".repeat(64)}`,
  hookEvents: ["Stop"],
  directTraceExporter: false,
  ...overrides,
});

const officialInventory = (): ClaudeCodePluginInventory => ({
  settingsLayers: [
    {
      scope: "user",
      targetPath: targetPathByScope.user,
      targetDigest,
      targetExists: true,
      enabledPlugins: {
        [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: true,
      },
    },
  ],
  installedPlugins: [officialPlugin()],
});

const emptyInventory = (targetExists = true): ClaudeCodePluginInventory => ({
  settingsLayers: [
    {
      scope: "user",
      targetPath: targetPathByScope.user,
      targetDigest,
      targetExists,
      enabledPlugins: {},
    },
  ],
  installedPlugins: [],
});

const officialInventoryAt = (
  scope: "user" | "project" | "local" | "managed",
): ClaudeCodePluginInventory => ({
  settingsLayers: [
    {
      scope,
      targetPath: targetPathByScope[scope],
      targetDigest,
      targetExists: true,
      enabledPlugins: {
        [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: true,
      },
    },
  ],
  installedPlugins: [officialPlugin()],
});

describe("Claude Code plugin overlap", () => {
  it("detects the reviewed official Langfuse exporter", () => {
    expect(inspectClaudeCodePluginOverlap(officialInventory())).toEqual({
      status: "conflict",
      pluginId: CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
    });
  });

  it("honors effective managed precedence", () => {
    expect(
      inspectClaudeCodePluginOverlap({
        ...officialInventory(),
        settingsLayers: [
          ...officialInventory().settingsLayers,
          {
            scope: "managed",
            targetPath: targetPathByScope.managed,
            targetDigest,
            targetExists: true,
            enabledPlugins: {
              [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: false,
            },
          },
        ],
      }),
    ).toEqual({ status: "absent" });
  });

  it.each([
    {
      settingsLayers: officialInventory().settingsLayers,
      installedPlugins: [],
    },
    {
      settingsLayers: officialInventory().settingsLayers,
      installedPlugins: [officialPlugin({ hookEvents: ["Stop"] })],
    },
    {
      settingsLayers: [
        ...officialInventory().settingsLayers,
        ...officialInventory().settingsLayers,
      ],
      installedPlugins: [officialPlugin()],
    },
    {
      settingsLayers: officialInventory().settingsLayers,
      installedPlugins: [
        officialPlugin(),
        officialPlugin({ manifestVersion: "1.0.1" }),
      ],
    },
  ])("fails closed for inconsistent official plugin state", (inventory) => {
    expect(inspectClaudeCodePluginOverlap(inventory)).toEqual({
      status: "ambiguous",
    });
  });
});

describe("Claude Code exporter reconciliation", () => {
  it("detects another enabled direct exporter with overlapping hooks", () => {
    const exporter: ClaudeCodeInstalledPlugin = {
      pluginId: "other-exporter",
      installedRegistryId: "other-exporter",
      cachePluginId: "other-exporter",
      manifestName: "other-exporter",
      manifestVersion: "1.0.0",
      manifestDigest: `sha256-${"a".repeat(64)}`,
      hooksDigest: `sha256-${"b".repeat(64)}`,
      hookEvents: ["Stop"],
      directTraceExporter: true,
    };
    const settingsLayers = [
      {
        scope: "project" as const,
        targetPath: targetPathByScope.project,
        targetDigest,
        targetExists: true,
        enabledPlugins: { "other-exporter": true },
      },
    ];
    expect(
      inspectClaudeCodePluginOverlap({
        settingsLayers,
        installedPlugins: [exporter],
      }),
    ).toEqual({ status: "conflict", pluginId: "other-exporter" });
    expect(
      inspectClaudeCodePluginOverlap({
        settingsLayers,
        installedPlugins: [{ ...exporter, cachePluginId: "mismatch" }],
      }),
    ).toEqual({ status: "ambiguous" });
  });

  it("fails closed when enabled and cached identities cannot be reconciled", () => {
    expect(
      inspectClaudeCodePluginOverlap({
        settingsLayers: [
          {
            scope: "local",
            targetPath: targetPathByScope.local,
            targetDigest,
            targetExists: true,
            enabledPlugins: { "unknown-plugin": true },
          },
        ],
        installedPlugins: [],
      }),
    ).toEqual({ status: "ambiguous" });
    expect(
      inspectClaudeCodePluginOverlap({
        settingsLayers: [
          {
            scope: "local",
            targetPath: targetPathByScope.local,
            targetDigest,
            targetExists: true,
            enabledPlugins: { "langfuse-alias": false },
          },
        ],
        installedPlugins: [
          officialPlugin({
            pluginId: "langfuse-alias",
            installedRegistryId: "langfuse-alias",
            cachePluginId: "langfuse-alias",
          }),
        ],
      }),
    ).toEqual({ status: "ambiguous" });
  });
});

describe("Claude Code owned lifecycle", () => {
  it("leaves an absent settings file absent on uninstall", () => {
    expect(
      createClaudeCodeInstallationPlanner(
        "uninstall",
        invocation,
        emptyInventory(false),
      )(target()),
    ).toEqual({ kind: "unchanged" });
  });

  it("installs direct-exec hooks idempotently and removes only owned state", () => {
    const foreign = {
      theme: "dark",
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "/foreign/exporter", args: [] },
            ],
          },
        ],
      },
    };
    const install = createClaudeCodeInstallationPlanner(
      "install",
      invocation,
      emptyInventory(),
    );
    const installed = install(target(JSON.stringify(foreign)));
    const installedText = decisionText(installed);
    const installedSettings = parseRecord(installedText);
    expect(installedSettings.theme).toBe("dark");
    expect(installedText).toContain("/foreign/exporter");
    expect(installedText).toContain(invocation.launcherPath);
    expect(installedText).toContain(invocation.ownershipIdentity);
    expect(install(target(installedText))).toEqual({ kind: "unchanged" });

    const uninstall = createClaudeCodeInstallationPlanner(
      "uninstall",
      invocation,
      emptyInventory(),
    );
    const uninstalledText = decisionText(uninstall(target(installedText)));
    expect(uninstalledText).toContain("/foreign/exporter");
    expect(uninstalledText).not.toContain(invocation.launcherPath);
    expect(parseRecord(uninstalledText).theme).toBe("dark");
  });

  it("installs every governed lifecycle event with zero external arguments", () => {
    const decision = createClaudeCodeInstallationPlanner(
      "install",
      invocation,
      emptyInventory(false),
    )(target());
    const text = decisionText(decision);
    for (const event of CLAUDE_CODE_LIFECYCLE_EVENTS) {
      expect(text).toContain(`"${event}"`);
    }
    expect(text).toContain('"args": []');
    expect(text).not.toMatch(/[;&|`$<>]/u);
  });

  it.each([
    "/isolated/space home",
    "/isolated/semi;$(synthetic-canary)",
    "/isolated/line\nbreak",
    "/isolated/single'quote",
    "/isolated/back\\slash",
  ])("encodes a hostile launcher path as one POSIX shell word", (home) => {
    const hostileInvocation = createOwnedHarnessHookInvocation({
      agentscopeHome: home,
      harnessType: "@agentscope/harness-claude-code",
      hookDeadlineMilliseconds: 2_000,
      platform: "posix",
    });
    const installed = createClaudeCodeInstallationPlanner(
      "install",
      hostileInvocation,
      emptyInventory(false),
    )(target());
    const command = installedHookCommand(decisionText(installed));
    expect(decodeSingleQuotedShellWord(command)).toBe(
      hostileInvocation.launcherPath,
    );
    if (home.includes("single")) {
      const basename = hostileInvocation.launcherPath.split("/").at(-1)!;
      expect(command).toBe(`'/isolated/single'\\''quote/bin/${basename}'`);
    }
  });

  it("rejects unbound or unrepresentable launcher dialects before mutation", () => {
    for (const unsupportedInvocation of [
      createOwnedHarnessHookInvocation({
        agentscopeHome: "/isolated/windows-dialect",
        harnessType: "@agentscope/harness-claude-code",
        hookDeadlineMilliseconds: 2_000,
        platform: "win32",
      }),
      createOwnedHarnessHookInvocation({
        agentscopeHome: "/isolated/nul\0path",
        harnessType: "@agentscope/harness-claude-code",
        hookDeadlineMilliseconds: 2_000,
        platform: "posix",
      }),
    ]) {
      expect(
        createClaudeCodeInstallationPlanner(
          "install",
          unsupportedInvocation,
          emptyInventory(false),
        )(target()),
      ).toEqual({ kind: "unsupported" });
    }
  });
});

describe("Claude Code migration and failure behavior", () => {
  it("requires explicit migration for the official exporter", () => {
    const text = JSON.stringify({
      enabledPlugins: {
        [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: true,
      },
    });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        officialInventory(),
      )(target(text)),
    ).toEqual({ kind: "conflict" });
    const migrated = createClaudeCodeInstallationPlanner(
      "migrate",
      invocation,
      officialInventory(),
    )(target(text));
    const migratedText = decisionText(migrated);
    expect(migrated.kind).toBe("replace-overlap");
    expect(migratedText).toContain(
      `"${CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID}": false`,
    );
    expect(migratedText).toContain(invocation.launcherPath);
  });
});

describe("Claude Code target-bound absence evidence", () => {
  it("binds explicit absence to the exact inspected settings snapshot", () => {
    const enabledOfficialSettings = JSON.stringify({
      enabledPlugins: {
        [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: true,
      },
    });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target(enabledOfficialSettings)),
    ).toEqual({ kind: "conflict" });

    const boundLayer = emptyInventory().settingsLayers[0]!;
    for (const layer of [
      { ...boundLayer, scope: "project" as const },
      { ...boundLayer, targetPath: targetPathByScope.project },
      { ...boundLayer, targetPath: "/isolated/../settings.json" },
      { ...boundLayer, targetDigest: "1".repeat(64) },
      { ...boundLayer, targetExists: false },
    ]) {
      expect(
        createClaudeCodeInstallationPlanner("install", invocation, {
          settingsLayers: [layer],
          installedPlugins: [],
        })(target("{}")),
      ).toEqual({ kind: "conflict" });
    }

    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target("{}")),
    ).toMatchObject({ kind: "replace" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(false),
      )(target()),
    ).toMatchObject({ kind: "replace" });
  });

  it("rejects every detached precedence layer with one target inspection", () => {
    const enabledOfficialSettings = JSON.stringify({
      enabledPlugins: {
        [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: true,
      },
    });
    const authenticatedUser = officialInventory().settingsLayers[0]!;
    for (const detachedLayer of [
      {
        scope: "project" as const,
        targetPath: targetPathByScope.project,
        targetDigest,
        targetExists: true,
        enabledPlugins: {
          [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: false,
        },
      },
      {
        scope: "managed" as const,
        targetPath: targetPathByScope.managed,
        targetDigest,
        targetExists: false,
        enabledPlugins: {},
      },
    ]) {
      expect(
        createClaudeCodeInstallationPlanner("install", invocation, {
          settingsLayers: [authenticatedUser, detachedLayer],
          installedPlugins: [officialPlugin()],
        })(target(enabledOfficialSettings)),
      ).toEqual({ kind: "conflict" });
    }
  });

  it("rejects state claims attached to a nonexistent target", () => {
    const absentLayer = emptyInventory(false).settingsLayers[0]!;
    for (const inventory of [
      {
        settingsLayers: [
          {
            ...absentLayer,
            enabledPlugins: {
              [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: false,
            },
          },
        ],
        installedPlugins: [],
      },
      {
        settingsLayers: [absentLayer],
        installedPlugins: [officialPlugin()],
      },
    ]) {
      expect(
        createClaudeCodeInstallationPlanner(
          "install",
          invocation,
          inventory,
        )(target()),
      ).toEqual({ kind: "conflict" });
    }
  });
});

describe("Claude Code migration authority", () => {
  it.each(["project", "local", "managed"] as const)(
    "refuses migration when %s owns the effective exporter",
    (scope) => {
      const text = JSON.stringify({
        enabledPlugins: {
          [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: true,
        },
      });
      expect(
        createClaudeCodeInstallationPlanner(
          "migrate",
          invocation,
          officialInventoryAt(scope),
        )(target(text)),
      ).toEqual({ kind: "conflict" });
    },
  );

  it("requires the owned user target to match effective plugin authority", () => {
    const enabled = JSON.stringify({
      enabledPlugins: {
        [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: true,
      },
    });
    expect(
      createClaudeCodeInstallationPlanner(
        "migrate",
        invocation,
        officialInventory(),
      )(target("{}")),
    ).toEqual({ kind: "conflict" });
    expect(
      createClaudeCodeInstallationPlanner(
        "migrate",
        invocation,
        officialInventory(),
      )(target(enabled, targetPathByScope.project)),
    ).toEqual({ kind: "conflict" });
    expect(
      createClaudeCodeInstallationPlanner(
        "migrate",
        invocation,
        officialInventory(),
      )(target(enabled, targetPathByScope.user, "1".repeat(64))),
    ).toEqual({ kind: "conflict" });
    expect(
      createClaudeCodeInstallationPlanner(
        "migrate",
        invocation,
        emptyInventory(),
      )(target("{}")),
    ).toEqual({ kind: "conflict" });
  });
});

describe("Claude Code hostile lifecycle state", () => {
  it("requires explicit governed inventory for every production operation", () => {
    type RuntimePlannerFactory = (
      operation: "install" | "migrate" | "uninstall",
      ownedInvocation: typeof invocation,
      inventory?: ClaudeCodePluginInventory,
    ) => HarnessInstallationPlanner;
    const runtimeFactory =
      createClaudeCodeInstallationPlanner as RuntimePlannerFactory;
    const enabledOfficialSettings = JSON.stringify({
      enabledPlugins: {
        [CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID]: true,
      },
    });
    expect(
      runtimeFactory("install", invocation)(target(enabledOfficialSettings)),
    ).toEqual({ kind: "conflict" });
    expect(
      runtimeFactory("migrate", invocation)(target(enabledOfficialSettings)),
    ).toEqual({ kind: "conflict" });

    const installed = decisionText(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(false),
      )(target()),
    );
    expect(runtimeFactory("uninstall", invocation)(target(installed))).toEqual({
      kind: "conflict",
    });
  });

  it("rejects forged ownership and tampered ownership metadata", () => {
    const installedText = decisionText(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(false),
      )(target()),
    );
    const forged = { ...invocation } as typeof invocation;
    expect(
      createClaudeCodeInstallationPlanner(
        "uninstall",
        forged,
        emptyInventory(),
      )(target(installedText)),
    ).toEqual({ kind: "conflict" });
    const foreignInvocation = createOwnedHarnessHookInvocation({
      agentscopeHome: "/foreign/agentscope",
      harnessType: "@agentscope/harness-claude-code",
      hookDeadlineMilliseconds: 2_000,
      platform: "posix",
    });
    expect(
      createClaudeCodeInstallationPlanner(
        "uninstall",
        foreignInvocation,
        emptyInventory(),
      )(target(installedText)),
    ).toEqual({ kind: "conflict" });

    const tampered = parseRecord(installedText);
    const hooks = parseRecord(JSON.stringify(tampered.hooks));
    const stop = hooks.Stop;
    if (!Array.isArray(stop) || stop.length !== 1)
      throw new Error("expected owned Stop hook");
    const matcher = parseRecord(JSON.stringify(stop[0]));
    const metadata = parseRecord(JSON.stringify(matcher.agentscope));
    metadata.ownershipIdentity = "agentscope-hook-v1-sha256-tampered";
    matcher.agentscope = metadata;
    hooks.Stop = [matcher];
    tampered.hooks = hooks;
    expect(
      createClaudeCodeInstallationPlanner(
        "uninstall",
        invocation,
        emptyInventory(),
      )(target(JSON.stringify(tampered))),
    ).toEqual({ kind: "conflict" });
  });
});

describe("Claude Code malformed inventory containers", () => {
  it("fails closed for malformed runtime plugin inventory", () => {
    const accessorInventory = Object.defineProperty(
      { installedPlugins: [] },
      "settingsLayers",
      { enumerable: true, get: () => [] },
    );
    class CustomInventory {
      public readonly installedPlugins = [];
      public readonly settingsLayers = [];
    }
    const customInventory = new CustomInventory();
    const throwingRecord = new Proxy(
      { installedPlugins: [], settingsLayers: [] },
      {
        getPrototypeOf: () => {
          throw new Error("hostile prototype");
        },
      },
    );
    const throwingArray = new Proxy([], {
      getPrototypeOf: () => {
        throw new Error("hostile array prototype");
      },
    });
    const symbolRecord = {
      installedPlugins: [],
      settingsLayers: [],
      [Symbol("hidden")]: true,
    };
    const symbolArray: unknown[] = [];
    Object.defineProperty(symbolArray, Symbol("hidden"), { value: true });
    const accessorArray: unknown[] = [undefined];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => undefined,
    });
    for (const malformed of [
      null,
      1,
      {},
      throwingRecord,
      symbolRecord,
      { installedPlugins: [], settingsLayers: null },
      { installedPlugins: [], settingsLayers: throwingArray },
      { installedPlugins: [], settingsLayers: symbolArray },
      { installedPlugins: [], settingsLayers: accessorArray },
      { installedPlugins: [], settingsLayers: new Array(1_025) },
      { installedPlugins: [], settingsLayers: [null] },
      { installedPlugins: [null], settingsLayers: [] },
      { installedPlugins: [{}], settingsLayers: [] },
      accessorInventory,
      customInventory,
    ]) {
      const inventory = malformed as ClaudeCodePluginInventory;
      expect(inspectClaudeCodePluginOverlap(inventory)).toEqual({
        status: "ambiguous",
      });
      expect(
        createClaudeCodeInstallationPlanner(
          "install",
          invocation,
          inventory,
        )(target("{}")),
      ).toEqual({ kind: "conflict" });
    }
  });
});

describe("Claude Code hostile plugin records", () => {
  it("rejects hostile array proxies before caller behavior", () => {
    let lengthReads = 0;
    const hostileLayers = new Proxy(officialInventory().settingsLayers, {
      get: (targetValue, property, receiver) => {
        if (property === "length") {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 0;
        }
        return Reflect.get(targetValue, property, receiver) as unknown;
      },
    });
    expect(
      inspectClaudeCodePluginOverlap({
        settingsLayers: hostileLayers,
        installedPlugins: [officialPlugin()],
      }),
    ).toEqual({ status: "ambiguous" });
    expect(lengthReads).toBe(0);
  });

  it("rejects duplicate orphan and normalization-equivalent identities", () => {
    const first = orphanPlugin("orphan-exporter");
    const duplicateInventories: ClaudeCodePluginInventory[] = [
      {
        settingsLayers: [],
        installedPlugins: [first, { ...first }],
      },
      {
        settingsLayers: [],
        installedPlugins: [first, orphanPlugin(" ORPHAN-EXPORTER ")],
      },
      {
        settingsLayers: [
          {
            scope: "user",
            targetPath: targetPathByScope.user,
            targetDigest,
            targetExists: true,
            enabledPlugins: { "orphan-exporter": false },
          },
          {
            scope: "project",
            targetPath: targetPathByScope.project,
            targetDigest,
            targetExists: true,
            enabledPlugins: { "other-exporter": false },
          },
        ],
        installedPlugins: [
          first,
          orphanPlugin("other-exporter", {
            cachePluginId: "ORPHAN-EXPORTER",
          }),
        ],
      },
    ];
    for (const inventory of duplicateInventories) {
      expect(inspectClaudeCodePluginOverlap(inventory)).toEqual({
        status: "ambiguous",
      });
      expect(
        createClaudeCodeInstallationPlanner(
          "install",
          invocation,
          inventory,
        )(target("{}")),
      ).toEqual({ kind: "conflict" });
    }
  });
});

describe("Claude Code malformed plugin fields", () => {
  it("rejects every malformed layer and plugin field without invoking accessors", () => {
    const enabledAccessor = Object.defineProperty({}, "official", {
      enumerable: true,
      get: () => true,
    });
    const throwingEnabled = new Proxy(
      { official: true },
      {
        getPrototypeOf: () => {
          throw new Error("hostile enabledPlugins prototype");
        },
      },
    );
    const enabledSymbol = { official: true, [Symbol("hidden")]: true };
    const baseLayer = officialInventory().settingsLayers[0]!;
    const malformedLayers: unknown[] = [
      { ...baseLayer, scope: "unknown" },
      { ...baseLayer, targetPath: "relative/settings.json" },
      { ...baseLayer, targetPath: "/isolated/../settings.json" },
      { ...baseLayer, targetDigest: "bad" },
      { ...baseLayer, enabledPlugins: null },
      { ...baseLayer, enabledPlugins: throwingEnabled },
      { ...baseLayer, enabledPlugins: enabledAccessor },
      { ...baseLayer, enabledPlugins: enabledSymbol },
      { ...baseLayer, enabledPlugins: { "": true } },
      { ...baseLayer, enabledPlugins: { official: "yes" } },
    ];
    const basePlugin = officialPlugin();
    const malformedPlugins: unknown[] = [
      { ...basePlugin, hookEvents: null },
      { ...basePlugin, hookEvents: [1] },
      { ...basePlugin, pluginId: "" },
      { ...basePlugin, manifestDigest: "bad" },
      { ...basePlugin, hooksDigest: "bad" },
      { ...basePlugin, directTraceExporter: "yes" },
    ];
    for (const settingsLayer of malformedLayers) {
      expect(
        inspectClaudeCodePluginOverlap({
          settingsLayers: [settingsLayer],
          installedPlugins: [basePlugin],
        } as ClaudeCodePluginInventory),
      ).toEqual({ status: "ambiguous" });
    }
    for (const plugin of malformedPlugins) {
      expect(
        inspectClaudeCodePluginOverlap({
          settingsLayers: [baseLayer],
          installedPlugins: [plugin],
        } as ClaudeCodePluginInventory),
      ).toEqual({ status: "ambiguous" });
    }
  });
});

describe("Claude Code hostile settings state", () => {
  it("rejects ambiguous and malformed settings", () => {
    const ambiguous = {
      settingsLayers: officialInventory().settingsLayers,
      installedPlugins: [],
    };
    expect(
      createClaudeCodeInstallationPlanner(
        "migrate",
        invocation,
        ambiguous,
      )(target("{}")),
    ).toEqual({ kind: "conflict" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target("[]")),
    ).toEqual({ kind: "unsupported" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target("{")),
    ).toEqual({ kind: "unsupported" });
    for (const malformed of [
      '{"bad\\q":true}',
      '{"unterminated',
      '{"nested":[1,',
    ]) {
      expect(
        createClaudeCodeInstallationPlanner(
          "install",
          invocation,
          emptyInventory(),
        )(target(malformed)),
      ).toEqual({ kind: "unsupported" });
    }
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target("vendor-observability-hook")),
    ).toEqual({ kind: "unsupported" });
    expect(
      createClaudeCodeInstallationPlanner(
        "migrate",
        invocation,
        emptyInventory(),
      )(target("vendor-observability-hook")),
    ).toEqual({ kind: "unsupported" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(binaryTarget(new Uint8Array([0xff]))),
    ).toEqual({ kind: "unsupported" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target('{"hooks":{"Stop":{}}}')),
    ).toEqual({ kind: "conflict" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target('{"hooks":[]}')),
    ).toEqual({ kind: "conflict" });
  });

  it.each([
    '{"enabledPlugins":{},"enabledPlugins":{"langfuse-observability@claude-plugins-official":true}}',
    '{"enabledPlugins":{},"enabled\\u0050lugins":{"langfuse-observability@claude-plugins-official":true}}',
    '{"hooks":{"Stop":[],"Stop":[]}}',
  ])("rejects duplicate decoded JSON object keys", (settings) => {
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target(settings)),
    ).toEqual({ kind: "unsupported" });
  });

  it("bounds settings size and structural depth before mutation", () => {
    const oversized = `{"value":"${"x".repeat(1_048_576)}"}`;
    const tooDeep = `${'{"nested":'.repeat(130)}null${"}".repeat(130)}`;
    for (const settings of [oversized, tooDeep]) {
      expect(
        createClaudeCodeInstallationPlanner(
          "install",
          invocation,
          emptyInventory(),
        )(target(settings)),
      ).toEqual({ kind: "unsupported" });
    }
  });
});

describe("Claude Code numeric settings preservation", () => {
  it.each(["9007199254740993", "1e400", "-0", "1.0", "1e0", "1E+0", "1e+21"])(
    "rejects an unstable unrelated numeric token %s",
    (numericToken) => {
      expect(
        createClaudeCodeInstallationPlanner(
          "install",
          invocation,
          emptyInventory(),
        )(target(`{"foreign":${numericToken}}`)),
      ).toEqual({ kind: "unsupported" });
    },
  );

  it.each(["0", "-1", "1.5", "1e-7"])(
    "preserves a canonical finite numeric token %s",
    (numericToken) => {
      const decision = createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target(`{"foreign":${numericToken}}`));
      expect(decision.kind).toBe("replace");
      expect(parseRecord(decisionText(decision)).foreign).toBe(
        JSON.parse(numericToken),
      );
    },
  );
});

describe("Claude Code hostile hook ownership state", () => {
  it("rejects partial, tampered, and duplicate ownership", () => {
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(
        target(
          JSON.stringify({
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: invocation.launcherPath,
                      args: [],
                    },
                  ],
                },
              ],
            },
          }),
        ),
      ),
    ).toEqual({ kind: "conflict" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(
        target(
          JSON.stringify({
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: invocation.launcherPath,
                      args: ["tampered"],
                    },
                  ],
                },
              ],
            },
          }),
        ),
      ),
    ).toEqual({ kind: "conflict" });
    expect(
      createClaudeCodeInstallationPlanner(
        "migrate",
        invocation,
        officialInventory(),
      )(target('{"enabledPlugins":[]}')),
    ).toEqual({ kind: "conflict" });

    const installed = decisionText(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(false),
      )(target()),
    );
    const duplicatedSettings = parseRecord(installed);
    const hooks = parseRecord(JSON.stringify(duplicatedSettings.hooks));
    const stop: unknown = hooks.Stop;
    if (!Array.isArray(stop)) throw new Error("expected Stop hook array");
    hooks.Stop = [
      ...(stop as readonly unknown[]),
      ...(stop as readonly unknown[]),
    ];
    duplicatedSettings.hooks = hooks;
    const duplicated = JSON.stringify(duplicatedSettings);
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target(duplicated)),
    ).toEqual({ kind: "conflict" });

    const partialSettings = parseRecord(installed);
    const partialHooks = parseRecord(JSON.stringify(partialSettings.hooks));
    delete partialHooks.SessionEnd;
    partialSettings.hooks = partialHooks;
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target(JSON.stringify(partialSettings))),
    ).toEqual({ kind: "conflict" });
  });
});

describe("Claude Code fail-open behavior", () => {
  it("fails open on hook errors, prior abort, and deadline abort", async () => {
    await expect(
      runClaudeCodeHook("failure", new AbortController().signal),
    ).resolves.toBe("failed-open");
    const prior = new AbortController();
    prior.abort();
    await expect(runClaudeCodeHook("hang", prior.signal)).resolves.toBe(
      "failed-open",
    );
    const deadline = new AbortController();
    const result = runClaudeCodeHook("hang", deadline.signal);
    deadline.abort();
    await expect(result).resolves.toBe("failed-open");
  });
});
