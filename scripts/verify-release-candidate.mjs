import { readFileSync } from "node:fs";

import {
  resolveContainedArtifactPath,
  verifyCandidateArtifact,
} from "./release-lane/candidate.mjs";

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

const result = verifyCandidateArtifact({
  manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
  certificationRecord: JSON.parse(
    readFileSync(certificationRecordPath, "utf8"),
  ),
  tarballPath,
  expectedManifestDigest: value("--manifest-digest"),
  expectedSourceRevision: value("--source-revision"),
  expectedProtectedTag: value("--protected-tag"),
});
process.stdout.write(
  `Verified exact certified release candidate without rebuilding: ${JSON.stringify(result)}\n`,
);
