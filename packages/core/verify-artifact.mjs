import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { invokeRedactedTraceSink } from "../destinations/core/dist/lifecycle-sink.js";
import { runFailOpenTraceLifecycle } from "./dist/index.js";
import { REDACTION_POLICY_IDENTITIES } from "./dist/redaction/policy.js";
import { isRedactedCanonicalTrace } from "../protocol/dist/index.js";

const invocation = {
  harnessRegistryId: "codex",
  harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
  snapshot: {
    configurationIdentity: "config.v1",
    policyIdentity: REDACTION_POLICY_IDENTITIES.baseline,
    redactionPolicy: { version: 1, mode: "baseline" },
  },
  hookObservedUnixNano: "10",
  operationIdScope: "session-global",
};
const candidate = {
  captureBoundary: {
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: "artifact-thread",
    },
    boundaryKind: "turn",
    boundaryId: "artifact-turn",
    generation: 0,
    positionKind: "event-index",
    exclusiveEndPosition: 1,
  },
  rootContext: { fields: [], unavailable: [] },
  operations: [
    {
      logicalKey: "root",
      locator: { kind: "source-ordinal", ordinal: 0 },
      kind: "AGENT",
      name: "agent-operation",
      nameProvenance: { field: "span.name", source: "native-artifact" },
      timing: {
        basis: "native-interval",
        nativeState: "observed",
        source: "native-artifact",
        startUnixNano: "1",
        endUnixNano: "20",
      },
      fields: [],
      unavailable: [],
      events: [],
      links: [],
    },
  ],
};

const verifyRuntime = (run, guard, invoke) => {
  let trace;
  const result = run({
    invocation,
    capture: (factory) => factory.capture(candidate),
    sink(value) {
      trace = value;
      return undefined;
    },
  });
  if (
    result.outcome !== "sink-returned" ||
    !guard(trace) ||
    invoke(() => undefined, structuredClone(trace)) !== "rejected" ||
    invoke(() => undefined, {}) !== "rejected"
  )
    throw new Error("Core lifecycle artifact registry verification failed.");
};

verifyRuntime(
  runFailOpenTraceLifecycle,
  isRedactedCanonicalTrace,
  invokeRedactedTraceSink,
);
const unhandled = [];
const collectUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", collectUnhandled);
try {
  const asyncMisuse = runFailOpenTraceLifecycle({
    invocation,
    capture: async () => {
      throw new Error("CANARY_SECRET");
    },
    sink: () => undefined,
  });
  if (asyncMisuse.outcome !== "failed-open" || asyncMisuse.stage !== "capture")
    throw new Error("Async capture misuse did not fail open.");
  await Promise.resolve();
  await Promise.resolve();
  if (unhandled.length !== 0)
    throw new Error("Async capture misuse was not safely observed.");
} finally {
  process.off("unhandledRejection", collectUnhandled);
}

const directory = mkdtempSync(join(tmpdir(), "agentscope-core-artifact-"));
const entry = join(directory, "entry.mjs");
const output = join(directory, "bundle.mjs");
try {
  writeFileSync(
    entry,
    [
      `import { runFailOpenTraceLifecycle } from ${JSON.stringify(resolve(import.meta.dirname, "dist/index.js"))};`,
      `import { REDACTION_POLICY_IDENTITIES } from ${JSON.stringify(resolve(import.meta.dirname, "dist/redaction/policy.js"))};`,
      `import { invokeRedactedTraceSink } from ${JSON.stringify(resolve(import.meta.dirname, "../destinations/core/dist/lifecycle-sink.js"))};`,
      `import { isRedactedCanonicalTrace } from ${JSON.stringify(resolve(import.meta.dirname, "../protocol/dist/index.js"))};`,
      `const invocation = ${JSON.stringify(invocation)};`,
      "invocation.snapshot.policyIdentity = REDACTION_POLICY_IDENTITIES.baseline;",
      `const candidate = ${JSON.stringify(candidate)};`,
      "export const verify = () => {",
      "  let trace;",
      "  const result = runFailOpenTraceLifecycle({ invocation, capture: (factory) => factory.capture(candidate), sink(value) { trace = value; return undefined; } });",
      "  return result.outcome === 'sink-returned' && isRedactedCanonicalTrace(trace) && invokeRedactedTraceSink(() => undefined, structuredClone(trace)) === 'rejected' && invokeRedactedTraceSink(() => undefined, {}) === 'rejected';",
      "};",
    ].join("\n"),
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
  });
  const bundled = await import(`${pathToFileURL(output).href}?artifact=1`);
  if (bundled.verify() !== true)
    throw new Error("Bundled lifecycle registry verification failed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(
  "Verified Core lifecycle dist and esbuild registry interop.\n",
);
