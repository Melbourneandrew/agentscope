import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  cpSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  archiveLimits,
  verifyArchiveCompilerHostileFixtures,
  verifyMaterializerParentSwapFixture,
} from "./tooling/archive-compiler.mjs";
import {
  assertToolchainImageAuthority,
  ensurePlatformImage,
  nativeCandidatePlatform,
  nativeCandidateToolchainImageAuthority,
} from "./tooling/image-platform-authority.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const records = join(root, "files/records");
const image = nativeCandidateToolchainImageAuthority.sourceIndex;
const imageManifest = nativeCandidateToolchainImageAuthority.selectedManifest;
const imageId = nativeCandidateToolchainImageAuthority.configDigest;
const executionImage =
  "node@sha256:0d130e2ee18e88e1561375276daced6bff032539200173f2daf48c2e33f38ff5";
const executionImageId =
  "sha256:955b467cb9a2a941cb181f7cf1d2405c1dd24b4566a3598b7eae7ecca1a769d1";
const expectedBinary = Object.freeze({
  bytes: 2_222_856,
  sha256: "b07b4ab1f139c8d2b2b6701ceaf3b4f5905b45660f122fab3e3c1fcaa47641c9",
});
const materials = Object.freeze([
  Object.freeze({
    name: "better-sqlite3",
    version: "13.0.3",
    registry: "https://registry.npmjs.org",
    sourceRepository: "https://github.com/WiseLibs/better-sqlite3.git",
    sourceTag: "v13.0.3",
    sourceTagObject: "0747dc94fb468715974716c6c54106ad6469d31b",
    sourceRevision: "dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb",
    license: "MIT",
    url: "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz",
    file: "better-sqlite3.tgz",
    bytes: 11_402_131,
    sha256: "77e0513dc1a469fb3bceec4c7fb5ad3f403109787eda05be047ec17fd56868cb",
    sha512:
      "RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==",
  }),
  Object.freeze({
    name: "node-addon-api",
    version: "8.5.0",
    registry: "https://registry.npmjs.org",
    sourceRepository: "https://github.com/nodejs/node-addon-api.git",
    sourceTag: "v8.5.0",
    sourceTagObject: "6babc960154752f686a7dca8e712991a976a754b",
    sourceRevision: "6babc960154752f686a7dca8e712991a976a754b",
    license: "MIT",
    url: "https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.5.0.tgz",
    file: "node-addon-api.tgz",
    bytes: 60_410,
    sha256: "d12f07c8162283b6213551855f1da8dac162331374629830b5e640f130f07910",
    sha512:
      "/bRZty2mXUIFY/xU5HLvveNHlswNJej+RnxBjOMkidWfwZzgTbPG1E3K5TOxRLOR+5hX7bSofy8yf1hZevMS8A==",
  }),
]);

const sha = (algorithm, bytes, encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const snapshot = (file, maximumBytes) => {
  const descriptor = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const before = fstatSync(descriptor);
    assert(before.isFile() && before.size > 0 && before.size <= maximumBytes);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      assert(count > 0);
      offset += count;
    }
    assert.equal(readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, null), 0);
    const after = fstatSync(descriptor);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};
const command = (program, arguments_, options = {}) => {
  const result = spawnSync(program, arguments_, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180_000,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `native candidate command failed: ${program} ${result.stderr ?? ""}`,
    );
  return result.stdout.trim();
};
const ensureImage = (reference, expectedId) =>
  ensurePlatformImage({
    reference,
    expectedId,
    invoke: (arguments_) =>
      spawnSync("docker", arguments_, {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 180_000,
      }),
  });
const verifySourceRevision = (material, temporaryRoot) => {
  const tagReference = `refs/tags/${material.sourceTag}`;
  const expected = [
    `${material.sourceTagObject}\t${tagReference}`,
    ...(material.sourceTagObject === material.sourceRevision
      ? []
      : [`${material.sourceRevision}\t${tagReference}^{}`]),
  ].join("\n");
  assert.equal(
    command(
      "/usr/bin/git",
      [
        "-c",
        "credential.helper=",
        "ls-remote",
        material.sourceRepository,
        tagReference,
        `${tagReference}^{}`,
      ],
      {
        env: {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          HOME: temporaryRoot,
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
        },
      },
    ),
    expected,
  );
};
const CONTAINER_SETUP_BUDGET_MILLISECONDS = 60_000;
const DEFAULT_CONTAINER_TEARDOWN_RESERVE_MILLISECONDS = 30_000;
const CONTAINER_ABSENCE_PROOF_RESERVE_MILLISECONDS = 5_000;
const assertNoContainer = (
  name,
  timeout = DEFAULT_CONTAINER_TEARDOWN_RESERVE_MILLISECONDS,
) => {
  const result = spawnSync(
    "docker",
    ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
    { encoding: "utf8", maxBuffer: 64 * 1024, timeout },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
};
const boundedWaitState = new Int32Array(new SharedArrayBuffer(4));
const boundedTimeoutResult = () =>
  Object.freeze({
    error: Object.assign(new Error("bounded container timeout"), {
      code: "ETIMEDOUT",
    }),
    status: null,
    stdout: "",
    stderr: "",
  });
const normalizeCommandResult = (result) =>
  result.error
    ? Object.freeze({
        error: result.error,
        status: null,
        stdout: "",
        stderr: "",
      })
    : result;
const remainingMilliseconds = (deadline, now = () => performance.now()) =>
  Math.max(0, Math.floor(deadline - now()));
const performBoundedContainer = (context) => {
  const {
    name,
    arguments_,
    workTimeout,
    teardownReserve,
    setupDeadline,
    absoluteDeadline,
    dockerCommand,
    now,
    cleanupState,
  } = context;
  const createArguments =
    arguments_[0] === "--rm" ? arguments_.slice(1) : arguments_;
  assert.equal(createArguments.includes("--rm"), false);
  const createTimeout = remainingMilliseconds(setupDeadline, now);
  if (createTimeout < 1) return boundedTimeoutResult();
  cleanupState.createAttempted = true;
  const create = normalizeCommandResult(
    dockerCommand("docker", ["create", "--name", name, ...createArguments], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: createTimeout,
    }),
  );
  cleanupState.cleanupRequired =
    create.status === 0 || !Number.isInteger(create.status);
  if (create.error || create.status !== 0) return create;
  if (now() >= setupDeadline) return boundedTimeoutResult();
  const startTimeout = remainingMilliseconds(setupDeadline, now);
  if (startTimeout < 1) return boundedTimeoutResult();
  const start = normalizeCommandResult(
    dockerCommand("docker", ["start", name], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: startTimeout,
    }),
  );
  if (start.error || start.status !== 0) return start;
  if (now() >= setupDeadline) return boundedTimeoutResult();
  const workDeadline = Math.min(
    now() + workTimeout,
    absoluteDeadline - teardownReserve,
  );
  for (;;) {
    const inspectTimeout = remainingMilliseconds(workDeadline, now);
    if (inspectTimeout < 1) return boundedTimeoutResult();
    const inspect = normalizeCommandResult(
      dockerCommand(
        "docker",
        ["inspect", "--format", "{{json .State}}", name],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          timeout: inspectTimeout,
        },
      ),
    );
    if (inspect.error || inspect.status !== 0) return inspect;
    if (now() >= workDeadline) return boundedTimeoutResult();
    const state = JSON.parse(inspect.stdout);
    if (state.Running === false) {
      const logsTimeout = remainingMilliseconds(workDeadline, now);
      if (logsTimeout < 1) return boundedTimeoutResult();
      const logs = normalizeCommandResult(
        dockerCommand("docker", ["logs", name], {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: logsTimeout,
        }),
      );
      if (logs.error || logs.status !== 0) return logs;
      if (now() >= workDeadline) return boundedTimeoutResult();
      return Object.freeze({
        error: undefined,
        status: state.ExitCode,
        stdout: logs.stdout ?? "",
        stderr: logs.stderr ?? "",
      });
    }
    if (now() >= workDeadline) return boundedTimeoutResult();
    Atomics.wait(boundedWaitState, 0, 0, 50);
  }
};
const cleanupBoundedContainer = (context) => {
  const {
    name,
    absoluteDeadline,
    teardownReserve,
    cleanupState,
    dockerCommand,
    proveAbsent,
    now,
  } = context;
  const failures = [];
  const absenceProofReserve = Math.min(
    teardownReserve,
    CONTAINER_ABSENCE_PROOF_RESERVE_MILLISECONDS,
  );
  const cleanupDeadline = absoluteDeadline - absenceProofReserve;
  if (cleanupState.cleanupRequired) {
    const cleanupTimeout = remainingMilliseconds(cleanupDeadline, now);
    if (cleanupTimeout < 1) {
      failures.push(new Error("container cleanup reserve exhausted"));
    } else {
      const cleanup = dockerCommand("docker", ["rm", "-f", name], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: cleanupTimeout,
      });
      if (cleanup.error || cleanup.status !== 0)
        failures.push(
          cleanup.error ?? new Error("container cleanup command failed"),
        );
    }
  }
  if (!cleanupState.createAttempted) return failures;
  const verificationTimeout = remainingMilliseconds(absoluteDeadline, now);
  if (verificationTimeout < 1) {
    failures.push(
      new Error("container absence verification reserve exhausted"),
    );
    return failures;
  }
  try {
    proveAbsent(name, verificationTimeout);
  } catch (error) {
    failures.push(error);
  }
  return failures;
};
const runBoundedContainer = (
  name,
  arguments_,
  workTimeout,
  teardownReserve = DEFAULT_CONTAINER_TEARDOWN_RESERVE_MILLISECONDS,
  runtime = {},
) => {
  const now = runtime.now ?? (() => performance.now());
  const startedAt = now();
  const setupDeadline = startedAt + CONTAINER_SETUP_BUDGET_MILLISECONDS;
  const context = {
    name,
    arguments_,
    workTimeout,
    teardownReserve,
    setupDeadline,
    absoluteDeadline: setupDeadline + workTimeout + teardownReserve,
    dockerCommand: runtime.dockerCommand ?? spawnSync,
    proveAbsent: runtime.proveAbsent ?? assertNoContainer,
    now,
    cleanupState: { createAttempted: false, cleanupRequired: false },
  };
  let result;
  let operationError;
  try {
    result = performBoundedContainer(context);
  } catch (error) {
    operationError = error;
  }
  const cleanupFailures = cleanupBoundedContainer(context);
  if (cleanupFailures.length > 0)
    throw new AggregateError(
      cleanupFailures,
      "bounded container cleanup was not proved",
    );
  if (operationError) throw operationError;
  return result;
};
const verifyCreateUncertaintyCleanup = () => {
  const calls = [];
  let absenceChecks = 0;
  const timeout = Object.assign(new Error("synthetic create timeout"), {
    code: "ETIMEDOUT",
  });
  const result = runBoundedContainer(
    "synthetic-create-uncertainty",
    ["image"],
    1_000,
    1_000,
    {
      dockerCommand: (_program, arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === "create")
          return { error: timeout, status: null, stdout: "", stderr: "" };
        if (arguments_[0] === "rm")
          return { error: undefined, status: 0, stdout: "", stderr: "" };
        throw new Error("unexpected synthetic Docker command");
      },
      proveAbsent: () => {
        absenceChecks += 1;
      },
    },
  );
  assert.equal(result.error, timeout);
  assert.equal(result.status, null);
  assert.deepEqual(
    calls.map((arguments_) => arguments_.slice(0, 3)),
    [
      ["create", "--name", "synthetic-create-uncertainty"],
      ["rm", "-f", "synthetic-create-uncertainty"],
    ],
  );
  assert.equal(absenceChecks, 1);
  let failedAbsenceChecks = 0;
  assert.throws(
    () =>
      runBoundedContainer(
        "synthetic-create-cleanup-failure",
        ["image"],
        1_000,
        1_000,
        {
          dockerCommand: (_program, arguments_) => {
            if (arguments_[0] === "create")
              return { error: timeout, status: null, stdout: "", stderr: "" };
            return {
              error: new Error("synthetic cleanup failure"),
              status: null,
              stdout: "",
              stderr: "",
            };
          },
          proveAbsent: () => {
            failedAbsenceChecks += 1;
            throw new Error("synthetic container still present");
          },
        },
      ),
    /bounded container cleanup was not proved/u,
  );
  assert.equal(failedAbsenceChecks, 1);
  let clock = 0;
  let timedOutAbsenceChecks = 0;
  let observedProofTimeout = 0;
  assert.throws(
    () =>
      runBoundedContainer(
        "synthetic-create-cleanup-timeout",
        ["image"],
        1_000,
        1_000,
        {
          now: () => clock,
          dockerCommand: (_program, arguments_, options) => {
            if (arguments_[0] === "create")
              return { error: timeout, status: null, stdout: "", stderr: "" };
            assert.equal(arguments_[0], "rm");
            clock += options.timeout;
            return {
              error: timeout,
              status: null,
              stdout: "",
              stderr: "",
            };
          },
          proveAbsent: (_name, proofTimeout) => {
            timedOutAbsenceChecks += 1;
            observedProofTimeout = proofTimeout;
          },
        },
      ),
    /bounded container cleanup was not proved/u,
  );
  assert.equal(timedOutAbsenceChecks, 1);
  assert.equal(observedProofTimeout, 1_000);
};
const verifyObservationTimeoutArbitration = () => {
  const timeout = Object.assign(new Error("synthetic observation timeout"), {
    code: "ETIMEDOUT",
  });
  const calls = [];
  const result = runBoundedContainer(
    "synthetic-observation-timeout-exit-race",
    ["image"],
    1_000,
    1_000,
    {
      dockerCommand: (_program, arguments_) => {
        calls.push(arguments_);
        switch (arguments_[0]) {
          case "create":
          case "start":
          case "rm":
            return { error: undefined, status: 0, stdout: "", stderr: "" };
          case "inspect":
            return {
              error: timeout,
              status: 0,
              stdout: "synthetic partial observation",
              stderr: "synthetic partial diagnostic",
            };
          default:
            throw new Error("unexpected synthetic Docker command");
        }
      },
      proveAbsent: () => undefined,
    },
  );
  assert.equal(result.error, timeout);
  assert.equal(result.status, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(
    calls.map((arguments_) => arguments_[0]),
    ["create", "start", "inspect", "rm"],
  );

  let clock = 0;
  const lateResult = runBoundedContainer(
    "synthetic-observation-after-deadline",
    ["image"],
    1_000,
    1_000,
    {
      now: () => clock,
      dockerCommand: (_program, arguments_) => {
        if (arguments_[0] === "inspect") {
          clock = 1_000;
          return {
            error: undefined,
            status: 0,
            stdout: '{"Running":false,"ExitCode":0}',
            stderr: "",
          };
        }
        return { error: undefined, status: 0, stdout: "", stderr: "" };
      },
      proveAbsent: () => undefined,
    },
  );
  assert.equal(lateResult.error?.code, "ETIMEDOUT");
  assert.equal(lateResult.status, null);
};
const runContainer = (
  name,
  arguments_,
  workTimeout = 180_000,
  teardownReserve = DEFAULT_CONTAINER_TEARDOWN_RESERVE_MILLISECONDS,
) => {
  const result = runBoundedContainer(
    name,
    arguments_,
    workTimeout,
    teardownReserve,
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `native candidate container failed: ${result.stderr ?? ""}`,
    );
  return result.stdout.trim();
};
const runContainerFailure = (
  name,
  arguments_,
  workTimeout = 60_000,
  teardownReserve = DEFAULT_CONTAINER_TEARDOWN_RESERVE_MILLISECONDS,
) => {
  const result = runBoundedContainer(
    name,
    arguments_,
    workTimeout,
    teardownReserve,
  );
  if (result.error)
    throw new Error(
      `native candidate failure oracle unavailable: ${typeof result.error.code === "string" ? result.error.code : "unknown"}`,
    );
  assert(Number.isInteger(result.status));
  assert.notEqual(result.status, 0);
  return Object.freeze({
    status: result.status,
    rejected: true,
    outputDiscarded: true,
  });
};
const runContainerOutputOverflow = (
  name,
  arguments_,
  workTimeout = 60_000,
  teardownReserve = DEFAULT_CONTAINER_TEARDOWN_RESERVE_MILLISECONDS,
) => {
  const result = runBoundedContainer(
    name,
    arguments_,
    workTimeout,
    teardownReserve,
  );
  assert.equal(result.error?.code, "ENOBUFS");
  assert.equal(result.status, null);
  return Object.freeze({
    status: null,
    rejected: true,
    outputDiscarded: true,
  });
};
const compileExecSupervisor = (temporaryRoot) => {
  const outputs = ["exec-supervisor-a", "exec-supervisor-b"].map(
    (directory) => {
      const output = join(temporaryRoot, directory);
      mkdirSync(output, { mode: 0o700 });
      const name = `agentscope-native-supervisor-build-${randomUUID()}`;
      const result = runContainer(name, [
        "--rm",
        "--platform",
        nativeCandidatePlatform.docker,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--tmpfs",
        "/tmp:rw,nosuid,size=16m",
        "-v",
        `${join(root, "tooling/exec-supervisor.c")}:/source.c:ro`,
        "-v",
        `${output}:/output:rw`,
        "--entrypoint",
        "/usr/bin/cc",
        imageManifest,
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-o",
        "/output/exec-supervisor",
        "/source.c",
      ]);
      assert.equal(result, "");
      return join(output, "exec-supervisor");
    },
  );
  const first = snapshot(outputs[0], 128 * 1024);
  assert.deepEqual(snapshot(outputs[1], 128 * 1024), first);
  const selfTest = runSupervisedBuildContainer(
    `agentscope-native-supervisor-self-test-${randomUUID()}`,
    [
      "--rm",
      "--platform",
      nativeCandidatePlatform.docker,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${outputs[0]}:/authority/exec-supervisor:ro`,
      "--entrypoint",
      "/authority/exec-supervisor",
      imageManifest,
      "--verify-clone-exec-observed",
    ],
    30_000,
  );
  assert.notEqual(selfTest.exitCode, 0);
  assert.deepEqual(
    selfTest.observed.map((path) =>
      path === "/bin/false" ? "/usr/bin/false" : path,
    ),
    ["/usr/bin/false"],
  );
  assert.deepEqual(selfTest.unexpectedStderr, []);
  return Object.freeze({
    path: outputs[0],
    sha256: sha("sha256", first),
  });
};
const runSupervisedBuildContainer = (
  name,
  arguments_,
  workTimeout = 180_000,
  teardownReserve = DEFAULT_CONTAINER_TEARDOWN_RESERVE_MILLISECONDS,
) => {
  const result = runBoundedContainer(
    name,
    arguments_,
    workTimeout,
    teardownReserve,
  );
  const lines = (result.stderr ?? "").trim().split("\n").filter(Boolean);
  return Object.freeze({
    exitCode: result.status,
    output: (result.stdout ?? "").trim(),
    error: result.error,
    observed: Object.freeze(
      lines
        .filter((line) => line.startsWith("AGENTSCOPE_EXEC\t"))
        .map((line) => line.slice("AGENTSCOPE_EXEC\t".length)),
    ),
    unexpectedStderr: Object.freeze(
      lines.filter((line) => !line.startsWith("AGENTSCOPE_EXEC\t")),
    ),
  });
};
const BUILD_PROCESS_COUNT = 4;
const BUILD_PROCESS_TIMEOUT_MILLISECONDS = 120_000;
const HOSTILE_PRELUDE_TIMEOUT_MILLISECONDS = 5_000;
const BUILD_TEARDOWN_RESERVE_MILLISECONDS = 60_000;
// The external authority covers the complete sequential inner graph and owns
// an exclusive teardown reserve. An outer timeout is cleanup evidence only; it
// is never accepted as a semantic hostile-input rejection.
const BUILD_WORK_TIMEOUT_MILLISECONDS =
  BUILD_PROCESS_COUNT * BUILD_PROCESS_TIMEOUT_MILLISECONDS;
const HOSTILE_BUILD_WORK_TIMEOUT_MILLISECONDS =
  BUILD_WORK_TIMEOUT_MILLISECONDS + HOSTILE_PRELUDE_TIMEOUT_MILLISECONDS;
const supervisedFailureDiagnostic = (observed) => {
  const maximumLines = 64;
  const maximumLineCharacters = 512;
  const bounded = (lines) =>
    lines
      .slice(0, maximumLines)
      .map((line) =>
        line.length <= maximumLineCharacters
          ? line
          : `${line.slice(0, maximumLineCharacters)}[truncated]`,
      );
  return JSON.stringify({
    errorCode:
      typeof observed.error?.code === "string" ? observed.error.code : null,
    exitCode: Number.isInteger(observed.exitCode) ? observed.exitCode : null,
    observedExecutables: bounded(observed.observed),
    observedExecutablesTruncated: observed.observed.length > maximumLines,
    unexpectedStderr: bounded(observed.unexpectedStderr),
    unexpectedStderrTruncated: observed.unexpectedStderr.length > maximumLines,
  });
};
const verifySupervisedFailureDiagnostic = () => {
  const diagnostic = JSON.parse(
    supervisedFailureDiagnostic({
      error: Object.assign(new Error("SYNTHETIC_SECRET_CANARY"), {
        code: "ETIMEDOUT",
      }),
      exitCode: null,
      observed: Array.from({ length: 65 }, (_, index) => `/owned/${index}`),
      unexpectedStderr: ["x".repeat(513)],
    }),
  );
  assert.equal(diagnostic.errorCode, "ETIMEDOUT");
  assert.equal(diagnostic.exitCode, null);
  assert.equal(diagnostic.observedExecutables.length, 64);
  assert.equal(diagnostic.observedExecutablesTruncated, true);
  assert.equal(diagnostic.unexpectedStderr[0], `${"x".repeat(512)}[truncated]`);
  assert.equal(diagnostic.unexpectedStderrTruncated, false);
  assert.equal(
    JSON.stringify(diagnostic).includes("SYNTHETIC_SECRET_CANARY"),
    false,
  );
};
const expectedBuildExecutableLedger = Object.freeze([
  "/usr/bin/python3",
  "/usr/bin/cc",
  "/usr/lib/gcc/x86_64-linux-gnu/12/cc1",
  "/usr/bin/as",
  "/usr/bin/ar",
  "/usr/bin/g++",
  "/usr/lib/gcc/x86_64-linux-gnu/12/cc1plus",
  "/usr/bin/as",
  "/usr/bin/g++",
  "/usr/lib/gcc/x86_64-linux-gnu/12/collect2",
  "/usr/bin/ld",
  "/usr/lib/gcc/x86_64-linux-gnu/12/lto-wrapper",
  "/usr/bin/g++",
  "/usr/lib/gcc/x86_64-linux-gnu/12/lto1",
  "/usr/bin/g++",
  "/usr/lib/gcc/x86_64-linux-gnu/12/lto1",
  "/usr/bin/as",
  "/usr/bin/g++",
  "/usr/lib/gcc/x86_64-linux-gnu/12/lto1",
  "/usr/bin/as",
  "/usr/bin/g++",
  "/usr/lib/gcc/x86_64-linux-gnu/12/lto1",
  "/usr/bin/as",
]);
const canonicalBuildExecutable = (executable) => {
  switch (executable) {
    case "/usr/bin/python3.11":
      return "/usr/bin/python3";
    case "/usr/bin/x86_64-linux-gnu-gcc-12":
      return "/usr/bin/cc";
    case "/usr/bin/x86_64-linux-gnu-as":
      return "/usr/bin/as";
    case "/usr/bin/x86_64-linux-gnu-ar":
      return "/usr/bin/ar";
    case "/usr/bin/x86_64-linux-gnu-g++-12":
      return "/usr/bin/g++";
    case "/usr/bin/x86_64-linux-gnu-ld.bfd":
      return "/usr/bin/ld";
    case "/usr/bin/true":
      return "/bin/true";
    default:
      return executable;
  }
};
const verifyBuildExecutableCanonicalization = () => {
  assert.deepEqual(
    [
      "/usr/bin/python3.11",
      "/usr/bin/x86_64-linux-gnu-gcc-12",
      "/usr/bin/x86_64-linux-gnu-as",
      "/usr/bin/x86_64-linux-gnu-ar",
      "/usr/bin/x86_64-linux-gnu-g++-12",
      "/usr/bin/x86_64-linux-gnu-ld.bfd",
      "/usr/bin/true",
    ].map(canonicalBuildExecutable),
    [
      "/usr/bin/python3",
      "/usr/bin/cc",
      "/usr/bin/as",
      "/usr/bin/ar",
      "/usr/bin/g++",
      "/usr/bin/ld",
      "/bin/true",
    ],
  );
  assert.equal(canonicalBuildExecutable("/hostile/cc"), "/hostile/cc");
};
const allowedBuildExecutables = new Set([
  "/usr/bin/ar",
  "/usr/bin/as",
  "/usr/bin/cc",
  "/usr/bin/g++",
  "/usr/bin/ld",
  "/usr/lib/gcc/x86_64-linux-gnu/12/cc1",
  "/usr/lib/gcc/x86_64-linux-gnu/12/cc1plus",
  "/usr/lib/gcc/x86_64-linux-gnu/12/collect2",
  "/usr/lib/gcc/x86_64-linux-gnu/12/lto-wrapper",
  "/usr/lib/gcc/x86_64-linux-gnu/12/lto1",
  "/usr/bin/python3",
]);
const timingContainerProfile = (execSupervisor) => [
  "--platform",
  nativeCandidatePlatform.docker,
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--user",
  `${process.getuid()}:${process.getgid()}`,
  "--pids-limit",
  "16",
  "--memory",
  "128m",
  "--cpus",
  "1",
  "--tmpfs",
  "/work:rw,exec,nosuid,size=8m",
  "-v",
  `${execSupervisor}:/authority/exec-supervisor:ro`,
  "--entrypoint",
  "/authority/exec-supervisor",
];
const verifyControlledSlowCompiler = (temporaryRoot, execSupervisor) => {
  const driver = join(temporaryRoot, "controlled-slow-compiler.py");
  writeFileSync(
    driver,
    [
      "import os, signal, subprocess",
      'fifo = "/work/controlled-slow.c"',
      "os.mkfifo(fifo, 0o600)",
      'child = subprocess.Popen(["/usr/bin/cc", "-x", "c", "-c", fifo, "-o", "/work/controlled-slow.o"], cwd="/work", env={"HOME":"/work","LANG":"C","LC_ALL":"C","PATH":"/usr/bin:/bin","TMPDIR":"/work"}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)',
      "try:",
      "    child.wait(timeout=0.25)",
      "except subprocess.TimeoutExpired:",
      "    os.killpg(child.pid, signal.SIGKILL)",
      "    child.wait(timeout=1)",
      "    raise SystemExit(124)",
      "raise SystemExit(125)",
      "",
    ].join("\n"),
    { mode: 0o400 },
  );
  const observed = runSupervisedBuildContainer(
    `agentscope-native-controlled-slow-compiler-${randomUUID()}`,
    [
      "--rm",
      ...timingContainerProfile(execSupervisor),
      "-v",
      `${driver}:/authority/controlled-slow-compiler.py:ro`,
      imageManifest,
      "/usr/bin/python3",
      "-B",
      "/authority/controlled-slow-compiler.py",
    ],
    30_000,
  );
  assert.equal(observed.error, undefined);
  assert.equal(observed.exitCode, 124);
  assert.equal(observed.output, "");
  assert.deepEqual(observed.unexpectedStderr, []);
  const executables = observed.observed.map(canonicalBuildExecutable);
  assert.equal(executables[0], "/usr/bin/python3");
  assert(executables.includes("/usr/bin/cc"));
};
const verifySupervisedSignalCleanup = (execSupervisor) => {
  const name = `agentscope-native-supervised-signal-${randomUUID()}`;
  const observed = runSupervisedBuildContainer(
    name,
    [
      "--rm",
      ...timingContainerProfile(execSupervisor),
      imageManifest,
      "/bin/sleep",
      "30",
    ],
    250,
  );
  assert.equal(observed.error?.code, "ETIMEDOUT");
  assert.equal(observed.exitCode, null);
  assert.equal(observed.output, "");
  assertNoContainer(name);
};
const buildContainerArguments = (
  materialDirectories,
  execSupervisor,
  hostileMode,
) => [
  "--rm",
  "--platform",
  nativeCandidatePlatform.docker,
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--user",
  `${process.getuid()}:${process.getgid()}`,
  "--pids-limit",
  "128",
  "--memory",
  "2g",
  "--cpus",
  "2",
  "--tmpfs",
  "/work:rw,exec,nosuid,size=512m",
  "-e",
  "HOME=/work/home",
  "-e",
  "LANG=C",
  "-e",
  "LC_ALL=C",
  "-e",
  "PATH=/usr/bin:/bin",
  "-e",
  "SOURCE_DATE_EPOCH=0",
  "-e",
  "TMPDIR=/work/tmp",
  "-v",
  `${materialDirectories[0]}:/materials/better-sqlite3:ro`,
  "-v",
  `${materialDirectories[1]}:/materials/node-addon-api:ro`,
  "-v",
  `${join(records, "release-materials.json")}:/authority/release-materials.json:ro`,
  "-v",
  `${join(root, "tooling/build-driver.py")}:/authority/build-driver.py:ro`,
  "-v",
  `${join(root, "tooling/namespace-helper.cpp")}:/authority/namespace-helper.cpp:ro`,
  "-v",
  `${join(root, "tooling/runtime-bundler.py")}:/authority/runtime_bundler.py:ro`,
  "-v",
  `${execSupervisor}:/authority/exec-supervisor:ro`,
  "--entrypoint",
  "/authority/exec-supervisor",
  imageManifest,
  "/usr/bin/python3",
  "-B",
  "/authority/build-driver.py",
  ...(hostileMode === undefined ? [] : [hostileMode]),
];
const build = (materialDirectories, execSupervisor) => {
  const name = `agentscope-native-build-${randomUUID()}`;
  const observed = runSupervisedBuildContainer(
    name,
    buildContainerArguments(materialDirectories, execSupervisor),
    BUILD_WORK_TIMEOUT_MILLISECONDS,
    BUILD_TEARDOWN_RESERVE_MILLISECONDS,
  );
  if (observed.exitCode !== 0)
    throw new Error(
      `native candidate container failed: ${supervisedFailureDiagnostic(observed)}`,
    );
  assert.equal(observed.unexpectedStderr.length, 0);
  assert.deepEqual(
    observed.observed.map(canonicalBuildExecutable),
    expectedBuildExecutableLedger,
  );
  const result = JSON.parse(observed.output.split("\n").at(-1));
  const binary = Buffer.from(result.outputBase64, "base64");
  const runtime = Buffer.from(result.runtimeBase64, "base64");
  assert.equal(binary.length, expectedBinary.bytes);
  assert.equal(sha("sha256", binary), expectedBinary.sha256);
  assert.equal(result.schemaVersion, 2);
  assert.equal(
    result.buildGraph,
    "agentscope-owned-cc-ar-cxx-link-plus-namespace-v2",
  );
  assert.deepEqual(result.commands, ["cc", "ar", "cxx", "link"]);
  assert.deepEqual(result.commandLedger, [
    "/usr/bin/cc",
    "/usr/bin/ar",
    "/usr/bin/g++",
    "/usr/bin/g++",
  ]);
  assert.deepEqual(
    result.outputInventory.map(({ path: relative }) => relative),
    ["better_sqlite3.node", "better_sqlite3.o", "sqlite3.a", "sqlite3.o"],
  );
  assert.match(result.sourceInventorySha256, /^[0-9a-f]{64}$/u);
  assert(result.workTreeNodes.includes("source/"));
  assert.deepEqual(
    result.generatedInventory.map(({ path: relative }) => relative),
    [
      "better_sqlite3.cpp",
      "namespace-helper.cpp",
      "sqlite3.c",
      "sqlite3.h",
      "sqlite3ext.h",
    ],
  );
  assert.equal(result.outputBytes, expectedBinary.bytes);
  assert.equal(result.outputSha256, expectedBinary.sha256);
  assert.equal(result.node, "22.18.0");
  assert.equal(result.nodeAbi, 127);
  assert.equal(result.runtimeBytes, runtime.length);
  assert.equal(result.runtimeSha256, sha("sha256", runtime));
  assert.equal(Object.keys(result).length, 16);
  return Object.freeze({
    binary,
    runtime,
    executables: observed.observed,
  });
};
// eslint-disable-next-line max-lines-per-function -- one nonexecuting aggregator reconstructs all mutually bound release records under one authority.
const validateRecords = () => {
  const lockBytes = snapshot(
    join(records, "release-materials.json"),
    64 * 1024,
  );
  const lock = JSON.parse(lockBytes.toString("utf8"));
  assert.deepEqual(Object.keys(lock), [
    "schemaVersion",
    "archiveCompiler",
    "buildGraph",
    "ownedTooling",
    "toolchainClosure",
    "materials",
  ]);
  assert.equal(lock.schemaVersion, 3);
  assert.deepEqual(lock.archiveCompiler, {
    grammar: archiveLimits.archiveGrammar,
    maximumArchiveBytes: archiveLimits.maximumArchiveBytes,
    maximumExpandedBytes: archiveLimits.maximumExpandedBytes,
    maximumEntries: archiveLimits.maximumEntries,
    maximumPathBytes: archiveLimits.maximumPathBytes,
    maximumArchivePathBytes: archiveLimits.maximumArchivePathBytes,
    maximumSegmentBytes: archiveLimits.maximumSegmentBytes,
    maximumFileBytes: archiveLimits.maximumFileBytes,
    maximumDepth: archiveLimits.maximumDepth,
    maximumCompressionRatio: archiveLimits.maximumCompressionRatio,
    materialization:
      "descriptor-relative-openat-exclusive-create-same-handle-final-namespace-verify-v3",
  });
  assert.deepEqual(lock.buildGraph, {
    identity: "agentscope-owned-cc-ar-cxx-link-plus-namespace-v2",
    commands: ["/usr/bin/cc", "/usr/bin/ar", "/usr/bin/g++", "/usr/bin/g++"],
    upstreamBuildMetadata: "never-evaluated",
    environment: "closed-six-variable-v1",
    processAuthority:
      "ptrace-all-process-creation-exact-exec-path-and-driver-ledger-v4",
    writableRoot: "/work",
    output: "/work/output/better_sqlite3.node",
    outputClosure:
      "exact-whole-writable-root-inventory-with-32MiB-output-cap-v2",
  });
  assert.deepEqual(lock.ownedTooling, {
    acquisitionDriverSha256: sha(
      "sha256",
      snapshot(join(root, "tooling/acquire-driver.mjs"), 32 * 1024),
    ),
    archiveCompilerSha256: sha(
      "sha256",
      snapshot(join(root, "tooling/archive-compiler.mjs"), 64 * 1024),
    ),
    materializeHelperSha256: sha(
      "sha256",
      snapshot(join(root, "tooling/materialize-helper.py"), 16 * 1024),
    ),
    execSupervisorSourceSha256: sha(
      "sha256",
      snapshot(join(root, "tooling/exec-supervisor.c"), 16 * 1024),
    ),
    buildDriverSha256: sha(
      "sha256",
      snapshot(join(root, "tooling/build-driver.py"), 64 * 1024),
    ),
    namespaceHelperSourceSha256: sha(
      "sha256",
      snapshot(join(root, "tooling/namespace-helper.cpp"), 16 * 1024),
    ),
    namespaceHelperLicense: "MIT",
    runtimeBundlerSha256: sha(
      "sha256",
      snapshot(join(root, "tooling/runtime-bundler.py"), 32 * 1024),
    ),
  });
  assert.deepEqual(lock.toolchainClosure, {
    image,
    selectedManifest: {
      reference: imageManifest,
      bytes: nativeCandidateToolchainImageAuthority.selectedManifestBytes,
      configDigest: imageId,
      configBytes: nativeCandidateToolchainImageAuthority.configBytes,
      rawIndexGzipBase64:
        lock.toolchainClosure.selectedManifest.rawIndexGzipBase64,
      rawManifestGzipBase64:
        lock.toolchainClosure.selectedManifest.rawManifestGzipBase64,
      platform: nativeCandidatePlatform,
    },
    imageId,
    architecture: "amd64",
    node: "22.18.0",
    nodeAbi: 127,
    python: "3.11.2",
    gcc: "12.2.0-14+deb12u1",
    binutils: "2.40",
    inputRoots: [
      "/usr/bin/cc",
      "/usr/bin/ar",
      "/usr/bin/g++",
      "/usr/bin/python3",
      "/usr/lib/gcc/x86_64-linux-gnu/12",
      "/usr/include",
      "/usr/local/include/node",
      "/usr/local/src",
      "/usr/local/deps",
    ],
    authority: "complete-content-addressed-container-filesystem",
    networkDuringBuild: "denied",
    credentialAuthority: "none",
  });
  assertToolchainImageAuthority({
    sourceIndex: lock.toolchainClosure.image,
    selectedManifest: lock.toolchainClosure.selectedManifest.reference,
    selectedManifestBytes: lock.toolchainClosure.selectedManifest.bytes,
    configDigest: lock.toolchainClosure.selectedManifest.configDigest,
    configBytes: lock.toolchainClosure.selectedManifest.configBytes,
    rawIndexGzipBase64:
      lock.toolchainClosure.selectedManifest.rawIndexGzipBase64,
    rawManifestGzipBase64:
      lock.toolchainClosure.selectedManifest.rawManifestGzipBase64,
    platform: lock.toolchainClosure.selectedManifest.platform,
  });
  assert.deepEqual(
    lock.materials.map(({ name, tarballBytes, tarballSha256 }) => ({
      name,
      bytes: tarballBytes,
      sha256: tarballSha256,
    })),
    materials.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
  );
  for (const material of lock.materials) {
    const expected = materials.find(({ name }) => name === material.name);
    assert(expected);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(material).filter(([key]) => key !== "entries"),
      ),
      {
        name: expected.name,
        version: expected.version,
        registry: expected.registry,
        sourceRepository: expected.sourceRepository,
        sourceTag: expected.sourceTag,
        sourceTagObject: expected.sourceTagObject,
        sourceRevision: expected.sourceRevision,
        tarballBytes: expected.bytes,
        tarballIntegrity: `sha512-${expected.sha512}`,
        tarballSha256: expected.sha256,
        license: expected.license,
      },
    );
    assert(material.entries.length > 0 && material.entries.length <= 128);
    assert.deepEqual(
      material.entries.map((entry) => Object.keys(entry)),
      material.entries.map(() => ["path", "bytes", "sha256"]),
    );
    assert.equal(
      new Set(material.entries.map(({ path }) => path)).size,
      material.entries.length,
    );
  }
  const [betterSqliteMaterial, nodeAddonMaterial] = lock.materials;
  assert.equal(
    sha(
      "sha256",
      snapshot(join(root, "files/notices/better-sqlite3-MIT.txt"), 4 * 1024),
    ),
    betterSqliteMaterial.entries.find(({ path }) => path === "LICENSE")?.sha256,
  );
  assert.equal(
    sha(
      "sha256",
      snapshot(join(root, "files/notices/node-addon-api-MIT.txt"), 4 * 1024),
    ),
    nodeAddonMaterial.entries.find(({ path }) => path === "LICENSE.md")?.sha256,
  );
  assert.equal(
    sha(
      "sha256",
      snapshot(join(root, "files/notices/sqlite-public-domain.txt"), 4 * 1024),
    ),
    "1d0f05cf16e1c2bbf53b9a00b49480fc802acec5248443c8eaef2e515333da95",
  );
  const provenance = JSON.parse(
    snapshot(join(records, "provenance.json"), 16 * 1024).toString("utf8"),
  );
  const runtimeBytes = snapshot(
    join(root, "files/runtime/better-sqlite3.cjs"),
    128 * 1024,
  );
  assert.deepEqual(provenance, {
    schemaVersion: 1,
    candidateDisposition: "proposed-unpublished-execution-eligible",
    nativeTupleId: "node127-linux-x64-glibc",
    releaseMaterialManifestSha256: sha("sha256", lockBytes),
    sourceMaterials: lock.materials.map(
      ({
        name,
        version,
        registry,
        sourceRepository,
        sourceTag,
        sourceRevision,
        tarballBytes,
        tarballIntegrity,
        tarballSha256,
      }) => ({
        name,
        version,
        registry,
        sourceRepository,
        sourceTag,
        sourceRevision,
        tarballBytes,
        tarballIntegrity,
        tarballSha256,
        sourceAuthority:
          "verified-git-tag-revision-plus-exact-registry-tarball",
      }),
    ),
    ownedBuild: {
      profile: "agentscope-owned-native-build-v1",
      containerImageSourceIndex: image,
      containerImage: imageManifest,
      containerImageManifestBytes:
        nativeCandidateToolchainImageAuthority.selectedManifestBytes,
      containerImageId: imageId,
      containerImageConfigBytes:
        nativeCandidateToolchainImageAuthority.configBytes,
      containerPlatform: nativeCandidatePlatform,
      node: "22.18.0",
      nodeAbi: 127,
      python: "3.11.2",
      gcc: "12.2.0-14+deb12u1",
      binutils: "2.40",
      commandProfile: "agentscope-owned-cc-ar-cxx-link-plus-namespace-v2",
      upstreamBuildMetadata: "never-evaluated",
      archiveCompiler: archiveLimits.archiveGrammar,
      network: "denied",
      credentials: "none",
      capabilities: "all-dropped",
      rootFilesystem: "read-only",
      inputMounts: "read-only",
      namespaceMutation: {
        primitive: "linux-renameat2-exchange-exact-inode-v1",
        sourceSha256: lock.ownedTooling.namespaceHelperSourceSha256,
        license: lock.ownedTooling.namespaceHelperLicense,
      },
      outputRoot: "fresh-bounded-single-writable-root",
      resourceCaps: {
        cpus: 2,
        memoryBytes: 2_147_483_648,
        processes: 128,
        writableRootBytes: 536_870_912,
      },
    },
    output: {
      path: "native/node127-linux-x64-glibc/agentscope_sqlite.node",
      bytes: expectedBinary.bytes,
      sha256: expectedBinary.sha256,
      format: "ELF64-x86-64-shared-object",
      maximumGlibcSymbolVersion: "2.34",
      maximumGlibcxxSymbolVersion: "3.4.29",
      repeatBuildSha256: expectedBinary.sha256,
    },
    runtimeBundle: {
      profile: "agentscope-owned-exact-commonjs-module-map-v1",
      source: "better-sqlite3-13.0.3/lib-exact-js-inventory",
      path: "runtime/better-sqlite3.cjs",
      bytes: runtimeBytes.length,
      sha256: sha("sha256", runtimeBytes),
    },
  });
  const sbom = JSON.parse(
    snapshot(join(records, "sbom.spdx.json"), 16 * 1024).toString("utf8"),
  );
  const [betterSqlite, nodeAddon] = lock.materials;
  assert.deepEqual(sbom, {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "agentscope-local-sqlite-node127-linux-x64-glibc",
    documentNamespace:
      "https://melbourneandrew.github.io/agentscope/sbom/local-sqlite/node127-linux-x64-glibc/v1",
    creationInfo: {
      created: "2026-08-22T00:00:00Z",
      creators: ["Tool: agentscope-owned-native-build-v1"],
    },
    packages: [
      {
        name: betterSqlite.name,
        SPDXID: "SPDXRef-Package-better-sqlite3",
        versionInfo: betterSqlite.version,
        downloadLocation: materials[0].url,
        filesAnalyzed: false,
        licenseConcluded: betterSqlite.license,
        licenseDeclared: betterSqlite.license,
        checksums: [
          { algorithm: "SHA256", checksumValue: betterSqlite.tarballSha256 },
        ],
      },
      {
        name: nodeAddon.name,
        SPDXID: "SPDXRef-Package-node-addon-api",
        versionInfo: nodeAddon.version,
        downloadLocation: materials[1].url,
        filesAnalyzed: false,
        licenseConcluded: nodeAddon.license,
        licenseDeclared: nodeAddon.license,
        checksums: [
          { algorithm: "SHA256", checksumValue: nodeAddon.tarballSha256 },
        ],
      },
      {
        name: "SQLite",
        SPDXID: "SPDXRef-Package-SQLite",
        versionInfo: "3.53.4",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "blessing",
        licenseDeclared: "blessing",
      },
      {
        name: "Agentscope Local SQLite namespace helper",
        SPDXID: "SPDXRef-Package-AgentscopeNamespaceHelper",
        versionInfo: "1",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: lock.ownedTooling.namespaceHelperLicense,
        licenseDeclared: lock.ownedTooling.namespaceHelperLicense,
        checksums: [
          {
            algorithm: "SHA256",
            checksumValue: lock.ownedTooling.namespaceHelperSourceSha256,
          },
        ],
      },
    ],
    files: [
      {
        fileName: "native/node127-linux-x64-glibc/agentscope_sqlite.node",
        SPDXID: "SPDXRef-File-native",
        checksums: [
          { algorithm: "SHA256", checksumValue: expectedBinary.sha256 },
        ],
        licenseConcluded: "MIT AND blessing",
        copyrightText: "NOASSERTION",
      },
      {
        fileName: "runtime/better-sqlite3.cjs",
        SPDXID: "SPDXRef-File-runtime",
        checksums: [
          { algorithm: "SHA256", checksumValue: sha("sha256", runtimeBytes) },
        ],
        licenseConcluded: "MIT",
        copyrightText: "NOASSERTION",
      },
    ],
    relationships: [
      ["SPDXRef-DOCUMENT", "DESCRIBES", "SPDXRef-Package-better-sqlite3"],
      ["SPDXRef-DOCUMENT", "DESCRIBES", "SPDXRef-Package-node-addon-api"],
      ["SPDXRef-DOCUMENT", "DESCRIBES", "SPDXRef-Package-SQLite"],
      [
        "SPDXRef-DOCUMENT",
        "DESCRIBES",
        "SPDXRef-Package-AgentscopeNamespaceHelper",
      ],
      ["SPDXRef-Package-better-sqlite3", "CONTAINS", "SPDXRef-File-runtime"],
      ["SPDXRef-File-native", "GENERATED_FROM", "SPDXRef-Package-SQLite"],
      [
        "SPDXRef-File-native",
        "GENERATED_FROM",
        "SPDXRef-Package-better-sqlite3",
      ],
      [
        "SPDXRef-File-native",
        "GENERATED_FROM",
        "SPDXRef-Package-node-addon-api",
      ],
      [
        "SPDXRef-File-native",
        "GENERATED_FROM",
        "SPDXRef-Package-AgentscopeNamespaceHelper",
      ],
    ].map(([spdxElementId, relationshipType, relatedSpdxElement]) => ({
      spdxElementId,
      relationshipType,
      relatedSpdxElement,
    })),
  });
};
const verifyHostileBuildInputs = (
  materialDirectories,
  execSupervisor,
  temporaryRoot,
) => {
  const fixtures = [
    [
      "hostile-binding-gyp",
      "binding.gyp",
      '{"targets":[],"actions":[{"action":["sh","-c","touch /host"]}]}',
    ],
    ["hostile-config", ".npmrc", "script-shell=/hostile\n"],
  ];
  for (const [name, relative, content] of fixtures) {
    const hostile = join(temporaryRoot, name);
    cpSync(materialDirectories[0], hostile, { recursive: true });
    const target = join(hostile, relative);
    try {
      chmodSync(target, 0o600);
    } catch (error) {
      assert.equal(error?.code, "ENOENT");
    }
    writeFileSync(target, content, { mode: 0o400 });
    assert.throws(
      () => build([hostile, materialDirectories[1]], execSupervisor),
      /native candidate container failed/u,
    );
  }
  const descendantName = `agentscope-native-build-hostile-descendant-${randomUUID()}`;
  const descendant = runSupervisedBuildContainer(
    descendantName,
    buildContainerArguments(
      materialDirectories,
      execSupervisor,
      "unexpected-descendant",
    ),
    HOSTILE_BUILD_WORK_TIMEOUT_MILLISECONDS,
    BUILD_TEARDOWN_RESERVE_MILLISECONDS,
  );
  assert.equal(descendant.exitCode, 0);
  const canonicalDescendantExecutables = descendant.observed.map(
    canonicalBuildExecutable,
  );
  assert(canonicalDescendantExecutables.includes("/bin/true"));
  assert(
    canonicalDescendantExecutables.some(
      (executable) => !allowedBuildExecutables.has(executable),
    ),
  );
  const extraAllowed = runSupervisedBuildContainer(
    `agentscope-native-build-hostile-extra-allowed-${randomUUID()}`,
    buildContainerArguments(
      materialDirectories,
      execSupervisor,
      "extra-allowed-executable",
    ),
    HOSTILE_BUILD_WORK_TIMEOUT_MILLISECONDS,
    BUILD_TEARDOWN_RESERVE_MILLISECONDS,
  );
  assert.equal(extraAllowed.exitCode, 0);
  assert.deepEqual(extraAllowed.unexpectedStderr, []);
  const canonicalExtraAllowedExecutables = extraAllowed.observed.map(
    canonicalBuildExecutable,
  );
  assert(
    canonicalExtraAllowedExecutables.every((executable) =>
      allowedBuildExecutables.has(executable),
    ),
  );
  assert.notDeepEqual(
    canonicalExtraAllowedExecutables,
    expectedBuildExecutableLedger,
  );
  for (const mode of ["unexpected-output"]) {
    const name = `agentscope-native-build-hostile-output-${randomUUID()}`;
    runContainerFailure(
      name,
      buildContainerArguments(materialDirectories, execSupervisor, mode),
      HOSTILE_BUILD_WORK_TIMEOUT_MILLISECONDS,
      BUILD_TEARDOWN_RESERVE_MILLISECONDS,
    );
  }
  return Object.freeze({
    upstreamBuildActionRejected: true,
    ambientConfigRejected: true,
    unknownSubprocessInputRejected: true,
    extraAllowedSubprocessRejected: true,
    outputEscapeInputRejected: true,
  });
};
// eslint-disable-next-line max-lines-per-function -- one external supervisor owns the complete execution/hostile oracle and joined teardown.
const execute = (candidate, authorityManifest, temporaryRoot) => {
  const before = snapshot(candidate, 256 * 1024 * 1024);
  assert.equal(
    command("docker", [
      "run",
      "--rm",
      "--platform",
      nativeCandidatePlatform.docker,
      "--network",
      "none",
      "--entrypoint",
      "/bin/sh",
      executionImage,
      "-c",
      "for x in gcc g++ make python3 node-gyp; do command -v $x || true; done",
    ]),
    "",
  );
  const evidenceVolume = `agentscope-native-evidence-${randomUUID()}`;
  assert.equal(
    command("docker", ["volume", "create", evidenceVolume]),
    evidenceVolume,
  );
  const hostCanary = join(temporaryRoot, "host-canary");
  writeFileSync(hostCanary, "supervisor-owned", { mode: 0o400 });
  const name = `agentscope-native-execution-${randomUUID()}`;
  const output = runContainer(
    name,
    [
      "--rm",
      "--platform",
      nativeCandidatePlatform.docker,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "96",
      "--memory",
      "768m",
      "--cpus",
      "1",
      "--tmpfs",
      "/work:rw,exec,nosuid,size=256m",
      "--tmpfs",
      "/tmp:rw,nosuid,size=64m",
      "-e",
      "HOME=/work/home",
      "-e",
      "npm_config_cache=/work/npm-cache",
      "-e",
      `AGENTSCOPE_NATIVE_MANIFEST_DIGEST=${authorityManifest.supportManifestDigest}`,
      "-v",
      `${candidate}:/candidate/agentscope-cli.tgz:ro`,
      "-v",
      `${join(root, "tooling/test-driver.cjs")}:/authority/test-driver.cjs:ro`,
      "-v",
      `${evidenceVolume}:/evidence:rw`,
      "-v",
      `${hostCanary}:/host-canary:ro`,
      "-w",
      "/work",
      "--entrypoint",
      "/bin/sh",
      executionImage,
      "-eu",
      "-c",
      'mkdir -p "$HOME"; npm install --ignore-scripts=false --no-audit --no-fund /candidate/agentscope-cli.tgz >/tmp/npm.log; exec node /authority/test-driver.cjs',
    ],
    120_000,
  );
  assert.equal(output, "");
  assert.deepEqual(snapshot(candidate, 256 * 1024 * 1024), before);
  assert.equal(snapshot(hostCanary, 64).toString("utf8"), "supervisor-owned");
  const filesystem = command("docker", [
    "run",
    "--rm",
    "--platform",
    nativeCandidatePlatform.docker,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${evidenceVolume}:/evidence:ro`,
    "--entrypoint",
    "/usr/bin/stat",
    executionImage,
    "-f",
    "-c",
    "%T",
    "/evidence",
  ]);
  assert.equal(filesystem, "ext2/ext3");
  const oracleName = `agentscope-native-oracle-${randomUUID()}`;
  const oracle = runContainer(oracleName, [
    "--rm",
    "--platform",
    nativeCandidatePlatform.docker,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "16",
    "--memory",
    "128m",
    "--cpus",
    "0.5",
    "-v",
    `${evidenceVolume}:/evidence:ro`,
    "--entrypoint",
    "/usr/bin/python3",
    imageManifest,
    "-c",
    "import os,sqlite3; assert sorted(os.listdir('/evidence'))==['proof.sqlite','traces.sqlite','traces.sqlite-shm','traces.sqlite-wal']; assert 0<os.stat('/evidence/proof.sqlite').st_size<=1048576; assert 0<os.stat('/evidence/traces.sqlite').st_size<=1048576; assert 0<os.stat('/evidence/traces.sqlite-shm').st_size<=65536; assert 0<=os.stat('/evidence/traces.sqlite-wal').st_size<=1048576; c=sqlite3.connect('file:/evidence/proof.sqlite?mode=ro',uri=True); assert c.execute(\"select name from sqlite_master where type='table'\").fetchall()==[('proof',)]; assert c.execute('select value from proof').fetchall()==[('packed-ok',)]; c.close(); r=sqlite3.connect('file:/evidence/traces.sqlite?mode=ro',uri=True); assert r.execute('select delivery_identity,trace_id,admission_time_unix_nano from traces').fetchall()==[('2'*64,'3'*32,'5')]; assert r.execute(\"select value from destination_metadata where key='last_trusted_time_unix_nano'\").fetchall()==[('5',)]; r.close(); print('externally-observed-packed-ok')",
  ]);
  assert.equal(oracle, "externally-observed-packed-ok");
  const result = Object.freeze({
    outcome: "passed",
    observedTuple: "node127-linux-x64-glibc",
    observedValue: "packed-ok",
    reporterChildOutcome: "accepted-and-durably-confirmed",
    retrieverChildOutcome: "search-matched-and-joined",
    recoveryFenceLockOutcome: "contention-and-process-release-proved",
    node: "22.18.0",
    nodeAbi: 127,
    platform: "linux",
    architecture: "x64",
    oracle: "separate-read-only-python-sqlite-process",
  });
  const replacementName = `agentscope-native-replacement-${randomUUID()}`;
  const replacementOutput = runContainer(
    replacementName,
    [
      "--rm",
      "--platform",
      nativeCandidatePlatform.docker,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "96",
      "--memory",
      "768m",
      "--cpus",
      "1",
      "--tmpfs",
      "/work:rw,exec,nosuid,size=256m",
      "--tmpfs",
      "/tmp:rw,nosuid,size=64m",
      "-e",
      "HOME=/work/home",
      "-e",
      "npm_config_cache=/work/npm-cache",
      "-e",
      `AGENTSCOPE_NATIVE_MANIFEST_DIGEST=${authorityManifest.supportManifestDigest}`,
      "-v",
      `${candidate}:/candidate/agentscope-cli.tgz:ro`,
      "-v",
      `${join(root, "tooling/replacement-driver.cjs")}:/authority/replacement-driver.cjs:ro`,
      "-w",
      "/work",
      "--entrypoint",
      "/bin/sh",
      executionImage,
      "-eu",
      "-c",
      'mkdir -p "$HOME"; npm install --no-audit --no-fund /candidate/agentscope-cli.tgz >/tmp/npm.log; node /authority/replacement-driver.cjs',
    ],
    120_000,
  );
  assert.deepEqual(snapshot(candidate, 256 * 1024 * 1024), before);
  const replacementResult = JSON.parse(replacementOutput.split("\n").at(-1));
  assert.deepEqual(replacementResult, {
    outcome: "native-unavailable",
    databaseOpened: false,
  });
  const authorityName = `agentscope-native-authority-${randomUUID()}`;
  const authorityOutput = runContainer(
    authorityName,
    [
      "--rm",
      "--platform",
      nativeCandidatePlatform.docker,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "32",
      "--memory",
      "256m",
      "--cpus",
      "0.5",
      "--tmpfs",
      "/work:rw,exec,nosuid,size=256m",
      "--tmpfs",
      "/tmp:rw,nosuid,size=64m",
      "-e",
      "HOME=/work/home",
      "-e",
      "npm_config_cache=/work/npm-cache",
      "-v",
      `${candidate}:/candidate/agentscope-cli.tgz:ro`,
      "-v",
      `${join(root, "tooling/authority-driver.cjs")}:/authority/authority-driver.cjs:ro`,
      "-w",
      "/work",
      "--entrypoint",
      "/bin/sh",
      executionImage,
      "-eu",
      "-c",
      'mkdir -p "$HOME"; npm install --no-audit --no-fund /candidate/agentscope-cli.tgz >/tmp/npm.log; node /authority/authority-driver.cjs',
    ],
    120_000,
  );
  const authorityResult = JSON.parse(authorityOutput.split("\n").at(-1));
  assert.equal(authorityResult.outcome, "rejected");
  assert.equal(authorityResult.accessorCalls, 0);
  assert.equal(authorityResult.proxyCanaryEscaped, false);
  assert(authorityResult.after <= authorityResult.before + 1);
  const hostileArguments = (mode) => [
    "--rm",
    "--platform",
    nativeCandidatePlatform.docker,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "16",
    "--memory",
    "128m",
    "--cpus",
    "0.5",
    "-v",
    `${join(root, "tooling/hostile-driver.cjs")}:/authority/hostile-driver.cjs:ro`,
    "--entrypoint",
    "/usr/local/bin/node",
    executionImage,
    "/authority/hostile-driver.cjs",
    mode,
  ];
  const hostileResults = {
    partial: runContainerFailure(
      `agentscope-native-hostile-partial-${randomUUID()}`,
      hostileArguments("partial"),
    ),
    overflow: runContainerOutputOverflow(
      `agentscope-native-hostile-overflow-${randomUUID()}`,
      hostileArguments("overflow"),
    ),
  };
  const forgedName = `agentscope-native-hostile-forged-${randomUUID()}`;
  const forged = runContainer(forgedName, [
    "--rm",
    "--platform",
    nativeCandidatePlatform.docker,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "16",
    "--memory",
    "128m",
    "--cpus",
    "0.5",
    "-v",
    `${join(root, "tooling/hostile-driver.cjs")}:/authority/hostile-driver.cjs:ro`,
    "--entrypoint",
    "/usr/local/bin/node",
    executionImage,
    "/authority/hostile-driver.cjs",
    "forged",
  ]);
  assert.match(forged, /"outcome":"passed"/u);
  command("docker", ["volume", "rm", evidenceVolume]);
  assert.notEqual(
    spawnSync("docker", ["volume", "inspect", evidenceVolume], {
      encoding: "utf8",
    }).status,
    0,
  );
  return {
    before,
    result,
    replacementResult,
    authorityResult,
    hostileResults: Object.freeze({
      forgedGuestRecordRejected: true,
      partialGuestRecordRejected: hostileResults.partial.rejected,
      outputOverflowRejected: hostileResults.overflow.rejected,
      networkEgressRejected: true,
      hostMutationRejected: true,
      retainedChildDestroyed: true,
      filesystemProfileObserved: "local-ext4-family",
    }),
  };
};

const temporary = mkdtempSync(join(tmpdir(), "agentscope-native-candidate-"));
try {
  verifySupervisedFailureDiagnostic();
  verifyCreateUncertaintyCleanup();
  verifyObservationTimeoutArbitration();
  verifyBuildExecutableCanonicalization();
  verifyArchiveCompilerHostileFixtures();
  verifyMaterializerParentSwapFixture();
  validateRecords();
  for (const material of materials) verifySourceRevision(material, temporary);
  ensureImage(imageManifest, imageId);
  ensureImage(executionImage, executionImageId);
  const materialDirectory = join(temporary, "materials");
  mkdirSync(materialDirectory, { mode: 0o700 });
  const acquisition = JSON.parse(
    command(
      process.execPath,
      [
        join(root, "tooling/acquire-driver.mjs"),
        materialDirectory,
        join(records, "release-materials.json"),
      ],
      {
        env: {
          HOME: temporary,
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          TMPDIR: temporary,
        },
      },
    ),
  );
  assert.equal(acquisition.schemaVersion, 1);
  assert.deepEqual(
    acquisition.acquired.map(({ name, archiveBytes, archiveSha256 }) => ({
      name,
      bytes: archiveBytes,
      sha256: archiveSha256,
    })),
    materials.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
  );
  const materialDirectories = materials.map(({ name }) =>
    join(materialDirectory, `${name}-compiled`),
  );
  const execSupervisor = compileExecSupervisor(temporary);
  verifyControlledSlowCompiler(temporary, execSupervisor.path);
  verifySupervisedSignalCleanup(execSupervisor.path);
  const first = build(materialDirectories, execSupervisor.path);
  const second = build(materialDirectories, execSupervisor.path);
  assert.deepEqual(first, second);
  const hostileBuildResults = verifyHostileBuildInputs(
    materialDirectories,
    execSupervisor.path,
    temporary,
  );
  assert.deepEqual(
    first.binary,
    snapshot(
      join(root, "files/native/node127-linux-x64-glibc/agentscope_sqlite.node"),
      4 * 1024 * 1024,
    ),
  );
  assert.deepEqual(
    first.runtime,
    snapshot(join(root, "files/runtime/better-sqlite3.cjs"), 128 * 1024),
  );
  const candidate = join(workspace, "artifacts/npm/agentscope-cli-0.1.0.tgz");
  const testManifest = snapshot(
    join(root, "evidence/test-manifest.json"),
    16 * 1024,
  );
  const testAuthority = JSON.parse(testManifest.toString("utf8"));
  assert.equal(testAuthority.executionImage, executionImage);
  assert.equal(testAuthority.executionImageId, executionImageId);
  assert.match(testAuthority.supportManifestDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(testAuthority.steps, [
    "offline-clean-install-scripts-enabled",
    "owned-loader-load",
    "file-database-create-insert-select-close",
    "descriptor-bound-native-open-substitution-rejected",
    "descriptor-relative-atomic-exchange-and-substitution-rejected",
    "descriptor-recovery-fence-lock-contention-and-process-release",
    "packed-reporter-child-ready-permission-transaction-settlement",
    "packed-retriever-child-ready-permission-search-settlement",
    "external-read-only-database-oracle",
    "post-load-runtime-path-substitution-rejected",
    "invalid-authority-descriptor-leak-and-accessor-rejected",
    "network-egress-rejected",
    "host-mutation-rejected",
    "retained-child-destroyed",
    "output-overflow-rejected",
    "forged-and-partial-guest-evidence-rejected",
  ]);
  assert.deepEqual(testAuthority.expected, {
    outcome: "passed",
    observedTuple: "node127-linux-x64-glibc",
    observedValue: "packed-ok",
    reporterChildOutcome: "accepted-and-durably-confirmed",
    retrieverChildOutcome: "search-matched-and-joined",
    replacementOutcome: "native-unavailable",
    recoveryFenceLockOutcome: "contention-and-process-release-proved",
    invalidAuthorityDescriptors: "rejected-without-leak-or-callback",
    networkEgress: "rejected",
    hostMutation: "rejected",
    retainedChild: "destroyed",
    outputOverflow: "rejected",
    forgedGuestEvidence: "rejected",
    filesystemProfile: "local-ext4-family",
    upstreamBuildAction: "rejected-before-execution",
    ambientBuildConfig: "rejected-before-execution",
    unknownBuildSubprocess: "rejected-before-execution",
    buildOutputEscape: "rejected-before-execution",
    survivingContainers: 0,
  });
  assert.deepEqual(testAuthority.containment, {
    network: "denied",
    credentials: "none",
    capabilities: "all-dropped",
    rootFilesystem: "read-only",
    candidateMount: "read-only",
    compilerToolchain: "absent",
    workspaceMount: "absent",
    processes: 96,
    memoryBytes: 805306368,
    cpus: 1,
    deadlineMilliseconds: 120000,
    teardown: "external-supervisor-forced-and-proved",
  });
  const execution = execute(candidate, testAuthority, temporary);
  const evidence = Object.freeze({
    schemaVersion: 1,
    disposition: "proposed-unpublished-execution-evidence",
    candidate: Object.freeze({
      bytes: execution.before.length,
      sha256: `sha256:${sha("sha256", execution.before)}`,
      integrity: `sha512-${sha("sha512", execution.before, "base64")}`,
    }),
    nativeTupleId: "node127-linux-x64-glibc",
    platformTupleId: "linux-x64-node22-ci-ext4-proposed",
    image,
    imageManifest,
    imageId,
    executionImage,
    executionImageId,
    materialLockDigest: `sha256:${sha(
      "sha256",
      snapshot(join(records, "release-materials.json"), 64 * 1024),
    )}`,
    buildDriverDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/build-driver.py"), 64 * 1024),
    )}`,
    acquisitionDriverDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/acquire-driver.mjs"), 32 * 1024),
    )}`,
    archiveCompilerDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/archive-compiler.mjs"), 64 * 1024),
    )}`,
    materializeHelperDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/materialize-helper.py"), 16 * 1024),
    )}`,
    execSupervisorSourceDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/exec-supervisor.c"), 16 * 1024),
    )}`,
    execSupervisorBinaryDigest: `sha256:${execSupervisor.sha256}`,
    buildExecutableLedger: first.executables,
    runtimeBundlerDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/runtime-bundler.py"), 32 * 1024),
    )}`,
    supervisorDigest: `sha256:${sha(
      "sha256",
      snapshot(fileURLToPath(import.meta.url), 64 * 1024),
    )}`,
    testDriverDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/test-driver.cjs"), 24 * 1024),
    )}`,
    replacementDriverDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/replacement-driver.cjs"), 16 * 1024),
    )}`,
    authorityDriverDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/authority-driver.cjs"), 16 * 1024),
    )}`,
    hostileDriverDigest: `sha256:${sha(
      "sha256",
      snapshot(join(root, "tooling/hostile-driver.cjs"), 16 * 1024),
    )}`,
    testManifestDigest: `sha256:${sha("sha256", testManifest)}`,
    repeatBuildSha256: `sha256:${expectedBinary.sha256}`,
    hostileBuildResults,
    containment: "external-supervisor-proved",
    result: execution.result,
    replacementResult: execution.replacementResult,
    authorityResult: execution.authorityResult,
    hostileResults: execution.hostileResults,
    survivingContainers: 0,
    supportAdmission: "not-claimed",
  });
  process.stdout.write(
    `${JSON.stringify({ nativeCandidateEvidence: evidence })}\n`,
  );
} finally {
  const volumes = spawnSync(
    "docker",
    [
      "volume",
      "ls",
      "--filter",
      "name=agentscope-native-evidence-",
      "--format",
      "{{.Name}}",
    ],
    { encoding: "utf8" },
  );
  for (const volume of (volumes.stdout ?? "")
    .trim()
    .split("\n")
    .filter(Boolean))
    spawnSync("docker", ["volume", "rm", "-f", volume], { encoding: "utf8" });
  rmSync(temporary, { recursive: true, force: true });
}
