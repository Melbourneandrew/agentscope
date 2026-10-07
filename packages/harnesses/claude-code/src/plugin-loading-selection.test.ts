import { describe, expect, it } from "vitest";
import { createOwnedHarnessHookInvocation } from "@agentscope/harnesses-core";
import {
  CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID as officialId,
  CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
  createClaudeCodeDialectAuthority,
  createClaudeCodeInstallationPlanner,
} from "./lifecycle.js";
import { claudeCodeDescriptor } from "./descriptor.js";
import {
  inspectPluginOverlap,
  parsePluginInventory,
  type ClaudeCodeInstalledPlugin,
  type ClaudeCodePluginSettingsLayer,
} from "./plugin-inventory.js";
import { parsePluginLoadSelections } from "./plugin-loading-selection.js";

const oldId = "old@market";
const canonicalId = "current@market";
const path = "/isolated/.claude/settings.json";
const digest = "0".repeat(64);
const plugin = (pluginId = canonicalId): ClaudeCodeInstalledPlugin => ({
  pluginId,
  installedRegistryId: pluginId,
  cachePluginId: pluginId,
  manifestName: "exporter",
  manifestVersion: null,
  manifestDigest: `sha256-${"a".repeat(64)}`,
  hooksDigest: null,
  hookEvents: ["Stop"],
  directTraceExporter: true,
});
const inventory = (
  enabledPlugins: ClaudeCodePluginSettingsLayer["enabledPlugins"] = {
    [oldId]: true,
  },
  loadSelections: unknown = { [oldId]: canonicalId },
  installedPlugins = [plugin()],
) => ({
  settingsLayers: [
    {
      scope: "user",
      targetPath: path,
      targetDigest: digest,
      targetExists: true,
      enabledPlugins,
    },
  ],
  installedPlugins,
  loadSelections,
});

describe("Claude plugin loading projection", () => {
  it("selects canonical records but retains original settings identity and scope", () => {
    const value = inventory();
    const parsed = parsePluginInventory(value);
    expect(parsed?.settingsLayers[0]?.enabledPlugins).toEqual({
      [oldId]: true,
    });
    expect(inspectPluginOverlap(value)).toEqual({
      status: "conflict",
      pluginId: oldId,
      effectiveScope: "user",
      targetPath: path,
      targetDigest: digest,
    });
    expect(value.settingsLayers[0]?.enabledPlugins).toEqual({ [oldId]: true });
  });

  it("keeps absent-projection identity semantics", () => {
    const observed = inventory({
      [canonicalId]: true,
    });
    const value = {
      settingsLayers: observed.settingsLayers,
      installedPlugins: observed.installedPlugins,
    };
    expect(parsePluginInventory(value)?.loadSelections).toBeUndefined();
    expect(inspectPluginOverlap(value)).toMatchObject({
      status: "conflict",
      pluginId: canonicalId,
    });
  });

  it("suppresses removed selections without looking up stale cache records", () => {
    expect(
      inspectPluginOverlap(inventory({ [oldId]: true }, { [oldId]: null }, [])),
    ).toEqual({ status: "absent" });
    expect(
      inspectPluginOverlap(inventory({ [oldId]: true }, { [oldId]: oldId })),
    ).toEqual({ status: "ambiguous" });
  });

  it.each([true, false])(
    "preserves canonical original dedup including disabled (%s)",
    (enabled) => {
      const value = inventory(
        { [oldId]: true, [canonicalId]: enabled },
        { [oldId]: null, [canonicalId]: canonicalId },
      );
      expect(parsePluginInventory(value)).toBeDefined();
      expect(inspectPluginOverlap(value)).toMatchObject(
        enabled
          ? { status: "conflict", pluginId: canonicalId }
          : { status: "absent" },
      );
      expect(
        parsePluginInventory({
          ...value,
          loadSelections: { [oldId]: canonicalId, [canonicalId]: canonicalId },
        }),
      ).toBeUndefined();
    },
  );
});

describe("Claude raw-state loading projection", () => {
  it.each([{ state: [] }, { state: ["constraint"] }])(
    "allows array entry renames without hook enablement (%j)",
    ({ state }) => {
      for (const selected of [canonicalId, null]) {
        const value = inventory({ [oldId]: state }, { [oldId]: selected });
        expect(parsePluginInventory(value)).toBeDefined();
        expect(inspectPluginOverlap(value)).toEqual({ status: "absent" });
      }
    },
  );

  it("excludes undefined keys from the finite loading projection", () => {
    expect(
      parsePluginInventory(inventory({ [oldId]: undefined }, {}, [])),
    ).toBeDefined();
    expect(
      parsePluginInventory(
        inventory({ [oldId]: undefined }, { [oldId]: oldId }, []),
      ),
    ).toBeUndefined();
  });
});

describe("Claude loading projection consistency", () => {
  it("binds the projection to effective scoped settings without relabeling scope", () => {
    const user = inventory().settingsLayers[0]!;
    const value = {
      ...inventory(),
      settingsLayers: [
        user,
        {
          ...user,
          scope: "project",
          targetPath: "/isolated/project/.claude/settings.json",
        },
      ],
    };
    expect(inspectPluginOverlap(value)).toMatchObject({
      status: "conflict",
      pluginId: oldId,
      effectiveScope: "project",
      targetPath: "/isolated/project/.claude/settings.json",
    });
    expect(
      parsePluginInventory({
        ...value,
        settingsLayers: [
          user,
          {
            ...value.settingsLayers[1]!,
            enabledPlugins: { [oldId]: false },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("permits one alias and a suppressed later duplicate", () => {
    const enabled = { [oldId]: true, "second@market": true };
    expect(
      parsePluginInventory(
        inventory(enabled, {
          [oldId]: canonicalId,
          "second@market": null,
        }),
      ),
    ).toBeDefined();
    expect(
      parsePluginInventory(
        inventory(enabled, {
          [oldId]: canonicalId,
          "second@market": canonicalId,
        }),
      ),
    ).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { unknown: canonicalId },
    { [oldId]: false },
    { [oldId]: "" },
    { [oldId]: "other@foreign" },
    { [oldId]: "invalid" },
    { [oldId]: "current@market", extra: null },
  ])("rejects incomplete or inconsistent projection %j", (selection) => {
    expect(
      parsePluginInventory({ ...inventory(), loadSelections: selection }),
    ).toBeUndefined();
  });

  it.each([null, canonicalId])(
    "does not rename disabled original selections (%s)",
    (selected) => {
      expect(
        parsePluginInventory(
          inventory({ [oldId]: false }, { [oldId]: selected }),
        ),
      ).toBeUndefined();
      expect(
        parsePluginInventory(inventory({ [oldId]: false }, { [oldId]: oldId })),
      ).toBeDefined();
    },
  );

  it("never relaxes canonical registry/cache equality", () => {
    for (const key of ["installedRegistryId", "cachePluginId"] as const)
      expect(
        inspectPluginOverlap(
          inventory(undefined, undefined, [
            {
              ...plugin(),
              [key]: oldId,
            },
          ]),
        ),
      ).toEqual({ status: "ambiguous" });
  });

  it("copies and freezes the projection before caller mutation", () => {
    const selections = { [oldId]: canonicalId };
    const parsed = parsePluginInventory(inventory(undefined, selections));
    expect(Object.isFrozen(parsed?.loadSelections)).toBe(true);
    selections[oldId] = "later@market";
    expect(parsed?.loadSelections).toEqual({ [oldId]: canonicalId });
  });
});

describe("Claude loading projection hostile boundary", () => {
  it("rejects getters, proxies, symbols and exotic prototypes without observation", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, oldId, {
      enumerable: true,
      get() {
        reads += 1;
        return canonicalId;
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          reads += 1;
          throw new Error("trap");
        },
      },
    );
    for (const value of [
      getter,
      proxy,
      Object.create(null),
      { [oldId]: canonicalId, [Symbol("extra")]: null },
    ])
      expect(parsePluginInventory(inventory(undefined, value))).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("enforces the same byte and entry bounds", () => {
    const effective = new Map([[oldId, { enabled: true }]]);
    expect(
      parsePluginLoadSelections({ [oldId]: canonicalId }, effective, {
        remainingBytes: oldId.length + canonicalId.length - 1,
      }),
    ).toBeUndefined();
    expect(
      parsePluginInventory(
        inventory(undefined, {
          [oldId]: `${"a".repeat(513)}@market`,
        }),
      ),
    ).toBeUndefined();
    const oversized = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`p${index}@market`, true]),
    );
    expect(
      parsePluginInventory(inventory(oversized, oversized)),
    ).toBeUndefined();
    const tooMany = new Map(
      Array.from(
        { length: 1_025 },
        (_, index) => [`p${index}@market`, { enabled: false }] as const,
      ),
    );
    expect(
      parsePluginLoadSelections({}, tooMany, { remainingBytes: 96 * 1_024 }),
    ).toBeUndefined();
  });

  it("preserves own literal prototype-like settings keys under identity semantics", () => {
    const enabled = JSON.parse(
      '{"__proto__":false,"constructor":false}',
    ) as Record<string, boolean>;
    const selection = JSON.parse(
      '{"__proto__":"__proto__","constructor":"constructor"}',
    ) as unknown;
    const parsed = parsePluginInventory(inventory(enabled, selection, []));
    expect(parsed?.loadSelections).toEqual(selection);
    expect(inspectPluginOverlap(inventory(enabled, selection, []))).toEqual({
      status: "absent",
    });
  });
});

describe("Claude aliases never authorize official migration", () => {
  const official = {
    ...plugin(officialId),
    manifestName: "langfuse-observability",
    manifestVersion: "1.0.0",
    manifestDigest: CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
    hooksDigest: CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
    hookEvents: ["Stop", "SessionEnd"],
  };
  const dialect = createClaudeCodeDialectAuthority(
    {
      harnessType: claudeCodeDescriptor.harnessType,
      state: "installed",
      reason: "compatible",
      version: "2.1.245",
      configurationLocations: [{ locationIndex: 0, present: true }],
    },
    "posix",
  );
  const invocation = createOwnedHarnessHookInvocation({
    agentscopeHome: "/opt/agentscope",
    harnessType: "@agentscope/harness-claude-code",
    hookDeadlineMilliseconds: 2_000,
    platform: "posix",
  });

  it("returns the original alias conflict and refuses migration", () => {
    const alias = "previous@claude-plugins-official";
    const value = inventory({ [alias]: true }, { [alias]: officialId }, [
      official,
    ]);
    expect(inspectPluginOverlap(value)).toMatchObject({
      status: "conflict",
      pluginId: alias,
    });
    const parsed = parsePluginInventory(value);
    if (parsed === undefined) throw new Error("expected parsed inventory");
    if (dialect === undefined) throw new Error("expected dialect");
    for (const operation of ["install", "migrate"] as const) {
      const decision = createClaudeCodeInstallationPlanner(
        operation,
        invocation,
        parsed,
        dialect,
      )({
        targetPath: path,
        digest,
        exists: true,
        mode: 0o600,
        bytes: new TextEncoder().encode(
          JSON.stringify({ enabledPlugins: { [alias]: true } }),
        ),
      });
      expect(decision).toEqual({ kind: "conflict" });
    }
  });

  it("does not grant official migration when original official selects another load", () => {
    const renamed = "new@claude-plugins-official";
    expect(
      inspectPluginOverlap(
        inventory({ [officialId]: true }, { [officialId]: renamed }, [
          plugin(renamed),
        ]),
      ),
    ).toEqual({ status: "ambiguous" });
  });
});
