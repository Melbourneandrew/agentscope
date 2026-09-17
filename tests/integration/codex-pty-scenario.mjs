#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

import { createCodexInternalProviderConfiguration } from "./runtime/codex-configuration.js";
import {
  boundedRequestLedger,
  classifyCodexSettledTraceObservation,
  inspectCodexStopHookCommand,
  codexSessionStartMediationUpperBoundMilliseconds,
  classifyTraceSearchRecordsBeforeDeadline,
  codexSessionIdentity,
  codexTurnTerminalIdAfterBaseline,
  codexTurnTerminalObservedAfterBaseline,
  localSqliteReporterSettled,
  openLocalSqliteLifecycle,
  inspectDiagnosticBeforeDeadline,
  publishTerminalCompletionBeforeDeadline,
  recordTerminalObservationBeforeDeadline,
  readCodexSessionLedgerRecords,
  readBoundedJsonResponse,
  terminalObservationBeforeDeadline,
  traceSummaryBeforeDeadline,
  waitForModelRequestBeforeDeadline,
  waitWithinObservationDeadline,
} from "./runtime/codex-runtime-evidence.mjs";
import { correlateCodexPlatformObservations } from "./scenario-oracle.mjs";
import { translateCodexPlatformObservations } from "./scenario-adapter.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`integration.codex.environment-${name}`);
  return value;
};
if (process.argv.length !== 4 || process.argv[2] !== "--artifact")
  throw new Error("integration.codex.arguments");
const artifactPath = process.argv[3];
const artifactStatus = lstatSync(artifactPath);
if (!artifactStatus.isFile() || artifactStatus.isSymbolicLink())
  throw new Error("integration.codex.artifact");
if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
  throw new Error("integration.codex.pty");

const bootNow = () => {
  const source = readFileSync("/proc/uptime", "utf8");
  if (source.length > 128 || !/^\d+(?:\.\d+)?\s/u.test(source))
    throw new Error("integration.codex.clock");
  return Number(source.split(/\s/u, 1)[0]) * 1_000;
};
const deadline = Number(required("AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS"));
if (!Number.isFinite(deadline) || deadline <= bootNow())
  throw new Error("integration.codex.deadline");
const remaining = () => {
  const value = deadline - bootNow();
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("integration.codex.deadline");
  return value;
};
const observeBeforeDiagnosticDeadline = async (completion, cutoff) => {
  const milliseconds = Math.floor(cutoff - bootNow());
  if (milliseconds <= 0)
    throw new Error("integration.codex.diagnostic-deadline");
  let timer;
  try {
    await Promise.race([
      completion,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("integration.codex.diagnostic-deadline")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
const readReadinessChallenge = () =>
  new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let timer;
    const settle = (error, value) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.pause();
      if (timer !== undefined) clearTimeout(timer);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onEnd = () => settle(new Error("integration.codex.readiness"));
    const onError = () => settle(new Error("integration.codex.readiness"));
    const onData = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65)
        return settle(new Error("integration.codex.readiness"));
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      const challenge = bytes.subarray(0, newline).toString("utf8");
      if (
        newline !== 64 ||
        bytes.length !== 65 ||
        !/^[a-f0-9]{64}$/u.test(challenge)
      )
        return settle(new Error("integration.codex.readiness"));
      settle(undefined, challenge);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
    timer = setTimeout(
      () => settle(new Error("integration.codex.readiness")),
      Math.min(10_000, remaining()),
    );
  });
const readinessChallenge = await readReadinessChallenge();
const expectedAssistantMessage = `AGENTSCOPE_CODEX_RESPONSE:${readinessChallenge}`;
const terminalCompletionMarker = `AGENTSCOPE_PTY_COMPLETE:${readinessChallenge}`;
const waitForCheckpointSignal = () =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      process.off("SIGUSR2", onSignal);
      if (timer !== undefined) clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onSignal = () => settle();
    process.once("SIGUSR2", onSignal);
    timer = setTimeout(
      () => settle(new Error("integration.codex.process-checkpoint")),
      Math.min(5_000, remaining()),
    );
  });

const maximumOutput = 1024 * 1024;
const run = (executable, arguments_, options = {}) => {
  let childPid;
  const completion = new Promise((resolve, reject) => {
    remaining();
    const timeoutMilliseconds =
      options.monotonicDeadline === undefined
        ? undefined
        : Math.floor(options.monotonicDeadline - bootNow());
    if (timeoutMilliseconds !== undefined && timeoutMilliseconds <= 0) {
      reject(new Error("integration.codex.child-deadline"));
      return;
    }
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    childPid = child.pid;
    let deadlineExpired = false;
    const timer =
      timeoutMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            deadlineExpired = true;
            child.kill("SIGKILL");
          }, timeoutMilliseconds);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    if (!options.inherit) {
      child.stdout.on("data", (chunk) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > maximumOutput) child.stdout.destroy();
      });
      child.stderr.on("data", (chunk) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > maximumOutput) child.stderr.destroy();
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      try {
        remaining();
        if (
          deadlineExpired ||
          code !== 0 ||
          signal !== null ||
          stdout.length > maximumOutput ||
          stderr.length > maximumOutput
        )
          return reject(new Error("integration.codex.child"));
        resolve({ stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
  Object.defineProperty(completion, "childPid", {
    configurable: false,
    enumerable: false,
    value: childPid,
    writable: false,
  });
  return completion;
};
const parseMachine = (bytes, command) => {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    value?.command !== command ||
    value?.completion !== "complete" ||
    !Array.isArray(value.records)
  )
    throw new Error("integration.codex.cli-output");
  return value.records;
};

const agentscope = "/opt/agentscope/installed/node_modules/.bin/agentscope";
const codex = "/opt/agentscope/harness/node_modules/.bin/codex";
const home = required("HOME");
const codexHome = join(home, ".codex");
const agentscopeHome = required("AGENTSCOPE_HOME");
const worktree = required("AGENTSCOPE_WORKTREE");
const ledger = required("AGENTSCOPE_LEDGER");
const scenarioId = required("AGENTSCOPE_SCENARIO_ID");
const modelEndpoint = required("AGENTSCOPE_MODEL_SERVER_URL");
if (worktree !== "/worktree")
  throw new Error("integration.codex.environment-AGENTSCOPE_WORKTREE");
for (const directory of [home, agentscopeHome, worktree, ledger])
  mkdirSync(directory, { recursive: true });
const codexDiagnosticLogDirectory = join(codexHome, "diagnostic-log");
const homeDescriptor = openSync(
  home,
  constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK,
);
let localSqliteLifecycleDescriptor;
let codexDiagnosticLogDirectoryDescriptor;
let interactiveFailurePhase = "bootstrap";
let interactiveFailurePhaseIndex = -1;
const interactivePhases = Object.freeze([
  "bootstrap",
  "init",
  "destination",
  "routing",
  "install",
  "installed-status",
  "tui-start",
  "model-request",
  "trace-terminal",
  "tui-exit",
  "trace-settlement",
  "trace-search",
  "hook-command-timeout",
  "hook-command-spawn-error",
  "hook-command-stdin-error",
  "hook-command-wait-error",
  "hook-command-completed-before-budget-boundary",
  "hook-command-completed-near-budget-boundary",
  "trace-search-record-count",
  "trace-search-shape",
  "trace-search-ambiguous",
  "trace-search-harness",
  "trace-search-locator",
  "trace-reporter-settled",
  "trace-acceptance",
  "trace-search-result",
  "verify",
]);
const recordInteractivePhase = (phase) => {
  const phaseIndex = interactivePhases.indexOf(phase);
  if (phaseIndex <= interactiveFailurePhaseIndex)
    throw new Error("integration.codex.failure-phase");
  interactiveFailurePhase = phase;
  interactiveFailurePhaseIndex = phaseIndex;
  writeFileSync(
    join(ledger, `interactive-phase-${phase}.txt`),
    `integration.fixture.codex-${phase}\n`,
    { flag: "wx", mode: 0o600 },
  );
};
const codexStopHookCommandFailure = (outcome) => {
  let phase;
  if (outcome === "timeout") phase = "hook-command-timeout";
  else if (outcome === "spawn_error") phase = "hook-command-spawn-error";
  else if (outcome === "stdin_error") phase = "hook-command-stdin-error";
  else if (outcome === "wait_error") phase = "hook-command-wait-error";
  else throw new Error("integration.codex.hook-command-outcome");
  return { error: `integration.codex.hook-command-${outcome}`, phase };
};
recordInteractivePhase(interactiveFailurePhase);
if (process.hasUncaughtExceptionCaptureCallback())
  throw new Error("integration.codex.failure-capture");
process.setUncaughtExceptionCaptureCallback(() => {
  try {
    writeFileSync(
      join(ledger, "interactive-failure.txt"),
      `integration.fixture.codex-${interactiveFailurePhase}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    process.exit(1);
  }
});

const cli = async (arguments_, command, options) => {
  const { stdout } = await run(
    agentscope,
    [...arguments_, "--output", "json"],
    options,
  );
  const monotonicDeadline = options?.monotonicDeadline;
  if (
    monotonicDeadline !== undefined &&
    !terminalObservationBeforeDeadline({
      observed: true,
      deadline: monotonicDeadline,
      now: bootNow,
    })
  )
    throw new Error("integration.codex.trace-deadline");
  const records = parseMachine(stdout, command);
  if (
    monotonicDeadline !== undefined &&
    !terminalObservationBeforeDeadline({
      observed: true,
      deadline: monotonicDeadline,
      now: bootNow,
    })
  )
    throw new Error("integration.codex.trace-deadline");
  return records;
};

const prompt = "Reply with one short confirmation and do not use tools.";
const promptSha256 = createHash("sha256").update(prompt).digest("hex");
const requestJson = async (url, options = {}) => {
  const { signal, ...requestOptions } = options;
  if (signal?.aborted) throw new Error("integration.codex.sidecar");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, Math.min(5_000, remaining()));
  try {
    const response = await fetch(url, {
      ...requestOptions,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("integration.codex.sidecar");
    return await readBoundedJsonResponse(response, maximumOutput);
  } catch {
    throw new Error("integration.codex.sidecar");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};
const exactKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const installedLauncher = (hookConfiguration) => {
  if (
    !exactKeys(hookConfiguration, ["hooks"]) ||
    !exactKeys(hookConfiguration.hooks, ["SessionStart", "Stop", "SessionEnd"])
  )
    throw new Error("integration.codex.hook-configuration");
  const commands = ["SessionStart", "Stop", "SessionEnd"].map((event) => {
    const groups = hookConfiguration.hooks[event];
    const group = groups?.[0];
    const handler = group?.hooks?.[0];
    const expectedGroupKeys =
      event === "SessionStart" ? ["hooks", "matcher"] : ["hooks"];
    if (
      !Array.isArray(groups) ||
      groups.length !== 1 ||
      !exactKeys(group, expectedGroupKeys) ||
      !Array.isArray(group.hooks) ||
      group.hooks.length !== 1 ||
      (event === "SessionStart" && group.matcher !== "startup|resume|clear") ||
      !exactKeys(handler, ["command", "statusMessage", "timeout", "type"]) ||
      handler.type !== "command" ||
      handler.timeout !== 7 ||
      handler.statusMessage !== "Agentscope trace capture"
    )
      throw new Error("integration.codex.hook-configuration");
    return handler.command;
  });
  if (
    commands.some((command) => typeof command !== "string") ||
    new Set(commands).size !== 1 ||
    !/^'[^']+'$/u.test(commands[0])
  )
    throw new Error("integration.codex.hook-configuration");
  return commands[0].slice(1, -1);
};
const readModelRequests = async (signal) =>
  boundedRequestLedger(
    await requestJson(`${modelEndpoint}/mockserver/retrieve?type=REQUESTS`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal,
    }),
  );
const readBoundedResponseText = async (response) => {
  if (!response.body) throw new Error("integration.codex.model-gateway");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maximumOutput)
      throw new Error("integration.codex.model-gateway");
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
};
const openChallengedModelGateway = async () => {
  let failure;
  let requestCount = 0;
  let closeResolved = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const finishClose = () => {
    if (closeResolved) return;
    closeResolved = true;
    resolveClosed();
  };
  const server = createServer(async (request, response) => {
    requestCount += 1;
    request.setTimeout(Math.min(5_000, remaining()), () =>
      request.destroy(new Error("integration.codex.model-gateway")),
    );
    try {
      if (
        requestCount !== 1 ||
        request.method !== "POST" ||
        request.url !== "/v1/responses" ||
        request.headers["content-type"] !== "application/json"
      )
        throw new Error("integration.codex.model-gateway");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > maximumOutput)
          throw new Error("integration.codex.model-gateway");
        chunks.push(value);
      }
      const upstream = await fetch(`${modelEndpoint}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.concat(chunks, bytes),
        signal: AbortSignal.timeout(Math.min(5_000, remaining())),
      });
      if (
        !upstream.ok ||
        upstream.headers.get("content-type") !== "text/event-stream"
      )
        throw new Error("integration.codex.model-gateway");
      const body = await readBoundedResponseText(upstream);
      if (
        body.split("AGENTSCOPE_PTY_COMPLETE").length !== 2 ||
        body.includes(expectedAssistantMessage)
      )
        throw new Error("integration.codex.model-gateway");
      codexLedgerBaseline = readCodexSessionLedgerRecords(homeDescriptor);
      if (codexLedgerBaseline.length !== 1)
        throw new Error("integration.codex.session-ledger");
      codexSessionId = codexSessionIdentity(codexLedgerBaseline);
      if (
        codexTurnTerminalObservedAfterBaseline(
          codexLedgerBaseline,
          codexLedgerBaseline,
          expectedAssistantMessage,
        )
      )
        throw new Error("integration.codex.session-ledger");
      const challenged = body.replace(
        "AGENTSCOPE_PTY_COMPLETE",
        expectedAssistantMessage,
      );
      const checkpointSignal = waitForCheckpointSignal();
      process.stdout.write(
        `\u001b[?1049hAGENTSCOPE_PTY_READY:${readinessChallenge}\r\n`,
      );
      await checkpointSignal;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(challenged);
    } catch (error) {
      failure = error;
      response.statusCode = 502;
      response.end();
    } finally {
      server.close(finishClose);
    }
  });
  server.on("clientError", (error, socket) => {
    failure = error;
    socket.destroy();
    server.close(finishClose);
  });
  server.headersTimeout = Math.min(5_000, remaining());
  server.requestTimeout = Math.min(5_000, remaining());
  server.keepAliveTimeout = 1_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("integration.codex.model-gateway");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    settle: async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("integration.codex.model-gateway")),
          Math.min(5_000, remaining()),
        );
        closed.then(() => {
          clearTimeout(timer);
          resolve();
        }, reject);
      });
      if (failure !== undefined || requestCount !== 1)
        throw new Error("integration.codex.model-gateway");
    },
    abort: () => {
      server.closeAllConnections();
      server.close(finishClose);
    },
  };
};
const projectHarnessStatus = (
  records,
  installation,
  configurationPresentCount,
) => {
  const value = records?.[0];
  if (
    records.length !== 1 ||
    value?.installation !== installation ||
    value?.discovery?.harness !== "codex" ||
    value.discovery.harnessType !== "@agentscope/harness-codex" ||
    value.discovery.state !== "installed" ||
    value.discovery.reason !== "compatible" ||
    value.discovery.version !== "0.149.1" ||
    value.discovery.configurationLocationCount !== 2 ||
    value.discovery.configurationPresentCount !== configurationPresentCount
  )
    throw new Error("integration.codex.harness-status");
  return { installation, configurationPresentCount };
};
const projectDoctor = (records) => {
  const report = records?.[0];
  if (
    records.length !== 1 ||
    report?.fixed !== false ||
    !Array.isArray(report.repairs) ||
    report.repairs.length !== 0 ||
    !Array.isArray(report.findings) ||
    report.findings.length < 1 ||
    report.findings.length > 1_159 ||
    report.summary?.errors !== 0 ||
    report.findings.some(({ severity }) => severity === "error")
  )
    throw new Error("integration.codex.doctor");
  for (const [code, state] of [
    ["doctor.harness.installed", "installed"],
    ["doctor.hook.unchanged", "unchanged"],
  ]) {
    const matches = report.findings.filter(
      (finding) =>
        finding?.code === code &&
        finding?.evidence?.state === state &&
        finding.evidence.subject === "codex" &&
        finding.severity === "info" &&
        finding.suggestedAction === "none",
    );
    if (matches.length !== 1) throw new Error("integration.codex.doctor");
  }
  return {
    findingCount: report.findings.length,
    errors: report.summary.errors,
    warnings: report.summary.warnings,
  };
};
const projectUninstall = (records) => {
  const value = records?.[0];
  if (
    records.length !== 1 ||
    value?.applied !== true ||
    value.changedTargetCount !== 3 ||
    value.disposition !== "committed" ||
    value.harness !== "codex" ||
    value.operation !== "uninstall" ||
    value.targetCount !== 3
  )
    throw new Error("integration.codex.uninstall");
  return {
    disposition: value.disposition,
    changedTargetCount: 3,
    targetCount: 3,
  };
};
const projectTraceGraph = (graph, traceId) => {
  if (!Array.isArray(graph?.resourceSpans) || graph.resourceSpans.length < 1)
    throw new Error("integration.codex.trace-get");
  const spans = graph.resourceSpans.flatMap((resource) =>
    Array.isArray(resource?.scopeSpans)
      ? resource.scopeSpans.flatMap((scope) =>
          Array.isArray(scope?.spans) ? scope.spans : [],
        )
      : [],
  );
  const root = spans.find(({ name }) => name === "codex.turn");
  const model = spans.find(({ name }) => name === "codex.response");
  const stringAttribute = (span, key) => {
    const matches = Array.isArray(span?.attributes)
      ? span.attributes.filter((attribute) => attribute?.key === key)
      : [];
    return matches.length === 1 &&
      typeof matches[0]?.value?.stringValue === "string"
      ? matches[0].value.stringValue
      : null;
  };
  if (
    spans.length !== 2 ||
    root?.traceId !== traceId ||
    model?.traceId !== traceId ||
    typeof root.spanId !== "string" ||
    root.spanId.length !== 16 ||
    model?.parentSpanId !== root.spanId ||
    (root.parentSpanId !== undefined && root.parentSpanId !== "")
  )
    throw new Error("integration.codex.trace-get");
  return {
    resourceSpanCount: graph.resourceSpans.length,
    spanNames: [root.name, model.name],
    parentLinked: true,
    sessionId: stringAttribute(root, "session.id"),
    modelName: stringAttribute(model, "llm.model_name"),
  };
};
const readTraceSummary = async (traceDeadline) => {
  if (codexSessionId === undefined)
    throw new Error("integration.codex.session-ledger");
  const { stdout } = await run(
    agentscope,
    [
      "traces",
      "search",
      "--destination",
      "local",
      "--session",
      codexSessionId,
      "--limit",
      "50",
      "--output",
      "json",
    ],
    { monotonicDeadline: traceDeadline },
  );
  if (
    !terminalObservationBeforeDeadline({
      observed: true,
      deadline: traceDeadline,
      now: bootNow,
    })
  )
    throw new Error("integration.codex.trace-deadline");
  const records = parseMachine(stdout, "agentscope traces search");
  return classifyTraceSearchRecordsBeforeDeadline({
    records,
    deadline: traceDeadline,
    now: bootNow,
    record: recordInteractivePhase,
  });
};
const waitForCodexTurnTerminal = async (traceDeadline) => {
  if (codexLedgerBaseline === undefined)
    throw new Error("integration.codex.session-ledger");
  while (true) {
    if (bootNow() >= traceDeadline)
      throw new Error("integration.codex.trace-deadline");
    const records = readCodexSessionLedgerRecords(homeDescriptor);
    const turnId = codexTurnTerminalIdAfterBaseline(
      records,
      codexLedgerBaseline,
      expectedAssistantMessage,
    );
    if (
      terminalObservationBeforeDeadline({
        observed: turnId !== null,
        deadline: traceDeadline,
        now: bootNow,
      })
    )
      return { records, turnId };
    await waitWithinObservationDeadline({
      deadline: traceDeadline,
      maximumWaitMilliseconds: 100,
      now: bootNow,
      wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    remaining();
  }
};
const waitForTraceSummary = async (traceDeadline) => {
  if (bootNow() >= traceDeadline)
    throw new Error("integration.codex.trace-deadline");
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-search"),
  });
  let summary;
  while (summary === undefined) {
    const hookCommandObservation = inspectDiagnosticBeforeDeadline({
      deadline: traceDeadline,
      now: bootNow,
      inspect: () =>
        inspectCodexStopHookCommand({
          directoryDescriptor: codexDiagnosticLogDirectoryDescriptor,
          directoryPath: codexDiagnosticLogDirectory,
        }),
    });
    if (
      hookCommandObservation !== undefined &&
      hookCommandObservation.outcome !== "completed"
    ) {
      const failure = codexStopHookCommandFailure(
        hookCommandObservation.outcome,
      );
      recordTerminalObservationBeforeDeadline({
        deadline: traceDeadline,
        now: bootNow,
        record: () => recordInteractivePhase(failure.phase),
      });
      throw new Error(failure.error);
    }
    const reporterSettled = localSqliteReporterSettled(
      localSqliteLifecycleDescriptor,
    );
    const candidate = traceSummaryBeforeDeadline({
      summary: await readTraceSummary(traceDeadline),
      deadline: traceDeadline,
      now: bootNow,
    });
    const terminalCut = classifyCodexSettledTraceObservation({
      hookCompleted: hookCommandObservation?.outcome === "completed",
      reporterSettled,
      tracePresent: candidate !== null,
    });
    if (terminalCut === "accepted") {
      summary = candidate;
      break;
    }
    if (terminalCut === "missing") {
      const nearBudgetBoundary =
        hookCommandObservation.durationMilliseconds >= 4_900;
      const phase = nearBudgetBoundary
        ? "hook-command-completed-near-budget-boundary"
        : "hook-command-completed-before-budget-boundary";
      recordTerminalObservationBeforeDeadline({
        deadline: traceDeadline,
        now: bootNow,
        record: () => recordInteractivePhase(phase),
      });
      throw new Error(`integration.codex.${phase}`);
    }
    await waitWithinObservationDeadline({
      deadline: traceDeadline,
      maximumWaitMilliseconds: 100,
      now: bootNow,
      wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    remaining();
  }
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-reporter-settled"),
  });
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-acceptance"),
  });
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-search-result"),
  });
  return summary;
};

let completed = false;
let modelGateway;
let codexLedgerBaseline;
let codexSessionId;
try {
  recordInteractivePhase("init");
  await cli(["init", "--yes"], "agentscope init");
  recordInteractivePhase("destination");
  await cli(
    ["destination", "configure", "local-sqlite", "--name", "local", "--yes"],
    "agentscope destination configure",
  );
  recordInteractivePhase("routing");
  await cli(["routing", "set", "local"], "agentscope routing set");
  recordInteractivePhase("install");
  await cli(["install", "codex", "--yes"], "agentscope install");
  const hookPath = join(codexHome, "hooks.json");
  const originalHooks = readFileSync(hookPath, "utf8");
  const launcher = installedLauncher(JSON.parse(originalHooks));
  if (!/\/agentscope-hook-v1-[a-f0-9]{64}-d5000$/u.test(launcher))
    throw new Error("integration.codex.hook-deadline");
  const launcherStatus = lstatSync(launcher);
  if (
    !launcherStatus.isFile() ||
    launcherStatus.isSymbolicLink() ||
    (launcherStatus.mode & 0o111) === 0
  )
    throw new Error("integration.codex.hook-configuration");
  localSqliteLifecycleDescriptor = openLocalSqliteLifecycle(homeDescriptor);
  recordInteractivePhase("installed-status");
  const installedStatus = projectHarnessStatus(
    await cli(["harness", "status", "codex"], "agentscope harness status"),
    "unchanged",
    1,
  );
  modelGateway = await openChallengedModelGateway();
  mkdirSync(codexDiagnosticLogDirectory, { mode: 0o700 });
  codexDiagnosticLogDirectoryDescriptor = openSync(
    codexDiagnosticLogDirectory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  // TOML has no syntax for returning to the root table. Keep every root key
  // ahead of the first table emitted by the provider configuration; appending
  // log_dir after it would silently make the key part of model_providers.
  const configuration = `log_dir = ${JSON.stringify(codexDiagnosticLogDirectory)}\n${createCodexInternalProviderConfiguration(
    {
      baseUrl: `${modelGateway.endpoint}/v1`,
      model: "fixture-model",
    },
  )}\n[projects."/worktree"]\ntrust_level = "trusted"\n`;
  writeFileSync(join(codexHome, "config.toml"), configuration, {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(join(codexHome, "config.toml"), 0o600);
  const traceDeadline = deadline - 3_000;
  recordInteractivePhase("tui-start");
  const codexRun = run(
    codex,
    [
      "--no-alt-screen",
      "--enable",
      "hooks",
      "--dangerously-bypass-hook-trust",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      prompt,
    ],
    {
      cwd: worktree,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        RUST_LOG: "codex_hooks::engine::command_runner=trace",
      },
      inherit: true,
    },
  );
  await waitForModelRequestBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    request: readModelRequests,
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
  recordInteractivePhase("model-request");
  await modelGateway.settle();
  recordInteractivePhase("trace-terminal");
  // Codex 0.149.1 deliberately excludes transient hook lifecycle events from
  // its rollout. Prove the installed hook through the durable trace and exact
  // rollout session identity below, after the sole challenged turn completes
  // and Testkit joins Codex so its vendor Stop hook has run.
  await waitForCodexTurnTerminal(traceDeadline);
  await publishTerminalCompletionBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("tui-exit"),
    publish: () =>
      new Promise((resolve, reject) => {
        process.stdout.write(`${terminalCompletionMarker}\r\n`, (error) =>
          error === null || error === undefined ? resolve() : reject(error),
        );
      }),
  });
  await observeBeforeDiagnosticDeadline(codexRun, traceDeadline);
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("trace-settlement"),
  });
  const summary = await waitForTraceSummary(traceDeadline);
  const sessionStartCommandDurationMilliseconds =
    inspectDiagnosticBeforeDeadline({
      deadline: traceDeadline,
      now: bootNow,
      inspect: () =>
        codexSessionStartMediationUpperBoundMilliseconds({
          directoryDescriptor: codexDiagnosticLogDirectoryDescriptor,
          directoryPath: codexDiagnosticLogDirectory,
        }),
    });
  if (
    sessionStartCommandDurationMilliseconds === undefined ||
    sessionStartCommandDurationMilliseconds > 1_000
  )
    throw new Error("integration.codex.hook-mediation");
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () => recordInteractivePhase("verify"),
  });
  if (readFileSync(hookPath, "utf8") !== originalHooks)
    throw new Error("integration.codex.hook-configuration");
  const modelRequests = await readModelRequests();
  const traceId = summary?.locator?.traceId;
  if (summary?.harness !== "codex" || typeof traceId !== "string")
    throw new Error("integration.codex.trace-search");
  const getRecords = await cli(
    [
      "traces",
      "get",
      "--destination",
      "local",
      "--trace-ref",
      JSON.stringify(summary.locator),
    ],
    "agentscope traces get",
    { monotonicDeadline: traceDeadline },
  );
  if (getRecords.length !== 1 || getRecords[0]?.locator?.traceId !== traceId)
    throw new Error("integration.codex.trace-get");
  const traceGraph = projectTraceGraph(getRecords[0].graph, traceId);
  if (codexSessionId === undefined || traceGraph.sessionId !== codexSessionId)
    throw new Error("integration.codex.trace-correlation");
  const doctor = projectDoctor(
    await cli(["doctor"], "agentscope doctor", {
      monotonicDeadline: traceDeadline,
    }),
  );
  const uninstallRecords = await cli(
    ["uninstall", "codex", "--yes"],
    "agentscope uninstall",
    { monotonicDeadline: traceDeadline },
  );
  const uninstall = projectUninstall(uninstallRecords);
  if (existsSync(hookPath)) throw new Error("integration.codex.uninstall");
  const uninstalledStatus = projectHarnessStatus(
    await cli(["harness", "status", "codex"], "agentscope harness status", {
      monotonicDeadline: traceDeadline,
    }),
    "ready",
    1,
  );
  const translated = translateCodexPlatformObservations({
    scenarioId,
    prompt,
    promptSha256,
    mediation: { sessionStartCommandDurationMilliseconds },
    modelRequests,
    search: {
      completion: "complete",
      harness: summary.harness,
      spanCount: summary.spanCount,
      traceId,
    },
    retrieval: {
      completion: "complete",
      ...traceGraph,
      traceId,
    },
    doctor: { completion: "complete", ...doctor },
    uninstall: {
      completion: "complete",
      installedStatus,
      uninstall,
      uninstalledStatus,
    },
  });
  const evidence = correlateCodexPlatformObservations(translated, {
    artifactFileName: basename(artifactPath),
    expectedPromptSha256: promptSha256,
    scenarioId,
  });
  const encodedEvidence = Buffer.from(JSON.stringify(evidence)).toString(
    "base64url",
  );
  recordTerminalObservationBeforeDeadline({
    deadline: traceDeadline,
    now: bootNow,
    record: () =>
      writeFileSync(
        join(ledger, "fixture-result.json"),
        `${JSON.stringify({ evidenceVersion: 1, scenarioId, encodedEvidence })}\n`,
        { flag: "wx", mode: 0o600 },
      ),
  });
  completed = true;
} finally {
  modelGateway?.abort();
  if (localSqliteLifecycleDescriptor !== undefined)
    closeSync(localSqliteLifecycleDescriptor);
  if (codexDiagnosticLogDirectoryDescriptor !== undefined)
    closeSync(codexDiagnosticLogDirectoryDescriptor);
  closeSync(homeDescriptor);
  if (!completed) {
    try {
      rmSync(join(ledger, "fixture-result.json"));
    } catch {
      // The selected execution kernel owns terminal descendant settlement.
    }
  }
}
