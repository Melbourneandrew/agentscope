const dockerDigestPattern = /^sha256:[0-9a-f]{64}$/u;

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
  platform: nativeCandidatePlatform,
});

export const assertToolchainImageAuthority = (authority) => {
  const expected = nativeCandidateToolchainImageAuthority;
  if (
    authority === null ||
    typeof authority !== "object" ||
    Object.keys(authority).length !== 5 ||
    authority.sourceIndex !== expected.sourceIndex ||
    authority.selectedManifest !== expected.selectedManifest ||
    authority.selectedManifestBytes !== expected.selectedManifestBytes ||
    authority.configDigest !== expected.configDigest ||
    authority.platform === null ||
    typeof authority.platform !== "object" ||
    Object.keys(authority.platform).length !== 4 ||
    authority.platform.docker !== expected.platform.docker ||
    authority.platform.os !== expected.platform.os ||
    authority.platform.architecture !== expected.platform.architecture ||
    authority.platform.variant !== expected.platform.variant
  )
    throw new Error("native candidate toolchain image authority invalid");
};

const imageInspectionArguments = (reference) =>
  Object.freeze([
    "image",
    "inspect",
    "--platform",
    nativeCandidatePlatform.docker,
    reference,
    "--format",
    "{{.Id}}\t{{.Os}}\t{{.Architecture}}\t{{.Variant}}",
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
    fields.length !== 4 ||
    fields[0] !== expectedId ||
    fields[1] !== nativeCandidatePlatform.os ||
    fields[2] !== nativeCandidatePlatform.architecture ||
    fields[3] !== nativeCandidatePlatform.variant
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

  let inspection = inspectImage(reference, invoke);
  if (inspection.error || inspection.status !== 0) {
    const pull = invoke(imagePullArguments(reference));
    if (pull.error || pull.status !== 0)
      throw new Error("native candidate image acquisition failed");
    inspection = inspectImage(reference, invoke);
  }
  assertExpectedImage(inspection, expectedId);
};
