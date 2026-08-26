import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const leaseScript = join(repositoryRoot, "scripts/validation-lease.py");
const temporaryRoots = [];
const leaseAuthorityEnvironmentKeys = [
  "AGENTSCOPE_VALIDATION_LEASE_FD",
  "AGENTSCOPE_VALIDATION_LEASE_TOKEN",
  "AGENTSCOPE_VALIDATION_LEASE_REPOSITORY",
];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function independentEnvironment(environment = {}, ambient = process.env) {
  const isolated = { ...ambient };
  for (const key of leaseAuthorityEnvironmentKeys) delete isolated[key];
  return { ...isolated, ...environment };
}

function command(command, arguments_, cwd, environment = {}) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: independentEnvironment(environment),
  });
  assert.equal(result.error, undefined);
  return result;
}

function git(cwd, ...arguments_) {
  const result = command("git", arguments_, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-validation-lease-test-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  const second = join(root, "second-worktree");
  const lockRoot = join(root, "locks");
  mkdirSync(repository);
  git(repository, "init", "--quiet");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Lease Test");
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "--quiet", "-m", "fixture");
  git(repository, "worktree", "add", "--quiet", "-b", "second", second);
  const environment = {
    AGENTSCOPE_VALIDATION_LEASE_TESTING: "1",
    AGENTSCOPE_VALIDATION_LEASE_TEST_ROOT: lockRoot,
  };
  return { root, repository, second, lockRoot, environment };
}

function runLease(cwd, environment, arguments_, options = {}) {
  return spawn("python3", [leaseScript, ...arguments_], {
    cwd,
    env: independentEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function result(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (value) => {
    stdout += value;
  });
  child.stderr?.on("data", (value) => {
    stderr += value;
  });
  const status = await new Promise((resolveStatus) => {
    child.once("exit", (code, signal) => resolveStatus({ code, signal }));
  });
  return { ...status, stdout, stderr };
}

async function waitForFile(path, milliseconds = 3_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error("validation lease fixture did not become ready");
}

async function waitForPidAbsence(pid, milliseconds = 3_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("validation lease descendant survived cleanup");
}

function helper(root, name, source) {
  const path = join(root, name);
  writeFileSync(path, source);
  chmodSync(path, 0o700);
  return path;
}

function ownerPath(lockRoot) {
  const [namespace] = readdirSync(lockRoot);
  assert.ok(namespace);
  return join(lockRoot, namespace, "owner.json");
}

function replayEnvironment(path, source, additions = {}) {
  chmodSync(path, 0o600);
  return {
    AGENTSCOPE_CORE_REPLAY_PRELOAD_PATH: realpathSync(path),
    AGENTSCOPE_CORE_REPLAY_PRELOAD_SHA256: createHash("sha256")
      .update(source)
      .digest("hex"),
    AGENTSCOPE_CORE_REPLAY_PRELOAD_BYTES: String(Buffer.byteLength(source)),
    ...additions,
  };
}

function pythonValue(cwd, source) {
  const outcome = command("python3", ["-c", source], cwd);
  assert.equal(outcome.status, 0, outcome.stderr);
  return outcome.stdout.trim();
}

test("independent fixtures scrub only ambient lease authority", () => {
  const ambient = {
    AGENTSCOPE_VALIDATION_LEASE_FD: "closed-fd",
    AGENTSCOPE_VALIDATION_LEASE_TOKEN: "outer-token",
    AGENTSCOPE_VALIDATION_LEASE_REPOSITORY: "outer-repository",
    AGENTSCOPE_VALIDATION_LEASE_TEST_ROOT: "test-root",
    AGENTSCOPE_CORE_REPLAY_PRELOAD_BYTES: "123",
  };
  const isolated = independentEnvironment({}, ambient);
  for (const key of leaseAuthorityEnvironmentKeys)
    assert.equal(Object.hasOwn(isolated, key), false);
  assert.equal(isolated.AGENTSCOPE_VALIDATION_LEASE_TEST_ROOT, "test-root");
  assert.equal(isolated.AGENTSCOPE_CORE_REPLAY_PRELOAD_BYTES, "123");

  const explicit = independentEnvironment(
    {
      AGENTSCOPE_VALIDATION_LEASE_FD: "explicit-fd",
      AGENTSCOPE_VALIDATION_LEASE_TOKEN: "explicit-token",
      AGENTSCOPE_VALIDATION_LEASE_REPOSITORY: "explicit-repository",
    },
    ambient,
  );
  assert.equal(explicit.AGENTSCOPE_VALIDATION_LEASE_FD, "explicit-fd");
  assert.equal(explicit.AGENTSCOPE_VALIDATION_LEASE_TOKEN, "explicit-token");
  assert.equal(
    explicit.AGENTSCOPE_VALIDATION_LEASE_REPOSITORY,
    "explicit-repository",
  );
});

test("two worktrees race for one lease and the loser starts no child", async () => {
  const value = fixture();
  const hold = helper(
    value.root,
    "hold.py",
    "import pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text('started')\ntime.sleep(.35)\n",
  );
  const firstMarker = join(value.root, "first-started");
  const secondMarker = join(value.root, "second-started");
  const first = runLease(value.repository, value.environment, [
    "test-run",
    "race",
    "--",
    "python3",
    hold,
    firstMarker,
  ]);
  const second = runLease(value.second, value.environment, [
    "test-run",
    "race",
    "--",
    "python3",
    hold,
    secondMarker,
  ]);
  const outcomes = await Promise.all([result(first), result(second)]);
  assert.deepEqual(
    outcomes.map(({ code }) => code).sort((left, right) => left - right),
    [0, 73],
  );
  assert.equal(
    [firstMarker, secondMarker].filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    }).length,
    1,
  );
  assert.match(
    outcomes.find(({ code }) => code === 73).stderr,
    /validation-lease: busy/,
  );
});

test("an owner composes a nested command through inherited authority", async () => {
  const value = fixture();
  const marker = join(value.root, "nested-started");
  const nested = helper(
    value.root,
    "nested.py",
    [
      "import os,subprocess,sys",
      "fd=int(os.environ['AGENTSCOPE_VALIDATION_LEASE_FD'])",
      "result=subprocess.run(['python3',sys.argv[1],'test-run','nested','--','python3','-c',\"import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('nested')\",sys.argv[2]],pass_fds=(fd,))",
      "raise SystemExit(result.returncode)",
      "",
    ].join("\n"),
  );
  const outcome = await result(
    runLease(value.repository, value.environment, [
      "test-run",
      "outer",
      "--",
      "python3",
      nested,
      leaseScript,
      marker,
    ]),
  );
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(readFileSync(marker, "utf8"), "nested");
});

test("a forged nesting environment without the inherited descriptor fails closed", async () => {
  const value = fixture();
  const marker = join(value.root, "forged-started");
  const forged = helper(
    value.root,
    "forged.py",
    [
      "import os,subprocess,sys",
      "environment=os.environ.copy()",
      "result=subprocess.run(['python3',sys.argv[1],'test-run','forged','--','python3','-c',\"import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('bad')\",sys.argv[2]],env=environment,close_fds=True)",
      "raise SystemExit(0 if result.returncode==74 else 1)",
      "",
    ].join("\n"),
  );
  const outcome = await result(
    runLease(value.repository, value.environment, [
      "test-run",
      "outer",
      "--",
      "python3",
      forged,
      leaseScript,
      marker,
    ]),
  );
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.throws(() => readFileSync(marker), /ENOENT/);
});

test("owner crash cannot release authority while an inherited child is live", async () => {
  const value = fixture();
  const pidFile = join(value.root, "child-pid");
  const sleeper = helper(
    value.root,
    "sleeper.py",
    "import os,pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep(30)\n",
  );
  const owner = runLease(value.repository, value.environment, [
    "test-run",
    "crash",
    "--",
    "python3",
    sleeper,
    pidFile,
  ]);
  const childPid = Number(await waitForFile(pidFile));
  process.kill(owner.pid, "SIGKILL");
  await result(owner);
  const loser = await result(
    runLease(value.second, value.environment, [
      "test-run",
      "loser",
      "--",
      "python3",
      "-c",
      "raise SystemExit(0)",
    ]),
  );
  assert.equal(loser.code, 73, loser.stderr);
  process.kill(-childPid, "SIGKILL");
  const status = command(
    "python3",
    [leaseScript, "status"],
    value.repository,
    value.environment,
  );
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /available stale=true/);
  const reconcile = command(
    "python3",
    [leaseScript, "reconcile"],
    value.repository,
    value.environment,
  );
  assert.equal(reconcile.status, 0, reconcile.stderr);
  assert.match(reconcile.stdout, /reconciled/);
});

test("a nested descendant keeps the lease after the outer owner crashes", async () => {
  const value = fixture();
  const groupFile = join(value.root, "nested-group");
  const ready = join(value.root, "nested-descendant-ready");
  const descendant = helper(
    value.root,
    "nested-descendant.py",
    "import pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text('ready')\ntime.sleep(30)\n",
  );
  const nesting = helper(
    value.root,
    "nested-crash.py",
    [
      "import os,pathlib,subprocess,sys",
      "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))",
      "fd=int(os.environ['AGENTSCOPE_VALIDATION_LEASE_FD'])",
      "raise SystemExit(subprocess.run(['python3',sys.argv[2],'test-run','nested-crash','--','python3',sys.argv[3],sys.argv[4]],pass_fds=(fd,)).returncode)",
      "",
    ].join("\n"),
  );
  const owner = runLease(value.repository, value.environment, [
    "test-run",
    "outer-crash",
    "--",
    "python3",
    nesting,
    groupFile,
    leaseScript,
    descendant,
    ready,
  ]);
  const groupPid = Number(await waitForFile(groupFile));
  await waitForFile(ready);
  process.kill(owner.pid, "SIGKILL");
  await result(owner);
  const loser = await result(
    runLease(value.second, value.environment, [
      "test-run",
      "loser",
      "--",
      "python3",
      "-c",
      "raise SystemExit(0)",
    ]),
  );
  assert.equal(loser.code, 73, loser.stderr);
  process.kill(-groupPid, "SIGKILL");
  const reconcile = command(
    "python3",
    [leaseScript, "reconcile"],
    value.repository,
    value.environment,
  );
  assert.equal(reconcile.status, 0, reconcile.stderr);
});

test("captured normal terminal fails closed without hanging on an escaped holder", async () => {
  const value = fixture();
  const pidFile = join(value.root, "escaped-normal-pid");
  const escaped = helper(
    value.root,
    "escaped-normal.py",
    "import os,pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep(30)\n",
  );
  const parent = helper(
    value.root,
    "escape-normal-parent.py",
    [
      "import os,subprocess,sys",
      "fd=int(os.environ['AGENTSCOPE_VALIDATION_LEASE_FD'])",
      "subprocess.Popen(['python3',sys.argv[1],sys.argv[2]],pass_fds=(fd,),start_new_session=True)",
      "",
    ].join("\n"),
  );
  let escapedPid;
  try {
    const started = Date.now();
    const outcome = await result(
      runLease(value.repository, value.environment, [
        "test-run",
        "escape-normal",
        "--",
        "python3",
        parent,
        escaped,
        pidFile,
      ]),
    );
    escapedPid = Number(await waitForFile(pidFile));
    assert.equal(outcome.code, 74);
    assert.match(
      outcome.stderr,
      /validation-lease: inherited-lock-cleanup-uncertain/u,
    );
    assert.ok(Date.now() - started < 3_000);
    const status = command(
      "python3",
      [leaseScript, "status"],
      value.repository,
      value.environment,
    );
    assert.equal(status.status, 2);
    assert.match(status.stdout, /validation-lease: busy/u);
  } finally {
    if (escapedPid) process.kill(-escapedPid, "SIGKILL");
  }
  await waitForPidAbsence(escapedPid);
  const reconcile = command(
    "python3",
    [leaseScript, "reconcile"],
    value.repository,
    value.environment,
  );
  assert.equal(reconcile.status, 0, reconcile.stderr);
  assert.match(reconcile.stdout, /reconciled/u);
}, 6_000);

test("captured signal terminal fails closed on an escaped holder", async () => {
  const value = fixture();
  const pidFile = join(value.root, "escaped-signal-pid");
  const escaped = helper(
    value.root,
    "escaped-signal.py",
    "import os,pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep(30)\n",
  );
  const parent = helper(
    value.root,
    "escape-signal-parent.py",
    [
      "import os,subprocess,sys,time",
      "fd=int(os.environ['AGENTSCOPE_VALIDATION_LEASE_FD'])",
      "subprocess.Popen(['python3',sys.argv[1],sys.argv[2]],pass_fds=(fd,),start_new_session=True)",
      "time.sleep(30)",
      "",
    ].join("\n"),
  );
  let escapedPid;
  try {
    const owner = runLease(value.repository, value.environment, [
      "test-run",
      "escape-signal",
      "--",
      "python3",
      parent,
      escaped,
      pidFile,
    ]);
    escapedPid = Number(await waitForFile(pidFile));
    const started = Date.now();
    process.kill(owner.pid, "SIGTERM");
    const outcome = await result(owner);
    assert.equal(outcome.code, 74);
    assert.match(
      outcome.stderr,
      /validation-lease: inherited-lock-cleanup-uncertain/u,
    );
    assert.ok(Date.now() - started < 3_000);
  } finally {
    if (escapedPid) process.kill(-escapedPid, "SIGKILL");
  }
  await waitForPidAbsence(escapedPid);
  const reconcile = command(
    "python3",
    [leaseScript, "reconcile"],
    value.repository,
    value.environment,
  );
  assert.equal(reconcile.status, 0, reconcile.stderr);
}, 6_000);

test("nested normal return reaps a same-group descendant before lease release", async () => {
  const value = fixture();
  const pidFile = join(value.root, "normal-descendant-pid");
  const descendant = helper(
    value.root,
    "normal-descendant.py",
    "import os,pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep(30)\n",
  );
  const spawnAndClose = helper(
    value.root,
    "spawn-and-close.py",
    [
      "import os,pathlib,subprocess,sys,time",
      "fd=int(os.environ['AGENTSCOPE_VALIDATION_LEASE_FD'])",
      "subprocess.Popen(['python3',sys.argv[1],sys.argv[2]],pass_fds=(fd,))",
      "deadline=time.monotonic()+2",
      "while not pathlib.Path(sys.argv[2]).exists() and time.monotonic()<deadline: time.sleep(.01)",
      "raise SystemExit(0 if pathlib.Path(sys.argv[2]).exists() else 1)",
      "",
    ].join("\n"),
  );
  const nesting = helper(
    value.root,
    "nested-normal.py",
    [
      "import os,subprocess,sys",
      "fd=int(os.environ['AGENTSCOPE_VALIDATION_LEASE_FD'])",
      "result=subprocess.run(['python3',sys.argv[1],'test-run','nested-normal','--','python3',sys.argv[2],sys.argv[3],sys.argv[4]],pass_fds=(fd,))",
      "raise SystemExit(result.returncode)",
      "",
    ].join("\n"),
  );
  const outcome = await result(
    runLease(value.repository, value.environment, [
      "test-run",
      "outer-normal",
      "--",
      "python3",
      nesting,
      leaseScript,
      spawnAndClose,
      descendant,
      pidFile,
    ]),
  );
  assert.equal(outcome.code, 0, outcome.stderr);
  const descendantPid = Number(await waitForFile(pidFile));
  await waitForPidAbsence(descendantPid);
  const status = command(
    "python3",
    [leaseScript, "status"],
    value.repository,
    value.environment,
  );
  assert.match(status.stdout, /available stale=false/);
});

test("SIGTERM cleans the owned group and releases only its record", async () => {
  const value = fixture();
  const ready = join(value.root, "signal-ready");
  const sleeper = helper(
    value.root,
    "signal-sleeper.py",
    "import pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text('ready')\ntime.sleep(30)\n",
  );
  const owner = runLease(value.repository, value.environment, [
    "test-run",
    "signal",
    "--",
    "python3",
    sleeper,
    ready,
  ]);
  await waitForFile(ready);
  process.kill(owner.pid, "SIGTERM");
  const outcome = await result(owner);
  assert.equal(outcome.code, 143, outcome.stderr);
  const status = command(
    "python3",
    [leaseScript, "status"],
    value.repository,
    value.environment,
  );
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /available stale=false/);
});

test("signal cleanup escalates after direct close until descendants are absent", async () => {
  const value = fixture();
  const pidFile = join(value.root, "signal-descendant-pid");
  const descendant = helper(
    value.root,
    "signal-descendant.py",
    [
      "import os,pathlib,signal,sys,time",
      "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))",
      "time.sleep(30)",
      "",
    ].join("\n"),
  );
  const parent = helper(
    value.root,
    "signal-parent.py",
    [
      "import os,subprocess,sys,time",
      "fd=int(os.environ['AGENTSCOPE_VALIDATION_LEASE_FD'])",
      "subprocess.Popen(['python3',sys.argv[1],sys.argv[2]],pass_fds=(fd,))",
      "time.sleep(30)",
      "",
    ].join("\n"),
  );
  const owner = runLease(value.repository, value.environment, [
    "test-run",
    "signal-descendant",
    "--",
    "python3",
    parent,
    descendant,
    pidFile,
  ]);
  const descendantPid = Number(await waitForFile(pidFile));
  process.kill(owner.pid, "SIGTERM");
  const outcome = await result(owner);
  assert.equal(outcome.code, 143, outcome.stderr);
  await waitForPidAbsence(descendantPid);
  const status = command(
    "python3",
    [leaseScript, "status"],
    value.repository,
    value.environment,
  );
  assert.match(status.stdout, /available stale=false/);
}, 12_000);

test("an interruption between mapped steps cannot launch the next step", async () => {
  const value = fixture();
  const binaries = join(value.root, "bin");
  mkdirSync(binaries);
  const ready = join(value.root, "first-step-ready");
  const forbidden = join(value.root, "second-step-started");
  const barrier = join(value.root, "between-steps");
  helper(
    binaries,
    "pnpm",
    `#!/bin/sh\nprintf ready > ${JSON.stringify(ready)}\n`,
  );
  helper(
    binaries,
    "nx",
    `#!/bin/sh\nprintf forbidden > ${JSON.stringify(forbidden)}\n`,
  );
  const owner = runLease(
    value.repository,
    {
      ...value.environment,
      AGENTSCOPE_VALIDATION_LEASE_TEST_BETWEEN_STEPS: barrier,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    ["run", "typecheck"],
  );
  await waitForFile(ready);
  await waitForFile(`${barrier}.ready`);
  const unrelated = spawn("python3", ["-c", "import time;time.sleep(30)"], {
    detached: true,
    stdio: "ignore",
  });
  process.kill(owner.pid, "SIGTERM");
  writeFileSync(`${barrier}.release`, "release");
  const outcome = await result(owner);
  assert.equal(outcome.code, 143, outcome.stderr);
  assert.throws(() => readFileSync(forbidden), /ENOENT/);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  process.kill(-unrelated.pid, "SIGKILL");
});

test("a signal in the spawn-publication gap is forwarded after authentication", async () => {
  const value = fixture();
  const binaries = join(value.root, "spawn-gap-bin");
  mkdirSync(binaries);
  const barrier = join(value.root, "after-spawn");
  const forbidden = join(value.root, "spawn-gap-next-step");
  helper(binaries, "pnpm", "#!/bin/sh\nsleep 30\n");
  helper(
    binaries,
    "nx",
    `#!/bin/sh\nprintf forbidden > ${JSON.stringify(forbidden)}\n`,
  );
  const owner = runLease(
    value.repository,
    {
      ...value.environment,
      AGENTSCOPE_VALIDATION_LEASE_TEST_AFTER_SPAWN: barrier,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    ["run", "typecheck"],
  );
  await waitForFile(`${barrier}.ready`);
  const started = Date.now();
  process.kill(owner.pid, "SIGTERM");
  writeFileSync(`${barrier}.release`, "release");
  const outcome = await result(owner);
  assert.equal(outcome.code, 143, outcome.stderr);
  assert.ok(Date.now() - started < 2_000);
  assert.throws(() => readFileSync(forbidden), /ENOENT/);
});

test("every injected post-spawn failure contains and joins the child", async () => {
  const value = fixture();
  const helperPath = helper(
    value.root,
    "injected-failure-child.py",
    "import sys,time\nprint('pump-ready',flush=True)\ntime.sleep(30)\n",
  );
  for (const phase of ["after-spawn", "owner-write", "output-pump"]) {
    const pidFile = join(value.root, `${phase}-child-pid`);
    const started = Date.now();
    const outcome = await result(
      runLease(
        value.repository,
        {
          ...value.environment,
          AGENTSCOPE_VALIDATION_LEASE_TEST_CHILD_PID: pidFile,
          AGENTSCOPE_VALIDATION_LEASE_TEST_FAILURE: phase,
        },
        ["test-run", `failure-${phase}`, "--", "python3", helperPath],
      ),
    );
    const childPid = Number(await waitForFile(pidFile));
    assert.equal(outcome.code, 74, outcome.stderr);
    assert.match(outcome.stderr, /validation-lease: injected-step-failure/u);
    assert.ok(Date.now() - started < 3_000);
    await waitForPidAbsence(childPid);
    const status = command(
      "python3",
      [leaseScript, "status"],
      value.repository,
      value.environment,
    );
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /available stale=false/u);
  }
}, 12_000);

test("the output writer preserves every byte across short writes", () => {
  const value = fixture();
  const outcome = command(
    "python3",
    [
      "-c",
      [
        "import importlib.util",
        `s=importlib.util.spec_from_file_location('lease',${JSON.stringify(leaseScript)})`,
        "m=importlib.util.module_from_spec(s); s.loader.exec_module(m)",
        "captured=bytearray()",
        "def short(_fd,data):",
        " chunk=bytes(data[:2]); captured.extend(chunk); return len(chunk)",
        "m.write_all(1,b'complete-output',writer=short)",
        "assert bytes(captured)==b'complete-output'",
      ].join("\n"),
    ],
    value.repository,
  );
  assert.equal(outcome.status, 0, outcome.stderr);
});

test("terminal drain preserves buffered child output larger than one read", async () => {
  const value = fixture();
  const size = 256 * 1024;
  const outcome = await result(
    runLease(value.repository, value.environment, [
      "test-run",
      "large-output",
      "--",
      "python3",
      "-c",
      `import sys;sys.stdout.write('x'*${size})`,
    ]),
  );
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stdout, "x".repeat(size));
});

test("reconcile distinguishes a reused PID identity from an exact live owner", async () => {
  const value = fixture();
  const status = command(
    "python3",
    [leaseScript, "status"],
    value.repository,
    value.environment,
  );
  assert.equal(status.status, 0, status.stderr);
  const path = ownerPath(value.lockRoot);
  const start = command(
    "python3",
    [
      "-c",
      `import importlib.util; s=importlib.util.spec_from_file_location('lease',${JSON.stringify(leaseScript)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.process_start(${process.pid})[1])`,
    ],
    value.repository,
  ).stdout.trim();
  const base = {
    version: 1,
    leaseId: "a".repeat(32),
    tokenHash: "b".repeat(64),
    repositoryId: "c".repeat(64),
    worktreeId: "d".repeat(64),
    rootKind: "validate",
    ownerPid: process.pid,
    ownerStart: "0".repeat(64),
    groupPid: null,
    groupStart: null,
    acquiredUnixMilliseconds: 1,
  };
  writeFileSync(path, `${JSON.stringify(base)}\n`);
  const reused = command(
    "python3",
    [leaseScript, "reconcile"],
    value.repository,
    value.environment,
  );
  assert.equal(reused.status, 0, reused.stderr);
  writeFileSync(path, `${JSON.stringify({ ...base, ownerStart: start })}\n`);
  const exact = command(
    "python3",
    [leaseScript, "reconcile"],
    value.repository,
    value.environment,
  );
  assert.equal(exact.status, 3);
  assert.match(exact.stdout, /reconciliation-required/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerStart, start);
});

test("owner diagnostics reject symlink, oversized, malformed, and extra data", () => {
  const value = fixture();
  command(
    "python3",
    [leaseScript, "status"],
    value.repository,
    value.environment,
  );
  const path = ownerPath(value.lockRoot);
  const canary = join(value.root, "diagnostic-canary");
  writeFileSync(canary, "SYNTHETIC-CANARY");
  symlinkSync(canary, path);
  for (const prepare of [
    () => {},
    () => {
      rmSync(path, { force: true });
      writeFileSync(path, "x".repeat(4_097));
    },
    () => writeFileSync(path, "[1]\n"),
    () => writeFileSync(path, '{"version":1,"extra":true}\n'),
  ]) {
    prepare();
    const outcome = command(
      "python3",
      [leaseScript, "status"],
      value.repository,
      value.environment,
    );
    assert.equal(outcome.status, 74);
    assert.match(outcome.stderr, /^validation-lease: owner-record-invalid\n$/u);
    assert.doesNotMatch(outcome.stderr, /SYNTHETIC-CANARY/u);
  }
});

test("worktrees and clones with one origin derive one repository identity", () => {
  const value = fixture();
  const bare = join(value.root, "origin.git");
  const cloneA = join(value.root, "clone-a");
  const cloneB = join(value.root, "clone-b");
  git(value.root, "init", "--quiet", "--bare", bare);
  git(value.root, "clone", "--quiet", bare, cloneA);
  git(value.root, "clone", "--quiet", bare, cloneB);
  const identity = (cwd) =>
    command(
      "python3",
      [
        "-c",
        `import importlib.util; s=importlib.util.spec_from_file_location('lease',${JSON.stringify(leaseScript)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.repository_context()['repositoryId'])`,
      ],
      cwd,
    ).stdout.trim();
  assert.equal(identity(value.repository), identity(value.second));
  assert.equal(identity(cloneA), identity(cloneB));
  const normalized = (remote) =>
    pythonValue(
      value.repository,
      `import importlib.util,pathlib; s=importlib.util.spec_from_file_location('lease',${JSON.stringify(leaseScript)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.normalized_origin(${JSON.stringify(remote)},pathlib.Path(${JSON.stringify(value.repository)})))`,
    );
  assert.equal(
    normalized("git@github.com:Melbourneandrew/agentscope.git"),
    normalized("https://credential@github.com/Melbourneandrew/agentscope.git"),
  );
  assert.equal(
    normalized("ssh://git@github.com/Melbourneandrew/agentscope.git"),
    normalized("https://github.com/Melbourneandrew/agentscope"),
  );
  assert.equal(
    normalized("../origin.git"),
    normalized(`file://${join(value.root, "origin.git")}`),
  );
});

test("malformed remote ports collapse to a content-free diagnostic", () => {
  const value = fixture();
  git(
    value.repository,
    "remote",
    "add",
    "origin",
    "https://example.invalid:SYNTHETIC-CANARY/repository.git",
  );
  const outcome = command("python3", [leaseScript, "status"], value.repository);
  assert.equal(outcome.status, 74);
  assert.equal(outcome.stderr, "validation-lease: repository-origin-invalid\n");
  assert.doesNotMatch(outcome.stderr, /SYNTHETIC-CANARY/u);
});

test("closed command mappings preserve aggregate order, cwd, and environment", () => {
  const value = fixture();
  const steps = (kind) =>
    JSON.parse(
      pythonValue(
        value.repository,
        `import importlib.util,json,pathlib; s=importlib.util.spec_from_file_location('lease',${JSON.stringify(leaseScript)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps([[str(c),a,e] for c,a,e in m.command_steps(${JSON.stringify(kind)},pathlib.Path(${JSON.stringify(value.repository)}))]))`,
      ),
    );
  const validate = steps("validate");
  assert.deepEqual(
    validate.map(([, arguments_]) => arguments_.join(" ")),
    [
      "pnpm verify:workspace",
      "pnpm verify:acceptance-evidence",
      "pnpm format:check",
      "pnpm verify:targets",
      "pnpm verify:quality",
      "eslint scripts *.mjs vitest.config.ts --max-warnings=0",
      "nx run-many -t lint --all",
      "pnpm verify:targets",
      "nx run-many -t typecheck --all",
      "pnpm verify:targets",
      "pnpm test:workspace-policy",
      "nx run-many -t test --all",
      "pnpm verify:targets",
      "nx run-many -t coverage --all",
      "pnpm verify:targets",
      "nx run-many -t build --all",
      "pnpm verify:cli-artifact",
      "node packages/destinations/local-sqlite/native-candidate/verify-artifact.mjs",
    ],
  );
  assert.ok(validate.every(([cwd]) => cwd === value.repository));
  const integration = steps("integration");
  assert.deepEqual(
    integration.map(([, arguments_]) => arguments_.join(" ")),
    [
      "pnpm --filter @agentscope/integration build",
      "pnpm --filter agentscope-cli verify:artifact",
      "node prepare-cli.mjs",
      "pnpm --filter @agentscope/integration maintain:artifacts",
      "pnpm --filter @agentscope/integration select",
      "node prepare-images.mjs",
      "pnpm --filter @agentscope/testkit build",
      "node prepare-model-routes.mjs",
      "node run-scenarios.mjs",
      "pnpm --filter @agentscope/integration maintain:artifacts",
    ],
  );
  assert.deepEqual(integration[4][2], { AGENTSCOPE_INTEGRATION_FULL: "1" });
  assert.ok(
    integration
      .filter(([, arguments_]) => arguments_[0] === "node")
      .every(([cwd]) => cwd === join(value.repository, "tests/integration")),
  );
  assert.deepEqual(
    steps("clean").map(([, arguments_]) => arguments_.join(" ")),
    ["pnpm verify:targets", "nx run-many -t clean --all"],
  );
  assert.deepEqual(
    steps("integration-clean").map(([, arguments_]) => arguments_.join(" ")),
    ["node tests/integration/clean.mjs"],
  );
  assert.deepEqual(
    steps("precommit").map(([, arguments_]) => arguments_.join(" ")),
    ["lint-staged", "node scripts/typecheck-staged.mjs"],
  );
  assert.deepEqual(
    steps("test").map(([, arguments_]) => arguments_.join(" ")),
    [
      "pnpm verify:targets",
      "pnpm test:workspace-policy",
      "nx run-many -t test --all",
    ],
  );
  const coreReplay = steps("core-artifact-replay");
  assert.deepEqual(
    coreReplay.map(([, arguments_]) => arguments_.join(" ")),
    [
      "pnpm nx run @agentscope/core:build --skip-nx-cache",
      "pnpm nx run @agentscope/core:build --skip-nx-cache",
    ],
  );
  assert.ok(coreReplay.every(([cwd]) => cwd === value.repository));
});

test("direct test executes the flattened production body without nested authority", async () => {
  const value = fixture();
  const binaries = join(value.root, "test-body-bin");
  const calls = join(value.root, "test-body-calls");
  mkdirSync(binaries);
  helper(
    binaries,
    "pnpm",
    `#!/bin/sh\nprintf 'pnpm %s\\n' "$*" >> ${JSON.stringify(calls)}\n`,
  );
  helper(
    binaries,
    "nx",
    `#!/bin/sh\nprintf 'nx %s\\n' "$*" >> ${JSON.stringify(calls)}\n`,
  );
  const outcome = await result(
    runLease(
      value.repository,
      {
        ...value.environment,
        PATH: `${binaries}:${process.env.PATH}`,
      },
      ["run", "test"],
    ),
  );
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(
    readFileSync(calls, "utf8"),
    [
      "pnpm verify:targets",
      "pnpm test:workspace-policy",
      "nx run-many -t test --all",
      "",
    ].join("\n"),
  );
});

test("mapped failures propagate their exact exit status", async () => {
  const value = fixture();
  const outcome = await result(
    runLease(value.repository, value.environment, [
      "test-run",
      "failure",
      "--",
      "python3",
      "-c",
      "raise SystemExit(37)",
    ]),
  );
  assert.equal(outcome.code, 37, outcome.stderr);
});

test("core artifact replay holds one lease for a scrubbed baseline and one fixed injection", async () => {
  const value = fixture();
  const binaries = join(value.root, "core-replay-bin");
  const calls = join(value.root, "core-replay-calls");
  const preload = join(value.root, "reviewed-preload.cjs");
  const source = "globalThis.__agentscopeReplay = true;\n";
  mkdirSync(binaries);
  writeFileSync(preload, source);
  helper(
    binaries,
    "pnpm",
    [
      "#!/bin/sh",
      `printf '%s|%s\\n' "$*" "\${NODE_OPTIONS-absent}" >> ${JSON.stringify(calls)}`,
      'if [ "${AGENTSCOPE_CORE_REPLAY_PRELOAD_PATH+x}" = x ] || [ "${AGENTSCOPE_CORE_REPLAY_PRELOAD_SHA256+x}" = x ] || [ "${AGENTSCOPE_CORE_REPLAY_PRELOAD_BYTES+x}" = x ]; then exit 2; fi',
      'if [ "${NODE_OPTIONS+x}" = x ]; then node -e "if (!globalThis.__agentscopeReplay) process.exit(1)"; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  const outcome = await result(
    runLease(
      value.repository,
      {
        ...value.environment,
        ...replayEnvironment(preload, source),
        NODE_OPTIONS: "--require=/forbidden/ambient.cjs",
        PATH: `${binaries}:${process.env.PATH}`,
      },
      ["run", "core-artifact-replay"],
    ),
  );
  assert.equal(outcome.code, 0, outcome.stderr);
  const lines = readFileSync(calls, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines)
    assert.match(line, /^nx run @agentscope\/core:build --skip-nx-cache\|/u);
  assert.match(lines[0], /\|absent$/u);
  assert.match(
    lines[1],
    /\|--import=data:text\/javascript;base64,[A-Za-z0-9+/=]+$/u,
  );
  assert.doesNotMatch(lines[1], /forbidden|reviewed-preload/u);
  assert.equal(readFileSync(preload, "utf8"), source);
  assert.equal(statSync(preload).mode & 0o777, 0o600);
});

test("core replay rejects open-ended input and hostile preload identities", () => {
  const value = fixture();
  const preload = join(value.root, "negative-preload.cjs");
  const source = "module.exports = {};\n";
  writeFileSync(preload, source);
  const valid = replayEnvironment(preload, source);
  const trailing = command(
    "python3",
    [leaseScript, "run", "core-artifact-replay", "arbitrary"],
    value.repository,
    { ...value.environment, ...valid },
  );
  assert.equal(trailing.status, 74);
  assert.match(trailing.stderr, /arguments-invalid/u);
  const arbitraryInput = command(
    "python3",
    [leaseScript, "run", "core-artifact-replay"],
    value.repository,
    { ...value.environment, ...valid, AGENTSCOPE_CORE_REPLAY_COMMAND: "bad" },
  );
  assert.equal(arbitraryInput.status, 74);
  assert.match(arbitraryInput.stderr, /replay-input-invalid/u);
  for (const environment of [
    { ...valid, AGENTSCOPE_CORE_REPLAY_PRELOAD_SHA256: "0".repeat(64) },
    { ...valid, AGENTSCOPE_CORE_REPLAY_PRELOAD_BYTES: "1" },
  ]) {
    const outcome = command(
      "python3",
      [leaseScript, "run", "core-artifact-replay"],
      value.repository,
      { ...value.environment, ...environment },
    );
    assert.equal(outcome.status, 74);
    assert.match(outcome.stderr, /replay-preload-invalid/u);
  }
  chmodSync(preload, 0o644);
  const badMode = command(
    "python3",
    [leaseScript, "run", "core-artifact-replay"],
    value.repository,
    { ...value.environment, ...valid },
  );
  assert.equal(badMode.status, 74);
  assert.match(badMode.stderr, /replay-preload-invalid/u);
  const link = join(value.root, "preload-link.cjs");
  symlinkSync(preload, link);
  const linked = command(
    "python3",
    [leaseScript, "run", "core-artifact-replay"],
    value.repository,
    {
      ...value.environment,
      ...valid,
      AGENTSCOPE_CORE_REPLAY_PRELOAD_PATH: `${realpathSync(value.root)}/preload-link.cjs`,
    },
  );
  assert.equal(linked.status, 74);
  assert.match(linked.stderr, /replay-preload-invalid/u);
  const ancestorLink = join(value.root, "ancestor-link");
  symlinkSync(realpathSync(value.root), ancestorLink);
  const linkedAncestor = command(
    "python3",
    [leaseScript, "run", "core-artifact-replay"],
    value.repository,
    {
      ...value.environment,
      ...valid,
      AGENTSCOPE_CORE_REPLAY_PRELOAD_PATH: `${realpathSync(value.root)}/ancestor-link/negative-preload.cjs`,
    },
  );
  assert.equal(linkedAncestor.status, 74);
  assert.match(linkedAncestor.stderr, /replay-preload-invalid/u);
  chmodSync(preload, 0o600);
  const wrongOwner = command(
    "python3",
    [
      "-c",
      [
        "import importlib.util,os,pathlib,sys",
        `s=importlib.util.spec_from_file_location('lease',${JSON.stringify(leaseScript)})`,
        "m=importlib.util.module_from_spec(s); s.loader.exec_module(m)",
        `os.environ.update(${JSON.stringify(valid)})`,
        "real=m.os.getuid()",
        "m.os.getuid=lambda: real+1",
        "try: m.open_replay_preload()",
        "except m.LeaseError as error: raise SystemExit(0 if str(error)=='replay-preload-invalid' else 1)",
        "raise SystemExit(1)",
      ].join("\n"),
      value.lockRoot,
    ],
    value.repository,
  );
  assert.equal(wrongOwner.status, 0, wrongOwner.stderr);
  chmodSync(value.root, 0o755);
  const publicParent = command(
    "python3",
    [leaseScript, "run", "core-artifact-replay"],
    value.repository,
    { ...value.environment, ...valid },
  );
  assert.equal(publicParent.status, 74);
  assert.match(publicParent.stderr, /replay-preload-invalid/u);
});

test("permission-denied replay cleanup is unresolved and non-mutating", () => {
  const value = fixture();
  const preload = join(value.root, "permission-cleanup-preload.mjs");
  const source = "globalThis.__permissionCleanup = true;\n";
  writeFileSync(preload, source);
  const valid = replayEnvironment(preload, source);
  const deniedCleanup = command(
    "python3",
    [
      "-c",
      [
        "import importlib.util,os",
        `s=importlib.util.spec_from_file_location('lease',${JSON.stringify(leaseScript)})`,
        "m=importlib.util.module_from_spec(s); s.loader.exec_module(m)",
        `os.environ.update(${JSON.stringify(valid)})`,
        "replay=m.open_replay_preload()",
        "m.os.open=lambda *args,**kwargs: (_ for _ in ()).throw(PermissionError())",
        "try: m.cleanup_replay_preload(replay)",
        "except m.LeaseError as error: raise SystemExit(0 if str(error)=='replay-preload-cleanup-unresolved' else 1)",
        "raise SystemExit(1)",
      ].join("\n"),
    ],
    value.repository,
  );
  assert.equal(deniedCleanup.status, 0, deniedCleanup.stderr);
  assert.equal(readFileSync(preload, "utf8"), source);
});

test("a crash after replay authentication leaves only the caller-owned source", async () => {
  const value = fixture();
  const barrier = join(value.root, "replay-open-crash");
  const preload = join(value.root, "crash-prefix-preload.mjs");
  const source = "globalThis.__crashPrefix = true;\n";
  writeFileSync(preload, source);
  const owner = runLease(
    value.repository,
    {
      ...value.environment,
      ...replayEnvironment(preload, source),
      AGENTSCOPE_VALIDATION_LEASE_TEST_REPLAY_OPEN: barrier,
    },
    ["run", "core-artifact-replay"],
  );
  await waitForFile(`${barrier}.ready`);
  process.kill(owner.pid, "SIGKILL");
  await result(owner);
  assert.equal(readFileSync(preload, "utf8"), source);
  assert.equal(statSync(preload).mode & 0o777, 0o600);
  const [namespace] = readdirSync(value.lockRoot);
  assert.ok(namespace);
  assert.deepEqual(
    readdirSync(join(value.lockRoot, namespace)).filter((name) =>
      name.startsWith("replay-preload"),
    ),
    [],
  );
  const status = command(
    "python3",
    [leaseScript, "status"],
    value.repository,
    value.environment,
  );
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /available stale=false/u);
});

test("core replay detects path replacement between its two fixed steps", async () => {
  const value = fixture();
  const binaries = join(value.root, "replacement-bin");
  const calls = join(value.root, "replacement-calls");
  const barrier = join(value.root, "replacement-barrier");
  const preload = join(value.root, "replacement-preload.cjs");
  const moved = join(value.root, "replacement-preload-original.cjs");
  const source = "module.exports = 'reviewed';\n";
  mkdirSync(binaries);
  writeFileSync(preload, source);
  helper(
    binaries,
    "pnpm",
    `#!/bin/sh\nprintf call >> ${JSON.stringify(calls)}\n`,
  );
  const owner = runLease(
    value.repository,
    {
      ...value.environment,
      ...replayEnvironment(preload, source),
      AGENTSCOPE_VALIDATION_LEASE_TEST_BETWEEN_STEPS: barrier,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    ["run", "core-artifact-replay"],
  );
  await waitForFile(`${barrier}.ready`);
  renameSync(preload, moved);
  writeFileSync(preload, "module.exports = 'substitute';\n", { mode: 0o600 });
  writeFileSync(`${barrier}.release`, "release");
  const outcome = await result(owner);
  assert.equal(outcome.code, 74, outcome.stderr);
  assert.match(outcome.stderr, /replay-preload-cleanup-unresolved/u);
  assert.equal(readFileSync(calls, "utf8"), "call");
  assert.equal(
    readFileSync(preload, "utf8"),
    "module.exports = 'substitute';\n",
  );
});

test("core replay detects a symlink replacement before injection without deleting it", async () => {
  const value = fixture();
  const binaries = join(value.root, "content-substitution-bin");
  const calls = join(value.root, "content-substitution-calls");
  const barrier = join(value.root, "content-substitution-barrier");
  const preload = join(value.root, "content-substitution-preload.cjs");
  const moved = join(value.root, "content-substitution-original.cjs");
  const substitute = join(value.root, "content-substitution-target.cjs");
  const source = "module.exports = 'reviewed';\n";
  mkdirSync(binaries);
  writeFileSync(preload, source);
  helper(
    binaries,
    "pnpm",
    `#!/bin/sh\nprintf call >> ${JSON.stringify(calls)}\n`,
  );
  const owner = runLease(
    value.repository,
    {
      ...value.environment,
      ...replayEnvironment(preload, source),
      AGENTSCOPE_VALIDATION_LEASE_TEST_BETWEEN_STEPS: barrier,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    ["run", "core-artifact-replay"],
  );
  await waitForFile(`${barrier}.ready`);
  renameSync(preload, moved);
  writeFileSync(substitute, "module.exports = 'substitute';\n", {
    mode: 0o600,
  });
  symlinkSync(substitute, preload);
  writeFileSync(`${barrier}.release`, "release");
  const outcome = await result(owner);
  assert.equal(outcome.code, 74, outcome.stderr);
  assert.match(outcome.stderr, /replay-preload-cleanup-unresolved/u);
  assert.equal(readFileSync(calls, "utf8"), "call");
  assert.equal(
    readFileSync(preload, "utf8"),
    "module.exports = 'substitute';\n",
  );
});

test("core replay detects in-place truncation before injection without deleting it", async () => {
  const value = fixture();
  const binaries = join(value.root, "truncation-bin");
  const calls = join(value.root, "truncation-calls");
  const barrier = join(value.root, "truncation-barrier");
  const preload = join(value.root, "truncation-preload.cjs");
  const source = "module.exports = 'reviewed';\n";
  const truncated = "export {};\n";
  mkdirSync(binaries);
  writeFileSync(preload, source);
  helper(
    binaries,
    "pnpm",
    `#!/bin/sh\nprintf call >> ${JSON.stringify(calls)}\n`,
  );
  const owner = runLease(
    value.repository,
    {
      ...value.environment,
      ...replayEnvironment(preload, source),
      AGENTSCOPE_VALIDATION_LEASE_TEST_BETWEEN_STEPS: barrier,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    ["run", "core-artifact-replay"],
  );
  await waitForFile(`${barrier}.ready`);
  writeFileSync(preload, truncated);
  writeFileSync(`${barrier}.release`, "release");
  const outcome = await result(owner);
  assert.equal(outcome.code, 74, outcome.stderr);
  assert.match(outcome.stderr, /replay-preload-cleanup-unresolved/u);
  assert.equal(readFileSync(calls, "utf8"), "call");
  assert.equal(readFileSync(preload, "utf8"), truncated);
});

test("core replay fails safe when the caller-owned source becomes missing", async () => {
  const value = fixture();
  const binaries = join(value.root, "missing-source-bin");
  const calls = join(value.root, "missing-source-calls");
  const barrier = join(value.root, "missing-source-barrier");
  const preload = join(value.root, "missing-source-preload.mjs");
  const source = "globalThis.__missingSource = true;\n";
  mkdirSync(binaries);
  writeFileSync(preload, source);
  helper(
    binaries,
    "pnpm",
    `#!/bin/sh\nprintf call >> ${JSON.stringify(calls)}\n`,
  );
  const owner = runLease(
    value.repository,
    {
      ...value.environment,
      ...replayEnvironment(preload, source),
      AGENTSCOPE_VALIDATION_LEASE_TEST_BETWEEN_STEPS: barrier,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    ["run", "core-artifact-replay"],
  );
  await waitForFile(`${barrier}.ready`);
  rmSync(preload);
  writeFileSync(`${barrier}.release`, "release");
  const outcome = await result(owner);
  assert.equal(outcome.code, 74, outcome.stderr);
  assert.match(outcome.stderr, /replay-preload-cleanup-unresolved/u);
  assert.equal(readFileSync(calls, "utf8"), "call");
});

test("replay rebinds ancestry, parent security, and source link identity before injection", async () => {
  for (const mutation of [
    "parent-rename",
    "ancestor-rename",
    "parent-mode",
    "hardlink",
  ]) {
    const value = fixture();
    const binaries = join(value.root, `${mutation}-bin`);
    const calls = join(value.root, `${mutation}-calls`);
    const barrier = join(value.root, `${mutation}-barrier`);
    const outer = mkdtempSync(join(value.root, `${mutation}-outer-`));
    const parent = join(outer, "private");
    const preload = join(parent, "reviewed-preload.mjs");
    const source = `globalThis.__replayMutation = ${JSON.stringify(mutation)};\n`;
    mkdirSync(binaries);
    mkdirSync(parent, { mode: 0o700 });
    writeFileSync(preload, source);
    helper(
      binaries,
      "pnpm",
      `#!/bin/sh\nprintf call >> ${JSON.stringify(calls)}\n`,
    );
    const owner = runLease(
      value.repository,
      {
        ...value.environment,
        ...replayEnvironment(preload, source),
        AGENTSCOPE_VALIDATION_LEASE_TEST_BETWEEN_STEPS: barrier,
        PATH: `${binaries}:${process.env.PATH}`,
      },
      ["run", "core-artifact-replay"],
    );
    await waitForFile(`${barrier}.ready`);
    if (mutation === "parent-rename") {
      renameSync(parent, `${parent}-moved`);
      mkdirSync(parent, { mode: 0o700 });
      writeFileSync(preload, "globalThis.__substitute = true;\n", {
        mode: 0o600,
      });
    } else if (mutation === "ancestor-rename") {
      renameSync(outer, `${outer}-moved`);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      writeFileSync(preload, "globalThis.__substitute = true;\n", {
        mode: 0o600,
      });
    } else if (mutation === "parent-mode") {
      chmodSync(parent, 0o755);
    } else {
      linkSync(preload, join(parent, "added-link.mjs"));
    }
    writeFileSync(`${barrier}.release`, "release");
    const outcome = await result(owner);
    assert.equal(outcome.code, 74, outcome.stderr);
    assert.match(outcome.stderr, /replay-preload-cleanup-unresolved/u);
    assert.equal(readFileSync(calls, "utf8"), "call");
  }
}, 15_000);

test("terminal cleanup ambiguity leaves a replacement untouched", async () => {
  const value = fixture();
  const binaries = join(value.root, "terminal-ambiguity-bin");
  const calls = join(value.root, "terminal-ambiguity-calls");
  const preload = join(value.root, "terminal-ambiguity-preload.mjs");
  const moved = join(value.root, "terminal-ambiguity-original.mjs");
  const source = "globalThis.__terminalAmbiguity = true;\n";
  const substitute = "globalThis.__substitute = true;";
  mkdirSync(binaries);
  writeFileSync(preload, source);
  helper(
    binaries,
    "pnpm",
    [
      "#!/bin/sh",
      `printf call >> ${JSON.stringify(calls)}`,
      `if [ "\${NODE_OPTIONS+x}" = x ]; then mv ${JSON.stringify(preload)} ${JSON.stringify(moved)}; printf %s ${JSON.stringify(substitute)} > ${JSON.stringify(preload)}; chmod 600 ${JSON.stringify(preload)}; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  const outcome = await result(
    runLease(
      value.repository,
      {
        ...value.environment,
        ...replayEnvironment(preload, source),
        PATH: `${binaries}:${process.env.PATH}`,
      },
      ["run", "core-artifact-replay"],
    ),
  );
  assert.equal(outcome.code, 74, outcome.stderr);
  assert.match(outcome.stderr, /replay-preload-cleanup-unresolved/u);
  assert.equal(readFileSync(calls, "utf8"), "callcall");
  assert.equal(readFileSync(preload, "utf8"), substitute);
});

test("a signal closes replay descriptors without mutating the caller source", async () => {
  const value = fixture();
  const binaries = join(value.root, "replay-signal-bin");
  const ready = join(value.root, "replay-signal-ready");
  const preload = join(value.root, "replay-signal-preload.mjs");
  const source = "globalThis.__replaySignal = true;\n";
  mkdirSync(binaries);
  writeFileSync(preload, source);
  helper(
    binaries,
    "pnpm",
    `#!/bin/sh\nprintf ready > ${JSON.stringify(ready)}\nsleep 30\n`,
  );
  const owner = runLease(
    value.repository,
    {
      ...value.environment,
      ...replayEnvironment(preload, source),
      PATH: `${binaries}:${process.env.PATH}`,
    },
    ["run", "core-artifact-replay"],
  );
  await waitForFile(ready);
  process.kill(owner.pid, "SIGTERM");
  const outcome = await result(owner);
  assert.equal(outcome.code, 143, outcome.stderr);
  assert.equal(readFileSync(preload, "utf8"), source);
  const status = command(
    "python3",
    [leaseScript, "status"],
    value.repository,
    value.environment,
  );
  assert.equal(status.status, 0, status.stderr);
});

test("core replay leaves caller cleanup authority when execution stops between or during steps", async () => {
  for (const phase of ["between", "injected"]) {
    const value = fixture();
    const binaries = join(value.root, `${phase}-failure-bin`);
    const calls = join(value.root, `${phase}-failure-calls`);
    const preload = join(value.root, `${phase}-failure-preload.cjs`);
    const source = `module.exports = ${JSON.stringify(phase)};\n`;
    mkdirSync(binaries);
    writeFileSync(preload, source);
    helper(
      binaries,
      "pnpm",
      [
        "#!/bin/sh",
        `printf call >> ${JSON.stringify(calls)}`,
        phase === "injected"
          ? 'if [ "${NODE_OPTIONS+x}" = x ]; then exit 37; fi'
          : "true",
        "exit 0",
        "",
      ].join("\n"),
    );
    const outcome = await result(
      runLease(
        value.repository,
        {
          ...value.environment,
          ...replayEnvironment(preload, source),
          ...(phase === "between"
            ? {
                AGENTSCOPE_VALIDATION_LEASE_TEST_FAILURE:
                  "between-replay-steps",
              }
            : {}),
          PATH: `${binaries}:${process.env.PATH}`,
        },
        ["run", "core-artifact-replay"],
      ),
    );
    assert.equal(outcome.code, phase === "between" ? 74 : 37, outcome.stderr);
    assert.equal(readFileSync(preload, "utf8"), source);
    assert.equal(
      readFileSync(calls, "utf8"),
      phase === "between" ? "call" : "callcall",
    );
  }
});

test("production losers start no package, Nx, Docker, or native executable", async () => {
  const value = fixture();
  const ready = join(value.root, "owner-ready");
  const hold = helper(
    value.root,
    "production-loser-hold.py",
    "import pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text('ready')\ntime.sleep(30)\n",
  );
  const owner = runLease(value.repository, value.environment, [
    "test-run",
    "owner",
    "--",
    "python3",
    hold,
    ready,
  ]);
  await waitForFile(ready);
  const binaries = join(value.root, "loser-bin");
  const marker = join(value.root, "loser-child-started");
  mkdirSync(binaries);
  for (const name of ["pnpm", "nx", "docker", "node", "lint-staged"])
    helper(
      binaries,
      name,
      `#!/bin/sh\nprintf child >> ${JSON.stringify(marker)}\n`,
    );
  const environment = {
    ...value.environment,
    PATH: `${binaries}:${process.env.PATH}`,
  };
  for (const kind of [
    "build",
    "core-artifact-replay",
    "clean",
    "native-candidate",
    "integration-clean",
    "integration-scenarios",
    "precommit",
  ]) {
    const loser = await result(
      runLease(value.second, environment, ["run", kind]),
    );
    assert.equal(loser.code, 73, loser.stderr);
  }
  assert.throws(() => readFileSync(marker), /ENOENT/);
  process.kill(owner.pid, "SIGTERM");
  await result(owner);
});

test("all host aggregate entry points are wired through the lease", () => {
  const rootManifest = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  for (const name of [
    "validate",
    "prepush",
    "lint",
    "typecheck",
    "test",
    "test:unit",
    "coverage",
    "build",
    "build:core-artifact-replay",
    "clean",
    "verify:native-candidate",
    "test:integration",
    "test:integration:clean",
    "test:integration:runner",
    "precommit",
  ])
    assert.match(rootManifest.scripts[name], /validation-lease\.py run/u);
  const integrationManifest = JSON.parse(
    readFileSync(
      join(repositoryRoot, "tests/integration/package.json"),
      "utf8",
    ),
  );
  for (const name of [
    "prepare:candidate",
    "prepare:images",
    "prepare:model-routes",
    "run:scenarios",
  ])
    assert.match(
      integrationManifest.scripts[name],
      /validation-lease\.py run/u,
    );
  assert.equal(
    readFileSync(join(repositoryRoot, ".husky/pre-push"), "utf8").trim(),
    "pnpm prepush",
  );
  assert.equal(
    readFileSync(join(repositoryRoot, ".husky/pre-commit"), "utf8").trim(),
    "pnpm precommit",
  );
});
