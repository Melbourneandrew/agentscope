import { lstatSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder, types } from "node:util";
import {
  bindNxCacheFixture,
  assertNativeCiSeed,
  cleanupNxCacheFixture,
  runNxCacheCommand,
} from "./nx-cache-process.mjs";
import { parseTrackedEntries } from "../native-ci-selection.mjs";

export function decodeNativeCiGraph(output) {
  if (!Buffer.isBuffer(output) || output.length > 1024 * 1024)
    throw new Error("native-ci.fixture.graph");
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(output),
    );
  } catch {
    value = undefined;
  }
  const graph = value?.graph;
  if (
    graph === null ||
    typeof graph !== "object" ||
    graph.nodes === null ||
    typeof graph.nodes !== "object" ||
    graph.dependencies === null ||
    typeof graph.dependencies !== "object" ||
    !Object.hasOwn(graph.nodes, "agentscope-cli")
  )
    throw new Error("native-ci.fixture.graph");
  for (const [name, node] of Object.entries(graph.nodes)) {
    if (node?.name !== name || typeof node.data?.root !== "string")
      throw new Error("native-ci.fixture.graph");
    if (!Array.isArray(graph.dependencies[name]))
      throw new Error("native-ci.fixture.graph");
    for (const edge of graph.dependencies[name])
      if (
        edge?.source !== name ||
        typeof edge.target !== "string" ||
        (!Object.hasOwn(graph.nodes, edge.target) &&
          !Object.hasOwn(graph.externalNodes ?? {}, edge.target))
      )
        throw new Error("native-ci.fixture.graph");
  }
  return graph;
}

// A failure projection only: never reads arbitrary error text or executes getters.
export function projectNativeCiClosureFailure(input) {
  const own = (value, name) => {
    if (value === null || typeof value !== "object" || types.isProxy(value))
      return undefined;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
    } catch {
      return undefined;
    }
  };
  const inspect = (error) => {
    let code = "unknown";
    let phase = "unknown";
    for (let depth = 0; depth < 3; depth += 1) {
      const message = own(error, "message");
      for (const candidate of [
        "deadline",
        "cleanup-deadline",
        "root-authority",
        "root-substitution",
        "birth",
        "spawn",
        "join-uncertain",
        "command-terminal",
        "group-inventory",
        "identity-loss",
        "wrapper-exit",
        "message",
        "output",
        "environment",
        "active",
        "quarantined",
        "inspection-deadline",
        "command",
        "seed",
      ])
        if (code === "unknown" && message === `nx-cache.fixture.${candidate}`)
          code = candidate;
      if (code === "unknown" && message === "native-ci.fixture.graph")
        code = "graph";
      const cause = own(error, "cause");
      const observed = own(cause, "phase");
      if (
        ["wrapper-startup", "nx-command", "terminal-inspection"].includes(
          observed,
        )
      )
        phase = observed;
      error = cause;
    }
    return { code, phase };
  };
  const primary = inspect(input.primary);
  const cleanup = inspect(input.cleanup);
  const stages = {
    "wrapper-startup": "start",
    "nx-command": "work",
    "terminal-inspection": "settlement",
  };
  const stage = stages[primary.phase] ?? input.stage;
  const elapsed = Math.floor(input.now - input.entered);
  return `operation=${["tracked", "graph"].includes(input.operation) ? input.operation : "unknown"} stage=${["setup", "start", "work", "settlement"].includes(stage) ? stage : "unknown"} inner_phase=${primary.phase} elapsed_ms=${Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= 2_147_483_647 ? elapsed : "unknown"} budget_ms=5000 teardown_reserve_ms=1500 primary=${primary.code} cleanup=${cleanup.code}`;
}

// Independent inventory and graph propositions retain a five-second ceiling.
// Each phase has one creation-to-cleanup authority, never a per-child reset.
export async function captureNativeCiClosure(phase, seed = "real") {
  if (!["tracked", "graph"].includes(phase))
    throw new Error("native-ci.fixture.phase");
  assertNativeCiSeed(seed);
  if (phase === "tracked" && seed !== "real")
    throw new Error("native-ci.fixture.seed");
  const report = (kind, projection) => {
    const message = `native-ci.fixture.${kind} ${projection}`;
    try {
      process.stderr.write(`${message}\n`);
    } catch {
      // Diagnostic delivery never changes the original failure or retirement.
    }
    return message;
  };
  const entered = performance.now();
  const deadline = entered + 5_000;
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "agentscope-native-closure-"));
  } catch (primary) {
    throw new Error(
      report(
        "failure",
        projectNativeCiClosureFailure({
          operation: phase,
          stage: "setup",
          entered,
          now: performance.now(),
          primary,
        }),
      ),
      { cause: primary },
    );
  }
  let identity;
  let authority;
  let primary;
  let result;
  let stage = "setup";
  const diagnostic = (cleanup) =>
    projectNativeCiClosureFailure({
      operation: phase,
      stage,
      entered,
      now: performance.now(),
      primary,
      cleanup,
    });
  try {
    identity = lstatSync(root);
    authority = bindNxCacheFixture(root, deadline);
    const environment = {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: authority.path,
      LANG: "C.UTF-8",
      CACHE_RUNTIME: "native-closure",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      NX_DAEMON: "false",
      NX_ISOLATE_PLUGINS: "false",
      NX_NO_CLOUD: "true",
      NX_LOAD_DOT_ENV_FILES: "false",
      NX_CACHE_PROJECT_GRAPH: "false",
      NX_NATIVE_FILE_CACHE_DIRECTORY: join(authority.path, "native-cache"),
      NX_WORKSPACE_DATA_DIRECTORY: join(authority.path, "workspace-data"),
      NX_CACHE_DIRECTORY: join(authority.path, "cache"),
      NATIVE_CI_GRAPH_SEED: seed,
    };
    stage = "start";
    const output = await runNxCacheCommand(
      authority,
      phase === "tracked" ? ["tracked"] : ["graph", "--file=stdout"],
      environment,
    );
    stage = "work";
    result =
      phase === "tracked"
        ? { trackedEntries: parseTrackedEntries(output) }
        : { graph: decodeNativeCiGraph(output) };
  } catch (error) {
    primary = error;
  }
  try {
    if (authority === undefined)
      throw new Error("native-ci.fixture.setup-quarantined", {
        cause: {
          path: root,
          dev: identity?.dev ?? null,
          ino: identity?.ino ?? null,
        },
      });
    cleanupNxCacheFixture(authority);
  } catch (error) {
    if (primary === undefined) stage = "settlement";
    throw new AggregateError(
      primary === undefined ? [error] : [primary, error],
      report("quarantined", diagnostic(error)),
      { cause: error },
    );
  }
  if (primary !== undefined)
    throw new Error(report("failure", diagnostic(undefined)), {
      cause: primary,
    });
  return result;
}
