import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  compileCapabilityManifest,
  selectCapabilityScenarios,
  verifyManifestEvidence,
} from "./dist/manifest.js";

const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const manifest = compileCapabilityManifest(
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ),
);
verifyManifestEvidence(manifest, integrationRoot);

const shard = process.env.AGENTSCOPE_INTEGRATION_SHARD;
let parsedShard;
if (shard !== undefined) {
  const match = /^(\d+)\/(\d+)$/u.exec(shard);
  if (!match) throw new Error("integration.manifest.shard");
  parsedShard = { index: Number(match[1]), total: Number(match[2]) };
}
const selector = {
  ...(process.env.AGENTSCOPE_INTEGRATION_SCENARIO === undefined
    ? {}
    : { scenarioId: process.env.AGENTSCOPE_INTEGRATION_SCENARIO }),
  ...(process.env.AGENTSCOPE_INTEGRATION_HARNESS === undefined
    ? {}
    : { harnessId: process.env.AGENTSCOPE_INTEGRATION_HARNESS }),
  ...(process.env.AGENTSCOPE_INTEGRATION_TAG === undefined
    ? {}
    : { tag: process.env.AGENTSCOPE_INTEGRATION_TAG }),
  ...(parsedShard === undefined ? {} : { shard: parsedShard }),
};
const scenarios = selectCapabilityScenarios(manifest, selector);
const selection = {
  selectionVersion: 1,
  manifestIdentity: manifest.manifestIdentity,
  scenarioIds: scenarios.map(({ scenarioId }) => scenarioId),
};
const integrationArtifacts = resolve(workspaceRoot, "artifacts/integration");
mkdirSync(integrationArtifacts, { recursive: true });
const pointer = resolve(integrationArtifacts, "current-selection.json");
const temporaryPointer = `${pointer}.${process.pid}.tmp`;
writeFileSync(temporaryPointer, `${JSON.stringify(selection, undefined, 2)}\n`);
renameSync(temporaryPointer, pointer);
process.stdout.write(`${JSON.stringify(selection)}\n`);
