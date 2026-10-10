import { constants, type realpathSync } from "node:fs";
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
  commandOutputs: [] as string[],
  commandFailure: undefined as Error | undefined,
  failAt: -1,
  settings: Buffer.alloc(0),
  nativeBytes: Buffer.alloc(0),
  nativeFailure: "",
  nativeOwnerSensitive: false,
  nativeUid: 0,
}));
function nativeStatus(descriptor: number, named = false) {
  return {
    isFile: () =>
      descriptor === 44 &&
      !(named && synthetic.nativeFailure === "target-symlink"),
    isDirectory: () =>
      descriptor !== 44 && synthetic.nativeFailure !== "symlink",
    uid:
      descriptor === 44 && synthetic.nativeOwnerSensitive
        ? synthetic.nativeUid
        : synthetic.nativeFailure === "owner"
          ? 0
          : 1000,
    gid: 1000,
    nlink: 1,
    mode:
      synthetic.nativeFailure === "mode"
        ? 0o644
        : descriptor !== 44 && synthetic.nativeFailure === "parent-mode"
          ? 0o777
          : 0o600,
    size: synthetic.nativeBytes.length,
    dev: 1,
    ino:
      named &&
      (synthetic.nativeFailure === "drift" ||
        (descriptor === 42 &&
          synthetic.nativeFailure === "parent-after" &&
          synthetic.nativeBytes.length > 0))
        ? 2
        : 1,
  };
}
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<{ realpathSync: typeof realpathSync }>(
    "node:fs",
  );
  return {
    constants: (
      await vi.importActual<{ constants: typeof constants }>("node:fs")
    ).constants,
    realpathSync: (path: string) => {
      if (path === "/harness-home" || path === "/worktree")
        return synthetic.nativeFailure === "alias" ? "/other" : path;
      return actual.realpathSync(path);
    },
    readFileSync: () => synthetic.uptime,
    openSync: (path: string, flags: number, mode: number) => {
      if (synthetic.writeError) throw new Error("synthetic-existing-path");
      synthetic.fileCalls.push({ action: "open", path, flags, mode });
      if (path === "/harness-home") {
        if (synthetic.nativeFailure === "missing") throw new Error("missing");
        return 42;
      }
      if (path === "/worktree") return 43;
      if (path === "/proc/self/fd/42/.claude.json") {
        if (synthetic.nativeFailure === "existing") throw new Error("existing");
        return 44;
      }
      return 41;
    },
    writeFileSync: (descriptor: number, contents: string | Buffer) => {
      if (descriptor === 44) {
        synthetic.nativeBytes = Buffer.from(contents);
        if (synthetic.nativeFailure === "partial")
          synthetic.nativeBytes = Buffer.alloc(1);
        if (synthetic.nativeFailure === "deadline")
          synthetic.uptime = "2.000 0.000\n";
      }
      synthetic.fileCalls.push({
        action: "write",
        descriptor,
        contents: Buffer.isBuffer(contents)
          ? contents.toString("utf8")
          : contents,
      });
    },
    fchownSync: (descriptor: number, uid: number, gid: number) => {
      synthetic.fileCalls.push({ action: "owner", descriptor, uid, gid });
      if (descriptor === 44) synthetic.nativeUid = uid;
    },
    fchmodSync: (descriptor: number, mode: number) => {
      synthetic.fileCalls.push({ action: "mode", descriptor, mode });
      if (
        descriptor === 44 &&
        synthetic.nativeOwnerSensitive &&
        synthetic.nativeUid !== 0
      )
        throw Object.assign(new Error("synthetic-owner-without-FOWNER"), {
          code: "EPERM",
        });
      if (synthetic.modeError) throw new Error("synthetic-mode-failure");
    },
    closeSync: (descriptor: number) => {
      synthetic.fileCalls.push({ action: "close", descriptor });
    },
    fstatSync: (descriptor: number) =>
      descriptor >= 42
        ? nativeStatus(descriptor)
        : {
            isFile: () => true,
            uid: 1000,
            nlink: 1,
            mode: 0o600,
            size: synthetic.settings.length,
            dev: 1,
            ino: 1,
            mtimeMs: 1,
            ctimeMs: 1,
          },
    lstatSync: (path: string) =>
      path === "/harness-home" ||
      path === "/worktree" ||
      path === "/harness-home/.claude.json"
        ? nativeStatus(path === "/harness-home/.claude.json" ? 44 : 42, true)
        : {
            uid: 1000,
            nlink: 1,
            mode: 0o600,
            size: synthetic.settings.length,
            dev: 1,
            ino: 1,
            mtimeMs: 1,
            ctimeMs: 1,
          },
    readSync: (
      _fd: number,
      bytes: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => synthetic.settings.copy(bytes, offset, position, position + length),
  };
});
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
    const index = synthetic.calls.length - 1;
    callback(
      index === synthetic.failAt ? (synthetic.commandFailure ?? null) : null,
      {
        stdout: synthetic.commandOutputs[index] ?? "synthetic-machine-output",
      },
    );
  },
}));

// @ts-expect-error private checksum-bound scenario module has no declaration
import * as scenarioModule from "../claude-code-scenario.mjs";
// @ts-expect-error private checksum-bound lifecycle module has no declaration
import * as lifecycleModule from "../claude-code-lifecycle.mjs";
const { prepareClaudeCodePackedCli } = lifecycleModule as {
  prepareClaudeCodePackedCli: (
    deadline: number,
    note?: (phase: string) => void,
  ) => Promise<{ commands: readonly (readonly string[])[]; settings: Buffer }>;
};

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
    expect(claudeCodeInteractiveInput.submission).toEqual([]);
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

const resetPackedLifecycleFixture = () => {
  synthetic.uptime = "1.000 0.000\n";
  synthetic.afterCommand = synthetic.uptime;
  synthetic.calls.length = 0;
  synthetic.commandOutputs = Array<string>(4).fill("unused-output");
  synthetic.commandOutputs.push(
    JSON.stringify({
      command: "agentscope harness status",
      completion: "complete",
      records: [
        {
          installation: "unchanged",
          discovery: {
            harness: "claude-code",
            version: "2.1.245",
          },
        },
      ],
    }),
  );
  synthetic.commandFailure = undefined;
  synthetic.failAt = -1;
  synthetic.writeError = false;
  synthetic.nativeFailure = "";
  synthetic.nativeOwnerSensitive = false;
  synthetic.nativeUid = 0;
  synthetic.nativeBytes = Buffer.alloc(0);
  const identity = `agentscope-hook-v1-sha256-${"a".repeat(64)}`;
  synthetic.settings = Buffer.from(
    JSON.stringify({
      hooks: Object.fromEntries(
        ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].map((event) => [
          event,
          [
            {
              agentscope: {
                event,
                contractVersion: 1,
                harnessType: "@agentscope/harness-claude-code",
                ownershipIdentity: identity,
              },
              hooks: [
                {
                  type: "command",
                  command: "/owned/launcher",
                  args: [],
                  timeout: 10,
                },
              ],
            },
          ],
        ]),
      ),
    }),
  );
};
describe("Claude fixed native first-run fixture (synthetic filesystem)", () => {
  beforeEach(resetPackedLifecycleFixture);
  it("prepares only the fixed native first-run state after verifying installed hooks", async () => {
    synthetic.fileCalls.length = 0;
    const value = await prepareClaudeCodePackedCli(1500);
    expect(value.settings.equals(synthetic.settings)).toBe(true);
    expect(synthetic.fileCalls).toContainEqual({
      action: "write",
      descriptor: 44,
      contents: JSON.stringify({
        hasCompletedOnboarding: true,
        autoUpdates: false,
        bypassPermissionsModeAccepted: false,
        projects: { "/worktree": { hasTrustDialogAccepted: true } },
      }),
    });
    expect(synthetic.fileCalls).toContainEqual({
      action: "open",
      path: "/proc/self/fd/42/.claude.json",
      flags:
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode: 0o600,
    });
    expect(
      Object.keys(
        JSON.parse(synthetic.nativeBytes.toString("utf8")) as Record<
          string,
          unknown
        >,
      ).sort(),
    ).toEqual([
      "autoUpdates",
      "bypassPermissionsModeAccepted",
      "hasCompletedOnboarding",
      "projects",
    ]);
  });
  it.each([
    "owner",
    "symlink",
    "alias",
    "existing",
    "mode",
    "drift",
    "partial",
    "target-symlink",
    "parent-after",
    "missing",
    "deadline",
  ])(
    "refuses native fixture %s without changing installed settings",
    async (failure) => {
      synthetic.nativeFailure = failure;
      const settings = Buffer.from(synthetic.settings);
      await expect(prepareClaudeCodePackedCli(1500)).rejects.toThrow();
      expect(synthetic.settings.equals(settings)).toBe(true);
    },
  );
  it("uses existing namespace ownership without inventing a parent mode gate", async () => {
    synthetic.nativeFailure = "parent-mode";
    await expect(prepareClaudeCodePackedCli(1500)).resolves.toHaveProperty(
      "settings",
    );
  });
});
describe("Claude native fixture ownership handoff (synthetic capability model)", () => {
  beforeEach(resetPackedLifecycleFixture);
  it("normalizes mode while root owns the inode without requiring CAP_FOWNER", async () => {
    synthetic.nativeOwnerSensitive = true;
    synthetic.fileCalls.length = 0;
    const value = await prepareClaudeCodePackedCli(1500);
    expect(value.settings.equals(synthetic.settings)).toBe(true);
    expect(synthetic.nativeUid).toBe(1000);
    expect(
      synthetic.fileCalls.filter(
        (call) => (call as { descriptor?: number }).descriptor === 44,
      ),
    ).toEqual([
      { action: "mode", descriptor: 44, mode: 0o600 },
      { action: "owner", descriptor: 44, uid: 1000, gid: 1000 },
      {
        action: "write",
        descriptor: 44,
        contents: synthetic.nativeBytes.toString("utf8"),
      },
      { action: "close", descriptor: 44 },
    ]);
    for (const descriptor of [42, 43])
      expect(synthetic.fileCalls).toContainEqual({
        action: "close",
        descriptor,
      });
  });
});
describe("Claude actual packed lifecycle (synthetic CLI and owned settings)", () => {
  beforeEach(resetPackedLifecycleFixture);
  it("accepts the actual successful unchanged status and retains strict settings", async () => {
    const notes: string[] = [];
    const value = await prepareClaudeCodePackedCli(1500, (phase) =>
      notes.push(phase),
    );
    expect(value.settings.equals(synthetic.settings)).toBe(true);
    expect(notes).toEqual([
      "packed-init",
      "packed-configure",
      "packed-routing",
      "packed-hook-install",
      "packed-status",
      "packed-settings",
    ]);
    expect(synthetic.calls).toHaveLength(5);
  });

  it.each([
    [0, "packed-init"],
    [1, "packed-configure"],
    [2, "packed-routing"],
    [3, "packed-hook-install"],
    [4, "packed-status"],
  ] as const)(
    "localizes command %i and rethrows the SAME original rejection",
    async (index, phase) => {
      const original = new Error("PRIVATE_CHILD_OUTPUT");
      synthetic.commandFailure = original;
      synthetic.failAt = index;
      const notes: string[] = [];
      await expect(
        prepareClaudeCodePackedCli(1500, (phase) => notes.push(phase)),
      ).rejects.toBe(original);
      expect(notes.at(-1)).toBe(phase);
      expect(synthetic.calls).toHaveLength(index + 1);
    },
  );

  it("localizes status-parser refusal without weakening the machine envelope", async () => {
    synthetic.commandOutputs[4] = "PRIVATE_MALFORMED_MACHINE_OUTPUT";
    const notes: string[] = [];
    await expect(
      prepareClaudeCodePackedCli(1500, (phase) => notes.push(phase)),
    ).rejects.toThrow("integration.codex.cli-output");
    expect(notes.at(-1)).toBe("packed-status");
  });

  it("localizes the original settings-reader refusal after strict status", async () => {
    synthetic.writeError = true;
    const notes: string[] = [];
    await expect(
      prepareClaudeCodePackedCli(1500, (phase) => notes.push(phase)),
    ).rejects.toThrow("synthetic-existing-path");
    expect(notes.at(-1)).toBe("packed-settings");
  });

  it.each([
    {
      installation: "installed",
      discovery: { harness: "claude-code", version: "2.1.245" },
    },
    {
      installation: "ready",
      discovery: { harness: "claude-code", version: "2.1.245" },
    },
    {
      installation: "unchanged",
      discovery: { harness: "codex", version: "2.1.245" },
    },
    {
      installation: "unchanged",
      discovery: { harness: "claude-code", version: "2.1.246" },
    },
  ])(
    "preserves rejection of a substituted installation observation",
    async (record) => {
      synthetic.commandOutputs[4] = JSON.stringify({
        command: "agentscope harness status",
        completion: "complete",
        records: [record],
      });
      await expect(prepareClaudeCodePackedCli(1500)).rejects.toThrow(
        "integration.claude-code.install",
      );
    },
  );
});

describe("Claude existing install diagnostic (synthetic CLI rejection)", () => {
  beforeEach(resetPackedLifecycleFixture);
  it.each([
    ["harness.absent", "not-found", 3, "packed-hook-absent"],
    ["harness.adapter-missing", "not-found", 3, "packed-hook-adapter-missing"],
    [
      "harness.discovery-indeterminate",
      "unavailable",
      5,
      "packed-hook-discovery-indeterminate",
    ],
    [
      "harness.installation-unsupported",
      "unavailable",
      5,
      "packed-hook-installation-unsupported",
    ],
    ["harness.overlap-conflict", "conflict", 4, "packed-hook-overlap-conflict"],
    ["harness.plan-invalid", "unavailable", 5, "packed-hook-plan-invalid"],
    [
      "harness.recovery-required",
      "conflict",
      4,
      "packed-hook-recovery-required",
    ],
    ["harness.unavailable", "unavailable", 5, "packed-hook-unavailable"],
    [
      "harness.version-unsupported",
      "unavailable",
      5,
      "packed-hook-version-unsupported",
    ],
    ["cli.internal", "internal-error", 70, "packed-hook-internal"],
  ] as const)(
    "retains exact fixed diagnostic %s and SAME original failure",
    async (code, category, exit, phase) => {
      const original = Object.assign(new Error("PRIVATE_CHILD_OUTPUT"), {
        code: exit,
        signal: null,
        killed: false,
        stderr: `${JSON.stringify({ category, code, command: "agentscope install", schema: "agentscope.cli.diagnostic.v1" })}\n`,
      });
      synthetic.commandFailure = original;
      synthetic.failAt = 3;
      const notes: string[] = [];
      await expect(
        prepareClaudeCodePackedCli(1500, (value) => notes.push(value)),
      ).rejects.toBe(original);
      expect(notes.at(-1)).toBe(phase);
      expect(synthetic.calls).toHaveLength(4);
    },
  );
});

describe("Claude diagnostic remains non-authoritative", () => {
  beforeEach(resetPackedLifecycleFixture);
  const fixedError = () =>
    Object.assign(new Error("PRIVATE"), {
      code: 5,
      signal: null,
      killed: false,
      stderr:
        '{"category":"unavailable","code":"harness.unavailable","command":"agentscope install","schema":"agentscope.cli.diagnostic.v1"}\n',
    });
  it("rethrows SAME original command error even when classification note fails", async () => {
    const original = fixedError();
    synthetic.commandFailure = original;
    synthetic.failAt = 3;
    await expect(
      prepareClaudeCodePackedCli(1500, (phase) => {
        if (phase === "packed-hook-unavailable")
          throw new Error("NOTE_PRIVATE");
      }),
    ).rejects.toBe(original);
  });
  it.each([
    [0, "packed-init"],
    [1, "packed-configure"],
    [2, "packed-routing"],
    [4, "packed-status"],
  ] as const)(
    "does not classify foreign command position %i",
    async (index, phase) => {
      const original = fixedError();
      synthetic.commandFailure = original;
      synthetic.failAt = index;
      const notes: string[] = [];
      await expect(
        prepareClaudeCodePackedCli(1500, (value) => notes.push(value)),
      ).rejects.toBe(original);
      expect(notes.at(-1)).toBe(phase);
    },
  );
});

describe("Claude ordinary command deadline (mocked child, no native evidence)", () => {
  beforeEach(() => {
    synthetic.uptime = "1.000 0.000\n";
    synthetic.afterCommand = synthetic.uptime;
    synthetic.calls.length = 0;
    synthetic.commandOutputs = [];
    synthetic.commandFailure = undefined;
    synthetic.failAt = -1;
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
