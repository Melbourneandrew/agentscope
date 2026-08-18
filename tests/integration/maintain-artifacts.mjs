import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";

import { planArtifactRetention } from "./dist/operations.js";

const integrationRoot = import.meta.dirname;
const artifactsRoot = resolve(integrationRoot, "../../artifacts/integration");
const collections = ["candidates", "contexts", "runs"];
const maximumFiles = 4096;
const maximumFileBytes = 128 * 1024 * 1024;
const maximumRetainedBytes = 512 * 1024 * 1024;

const directoryBytes = (root) => {
  const pending = [root];
  let bytes = 0;
  let files = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = resolve(directory, entry.name);
      if (!target.startsWith(`${root}${sep}`) || entry.isSymbolicLink())
        throw new Error("integration.operations.artifacts");
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) throw new Error("integration.operations.artifacts");
      const status = lstatSync(target);
      files += 1;
      bytes += status.size;
      if (files > maximumFiles || status.size > maximumFileBytes)
        throw new Error("integration.operations.artifacts");
    }
  }
  return bytes;
};

const entries = collections.flatMap((collection) => {
  try {
    const rootStatus = lstatSync(artifactsRoot);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink())
      throw new Error("integration.operations.artifacts");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const root = resolve(artifactsRoot, collection);
  try {
    const status = lstatSync(root);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error("integration.operations.artifacts");
    return readdirSync(root, { withFileTypes: true }).map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("integration.operations.artifacts");
      const target = resolve(root, entry.name);
      const status = lstatSync(target);
      return {
        collection,
        name: entry.name,
        modifiedMilliseconds: Math.trunc(status.mtimeMs),
        bytes: directoryBytes(target),
      };
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
});
let currentCandidate;
try {
  const pointer = JSON.parse(
    readFileSync(resolve(artifactsRoot, "current-candidate.json"), "utf8"),
  );
  currentCandidate = pointer.bundleIdentity;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const plan = planArtifactRetention(entries, currentCandidate);
for (const entry of plan.remove) {
  const target = resolve(artifactsRoot, entry.collection, entry.name);
  const expectedRoot = resolve(artifactsRoot, entry.collection);
  if (!target.startsWith(`${expectedRoot}${sep}`))
    throw new Error("integration.operations.artifacts");
  rmSync(target, { recursive: true });
}
const retainedBytes = plan.retain.reduce(
  (total, entry) => total + entry.bytes,
  0,
);
if (retainedBytes > maximumRetainedBytes)
  throw new Error("integration.operations.artifact-budget");
process.stdout.write(
  `${JSON.stringify({
    artifactAccountingVersion: 1,
    beforeBytes: plan.totalBytes,
    retainedBytes,
    removedBytes: plan.remove.reduce((total, entry) => total + entry.bytes, 0),
    retained: plan.retain.map(({ collection, name, bytes }) => ({
      collection,
      name,
      bytes,
    })),
  })}\n`,
);
