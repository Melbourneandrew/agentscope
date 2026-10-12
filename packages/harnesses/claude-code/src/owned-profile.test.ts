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

const profileFixture = (kind: "legacy" | "current" | "native") => ({
  hooks: Object.fromEntries(
    CLAUDE_CODE_LIFECYCLE_EVENTS.filter(
      (event) => kind === "legacy" || event !== "SessionEnd",
    ).map((event) => [
      event,
      [
        {
          ...(kind === "native"
            ? {}
            : {
                agentscope: {
                  contractVersion: invocation.contractVersion,
                  event,
                  harnessType: invocation.harnessType,
                  ownershipIdentity: invocation.ownershipIdentity,
                },
              }),
          hooks: [
            {
              type: "command",
              command: invocation.launcherPath,
              args: [],
              ...(kind === "legacy" ? {} : { timeout: 4 }),
            },
          ],
        },
      ],
    ]),
  ),
});

describe("native-only owned profile compatibility", () => {
  it("emits only the native handler representation", () => {
    const text = decisionText(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(false),
      )(target()),
    );
    expect(JSON.parse(text)).toEqual(profileFixture("native"));
    expect(text).not.toContain('"agentscope"');
  });
  it("recognizes exact native ownership without a custom group member", () => {
    const text = JSON.stringify(profileFixture("native"));
    expect(
      createClaudeCodeInstallationPlanner(
        "install",
        invocation,
        emptyInventory(),
      )(target(text)),
    ).toEqual({ kind: "unchanged" });
    expect(
      createClaudeCodeInstallationPlanner(
        "uninstall",
        invocation,
        emptyInventory(),
      )(target(text)),
    ).toEqual({ kind: "remove" });
  });
  it.each(["legacy", "current"] as const)(
    "upgrades exact %s metadata ownership without losing foreign settings",
    (kind) => {
      const old = { theme: "dark", ...profileFixture(kind) };
      const text = decisionText(
        createClaudeCodeInstallationPlanner(
          "install",
          invocation,
          emptyInventory(),
        )(target(JSON.stringify(old))),
      );
      expect(JSON.parse(text)).toEqual({
        theme: "dark",
        ...profileFixture("native"),
      });
      const removed = decisionText(
        createClaudeCodeInstallationPlanner(
          "uninstall",
          invocation,
          emptyInventory(),
        )(target(JSON.stringify(old))),
      );
      expect(JSON.parse(removed)).toEqual({ hooks: {}, theme: "dark" });
    },
  );
});

type MutableProfile = { hooks: Record<string, Array<Record<string, unknown>>> };
const alteredProfile = (
  kind: "legacy" | "current" | "native",
  fault: string,
) => {
  const value = profileFixture(kind) as MutableProfile;
  const group = value.hooks.Stop![0]!;
  const hook = (group.hooks as Array<Record<string, unknown>>)[0]!;
  switch (fault) {
    case "partial":
      delete value.hooks.Stop;
      break;
    case "duplicate":
      value.hooks.Stop!.push(group);
      break;
    case "mixed":
      value.hooks.Stop = profileFixture(
        kind === "native" ? "current" : "native",
      ).hooks.Stop!;
      break;
    case "command":
      hook.command = "/other/launcher";
      break;
    case "args":
      hook.args = ["extra"];
      break;
    case "timeout":
      hook.timeout = 5;
      break;
    case "group-extra":
      group.matcher = "*";
      break;
    case "handler-extra":
      hook.once = true;
      break;
    case "metadata":
      group.agentscope = { contractVersion: 2 };
      break;
    default:
      throw new Error("unknown profile fault");
  }
  return JSON.stringify(value);
};
describe.each(["legacy", "current", "native"] as const)(
  "complete uniform %s ownership",
  (kind) => {
    it("removes only the exact standalone representation", () => {
      expect(
        createClaudeCodeInstallationPlanner(
          "uninstall",
          invocation,
          emptyInventory(),
        )(target(JSON.stringify(profileFixture(kind)))),
      ).toEqual({ kind: "remove" });
    });
    it.each([
      "partial",
      "duplicate",
      "mixed",
      "command",
      "args",
      "timeout",
      "group-extra",
      "handler-extra",
      "metadata",
    ])("refuses %s without adopting owned-looking mutations", (fault) => {
      const changed = alteredProfile(kind, fault);
      for (const operation of ["install", "uninstall"] as const)
        expect(
          createClaudeCodeInstallationPlanner(
            operation,
            invocation,
            emptyInventory(),
          )(target(changed)),
        ).toEqual({ kind: "conflict" });
    });
  },
);

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
