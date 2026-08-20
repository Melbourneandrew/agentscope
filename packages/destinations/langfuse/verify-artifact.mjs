import { Buffer } from "node:buffer";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  isDestinationDescriptor,
  parseDestinationSettings,
} from "@agentscope/destinations-core";

import * as root from "./dist/index.js";
import * as reporter from "./dist/reporter/index.js";
import * as testing from "./dist/testing.js";

const packageRoot = new URL(".", import.meta.url);
const sourceRoot = new URL("./src/", packageRoot);
const distRoot = new URL("./dist/", packageRoot);

const regularFiles = (rootUrl) => {
  const rootPath = rootUrl.pathname;
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

const rootKeys = Object.keys(root).sort();
if (
  JSON.stringify(rootKeys) !==
  JSON.stringify(
    [
      "LANGFUSE_COMPATIBILITY_MANIFEST",
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
  JSON.stringify(Object.keys(testing).sort()) !==
  JSON.stringify(
    [
      "LANGFUSE_FILTER_CONFORMANCE_FIXTURES",
      "LANGFUSE_SANITIZED_HTTP_FIXTURES",
      "createLangfuseDestinationTestAdapter",
      "createLangfuseReporterTestHarness",
    ].sort(),
  )
)
  throw new Error("Langfuse testing export surface drifted.");
if (
  !isDestinationDescriptor(root.langfuseDestinationDescriptor) ||
  root.langfuseDestinationDescriptor.deliveryIdentitySupport !==
    "duplicates-possible" ||
  root.langfuseDestinationDescriptor.retrievalSupport !== "unsupported" ||
  JSON.stringify(
    root.LANGFUSE_COMPATIBILITY_MANIFEST.projection.modelAttributeKeys,
  ) !==
    JSON.stringify([
      "llm.model_name",
      "embedding.model_name",
      "reranker.model_name",
    ]) ||
  root.LANGFUSE_COMPATIBILITY_MANIFEST.manifestId !==
    "sha256:0cebb10cc8b3ec59be2f85111971edfb79c90a33b75d0118149c6626512dccca"
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
if (
  result.outcome !== "accepted" ||
  requests.length !== 1 ||
  request.url !== "http://127.0.0.1:4318/api/public/otel/v1/traces" ||
  request.headers.authorization !==
    `Basic ${Buffer.from("pk-fixture:sk-fixture", "utf8").toString("base64")}` ||
  request.headers["x-langfuse-ingestion-version"] !== "4" ||
  attributes.get("agentscope.harness.name")?.stringValue !==
    "fixture-harness" ||
  attributes.get("langfuse.observation.metadata.agentscope_session")
    ?.stringValue !== "artifact-session" ||
  attributes.get("langfuse.trace.tags")?.arrayValue?.values?.[0]
    ?.stringValue !== "agentscope:model:artifact-model"
)
  throw new Error("Langfuse built Reporter projection or transport drifted.");

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

const source = readFileSync(new URL("./dist/index.js", packageRoot), "utf8");
for (const forbidden of [
  "LANGFUSE_SANITIZED_HTTP_FIXTURES",
  "encodeLangfuseOtlpJsonBatchWithinLimitForTesting",
  "prepareDestinationReporterForTesting",
])
  if (source.includes(forbidden))
    throw new Error(`Langfuse root artifact leaks ${forbidden}.`);

if (!statSync(new URL("./dist/reporter/projection.js", packageRoot)).isFile())
  throw new Error("Langfuse Reporter projection artifact is absent.");
if (
  readFileSync(
    new URL("./dist/reporter/projection.js", packageRoot),
    "utf8",
  ).includes("encodeLangfuseOtlpJsonBatchWithinLimitForTesting")
)
  throw new Error("Langfuse Reporter artifact contains a test-only helper.");

process.stdout.write("Verified Langfuse descriptor and Reporter artifact.\n");
