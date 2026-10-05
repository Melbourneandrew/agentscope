/** Pure output representation only; no subprocess or lifecycle authority. */
const maximumHeaderBytes = 16_384;
const buildxStderrClassifiers = Object.freeze([
  ["resource-conflict", /(?:already exists|existing instance)/iu],
  ["build-failed", /(?:failed to solve|failed to build)/iu],
  [
    "bootstrap-failed",
    /(?:failed to boot|bootstrap|connection refused|unavailable)/iu,
  ],
  ["permission-denied", /(?:permission denied|operation not permitted)/iu],
]);
export const classifyBuildxStderr = (value) => {
  if (typeof value !== "string" || value.length > maximumHeaderBytes)
    return "unknown";
  return (
    buildxStderrClassifiers.find(([, pattern]) => pattern.test(value))?.[0] ??
    "unknown"
  );
};
export const selectCommandOutput = (value) => {
  if (value === undefined) return "text";
  if (value !== "text" && value !== "binary")
    throw new Error("integration.images.build.input");
  return value;
};
export const serializeCommandOutput = (chunks, selection) => {
  const bytes = Buffer.concat(chunks);
  return selection === "binary" ? bytes : bytes.toString("utf8");
};
