import { describe, expect, it } from "vitest";
import {
  createOwnedHarnessHookInvocation,
  type HarnessTargetDecision,
} from "@agentscope/harnesses-core";
import { claudeCodeDescriptor } from "./descriptor.js";
import {
  CLAUDE_CODE_LIFECYCLE_EVENTS,
  createClaudeCodeDialectAuthority,
  createClaudeCodeInstallationPlanner as planner,
} from "./lifecycle.js";
const invocation = createOwnedHarnessHookInvocation({
  agentscopeHome: "/opt/agentscope",
  harnessType: claudeCodeDescriptor.harnessType,
  hookDeadlineMilliseconds: 2000,
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
if (dialect === undefined) throw Error("expected dialect");
const emptyInventory = (exists = true) => ({
  settingsLayers: [
    {
      scope: "user" as const,
      targetPath: "/isolated/.claude/settings.json",
      targetDigest: "0".repeat(64),
      targetExists: exists,
      enabledPlugins: {},
    },
  ],
  installedPlugins: [],
});
const target = (text?: string) => ({
  targetPath: "/isolated/.claude/settings.json",
  exists: text !== undefined,
  bytes: text === undefined ? null : new TextEncoder().encode(text),
  digest: "0".repeat(64),
  mode: text === undefined ? null : 0o600,
});
const createClaudeCodeInstallationPlanner = (
  operation: Parameters<typeof planner>[0],
  owned: Parameters<typeof planner>[1],
  inventory: Parameters<typeof planner>[2],
) => planner(operation, owned, inventory, dialect);
const decisionText = (decision: HarnessTargetDecision) => {
  if (decision.kind !== "replace" && decision.kind !== "replace-overlap")
    throw Error("expected replacement");
  return new TextDecoder().decode(decision.bytes);
};

describe("Claude ADR008 owned profile", () => {
  const legacy = (): { hooks: Record<string, unknown[]> } => ({
    hooks: Object.fromEntries(
      CLAUDE_CODE_LIFECYCLE_EVENTS.map((event) => [
        event,
        [
          {
            agentscope: {
              contractVersion: invocation.contractVersion,
              event,
              harnessType: invocation.harnessType,
              ownershipIdentity: invocation.ownershipIdentity,
            },
            hooks: [
              { type: "command", command: invocation.launcherPath, args: [] },
            ],
          },
        ],
      ]),
    ),
  });
  it.each([50, 1000, 1001, 5000, 60000])(
    "binds exact timeout to duration %i",
    (duration) => {
      const owned = createOwnedHarnessHookInvocation({
        agentscopeHome: "/opt/agentscope",
        harnessType: invocation.harnessType,
        hookDeadlineMilliseconds: duration,
        platform: "posix",
      });
      const text = decisionText(
        createClaudeCodeInstallationPlanner(
          "install",
          owned,
          emptyInventory(false),
        )(target()),
      );
      expect(text).toContain(
        `"timeout": ${Math.ceil((duration + 2000) / 1000)}`,
      );
      expect(text).not.toContain('"SessionEnd"');
    },
  );
  it("upgrades exact legacy ownership and preserves foreign SessionEnd", () => {
    const install = createClaudeCodeInstallationPlanner(
      "install",
      invocation,
      emptyInventory(),
    );
    const old = legacy();
    old.hooks.SessionEnd!.push({
      hooks: [{ type: "command", command: "/usr/bin/printf", args: [] }],
    });
    const upgraded = decisionText(install(target(JSON.stringify(old))));
    expect(upgraded).toContain("/usr/bin/printf");
    expect(upgraded).toContain('"timeout": 4');
    expect(install(target(upgraded))).toEqual({ kind: "unchanged" });
    const removed = decisionText(
      createClaudeCodeInstallationPlanner(
        "uninstall",
        invocation,
        emptyInventory(),
      )(target(upgraded)),
    );
    expect(removed).toContain("/usr/bin/printf");
    expect(removed).not.toContain(invocation.ownershipIdentity);
  });
  it("removes an exact old standalone profile and rejects partial uninstall", () => {
    const uninstall = createClaudeCodeInstallationPlanner(
      "uninstall",
      invocation,
      emptyInventory(),
    );
    expect(uninstall(target(JSON.stringify(legacy(), null, 2) + "\n"))).toEqual(
      { kind: "remove" },
    );
    const old = legacy();
    delete old.hooks.Stop;
    expect(uninstall(target(JSON.stringify(old)))).toEqual({
      kind: "conflict",
    });
  });
});

describe("Claude profile substitution refusal", () => {
  it.each(["timeout", "mixed", "duplicate", "partial"])(
    "rejects %s owned profiles",
    (fault) => {
      const install = createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      );
      const bytes = createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(false),
      )(target());
      const current = decisionText(bytes);
      let changed: string;
      if (fault === "timeout")
        changed = current.replaceAll('"timeout": 4', '"timeout": 5');
      else {
        const settings = JSON.parse(current) as {
          hooks: Record<string, unknown[]>;
        };
        if (fault === "partial") delete settings.hooks.Stop;
        else if (fault === "duplicate")
          settings.hooks.Stop!.push(settings.hooks.Stop![0]);
        else
          settings.hooks.SessionEnd = [
            {
              agentscope: {
                contractVersion: invocation.contractVersion,
                event: "SessionEnd",
                harnessType: invocation.harnessType,
                ownershipIdentity: invocation.ownershipIdentity,
              },
              hooks: [
                { type: "command", command: invocation.launcherPath, args: [] },
              ],
            },
          ];
        changed = JSON.stringify(settings);
      }
      expect(changed).not.toBe(current);
      expect(install(target(changed))).toEqual({ kind: "conflict" });
      expect(
        createClaudeCodeInstallationPlanner(
          "uninstall",
          invocation,
          emptyInventory(),
        )(target(changed)),
      ).toEqual({ kind: "conflict" });
    },
  );
});
