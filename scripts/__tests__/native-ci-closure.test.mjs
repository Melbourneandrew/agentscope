import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, test } from "vitest";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import {
  bindNxCacheMessagesForTesting,
  decodeNativeCapturedOutput,
} from "../fixtures/nx-cache-process.mjs";
import {
  captureNativeCiClosure,
  decodeNativeCiGraph,
  projectNativeCiClosureFailure,
} from "../fixtures/native-ci-closure-process.mjs";
import {
  selectNativeCertification,
  validateNativeCiPolicy,
} from "../native-ci-selection.mjs";
import {
  classifyWorkspacePolicyInventory,
  createVitestInvocation,
  createWorkspacePolicyPlan,
  discoverWorkspacePolicyInventory,
  validateWorkspacePolicyInventory,
} from "../workspace-policy-runner.mjs";

const root = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(
  readFileSync(join(root, "scripts/native-ci-irrelevant-paths.json"), "utf8"),
);
const captured = {};
function syntheticCapture({ primary, cleanup, creation, output, now = 100 }) {
  const source = readFileSync(
    join(root, "scripts/fixtures/native-ci-closure-process.mjs"),
    "utf8",
  );
  const body = source
    .slice(source.indexOf("export async function captureNativeCiClosure"))
    .replace("export async function", "async function");
  const observed = { deadlines: [], cleanup: 0 };
  let reads = 0;
  const dependencies = {
    mkdtempSync: () => {
      if (creation !== undefined) throw creation;
      return "/synthetic/exact-root";
    },
    lstatSync: () => ({ dev: 11, ino: 22 }),
    bindNxCacheFixture: (path, deadline) => {
      observed.deadlines.push(deadline);
      return { path };
    },
    cleanupNxCacheFixture: () => {
      observed.cleanup += 1;
      if (cleanup !== undefined) throw cleanup;
    },
    assertNativeCiSeed: () => {},
    performance: { now: () => (reads++ === 0 ? 100 : now) },
    join,
    tmpdir: () => "/synthetic",
    dirname: () => "/synthetic",
    runNxCacheCommand: async () => {
      if (primary !== undefined) throw primary;
      return output;
    },
    parseTrackedEntries: (value) => value,
    decodeNativeCiGraph: (value) => value,
    projectNativeCiClosureFailure,
  };
  const capture = new Function(
    "dependencies",
    `const { ${Object.keys(dependencies).join(",")} } = dependencies; ${body}; return captureNativeCiClosure;`,
  )(dependencies);
  return { capture, observed };
}

test.each([
  ["wrapper-startup", "start"],
  ["nx-command", "work"],
  ["terminal-inspection", "settlement"],
])(
  "closed %s failure retains original authority and phase",
  async (phase, stage) => {
    const primary = new Error("nx-cache.fixture.deadline", {
      cause: { phase },
    });
    const cleanup = new Error("nx-cache.fixture.cleanup-deadline");
    const { capture, observed } = syntheticCapture({
      primary,
      cleanup,
      now: 7060,
    });
    await assert.rejects(capture("graph"), (error) => {
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.equal(error.cause, cleanup);
      assert.equal(
        error.message,
        `native-ci.fixture.quarantined operation=graph stage=${stage} inner_phase=${phase} elapsed_ms=6960 budget_ms=5000 teardown_reserve_ms=1500 primary=deadline cleanup=cleanup-deadline`,
      );
      return true;
    });
    assert.deepEqual(observed.deadlines, [5100]);
    assert.equal(observed.cleanup, 1);
  },
);
test("successful synthetic closure has exact output and no diagnostic authority", async () => {
  const output = Object.freeze([{ path: "synthetic" }]);
  const { capture, observed } = syntheticCapture({ output });
  assert.deepEqual(await capture("tracked"), { trackedEntries: output });
  assert.deepEqual(observed.deadlines, [5100]);
  assert.equal(observed.cleanup, 1);
});
test("creation failure keeps setup elapsed and admits no cleanup or child", async () => {
  const creation = new Error("private-root-secret");
  const { capture, observed } = syntheticCapture({ creation, now: 160 });
  await assert.rejects(capture("tracked"), (error) => {
    assert.equal(error.cause, creation);
    assert.match(
      error.message,
      /operation=tracked stage=setup inner_phase=unknown elapsed_ms=60 /u,
    );
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.deepEqual(observed.deadlines, []);
  assert.equal(observed.cleanup, 0);
});
test("primary-only and cleanup-only failures preserve separate originals", async () => {
  const primary = new Error("nx-cache.fixture.deadline");
  const first = syntheticCapture({ primary });
  await assert.rejects(first.capture("tracked"), (error) => {
    assert.equal(error.cause, primary);
    assert.match(
      error.message,
      /operation=tracked stage=start inner_phase=unknown /u,
    );
    assert.match(error.message, /primary=deadline cleanup=unknown$/u);
    return true;
  });
  const cleanup = new Error("nx-cache.fixture.cleanup-deadline");
  const second = syntheticCapture({ cleanup });
  await assert.rejects(second.capture("graph"), (error) => {
    assert.deepEqual(error.errors, [cleanup]);
    assert.equal(error.cause, cleanup);
    assert.match(error.message, /stage=settlement inner_phase=unknown /u);
    return true;
  });
});
test("diagnostics reject hostile or absent error observations without reading content", () => {
  let accessed = 0;
  const hostile = Object.defineProperties(
    {},
    {
      message: {
        get() {
          accessed += 1;
          throw new Error("secret");
        },
      },
      cause: {
        get() {
          accessed += 1;
          throw new Error("secret");
        },
      },
    },
  );
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        accessed += 1;
        throw new Error("secret");
      },
    },
  );
  for (const primary of [
    undefined,
    hostile,
    proxy,
    new Error("private-path-secret"),
    new Error("nx-cache.fixture.deadline", {
      cause: { phase: "private-phase-secret" },
    }),
  ]) {
    const diagnostic = projectNativeCiClosureFailure({
      operation: "tracked",
      stage: "start",
      entered: 100,
      now: 110,
      primary,
      cleanup: hostile,
    });
    assert.match(diagnostic, /inner_phase=unknown elapsed_ms=10 /u);
    assert.equal(diagnostic.includes("secret"), false);
  }
  assert.equal(accessed, 0);
});
describe("real native closure inventory", () => {
  beforeAll(async () => {
    Object.assign(captured, await captureNativeCiClosure("tracked"));
  }, 5_000);
  beforeAll(async () => {
    Object.assign(captured, await captureNativeCiClosure("graph"));
  }, 5_000);

  test("real closure preparation is mandatory and serialized", () => {
    const name = "native-ci-closure.test.mjs";
    const inventory = discoverWorkspacePolicyInventory();
    assert.throws(
      () =>
        validateWorkspacePolicyInventory(
          inventory.filter((entry) => entry !== name),
        ),
      /required test is missing/u,
    );
    const plan = createWorkspacePolicyPlan(
      inventory,
      classifyWorkspacePolicyInventory(inventory),
    );
    assert.equal(plan.authority.filter((entry) => entry === name).length, 1);
    assert.equal(plan.pure.includes(name), false);
    assert.throws(
      () => createVitestInvocation([name], 2),
      /classification is invalid/u,
    );
  });

  test("finite irrelevant inventory remains disjoint from real packed-project closure", () => {
    const { trackedEntries, graph: nxGraph } = captured;
    const trackedPaths = trackedEntries.map(({ path }) => path);
    const irrelevantPaths = new Set(manifest.irrelevantPaths);
    const authorities = trackedPaths.filter(
      (path) =>
        path !== "scripts/native-ci-irrelevant-paths.json" &&
        !irrelevantPaths.has(path),
    );
    assert.ok(authorities.length > 0);
    for (const path of authorities)
      assert.equal(
        selectNativeCertification("pull_request", [path]).required,
        true,
        path,
      );
    assert.doesNotThrow(() => validateNativeCiPolicy(manifest, trackedEntries));
    for (const path of [
      "apps/cli/src/program.ts",
      "packages/destinations/local-sqlite/src/production/runtime.ts",
    ])
      assert.ok(authorities.includes(path), path);
    const closure = new Set(["agentscope-cli"]);
    const pending = ["agentscope-cli"];
    while (pending.length > 0) {
      const project = pending.pop();
      for (const { target } of nxGraph.dependencies[project] ?? []) {
        if (closure.has(target)) continue;
        closure.add(target);
        pending.push(target);
      }
    }
    const nodes = Object.values(nxGraph.nodes).sort(
      (left, right) => right.data.root.length - left.data.root.length,
    );
    for (const path of manifest.irrelevantPaths) {
      const owner = nodes.find(
        ({ data }) => path === data.root || path.startsWith(`${data.root}/`),
      );
      if (owner !== undefined)
        assert.equal(closure.has(owner.name), false, path);
    }
  }, 5_000);

  test("content and new authority paths retain fail-closed selection", () => {
    const { trackedEntries } = captured;
    assert.doesNotThrow(() =>
      validateNativeCiPolicy(
        manifest,
        trackedEntries.map((entry) =>
          entry.path === "apps/cli/src/program.ts"
            ? { ...entry, objectId: "f".repeat(40) }
            : entry,
        ),
      ),
    );
    const path = "apps/cli/src/new-command.ts";
    const entries = [
      ...trackedEntries,
      { mode: "100644", objectId: "e".repeat(40), path },
    ].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    assert.ok(
      validateNativeCiPolicy(manifest, entries).authorityFiles.includes(path),
    );
    assert.equal(
      selectNativeCertification("pull_request", [path]).required,
      true,
    );
  }, 5_000);

  registerTrackedAuthorityTests();
});

function registerTrackedAuthorityTests() {
  test("every workflow and script rejects self-authorized exclusion", () => {
    for (const { path } of captured.trackedEntries.filter(
      ({ path }) =>
        path.startsWith(".github/workflows/") || path.startsWith("scripts/"),
    )) {
      assert.throws(
        () =>
          validateNativeCiPolicy(
            {
              ...manifest,
              irrelevantPaths: [...manifest.irrelevantPaths, path].sort(),
            },
            captured.trackedEntries,
          ),
        /native-ci-policy-invalid/u,
        path,
      );
      assert.equal(
        selectNativeCertification("pull_request", [path]).required,
        true,
        path,
      );
    }
  }, 5_000);

  test("every original policy authority rejects mode substitution", () => {
    for (const path of [
      ".github/workflows/pr-validation.yml",
      ".github/workflows/release-candidate-rehearsal.yml",
      "scripts/__tests__/native-ci-policy.test.mjs",
      "scripts/native-ci-irrelevant-paths.json",
      "scripts/native-ci-selection.mjs",
      "scripts/workspace-policy-runner.mjs",
    ])
      for (const mode of ["100755", "120000", "160000"])
        assert.throws(
          () =>
            validateNativeCiPolicy(
              manifest,
              captured.trackedEntries.map((entry) =>
                entry.path === path ? { ...entry, mode } : entry,
              ),
            ),
          /native-ci-policy-invalid/u,
          `${path}:${mode}`,
        );
  }, 5_000);
}

test.each(["", "{", "null", "{}", '{"graph":{"nodes":{},"dependencies":{}}}'])(
  "closed graph decoding rejects malformed or incomplete %s",
  (value) => {
    assert.throws(() => decodeNativeCiGraph(Buffer.from(value)));
  },
);
test("closed graph decoding rejects oversized bytes before parse", () => {
  assert.throws(
    () => decodeNativeCiGraph(Buffer.alloc(1024 * 1024 + 1)),
    /native-ci.fixture.graph/u,
  );
});

test.each([
  ["overflow", "nx-cache.fixture.command-terminal"],
  ["hang", "nx-cache.fixture.deadline"],
  ["descendant", "nx-cache.fixture.command-terminal"],
  ["malformed", "native-ci.fixture.graph"],
])(
  "real-process closure preparation rejects and joins %s",
  async (seed, expected) => {
    await assert.rejects(captureNativeCiClosure("graph", seed), (error) => {
      assert.ok(error.message.startsWith("native-ci.fixture.failure "));
      assert.equal(error.cause.message, expected);
      assert.match(error.message, /operation=graph/u);
      return true;
    });
  },
  5_000,
);
test("preparation rejects unknown command and seed before root creation", async () => {
  await assert.rejects(captureNativeCiClosure("arbitrary"), /fixture.phase/u);
  await assert.rejects(
    captureNativeCiClosure("graph", "arbitrary"),
    /fixture.seed/u,
  );
  await assert.rejects(
    captureNativeCiClosure("tracked", "hang"),
    /fixture.seed/u,
  );
});

test.each(["bind", "identity"])(
  "post-creation %s failure preserves primary and quarantined root",
  async (phase) => {
    const source = readFileSync(
      join(root, "scripts/fixtures/native-ci-closure-process.mjs"),
      "utf8",
    );
    const body = source
      .slice(source.indexOf("export async function captureNativeCiClosure"))
      .replace("export async function", "async function");
    const primary = new Error("synthetic.setup");
    let created = 0;
    let cleaned = 0;
    const capture = new Function(
      "mkdtempSync",
      "lstatSync",
      "bindNxCacheFixture",
      "cleanupNxCacheFixture",
      "assertNativeCiSeed",
      "performance",
      "join",
      "tmpdir",
      "projectNativeCiClosureFailure",
      `${body}; return captureNativeCiClosure;`,
    )(
      () => {
        created += 1;
        return "/synthetic/exact-root";
      },
      () => {
        if (phase === "identity") throw primary;
        return { dev: 11, ino: 22 };
      },
      () => {
        throw primary;
      },
      () => {
        cleaned += 1;
      },
      () => {},
      { now: () => 0 },
      join,
      () => "/synthetic",
      projectNativeCiClosureFailure,
    );
    await assert.rejects(capture("tracked"), (error) => {
      assert.match(
        error.message,
        /^native-ci.fixture.quarantined operation=tracked stage=setup /u,
      );
      assert.equal(error.errors[0], primary);
      assert.equal(
        error.errors[1].message,
        "native-ci.fixture.setup-quarantined",
      );
      assert.deepEqual(error.errors[1].cause, {
        path: "/synthetic/exact-root",
        dev: phase === "identity" ? null : 11,
        ino: phase === "identity" ? null : 22,
      });
      return true;
    });
    assert.equal(created, 1);
    assert.equal(cleaned, 0);
  },
);

test("captured output rejects noncanonical and over-budget frames", () => {
  for (const value of [
    null,
    {},
    "!",
    "YQ",
    Buffer.alloc(1024 * 1024 + 1).toString("base64"),
  ])
    assert.throws(() => decodeNativeCapturedOutput(value), /fixture.output/u);
  assert.deepEqual(decodeNativeCapturedOutput("YQ=="), Buffer.from("a"));
});

test.each(["late", "substituted", "duplicate"])(
  "native readiness rejects %s without another child admission",
  (kind) => {
    const child = new EventEmitter();
    const sends = [];
    const errors = [];
    let stopped = false;
    child.send = (message) => {
      sends.push(message);
    };
    bindNxCacheMessagesForTesting(
      child,
      {
        cutoff: performance.now() + (kind === "late" ? -1 : 1_000),
        deadline: performance.now() + 5_000,
        nonce: "exact",
        leader: { pid: 1 },
        runtime: "native-closure",
        result: {},
        progress: {},
        arguments: ["graph", "--file=stdout"],
      },
      () => stopped,
      (error) => errors.push(error),
      () => {
        stopped = true;
      },
    );
    child.emit("message", {
      kind: "ready",
      nonce: kind === "substituted" ? "foreign" : "exact",
    });
    if (kind === "duplicate")
      child.emit("message", { kind: "ready", nonce: "exact" });
    assert.equal(sends.length, kind === "duplicate" ? 1 : 0);
    assert.equal(errors.length, 1);
    assert.equal(stopped, true);
  },
);
