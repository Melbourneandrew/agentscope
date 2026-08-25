import { readFileSync } from "node:fs";

import { resolveContainedArtifactPath } from "./release-lane/candidate.mjs";
import { collectReleaseAuthorityBytes } from "./release-lane/offline-policy.mjs";
import { validateSyntheticReleaseRecords } from "./release-lane/records.mjs";

const value = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
};
const artifactRoot = value("--artifact-root");
const workspaceRoot = value("--workspace-root");
const recordSetPath = resolveContainedArtifactPath(
  artifactRoot,
  value("--record-set-relative"),
  "record set",
);
const workflowRelative = value("--workflow-relative");
const workflowPath = resolveContainedArtifactPath(
  workspaceRoot,
  workflowRelative,
  "workflow",
);
const releaseScripts = collectReleaseAuthorityBytes(workspaceRoot);
const result = validateSyntheticReleaseRecords(
  JSON.parse(readFileSync(recordSetPath, "utf8")),
  {
    workflowBytes: readFileSync(workflowPath),
    releaseScripts,
  },
);
process.stdout.write(
  `Verified synthetic nonpublishing release records against observed bytes: ${JSON.stringify(result)}\n`,
);
