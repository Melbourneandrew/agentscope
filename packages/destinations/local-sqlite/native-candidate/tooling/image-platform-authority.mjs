const dockerDigestPattern = /^sha256:[0-9a-f]{64}$/u;

export const nativeCandidatePlatform = Object.freeze({
  docker: "linux/amd64",
  os: "linux",
  architecture: "amd64",
  variant: "",
});

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
