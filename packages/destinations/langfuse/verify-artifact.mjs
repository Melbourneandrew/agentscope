import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createTraceLocator,
  isDestinationDescriptor,
  parseDestinationSettings,
} from "@agentscope/destinations-core";

const packageRoot = new URL(".", import.meta.url);
const sourceRoot = new URL("./src/", packageRoot);
const distRoot = new URL("./dist/", packageRoot);

const regularFiles = (rootUrl) => {
  const rootPath = fileURLToPath(rootUrl);
  const files = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        throw new Error(`Artifact contains a symlink: ${path}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) files.push(relative(rootPath, path));
      else throw new Error(`Artifact contains a nonregular entry: ${path}`);
    }
  }
  return files.sort();
};

const sourceFiles = regularFiles(sourceRoot).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
);
const expectedDist = sourceFiles
  .flatMap((file) => [
    file.replace(/\.ts$/u, ".d.ts"),
    file.replace(/\.ts$/u, ".js"),
  ])
  .sort();
const actualDist = regularFiles(distRoot);
if (JSON.stringify(actualDist) !== JSON.stringify(expectedDist))
  throw new Error("Langfuse dist is not an exact production-source artifact.");
if (actualDist.some((file) => file.includes(".test.")))
  throw new Error("Langfuse dist contains compiled tests.");

const snapshotDist = (files, rootPath) => {
  const hash = createHash("sha256");
  hash.update("agentscope-langfuse-dist-v1\0", "utf8");
  let totalBytes = 0;
  const snapshots = [];
  for (const file of files) {
    const name = Buffer.from(file, "utf8");
    const path = resolve(rootPath, file);
    const descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let bytes;
    try {
      const metadata = fstatSync(descriptor);
      if (
        !metadata.isFile() ||
        metadata.size < 1 ||
        totalBytes + metadata.size > 16 * 1024 * 1024
      )
        throw new Error("Langfuse dist exceeds the verifier byte ceiling.");
      bytes = Buffer.alloc(metadata.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const read = readSync(
          descriptor,
          bytes,
          offset,
          bytes.byteLength - offset,
          null,
        );
        if (read === 0) break;
        offset += read;
      }
      const overflow = Buffer.alloc(1);
      if (offset !== metadata.size || readSync(descriptor, overflow) !== 0)
        throw new Error("Langfuse dist changed while it was snapshotted.");
      totalBytes += bytes.byteLength;
    } finally {
      closeSync(descriptor);
    }
    const framing = Buffer.alloc(16);
    framing.writeBigUInt64BE(BigInt(name.byteLength), 0);
    framing.writeBigUInt64BE(BigInt(bytes.byteLength), 8);
    hash.update(framing);
    hash.update(name);
    hash.update(bytes);
    snapshots.push(Object.freeze({ file, bytes }));
  }
  return Object.freeze({
    digest: `sha256-${hash.digest("hex")}`,
    files: Object.freeze(snapshots),
  });
};

const distSnapshot = snapshotDist(actualDist, fileURLToPath(distRoot));
const candidateArtifactDigest = distSnapshot.digest;
const privateCandidateRoot = mkdtempSync(
  resolve(fileURLToPath(packageRoot), ".langfuse-artifact-verifier-"),
);
process.once("exit", () => rmSync(privateCandidateRoot, { recursive: true }));
for (const snapshot of distSnapshot.files) {
  const target = resolve(privateCandidateRoot, snapshot.file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, snapshot.bytes, { flag: "wx", mode: 0o400 });
}
const privateCandidateUrl = pathToFileURL(`${privateCandidateRoot}${sep}`);
const [root, reporter, retriever, testing] = await Promise.all([
  import(new URL("./index.js", privateCandidateUrl).href),
  import(new URL("./reporter/index.js", privateCandidateUrl).href),
  import(new URL("./retriever/public.js", privateCandidateUrl).href),
  import(new URL("./testing.js", privateCandidateUrl).href),
]);

const rootKeys = Object.keys(root).sort();
if (
  JSON.stringify(rootKeys) !==
  JSON.stringify(
    [
      "LANGFUSE_COMPATIBILITY_MANIFEST",
      "createLangfuseReachabilityProbe",
      "langfuseDestinationDescriptor",
      "langfuseDestinationPackageId",
      "langfuseReporterPackageId",
      "langfuseRetrieverPackageId",
    ].sort(),
  )
)
  throw new Error("Langfuse root export surface drifted.");
if (
  JSON.stringify(Object.keys(reporter).sort()) !==
  JSON.stringify(
    ["langfuseDestinationDescriptor", "langfuseReporterPackageId"].sort(),
  )
)
  throw new Error("Langfuse Reporter export surface drifted.");
if (
  JSON.stringify(Object.keys(retriever).sort()) !==
  JSON.stringify(["langfuseRetrieverPackageId"])
)
  throw new Error("Langfuse Retriever export surface drifted.");
if (
  JSON.stringify(Object.keys(testing).sort()) !==
  JSON.stringify(
    [
      "LANGFUSE_FILTER_CONFORMANCE_FIXTURES",
      "LANGFUSE_SANITIZED_HTTP_FIXTURES",
      "createLangfuseDestinationTestAdapter",
      "createLangfuseReachabilityProbeTestHarness",
      "executeLangfuseMockRoundTrip",
      "createLangfuseReporterTestHarness",
      "createLangfuseRetrieverTestHarness",
    ].sort(),
  )
)
  throw new Error("Langfuse testing export surface drifted.");

const doctorRequests = [];
const doctorHarness = testing.createLangfuseReachabilityProbeTestHarness(
  async (request) => {
    doctorRequests.push(request);
    return {
      status: 405,
      headers: { "x-canary": "CANARY_PROVIDER" },
      body: new TextEncoder().encode("CANARY_TRACE_CONTENT"),
    };
  },
);
const doctorState = await doctorHarness.probe.inspect({
  configurationGeneration: 1,
  configurationIdentity: `sha256-${"a".repeat(64)}`,
  connectionId: doctorHarness.connectionId,
  signal: new AbortController().signal,
});
if (
  doctorState !== "available" ||
  doctorRequests.length !== 1 ||
  doctorRequests[0].method !== "GET" ||
  doctorRequests[0].body !== undefined ||
  Object.keys(doctorRequests[0].headers).length !== 0
)
  throw new Error("Langfuse built Doctor probe drifted.");

const mockResult = await testing.executeLangfuseMockRoundTrip({
  runId: candidateArtifactDigest.slice("sha256-".length, "sha256-".length + 16),
  visibilityDelayAttempts: 1,
});
const mockEvidence = Object.freeze({
  evidenceVersion: 1,
  candidateArtifactDigest,
  ...mockResult,
});
if (
  mockEvidence.outcome !== "passed" ||
  mockEvidence.visibilityAttempts !== 2 ||
  mockEvidence.candidateArtifactDigest !== candidateArtifactDigest ||
  JSON.stringify(mockEvidence).includes("fixture") ||
  JSON.stringify(mockEvidence).includes("traceId")
)
  throw new Error("Langfuse built mock evidence drifted.");
if (
  !isDestinationDescriptor(root.langfuseDestinationDescriptor) ||
  root.langfuseDestinationDescriptor.deliveryIdentitySupport !==
    "duplicates-possible" ||
  root.langfuseDestinationDescriptor.retrievalSupport !== "search-and-get" ||
  JSON.stringify(
    root.LANGFUSE_COMPATIBILITY_MANIFEST.projection.modelAttributeKeys,
  ) !==
    JSON.stringify([
      "llm.model_name",
      "embedding.model_name",
      "reranker.model_name",
    ]) ||
  root.LANGFUSE_COMPATIBILITY_MANIFEST.manifestId !==
    "sha256:3ef86febf50fa98c3e8c574db77dbafec4f001c6689e1fc249a2332b2fe8f369"
)
  throw new Error("Langfuse built descriptor or manifest identity is invalid.");
try {
  parseDestinationSettings(root.langfuseDestinationDescriptor, {
    unknown: true,
  });
  throw new Error("Langfuse built descriptor accepted an unknown setting.");
} catch (error) {
  if (error?.code !== "destination.descriptor.invalid") throw error;
}

const requests = [];
const builtReporter = testing.createLangfuseReporterTestHarness({
  executor: async (request) => {
    requests.push(request);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
    };
  },
});
const result = await builtReporter.report({
  trace: {
    sequence: 7,
    sessionId: "artifact-session",
    tags: ["artifact-tag"],
    modelName: "artifact-model",
  },
});
const request = requests[0];
const body = JSON.parse(new TextDecoder().decode(request?.body));
const rootSpan = body.resourceSpans[0].scopeSpans[0].spans.find(
  (span) => span.parentSpanId === undefined,
);
const attributes = new Map(
  rootSpan.attributes.map((entry) => [entry.key, entry.value]),
);
const capsuleResources = body.resourceSpans.filter((resource) =>
  resource.scopeSpans.some(
    (scope) => scope.scope?.name === "@agentscope/destination-langfuse/capsule",
  ),
);
const capsuleHeader = capsuleResources
  .flatMap((resource) => resource.scopeSpans)
  .flatMap((scope) => scope.spans)
  .find((span) => span.name === "agentscope.capsule.header.v1");
const capsuleAttributes = new Map(
  capsuleHeader.attributes.map((entry) => [entry.key, entry.value]),
);
if (
  result.outcome !== "accepted" ||
  requests.length !== 1 ||
  request.url !== "http://127.0.0.1:4318/api/public/otel/v1/traces" ||
  request.headers.authorization !==
    `Basic ${Buffer.from("pk-fixture:sk-fixture", "utf8").toString("base64")}` ||
  request.headers["x-langfuse-ingestion-version"] !== "4" ||
  capsuleResources.length !== 1 ||
  JSON.stringify(
    capsuleResources[0].resource.attributes.map(({ key }) => key),
  ) !== JSON.stringify(["agentscope.protocol.manifest_id", "service.name"]) ||
  attributes.get("agentscope.harness.name")?.stringValue !==
    "fixture-harness" ||
  capsuleAttributes.get("langfuse.observation.metadata.agentscope_session")
    ?.stringValue !== "artifact-session" ||
  capsuleAttributes.get("langfuse.trace.tags")?.arrayValue?.values?.[0]
    ?.stringValue !== "agentscope:model:artifact-model"
)
  throw new Error("Langfuse built Reporter projection or transport drifted.");

const observationFor = (span) => ({
  id: span.spanId,
  traceId: span.traceId,
  parentObservationId: span.parentSpanId,
  type: "SPAN",
  isRootObservation: false,
  name: span.name,
  startTime: new Date(
    Number(BigInt(span.startTimeUnixNano) / 1_000_000n),
  ).toISOString(),
  endTime: new Date(
    Number(BigInt(span.endTimeUnixNano) / 1_000_000n),
  ).toISOString(),
  metadata: Object.fromEntries(
    (span.attributes ?? [])
      .filter((attribute) =>
        attribute.key.startsWith("langfuse.observation.metadata."),
      )
      .map((attribute) => [
        attribute.key.slice("langfuse.observation.metadata.".length),
        attribute.value.stringValue ??
          attribute.value.arrayValue.values.map((entry) => entry.stringValue),
      ]),
  ),
});
const artifactSpans = body.resourceSpans.flatMap((resource) =>
  resource.scopeSpans.flatMap((scope) => scope.spans),
);
const artifactHeaders = artifactSpans
  .filter((span) => span.name === "agentscope.capsule.header.v1")
  .map(observationFor);
const artifactCarriers = artifactSpans
  .filter((span) => span.name === "agentscope.capsule.carrier.v1")
  .map(observationFor);
const retrievalRequests = [];
const builtRetriever = testing.createLangfuseRetrieverTestHarness({
  executor: async (providerRequest) => {
    retrievalRequests.push(providerRequest);
    const filter =
      new URL(providerRequest.url).searchParams.get("filter") ?? "";
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: new TextEncoder().encode(
        JSON.stringify({
          data: filter.includes("agentscope.capsule.carrier.v1")
            ? artifactCarriers
            : artifactHeaders,
          meta: {},
        }),
      ),
    };
  },
});
const search = await builtRetriever.search({ harness: "fixture-harness" });
if (!search.ok || search.value.summaries.length !== 1)
  throw new Error("Langfuse built Retriever search failed.");
const get = await builtRetriever.get(search.value.summaries[0].locator);
const carrierFilter = JSON.parse(
  new URL(retrievalRequests[2].url).searchParams.get("filter") ?? "[]",
);
const artifactDigest =
  artifactHeaders[0].metadata.agentscope_capsule_graph_sha256;
if (
  !get.ok ||
  get.value.representation.kind !== "canonical-graph" ||
  retrievalRequests.length !== 3 ||
  !carrierFilter.some(
    ({ key, value }) =>
      key === "agentscope_capsule_graph_sha256" && value === artifactDigest,
  ) ||
  !artifactCarriers.every(
    ({ metadata }) =>
      metadata.agentscope_capsule_graph_sha256 === artifactDigest,
  ) ||
  retrievalRequests.some(
    (entry) =>
      entry.headers.authorization !==
      `Basic ${Buffer.from("pk-fixture:sk-fixture", "utf8").toString("base64")}`,
  )
)
  throw new Error("Langfuse built Retriever round trip drifted.");

const requestsBeforeInvalidRevision = retrievalRequests.length;
const invalidRevisionResult = await builtRetriever.get(
  createTraceLocator({
    ...search.value.summaries[0].locator,
    destinationRevision: "CANARY-INVALID-REVISION",
  }),
);
if (
  invalidRevisionResult.ok ||
  invalidRevisionResult.code !== "invalid-query" ||
  retrievalRequests.length !== requestsBeforeInvalidRevision
)
  throw new Error(
    "Langfuse built Retriever performed I/O for an invalid revision.",
  );

const nonce = artifactHeaders[0].metadata.agentscope_capsule_nonce;
const duplicateHeaderJson = JSON.stringify({
  data: artifactHeaders,
  meta: {},
}).replace(
  `"agentscope_capsule_nonce":"${nonce}"`,
  `"agentscope_capsule_nonce":"${"0".repeat(32)}","agentscope_capsule_nonce":"${nonce}"`,
);
const duplicateRetriever = testing.createLangfuseRetrieverTestHarness({
  executor: async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(duplicateHeaderJson),
  }),
});
const duplicateResult = await duplicateRetriever.search();
if (duplicateResult.ok || duplicateResult.code !== "malformed-response")
  throw new Error("Langfuse built Retriever accepted duplicate JSON keys.");

const invalidHeader = {
  ...artifactHeaders[0],
  metadata: { ...artifactHeaders[0].metadata, agentscope_status: "future" },
};
const invalidHeaderRetriever = testing.createLangfuseRetrieverTestHarness({
  executor: async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(
      JSON.stringify({ data: [invalidHeader], meta: {} }),
    ),
  }),
});
const invalidHeaderResult = await invalidHeaderRetriever.get(
  search.value.summaries[0].locator,
);
if (invalidHeaderResult.ok || invalidHeaderResult.code !== "malformed-response")
  throw new Error("Langfuse built Retriever accepted an invalid exact header.");

const zeroNonce = "0".repeat(32);
const zeroNonceHeader = {
  ...artifactHeaders[0],
  id: createHash("sha256")
    .update(
      `agentscope:langfuse:capsule:v1:${artifactHeaders[0].traceId}:${zeroNonce}:header:0`,
    )
    .digest("hex")
    .slice(0, 16),
  metadata: {
    ...artifactHeaders[0].metadata,
    agentscope_capsule_nonce: zeroNonce,
  },
};
const zeroNonceRetriever = testing.createLangfuseRetrieverTestHarness({
  executor: async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(
      JSON.stringify({ data: [zeroNonceHeader], meta: {} }),
    ),
  }),
});
const zeroNonceResult = await zeroNonceRetriever.search();
if (zeroNonceResult.ok || zeroNonceResult.code !== "malformed-response")
  throw new Error("Langfuse built Retriever accepted an all-zero nonce.");

const invalidStructureRetriever = testing.createLangfuseRetrieverTestHarness({
  executor: async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(
      JSON.stringify({
        data: [{ ...artifactHeaders[0], type: "GENERATION" }],
        meta: {},
      }),
    ),
  }),
});
const invalidStructure = await invalidStructureRetriever.search();
if (invalidStructure.ok || invalidStructure.code !== "malformed-response")
  throw new Error("Langfuse built Retriever accepted a non-SPAN header.");

const lastCarrier = artifactCarriers.at(-1);
const originalChunks = lastCarrier.metadata.agentscope_capsule_chunks;
if (!Array.isArray(originalChunks) || originalChunks.length < 2)
  throw new Error("Langfuse built capsule lacks the chunk boundary fixture.");
const penultimate = originalChunks.at(-2);
const finalChunk = originalChunks.at(-1);
const noncanonicalCarriers = [
  ...artifactCarriers.slice(0, -1),
  {
    ...lastCarrier,
    metadata: {
      ...lastCarrier.metadata,
      agentscope_capsule_chunks: [
        ...originalChunks.slice(0, -2),
        penultimate.slice(0, -1),
        `${penultimate.at(-1)}${finalChunk}`,
      ],
    },
  },
];
const boundaryRetriever = testing.createLangfuseRetrieverTestHarness({
  executor: async (providerRequest) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(
      JSON.stringify({
        data: (
          new URL(providerRequest.url).searchParams.get("filter") ?? ""
        ).includes("agentscope.capsule.carrier.v1")
          ? noncanonicalCarriers
          : artifactHeaders,
        meta: {},
      }),
    ),
  }),
});
const boundarySearch = await boundaryRetriever.search();
if (!boundarySearch.ok || boundarySearch.value.summaries[0] === undefined)
  throw new Error("Langfuse built boundary fixture search failed.");
const boundaryGet = await boundaryRetriever.get(
  boundarySearch.value.summaries[0].locator,
);
if (boundaryGet.ok || boundaryGet.code !== "malformed-response")
  throw new Error(
    "Langfuse built Retriever accepted a shifted chunk boundary.",
  );

const rejected = await builtReporter.report({
  trace: {
    sequence: 8,
    tags: ["agentscope:model:collision"],
  },
});
if (rejected.outcome !== "rejected" || requests.length !== 1)
  throw new Error("Langfuse built Reporter projection collision escaped.");

const noncanonical = await builtReporter.report({
  trace: {
    sequence: 9,
    tags: ["e\u0301"],
  },
});
if (noncanonical.outcome !== "rejected" || requests.length !== 1)
  throw new Error("Langfuse built Reporter accepted a non-NFC projection.");

for (const headers of [
  {},
  { "content-type": "text/plain" },
  { "content-type": "application/json; charset=utf-16" },
  { "content-type": "application/json; charset=utf-8; charset=utf-8" },
]) {
  const untrustedResponseReporter = testing.createLangfuseReporterTestHarness({
    executor: async () => ({
      status: 200,
      headers,
      body: new TextEncoder().encode("{}"),
    }),
  });
  const untrustedResponse = await untrustedResponseReporter.report();
  if (untrustedResponse.outcome !== "outcome-unknown")
    throw new Error(
      "Langfuse built Reporter trusted a noncanonical response media type.",
    );
}

const parameterizedResponseReporter = testing.createLangfuseReporterTestHarness(
  {
    executor: async () => ({
      status: 200,
      headers: { "content-type": "Application/JSON; Charset=UTF-8" },
      body: new TextEncoder().encode("{}"),
    }),
  },
);
if ((await parameterizedResponseReporter.report()).outcome !== "accepted")
  throw new Error(
    "Langfuse built Reporter rejected the governed parameterized media type.",
  );

const source = readFileSync(new URL("./index.js", privateCandidateUrl), "utf8");
for (const forbidden of [
  "LANGFUSE_SANITIZED_HTTP_FIXTURES",
  "encodeLangfuseOtlpJsonBatchWithinLimitForTesting",
  "prepareDestinationReporterForTesting",
])
  if (source.includes(forbidden))
    throw new Error(`Langfuse root artifact leaks ${forbidden}.`);

if (
  !statSync(new URL("./reporter/projection.js", privateCandidateUrl)).isFile()
)
  throw new Error("Langfuse Reporter projection artifact is absent.");
if (
  readFileSync(
    new URL("./reporter/projection.js", privateCandidateUrl),
    "utf8",
  ).includes("encodeLangfuseOtlpJsonBatchWithinLimitForTesting")
)
  throw new Error("Langfuse Reporter artifact contains a test-only helper.");
if (
  readFileSync(
    new URL("./retriever/public.js", privateCandidateUrl),
    "utf8",
  ).includes("createLangfuseRetriever")
)
  throw new Error(
    "Langfuse Retriever public artifact leaks factory authority.",
  );

const finalCandidateFiles = regularFiles(privateCandidateUrl);
if (
  JSON.stringify(finalCandidateFiles) !== JSON.stringify(actualDist) ||
  snapshotDist(finalCandidateFiles, privateCandidateRoot).digest !==
    candidateArtifactDigest
)
  throw new Error("Langfuse dist changed while its evidence was executing.");

process.stdout.write(
  `${JSON.stringify({ langfuseMockRoundTripEvidence: mockEvidence })}\nVerified Langfuse descriptor, Reporter, and Retriever artifact (${candidateArtifactDigest}).\n`,
);
