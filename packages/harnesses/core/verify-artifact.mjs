import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  compileHarnessRegistry,
  defineHarnessDescriptor,
  discoverHarness,
  harnessesCorePackageId,
} from "./dist/index.js";

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
