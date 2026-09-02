import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runnerPath = fileURLToPath(import.meta.url);
const testRoot = resolve(workspaceRoot, "scripts/__tests__");
const configPath = resolve(workspaceRoot, "vitest.config.ts");
const vitestPath = realpathSync(
  resolve(
    dirname(fileURLToPath(import.meta.resolve("vitest"))),
    "../vitest.mjs",
  ),
);

export const processAuthorityFiles = Object.freeze([
  "code-quality-policy.test.mjs",
  "validation-lease.test.mjs",
  "prepush.test.mjs",
]);

export const purePolicyFiles = Object.freeze([
  "acceptance-evidence.test.mjs",
  "crabbox-coordinator-plan.test.mjs",
  "crabbox-coordinator-profile.test.mjs",
  "crabbox-coordinator-retirement-profile.test.mjs",
  "release-lane-substrate.test.mjs",
  "restricted-import-policy.test.mjs",
  "review-skill.test.mjs",
  "workspace-dependency-policy.test.mjs",
  "workspace-policy-runner.test.mjs",
  "workspace-target-policy.test.mjs",
]);

const classificationsByName = new Map([
  ...purePolicyFiles.map((name) => [name, "pure"]),
  ...processAuthorityFiles.map((name) => [name, "authority"]),
]);
export const requiredPolicyFiles = Object.freeze([
  ...purePolicyFiles,
  "code-quality-policy.test.mjs",
  "validation-lease.test.mjs",
]);
const forwardedSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const terminalSignals = Object.freeze(Object.keys(osConstants.signals).sort());
const pureWorkerCeiling = 2;
const internalChildMarker = "--internal-workspace-policy-child";
export const childLifecycleBounds = Object.freeze({
  hardMilliseconds: 300_000,
  pollMilliseconds: 20,
  signalGraceMilliseconds: 100,
  teardownMilliseconds: 5_000,
});

function fail(message) {
  throw new Error(`workspace-policy scheduling rejected: ${message}`);
}

export function discoverWorkspacePolicyInventory(root = testRoot) {
  const canonicalRoot = realpathSync(root);
  const inventory = [];
  for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) {
    if (entry.isDirectory())
      fail(`nested test directory is not admitted: ${entry.name}`);
    if (!entry.isFile())
      fail(`test-root entry is not a regular file: ${entry.name}`);
    if (!entry.name.endsWith(".test.mjs")) continue;
    const path = resolve(canonicalRoot, entry.name);
    if (realpathSync(path) !== path)
      fail(`test path is not canonical: ${entry.name}`);
    inventory.push(entry.name);
  }
  return Object.freeze(inventory.sort());
}

export function classifyWorkspacePolicyInventory(inventory) {
  return inventory.map((name) => {
    const classification = classificationsByName.get(name);
    if (classification === undefined)
      fail(`test has no reviewed classification: ${name}`);
    return { classification, name };
  });
}

export function validateWorkspacePolicyInventory(inventory) {
  if (!Array.isArray(inventory)) fail("inventory must be an array");
  const observed = new Set(inventory);
  if (observed.size !== inventory.length) fail("inventory contains duplicates");
  for (const name of requiredPolicyFiles)
    if (!observed.has(name)) fail(`required test is missing: ${name}`);
  for (const name of observed)
    if (!classificationsByName.has(name))
      fail(`test has no reviewed classification: ${name}`);
  return inventory;
}

export function createWorkspacePolicyPlan(inventory, classifications) {
  if (!Array.isArray(inventory) || !Array.isArray(classifications))
    fail("inventory and classifications must be arrays");
  const expected = new Set();
  for (const name of inventory) {
    if (
      typeof name !== "string" ||
      !name.endsWith(".test.mjs") ||
      basename(name) !== name
    )
      fail("inventory contains an invalid test name");
    if (expected.has(name)) fail(`duplicate inventory entry: ${name}`);
    expected.add(name);
  }
  const classified = new Set();
  const pure = [];
  const authority = [];
  for (const record of classifications) {
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.name !== "string"
    )
      fail("classification record is malformed");
    if (!expected.has(record.name))
      fail(`classification names an unknown test: ${record.name}`);
    if (classified.has(record.name))
      fail(`duplicate classification: ${record.name}`);
    classified.add(record.name);
    const expectedClassification = classificationsByName.get(record.name);
    if (expectedClassification === undefined)
      fail(`test has no reviewed classification: ${record.name}`);
    if (record.classification !== expectedClassification)
      fail(
        `test classification disagrees with reviewed policy: ${record.name}`,
      );
    if (record.classification === "pure") {
      pure.push(record.name);
    } else if (record.classification === "authority")
      authority.push(record.name);
    else fail(`unknown classification for ${record.name}`);
  }
  for (const name of expected)
    if (!classified.has(name)) fail(`missing classification: ${name}`);
  const authorityOrder = processAuthorityFiles.filter((name) =>
    authority.includes(name),
  );
  if (authorityOrder.length !== authority.length)
    fail("authority classification is outside the closed authority set");
  return Object.freeze({
    authority: Object.freeze(authorityOrder),
    pure: Object.freeze(pure.sort()),
  });
}

export function createVitestInvocation(files, workerCeiling = 1) {
  if (!Array.isArray(files) || files.length === 0)
    fail("a Vitest child requires at least one test file");
  if (!Number.isSafeInteger(workerCeiling) || workerCeiling < 1)
    fail("a Vitest child requires a positive worker ceiling");
  const names = files.map((name) => {
    if (!classificationsByName.has(name))
      fail(`test has no reviewed classification: ${name}`);
    return name;
  });
  if (
    (workerCeiling === pureWorkerCeiling &&
      names.some((name) => classificationsByName.get(name) !== "pure")) ||
    (workerCeiling === 1 &&
      (names.length !== 1 ||
        classificationsByName.get(names[0]) !== "authority"))
  )
    fail("a Vitest child classification is invalid");
  return Object.freeze({
    arguments: Object.freeze([
      runnerPath,
      internalChildMarker,
      String(workerCeiling),
      ...names,
    ]),
    executable: process.execPath,
    files: Object.freeze(names),
    workerCeiling,
  });
}

function createDirectVitestArguments(files, workerCeiling) {
  return Object.freeze([
    vitestPath,
    "run",
    "--config",
    configPath,
    "--maxWorkers",
    String(workerCeiling),
    ...files.map((name) => resolve(testRoot, name)),
  ]);
}

function parseInternalChildArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_[0] !== internalChildMarker)
    fail("internal child marker is invalid");
  const workerCeiling = Number(arguments_[1]);
  const files = arguments_.slice(2);
  if (
    !Number.isSafeInteger(workerCeiling) ||
    ![1, pureWorkerCeiling].includes(workerCeiling) ||
    files.length === 0 ||
    new Set(files).size !== files.length
  )
    fail("internal child arguments are invalid");
  for (const name of files) {
    const classification = classificationsByName.get(name);
    if (
      classification === undefined ||
      (workerCeiling === pureWorkerCeiling && classification !== "pure") ||
      (workerCeiling === 1 &&
        (classification !== "authority" || files.length !== 1))
    )
      fail("internal child classification is invalid");
  }
  return Object.freeze({ files: Object.freeze(files), workerCeiling });
}

function childEnvironment() {
  const environment = {};
  for (const key of [
    "CI",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SHELL",
    "SYSTEMROOT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USERPROFILE",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function ensureInspectionBudget(hardDeadline) {
  if (hardDeadline - performance.now() <= 0)
    throw new Error("process inspection deadline reached");
}

function readLinuxProcess(pid, hardDeadline) {
  ensureInspectionBudget(hardDeadline);
  let value;
  try {
    value = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  ensureInspectionBudget(hardDeadline);
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("malformed process record");
  const fields = value.slice(commandEnd + 2).split(" ");
  const processGroup = Number(fields[2]);
  const startIdentity = fields[19];
  if (!Number.isSafeInteger(processGroup) || startIdentity === undefined)
    throw new Error("malformed process record");
  return { processGroup, startIdentity };
}

const darwinBirthProbe = String.raw`import ctypes,sys
class B(ctypes.Structure):
 _fields_=[("flags",ctypes.c_uint32),("status",ctypes.c_uint32),("xstatus",ctypes.c_uint32),("pid",ctypes.c_uint32),("ppid",ctypes.c_uint32),("uid",ctypes.c_uint32),("gid",ctypes.c_uint32),("ruid",ctypes.c_uint32),("rgid",ctypes.c_uint32),("svuid",ctypes.c_uint32),("svgid",ctypes.c_uint32),("rfu",ctypes.c_uint32),("comm",ctypes.c_char*16),("name",ctypes.c_char*32),("nfiles",ctypes.c_uint32),("pgid",ctypes.c_uint32),("pjobc",ctypes.c_uint32),("tdev",ctypes.c_uint32),("tpgid",ctypes.c_uint32),("nice",ctypes.c_int32),("sec",ctypes.c_uint64),("usec",ctypes.c_uint64)]
b=B();lib=ctypes.CDLL("/usr/lib/libproc.dylib");n=lib.proc_pidinfo(int(sys.argv[1]),3,0,ctypes.byref(b),ctypes.sizeof(b))
if n != ctypes.sizeof(b) or b.pid != int(sys.argv[1]): raise SystemExit(1)
print(f"{b.pid}:{b.pgid}:{b.sec}:{b.usec}")`;

function boundedProbeTimeout(hardDeadline) {
  ensureInspectionBudget(hardDeadline);
  const remaining = Math.floor(hardDeadline - performance.now());
  if (remaining <= 0) throw new Error("process inspection deadline reached");
  return Math.min(1_000, remaining);
}

function readDarwinBirth(pid, hardDeadline) {
  const output = execFileSync(
    realpathSync("/usr/bin/python3"),
    ["-c", darwinBirthProbe, String(pid)],
    {
      encoding: "utf8",
      env: {},
      maxBuffer: 256,
      shell: false,
      timeout: boundedProbeTimeout(hardDeadline),
    },
  );
  const match = /^(\d+):(\d+):(\d+):(\d+)\n$/.exec(output);
  ensureInspectionBudget(hardDeadline);
  if (match === null || Number(match[1]) !== pid)
    throw new Error("malformed process birth record");
  const record = Object.freeze({
    processGroup: Number(match[2]),
    startIdentity: `${match[3]}:${match[4]}`,
  });
  ensureInspectionBudget(hardDeadline);
  return record;
}

function kernelAuthorityExists(pid, hardDeadline) {
  ensureInspectionBudget(hardDeadline);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  } finally {
    ensureInspectionBudget(hardDeadline);
  }
  return true;
}

const defaultLifecycle = Object.freeze({
  capture(pid, platform, hardDeadline) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("invalid process identifier");
    if (platform === "linux") {
      const record = readLinuxProcess(pid, hardDeadline);
      if (record === undefined || record.processGroup !== pid)
        throw new Error("child process authority unavailable");
      return Object.freeze({ pid, startIdentity: record.startIdentity });
    }
    if (platform === "darwin") {
      const record = readDarwinBirth(pid, hardDeadline);
      if (record === undefined || record.processGroup !== pid)
        throw new Error("child process authority unavailable");
      return Object.freeze({ pid, startIdentity: record.startIdentity });
    }
    throw new Error("unsupported process authority platform");
  },
  clearTimer(timer) {
    clearTimeout(timer);
  },
  inspect(authority, platform, hardDeadline) {
    const groupAbsent = !kernelAuthorityExists(-authority.pid, hardDeadline);
    if (platform === "linux") {
      const leader = readLinuxProcess(authority.pid, hardDeadline);
      ensureInspectionBudget(hardDeadline);
      return Object.freeze({
        groupAbsent,
        leader:
          leader === undefined
            ? "absent"
            : leader.processGroup === authority.pid &&
                leader.startIdentity === authority.startIdentity
              ? "same"
              : "mismatch",
      });
    }
    if (platform === "darwin") {
      const leaderExists = kernelAuthorityExists(authority.pid, hardDeadline);
      const birth = leaderExists
        ? readDarwinBirth(authority.pid, hardDeadline)
        : undefined;
      ensureInspectionBudget(hardDeadline);
      return Object.freeze({
        groupAbsent,
        leader:
          birth === undefined
            ? "absent"
            : birth.processGroup === authority.pid &&
                birth.startIdentity === authority.startIdentity
              ? "same"
              : "mismatch",
      });
    }
    throw new Error("unsupported process authority platform");
  },
  now: () => performance.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  signal(authority, signal) {
    try {
      process.kill(-authority.pid, signal);
      return "sent";
    } catch (error) {
      if (error?.code === "ESRCH") return "absent";
      throw error;
    }
  },
});

function lifecycleFailure(reason) {
  return new Error(`workspace-policy child containment failed: ${reason}`);
}

class ChildLifecycleController {
  constructor(resolveExecution, rejectExecution, signalHost, lifecycle) {
    this.resolveExecution = resolveExecution;
    this.rejectExecution = rejectExecution;
    this.signalHost = signalHost;
    this.lifecycle = lifecycle;
    this.hardDeadline = lifecycle.now() + childLifecycleBounds.hardMilliseconds;
    this.handlers = new Map();
  }

  fail(reason) {
    this.failure ??= lifecycleFailure(reason);
  }

  failUncertain(reason) {
    this.terminalUncertainty = true;
    this.fail(reason);
  }

  clearTimer(timer) {
    if (timer !== undefined) this.lifecycle.clearTimer(timer);
  }

  removeHandlers() {
    for (const [signal, handler] of this.handlers)
      this.signalHost.off(signal, handler);
    this.handlers.clear();
  }

  finish() {
    if (this.settled || this.closeOutcome === undefined || !this.contained)
      return;
    this.settled = true;
    for (const timer of [
      this.executionTimer,
      this.hardTimer,
      this.graceTimer,
      this.pollTimer,
    ])
      this.clearTimer(timer);
    this.removeHandlers();
    if (this.terminalUncertainty) this.rejectExecution(this.failure);
    else if (this.pendingSignal !== undefined)
      this.resolveExecution(
        Object.freeze({ code: 1, signal: this.pendingSignal }),
      );
    else if (this.failure !== undefined) this.rejectExecution(this.failure);
    else this.resolveExecution(this.directOutcome ?? this.closeOutcome);
  }

  inspect(deadline = this.hardDeadline) {
    if (this.authority === undefined) {
      this.failUncertain("process authority unavailable");
      return undefined;
    }
    try {
      const observation = this.lifecycle.inspect(
        this.authority,
        this.signalHost.platform,
        deadline,
      );
      if (this.lifecycle.now() > deadline)
        throw new Error("process-group inspection exceeded its authority");
      if (
        observation === null ||
        typeof observation !== "object" ||
        typeof observation.groupAbsent !== "boolean" ||
        !["same", "absent", "mismatch"].includes(observation.leader)
      )
        throw new Error("malformed observation");
      if (!observation.groupAbsent && observation.leader === "mismatch")
        this.failUncertain("process identity mismatch");
      if (
        observation.leader === "absent" &&
        !observation.groupAbsent &&
        !this.groupKillSent
      )
        this.failUncertain("wrapper identity lost before group retirement");
      if (observation.leader !== "same" || observation.groupAbsent)
        this.groupAuthorityRevoked = true;
      return observation;
    } catch {
      this.groupAuthorityRevoked = true;
      this.failUncertain("process-group inspection uncertainty");
      return undefined;
    }
  }

  signalGroup(signal, deadline = this.hardDeadline) {
    const observation = this.inspect(deadline);
    if (
      observation === undefined ||
      this.groupAuthorityRevoked ||
      observation.leader !== "same"
    ) {
      if (observation?.groupAbsent === true) {
        this.contained = true;
        this.finish();
        return "absent";
      }
      this.failUncertain("process identity unavailable before signal");
      return "uncertain";
    }
    try {
      const result = this.lifecycle.signal(this.authority, signal);
      if (result === "absent") {
        this.groupAuthorityRevoked = true;
        this.contained = true;
        this.finish();
        return "absent";
      } else if (result !== "sent") throw new Error("malformed signal result");
      if (signal === "SIGKILL") this.groupKillSent = true;
      return "sent";
    } catch {
      this.groupAuthorityRevoked = true;
      this.failUncertain("process-group signal uncertainty");
      return "uncertain";
    }
  }

  checkContainment() {
    const observation = this.inspect();
    if (observation?.groupAbsent === true) this.contained = true;
    this.finish();
    return this.contained;
  }

  schedulePoll() {
    if (
      this.pollTimer !== undefined ||
      this.settled ||
      this.contained ||
      this.lifecycle.now() >= this.hardDeadline
    )
      return;
    this.pollTimer = this.lifecycle.setTimer(
      this.onPoll,
      Math.min(
        childLifecycleBounds.pollMilliseconds,
        Math.max(0, this.hardDeadline - this.lifecycle.now()),
      ),
    );
  }

  pollForContainment() {
    if (this.settled || this.contained) return;
    this.checkContainment();
    this.schedulePoll();
  }

  onPoll = () => {
    this.pollTimer = undefined;
    this.pollForContainment();
  };

  forceKill = () => {
    if (this.settled || this.contained) return;
    this.signalGroup("SIGKILL", this.escalationDeadline);
    this.pollForContainment();
  };

  beginStop(signal) {
    if (this.settled || this.stopping) return;
    this.stopping = true;
    const result = this.signalGroup(signal);
    if (result !== "sent" || this.settled || this.contained) return;
    this.escalationDeadline = Math.min(
      this.hardDeadline,
      this.lifecycle.now() + childLifecycleBounds.signalGraceMilliseconds,
    );
    this.graceTimer = this.lifecycle.setTimer(this.forceKill, 0);
  }

  onMessage(message) {
    const keys =
      message !== null && typeof message === "object"
        ? Object.keys(message).sort()
        : [];
    if (
      this.directOutcome !== undefined ||
      message === null ||
      typeof message !== "object" ||
      message.kind !== "direct-terminal" ||
      !Number.isSafeInteger(message.code) ||
      message.code < 0 ||
      message.code > 255 ||
      ![undefined, ...terminalSignals].includes(message.signal) ||
      (message.signal === undefined
        ? keys.join(",") !== "code,kind"
        : keys.join(",") !== "code,kind,signal" || message.code !== 1)
    ) {
      this.failUncertain("wrapper message uncertainty");
      this.beginStop("SIGTERM");
      return;
    }
    this.directOutcome = Object.freeze({
      code: message.code,
      signal: message.signal,
    });
    this.beginStop("SIGTERM");
  }

  hardStop = () => {
    this.clearTimer(this.graceTimer);
    this.clearTimer(this.pollTimer);
    this.settled = true;
    this.terminalUncertainty = true;
    this.removeHandlers();
    try {
      if (this.child?.connected === true) this.child.disconnect();
      this.child?.unref();
    } catch {
      // The terminal is deliberately content-free for every revocation failure.
    }
    this.rejectExecution(lifecycleFailure("terminal containment uncertainty"));
  };

  installHandlers() {
    for (const signal of forwardedSignals) {
      const handler = () => {
        this.pendingSignal ??= signal;
        if (this.authority !== undefined) this.beginStop(this.pendingSignal);
      };
      this.handlers.set(signal, handler);
      this.signalHost.on(signal, handler);
    }
  }

  start(invocation, spawnChild) {
    this.installHandlers();
    try {
      this.child = spawnChild(invocation.executable, invocation.arguments, {
        cwd: workspaceRoot,
        detached: true,
        env: childEnvironment(),
        shell: false,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
    } catch {
      this.removeHandlers();
      this.rejectExecution(lifecycleFailure("child spawn uncertainty"));
      return;
    }
    try {
      this.authority = this.lifecycle.capture(
        this.child.pid,
        this.signalHost.platform,
        this.hardDeadline,
      );
    } catch {
      this.failUncertain("process authority unavailable");
    }
    this.executionTimer = this.lifecycle.setTimer(
      () => {
        this.fail("execution deadline exceeded");
        this.beginStop("SIGTERM");
      },
      Math.max(
        0,
        this.hardDeadline -
          childLifecycleBounds.teardownMilliseconds -
          this.lifecycle.now(),
      ),
    );
    this.hardTimer = this.lifecycle.setTimer(
      this.hardStop,
      Math.max(0, this.hardDeadline - this.lifecycle.now()),
    );
    if (this.pendingSignal !== undefined) this.beginStop(this.pendingSignal);
    this.child.on("message", (message) => this.onMessage(message));
    this.child.once("error", () => this.fail("child execution uncertainty"));
    this.child.once("close", (code, signal) => this.onClose(code, signal));
  }

  onClose(code, signal) {
    this.closeOutcome = Object.freeze({
      code: code ?? 1,
      signal: signal ?? undefined,
    });
    if (
      !this.stopping &&
      (this.directOutcome === undefined ||
        this.directOutcome.code !== this.closeOutcome.code ||
        this.directOutcome.signal !== this.closeOutcome.signal)
    )
      this.failUncertain("wrapper terminal uncertainty");
    if (this.contained) return this.finish();
    const observation = this.inspect();
    if (observation?.groupAbsent === true) this.contained = true;
    else {
      this.failUncertain("child leader closed before process-group join");
      if (observation?.leader === "same") this.forceKill();
      else this.pollForContainment();
    }
    this.finish();
  }
}

export function executeVitestInvocation(
  invocation,
  spawnChild = spawn,
  signalHost = process,
  lifecycle = defaultLifecycle,
) {
  return new Promise((resolveExecution, rejectExecution) => {
    new ChildLifecycleController(
      resolveExecution,
      rejectExecution,
      signalHost,
      lifecycle,
    ).start(invocation, spawnChild);
  });
}

export function publishTerminalOutcome(outcome, processHost = process) {
  if (outcome.signal !== undefined) {
    processHost.kill(processHost.pid, outcome.signal);
    return;
  }
  processHost.exitCode = outcome.code;
}

export function runInternalVitestChild(
  arguments_,
  spawnChild = spawn,
  processHost = process,
) {
  const specification = parseInternalChildArguments(arguments_);
  if (typeof processHost.send !== "function" || processHost.connected !== true)
    fail("internal child requires the authenticated parent channel");
  return new Promise(() => {
    let child;
    let directOutcome;
    let executionFailed = false;
    const signalHandlers = new Map();
    const onDisconnect = () => {
      try {
        processHost.kill(-processHost.pid, "SIGKILL");
      } catch {
        processHost.exitCode = 1;
      }
    };
    const publishDirectOutcome = () => {
      try {
        processHost.send(
          Object.freeze({
            code: directOutcome.code,
            kind: "direct-terminal",
            ...(directOutcome.signal === undefined
              ? {}
              : { signal: directOutcome.signal }),
          }),
        );
      } catch {
        onDisconnect();
      }
    };
    for (const signal of forwardedSignals) {
      const handler = () => {};
      signalHandlers.set(signal, handler);
      processHost.on(signal, handler);
    }
    processHost.on("disconnect", onDisconnect);
    try {
      child = spawnChild(
        process.execPath,
        createDirectVitestArguments(
          specification.files,
          specification.workerCeiling,
        ),
        {
          cwd: workspaceRoot,
          detached: false,
          env: childEnvironment(),
          shell: false,
          stdio: "inherit",
        },
      );
    } catch {
      directOutcome = Object.freeze({ code: 1, signal: undefined });
      publishDirectOutcome();
      return;
    }
    child.once("error", () => {
      executionFailed = true;
    });
    child.once("close", (code, signal) => {
      directOutcome = Object.freeze({
        code: executionFailed ? 1 : (code ?? 1),
        signal: signal ?? undefined,
      });
      publishDirectOutcome();
    });
  });
}

export async function runWorkspacePolicyPlan(
  plan,
  execute = executeVitestInvocation,
) {
  const batches = [
    ...(plan.pure.length > 0
      ? [{ files: plan.pure, workers: pureWorkerCeiling }]
      : []),
    ...plan.authority.map((name) => ({ files: [name], workers: 1 })),
  ];
  for (const batch of batches) {
    const outcome = await execute(
      createVitestInvocation(batch.files, batch.workers),
    );
    if (outcome.code !== 0 || outcome.signal !== undefined) return outcome;
  }
  return Object.freeze({ code: 0, signal: undefined });
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (arguments_.length !== 0) fail("caller arguments are not accepted");
  const inventory = discoverWorkspacePolicyInventory();
  validateWorkspacePolicyInventory(inventory);
  const plan = createWorkspacePolicyPlan(
    inventory,
    classifyWorkspacePolicyInventory(inventory),
  );
  return runWorkspacePolicyPlan(plan);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const arguments_ = process.argv.slice(2);
    const outcome =
      arguments_[0] === internalChildMarker
        ? await runInternalVitestChild(arguments_)
        : await main(arguments_);
    publishTerminalOutcome(outcome);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
