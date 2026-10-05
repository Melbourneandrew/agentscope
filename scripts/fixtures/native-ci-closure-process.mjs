import { lstatSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
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

// Independent inventory and graph propositions retain a five-second ceiling.
// Each phase has one creation-to-cleanup authority, never a per-child reset.
export async function captureNativeCiClosure(phase, seed = "real") {
  if (!["tracked", "graph"].includes(phase))
    throw new Error("native-ci.fixture.phase");
  assertNativeCiSeed(seed);
  if (phase === "tracked" && seed !== "real")
    throw new Error("native-ci.fixture.seed");
  const deadline = performance.now() + 5_000;
  const root = mkdtempSync(join(tmpdir(), "agentscope-native-closure-"));
  let identity;
  let authority;
  let primary;
  let result;
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
    const output = await runNxCacheCommand(
      authority,
      phase === "tracked" ? ["tracked"] : ["graph", "--file=stdout"],
      environment,
    );
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
    throw new AggregateError(
      primary === undefined ? [error] : [primary, error],
      "native-ci.fixture.quarantined",
      { cause: error },
    );
  }
  if (primary !== undefined) throw primary;
  return result;
}
