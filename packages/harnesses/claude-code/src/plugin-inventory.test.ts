import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
  CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
  inspectClaudeCodePluginOverlap,
  type ClaudeCodeInstalledPlugin,
  type ClaudeCodePluginInventory,
} from "./lifecycle.js";
import {
  inspectParsedPluginOverlap,
  parsePluginInventory,
} from "./plugin-inventory.js";
const targetDigest = "0".repeat(64);
const targetPathByScope = {
  user: "/isolated/.claude/settings.json",
  project: "/isolated/project/.claude/settings.json",
  local: "/isolated/project/.claude/settings.local.json",
  managed: "/isolated/managed-settings.json",
} as const;
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

const inventoryFor = (
  plugin: ClaudeCodeInstalledPlugin,
  enabled = true,
): ClaudeCodePluginInventory => ({
  ...emptyInventory(),
  settingsLayers: [
    {
      ...emptyInventory().settingsLayers[0]!,
      enabledPlugins: { [plugin.pluginId]: enabled },
    },
  ],
  installedPlugins: [plugin],
});

describe("Claude Code observed plugin metadata", () => {
  it.each([null, "", "1.2.3"])(
    "preserves the observed optional version %j",
    (manifestVersion) => {
      const inventory = inventoryFor(
        orphanPlugin("ordinary", { manifestVersion }),
      );
      expect(
        parsePluginInventory(inventory)?.installedPlugins[0]!.manifestVersion,
      ).toBe(manifestVersion);
      expect(inspectClaudeCodePluginOverlap(inventory)).toEqual({
        status: "absent",
      });
    },
  );

  it("preserves authenticated absent manifest and default hooks independently", () => {
    const plugin = orphanPlugin("ordinary", {
      manifestName: null,
      manifestVersion: null,
      manifestDigest: null,
      hooksDigest: null,
      hookEvents: [],
      directTraceExporter: null,
    });
    const parsed = parsePluginInventory(inventoryFor(plugin));
    expect(parsed?.installedPlugins[0]).toEqual(plugin);
    expect(inspectClaudeCodePluginOverlap(inventoryFor(plugin))).toEqual({
      status: "absent",
    });
    expect(
      inspectClaudeCodePluginOverlap(
        inventoryFor({
          ...plugin,
          hooksDigest: `sha256-${"b".repeat(64)}`,
          hookEvents: ["Stop"],
        }),
      ),
    ).toEqual({ status: "ambiguous" });
  });

  it.each(["PreToolUse", "Stop"])(
    "permits inline/custom %s observations with no default hooks file",
    (event) => {
      const plugin = orphanPlugin("ordinary", {
        hooksDigest: null,
        hookEvents: [event],
        directTraceExporter: false,
      });
      expect(
        parsePluginInventory(inventoryFor(plugin))?.installedPlugins[0]!
          .hooksDigest,
      ).toBeNull();
      expect(inspectClaudeCodePluginOverlap(inventoryFor(plugin))).toEqual({
        status: "absent",
      });
    },
  );

  it.each([
    { manifestDigest: null },
    { manifestName: null },
    { manifestDigest: null, manifestName: null, manifestVersion: "" },
    { manifestName: "" },
    { manifestName: "with space" },
    { manifestVersion: 1 },
    { manifestVersion: undefined },
    { hooksDigest: undefined },
    { directTraceExporter: undefined },
    { hookEvents: ["Stop", "Stop"] },
  ])("rejects incoherent or malformed fields %j", (fields) => {
    const plugin = {
      ...orphanPlugin("ordinary"),
      ...fields,
    } as ClaudeCodeInstalledPlugin;
    expect(parsePluginInventory(inventoryFor(plugin))).toBeUndefined();
    expect(inspectClaudeCodePluginOverlap(inventoryFor(plugin))).toEqual({
      status: "ambiguous",
    });
  });

  it("uses the exact ASCII-space name rule without trimming observations", () => {
    const plugin = orphanPlugin("ordinary", { manifestName: "with\\ttab" });
    expect(
      parsePluginInventory(inventoryFor(plugin))?.installedPlugins[0]!
        .manifestName,
    ).toBe("with\\ttab");
  });
});

describe("Claude Code unknown and official exporter evidence", () => {
  it.each(["Stop", "SessionEnd"])(
    "rejects unknown exporter classification only on enabled %s overlap",
    (event) => {
      const plugin = orphanPlugin("ordinary", {
        hookEvents: [event],
        directTraceExporter: null,
      });
      expect(inspectClaudeCodePluginOverlap(inventoryFor(plugin))).toEqual({
        status: "ambiguous",
      });
      expect(
        inspectClaudeCodePluginOverlap(inventoryFor(plugin, false)),
      ).toEqual({ status: "absent" });
      expect(
        inspectClaudeCodePluginOverlap(
          inventoryFor({ ...plugin, hookEvents: ["PreToolUse"] }),
        ),
      ).toEqual({ status: "absent" });
      expect(
        inspectClaudeCodePluginOverlap(
          inventoryFor({ ...plugin, hookEvents: [], hooksDigest: null }),
        ),
      ).toEqual({ status: "absent" });
      expect(
        inspectClaudeCodePluginOverlap(
          inventoryFor({ ...plugin, directTraceExporter: true }),
        ),
      ).toEqual({ status: "conflict", pluginId: "ordinary" });
    },
  );

  it.each([
    { manifestName: null, manifestVersion: null, manifestDigest: null },
    { manifestVersion: null },
    { manifestVersion: "" },
    { hooksDigest: null },
    { directTraceExporter: null },
  ])("does not weaken the exact official exporter proof %j", (fields) => {
    expect(
      inspectClaudeCodePluginOverlap({
        ...officialInventory(),
        installedPlugins: [officialPlugin(fields)],
      }),
    ).toEqual({ status: "ambiguous" });
  });
});

describe("Claude Code bounded scoped plugin observations", () => {
  it.each([false, true, null])(
    "preserves nonoverlap for exporter classification %j",
    (directTraceExporter) => {
      const plugin = orphanPlugin("ordinary", {
        hookEvents: ["PreToolUse"],
        directTraceExporter,
      });
      expect(inspectClaudeCodePluginOverlap(inventoryFor(plugin))).toEqual({
        status: "absent",
      });
    },
  );

  it("allows missing unrelated settings with installed plugins", () => {
    const inventory = inventoryFor(orphanPlugin("ordinary"));
    const parsed = parsePluginInventory({
      ...inventory,
      settingsLayers: [
        ...inventory.settingsLayers,
        {
          scope: "local",
          targetPath: targetPathByScope.local,
          targetDigest,
          targetExists: false,
          enabledPlugins: {},
        },
      ],
    });
    expect(parsed?.settingsLayers).toHaveLength(2);
    expect(inspectClaudeCodePluginOverlap(parsed!)).toEqual({
      status: "absent",
    });
  });

  it("rejects duplicate scopes and duplicate consulted paths", () => {
    const layer = emptyInventory().settingsLayers[0]!;
    for (const duplicate of [
      layer,
      { ...layer, targetPath: targetPathByScope.project },
      { ...layer, scope: "project" as const },
    ]) {
      const inventory = {
        ...emptyInventory(),
        settingsLayers: [layer, duplicate],
      };
      expect(parsePluginInventory(inventory)).toBeUndefined();
      expect(inspectClaudeCodePluginOverlap(inventory)).toEqual({
        status: "ambiguous",
      });
    }
  });

  it.each(["manifestName", "manifestVersion"] as const)(
    "retains bounded string validation for %s",
    (field) => {
      const plugin = orphanPlugin("ordinary", { [field]: "a".repeat(513) });
      expect(parsePluginInventory(inventoryFor(plugin))).toBeUndefined();
    },
  );

  it("takes an immutable owned snapshot before later caller mutation", () => {
    const inventory = inventoryFor(
      orphanPlugin("ordinary", {
        hooksDigest: null,
        directTraceExporter: null,
        hookEvents: ["PreToolUse"],
      }),
    );
    const parsed = parsePluginInventory(inventory)!;
    const original = JSON.stringify(parsed);
    (inventory.installedPlugins[0]!.hookEvents as string[]).push("Stop");
    (inventory.settingsLayers[0]!.enabledPlugins as Record<string, boolean>)[
      "ordinary"
    ] = false;
    expect(JSON.stringify(parsed)).toBe(original);
    for (const value of [
      parsed,
      parsed.settingsLayers,
      parsed.settingsLayers[0],
      parsed.settingsLayers[0]!.enabledPlugins,
      parsed.installedPlugins,
      parsed.installedPlugins[0],
      parsed.installedPlugins[0]!.hookEvents,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("rejects metadata accessors and proxies without consulting them", () => {
    let effects = 0;
    const plugin = orphanPlugin("ordinary");
    const accessor = Object.defineProperty({ ...plugin }, "manifestName", {
      enumerable: true,
      get() {
        effects += 1;
        return null;
      },
    });
    const proxy = new Proxy(plugin, {
      getPrototypeOf() {
        effects += 1;
        return Object.prototype;
      },
    });
    for (const hostile of [accessor, proxy])
      expect(parsePluginInventory(inventoryFor(hostile))).toBeUndefined();
    expect(effects).toBe(0);
  });

  it("defensively refuses duplicate scopes at the private overlap boundary", () => {
    const inventory = inventoryFor(orphanPlugin("ordinary"));
    expect(
      inspectParsedPluginOverlap({
        ...inventory,
        settingsLayers: [
          inventory.settingsLayers[0]!,
          inventory.settingsLayers[0]!,
        ],
      }),
    ).toEqual({ status: "ambiguous" });
  });
});
