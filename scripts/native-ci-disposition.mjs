import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectCandidateTarball,
  resolveContainedArtifactPath,
  validateCandidateManifest,
} from "./release-lane/candidate.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const revisionPattern = /^[0-9a-f]{40}$/u;
const blobPattern = /^[0-9a-f]{40}$/u;
const nativeRoot = "package/dist/internal/local-sqlite/";
const loader = `${nativeRoot}loader/owned-loader.cjs`;
const supportManifest = `${nativeRoot}records/support-manifest.json`;
const nativeBinary =
  /^package\/dist\/internal\/local-sqlite\/native\/[^/]+\/agentscope_sqlite\.node$/u;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

export function validateNativeCandidateProfile(profile) {
  if (
    !exactKeys(profile, [
      "schemaVersion",
      "package",
      "version",
      "localSqliteExecutableTuple",
    ]) ||
    profile.schemaVersion !== 1 ||
    profile.package !== "agentscope-cli" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(profile.version) ||
    !["excluded", "proposed-unpublished"].includes(
      profile.localSqliteExecutableTuple,
    )
  )
    throw new Error("native-ci-profile-invalid");
  return profile;
}

export function readAuthenticatedNativeProfile(path, expectedBlob) {
  if (
    !blobPattern.test(expectedBlob) ||
    typeof constants.O_NOFOLLOW !== "number"
  )
    throw new Error("native-ci-profile-source-invalid");
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile())
      throw new Error("native-ci-profile-not-regular");
    const bytes = readFileSync(descriptor);
    const observedBlob = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
    if (observedBlob !== expectedBlob)
      throw new Error("native-ci-profile-source-mismatch");
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function nativeInventoryState(inspected, profile) {
  if (
    inspected?.packedManifest === null ||
    typeof inspected?.packedManifest !== "object" ||
    inspected.packedManifest.name !== profile.package ||
    inspected.packedManifest.version !== profile.version ||
    !Array.isArray(inspected.inventory) ||
    inspected.inventory.length === 0
  )
    throw new Error("native-ci-packed-inventory-invalid");
  const paths = inspected.inventory.map((entry) => entry.path);
  if (
    paths.some((path) => typeof path !== "string") ||
    new Set(paths).size !== paths.length ||
    !paths.includes("package/dist/bin/agentscope.js")
  )
    throw new Error("native-ci-packed-inventory-invalid");
  const folded = paths.map((path) => path.toLowerCase());
  const hasNative = folded.some(
    (path) => path.startsWith(nativeRoot) || path.endsWith(".node"),
  );
  const hasCompleteTuple =
    paths.includes(loader) &&
    paths.includes(supportManifest) &&
    paths.some((path) => nativeBinary.test(path));
  if (hasNative && !hasCompleteTuple)
    throw new Error("native-ci-packed-inventory-contradictory");
  return hasCompleteTuple;
}

export function evaluateNativeCandidateDisposition({
  profile,
  packed,
  sourceRevision,
  candidateManifest,
  candidateTarball,
}) {
  validateNativeCandidateProfile(profile);
  if (!revisionPattern.test(sourceRevision))
    throw new Error("native-ci-source-revision-invalid");
  const packedTuple = nativeInventoryState(packed, profile);
  if (candidateManifest !== undefined || candidateTarball !== undefined) {
    if (candidateManifest === undefined || candidateTarball === undefined)
      throw new Error("native-ci-candidate-evidence-missing");
    validateCandidateManifest(candidateManifest);
    if (
      candidateManifest.sourceRevision !== sourceRevision ||
      candidateManifest.package.name !== profile.package ||
      candidateManifest.package.version !== profile.version ||
      candidateTarball.sha256 !== candidateManifest.tarball.sha256 ||
      candidateTarball.inventoryDigest !==
        candidateManifest.tarball.inventoryDigest ||
      candidateTarball.integrity !== candidateManifest.tarball.integrity ||
      candidateTarball.bytes !== candidateManifest.tarball.bytes
    )
      throw new Error("native-ci-candidate-identity-mismatch");
    if (
      candidateTarball.inventoryDigest !== packed.inventoryDigest ||
      nativeInventoryState(candidateTarball, profile) !== packedTuple
    )
      throw new Error("native-ci-candidate-inventory-contradictory");
  }
  if (profile.localSqliteExecutableTuple === "excluded") {
    if (packedTuple)
      throw new Error("native-ci-profile-inventory-contradictory");
    return Object.freeze({
      required: false,
      reason: "Local SQLite not admitted",
      supportAdmission: "not-claimed",
    });
  }
  if (!packedTuple)
    throw new Error("native-ci-profile-inventory-contradictory");
  return Object.freeze({
    required: true,
    reason: "packed proposed Local SQLite tuple",
    supportAdmission: "not-claimed",
  });
}

function parseArguments(argv) {
  const options = new Map();
  if (argv.length % 2 !== 0) throw new Error("native-ci-arguments-invalid");
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv.at(index);
    const value = argv.at(index + 1);
    if (
      ![
        "--profile",
        "--profile-blob",
        "--packed-tarball",
        "--source-revision",
        "--artifact-root",
        "--candidate-manifest-relative",
        "--candidate-tarball-relative",
        "--output",
        "--summary",
      ].includes(key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      options.has(key)
    )
      throw new Error("native-ci-arguments-invalid");
    options.set(key, value);
  }
  for (const key of [
    "--profile",
    "--profile-blob",
    "--packed-tarball",
    "--source-revision",
    "--output",
    "--summary",
  ])
    if (!options.has(key)) throw new Error("native-ci-arguments-invalid");
  const candidateKeys = [
    "--artifact-root",
    "--candidate-manifest-relative",
    "--candidate-tarball-relative",
  ];
  if (
    candidateKeys.some((key) => options.has(key)) &&
    !candidateKeys.every((key) => options.has(key))
  )
    throw new Error("native-ci-arguments-invalid");
  return options;
}

function run(argv) {
  const options = parseArguments(argv);
  const profileBytes = readAuthenticatedNativeProfile(
    resolve(root, options.get("--profile")),
    options.get("--profile-blob"),
  );
  const profile = JSON.parse(profileBytes.toString("utf8"));
  const packed = inspectCandidateTarball(
    resolve(root, options.get("--packed-tarball")),
  );
  const artifactRoot = options.get("--artifact-root");
  const candidateManifest =
    artifactRoot === undefined
      ? undefined
      : JSON.parse(
          readFileSync(
            resolveContainedArtifactPath(
              resolve(root, artifactRoot),
              options.get("--candidate-manifest-relative"),
              "candidate manifest",
            ),
            "utf8",
          ),
        );
  const candidateTarball =
    artifactRoot === undefined
      ? undefined
      : inspectCandidateTarball(
          resolveContainedArtifactPath(
            resolve(root, artifactRoot),
            options.get("--candidate-tarball-relative"),
            "candidate tarball",
          ),
        );
  const disposition = evaluateNativeCandidateDisposition({
    profile,
    packed,
    sourceRevision: options.get("--source-revision"),
    candidateManifest,
    candidateTarball,
  });
  const profileDigest = `sha256:${createHash("sha256")
    .update(profileBytes)
    .digest("hex")}`;
  const output = `required=${disposition.required}\nreason=${disposition.reason}\n`;
  appendFileSync(options.get("--output"), output);
  appendFileSync(
    options.get("--summary"),
    `Native candidate disposition: ${disposition.reason}\n\nSource: ${options.get("--source-revision")}  \nProfile: ${profileDigest}  \nPacked inventory: ${packed.inventoryDigest}  \nSupport admission: ${disposition.supportAdmission}\n`,
  );
  process.stdout.write(output);
}

if (process.argv.at(1) === fileURLToPath(import.meta.url))
  run(process.argv.slice(2));
