/** Build-time verification of the same private closure the owned loader uses. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => {
  throw new Error("Harness directory artifact is not exact.");
};
const boundedFile = (path, maximum) => {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum))
      fail();
    const result = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < result.length) {
      const count = readSync(fd, result, offset, result.length - offset, null);
      if (count < 1) fail();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) fail();
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    for (const key of [
      "dev",
      "ino",
      "size",
      "mode",
      "nlink",
      "mtimeNs",
      "ctimeNs",
    ])
      if (before[key] !== after[key] || after[key] !== named[key]) fail();
    return result;
  } finally {
    closeSync(fd);
  }
};

const verifyMaterialHeader = (material, verified, provenance) => {
  if (
    material.schemaVersion !== 1 ||
    material.capability !== "installation-directory" ||
    material.disposition !== "proposed-unpublished-execution-eligible" ||
    provenance.schemaVersion !== 1 ||
    provenance.capability !== material.capability ||
    provenance.disposition !== material.disposition ||
    material.sourceCommit !== provenance.sourceCommit ||
    material.sourceTree !== provenance.sourceTree ||
    material.candidateRunId !== provenance.candidateRunId ||
    !/^[a-f0-9]{40}$/u.test(material.sourceCommit) ||
    !/^[a-f0-9]{40}$/u.test(material.sourceTree) ||
    !/^[1-9][0-9]{0,19}$/u.test(material.candidateRunId) ||
    !Array.isArray(material.candidates) ||
    material.candidates.length !== 2 ||
    !Array.isArray(provenance.outputs) ||
    provenance.outputs.length !== 2 ||
    verified.manifest.nativeBinaries.length !== 2
  )
    fail();
};

const verifyObservedCandidate = (
  row,
  material,
  provenance,
  driverDigest,
  workflowDigest,
) => {
  const observed = row.observation;
  if (
    observed?.schemaVersion !== 1 ||
    row.observedRecordDigest !==
      `sha256:${sha(Buffer.from(JSON.stringify(observed)))}` ||
    observed.disposition !== "unadmitted-candidate" ||
    observed.sourceCommit !== material.sourceCommit ||
    observed.runId !== material.candidateRunId ||
    observed.primitiveSourceDigest !== provenance.primitiveSourceDigest ||
    observed.driverSourceDigest !== driverDigest ||
    observed.workflowSourceDigest !== workflowDigest ||
    observed.componentProof !== "passed"
  )
    fail();
};

const verifyMaterialBindings = (root, verified, provenance) => {
  const bytes = boundedFile(
    new URL("records/release-materials.json", root),
    65_536,
  );
  if (provenance.releaseMaterialsDigest !== `sha256:${sha(bytes)}`) fail();
  const material = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  verifyMaterialHeader(material, verified, provenance);
  const sourceDigest = (path) =>
    `sha256:${sha(boundedFile(new URL(path, import.meta.url), 65_536))}`;
  const driverDigest = sourceDigest("build-candidate.mjs");
  const workflowDigest = sourceDigest(
    "../../../../.github/workflows/directory-native-candidate.yml",
  );
  if (
    provenance.componentProofSourceDigest !==
    sourceDigest("component-proof.mjs")
  )
    fail();
  const seen = new Set();
  for (const row of material.candidates) {
    const observed = row.observation;
    if (seen.has(row.relativePath)) fail();
    verifyObservedCandidate(
      row,
      material,
      provenance,
      driverDigest,
      workflowDigest,
    );
    seen.add(row.relativePath);
    const artifact = verified.manifest.artifactFiles.find(
      (file) => file.relativePath === row.relativePath,
    );
    const output = provenance.outputs.find(
      (file) => file.relativePath === row.relativePath,
    );
    const profiles = verified.manifest.nativeBinaries.filter(
      (file) => file.relativePath === row.relativePath,
    );
    if (
      !artifact ||
      !output ||
      profiles.length !== 1 ||
      artifact.bytes !== observed.binary?.bytes ||
      artifact.digest !== observed.binary?.digest ||
      output.bytes !== artifact.bytes ||
      output.digest !== artifact.digest
    )
      fail();
    const { relativePath: ignored, ...profile } = profiles[0];
    if (
      ignored !== row.relativePath ||
      JSON.stringify(profile) !== JSON.stringify(observed.profile)
    )
      fail();
    const license = verified.manifest.artifactFiles.find(
      (file) => file.relativePath === "notices/node-MIT.txt",
    );
    if (
      !license ||
      observed.material?.license?.bytes !== license.bytes ||
      observed.material?.license?.digest !== license.digest
    )
      fail();
  }
  if (seen.size !== verified.manifest.nativeBinaries.length) fail();
};

export const verifyDirectoryArtifact = async (built = false) => {
  if (typeof built !== "boolean") fail();
  const root = new URL(
    built ? "../dist/directory-runtime/" : "files/",
    import.meta.url,
  );
  const manifestBytes = boundedFile(
    new URL("records/support-manifest.json", root),
    65_536,
  );
  const digest = sha(manifestBytes);
  // Authenticate the actual code before importing it. Neither a manifest nor a
  // candidate can substitute the source-controlled owned loader implementation.
  const loaderBytes = boundedFile(
    new URL("loader/owned-loader.mjs", root),
    65_536,
  );
  if (
    sha(loaderBytes) !==
    sha(boundedFile(new URL("owned-loader.mjs", import.meta.url), 65_536))
  )
    fail();
  const loader = await import(new URL("loader/owned-loader.mjs", root).href);
  const verified = loader.verifyDirectoryAsset(digest);
  const sourceBytes = boundedFile(
    new URL("primitive.c", import.meta.url),
    65_536,
  );
  // The exact native material/provenance records additionally bind this source.
  // Missing records are a build failure, never permission to compile locally.
  for (const path of [
    "records/provenance.json",
    "records/release-materials.json",
    "records/sbom.spdx.json",
  ])
    if (!verified.paths.includes(path)) fail();
  const provenance = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      boundedFile(new URL("records/provenance.json", root), 65_536),
    ),
  );
  if (
    provenance.primitiveSourceDigest !== `sha256:${sha(sourceBytes)}` ||
    provenance.loaderSourceDigest !== `sha256:${sha(loaderBytes)}`
  )
    fail();
  verifyMaterialBindings(root, verified, provenance);
  return Object.freeze({
    root,
    digest,
    paths: Object.freeze([...verified.paths, "records/support-manifest.json"]),
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url))
  await verifyDirectoryArtifact();
