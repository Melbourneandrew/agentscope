import { describe, expect, it } from "vitest";
import { createOwnedHarnessHookInvocation } from "@agentscope/harnesses-core";
import {
  CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
  CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID,
  createClaudeCodeDialectAuthority,
  createClaudeCodeInstallationPlanner,
  type ClaudeCodePluginInventory,
  type ClaudeCodePluginSettingsLayer,
} from "./lifecycle.js";
import { claudeCodeDescriptor } from "./descriptor.js";
import {
  inspectParsedPluginOverlap,
  parsePluginInventory,
} from "./plugin-inventory.js";

const targetPath = "/isolated/.claude/settings.json";
const foreignPaths = {
  project: "/isolated/project/.claude/settings.json",
  local: "/isolated/project/.claude/settings.local.json",
  managed: "/isolated/managed-settings.json",
};
const digest = "0".repeat(64);
const pluginId = CLAUDE_CODE_OFFICIAL_LANGFUSE_PLUGIN_ID;
const invocation = createOwnedHarnessHookInvocation({
  agentscopeHome: "/opt/agentscope",
  harnessType: "@agentscope/harness-claude-code",
  hookDeadlineMilliseconds: 2_000,
  platform: "posix",
});
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
if (dialect === undefined) throw new Error("expected dialect");
const plugin = {
  pluginId,
  installedRegistryId: pluginId,
  cachePluginId: pluginId,
  manifestName: "langfuse-observability",
  manifestVersion: "1.0.0",
  manifestDigest: CLAUDE_CODE_LANGFUSE_PLUGIN_MANIFEST_DIGEST,
  hooksDigest: CLAUDE_CODE_LANGFUSE_HOOKS_DIGEST,
  hookEvents: ["Stop", "SessionEnd"],
  directTraceExporter: true,
};
const layer = (
  scope: ClaudeCodePluginSettingsLayer["scope"],
  enabledPlugins: Readonly<Record<string, boolean>> = {},
): ClaudeCodePluginSettingsLayer => ({
  scope,
  targetPath,
  targetDigest: digest,
  targetExists: true,
  enabledPlugins,
});
const inventory = (
  layers: readonly ClaudeCodePluginSettingsLayer[],
): ClaudeCodePluginInventory => ({
  settingsLayers: layers,
  installedPlugins: [plugin],
});
const decide = (
  operation: "install" | "migrate" | "uninstall",
  value: ClaudeCodePluginInventory,
  text = "{}",
  path = targetPath,
  targetDigest = digest,
) =>
  createClaudeCodeInstallationPlanner(
    operation,
    invocation,
    value,
    dialect,
  )({
    targetPath: path,
    digest: targetDigest,
    exists: true,
    bytes: new TextEncoder().encode(text),
    mode: 0o600,
  });
const enabled = { [pluginId]: true };
const enabledText = JSON.stringify({ enabledPlugins: enabled });

describe("Claude settings physical-target aliases", () => {
  it.each([false, true])(
    "preserves identical absent/present scoped observations (%s)",
    (targetExists) => {
      const layers = [layer("user"), layer("project")].map((item) => ({
        ...item,
        targetExists,
      }));
      const parsed = parsePluginInventory(inventory(layers));
      expect(parsed?.settingsLayers.map((item) => item.scope)).toEqual([
        "user",
        "project",
      ]);
      expect(parsed?.settingsLayers.every(Object.isFrozen)).toBe(true);
      if (parsed === undefined) throw new Error("expected parsed inventory");
      expect(inspectParsedPluginOverlap(parsed)).toEqual({ status: "absent" });
    },
  );

  it("compares canonical maps independently of insertion order and snapshots aliases", () => {
    const mutable = { a: false, b: false };
    const user = layer("user", mutable);
    const project = layer("project", { b: false, a: false });
    const parsed = parsePluginInventory(inventory([user, project]));
    expect(parsed).toBeDefined();
    expect(parsed?.settingsLayers[0]?.enabledPlugins).not.toBe(
      user.enabledPlugins,
    );
    expect(Object.isFrozen(parsed?.settingsLayers[1]?.enabledPlugins)).toBe(
      true,
    );
    mutable.a = true;
    expect(parsed?.settingsLayers[0]?.enabledPlugins).toEqual({
      a: false,
      b: false,
    });
  });

  it.each([
    { targetExists: false },
    { targetDigest: "1".repeat(64) },
    { enabledPlugins: { changed: false } },
    { enabledPlugins: { [pluginId]: false } },
    { scope: "user" as const },
  ])("rejects contradictory or duplicate observations %j", (change) => {
    expect(
      parsePluginInventory(
        inventory([
          layer("user", enabled),
          { ...layer("project", enabled), ...change },
        ]),
      ),
    ).toBeUndefined();
  });

  it("retains native project-effective scope and requires explicit migration", () => {
    const value = inventory([
      layer("project", enabled),
      layer("user", enabled),
    ]);
    const parsed = parsePluginInventory(value);
    if (parsed === undefined) throw new Error("expected parsed inventory");
    expect(inspectParsedPluginOverlap(parsed)).toEqual({
      status: "conflict",
      pluginId,
      effectiveScope: "project",
      targetPath,
      targetDigest: digest,
    });
    expect(decide("install", value, enabledText)).toEqual({ kind: "conflict" });
    const migrated = decide("migrate", value, enabledText);
    expect(migrated.kind).toBe("replace-overlap");
    if (migrated.kind !== "replace-overlap")
      throw new Error("expected migration");
    const settings = JSON.parse(new TextDecoder().decode(migrated.bytes)) as {
      enabledPlugins: unknown;
      hooks: Record<string, unknown>;
    };
    expect(settings.enabledPlugins).toEqual({ [pluginId]: false });
    expect(Object.keys(settings.hooks)).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
      "Stop",
    ]);
  });

  it("allows no-plugin installation but never substitutes the user preimage", () => {
    const value = {
      ...inventory([layer("user"), layer("project")]),
      installedPlugins: [],
    };
    expect(decide("install", value).kind).toBe("replace");
    expect(decide("install", value, "{}", "/unrelated/settings.json")).toEqual({
      kind: "conflict",
    });
    expect(decide("install", value, "{}", targetPath, "1".repeat(64))).toEqual({
      kind: "conflict",
    });
    expect(
      decide("migrate", inventory([layer("project", enabled)]), enabledText),
    ).toEqual({ kind: "conflict" });
  });
});

describe("Claude migration scope remains bounded", () => {
  it("never infers a physical alias from matching maps and digests at different paths", () => {
    const foreign = {
      ...layer("project", enabled),
      targetPath: foreignPaths.project,
    };
    const value = inventory([layer("user", enabled), foreign]);
    expect(parsePluginInventory(value)).toBeDefined();
    expect(decide("migrate", value, enabledText)).toEqual({ kind: "conflict" });
  });

  it("freezes the validated observations before later caller mutation", () => {
    const mutableMap = { [pluginId]: true };
    const value = inventory([
      layer("user", mutableMap),
      layer("project", mutableMap),
    ]);
    const planner = createClaudeCodeInstallationPlanner(
      "migrate",
      invocation,
      value,
      dialect,
    );
    mutableMap[pluginId] = false;
    expect(
      planner({
        targetPath,
        digest,
        exists: true,
        bytes: new TextEncoder().encode(enabledText),
        mode: 0o600,
      }).kind,
    ).toBe("replace-overlap");
  });

  it.each(["project", "local", "managed"] as const)(
    "keeps migration scoped to the user target with an observed %s exporter",
    (scope) => {
      const foreign = {
        ...layer(scope, enabled),
        targetPath: foreignPaths[scope],
      };
      const value = inventory([layer("user"), foreign]);
      for (const operation of ["install", "migrate"] as const)
        expect(decide(operation, value)).toEqual({ kind: "conflict" });
    },
  );
  it.each(["project", "local", "managed"] as const)(
    "refuses migration when %s owns an unrelated effective exporter",
    (scope) => {
      const foreign = {
        ...layer(scope, enabled),
        targetPath: foreignPaths[scope],
      };
      expect(decide("migrate", inventory([foreign]), enabledText)).toEqual({
        kind: "conflict",
      });
    },
  );
  it.each(["local", "managed"] as const)(
    "does not extend migration to an aliased %s scope",
    (scope) => {
      expect(
        decide(
          "migrate",
          inventory([layer("user", enabled), layer(scope, enabled)]),
          enabledText,
        ),
      ).toEqual({ kind: "conflict" });
    },
  );
  it.each([null, true] as const)(
    "retains ambiguous/nonofficial exporter refusal (%s)",
    (directTraceExporter) => {
      const value = inventory([
        layer("user", enabled),
        layer("project", enabled),
      ]);
      expect(
        decide(
          "migrate",
          {
            ...value,
            installedPlugins: [
              { ...plugin, directTraceExporter, manifestVersion: "unreviewed" },
            ],
          },
          enabledText,
        ),
      ).toEqual({ kind: "conflict" });
    },
  );
});
