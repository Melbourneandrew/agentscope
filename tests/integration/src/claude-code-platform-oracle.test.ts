import type * as NodeFs from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error private checksum-bound scenario module has no declaration
import * as scenarioModule from "../claude-code-scenario.mjs";
const { claudeCodeReadStimulus } = scenarioModule as {
  claudeCodeReadStimulus: Readonly<{ path: string; prompt: string }>;
};

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
const {
  inspectClaudeCodeHookLifecycle,
  inspectClaudeCodeReadHookTurn,
  inspectClaudeCodeModelRequests,
} = oracleModule as {
  inspectClaudeCodeHookLifecycle: (hooks: readonly HookFacts[]) => HookResult;
  inspectClaudeCodeReadHookTurn: (hooks: readonly HookFacts[]) => HookResult;
  inspectClaudeCodeModelRequests: (
    bytes: Buffer,
    stimulus: typeof claudeCodeReadStimulus,
  ) => Readonly<{ modelRequestBodySha256: readonly string[] }> | undefined;
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

describe("Claude actual request-pair projection (synthetic upstream rows only)", () => {
  const bodies = () => {
    const first = {
      model: "synthetic-model",
      stream: true,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: claudeCodeReadStimulus.prompt }],
        },
      ],
    };
    const second = {
      ...first,
      messages: [
        ...first.messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_agentscope_claude_read_1",
              name: "Read",
              input: { file_path: claudeCodeReadStimulus.path },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_agentscope_claude_read_1",
              content: "synthetic-private-result",
              is_error: false,
            },
          ],
        },
      ],
    };
    return [first, second];
  };
  const encode = (values: unknown[]) =>
    Buffer.from(
      JSON.stringify(
        values.map((value) => ({
          method: "POST",
          path: "/v1/messages",
          body: { type: "STRING", string: JSON.stringify(value) },
        })),
      ),
    );
  it("binds ordered original body bytes, not normalized or caller-provided hashes", () => {
    const values = bodies();
    const observed = inspectClaudeCodeModelRequests(
      encode(values),
      claudeCodeReadStimulus,
    );
    expect(observed?.modelRequestBodySha256).toEqual(
      values.map((value) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      ),
    );
    expect(JSON.stringify(observed)).not.toContain("synthetic-private-result");
    expect(observed).not.toHaveProperty("complete");
    expect(
      inspectClaudeCodeModelRequests(
        encode(values.slice(0, 1)),
        claudeCodeReadStimulus,
      ),
    ).toBeUndefined();
  });
  it("refuses failed/missing/wrong/reordered native tool results and extra primaries", () => {
    for (const replacement of [
      { is_error: true },
      { tool_use_id: "other" },
      { type: "text" },
    ]) {
      const values = bodies();
      Object.assign(values[1]!.messages[2]!.content[0]!, replacement);
      expect(() =>
        inspectClaudeCodeModelRequests(encode(values), claudeCodeReadStimulus),
      ).toThrow();
    }
    const values = bodies();
    expect(() =>
      inspectClaudeCodeModelRequests(
        encode([...values].reverse()),
        claudeCodeReadStimulus,
      ),
    ).toThrow();
    expect(() =>
      inspectClaudeCodeModelRequests(
        encode([...values, values[1]]),
        claudeCodeReadStimulus,
      ),
    ).toThrow();
    expect(() =>
      inspectClaudeCodeModelRequests(
        Buffer.alloc(1024 * 1024 + 1),
        claudeCodeReadStimulus,
      ),
    ).toThrow();
  });
});

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

const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
const nativeRecords = () => {
  const record = (type: string, content: unknown, model?: string) => ({
    type,
    sessionId,
    cwd: "/worktree",
    version: "2.1.245",
    isSidechain: false,
    message: { content, ...(model === undefined ? {} : { model }) },
  });
  return [
    record("user", claudeCodeReadStimulus.prompt),
    record(
      "assistant",
      [
        {
          type: "tool_use",
          id: "toolu_agentscope_claude_read_1",
          name: "Read",
          input: { file_path: claudeCodeReadStimulus.path },
        },
      ],
      "synthetic-model",
    ),
    record("user", [
      {
        type: "tool_result",
        tool_use_id: "toolu_agentscope_claude_read_1",
        content: "synthetic-private-body",
      },
    ]),
    record("assistant", [{ type: "text", text: "DONE" }], "synthetic-model"),
  ];
};
const observe = async (records: unknown[], pending = false) => {
  const { readFileSync } = await vi.importActual<typeof NodeFs>("node:fs");
  const source = readFileSync(
    new URL("../claude-code-platform-oracle.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const assertClaudeNativeRecord =");
  const end = source.indexOf(
    "// This is one native correlation predicate",
    start,
  );
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return runInNewContext(
    `${source.slice(start, end)}; inspectClaudeCodeNativeRecords(records, sessionId, claudeCodeReadStimulus, pending)`,
    { records, sessionId, claudeCodeReadStimulus, pending },
  ) as unknown;
};
describe("Claude held native transcript projection (synthetic records only)", () => {
  it("retains only actual native identities/model and discards all bodies", async () => {
    const result = await observe(nativeRecords());
    expect(result).toEqual({
      nativeSessionId: sessionId,
      nativeToolUseId: "toolu_agentscope_claude_read_1",
      nativeModelName: "synthetic-model",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-body");
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("hooks");
    expect(result).not.toHaveProperty("complete");
  });
  it("keeps an absent native model absent rather than inventing one", async () => {
    const records = nativeRecords();
    for (const record of records) delete record.message.model;
    expect(await observe(records)).not.toHaveProperty("nativeModelName");
  });
  it("pending accepts only a validated incomplete prefix, never malformed native facts", async () => {
    expect(await observe(nativeRecords().slice(0, -1), true)).toBeUndefined();
    expect(await observe(nativeRecords(), true)).toMatchObject({
      nativeSessionId: sessionId,
    });
    const hostile = nativeRecords().slice(0, -1);
    hostile[1]!.sessionId = "foreign";
    await expect(observe(hostile, true)).rejects.toThrow(
      "integration.claude-code.native-record",
    );
    const failed = nativeRecords().slice(0, -1);
    failed[2]!.message.content = [
      {
        type: "tool_result",
        tool_use_id: "toolu_agentscope_claude_read_1",
        is_error: true,
      },
    ];
    await expect(observe(failed, true)).rejects.toThrow(
      "integration.claude-code.native-tool-result",
    );
    const reordered = nativeRecords().slice(0, -1);
    [reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!];
    await expect(observe(reordered, true)).rejects.toThrow(
      "integration.claude-code.native-turn",
    );
  });
  it("refuses wrong session/version/cwd, tool IDs, failed results and reordered turns", async () => {
    for (const replacement of [
      { sessionId: "other" },
      { version: "other" },
      { cwd: "/other" },
      { isSidechain: true },
    ]) {
      const records = nativeRecords();
      Object.assign(records[1]!, replacement);
      await expect(observe(records)).rejects.toThrow(
        "integration.claude-code.native-record",
      );
    }
    const failed = nativeRecords();
    failed[2]!.message.content = [
      {
        type: "tool_result",
        tool_use_id: "toolu_agentscope_claude_read_1",
        is_error: true,
      },
    ];
    await expect(observe(failed)).rejects.toThrow(
      "integration.claude-code.native-tool-result",
    );
    const wrongId = nativeRecords();
    wrongId[2]!.message.content = [
      { type: "tool_result", tool_use_id: "other" },
    ];
    await expect(observe(wrongId)).rejects.toThrow(
      "integration.claude-code.native-tool-result",
    );
    const reordered = nativeRecords();
    [reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!];
    await expect(observe(reordered)).rejects.toThrow(
      "integration.claude-code.native-turn",
    );
  });
});
