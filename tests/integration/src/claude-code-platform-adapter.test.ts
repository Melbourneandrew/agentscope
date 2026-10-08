import { describe, expect, it } from "vitest";

// @ts-expect-error private checksum-bound scenario module has no declaration
import * as adapterModule from "../fixtures/claude-code-platform-adapter.mjs";

const { claudeCodeInteractiveInvocation, translateClaudeCodeHookObservations } =
  adapterModule as {
    claudeCodeInteractiveInvocation: (endpoint: string) => Readonly<{
      executable: string;
      arguments: readonly string[];
      environment: Readonly<Record<string, string>>;
    }>;
    translateClaudeCodeHookObservations: (
      payloads: readonly Uint8Array[],
    ) => readonly Readonly<{
      eventName: string;
      toolUseId: string | null;
      durationMilliseconds: number | null;
      stopHookActive: boolean | null;
    }>[];
  };

const payload = (hook_event_name: string, fields = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      hook_event_name,
      session_id: "synthetic-session",
      transcript_path: "/isolated/transcript.jsonl",
      cwd: "/isolated/project",
      ...fields,
    }),
  );

describe("Claude native hook observation projection (synthetic only)", () => {
  it("uses interactive argv and only existing internal synthetic provider settings", () => {
    const invocation = claudeCodeInteractiveInvocation(
      "http://mockserver.agentscope.internal:1080",
    );
    expect(invocation.executable).toBe("/usr/local/bin/claude");
    expect(invocation.arguments).toEqual([
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]);
    expect(invocation.arguments).not.toContain("--print");
    expect(invocation.arguments).not.toContain(
      "--dangerously-skip-permissions",
    );
    expect(Object.keys(invocation.environment).sort()).toEqual([
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
      "CLAUDE_CONFIG_DIR",
      "DISABLE_UPDATES",
      "HOME",
      "LANG",
      "PATH",
      "TERM",
    ]);
    expect(invocation.environment.ANTHROPIC_AUTH_TOKEN).toBe(
      "DUMMY_INTERNAL_MOCK_TOKEN",
    );
    expect(Object.isFrozen(invocation.environment)).toBe(true);
    expect(() =>
      claudeCodeInteractiveInvocation("https://api.anthropic.com"),
    ).toThrow("claude-code.execution.internal-endpoint");
  });
  it("preserves four observed boundaries without retaining raw content", () => {
    const hooks = translateClaudeCodeHookObservations([
      payload("SessionStart", { source: "startup", model: "fixture-model" }),
      payload("PreToolUse", {
        tool_name: "Read",
        tool_use_id: "tool-1",
        tool_input: { file_path: "/isolated/private" },
      }),
      payload("PostToolUse", {
        tool_name: "Read",
        tool_use_id: "tool-1",
        tool_input: {},
        tool_response: { text: "synthetic-private-result" },
        duration_ms: 12,
      }),
      payload("Stop", {
        stop_hook_active: false,
        last_assistant_message: "synthetic-private-reply",
      }),
    ]);
    expect(hooks.map((hook: { eventName: string }) => hook.eventName)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ]);
    expect(hooks[2]).toMatchObject({
      toolUseId: "tool-1",
      durationMilliseconds: 12,
    });
    expect(Object.isFrozen(hooks)).toBe(true);
    expect(hooks.every(Object.isFrozen)).toBe(true);
    const retained = JSON.stringify(hooks);
    expect(retained).not.toContain("synthetic-private");
    expect(retained).not.toContain("/isolated");
    expect(retained).not.toContain("SessionEnd");
  });

  it("does not filter unknown or contradictory native records into success", () => {
    expect(() =>
      translateClaudeCodeHookObservations([
        payload("Stop", { stop_hook_active: false }),
        payload("Unknown"),
      ]),
    ).toThrow("claude-code.mapping.invalid");
    const hooks = translateClaudeCodeHookObservations([
      payload("Stop", { stop_hook_active: true }),
      payload("SessionEnd", { reason: "other" }),
    ]);
    expect(hooks[0].stopHookActive).toBe(true);
    expect(hooks[1].eventName).toBe("SessionEnd");
  });

  it("reuses duplicate-key and byte bounds of the component decoder", () => {
    expect(() =>
      translateClaudeCodeHookObservations([
        new TextEncoder().encode(
          '{"hook_event_name":"Stop","hook_event_name":"Stop"}',
        ),
      ]),
    ).toThrow("claude-code.mapping.invalid");
    expect(() =>
      translateClaudeCodeHookObservations([new Uint8Array(65_537)]),
    ).toThrow("claude-code.mapping.invalid");
    expect(() =>
      translateClaudeCodeHookObservations(
        Array.from({ length: 129 }, () => payload("Stop")),
      ),
    ).toThrow("integration.claude-code.adapter-observation");
  });
});
