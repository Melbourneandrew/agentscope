import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { finalizeRedactedCanonicalTrace } from "./dist/core-finalization.js";
import {
  deriveIdentityBundle,
  encodeOtlpJson,
  encodeOtlpProtobuf,
  isRedactedCanonicalTrace,
  readExternalOtlpJson,
  readExternalOtlpProtobuf,
  readPersistedCanonicalEnvelope,
  serializeRedactedCanonicalTrace,
  standardsManifest,
} from "./dist/index.js";
import { createSanitizedCanonicalTraceFixture } from "./dist/testing.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./src/testing/fixtures/sanitized-canonical-trace.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (
  JSON.stringify(createSanitizedCanonicalTraceFixture()) !==
  JSON.stringify(fixture)
)
  throw new Error("Protocol testing fixture export drifted.");
const identityInput = {
  harnessRegistryId: "codex",
  session: {
    kind: "native-session",
    nativeIdentityKind: "thread",
    nativeIdentity: "artifact-session",
  },
  boundary: {
    kind: "turn",
    id: "artifact-boundary",
    generation: 1,
    positionKind: "event-index",
    exclusiveEndPosition: 3,
  },
  operationIdScope: "session-global",
  operations: [
    { logicalKey: "root", locator: { kind: "source-ordinal", ordinal: 0 } },
    {
      logicalKey: "model",
      parentLogicalKey: "root",
      locator: { kind: "native-operation", nativeId: "model-1" },
    },
    {
      logicalKey: "tool",
      parentLogicalKey: "root",
      locator: { kind: "native-operation", nativeId: "tool-1" },
    },
  ],
};
const alignGraph = (raw, bundle) => {
  const graph = structuredClone(raw);
  const spans = graph.resourceSpans[0].scopeSpans[0].spans;
  for (const span of spans) span.traceId = bundle.traceId;
  spans[0].spanId = bundle.spans.root;
  spans[1].spanId = bundle.spans.model;
  spans[1].parentSpanId = bundle.spans.root;
  spans[2].spanId = bundle.spans.tool;
  spans[2].parentSpanId = bundle.spans.root;
  spans[0].logicalOperationKey = "root";
  spans[1].logicalOperationKey = "model";
  spans[2].logicalOperationKey = "tool";
  for (const span of spans) {
    const attribute = span.attributes.find(
      ({ key }) => key === "agentscope.mapping.provenance",
    );
    const ledger = JSON.parse(attribute.value.stringValue);
    for (const entry of ledger) {
      if (
        entry.field === "span.trace_id" ||
        entry.field === "span.span_id" ||
        entry.field === "span.parent_span_id"
      )
        entry.source = "derived";
    }
    attribute.value.stringValue = JSON.stringify(ledger);
  }
  return graph;
};
const identityBundle = deriveIdentityBundle(identityInput);
const input = {
  identityBundle,
  graph: alignGraph(fixture, identityBundle),
};
const direct = finalizeRedactedCanonicalTrace(input);
const directJson = encodeOtlpJson(direct);
const directProtobuf = encodeOtlpProtobuf(direct);
const directJsonRead = readExternalOtlpJson(directJson);
const directProtobufRead = readExternalOtlpProtobuf(directProtobuf);
const directPersistedRead = readPersistedCanonicalEnvelope(
  serializeRedactedCanonicalTrace(direct),
);
if (
  !isRedactedCanonicalTrace(direct) ||
  JSON.parse(serializeRedactedCanonicalTrace(direct)).envelopeVersion !== 1 ||
  !directJsonRead.ok ||
  !directProtobufRead.ok ||
  !directPersistedRead.ok ||
  isRedactedCanonicalTrace(directJsonRead.batch.units[0]?.graph) ||
  isRedactedCanonicalTrace(directProtobufRead.batch.units[0]?.graph) ||
  isRedactedCanonicalTrace(directPersistedRead.envelope)
) {
  throw new Error("Protocol dist codec or brand boundary is invalid.");
}

const directory = mkdtempSync(join(tmpdir(), "agentscope-protocol-artifact-"));
const entry = join(directory, "entry.mjs");
const output = join(directory, "bundle.mjs");
try {
  writeFileSync(
    entry,
    [
      `import { encodeOtlpJson, encodeOtlpProtobuf, isRedactedCanonicalTrace, readExternalOtlpJson, readExternalOtlpProtobuf, readPersistedCanonicalEnvelope, serializeRedactedCanonicalTrace } from ${JSON.stringify(resolve(import.meta.dirname, "dist/index.js"))};`,
      `import { deriveIdentityBundle } from ${JSON.stringify(resolve(import.meta.dirname, "dist/index.js"))};`,
      `import { finalizeRedactedCanonicalTrace } from ${JSON.stringify(resolve(import.meta.dirname, "dist/core-finalization.js"))};`,
      "const alignGraph = (raw, bundle) => {",
      "  const graph = structuredClone(raw);",
      "  const spans = graph.resourceSpans[0].scopeSpans[0].spans;",
      "  for (const span of spans) span.traceId = bundle.traceId;",
      "  spans[0].spanId = bundle.spans.root;",
      "  spans[1].spanId = bundle.spans.model;",
      "  spans[1].parentSpanId = bundle.spans.root;",
      "  spans[2].spanId = bundle.spans.tool;",
      "  spans[2].parentSpanId = bundle.spans.root;",
      "  spans[0].logicalOperationKey = 'root';",
      "  spans[1].logicalOperationKey = 'model';",
      "  spans[2].logicalOperationKey = 'tool';",
      "  for (const span of spans) {",
      "    const attribute = span.attributes.find(({ key }) => key === 'agentscope.mapping.provenance');",
      "    const ledger = JSON.parse(attribute.value.stringValue);",
      "    for (const entry of ledger) {",
      "      if (entry.field === 'span.trace_id' || entry.field === 'span.span_id' || entry.field === 'span.parent_span_id') entry.source = 'derived';",
      "    }",
      "    attribute.value.stringValue = JSON.stringify(ledger);",
      "  }",
      "  return graph;",
      "};",
      "export const verify = (identityInput, graph) => {",
      "  const identityBundle = deriveIdentityBundle(identityInput);",
      "  const value = finalizeRedactedCanonicalTrace({ identityBundle, graph: alignGraph(graph, identityBundle) });",
      "  const serialized = serializeRedactedCanonicalTrace(value);",
      "  const jsonRead = readExternalOtlpJson(encodeOtlpJson(value));",
      "  const protobufRead = readExternalOtlpProtobuf(encodeOtlpProtobuf(value));",
      "  const persistedRead = readPersistedCanonicalEnvelope(serialized);",
      "  return { branded: isRedactedCanonicalTrace(value), decodedBranded: jsonRead.ok && isRedactedCanonicalTrace(jsonRead.batch.units[0]?.graph), protobufBranded: protobufRead.ok && isRedactedCanonicalTrace(protobufRead.batch.units[0]?.graph), persistedBranded: persistedRead.ok && isRedactedCanonicalTrace(persistedRead.envelope), serialized };",
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
  const result = bundled.verify(identityInput, fixture);
  if (
    result.branded !== true ||
    result.decodedBranded !== false ||
    result.protobufBranded !== false ||
    result.persistedBranded !== false ||
    JSON.parse(result.serialized).protocolManifestId !==
      standardsManifest.manifestId
  ) {
    throw new Error("Bundled Protocol entrypoints do not share the registry.");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write("Verified Protocol dist and esbuild registry interop.\n");
