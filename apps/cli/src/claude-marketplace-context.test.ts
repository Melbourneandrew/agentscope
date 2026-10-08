import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inspectClaudeCodePluginOverlap,
  createClaudeCodeDialectAuthority,
  claudeCodeDescriptor,
} from "@agentscope/harness-claude-code";

import { createProductHarnessInstallationInput } from "./product-harness-installation.js";

import { createClaudeContextFixtures } from "./__tests__/claude-plugin-context-fixture.js";

const { cachedContext } = createClaudeContextFixtures();

describe("selected cached marketplace observations", () => {
  it("discovers only the selected record documents and re-elects from fresh Core data", async () => {
    const value = await cachedContext();
    const empty = join(value.root, "marker-cache"),
      unused = join(value.root, "unused-cache");
    await mkdir(join(empty, "node_modules"), { recursive: true });
    await mkdir(join(unused, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(unused, ".claude-plugin", "plugin.json"),
      "INVALID-UNSELECTED-CANARY",
    );
    const paths = [empty, value.plugin, unused];
    await writeFile(
      join(value.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ordinary@market": paths.map((installPath) => ({
            scope: "user",
            installPath,
          })),
        },
      }),
    );
    // This case tests cache election, not an unknown overlapping Stop hook.
    await writeFile(
      join(value.catalog, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "market",
        plugins: [{ name: "ordinary", source: "./ordinary" }],
      }),
    );
    const context = await value.read();
    expect(context.pluginInventory).not.toBeNull();
    if (context.pluginInventory === null)
      throw new Error("missing selected inventory");
    expect(inspectClaudeCodePluginOverlap(context.pluginInventory)).toEqual({
      status: "absent",
    });
    expect(
      context.cacheElections[0]?.candidates.map(
        (candidate) => candidate.plugin === null,
      ),
    ).toEqual([true, false, true]);
    expect(
      context.readGuards.some((guard) =>
        guard.targetPath.startsWith(`${unused}/`),
      ),
    ).toBe(false);
    const authority = createClaudeCodeDialectAuthority(
      {
        configurationLocations: [{ locationIndex: 0, present: true }],
        harnessType: claudeCodeDescriptor.harnessType,
        state: "installed",
        reason: "compatible",
        version: "2.1.245",
      },
      "posix",
    );
    if (authority === undefined) throw new Error("fixture.authority");
    const input = createProductHarnessInstallationInput({
      harness: "claude-code",
      dialectAuthority: authority,
      ...context,
      agentscopeHome: value.root,
      hookConfigurationPath: join(value.home, ".claude", "settings.json"),
      hookDeadlineMilliseconds: 250,
      machineEntryPath: join(value.root, "machine.js"),
      mutationDirectory: join(value.root, "mutations"),
      nodeExecutable: process.execPath,
      operation: "install",
      releaseIdentity: "0.1.0",
    });
    expect(input.directoryPaths).toEqual([
      ...paths.slice(0, 2),
      ...context.settingsDirectorySelections.map(
        (entry) => entry.directoryPath,
      ),
    ]);
    const settingsPath = join(value.home, ".claude", "settings.json");
    const settingsGuard = context.readGuards.find(
      (guard) => guard.targetPath === settingsPath,
    );
    if (settingsGuard === undefined) throw new Error("fixture.settings");
    const target = {
      ...settingsGuard,
      bytes: Buffer.from(
        JSON.stringify({ enabledPlugins: { "ordinary@market": true } }),
      ),
    };
    const observed = [
      ...paths.slice(0, 2).map((directoryPath, index) => ({
        directoryPath,
        exists: true,
        mode: 0o755,
        entries: [index === 0 ? "node_modules" : ".claude-plugin"],
      })),
      ...context.settingsDirectorySelections.map((selection) => ({
        directoryPath: selection.directoryPath,
        exists: selection.exists,
        mode: selection.exists ? 0o755 : null,
        entries: [...(selection.entries ?? [])],
      })),
    ];
    expect(input.planner(target, observed)).toMatchObject({ kind: "replace" });
    observed[0]!.entries = ["newly-eligible"];
    expect(() => input.planner(target, observed)).toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });
});
