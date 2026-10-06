import { readFileSync } from "node:fs";

import {
  resolveContainedArtifactPath,
  verifyCandidateArtifact,
} from "./release-lane/candidate.mjs";
import {
  readReleaseEvidence,
  validateReleaseEvidence,
} from "./release-lane/admission.mjs";

const value = (name) => {
  const index = process.argv.indexOf(name);
  const result = process.argv.at(index + 1);
  if (index < 0 || !result) throw new Error(`Missing ${name}`);
  return result;
};

const artifactRoot = value("--artifact-root");
const resolveArtifact = (name) => {
  return resolveContainedArtifactPath(artifactRoot, value(name), name);
};

const manifestPath = resolveArtifact("--manifest-relative");
const certificationRecordPath = resolveArtifact("--certification-relative");
const tarballPath = resolveArtifact("--tarball-relative");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const certificationRecord = JSON.parse(
  readFileSync(certificationRecordPath, "utf8"),
);
const result = verifyCandidateArtifact({
  manifest,
  certificationRecord,
  tarballPath,
  expectedManifestDigest: value("--manifest-digest"),
  expectedSourceRevision: value("--source-revision"),
  expectedProtectedTag: value("--protected-tag"),
});
const evidence = validateReleaseEvidence({
  manifest,
  certificationRecord,
  supportAdmission: readReleaseEvidence(artifactRoot, "support-admission.json"),
  evidenceIndex: readReleaseEvidence(artifactRoot, "evidence-index.json"),
  readEvidence: (path) => readReleaseEvidence(artifactRoot, path),
});
process.stdout.write(
  `Verified retained candidate records without rebuilding; final advertised roster and publication admission remain unclaimed: ${JSON.stringify({ ...result, ...evidence })}\n`,
);
