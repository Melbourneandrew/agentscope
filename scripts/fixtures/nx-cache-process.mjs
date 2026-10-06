import { spawn, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  inspectGroupExistenceForTesting,
  inspectProcessAuthorityForTesting,
  readDarwinBirthForTesting,
} from "../workspace-policy-runner.mjs";

const entrypoint = fileURLToPath(import.meta.url);
const nx = realpathSync(
  join(dirname(entrypoint), "../../node_modules/.bin/nx"),
);
const nativeNx = realpathSync(
  new URL("../../node_modules/nx/dist/bin/nx.js", import.meta.url),
);
const teardownReserve = 3_000;
const outputLimit = 64 * 1024;
const nativeOutputLimit = 1024 * 1024;
const repository = resolve(dirname(entrypoint), "../..");
const nativeSeeds = ["real", "hang", "overflow", "descendant", "malformed"];

export function assertNativeCiSeed(seed) {
  if (!nativeSeeds.includes(seed)) throw failure("seed");
}

export function decodeNativeCapturedOutput(output) {
  if (
    typeof output !== "string" ||
    output.length > Math.ceil(nativeOutputLimit / 3) * 4
  )
    throw failure("output");
  const bytes = Buffer.from(output, "base64");
  if (bytes.length > nativeOutputLimit || bytes.toString("base64") !== output)
    throw failure("output");
  return bytes;
}

function failure(category, phase) {
  return new Error(`nx-cache.fixture.${category}`, {
    ...(phase === undefined ? {} : { cause: Object.freeze({ phase }) }),
  });
}

export function bindNxCacheFixture(root, deadline) {
  if (!lstatSync(root).isDirectory()) throw failure("root-authority");
  const path = realpathSync(root);
  const identity = lstatSync(path);
  if (
    !identity.isDirectory() ||
    identity.uid !== process.getuid() ||
    (identity.mode & 0o777) !== 0o700 ||
    !Number.isFinite(deadline) ||
    deadline - performance.now() <= teardownReserve
  )
    throw failure("root-authority");
  return { deadline, identity, path, quarantined: false, active: false };
}

function verifyRoot(authority) {
  const current = lstatSync(authority.path);
  if (
    !current.isDirectory() ||
    current.dev !== authority.identity.dev ||
    current.ino !== authority.identity.ino ||
    current.uid !== authority.identity.uid ||
    (current.mode & 0o777) !== 0o700 ||
    realpathSync(authority.path) !== authority.path
  )
    throw failure("root-substitution");
}

export function cleanupNxCacheFixture(authority) {
  if (authority.active || authority.quarantined) throw failure("quarantined");
  if (performance.now() >= authority.deadline)
    throw failure("cleanup-deadline");
  verifyRoot(authority);
  rmSync(authority.path, { recursive: true });
  if (performance.now() >= authority.deadline)
    throw failure("cleanup-deadline");
}

function captureLeader(pid, deadline) {
  let record;
  if (process.platform === "darwin") {
    record = readDarwinBirthForTesting(pid, deadline);
  } else if (process.platform === "linux") {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value
      .slice(value.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    if (!/^\d+$/u.test(fields[19] ?? "")) throw failure("birth");
    record = { processGroup: Number(fields[2]), startIdentity: fields[19] };
  }
  if (performance.now() >= deadline || record?.processGroup !== pid)
    throw failure("birth");
  return Object.freeze({ pid, startIdentity: record.startIdentity });
}

function wrapperIsAlone(pid, deadline) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw failure("inspection-deadline");
  const output = execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    env: {},
    maxBuffer: 1024 * 1024,
    timeout: Math.min(1_000, remaining),
  });
  const members = [];
  for (const line of output.trim().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match === null) throw failure("group-inventory");
    if (Number(match[2]) === pid) members.push(Number(match[1]));
  }
  return members.length === 1 && members[0] === pid;
}

function closedCommand(arguments_, runtime) {
  const encoded = JSON.stringify(arguments_);
  if (runtime === "native-closure") {
    if (!['["tracked"]', '["graph","--file=stdout"]'].includes(encoded))
      throw failure("command");
    return;
  }
  if (
    !["runtime-one", "runtime-two"].includes(runtime) ||
    ![
      '["run","@fixture/consumer:build"]',
      '["run","@fixture/consumer:coverage"]',
      '["reset"]',
    ].includes(encoded)
  )
    throw failure("command");
}

export function bindNxCacheMessagesForTesting(
  child,
  command,
  isStopping,
  recordProblem,
  stop,
) {
  let admitted = false;
  child.on("message", (message) => {
    if (isStopping()) return;
    if (performance.now() >= command.cutoff) {
      recordProblem(failure("deadline"));
      stop();
    } else if (message?.nonce !== command.nonce) {
      recordProblem(failure("message"));
      stop();
    } else if (message.kind === "ready" && !admitted && command.leader) {
      admitted = true;
      command.progress.phase = "nx-command";
      command.diagnostic?.command("nx-command");
      child.send({ nonce: command.nonce, arguments: command.arguments });
    } else if (message.kind === "terminal" && admitted) {
      command.progress.phase = "terminal-inspection";
      command.diagnostic?.command("terminal-inspection");
      try {
        if (
          message.error !== false ||
          message.code !== 0 ||
          message.signal !== null ||
          message.overflow !== false ||
          !wrapperIsAlone(command.leader.pid, command.deadline)
        )
          recordProblem(failure("command-terminal"));
        else if (command.runtime === "native-closure") {
          command.result.output = decodeNativeCapturedOutput(message.output);
        }
      } catch {
        recordProblem(failure("group-inventory"));
      }
      stop();
    } else {
      recordProblem(failure("message"));
      stop();
    }
  });
}

function spawnWrapper(authority, nonce, environment) {
  return spawn(process.execPath, [entrypoint, "--wrapper", nonce], {
    cwd: authority.path,
    env: environment,
    detached: true,
    shell: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

export function assertNxCacheWorkBudget(deadline, now = performance.now()) {
  const cutoff = deadline - teardownReserve;
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || now >= cutoff)
    throw failure("deadline");
  return cutoff;
}

function settleUncertain(child, authority, problem, finish) {
  authority.quarantined = true;
  if (child.connected) child.disconnect();
  child.unref();
  finish(
    problem === undefined
      ? failure("join-uncertain")
      : new AggregateError(
          [problem, failure("join-uncertain")],
          "Nx command failed with uncertain containment",
          { cause: problem },
        ),
  );
}

function admitCommand(authority, arguments_, environment) {
  closedCommand(arguments_, environment.CACHE_RUNTIME);
  if (environment.CACHE_RUNTIME === "native-closure") {
    assertNativeCiSeed(environment.NATIVE_CI_GRAPH_SEED);
    if (
      environment.NX_DAEMON !== "false" ||
      environment.NX_ISOLATE_PLUGINS !== "false" ||
      environment.NX_NO_CLOUD !== "true" ||
      "NODE_OPTIONS" in environment ||
      environment.NX_WORKSPACE_DATA_DIRECTORY !==
        join(authority.path, "workspace-data") ||
      environment.NX_CACHE_DIRECTORY !== join(authority.path, "cache") ||
      environment.NX_NATIVE_FILE_CACHE_DIRECTORY !==
        join(authority.path, "native-cache")
    )
      throw failure("environment");
  }
  verifyRoot(authority);
  if (authority.active || authority.quarantined) throw failure("active");
  const cutoff =
    environment.CACHE_RUNTIME === "native-closure"
      ? authority.deadline - 1_500
      : assertNxCacheWorkBudget(authority.deadline);
  if (performance.now() >= cutoff) throw failure("deadline");
  authority.active = true;
  return cutoff;
}

// Test-only: a persistent wrapper owns each real Nx command's process group.
// It stays alive after direct-child close until the parent retires that group.
function signalOwnedGroup(leader, deadline, name) {
  const observation = inspectProcessAuthorityForTesting(
    leader,
    process.platform,
    deadline,
  );
  if (observation.groupAbsent) return false;
  if (observation.leader !== "same") throw failure("identity-loss");
  process.kill(-leader.pid, name);
  return name === "SIGKILL";
}

function captureOwnedLeader(child, authority) {
  try {
    return captureLeader(child.pid, authority.deadline);
  } catch {
    authority.quarantined = true;
    if (child.connected) child.disconnect();
    return undefined;
  }
}

export function runNxCacheCommand(authority, arguments_, environment) {
  const cutoff = admitCommand(authority, arguments_, environment);
  return new Promise((resolveCommand, rejectCommand) => {
    const nonce = randomBytes(16).toString("hex");
    let leader;
    let problem;
    let closed = false;
    let stopping = false;
    let killed = false;
    let settled = false;
    let graceTimer;
    let pollTimer;
    const progress = { phase: "wrapper-startup" };
    const diagnostic = authority.diagnostic;
    diagnostic?.command("wrapper-startup");
    const result = {};
    const child = spawnWrapper(authority, nonce, environment);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      [executionTimer, hardTimer, graceTimer, pollTimer].forEach(clearTimeout);
      authority.active = false;
      if (error === undefined) diagnostic?.command("complete");
      if (error === undefined) resolveCommand(result.output);
      else rejectCommand(error);
    };
    const inspect = () =>
      inspectProcessAuthorityForTesting(
        leader,
        process.platform,
        authority.deadline,
      );
    const signal = (name) => {
      if (signalOwnedGroup(leader, authority.deadline, name)) killed = true;
    };
    const poll = () => {
      if (settled) return;
      diagnostic?.command("join-inspection");
      try {
        if (inspectGroupExistenceForTesting(-leader.pid, authority.deadline)) {
          if (!killed && inspect().leader !== "same")
            throw failure("identity-loss");
        } else if (closed) {
          finish(problem);
          return;
        }
      } catch {
        authority.quarantined = true;
        problem ??= failure("join-uncertain");
      }
      pollTimer = setTimeout(poll, 20);
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      diagnostic?.command("stop-inspection");
      try {
        signal("SIGTERM");
        graceTimer = setTimeout(() => {
          try {
            signal("SIGKILL");
          } catch {
            authority.quarantined = true;
            problem ??= failure("join-uncertain");
          }
        }, 100);
      } catch {
        authority.quarantined = true;
        problem ??= failure("join-uncertain");
      }
      poll();
    };
    const executionTimer = setTimeout(
      () => {
        problem ??= failure("deadline", progress.phase);
        stop();
      },
      Math.max(0, cutoff - performance.now()),
    );
    const hardTimer = setTimeout(
      () => settleUncertain(child, authority, problem, finish),
      Math.max(0, authority.deadline - performance.now()),
    );
    diagnostic?.command("birth-inspection");
    leader = captureOwnedLeader(child, authority);
    if (leader === undefined) problem = failure("birth");
    child.once("error", () => {
      problem ??= failure("spawn");
      stop();
    });
    child.once("close", () => {
      closed = true;
      if (!stopping) {
        problem ??= failure("wrapper-exit");
        stop();
      }
    });
    bindNxCacheMessagesForTesting(
      child,
      {
        nonce,
        leader,
        arguments: arguments_,
        deadline: authority.deadline,
        cutoff,
        progress,
        diagnostic,
        runtime: environment.CACHE_RUNTIME,
        result,
      },
      () => settled || stopping,
      (error) => {
        problem ??= error;
      },
      stop,
    );
  });
}

function spawnFixtureCommand(arguments_) {
  const native = process.env.CACHE_RUNTIME === "native-closure";
  const tracked = native && arguments_[0] === "tracked";
  const seed = process.env.NATIVE_CI_GRAPH_SEED;
  if (native) assertNativeCiSeed(seed);
  const synthetic = native && !tracked && seed !== "real";
  return spawn(
    synthetic || (native && !tracked)
      ? process.execPath
      : tracked
        ? "/usr/bin/git"
        : nx,
    synthetic
      ? [entrypoint, "--native-seed", seed]
      : tracked
        ? ["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"]
        : [
            ...(native ? [nativeNx] : []),
            ...arguments_,
            ...(native || arguments_[0] === "reset"
              ? []
              : ["--outputStyle=static"]),
          ],
    {
      cwd: native ? repository : undefined,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function nativeSeed(seed) {
  assertNativeCiSeed(seed);
  if (seed === "hang") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
    if (process.connected) process.send({ ready: true });
  } else if (seed === "overflow") {
    process.stdout.write(Buffer.alloc(nativeOutputLimit + 1));
  } else if (seed === "descendant") {
    const child = spawn(
      process.execPath,
      [entrypoint, "--native-seed", "hang"],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    child.once("message", (message) =>
      process.exit(message?.ready === true ? 0 : 1),
    );
  } else if (seed === "malformed")
    process.stdout.write('{"graph":{"nodes":null}}');
  else process.exit(1);
}

function wrapper(nonce) {
  if (!/^[a-f0-9]{32}$/u.test(nonce) || !process.connected) process.exit(1);
  const keepAlive = setInterval(() => {}, 1_000);
  let started = false;
  // Stay the authenticated group leader through cooperative stop and KILL.
  process.on("SIGTERM", () => {});
  // Disconnect is channel-bound to this live wrapper, never a recycled PID.
  process.once("disconnect", () => process.kill(-process.pid, "SIGKILL"));
  process.on("message", (message) => {
    if (started || message?.nonce !== nonce)
      process.kill(-process.pid, "SIGKILL");
    started = true;
    closedCommand(message.arguments, process.env.CACHE_RUNTIME);
    const arguments_ = message.arguments;
    const native = process.env.CACHE_RUNTIME === "native-closure";
    const child = spawnFixtureCommand(arguments_);
    let bytes = 0;
    let overflow = false;
    let error = false;
    const chunks = [];
    const observe = (chunk) => {
      bytes += chunk.length;
      if (bytes > (native ? nativeOutputLimit : outputLimit) && !overflow) {
        overflow = true;
        process.send({ nonce, kind: "terminal", error: true, overflow: true });
      }
    };
    child.stdout.on("data", (chunk) => {
      observe(chunk);
      if (native && !overflow) chunks.push(chunk);
    });
    child.stderr.on("data", observe);
    child.once("error", () => {
      error = true;
    });
    child.once("close", (code, signal) => {
      if (!overflow)
        process.send({
          nonce,
          kind: "terminal",
          code,
          signal,
          error,
          overflow,
          ...(native
            ? { output: Buffer.concat(chunks).toString("base64") }
            : {}),
        });
    });
  });
  process.send({ nonce, kind: "ready" });
  return keepAlive;
}

if (resolve(process.argv[1] ?? "") === entrypoint) {
  if (process.argv[2] === "--native-seed") nativeSeed(process.argv[3]);
  else wrapper(process.argv[2] === "--wrapper" ? process.argv[3] : "");
}
