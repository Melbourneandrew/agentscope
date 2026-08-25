import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const maximumPreparationMilliseconds = 300_000;
const preparationTeardownMilliseconds = 5_000;
const maximumCommandOutputBytes = 65_536;
const maximumAbsenceProofMilliseconds = 1_000;
const maximumProcessInspectionMilliseconds = 250;
const maximumProcessInspectionBytes = 1_048_576;
const absencePollMilliseconds = 10;

const fixedError = (code, timedOut = false) => {
  const error = new Error(code);
  if (timedOut) error.code = "ETIMEDOUT";
  return error;
};

const killOwnedProcess = (child) => {
  try {
    if (process.platform !== "win32" && child.pid !== undefined)
      process.kill(-child.pid, "SIGKILL");
    else if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") return false;
  }
  return true;
};

const waitUntil = (deadline) => {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolveWait) => setTimeout(resolveWait, remaining));
};

const processGroupIsAbsent = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
};

export const classifyProcessGroupState = (output, processGroup) => {
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    !Number.isSafeInteger(processGroup) ||
    processGroup < 1
  )
    return "unavailable";
  const members = [];
  for (const line of output.trimEnd().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (match === null) return "unavailable";
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(pgid))
      return "unavailable";
    if (pgid === processGroup) members.push(match[3]);
  }
  if (members.length === 0) return "absent";
  return members.every((state) => state.startsWith("Z"))
    ? "zombie-only"
    : "live";
};

const processExecutable = () =>
  process.platform === "darwin"
    ? "/bin/ps"
    : process.platform === "linux"
      ? "/usr/bin/ps"
      : undefined;

const inspectProcessGroup = (processGroup, deadline) => {
  const executable = processExecutable();
  const remaining = Math.floor(deadline - performance.now());
  if (executable === undefined || remaining < 1) return "unavailable";
  try {
    const output = execFileSync(executable, ["-axo", "pid=,pgid=,state="], {
      encoding: "utf8",
      maxBuffer: maximumProcessInspectionBytes,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: Math.min(maximumProcessInspectionMilliseconds, remaining),
    });
    return classifyProcessGroupState(output, processGroup);
  } catch {
    return "unavailable";
  }
};

const assertProcessInspectionAvailable = (deadline) => {
  if (inspectProcessGroup(process.pid, deadline) === "unavailable")
    throw fixedError("integration.images.platform");
};

const proveProcessGroupAbsent = async (pid, deadline) => {
  for (;;) {
    if (processGroupIsAbsent(pid)) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await waitUntil(
      Math.min(deadline, performance.now() + absencePollMilliseconds),
    );
  }
};

const never = () => new Promise(() => {});

const settleTerminatedProcess = async (child, closed, termination) => {
  const proofMilliseconds = Math.min(
    maximumAbsenceProofMilliseconds,
    Math.floor(termination.teardownMilliseconds / 2),
  );
  const inspectionMilliseconds = Math.max(
    1,
    Math.min(
      maximumProcessInspectionMilliseconds,
      Math.floor(termination.teardownMilliseconds / 2),
    ),
  );
  const inspectionDeadline = termination.deadline;
  const absenceDeadline = Math.max(
    performance.now(),
    inspectionDeadline - inspectionMilliseconds,
  );
  const removalDeadline = Math.max(
    performance.now(),
    absenceDeadline - proofMilliseconds,
  );
  const closeSettlement = closed.then((result) => ({ result }));
  let closeBeforeProof = await Promise.race([
    closeSettlement,
    waitUntil(removalDeadline).then(() => undefined),
  ]);
  termination.killConfirmed =
    killOwnedProcess(child) || termination.killConfirmed;
  const absent = await proveProcessGroupAbsent(child.pid, absenceDeadline);
  const groupState = absent
    ? "absent"
    : inspectProcessGroup(child.pid, inspectionDeadline);
  if (closeBeforeProof === undefined)
    closeBeforeProof = await Promise.race([
      closeSettlement,
      waitUntil(inspectionDeadline).then(() => undefined),
    ]);
  if (
    !termination.killConfirmed ||
    closeBeforeProof === undefined ||
    (groupState !== "absent" && groupState !== "zombie-only")
  )
    throw fixedError("integration.images.containment", true);
  if (groupState === "zombie-only")
    throw fixedError("integration.images.teardown", true);
  throw fixedError(
    termination.code,
    termination.code === "integration.images.timeout",
  );
};

const runUntilDeadline = async (
  executable,
  arguments_,
  { closeBarrier, deadline, teardownMilliseconds, environment, signal },
) => {
  if (process.platform === "win32")
    throw fixedError("integration.images.platform");
  if (signal?.aborted) throw fixedError("integration.images.interrupted");
  const workDeadline = deadline - teardownMilliseconds;
  assertProcessInspectionAvailable(workDeadline);
  const remainingWork = workDeadline - performance.now();
  if (remainingWork <= 0) throw fixedError("integration.images.timeout", true);
  let child;
  try {
    child = spawn(executable, arguments_, {
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw fixedError("integration.images.command");
  }
  let terminationState;
  let resolveTermination;
  const termination = new Promise((resolveTerminated) => {
    resolveTermination = resolveTerminated;
  });
  let outputBytes = 0;
  const output = [];
  const terminate = (code) => {
    if (terminationState !== undefined) return;
    terminationState = {
      code,
      deadline: Math.min(deadline, performance.now() + teardownMilliseconds),
      killConfirmed: killOwnedProcess(child),
      teardownMilliseconds,
    };
    resolveTermination(terminationState);
  };
  const consume = (chunk, retain) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > maximumCommandOutputBytes) {
      terminate("integration.images.output");
      return;
    }
    if (retain) output.push(chunk);
  };
  child.stdout?.on("data", (chunk) => consume(chunk, true));
  child.stderr?.on("data", (chunk) => consume(chunk, false));
  const onAbort = () => terminate("integration.images.interrupted");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => terminate("integration.images.timeout"),
    Math.max(1, remainingWork),
  );
  const closed = new Promise((resolveResult) => {
    child.once("error", () => {
      terminate("integration.images.command");
    });
    child.once("close", (code, childSignal) =>
      resolveResult({ code, childSignal }),
    );
  });
  const barrier = Promise.resolve()
    .then(() => closeBarrier?.())
    .catch(never);
  const observedClose = Promise.all([closed, barrier]).then(
    ([result]) => result,
  );
  try {
    const first = await Promise.race([
      observedClose.then((result) => ({ result })),
      termination.then((state) => ({ state })),
    ]);
    if ("state" in first)
      return await settleTerminatedProcess(child, closed, first.state);
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    if (!processGroupIsAbsent(child.pid)) {
      terminate("integration.images.command");
      return await settleTerminatedProcess(child, closed, terminationState);
    }
    const result = first.result;
    if (result.code !== 0 || result.childSignal !== null)
      throw fixedError("integration.images.command");
    return Buffer.concat(output).toString("utf8");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null)
      killOwnedProcess(child);
  }
};

const credentialFreeEnvironment = (environment, dockerConfig) => {
  const sanitized = { ...environment, DOCKER_CONFIG: dockerConfig };
  delete sanitized.DOCKER_AUTH_CONFIG;
  return sanitized;
};

export const preparePinnedDockerImages = async (images, options = {}) => {
  const preparationMilliseconds =
    options.maximumPreparationMilliseconds ?? maximumPreparationMilliseconds;
  const teardownMilliseconds =
    options.teardownMilliseconds ?? preparationTeardownMilliseconds;
  if (
    !Number.isSafeInteger(preparationMilliseconds) ||
    preparationMilliseconds < 2 ||
    preparationMilliseconds > maximumPreparationMilliseconds ||
    !Number.isSafeInteger(teardownMilliseconds) ||
    teardownMilliseconds < 1 ||
    teardownMilliseconds >= preparationMilliseconds ||
    teardownMilliseconds > preparationTeardownMilliseconds
  )
    throw fixedError("integration.images.deadline");
  const deadline = performance.now() + preparationMilliseconds;
  let dockerConfig;
  let prepared;
  let failure;
  try {
    dockerConfig = mkdtempSync(resolve(tmpdir(), "agentscope-docker-config-"));
  } catch {
    throw fixedError("integration.images.setup");
  }
  try {
    chmodSync(dockerConfig, 0o700);
    writeFileSync(resolve(dockerConfig, "config.json"), '{"auths":{}}\n', {
      mode: 0o600,
    });
    const environment = credentialFreeEnvironment(
      options.environment ?? process.env,
      dockerConfig,
    );
    const executable = options.dockerExecutable ?? "docker";
    const prefix = options.dockerArgumentsPrefix ?? [];
    prepared = [];
    for (const image of images) {
      await runUntilDeadline(executable, [...prefix, "pull", image], {
        closeBarrier: options.closeBarrier,
        deadline,
        teardownMilliseconds,
        environment,
        signal: options.signal,
      });
      const localImageDigest = (
        await runUntilDeadline(
          executable,
          [...prefix, "image", "inspect", "--format", "{{.Id}}", image],
          {
            closeBarrier: options.closeBarrier,
            deadline,
            teardownMilliseconds,
            environment,
            signal: options.signal,
          },
        )
      ).trim();
      if (!/^sha256:[a-f\d]{64}$/u.test(localImageDigest))
        throw fixedError("integration.images.digest");
      prepared.push({
        image,
        localImageDigest: localImageDigest.replace(":", "-"),
      });
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /^integration\.images\.[a-z-]+$/u.test(error.message)
    )
      failure = error;
    else failure = fixedError("integration.images.setup");
  }
  try {
    rmSync(dockerConfig, { force: true, recursive: true });
  } catch {
    failure = fixedError("integration.images.cleanup");
  }
  if (failure !== undefined) throw failure;
  return prepared;
};

export const publishPreparedImageEvidence = (target, evidence) => {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(evidence, undefined, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, target);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      throw fixedError("integration.images.cleanup");
    }
    throw fixedError("integration.images.publication");
  }
};

export const IMAGE_PREPARATION_LIMITS = Object.freeze({
  maximumPreparationMilliseconds,
  maximumTeardownMilliseconds: preparationTeardownMilliseconds,
  maximumCommandOutputBytes,
});
