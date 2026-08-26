import { describe, expect, it } from "vitest";

import {
  createOwnedHarnessHookInvocation,
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
  runClaudeCodeHook,
  type ClaudeCodeInstalledPlugin,
  type ClaudeCodePluginInventory,
} from "./lifecycle.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const invocation = createOwnedHarnessHookInvocation({
  agentscopeHome: "/opt/agentscope",
  harnessType: "@agentscope/harness-claude-code",
  hookDeadlineMilliseconds: 2_000,
  platform: "posix",
});

const target = (text?: string): HarnessTargetInspection => ({
  targetPath: "/isolated/.claude/settings.json",
  exists: text !== undefined,
  bytes: text === undefined ? null : encoder.encode(text),
  digest: "0".repeat(64),
  mode: text === undefined ? null : 0o600,
});

const binaryTarget = (bytes: Uint8Array): HarnessTargetInspection => ({
  targetPath: "/isolated/.claude/settings.json",
  exists: true,
  bytes,
  digest: "0".repeat(64),
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

const officialInventory = (): ClaudeCodePluginInventory => ({
  settingsLayers: [
    {
      scope: "user",
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
      { scope: "project" as const, enabledPlugins: { "other-exporter": true } },
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
          { scope: "local", enabledPlugins: { "unknown-plugin": true } },
        ],
        installedPlugins: [],
      }),
    ).toEqual({ status: "ambiguous" });
    expect(
      inspectClaudeCodePluginOverlap({
        settingsLayers: [
          { scope: "local", enabledPlugins: { "langfuse-alias": false } },
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
      createClaudeCodeInstallationPlanner("uninstall", invocation)(target()),
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
    const install = createClaudeCodeInstallationPlanner("install", invocation);
    const installed = install(target(JSON.stringify(foreign)));
    const installedText = decisionText(installed);
    const installedSettings = parseRecord(installedText);
    expect(installedSettings.theme).toBe("dark");
    expect(installedText).toContain("/foreign/exporter");
    expect(installedText).toContain(invocation.launcherPath);
    expect(install(target(installedText))).toEqual({ kind: "unchanged" });

    const uninstall = createClaudeCodeInstallationPlanner(
      "uninstall",
      invocation,
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
    )(target());
    const text = decisionText(decision);
    for (const event of CLAUDE_CODE_LIFECYCLE_EVENTS) {
      expect(text).toContain(`"${event}"`);
    }
    expect(text).toContain('"args": []');
    expect(text).not.toMatch(/[;&|`$<>]/u);
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

describe("Claude Code hostile lifecycle state", () => {
  it("rejects ambiguous, malformed, partial, and duplicate ownership", () => {
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
      createClaudeCodeInstallationPlanner("install", invocation)(target("[]")),
    ).toEqual({ kind: "unsupported" });
    expect(
      createClaudeCodeInstallationPlanner("install", invocation)(target("{")),
    ).toEqual({ kind: "unsupported" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
      )(binaryTarget(new Uint8Array([0xff]))),
    ).toEqual({ kind: "unsupported" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
      )(target('{"hooks":{"Stop":{}}}')),
    ).toEqual({ kind: "conflict" });
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
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
      createClaudeCodeInstallationPlanner("install", invocation)(target()),
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
      )(target(duplicated)),
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
