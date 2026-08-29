import {
  createOwnedHarnessHookInvocation,
  type HarnessTargetDecision,
  type OwnedHarnessHookInvocation,
} from "@agentscope/harnesses-core";
import { describe, expect, it } from "vitest";

import { codexHarnessDescriptor } from "./descriptor.js";
import {
  CodexInstallationError,
  createCodexInstallationPlanner,
  encodeCodexPosixHookCommand,
} from "./installation.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const invocation = (
  agentscopeHome = "/opt/agentscope",
  deadline = 2_000,
  platform: "posix" | "win32" = "posix",
): OwnedHarnessHookInvocation =>
  createOwnedHarnessHookInvocation({
    agentscopeHome,
    harnessType: codexHarnessDescriptor.harnessType,
    hookDeadlineMilliseconds: deadline,
    platform,
  });

const decide = (
  operation: "install" | "migrate" | "uninstall",
  ownedInvocation: OwnedHarnessHookInvocation,
  text: string | null,
): HarnessTargetDecision =>
  createCodexInstallationPlanner(
    operation,
    ownedInvocation,
  )({
    targetPath: "/isolated/.codex/hooks.json",
    exists: text !== null,
    bytes: text === null ? null : encoder.encode(text),
    digest: "0".repeat(64),
    mode: text === null ? null : 0o600,
  });

const replacementText = (decision: HarnessTargetDecision): string => {
  expect(decision.kind).toBe("replace");
  if (decision.kind !== "replace") throw new Error("expected replacement");
  return decoder.decode(decision.bytes);
};

describe("Codex vendor-mediated hook command", () => {
  it("encodes one constant absolute launcher path as one POSIX shell word", () => {
    const ownedInvocation = invocation("/opt/Agent's Scope;$(canary)");
    const command = encodeCodexPosixHookCommand(ownedInvocation);
    expect(command).toBe(
      `'${ownedInvocation.launcherPath.replaceAll("'", `'"'"'`)}'`,
    );
    expect(command).not.toContain(" canary");
    expect(ownedInvocation.arguments).toEqual([]);
  });

  it("rejects Windows launchers and deadlines outside the Codex cap", () => {
    expect(() =>
      encodeCodexPosixHookCommand(invocation("/opt/scope", 2_000, "win32")),
    ).toThrow(CodexInstallationError);
    expect(() =>
      encodeCodexPosixHookCommand(invocation("/opt/scope", 3_000)),
    ).toThrow(CodexInstallationError);
  });
});

describe("Codex owned hook installation", () => {
  it("installs the exact root lifecycle and is idempotent", () => {
    const ownedInvocation = invocation();
    const installed = replacementText(decide("install", ownedInvocation, null));
    const installedValue: unknown = JSON.parse(installed);
    expect(installedValue).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear",
            hooks: [
              {
                type: "command",
                command: encodeCodexPosixHookCommand(ownedInvocation),
                timeout: 3,
                statusMessage: "Agentscope trace capture",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: encodeCodexPosixHookCommand(ownedInvocation),
                timeout: 3,
                statusMessage: "Agentscope trace capture",
              },
            ],
          },
        ],
        SessionEnd: [
          {
            hooks: [
              {
                type: "command",
                command: encodeCodexPosixHookCommand(ownedInvocation),
                timeout: 3,
                statusMessage: "Agentscope trace capture",
              },
            ],
          },
        ],
      },
    });
    expect(decide("install", ownedInvocation, installed)).toEqual({
      kind: "unchanged",
    });
    expect(decide("uninstall", ownedInvocation, installed)).toEqual({
      kind: "remove",
    });
  });
});

describe("Codex owned hook migration and removal", () => {
  it("preserves unrelated configuration and refuses foreign overlap", () => {
    const ownedInvocation = invocation();
    const foreign = JSON.stringify({
      description: "foreign",
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "/foreign/hook", timeout: 1 }],
          },
        ],
        PreToolUse: [{ matcher: "Bash", hooks: [] }],
      },
    });
    expect(decide("install", ownedInvocation, foreign).kind).toBe(
      "replace-overlap",
    );
    const migrated = decide("migrate", ownedInvocation, foreign);
    expect(migrated.kind).toBe("replace-overlap");
    if (migrated.kind !== "replace-overlap")
      throw new Error("expected migration");
    const migratedValue = JSON.parse(decoder.decode(migrated.bytes)) as {
      description: string;
      hooks: { PreToolUse: unknown };
    };
    expect(migratedValue.description).toBe("foreign");
    expect(migratedValue.hooks).toHaveProperty("PreToolUse");
    expect(decide("uninstall", ownedInvocation, foreign)).toEqual({
      kind: "unchanged",
    });
  });

  it("uninstalls only exact owned groups and preserves foreign state", () => {
    const ownedInvocation = invocation();
    const installed = replacementText(decide("install", ownedInvocation, null));
    const installedValue = JSON.parse(installed) as Record<string, unknown>;
    const withForeignState = JSON.stringify({
      description: "foreign",
      ...installedValue,
    });
    const uninstalled = replacementText(
      decide("uninstall", ownedInvocation, withForeignState),
    );
    expect(JSON.parse(uninstalled)).toEqual({ description: "foreign" });
    expect(decide("uninstall", ownedInvocation, null)).toEqual({
      kind: "unchanged",
    });
  });

  it("migrates stale owned launchers only within the authenticated owned directory", () => {
    const oldInvocation = invocation("/opt/agentscope", 1_500);
    const currentInvocation = invocation("/opt/agentscope", 2_000);
    const stale = replacementText(decide("install", oldInvocation, null));
    const migrated = replacementText(
      decide("migrate", currentInvocation, stale),
    );
    expect(migrated).toContain(encodeCodexPosixHookCommand(currentInvocation));
    expect(migrated).not.toContain(encodeCodexPosixHookCommand(oldInvocation));

    const impersonator = stale.replaceAll(
      "/opt/agentscope/bin/",
      "/foreign/bin/",
    );
    expect(decide("uninstall", currentInvocation, impersonator)).toEqual({
      kind: "unchanged",
    });
    expect(decide("install", currentInvocation, impersonator).kind).toBe(
      "replace-overlap",
    );
  });

  it("fails closed on malformed native formats and validates planner inputs", () => {
    const ownedInvocation = invocation();
    expect(decide("install", ownedInvocation, "not-json")).toEqual({
      kind: "unsupported",
    });
    expect(decide("uninstall", ownedInvocation, "not-json")).toEqual({
      kind: "unchanged",
    });
    expect(decide("install", invocation("/opt/scope", 3_000), null)).toEqual({
      kind: "unsupported",
    });
    expect(
      decide("install", ownedInvocation, "vendor-observability-hook"),
    ).toEqual({
      kind: "unsupported",
    });
    expect(
      decide("migrate", ownedInvocation, "vendor-observability-hook"),
    ).toEqual({
      kind: "unsupported",
    });
    expect(
      decide("uninstall", ownedInvocation, "vendor-observability-hook"),
    ).toEqual({
      kind: "unchanged",
    });
    expect(() =>
      createCodexInstallationPlanner("invalid" as never, ownedInvocation),
    ).toThrow(CodexInstallationError);
    const other = createOwnedHarnessHookInvocation({
      agentscopeHome: "/opt/agentscope",
      harnessType: "@agentscope/harness-other",
      hookDeadlineMilliseconds: 2_000,
      platform: "posix",
    });
    expect(() => createCodexInstallationPlanner("install", other)).toThrow(
      CodexInstallationError,
    );
  });
});

describe("Codex duplicate-aware configuration boundary", () => {
  it("ignores ambient prototype hooks and never mutates inherited state", () => {
    const ownedInvocation = invocation();
    const inheritedHooks = {
      Stop: [
        {
          hooks: [{ type: "command", command: "/foreign/hook", timeout: 1 }],
        },
      ],
    };
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "hooks");
    Object.defineProperty(Object.prototype, "hooks", {
      value: inheritedHooks,
      configurable: true,
      writable: true,
    });
    try {
      const target = '{"description":"foreign"}';
      expect(decide("install", ownedInvocation, target).kind).toBe("replace");
      expect(decide("migrate", ownedInvocation, target).kind).toBe("replace");
      expect(decide("uninstall", ownedInvocation, target)).toEqual({
        kind: "unchanged",
      });
      expect(Object.keys(inheritedHooks)).toEqual(["Stop"]);
      expect(inheritedHooks).not.toHaveProperty("SessionStart");
      expect(inheritedHooks).not.toHaveProperty("SessionEnd");
    } finally {
      if (previous === undefined)
        delete (Object.prototype as { hooks?: unknown }).hooks;
      else Object.defineProperty(Object.prototype, "hooks", previous);
    }
  });

  it("serializes owned and preserved configuration without inherited callbacks", () => {
    const ownedInvocation = invocation();
    const target = JSON.stringify({
      description: "foreign",
      foreignNull: null,
      foreignTrue: true,
      foreignFalse: false,
      foreignNumber: 42,
      foreignArray: [1, false, null],
      foreignEmpty: {},
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [] }],
      },
    });
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    let decision: HarnessTargetDecision;
    Object.defineProperty(Object.prototype, "toJSON", {
      value: () => ({ prototypeCanary: true }),
      configurable: true,
      writable: true,
    });
    try {
      decision = decide("install", ownedInvocation, target);
    } finally {
      if (previous === undefined)
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Object.prototype, "toJSON", previous);
    }
    const serialized = replacementText(decision);
    expect(serialized).toContain('"PreToolUse"');
    expect(serialized).toContain('"matcher":"Bash"');
    expect(serialized).toContain('"SessionStart"');
    expect(serialized).toContain('"SessionEnd"');
    expect(serialized).not.toContain("prototypeCanary");
    expect(JSON.parse(serialized)).toMatchObject({
      foreignNull: null,
      foreignTrue: true,
      foreignFalse: false,
      foreignNumber: 42,
      foreignArray: [1, false, null],
      foreignEmpty: {},
    });
  });
});

describe("Codex configuration callback isolation", () => {
  it("ignores mutable array callbacks during overlap classification and output", () => {
    const ownedInvocation = invocation();
    const foreign = JSON.stringify({
      description: "foreign",
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "/foreign/hook", timeout: 1 }],
          },
        ],
      },
    });
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "map");
    const previousNumeric = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "0",
    );
    let numericSetterCalls = 0;
    let absent: HarnessTargetDecision;
    let overlap: HarnessTargetDecision;
    Object.defineProperty(Array.prototype, "map", {
      value: () => [],
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Array.prototype, "0", {
      set() {
        numericSetterCalls += 1;
      },
      configurable: true,
    });
    try {
      absent = decide("install", ownedInvocation, '{"description":"foreign"}');
      overlap = decide("install", ownedInvocation, foreign);
    } finally {
      if (previous === undefined)
        delete (Array.prototype as { map?: unknown }).map;
      else Object.defineProperty(Array.prototype, "map", previous);
      if (previousNumeric === undefined)
        Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", previousNumeric);
    }
    expect(numericSetterCalls).toBe(0);
    expect(overlap.kind).toBe("replace-overlap");
    const absentValue = JSON.parse(replacementText(absent)) as {
      description: string;
      hooks: Record<string, unknown>;
    };
    expect(absentValue.description).toBe("foreign");
    expect(Object.keys(absentValue.hooks).sort()).toEqual([
      "SessionEnd",
      "SessionStart",
      "Stop",
    ]);
  });

  it("keeps maximum-depth bounded input below the Core decision ceiling", () => {
    const values = new Array<string>(8_000);
    for (let index = 0; index < values.length; index += 1) values[index] = "0";
    const nested = `${"[".repeat(63)}${values.join(",")}${"]".repeat(63)}`;
    const decision = decide("install", invocation(), `{"bounded":${nested}}`);
    expect(decision.kind).toBe("replace");
    if (decision.kind !== "replace") throw new Error("expected replacement");
    expect(decision.bytes.byteLength).toBeLessThanOrEqual(1_048_576);
  });
});

describe("Codex duplicate-aware configuration rejection", () => {
  it.each([
    '{"hooks":42}',
    '{"hooks":{"Stop":{}}}',
    '{"foreign":9007199254740993}',
    '{"hooks":{},"hooks":{"Stop":[]}}',
    '{"hooks":{"Stop":[],"Stop":[{"hooks":[]}]}}',
    '{"hooks":{"Stop":[],"\\u0053top":[{"hooks":[]}]}}',
    '{"foreign":{"key":1,"key":2}}',
    `${"[".repeat(66)}null${"]".repeat(66)}`,
    JSON.stringify({ oversized: "x".repeat(262_145) }),
  ])("rejects duplicate, ambiguous, or unbounded JSON %#", (text) => {
    const ownedInvocation = invocation();
    expect(decide("install", ownedInvocation, text)).toEqual({
      kind: "unsupported",
    });
    expect(decide("migrate", ownedInvocation, text)).toEqual({
      kind: "unsupported",
    });
    expect(decide("uninstall", ownedInvocation, text)).toEqual({
      kind: "unchanged",
    });
  });
});
