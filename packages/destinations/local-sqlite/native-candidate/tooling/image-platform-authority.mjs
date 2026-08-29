import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const dockerDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const maximumRawProofBytes = 16_384;

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

export const assertOwnedToolingAuthority = (claimed, tooling) => {
  const expected = {
    acquisitionDriverSha256: sha256Hex(tooling.acquisitionDriver),
    archiveCompilerSha256: sha256Hex(tooling.archiveCompiler),
    materializeHelperSha256: sha256Hex(tooling.materializeHelper),
    execSupervisorSourceSha256: sha256Hex(tooling.execSupervisorSource),
    buildDriverSha256: sha256Hex(tooling.buildDriver),
    namespaceHelperSourceSha256: sha256Hex(tooling.namespaceHelperSource),
    namespaceHelperLicense: "MIT",
    runtimeBundlerSha256: sha256Hex(tooling.runtimeBundler),
  };
  if (JSON.stringify(claimed) !== JSON.stringify(expected))
    throw new Error("native candidate owned tooling authority invalid");
  return Object.freeze(expected);
};

export const nativeCandidatePlatform = Object.freeze({
  docker: "linux/amd64",
  os: "linux",
  architecture: "amd64",
  variant: "",
});

export const nativeCandidateToolchainImageAuthority = Object.freeze({
  sourceIndex:
    "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2",
  selectedManifest:
    "node@sha256:bb6834c0669aa71cbc8d94606561a721adf489f6b93d7b8b825f0cf1b498c2c4",
  selectedManifestBytes: 2493,
  configDigest:
    "sha256:a1bea2f8c1ee78866f82039a60baa1c3a480872018aa0ef4891000ec793ed82b",
  configBytes: 6629,
  platform: nativeCandidatePlatform,
});

const rawProof = (encoded) => {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length > maximumRawProofBytes ||
    !base64Pattern.test(encoded)
  )
    throw new Error("native candidate toolchain image authority invalid");
  const compressed = Buffer.from(encoded, "base64");
  if (compressed.toString("base64") !== encoded)
    throw new Error("native candidate toolchain image authority invalid");
  try {
    return gunzipSync(compressed, { maxOutputLength: maximumRawProofBytes });
  } catch {
    throw new Error("native candidate toolchain image authority invalid");
  }
};

const digest = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const invalidAuthority = () => {
  throw new Error("native candidate toolchain image authority invalid");
};

const authorityFieldsMatch = (authority) => {
  const expected = nativeCandidateToolchainImageAuthority;
  return !(
    authority === null ||
    typeof authority !== "object" ||
    Object.keys(authority).length !== 8 ||
    authority.sourceIndex !== expected.sourceIndex ||
    authority.selectedManifest !== expected.selectedManifest ||
    authority.selectedManifestBytes !== expected.selectedManifestBytes ||
    authority.configDigest !== expected.configDigest ||
    authority.configBytes !== expected.configBytes ||
    typeof authority.rawIndexGzipBase64 !== "string" ||
    typeof authority.rawManifestGzipBase64 !== "string" ||
    authority.platform === null ||
    typeof authority.platform !== "object" ||
    Object.keys(authority.platform).length !== 4 ||
    authority.platform.docker !== expected.platform.docker ||
    authority.platform.os !== expected.platform.os ||
    authority.platform.architecture !== expected.platform.architecture ||
    authority.platform.variant !== expected.platform.variant
  );
};

const parseProofDocuments = (rawIndex, rawManifest) => {
  try {
    return Object.freeze({
      index: JSON.parse(rawIndex.toString("utf8")),
      manifest: JSON.parse(rawManifest.toString("utf8")),
    });
  } catch {
    return invalidAuthority();
  }
};

const documentsMatch = (index, manifest) => {
  const expected = nativeCandidateToolchainImageAuthority;
  const selected = index?.manifests?.filter(
    ({ platform }) =>
      platform?.os === expected.platform.os &&
      platform?.architecture === expected.platform.architecture &&
      (platform.variant ?? "") === expected.platform.variant,
  );
  return (
    index?.schemaVersion === 2 &&
    index?.mediaType === "application/vnd.oci.image.index.v1+json" &&
    Array.isArray(selected) &&
    selected.length === 1 &&
    selected[0].mediaType === "application/vnd.oci.image.manifest.v1+json" &&
    selected[0].digest === expected.selectedManifest.slice("node@".length) &&
    selected[0].size === expected.selectedManifestBytes &&
    manifest?.schemaVersion === 2 &&
    manifest?.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
    manifest?.config?.mediaType ===
      "application/vnd.oci.image.config.v1+json" &&
    manifest?.config?.digest === expected.configDigest &&
    manifest?.config?.size === expected.configBytes
  );
};

export const assertToolchainImageAuthority = (authority) => {
  const expected = nativeCandidateToolchainImageAuthority;
  if (!authorityFieldsMatch(authority)) invalidAuthority();

  const rawIndex = rawProof(authority.rawIndexGzipBase64);
  const rawManifest = rawProof(authority.rawManifestGzipBase64);
  if (
    digest(rawIndex) !== expected.sourceIndex.slice("node@".length) ||
    rawManifest.length !== expected.selectedManifestBytes ||
    digest(rawManifest) !== expected.selectedManifest.slice("node@".length)
  )
    invalidAuthority();
  const { index, manifest } = parseProofDocuments(rawIndex, rawManifest);
  if (!documentsMatch(index, manifest)) invalidAuthority();
};

const imageInspectionArguments = (reference) =>
  Object.freeze([
    "image",
    "inspect",
    reference,
    "--format",
    "{{.Id}}\t{{.Os}}\t{{.Architecture}}",
  ]);

const imagePullArguments = (reference) =>
  Object.freeze([
    "pull",
    "--platform",
    nativeCandidatePlatform.docker,
    reference,
  ]);

const inspectImage = (reference, invoke) =>
  invoke(imageInspectionArguments(reference));

const assertExpectedImage = (inspection, expectedId) => {
  if (inspection.error || inspection.status !== 0)
    throw new Error("native candidate image inspection failed");
  const fields = inspection.stdout.replace(/\r?\n$/u, "").split("\t");
  if (
    fields.length !== 3 ||
    fields[0] !== expectedId ||
    fields[1] !== nativeCandidatePlatform.os ||
    fields[2] !== nativeCandidatePlatform.architecture
  )
    throw new Error("native candidate image identity mismatch");
};

export const ensurePlatformImage = ({ reference, expectedId, invoke }) => {
  if (
    typeof reference !== "string" ||
    !reference.includes("@sha256:") ||
    !dockerDigestPattern.test(expectedId) ||
    typeof invoke !== "function"
  )
    throw new Error("native candidate image authority invalid");

  let inspection = inspectImage(expectedId, invoke);
  if (inspection.error || inspection.status !== 0) {
    const pull = invoke(imagePullArguments(reference));
    if (pull.error || pull.status !== 0)
      throw new Error("native candidate image acquisition failed");
    inspection = inspectImage(expectedId, invoke);
  }
  assertExpectedImage(inspection, expectedId);
};
