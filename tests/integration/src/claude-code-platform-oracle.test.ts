import { describe, expect, it } from "vitest";

// @ts-expect-error private checksum-bound scenario module has no declaration
import * as oracleModule from "../claude-code-platform-oracle.mjs";

type HookFacts = Readonly<{
  eventName: string;
  sessionId: string;
  toolUseId: string | null;
  toolName: string | null;
  stopHookActive: boolean | null;
}>;
type HookResult = Readonly<{
  sessionId: string;
  toolUseIds: readonly string[];
  hookEventCount: number;
  nativeSessionEnd: null;
}>;
const { inspectClaudeCodeHookLifecycle, inspectClaudeCodeReadHookTurn } =
  oracleModule as {
    inspectClaudeCodeHookLifecycle: (hooks: readonly HookFacts[]) => HookResult;
    inspectClaudeCodeReadHookTurn: (hooks: readonly HookFacts[]) => HookResult;
  };

const syntheticHooks = () => [
  {
    eventName: "SessionStart",
    sessionId: "session-1",
    toolUseId: null,
    toolName: null,
    stopHookActive: null,
  },
  {
    eventName: "PreToolUse",
    sessionId: "session-1",
    toolUseId: "tool-1",
    toolName: "Read",
    stopHookActive: null,
  },
  {
    eventName: "PostToolUse",
    sessionId: "session-1",
    toolUseId: "tool-1",
    toolName: "Read",
    stopHookActive: null,
  },
  {
    eventName: "Stop",
    sessionId: "session-1",
    toolUseId: null,
    toolName: null,
    stopHookActive: false,
  },
];

describe("Claude native correlation predicate (synthetic only)", () => {
  it("requires the specific controlled Read pair, not merely any internally matching tool", () => {
    const read = syntheticHooks();
    read[1]!.toolUseId = "toolu_agentscope_claude_read_1";
    read[2]!.toolUseId = "toolu_agentscope_claude_read_1";
    expect(inspectClaudeCodeReadHookTurn(read).toolUseIds).toEqual([
      "toolu_agentscope_claude_read_1",
    ]);
    expect(() => inspectClaudeCodeReadHookTurn(syntheticHooks())).toThrow(
      "integration.claude-code.oracle-read-model-id",
    );
    read[1]!.toolName = "Write";
    read[2]!.toolName = "Write";
    expect(() => inspectClaudeCodeReadHookTurn(read)).toThrow(
      "integration.claude-code.oracle-read-tool",
    );
  });
  it("correlates observed tool boundaries without fabricating SessionEnd", () => {
    const result = inspectClaudeCodeHookLifecycle(syntheticHooks());
    expect(result).toEqual({
      sessionId: "session-1",
      toolUseIds: ["tool-1"],
      hookEventCount: 4,
      nativeSessionEnd: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.toolUseIds)).toBe(true);
    expect(result).not.toHaveProperty("resultStatus");
    expect(result).not.toHaveProperty("certificationReadiness");
  });

  it("refuses missing and substituted boundaries rather than filtering them", () => {
    for (let removed = 0; removed < 4; removed += 1) {
      const hooks = syntheticHooks();
      hooks.splice(removed, 1);
      expect(() => inspectClaudeCodeHookLifecycle(hooks)).toThrow();
    }
    for (const eventName of ["SessionEnd", "SessionStart", "Unknown", "Stop"]) {
      const hooks = syntheticHooks();
      hooks[2]!.eventName = eventName;
      expect(() => inspectClaudeCodeHookLifecycle(hooks)).toThrow();
    }
  });

  it("refuses cross-session, mismatched-tool, duplicate and recursive records", () => {
    for (const mutation of [
      (hooks: ReturnType<typeof syntheticHooks>) => {
        hooks[2]!.sessionId = "other";
      },
      (hooks: ReturnType<typeof syntheticHooks>) => {
        hooks[2]!.toolUseId = "other";
      },
      (hooks: ReturnType<typeof syntheticHooks>) => {
        hooks[2]!.toolName = "Write";
      },
      (hooks: ReturnType<typeof syntheticHooks>) => {
        hooks[3]!.stopHookActive = true;
      },
      (hooks: ReturnType<typeof syntheticHooks>) => {
        hooks.splice(2, 0, { ...hooks[1]! });
      },
      (hooks: ReturnType<typeof syntheticHooks>) => {
        hooks.splice(3, 0, { ...hooks[2]! });
      },
    ]) {
      const hooks = syntheticHooks();
      mutation(hooks);
      expect(() => inspectClaudeCodeHookLifecycle(hooks)).toThrow();
    }
  });
});
