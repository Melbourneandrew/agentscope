import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = "/opt/agentscope/installed/node_modules/.bin/agentscope";
export const claudeCodeReadStimulus = Object.freeze({
  path: "/worktree/agentscope-claude-tool-stimulus.txt",
  contents: "agentscope-claude-tool-stimulus-v1\n",
  prompt:
    "Use the Read tool to read /worktree/agentscope-claude-tool-stimulus.txt, then reply with the single word DONE.",
});

// Input segments for the existing selected PTY owner. Enter/CR and /exit are
// source-bound, but readiness and paste/submit behavior still need actual
// pinned-vendor capture. Never send termination before semantic completion.
export const claudeCodeInteractiveInput = Object.freeze({
  submission: Object.freeze([claudeCodeReadStimulus.prompt, "\r"]),
  termination: Object.freeze(["/exit", "\r"]),
});

// An exclusively created nonsecret fixture is readable by the candidate UID,
// but cannot replace an existing path. PTY input remains the outer owner's job.
export const prepareClaudeCodeReadStimulus = () => {
  const descriptor = openSync(
    claudeCodeReadStimulus.path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, claudeCodeReadStimulus.contents);
    // Explicit descriptor mode is not filtered by the controller's umask.
    fchmodSync(descriptor, 0o444);
  } finally {
    closeSync(descriptor);
  }
  return claudeCodeReadStimulus.prompt;
};

// Controlled provider responses, not captured native observations. The shared
// receiver must verify the real second request's tool_result before serving
// the second response; choosing this response is not proof of that request.
export const claudeCodeReadResponses = (model) => {
  if (typeof model !== "string" || model.length === 0 || model.length > 256)
    throw new Error("integration.claude-code.response-model");
  const toolUseId = "toolu_agentscope_claude_read_1";
  const response = (id, start, delta, reason) => {
    const events = [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: start },
      { type: "content_block_delta", index: 0, delta },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: reason,
          stop_sequence: null,
        },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    return events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
  };
  return Object.freeze({
    contentType: "text/event-stream",
    toolUseId,
    toolResponse: response(
      "msg_agentscope_claude_tool_1",
      {
        type: "tool_use",
        id: toolUseId,
        name: "Read",
        input: {},
      },
      {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          file_path: claudeCodeReadStimulus.path,
        }),
      },
      "tool_use",
    ),
    finalResponse: response(
      "msg_agentscope_claude_final_1",
      {
        type: "text",
        text: "",
      },
      { type: "text_delta", text: "DONE" },
      "end_turn",
    ),
  });
};
const monotonicNow = () => {
  const source = readFileSync("/proc/uptime", "utf8");
  if (source.length > 128 || !/^\d+(?:\.\d+)?\s/u.test(source))
    throw new Error("integration.claude-code.clock");
  const value = Number(source.split(/\s/u, 1)[0]) * 1000;
  if (!Number.isFinite(value) || value < 0)
    throw new Error("integration.claude-code.clock");
  return value;
};
const cliEnvironment = Object.freeze({
  HOME: "/home/agentscope",
  XDG_CONFIG_HOME: "/harness-home",
  CLAUDE_CONFIG_DIR: "/harness-home",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  CI: "true",
  AGENTSCOPE_TEST_PUBLIC_KEY: "DUMMY_INTERNAL_PUBLIC_KEY",
  AGENTSCOPE_TEST_SECRET_KEY: "DUMMY_INTERNAL_SECRET_KEY",
});

// These are ordinary packed-CLI commands within the existing selected PTY
// scenario boundary, not another execution kernel or a support receipt.
export const claudeCodeLifecycleCommands = (destinationSettings) => {
  const settings = JSON.stringify(destinationSettings);
  if (settings === undefined || Buffer.byteLength(settings) > 65_536)
    throw new Error("integration.claude-code.destination-settings");
  return Object.freeze(
    [
      ["init", "--yes"],
      [
        "destination",
        "configure",
        "langfuse",
        "--name",
        "trace",
        "--yes",
        "--settings",
        settings,
        "--credential-env",
        "public-key=AGENTSCOPE_TEST_PUBLIC_KEY",
        "secret-key=AGENTSCOPE_TEST_SECRET_KEY",
      ],
      ["routing", "set", "trace"],
      ["install", "claude-code", "--yes"],
      ["harness", "status", "claude-code"],
      ["doctor"],
      ["uninstall", "claude-code", "--yes"],
      ["harness", "status", "claude-code"],
    ].map((arguments_) => Object.freeze(arguments_)),
  );
};

// The original outer deadline is supplied by the selected wrapper. The caller
// must not replace it with a new duration after any command or vendor turn.
export const runClaudeCodeLifecycleCommand = async (arguments_, deadline) => {
  const remaining = Math.floor(deadline - monotonicNow());
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new Error("integration.claude-code.deadline");
  const result = await execute(cli, [...arguments_, "--output", "json"], {
    cwd: "/worktree",
    env: cliEnvironment,
    uid: 1000,
    gid: 1000,
    timeout: remaining,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  if (monotonicNow() >= deadline)
    throw new Error("integration.claude-code.deadline");
  return result.stdout;
};

// run-scenarios already binds the family adapter to this exact staging name.
// The child inherits the selected wrapper's PTY. Its process set, input,
// deadline, cancellation and final drain remain owned by that one kernel.
export const runClaudeCodeInteractiveTurn = async (modelEndpoint, deadline) => {
  if (monotonicNow() >= deadline || !Number.isFinite(deadline))
    throw new Error("integration.claude-code.deadline");
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
    throw new Error("integration.claude-code.pty");
  const { claudeCodeInteractiveInvocation } = await import(
    new URL("./scenario-adapter.mjs", import.meta.url).href
  );
  const invocation = claudeCodeInteractiveInvocation(modelEndpoint);
  if (monotonicNow() >= deadline)
    throw new Error("integration.claude-code.deadline");
  await new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.arguments, {
      cwd: "/worktree",
      env: invocation.environment,
      uid: 1000,
      gid: 1000,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null)
        reject(new Error("integration.claude-code.vendor-terminal"));
      else resolve();
    });
  });
  if (monotonicNow() >= deadline)
    throw new Error("integration.claude-code.deadline");
};

// Messages streaming/auxiliary request expectations, readiness/checkpoint
// publication, receiver graph correlation and terminal completion are not yet
// composed. A vendor exit alone is never successful trace acceptance.
// This module deliberately emits no complete result, readiness marker, or
// admission artifact from its partial source-only CLI orchestration.
