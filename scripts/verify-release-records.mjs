import { readFileSync } from "node:fs";

import {
  resolveContainedArtifactPath,
  validateCandidateManifest,
} from "./release-lane/candidate.mjs";
import { collectReleaseAuthorityBytes } from "./release-lane/offline-policy.mjs";
import { validateSyntheticReleaseRecords } from "./release-lane/records.mjs";
import { canonicalJson, sha256 } from "./release-lane/validation.mjs";

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
const candidateManifestPath = resolveContainedArtifactPath(
  artifactRoot,
  value("--candidate-manifest-relative"),
  "candidate manifest",
);
const candidateManifest = validateCandidateManifest(
  JSON.parse(readFileSync(candidateManifestPath, "utf8")),
);
const trustedManifestDigest = value("--trusted-candidate-manifest-digest");
if (sha256(canonicalJson(candidateManifest)) !== trustedManifestDigest)
  throw new Error("Trusted candidate manifest digest mismatch");
if (
  candidateManifest.sourceRevision !== value("--source-revision") ||
  candidateManifest.protectedTag !== value("--protected-tag")
)
  throw new Error("Trusted candidate source/tag mismatch");
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
  {
    manifestDigest: trustedManifestDigest,
    tarballSha256: candidateManifest.tarball.sha256,
    integrity: candidateManifest.tarball.integrity,
    sourceRevision: candidateManifest.sourceRevision,
    protectedTag: candidateManifest.protectedTag,
    packageName: candidateManifest.package.name,
    packageVersion: candidateManifest.package.version,
    distTag: candidateManifest.channel.npmDistTag,
  },
);
process.stdout.write(
  `Verified synthetic nonpublishing release records against observed bytes: ${JSON.stringify(result)}\n`,
);
