import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
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
const pureWorkerCeiling = 2;
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
  const paths = files.map((name) => {
    if (!classificationsByName.has(name))
      fail(`test has no reviewed classification: ${name}`);
    return resolve(testRoot, name);
  });
  return Object.freeze({
    arguments: Object.freeze([
      vitestPath,
      "run",
      "--config",
      configPath,
      "--maxWorkers",
      String(workerCeiling),
      ...paths,
    ]),
    executable: process.execPath,
  });
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

function readLinuxProcess(pid) {
  let value;
  try {
    value = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
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

function readDarwinBirth(pid) {
  const output = execFileSync(
    realpathSync("/usr/bin/python3"),
    ["-c", darwinBirthProbe, String(pid)],
    {
      encoding: "utf8",
      env: {},
      maxBuffer: 256,
      shell: false,
      timeout: 1_000,
    },
  );
  const match = /^(\d+):(\d+):(\d+):(\d+)\n$/.exec(output);
  if (match === null || Number(match[1]) !== pid)
    throw new Error("malformed process birth record");
  return Object.freeze({
    processGroup: Number(match[2]),
    startIdentity: `${match[3]}:${match[4]}`,
  });
}

function readDarwinProcesses() {
  const output = execFileSync(realpathSync("/bin/ps"), ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  const records = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    records.push({
      pid: Number(match[1]),
      processGroup: Number(match[2]),
    });
  }
  return records;
}

const defaultLifecycle = Object.freeze({
  capture(pid, platform) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("invalid process identifier");
    if (platform === "linux") {
      const record = readLinuxProcess(pid);
      if (record === undefined || record.processGroup !== pid)
        throw new Error("child process authority unavailable");
      return Object.freeze({ pid, startIdentity: record.startIdentity });
    }
    if (platform === "darwin") {
      const record = readDarwinBirth(pid);
      if (record === undefined || record.processGroup !== pid)
        throw new Error("child process authority unavailable");
      return Object.freeze({ pid, startIdentity: record.startIdentity });
    }
    throw new Error("unsupported process authority platform");
  },
  clearTimer(timer) {
    clearTimeout(timer);
  },
  inspect(authority, platform) {
    if (platform === "linux") {
      const leader = readLinuxProcess(authority.pid);
      let groupAbsent = true;
      for (const entry of readdirSync("/proc", { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const record = readLinuxProcess(Number(entry.name));
        if (record?.processGroup === authority.pid) groupAbsent = false;
      }
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
      const records = readDarwinProcesses();
      const leader = records.find((item) => item.pid === authority.pid);
      const birth =
        leader === undefined ? undefined : readDarwinBirth(authority.pid);
      return Object.freeze({
        groupAbsent: !records.some(
          (item) => item.processGroup === authority.pid,
        ),
        leader:
          leader === undefined
            ? "absent"
            : leader.processGroup === authority.pid &&
                birth.processGroup === authority.pid &&
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
    process.kill(-authority.pid, signal);
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
    if (this.pendingSignal !== undefined)
      this.resolveExecution(
        Object.freeze({ code: 1, signal: this.pendingSignal }),
      );
    else if (this.failure !== undefined) this.rejectExecution(this.failure);
    else this.resolveExecution(this.closeOutcome);
  }

  inspect() {
    if (this.authority === undefined) {
      this.fail("process authority unavailable");
      return undefined;
    }
    try {
      const observation = this.lifecycle.inspect(
        this.authority,
        this.signalHost.platform,
      );
      if (
        observation === null ||
        typeof observation !== "object" ||
        typeof observation.groupAbsent !== "boolean" ||
        !["same", "absent", "mismatch"].includes(observation.leader)
      )
        throw new Error("malformed observation");
      if (observation.leader === "mismatch")
        this.fail("process identity mismatch");
      if (observation.leader === "mismatch" || observation.groupAbsent)
        this.groupAuthorityRevoked = true;
      return observation;
    } catch {
      this.groupAuthorityRevoked = true;
      this.fail("process-group inspection uncertainty");
      return undefined;
    }
  }

  signalGroup(signal) {
    const observation = this.inspect();
    if (
      observation === undefined ||
      this.groupAuthorityRevoked ||
      observation.groupAbsent ||
      (observation.leader !== "same" &&
        !(observation.leader === "absent" && this.groupSignalAuthorized))
    ) {
      this.fail("process identity unavailable before signal");
      return;
    }
    try {
      this.lifecycle.signal(this.authority, signal);
      this.groupSignalAuthorized = true;
    } catch {
      this.groupAuthorityRevoked = true;
      this.fail("process-group signal uncertainty");
    }
  }

  checkContainment() {
    if (this.inspect()?.groupAbsent === true) this.contained = true;
    this.finish();
    return this.contained;
  }

  pollForContainment = () => {
    if (this.settled || this.contained) return;
    this.checkContainment();
    if (
      !this.settled &&
      !this.contained &&
      this.lifecycle.now() < this.hardDeadline
    )
      this.pollTimer = this.lifecycle.setTimer(
        this.pollForContainment,
        Math.min(
          childLifecycleBounds.pollMilliseconds,
          Math.max(0, this.hardDeadline - this.lifecycle.now()),
        ),
      );
  };

  forceKill = () => {
    if (this.settled || this.contained) return;
    this.signalGroup("SIGKILL");
    this.pollForContainment();
  };

  beginStop(signal) {
    if (this.settled || this.stopping) return;
    this.stopping = true;
    this.signalGroup(signal);
    this.pollForContainment();
    this.graceTimer = this.lifecycle.setTimer(
      this.forceKill,
      Math.min(
        childLifecycleBounds.signalGraceMilliseconds,
        Math.max(0, this.hardDeadline - this.lifecycle.now()),
      ),
    );
  }

  hardStop = () => {
    this.clearTimer(this.graceTimer);
    this.clearTimer(this.pollTimer);
    this.checkContainment();
    if (this.settled) return;
    this.settled = true;
    this.removeHandlers();
    this.rejectExecution(
      this.failure ?? lifecycleFailure("hard deadline reached before join"),
    );
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
        stdio: "inherit",
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
      );
    } catch {
      this.fail("process authority unavailable");
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
    this.child.once("error", () => this.fail("child execution uncertainty"));
    this.child.once("close", (code, signal) => this.onClose(code, signal));
  }

  onClose(code, signal) {
    this.closeOutcome = Object.freeze({
      code: code ?? 1,
      signal: signal ?? undefined,
    });
    const observation = this.inspect();
    if (observation?.groupAbsent === true) this.contained = true;
    else {
      this.fail("child leader closed before process-group join");
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
    const outcome = await main();
    publishTerminalOutcome(outcome);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
