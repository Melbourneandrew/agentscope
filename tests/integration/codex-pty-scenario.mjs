#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { createCodexInternalProviderConfiguration } from "./runtime/codex-configuration.js";
import {
  boundedRequestLedger,
  readBoundedJsonResponse,
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

const maximumOutput = 1024 * 1024;
const run = (executable, arguments_, options = {}) =>
  new Promise((resolve, reject) => {
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
const agentscopeHome = required("AGENTSCOPE_HOME");
const worktree = required("AGENTSCOPE_WORKTREE");
const ledger = required("AGENTSCOPE_LEDGER");
const scenarioId = required("AGENTSCOPE_SCENARIO_ID");
const modelEndpoint = required("AGENTSCOPE_MODEL_SERVER_URL");
for (const directory of [home, agentscopeHome, worktree, ledger])
  mkdirSync(directory, { recursive: true });
let interactiveFailurePhase = "bootstrap";
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

const cli = async (arguments_, command, options) =>
  parseMachine(
    (await run(agentscope, [...arguments_, "--output", "json"], options))
      .stdout,
    command,
  );

const prompt = "Reply with one short confirmation and do not use tools.";
const promptSha256 = createHash("sha256").update(prompt).digest("hex");
const requestJson = async (url, options) => {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(Math.min(5_000, remaining())),
  });
  if (!response.ok) throw new Error("integration.codex.sidecar");
  return readBoundedJsonResponse(response, maximumOutput);
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
      handler.timeout !== 3 ||
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
const readModelRequests = async () =>
  boundedRequestLedger(
    await requestJson(`${modelEndpoint}/mockserver/retrieve?type=REQUESTS`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
const waitForModelRequest = async () => {
  while ((await readModelRequests()).length === 0)
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    value.discovery.configurationLocationCount !== 1 ||
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
    value.changedTargetCount !== 1 ||
    value.disposition !== "committed" ||
    value.harness !== "codex" ||
    value.operation !== "uninstall" ||
    value.targetCount !== 1
  )
    throw new Error("integration.codex.uninstall");
  return { disposition: value.disposition, changedTargetCount: 1 };
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
const readTraceSummary = async (monotonicDeadline) => {
  const records = await cli(
    [
      "traces",
      "search",
      "--destination",
      "local",
      "--harness",
      "codex",
      "--limit",
      "50",
    ],
    "agentscope traces search",
    monotonicDeadline === undefined ? undefined : { monotonicDeadline },
  );
  if (
    records.length !== 1 ||
    !Array.isArray(records[0]?.summaries) ||
    records[0].summaries.length > 1
  )
    throw new Error("integration.codex.trace-search");
  if (records[0].summaries.length === 0) return null;
  const summary = records[0].summaries[0];
  if (
    summary?.harness !== "codex" ||
    typeof summary?.locator?.traceId !== "string"
  )
    throw new Error("integration.codex.trace-search");
  return summary;
};
const waitForTraceSummary = async () => {
  const traceDeadline = Math.min(deadline - 3_000, bootNow() + 15_000);
  while (true) {
    if (bootNow() >= traceDeadline)
      throw new Error("integration.codex.trace-deadline");
    const summary = await readTraceSummary(traceDeadline);
    if (bootNow() >= traceDeadline)
      throw new Error("integration.codex.trace-deadline");
    if (summary !== null) return summary;
    await new Promise((resolve) => setTimeout(resolve, 25));
    remaining();
  }
};

let completed = false;
try {
  interactiveFailurePhase = "install";
  await cli(["init", "--yes"], "agentscope init");
  await cli(
    ["destination", "configure", "local-sqlite", "--name", "local", "--yes"],
    "agentscope destination configure",
  );
  await cli(["routing", "set", "local"], "agentscope routing set");
  await cli(["install", "codex", "--yes"], "agentscope install");
  const installedStatus = projectHarnessStatus(
    await cli(["harness", "status", "codex"], "agentscope harness status"),
    "unchanged",
    1,
  );
  const codexHome = join(home, ".codex");
  const hookPath = join(codexHome, "hooks.json");
  const originalHooks = readFileSync(hookPath, "utf8");
  const launcher = installedLauncher(JSON.parse(originalHooks));
  if (!/\/agentscope-hook-v1-[a-f0-9]{64}-d2500$/u.test(launcher))
    throw new Error("integration.codex.hook-deadline");
  const launcherStatus = lstatSync(launcher);
  if (
    !launcherStatus.isFile() ||
    launcherStatus.isSymbolicLink() ||
    (launcherStatus.mode & 0o111) === 0
  )
    throw new Error("integration.codex.hook-configuration");
  const configuration = createCodexInternalProviderConfiguration({
    baseUrl: `${modelEndpoint}/v1`,
    model: "fixture-model",
  });
  writeFileSync(join(codexHome, "config.toml"), configuration, {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(join(codexHome, "config.toml"), 0o600);
  interactiveFailurePhase = "tui-start";
  const codexRun = run(
    codex,
    [
      "--no-alt-screen",
      "--dangerously-bypass-hook-trust",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      prompt,
    ],
    {
      cwd: worktree,
      env: { ...process.env, CODEX_HOME: codexHome },
      inherit: true,
    },
  );
  interactiveFailurePhase = "model-request";
  await waitForModelRequest();
  process.stdout.write("\u001b[?1049hAGENTSCOPE_PTY_READY\r\n");
  interactiveFailurePhase = "trace";
  let observedBeforeQuit;
  let traceFailure;
  try {
    observedBeforeQuit = await waitForTraceSummary();
  } catch (error) {
    traceFailure = error;
  }
  process.stdout.write("AGENTSCOPE_PTY_COMPLETE\r\n");
  interactiveFailurePhase = "tui-exit";
  await codexRun;
  if (traceFailure !== undefined) {
    interactiveFailurePhase = "trace";
    throw traceFailure;
  }
  interactiveFailurePhase = "verify";
  const modelRequests = await readModelRequests();
  if (readFileSync(hookPath, "utf8") !== originalHooks)
    throw new Error("integration.codex.hook-configuration");
  const summary = await readTraceSummary();
  if (
    summary === null ||
    summary.locator.traceId !== observedBeforeQuit?.locator.traceId
  )
    throw new Error("integration.codex.trace-search");
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
  );
  if (getRecords.length !== 1 || getRecords[0]?.locator?.traceId !== traceId)
    throw new Error("integration.codex.trace-get");
  const traceGraph = projectTraceGraph(getRecords[0].graph, traceId);
  const doctor = projectDoctor(await cli(["doctor"], "agentscope doctor"));
  const uninstallRecords = await cli(
    ["uninstall", "codex", "--yes"],
    "agentscope uninstall",
  );
  const uninstall = projectUninstall(uninstallRecords);
  if (existsSync(hookPath)) throw new Error("integration.codex.uninstall");
  const uninstalledStatus = projectHarnessStatus(
    await cli(["harness", "status", "codex"], "agentscope harness status"),
    "ready",
    0,
  );
  const translated = translateCodexPlatformObservations({
    scenarioId,
    prompt,
    promptSha256,
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
  writeFileSync(
    join(ledger, "fixture-result.json"),
    `${JSON.stringify({ evidenceVersion: 1, scenarioId, encodedEvidence })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  completed = true;
} finally {
  if (!completed) {
    try {
      rmSync(join(ledger, "fixture-result.json"));
    } catch {
      // The selected execution kernel owns terminal descendant settlement.
    }
  }
}
