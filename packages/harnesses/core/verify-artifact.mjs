import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  compileHarnessRegistry,
  defineHarnessDescriptor,
  discoverHarness,
  harnessesCorePackageId,
  completeNativeCaptureBoundary,
  createOwnedHarnessHookInvocation,
  inspectHarnessInstallation,
  applyHarnessInstallation,
  resolveNativeCaptureStart,
} from "./dist/index.js";
import * as harnessRoot from "./dist/index.js";
import { createHarnessContractSuite } from "./dist/testing.js";

const listRegularFiles = (directory, prefix = "") => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listRegularFiles(join(directory, entry.name), relative));
      continue;
    }
    if (!entry.isFile())
      throw new Error(`Unexpected harness artifact entry: ${relative}`);
    files.push(relative);
  }
  return files.sort();
};

const sources = listRegularFiles(resolve(import.meta.dirname, "src"))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => file.slice(0, -3));
const expected = sources
  .flatMap((file) => [`${file}.d.ts`, `${file}.js`])
  .sort();
const actual = listRegularFiles(resolve(import.meta.dirname, "dist"));
if (
  actual.length !== expected.length ||
  actual.some((file, index) => file !== expected[index]) ||
  actual.some((file) => file.includes(".test."))
)
  throw new Error("Harness Core production artifact inventory is not exact.");

if (harnessesCorePackageId !== "@agentscope/harnesses-core")
  throw new Error("Harness Core package identity drifted.");
if (
  "createHarnessContractSuite" in harnessRoot ||
  typeof createHarnessContractSuite !== "function"
)
  throw new Error("Harness Core testing export boundary drifted.");

const descriptor = defineHarnessDescriptor({
  descriptorVersion: 1,
  harnessType: "@agentscope/harness-artifact",
  executable: {
    names: ["artifact"],
    versionArguments: ["--version"],
    versionPrefix: "artifact ",
    versionSuffix: "",
  },
  configuration: { locationSegments: [["artifact", "config.json"]] },
  compatibility: [
    {
      minimumInclusive: "1.0.0",
      maximumExclusive: "2.0.0",
      evidenceSlot: "artifact-v1",
    },
  ],
  nativeSource: { sourceKind: "artifact-session", continuityVersion: 1 },
});
const digest = `sha256-${"a".repeat(64)}`;
const registry = compileHarnessRegistry([descriptor], {
  manifestVersion: 1,
  entries: [
    {
      harnessType: descriptor.harnessType,
      evidenceSlot: "artifact-v1",
      testedVersion: "1.1.0",
      contractSuiteDigest: digest,
      realScenarioDigest: digest,
    },
  ],
});
const result = await discoverHarness(registry, descriptor.harnessType, {
  locateExecutable: async () => ({
    kind: "found",
    candidates: [{ path: "/artifact/bin/harness" }],
  }),
  readVersion: async () => ({ kind: "observed", output: "artifact 1.1.0" }),
  inspectConfiguration: async () => [{ locationIndex: 0, present: false }],
});
if (result.state !== "installed" || result.version !== "1.1.0")
  throw new Error("Harness Core built contract failed.");

const captureStart = resolveNativeCaptureStart(
  {
    nativeIdentityKind: "session",
    nativeIdentity: "artifact-session",
    sourceGeneration: 1,
    positionKind: "sequence",
    availableStartPosition: 0,
  },
  () => ({ disposition: "unavailable", startPosition: 0 }),
);
const boundary = completeNativeCaptureBoundary(captureStart, {
  boundaryKind: "session",
  boundaryId: "artifact-boundary",
  exclusiveEndPosition: 1,
});
if (
  boundary.session.nativeIdentity !== "artifact-session" ||
  boundary.startPosition !== 0 ||
  boundary.exclusiveEndPosition !== 1
)
  throw new Error("Harness Core built native mapping contract failed.");

const invocation = createOwnedHarnessHookInvocation({
  executablePath: resolve("/opt/agentscope/bin/agentscope"),
  harnessType: descriptor.harnessType,
  contextEvidence: new TextEncoder().encode("artifact-context"),
});
if (
  invocation.contractVersion !== 1 ||
  !/^agentscope-hook-v1-sha256-[0-9a-f]{64}$/u.test(
    invocation.ownershipIdentity,
  ) ||
  JSON.stringify(invocation.arguments) !==
    JSON.stringify([
      "capture-hook-v1",
      "--contract-version",
      "1",
      "--harness",
      descriptor.harnessType,
    ])
)
  throw new Error("Harness Core built launcher contract failed.");

const installationRoot = mkdtempSync(join(tmpdir(), "agentscope-artifact-"));
try {
  const target = join(installationRoot, "harness.json");
  writeFileSync(target, "vendor");
  const plan = await inspectHarnessInstallation({
    manifestPath: join(installationRoot, "transactions", "hook.json"),
    operation: "install",
    targetPaths: [target],
    planner: () => ({
      kind: "replace",
      bytes: new TextEncoder().encode("agentscope-owned"),
    }),
  });
  const applied = await applyHarnessInstallation(plan);
  if (
    !applied.ok ||
    applied.state !== "committed" ||
    readFileSync(target, "utf8") !== "agentscope-owned"
  )
    throw new Error("Harness Core built installation contract failed.");
} finally {
  rmSync(installationRoot, { recursive: true, force: true });
}
