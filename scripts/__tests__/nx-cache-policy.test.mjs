import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import {
  assertNxCacheWorkBudget,
  bindNxCacheFixture,
  bindNxCacheMessagesForTesting,
  cleanupNxCacheFixture,
  runNxCacheCommand,
} from "../fixtures/nx-cache-process.mjs";
import {
  createNxCacheFixture,
  executionCount,
  replaceFixtureInput,
  localNxEnvironment,
} from "../fixtures/nx-cache-project.mjs";
import {
  classifyWorkspacePolicyInventory,
  createVitestInvocation,
  createWorkspacePolicyPlan,
  discoverWorkspacePolicyInventory,
  runWorkspacePolicyPlan,
  validateWorkspacePolicyInventory,
} from "../workspace-policy-runner.mjs";

const suite = "nx-cache-policy.test.mjs";

test("Nx cache suite is mandatory and serialized exactly once", async () => {
  const inventory = discoverWorkspacePolicyInventory();
  validateWorkspacePolicyInventory(inventory);
  assert.throws(
    () =>
      validateWorkspacePolicyInventory(
        inventory.filter((name) => name !== suite),
      ),
    /required test is missing: nx-cache-policy/u,
  );
  const plan = createWorkspacePolicyPlan(
    inventory,
    classifyWorkspacePolicyInventory(inventory),
  );
  assert.equal(plan.authority.filter((name) => name === suite).length, 1);
  assert.equal(plan.pure.includes(suite), false);
  assert.throws(
    () => createVitestInvocation([suite], 2),
    /classification is invalid/u,
  );
  const calls = [];
  await runWorkspacePolicyPlan(plan, async (invocation) => {
    calls.push(invocation);
    return { code: 0, signal: undefined };
  });
  const observed = calls.filter((invocation) =>
    invocation.files.includes(suite),
  );
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].files, [suite]);
  assert.equal(observed[0].workerCeiling, 1);
});

test("Nx cache terminal publication precedes later suite admission", async () => {
  const inventory = ["acceptance-evidence.test.mjs", suite, "prepush.test.mjs"];
  const plan = createWorkspacePolicyPlan(
    inventory,
    classifyWorkspacePolicyInventory(inventory),
  );
  const calls = [];
  let admit;
  let publish;
  const started = new Promise((resolveStarted) => {
    admit = resolveStarted;
  });
  const terminal = new Promise((resolveTerminal) => {
    publish = resolveTerminal;
  });
  const result = runWorkspacePolicyPlan(plan, async (invocation) => {
    calls.push(invocation.files);
    if (invocation.files.includes(suite)) {
      admit();
      await terminal;
    }
    return { code: 0, signal: undefined };
  });
  await started;
  assert.deepEqual(calls, [["acceptance-evidence.test.mjs"], [suite]]);
  publish();
  assert.deepEqual(await result, { code: 0, signal: undefined });
  assert.deepEqual(calls, [
    ["acceptance-evidence.test.mjs"],
    [suite],
    ["prepush.test.mjs"],
  ]);
});

async function withNxCacheFixture(check, duration = 30_000) {
  // Each independent cache proposition owns one deadline before setup.
  const deadline = performance.now() + duration;
  const root = mkdtempSync(join(tmpdir(), "agentscope-nx-cache-"));
  const identity = lstatSync(root);
  let authority;
  const run = (arguments_, runtime = "runtime-one") =>
    runNxCacheCommand(authority, arguments_, localNxEnvironment(runtime));
  const build = (runtime) => run(["run", "@fixture/consumer:build"], runtime);
  let primary;
  try {
    authority = bindNxCacheFixture(root, deadline);
    createNxCacheFixture(root);
    await check({ root, authority, run, build });
  } catch (error) {
    primary = { error };
  }
  // Unsettled/substituted authority retains its private fixture, never a
  // prefix sweep or cleanup claim based only on the Nx leader's exit.
  try {
    if (authority === undefined)
      throw new Error("Nx fixture setup root quarantined", {
        cause: { path: root, dev: identity.dev, ino: identity.ino },
      });
    cleanupNxCacheFixture(authority);
  } catch (error) {
    if (primary !== undefined)
      throw new AggregateError(
        [primary.error, error],
        "Nx fixture failed and remains unsettled",
        { cause: error },
      );
    throw error;
  }
  if (primary !== undefined) throw primary.error;
}

test("standard Nx cache restores only declared outputs", async () => {
  await withNxCacheFixture(async ({ root, build }) => {
    await build();
    assert.equal(executionCount(root, "dependency"), 1);
    assert.equal(executionCount(root, "consumer"), 1);

    writeFileSync(join(root, "packages/dependency/dist/result.txt"), "stale\n");
    rmSync(join(root, "packages/consumer/dist"), {
      recursive: true,
      force: true,
    });
    rmSync(join(root, "untracked"), { recursive: true, force: true });
    await build();
    assert.equal(executionCount(root, "dependency"), 1);
    assert.equal(executionCount(root, "consumer"), 1);
    assert.equal(
      readFileSync(join(root, "packages/dependency/dist/result.txt"), "utf8"),
      "dependency-one\n",
    );
    assert.equal(
      readFileSync(join(root, "packages/consumer/dist/result.txt"), "utf8"),
      "consumer-one\n",
    );
    assert.equal(existsSync(join(root, "untracked/dependency")), false);
    assert.equal(existsSync(join(root, "untracked/consumer")), false);
  });
}, 30_000);

const cacheInputCases = [
  {
    name: "dependency content change",
    dependencyExecutions: 2,
    change(root) {
      writeFileSync(
        join(root, "packages/dependency/src/value.txt"),
        "dependency-two\n",
      );
    },
  },
  {
    name: "same-length atomic dependency substitution",
    dependencyExecutions: 2,
    change(root) {
      replaceFixtureInput(
        join(root, "packages/dependency/src/value.txt"),
        "substitute-one\n",
      );
    },
  },
  {
    name: "source deletion",
    dependencyExecutions: 1,
    change(root) {
      unlinkSync(join(root, "packages/consumer/src/value.txt"));
    },
  },
  {
    name: "command manifest change",
    dependencyExecutions: 1,
    change(root) {
      const path = join(root, "packages/consumer/package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.scripts.build += " command-change";
      writeFileSync(path, JSON.stringify(manifest));
    },
  },
  {
    name: "root policy change",
    dependencyExecutions: 2,
    change(root) {
      writeFileSync(join(root, "root-policy.txt"), "policy-two\n");
    },
  },
  {
    name: "lockfile change",
    dependencyExecutions: 2,
    change(root) {
      const path = join(root, "package-lock.json");
      const lock = JSON.parse(readFileSync(path, "utf8"));
      lock.seededPolicy = "changed";
      writeFileSync(path, JSON.stringify(lock));
    },
  },
  {
    name: "runtime input change",
    dependencyExecutions: 2,
    runtime: "runtime-two",
    change() {},
  },
];

test.each(cacheInputCases)(
  "standard Nx cache invalidates $name",
  async (entry) => {
    await withNxCacheFixture(async ({ root, build }) => {
      await build();
      assert.equal(executionCount(root, "dependency"), 1);
      assert.equal(executionCount(root, "consumer"), 1);
      entry.change(root);
      await build(entry.runtime);
      assert.equal(
        executionCount(root, "dependency"),
        entry.dependencyExecutions,
      );
      assert.equal(executionCount(root, "consumer"), 2);
    });
  },
  30_000,
);

test("standard Nx reset removes prior execution evidence", async () => {
  await withNxCacheFixture(async ({ root, build, run }) => {
    await build();
    await run(["reset"]);
    await build();
    assert.equal(executionCount(root, "dependency"), 2);
    assert.equal(executionCount(root, "consumer"), 2);
  });
}, 30_000);

test("standard Nx coverage never consumes cached execution", async () => {
  await withNxCacheFixture(async ({ root, run }) => {
    await run(["run", "@fixture/consumer:coverage"]);
    assert.equal(executionCount(root, "consumer", "coverage"), 1);
    await run(["run", "@fixture/consumer:coverage"]);
    assert.equal(executionCount(root, "consumer", "coverage"), 2);
  });
}, 30_000);

test("Nx fixture rejects arbitrary command authority without a child", async () => {
  await withNxCacheFixture(({ authority, run }) => {
    assert.throws(() => run(["exec", "arbitrary"]), /fixture.command/u);
    assert.equal(authority.active, false);
  });
}, 30_000);

test("Nx fixture rejects exhausted invocation budget at its exact cutoff", () => {
  assert.equal(assertNxCacheWorkBudget(30_000, 26_999), 27_000);
  for (const now of [27_000, 27_001, 30_000, NaN, Infinity])
    assert.throws(
      () => assertNxCacheWorkBudget(30_000, now),
      /fixture.deadline/u,
    );
  assert.throws(() => assertNxCacheWorkBudget(NaN, 0), /fixture.deadline/u);
});

test("Nx fixture rejects symlink and changed-mode roots without launching", async () => {
  await withNxCacheFixture(({ root, authority, run }) => {
    const alias = join(root, "root-alias");
    symlinkSync(root, alias, "dir");
    assert.throws(
      () => bindNxCacheFixture(alias, authority.deadline),
      /fixture.root-authority/u,
    );
    unlinkSync(alias);
    chmodSync(root, 0o750);
    try {
      assert.throws(() => run(["reset"]), /fixture.root-substitution/u);
      assert.throws(
        () => cleanupNxCacheFixture(authority),
        /fixture.root-substitution/u,
      );
      assert.equal(authority.active, false);
      assert.equal(existsSync(root), true);
    } finally {
      chmodSync(root, 0o700);
    }
  });
}, 30_000);

test("Nx fixture preserves quarantined evidence instead of deleting it", async () => {
  await withNxCacheFixture(({ root, authority }) => {
    authority.quarantined = true;
    try {
      assert.throws(
        () => cleanupNxCacheFixture(authority),
        /fixture.quarantined/u,
      );
      assert.equal(existsSync(root), true);
    } finally {
      // This synthetic metadata-only case launched no child or mutation.
      authority.quarantined = false;
    }
  });
}, 30_000);

function messageFixture() {
  const child = new EventEmitter();
  const sent = [];
  const errors = [];
  let stopped = false;
  child.send = (message) => sent.push(message);
  const command = {
    nonce: "a".repeat(32),
    leader: { pid: 1 },
    arguments: ["reset"],
    cutoff: performance.now() + 5_000,
    deadline: performance.now() + 8_000,
    progress: { phase: "wrapper-startup" },
  };
  bindNxCacheMessagesForTesting(
    child,
    command,
    () => stopped,
    (error) => errors.push(error),
    () => {
      stopped = true;
    },
  );
  return { child, command, sent, errors };
}

test("Nx fixture rejects late ready before starting a command", () => {
  const state = messageFixture();
  state.command.cutoff = performance.now() - 1;
  state.child.emit("message", { nonce: state.command.nonce, kind: "ready" });
  assert.equal(state.sent.length, 0);
  assert.match(state.errors[0].message, /fixture.deadline/u);
});

test("Nx fixture rejects late terminal before success inspection", () => {
  const state = messageFixture();
  state.child.emit("message", { nonce: state.command.nonce, kind: "ready" });
  state.command.cutoff = performance.now() - 1;
  state.child.emit("message", {
    nonce: state.command.nonce,
    kind: "terminal",
    code: 0,
    signal: null,
    error: false,
    overflow: false,
  });
  assert.equal(state.sent.length, 1);
  assert.match(state.errors[0].message, /fixture.deadline/u);
  assert.equal(state.command.progress.phase, "nx-command");
});

test.each(["substituted", "duplicate"])(
  "Nx fixture rejects %s ready authority",
  (kind) => {
    const state = messageFixture();
    if (kind === "duplicate")
      state.child.emit("message", {
        nonce: state.command.nonce,
        kind: "ready",
      });
    state.child.emit("message", {
      nonce: kind === "substituted" ? "b".repeat(32) : state.command.nonce,
      kind: "ready",
    });
    assert.equal(state.sent.length, kind === "duplicate" ? 1 : 0);
    assert.match(state.errors[0].message, /fixture.message/u);
  },
);

test("Nx fixture bounds overflowing command output and joins before cleanup", async () => {
  await withNxCacheFixture(async ({ root, authority, build }) => {
    const path = join(root, "task.mjs");
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        '\nif (name === "consumer") process.stdout.write("x".repeat(128 * 1024));\n',
    );
    await assert.rejects(build(), /fixture.command-terminal/u);
    assert.equal(authority.active, false);
    assert.equal(authority.quarantined, false);
  });
}, 30_000);

test("Nx fixture retires a never-settling command on its original deadline", async () => {
  await withNxCacheFixture(async ({ root, authority, build }) => {
    const path = join(root, "task.mjs");
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        '\nif (name === "consumer") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }\n',
    );
    await assert.rejects(build(), (error) => {
      assert.match(error.message, /fixture.deadline/u);
      assert.equal(error.cause.phase, "nx-command");
      return true;
    });
    assert.equal(executionCount(root, "consumer"), 1);
    assert.equal(authority.active, false);
    assert.equal(authority.quarantined, false);
  }, 10_000);
}, 30_000);

test("Nx fixture rejects a surviving descendant and joins it before cleanup", async () => {
  await withNxCacheFixture(async ({ root, authority, build }) => {
    const path = join(root, "task.mjs");
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        `
if (name === "consumer") {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send("owned-descendant-ready");'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await new Promise((settle) => child.once("message", (message) => {
    if (message !== "owned-descendant-ready") process.exit(1);
    writeFileSync(resolve(root, "descendant-pid"), String(child.pid));
    child.disconnect(); child.unref(); settle();
  }));
}
`,
    );
    await assert.rejects(build(), /fixture.command-terminal/u);
    const pid = Number(readFileSync(join(root, "descendant-pid"), "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(authority.active, false);
    assert.equal(authority.quarantined, false);
  });
}, 30_000);
