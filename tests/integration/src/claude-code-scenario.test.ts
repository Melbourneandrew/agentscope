import { constants } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const synthetic = vi.hoisted(() => ({
  uptime: "1.000 0.000\n",
  calls: [] as Array<{
    executable: string;
    arguments_: string[];
    options: Record<string, unknown>;
  }>,
  afterCommand: "1.000 0.000\n",
  fileCalls: [] as unknown[],
  writeError: false,
  modeError: false,
}));
vi.mock("node:fs", async () => ({
  constants: (await vi.importActual<{ constants: typeof constants }>("node:fs"))
    .constants,
  readFileSync: () => synthetic.uptime,
  openSync: (path: string, flags: number, mode: number) => {
    if (synthetic.writeError) throw new Error("synthetic-existing-path");
    synthetic.fileCalls.push({ action: "open", path, flags, mode });
    return 41;
  },
  writeFileSync: (descriptor: number, contents: string) => {
    synthetic.fileCalls.push({ action: "write", descriptor, contents });
  },
  fchmodSync: (descriptor: number, mode: number) => {
    synthetic.fileCalls.push({ action: "mode", descriptor, mode });
    if (synthetic.modeError) throw new Error("synthetic-mode-failure");
  },
  closeSync: (descriptor: number) => {
    synthetic.fileCalls.push({ action: "close", descriptor });
  },
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("synthetic-native-launch-forbidden");
  }),
  execFile: (
    executable: string,
    arguments_: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, value: { stdout: string }) => void,
  ) => {
    synthetic.calls.push({ executable, arguments_, options });
    synthetic.uptime = synthetic.afterCommand;
    callback(null, { stdout: "synthetic-machine-output" });
  },
}));

// @ts-expect-error private checksum-bound scenario module has no declaration
import * as scenarioModule from "../claude-code-scenario.mjs";

const {
  claudeCodeLifecycleCommands,
  claudeCodeReadStimulus,
  claudeCodeInteractiveInput,
  claudeCodeReadResponses,
  claudeCodeReadExpectations,
  prepareClaudeCodeReadStimulus,
  runClaudeCodeInteractiveTurn,
  runClaudeCodeLifecycleCommand,
} = scenarioModule as {
  claudeCodeLifecycleCommands: (
    settings: unknown,
  ) => readonly (readonly string[])[];
  claudeCodeReadStimulus: Readonly<{
    path: string;
    contents: string;
    prompt: string;
  }>;
  claudeCodeInteractiveInput: Readonly<{
    submission: readonly string[];
    termination: readonly string[];
  }>;
  claudeCodeReadResponses: (model: string) => Readonly<{
    contentType: string;
    toolUseId: string;
    toolResponse: string;
    finalResponse: string;
  }>;
  claudeCodeReadExpectations: (model: string) => readonly {
    httpRequest: {
      method: string;
      path: string;
      body: { type: string; jsonSchema: string };
    };
    httpResponse: { body: string };
    times: { remainingTimes: number; unlimited: boolean };
  }[];
  prepareClaudeCodeReadStimulus: () => string;
  runClaudeCodeInteractiveTurn: (
    endpoint: string,
    deadline: number,
  ) => Promise<void>;
  runClaudeCodeLifecycleCommand: (
    arguments_: readonly string[],
    deadline: number,
  ) => Promise<string>;
};

describe("Claude fixed interactive stimulus (source preparation only)", () => {
  it("keeps submission and post-completion exit separate without a synthetic readiness claim", () => {
    expect(claudeCodeInteractiveInput.submission).toEqual([
      claudeCodeReadStimulus.prompt,
      "\r",
    ]);
    expect(claudeCodeInteractiveInput.termination).toEqual(["/exit", "\r"]);
    expect(Object.isFrozen(claudeCodeInteractiveInput)).toBe(true);
    expect(Object.isFrozen(claudeCodeInteractiveInput.submission)).toBe(true);
    expect(Object.isFrozen(claudeCodeInteractiveInput.termination)).toBe(true);
    expect(claudeCodeInteractiveInput).not.toHaveProperty("ready");
    expect(claudeCodeInteractiveInput).not.toHaveProperty("complete");
  });
  it("builds the complete fixed two-response Messages stream without claiming native capture", () => {
    const responses = claudeCodeReadResponses("synthetic-model");
    const decode = (source: string) =>
      source
        .trim()
        .split("\n\n")
        .map((frame) => {
          const [event, data] = frame.split("\n");
          const parsed = JSON.parse(data!.slice("data: ".length)) as {
            type: string;
            message: Record<string, unknown>;
            content_block: unknown;
            delta: unknown;
            usage: unknown;
          };
          expect(event).toBe(`event: ${parsed.type}`);
          return parsed;
        });
    const first = decode(responses.toolResponse);
    const second = decode(responses.finalResponse);
    expect(first.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(first[0]!.message).toEqual({
      id: "msg_agentscope_claude_tool_1",
      type: "message",
      role: "assistant",
      model: "synthetic-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    expect(first[1]!.content_block).toEqual({
      type: "tool_use",
      id: responses.toolUseId,
      name: "Read",
      input: {},
    });
    expect(first[2]!.delta).toEqual({
      type: "input_json_delta",
      partial_json: JSON.stringify({ file_path: claudeCodeReadStimulus.path }),
    });
    expect(first[4]).toEqual({
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    });
    expect(second[0]!.message.id).toBe("msg_agentscope_claude_final_1");
    expect(second[1]!.content_block).toEqual({ type: "text", text: "" });
    expect(second[2]!.delta).toEqual({ type: "text_delta", text: "DONE" });
    expect(second[4]!.delta).toEqual({
      stop_reason: "end_turn",
      stop_sequence: null,
    });
    expect(responses.contentType).toBe("text/event-stream");
    expect(Object.isFrozen(responses)).toBe(true);
    expect(() => claudeCodeReadResponses("")).toThrow(
      "integration.claude-code.response-model",
    );
    expect(() => claudeCodeReadResponses("x".repeat(257))).toThrow(
      "integration.claude-code.response-model",
    );
  });
});

describe("Claude nonsecret fixture descriptor (mocked filesystem only)", () => {
  it("prepares only the exclusive nonsecret Read stimulus and preserves collision refusal", () => {
    synthetic.fileCalls.length = 0;
    synthetic.writeError = false;
    expect(prepareClaudeCodeReadStimulus()).toBe(claudeCodeReadStimulus.prompt);
    expect(synthetic.fileCalls).toEqual([
      {
        action: "open",
        path: "/worktree/agentscope-claude-tool-stimulus.txt",
        flags:
          constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        mode: 0o600,
      },
      {
        action: "write",
        descriptor: 41,
        contents: "agentscope-claude-tool-stimulus-v1\n",
      },
      { action: "mode", descriptor: 41, mode: 0o444 },
      { action: "close", descriptor: 41 },
    ]);
    expect(Object.isFrozen(claudeCodeReadStimulus)).toBe(true);
    synthetic.writeError = true;
    expect(() => prepareClaudeCodeReadStimulus()).toThrow(
      "synthetic-existing-path",
    );
    expect(synthetic.fileCalls).toHaveLength(4);
    synthetic.writeError = false;
  });
  it("closes the held fixture on mode refusal without returning a prompt", () => {
    synthetic.fileCalls.length = 0;
    synthetic.modeError = true;
    try {
      expect(() => prepareClaudeCodeReadStimulus()).toThrow(
        "synthetic-mode-failure",
      );
      expect(synthetic.fileCalls.at(-1)).toEqual({
        action: "close",
        descriptor: 41,
      });
    } finally {
      synthetic.modeError = false;
    }
  });
});

describe("Claude ordinary packed CLI sequence (source preparation only)", () => {
  it("guards final SSE with the ordered native Read request tuple, not request count", () => {
    const rows = claudeCodeReadExpectations("synthetic-model");
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.httpRequest.method === "POST" &&
          row.httpRequest.path === "/v1/messages",
      ),
    ).toBe(true);
    expect(
      rows.every((row) => row.httpRequest.body.type === "JSON_SCHEMA"),
    ).toBe(true);
    const schema: unknown = JSON.parse(rows[1]!.httpRequest.body.jsonSchema);
    expect(schema).toMatchObject({
      properties: {
        messages: {
          minItems: 3,
          maxItems: 3,
          additionalItems: false,
          items: [
            { properties: { role: { const: "user" } } },
            {
              properties: {
                role: { const: "assistant" },
                content: {
                  contains: {
                    properties: {
                      id: { const: "toolu_agentscope_claude_read_1" },
                      name: { const: "Read" },
                    },
                  },
                },
              },
            },
            {
              properties: {
                role: { const: "user" },
                content: {
                  contains: {
                    properties: {
                      tool_use_id: { const: "toolu_agentscope_claude_read_1" },
                      is_error: { const: false },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    });
    expect(rows[1]!.httpResponse.body).toContain("end_turn");
    expect(
      rows.every(
        (row) => row.times.remainingTimes === 1 && !row.times.unlimited,
      ),
    ).toBe(true);
  });
  it("uses the real remote destination and CI reference commands, not Local", () => {
    const settings = { endpoint: "https://collector.agentscope.internal" };
    const commands = claudeCodeLifecycleCommands(settings);
    expect(commands[0]).toEqual(["init", "--yes"]);
    expect(commands[1]).toEqual([
      "destination",
      "configure",
      "langfuse",
      "--name",
      "trace",
      "--yes",
      "--settings",
      JSON.stringify(settings),
      "--credential-env",
      "public-key=AGENTSCOPE_LANGFUSE_PUBLIC_KEY",
      "secret-key=AGENTSCOPE_LANGFUSE_SECRET_KEY",
    ]);
    expect(commands[2]).toEqual(["routing", "set", "trace"]);
    expect(commands[3]).toEqual(["install", "claude-code", "--yes"]);
    expect(commands.slice(4)).toEqual([
      ["harness", "status", "claude-code"],
      ["doctor"],
      ["uninstall", "claude-code", "--yes"],
      ["harness", "status", "claude-code"],
    ]);
    expect(JSON.stringify(commands)).not.toContain("local-sqlite");
    expect(Object.isFrozen(commands)).toBe(true);
    expect(commands.every(Object.isFrozen)).toBe(true);
  });

  it("snapshots nonsecret settings without introducing argv interpolation", () => {
    const settings = { endpoint: "https://collector.agentscope.internal" };
    const commands = claudeCodeLifecycleCommands(settings);
    settings.endpoint = "https://other.invalid";
    expect(commands[1]).toContain(
      '{"endpoint":"https://collector.agentscope.internal"}',
    );
    expect(() => claudeCodeLifecycleCommands(undefined)).toThrow();
    expect(() =>
      claudeCodeLifecycleCommands({ endpoint: "x".repeat(65_537) }),
    ).toThrow();
  });
});

describe("Claude ordinary command deadline (mocked child, no native evidence)", () => {
  beforeEach(() => {
    synthetic.uptime = "1.000 0.000\n";
    synthetic.afterCommand = synthetic.uptime;
    synthetic.calls.length = 0;
  });

  it("passes only the original remaining budget and closed candidate environment", async () => {
    expect(await runClaudeCodeLifecycleCommand(["doctor"], 1500)).toBe(
      "synthetic-machine-output",
    );
    expect(synthetic.calls).toHaveLength(1);
    const call = synthetic.calls[0]!;
    expect(call.executable).toBe(
      "/opt/agentscope/installed/node_modules/.bin/agentscope",
    );
    expect(call.arguments_).toEqual(["doctor", "--output", "json"]);
    expect(call.options).toMatchObject({
      uid: 1000,
      gid: 1000,
      cwd: "/worktree",
      timeout: 500,
      maxBuffer: 1024 * 1024,
    });
    expect(Object.keys(call.options.env as object).sort()).toEqual([
      "AGENTSCOPE_HOME",
      "AGENTSCOPE_LANGFUSE_PUBLIC_KEY",
      "AGENTSCOPE_LANGFUSE_SECRET_KEY",
      "CI",
      "CLAUDE_CONFIG_DIR",
      "HOME",
      "LANG",
      "NODE_EXTRA_CA_CERTS",
      "PATH",
      "TERM",
      "XDG_CONFIG_HOME",
    ]);
  });

  it("refuses an expired or malformed clock before spawning", async () => {
    await expect(
      runClaudeCodeInteractiveTurn(
        "http://mockserver.agentscope.internal:1080",
        1000,
      ),
    ).rejects.toThrow("integration.claude-code.deadline");
    await expect(
      runClaudeCodeLifecycleCommand(["doctor"], 1000),
    ).rejects.toThrow("integration.claude-code.deadline");
    synthetic.uptime = "unknown";
    await expect(
      runClaudeCodeLifecycleCommand(["doctor"], 1500),
    ).rejects.toThrow("integration.claude-code.clock");
    expect(synthetic.calls).toHaveLength(0);
  });

  it("rejects output observed at the same original cutoff, without renewal", async () => {
    synthetic.afterCommand = "1.500 0.000\n";
    await expect(
      runClaudeCodeLifecycleCommand(["doctor"], 1500),
    ).rejects.toThrow("integration.claude-code.deadline");
    expect(synthetic.calls).toHaveLength(1);
    expect(synthetic.calls[0]!.options.timeout).toBe(500);
  });
});
