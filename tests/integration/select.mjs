/* eslint import-x/no-cycle: "off" -- private executable capability */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  compileCapabilityManifest,
  selectCapabilityScenarios,
  verifyManifestEvidence,
} from "./dist/manifest.js";
import { compileLocalSelection } from "./dist/operations.js";
import {
  registerIntegrationArtifactFile,
  requireDisposableOuterHostCapability,
} from "./dist/controller.js";

requireDisposableOuterHostCapability();

const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const manifest = compileCapabilityManifest(
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ),
);
verifyManifestEvidence(manifest, integrationRoot);

const { mode: selectionMode, selector } = compileLocalSelection(process.env);
const scenarios = selectCapabilityScenarios(manifest, selector);
const selection = {
  selectionVersion: 2,
  manifestIdentity: manifest.manifestIdentity,
  selectionMode,
  selector,
  scenarioIds: scenarios.map(({ scenarioId }) => scenarioId),
};
const integrationArtifacts = resolve(workspaceRoot, "artifacts/integration");
mkdirSync(integrationArtifacts, { recursive: true });
const pointer = resolve(integrationArtifacts, "current-selection.json");
registerIntegrationArtifactFile("current-selection.json");
const temporaryPointer = `${pointer}.${process.pid}.tmp`;
writeFileSync(temporaryPointer, `${JSON.stringify(selection, undefined, 2)}\n`);
renameSync(temporaryPointer, pointer);
process.stdout.write(`${JSON.stringify(selection)}\n`);
