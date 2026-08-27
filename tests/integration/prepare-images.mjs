/* eslint import-x/no-cycle: "off" -- private executable capability */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compileCapabilityManifest } from "./dist/index.js";
import {
  preparePinnedDockerImages,
  publishPreparedImageEvidence,
  retirePreparedImageEvidence,
} from "./image-preparation.mjs";
import {
  integrationStageSignal,
  registerIntegrationArtifactFile,
  remainingIntegrationOperationMilliseconds,
  requireDisposableOuterHostCapability,
} from "./dist/controller.js";

const capability = requireDisposableOuterHostCapability();

const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const artifactsRoot = resolve(workspaceRoot, "artifacts/integration");
const evidenceTarget = resolve(artifactsRoot, "current-images.json");
// Retire prior authority before any fallible manifest or selection work.
retirePreparedImageEvidence(evidenceTarget);
const evidenceTarget = resolve(artifactsRoot, "current-images.json");
// Retire prior authority before any fallible manifest or selection work.
retirePreparedImageEvidence(evidenceTarget);
const manifest = compileCapabilityManifest(
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ),
);
const selection = JSON.parse(
  readFileSync(resolve(artifactsRoot, "current-selection.json"), "utf8"),
);
if (
  selection.selectionVersion !== 2 ||
  selection.manifestIdentity !== manifest.manifestIdentity ||
  typeof selection.selector !== "object" ||
  selection.selector === null ||
  !Array.isArray(selection.scenarioIds)
)
  throw new Error("integration.images.selection");
const scenarios = new Map(
  manifest.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
);
const images = [
  ...new Set(
    selection.scenarioIds.flatMap((scenarioId) => {
      const scenario = scenarios.get(scenarioId);
      if (!scenario) throw new Error("integration.images.selection");
      return [scenario.image, scenario.mockServerImage];
    }),
  ),
].sort();
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const prepared = await preparePinnedDockerImages(images, {
    dockerExecutable: capability.binding.dockerExecutable,
    environment: capability.binding.dockerEnvironment,
    maximumPreparationMilliseconds:
      remainingIntegrationOperationMilliseconds(300_000),
    signal: AbortSignal.any([controller.signal, integrationStageSignal()]),
  });
  registerIntegrationArtifactFile("current-images.json");
  publishPreparedImageEvidence(
    evidenceTarget,
    manifest.manifestIdentity,
    prepared,
  );
  process.stdout.write(`${JSON.stringify(prepared.images)}\n`);
} catch (error) {
  const code =
    error instanceof Error &&
    /^integration\.images\.[a-z-]+$/u.test(error.message)
      ? error.message
      : "integration.images.command";
  process.stderr.write(`${code}\n`);
  throw new Error(code, { cause: error });
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
