import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  claudeScenarioFailureDiagnostic,
  encodeInteractiveFailureExitCode,
} from "./immutable-candidate-authority.mjs";
import {
  openMockServerControl,
  projectMockServerRequests,
  snapshotMockServerTraffic,
} from "./mockserver-control.mjs";
import {
  inspectClaudeCodeModelRequests,
  claudeModelLedger,
  correlateClaudeModelControl,
  observeClaudeCodeNativeTurn,
} from "./claude-code-platform-oracle.mjs";
import {
  claudeCodeLifecycleCommands,
  cliEnvironment,
  monotonicNow,
  prepareClaudeCodePackedCli,
  retireClaudeCodePackedCli,
  readClaudeCodeReadinessChallenge,
  runClaudeCodeLifecycleCommand,
} from "./claude-code-lifecycle.mjs";

const execute = promisify(execFile);
const childTerminalFailures = new WeakMap();
const childSignals = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
});
const childCodeIsInteger = Number.isSafeInteger;
const childSignalHasOwn = Object.hasOwn;
export const claudeCodeReadStimulus = Object.freeze({
  path: "/worktree/agentscope-claude-tool-stimulus.txt",
  contents: "agentscope-claude-tool-stimulus-v1\n",
  prompt:
    "Read /worktree/agentscope-claude-tool-stimulus.txt with Read, then reply DONE.",
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
// Upstream matcher grammar, not another request decoder. The terminal owner
// still independently checks the actual full ledger before declaring a turn.
export const claudeCodeReadExpectations = (model) => {
  const responses = claudeCodeReadResponses(model);
  const content = (role, block) => ({
    type: "object",
    required: ["role", "content"],
    properties: {
      role: { const: role },
      content: { type: "array", minItems: 1, contains: block },
    },
  });
  const tool = content("assistant", {
    type: "object",
    required: ["type", "id", "name", "input"],
    properties: {
      type: { const: "tool_use" },
      id: { const: responses.toolUseId },
      name: { const: "Read" },
      input: {
        type: "object",
        required: ["file_path"],
        properties: { file_path: { const: claudeCodeReadStimulus.path } },
      },
    },
  });
  const result = content("user", {
    type: "object",
    required: ["type", "tool_use_id"],
    properties: {
      type: { const: "tool_result" },
      tool_use_id: { const: responses.toolUseId },
      is_error: { const: false },
    },
  });
  const initial = content("user", {
    type: "object",
    required: ["type", "text"],
    properties: {
      type: { const: "text" },
      text: { const: claudeCodeReadStimulus.prompt },
    },
  });
  const expectation = (messages, response) => ({
    httpRequest: {
      method: "POST",
      path: "/v1/messages",
      body: {
        type: "JSON_SCHEMA",
        jsonSchema: JSON.stringify({
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          required: ["messages", "stream"],
          properties: {
            stream: { const: true },
            messages: {
              type: "array",
              minItems: messages.length,
              maxItems: messages.length,
              items: messages,
              additionalItems: false,
            },
          },
        }),
      },
    },
    httpResponse: {
      statusCode: 200,
      headers: { "Content-Type": [responses.contentType] },
      body: response,
    },
    times: { remainingTimes: 1, unlimited: false },
  });
  return Object.freeze([
    expectation([initial], responses.toolResponse),
    expectation([initial, tool, result], responses.finalResponse),
  ]);
};
export { claudeCodeLifecycleCommands, runClaudeCodeLifecycleCommand };
// run-scenarios already binds the family adapter to this exact staging name.
// The child inherits the selected wrapper's PTY. Its process set, input,
// deadline, cancellation and final drain remain owned by that one kernel.
export const runClaudeCodeInteractiveTurn = async (modelEndpoint, deadline) => {
  if (monotonicNow() >= deadline || !Number.isFinite(deadline))
    throw new Error("integration.claude-code.deadline");
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
    throw new Error("integration.claude-code.pty");
  const { claudeCodeInteractiveInvocation } =
    await import("./scenario-adapter.mjs");
  const invocation = claudeCodeInteractiveInvocation(modelEndpoint);
  if (monotonicNow() >= deadline)
    throw new Error("integration.claude-code.deadline");
  await new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/local/bin/node",
      ["/opt/agentscope/codex-candidate-dropper.mjs"],
      {
        cwd: "/worktree",
        env: {
          ...invocation.environment,
          AGENTSCOPE_CANDIDATE_HARNESS: "claude-code",
          AGENTSCOPE_CANDIDATE_RUN_ID:
            process.env.AGENTSCOPE_INTEGRATION_RUN_ID,
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        const error = new Error("integration.claude-code.vendor-terminal");
        if (
          signal === null &&
          childCodeIsInteger(code) &&
          code >= 1 &&
          code <= 255
        )
          childTerminalFailures.set(error, `code;${code}`);
        else if (
          code === null &&
          typeof signal === "string" &&
          childSignalHasOwn(childSignals, signal)
        )
          childTerminalFailures.set(error, `signal;${childSignals[signal]}`);
        reject(error);
      } else resolve();
    });
  });
  if (monotonicNow() >= deadline)
    throw new Error("integration.claude-code.deadline");
};

const publishClaudeMarker = (marker) =>
  new Promise((resolve, reject) => {
    process.stdout.write(marker, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
const waitForClaudeModelPair = async (control, turn, deadline) => {
  // A child ending before the observed provider handshake cannot be promoted
  // to completion. Keep its rejection handled while awaiting bounded controls.
  const earlyExit = turn.then(() => {
    throw new Error("integration.claude-code.early-exit");
  });
  earlyExit.catch(() => {});
  let pair, rows;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await Promise.race([control.requests(), earlyExit]);
    if (response.status !== 200)
      throw new Error("integration.claude-code.model-control");
    pair = inspectClaudeCodeModelRequests(
      response.bytes,
      claudeCodeReadStimulus,
    );
    rows = projectMockServerRequests(response.bytes);
    if (pair !== undefined) break;
    const remaining = deadline - monotonicNow();
    if (remaining <= 0 || attempt === 4)
      throw new Error("integration.claude-code.model-pair");
    await Promise.race([
      // Divide the original remaining budget across the finite control-row
      // allowance; do not accidentally create a new five-second turn cutoff.
      new Promise((resolve) =>
        setTimeout(resolve, Math.floor(remaining / (5 - attempt))),
      ),
      earlyExit,
    ]);
  }
  return { pair, rows };
};

// A delivered second request is not a delivered final response. Observe the
// actual final native record before allowing the existing PTY owner to exit.
// This trigger is not evidence: a strict independent reread follows the join.
const waitForClaudeNativeFinalTurn = async (turn, deadline) => {
  const earlyExit = turn.then(() => {
    throw new Error("integration.claude-code.native-early-exit");
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (monotonicNow() >= deadline)
      throw new Error("integration.claude-code.native-final-turn");
    const observed = await Promise.race([
      Promise.resolve().then(() =>
        observeClaudeCodeNativeTurn(claudeCodeReadStimulus, true),
      ),
      earlyExit,
    ]);
    if (monotonicNow() >= deadline)
      throw new Error("integration.claude-code.native-final-turn");
    if (observed !== undefined) return;
    const remaining = deadline - monotonicNow();
    if (remaining <= 0 || attempt === 4)
      throw new Error("integration.claude-code.native-final-turn");
    await Promise.race([
      new Promise((resolve) =>
        setTimeout(resolve, Math.floor(remaining / (5 - attempt))),
      ),
      earlyExit,
    ]);
  }
};

// This is the existing selected PTY scenario process, not a second driver.
// It emits only native partial evidence; the outer authenticated collector
// must independently join four real OTLP graphs before completing it.
const probeClaudeCandidate = (runId, deadline) =>
  execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {probeMockServerCandidate,readMockServerBootClock as now} from '/opt/agentscope/mockserver-control.mjs'; console.log(JSON.stringify(await probeMockServerCandidate({runId:${JSON.stringify(runId)},host:'mockserver',deadline:${deadline},now})));`,
    ],
    {
      cwd: "/worktree",
      env: cliEnvironment,
      uid: 1000,
      gid: 1000,
      timeout: Math.max(1, Math.floor(deadline - monotonicNow())),
      maxBuffer: 65536,
    },
  );
let claudeFailurePhase = "bootstrap";
const noteClaudeFailurePhase = (phase) => {
  claudeFailurePhase = phase;
};
export const runClaudeCodeScenario = async () => {
  const deadline = Number(process.env.AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS);
  const scenarioId = process.env.AGENTSCOPE_SCENARIO_ID;
  const runId = process.env.AGENTSCOPE_INTEGRATION_RUN_ID;
  if (
    !Number.isFinite(deadline) ||
    deadline <= monotonicNow() ||
    scenarioId !== "claude-interactive-trace-smoke" ||
    !/^[a-f0-9]{16}$/u.test(runId ?? "") ||
    process.env.AGENTSCOPE_WORKTREE !== "/worktree" ||
    process.env.HARNESS_HOME !== "/harness-home" ||
    process.env.AGENTSCOPE_LEDGER !== "/ledger" ||
    process.argv.length !== 4 ||
    process.argv[2] !== "--artifact"
  )
    throw new Error("integration.claude-code.environment");
  claudeFailurePhase = "readiness";
  const challenge = await readClaudeCodeReadinessChallenge(
    deadline,
    monotonicNow,
  );
  claudeFailurePhase = "packed-install";
  const { commands, settings } = await prepareClaudeCodePackedCli(
    deadline,
    noteClaudeFailurePhase,
  );
  claudeFailurePhase = "stimulus";
  prepareClaudeCodeReadStimulus();
  claudeFailurePhase = "model-config";
  if (process.env.AGENTSCOPE_MODEL_SERVER_URL !== "http://mockserver:1080")
    throw new Error("integration.claude-code.model-control");
  const control = openMockServerControl({
    runId,
    host: "mockserver",
    deadline,
    now: monotonicNow,
  });
  if (
    (await control.configure(claudeCodeReadExpectations("fixture-model")))
      .status !== 201
  )
    throw new Error("integration.claude-code.model-control");
  claudeFailurePhase = "candidate-denial";
  const candidate = await probeClaudeCandidate(runId, deadline);
  const denials = snapshotMockServerTraffic(
    JSON.parse(candidate.stdout),
    runId,
  );
  await publishClaudeMarker(`AGENTSCOPE_PTY_READY:${challenge}\r\n`);
  claudeFailurePhase = "model-pair";
  const turn = runClaudeCodeInteractiveTurn(
    "http://mockserver.agentscope.internal:1080",
    deadline,
  );
  const { pair, rows } = await waitForClaudeModelPair(control, turn, deadline);
  claudeFailurePhase = "native-final";
  await waitForClaudeNativeFinalTurn(turn, deadline);
  await publishClaudeMarker(
    `\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b\\`,
  );
  await turn;
  const native = observeClaudeCodeNativeTurn(
    claudeCodeReadStimulus,
    false,
    true,
  );
  claudeFailurePhase = "retirement";
  await retireClaudeCodePackedCli(commands, settings, deadline);
  claudeFailurePhase = "result";
  const traffic = correlateClaudeModelControl(
    rows,
    control.snapshot().entries,
    denials.entries,
  );
  if (monotonicNow() >= deadline)
    throw new Error("integration.claude-code.deadline");
  const evidence = {
    evidenceVersion: 1,
    resultStatus: "partial",
    scenarioId,
    artifactFileName: basename(process.argv[3]),
    certificationReadiness: null,
    lifecycle: ["install", "configure", "hook", "execute"],
    eventKinds: ["hook", "model"],
    harnessObservation: {
      observationVersion: 1,
      kind: "claude-code-native",
      ...native,
      ...pair,
      doctorErrors: 0,
      uninstallDisposition: "committed",
    },
    modelLedger: claudeModelLedger(
      rows,
      JSON.parse(
        readFileSync("/opt/agentscope/current-model-routes.json", "utf8"),
      ),
      scenarioId,
    ),
    destinationLedger: {
      ledgerVersion: 1,
      scenarioId,
      ingestion: [],
      retrieval: [],
    },
    mockServerTraffic: snapshotMockServerTraffic(
      { runId, entries: traffic },
      runId,
    ),
  };
  writeFileSync(
    "/ledger/fixture-result.json",
    `${JSON.stringify({ evidenceVersion: 1, scenarioId, encodedEvidence: Buffer.from(JSON.stringify(evidence)).toString("base64url") })}\n`,
    { flag: "wx", mode: 0o600 },
  );
};
const isClaudeScenarioMain = () => {
  if (process.argv[1] === undefined) return false;
  try {
    return (
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
};
if (isClaudeScenarioMain())
  try {
    await runClaudeCodeScenario();
  } catch (error) {
    process.exitCode = 1;
    try {
      const diagnostic = claudeScenarioFailureDiagnostic(
        error,
        claudeFailurePhase,
      );
      const terminal =
        diagnostic === "integration.fixture.claude-vendor-terminal"
          ? childTerminalFailures.get(error)
          : undefined;
      writeFileSync(
        "/ledger/interactive-failure.txt",
        `${diagnostic}${terminal === undefined ? "" : `|${terminal}`}\n`,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      process.exitCode =
        encodeInteractiveFailureExitCode(
          diagnostic,
          "claude-interactive-trace-smoke",
        ) ?? 1;
    } catch {
      // Failed or conflicting publication cannot replace the original refusal.
    }
    // Never forward child output, native bodies or credential-bearing errors.
    process.stderr.write("integration.claude-code.scenario\n");
  }
