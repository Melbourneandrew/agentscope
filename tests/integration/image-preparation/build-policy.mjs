/** Closed build network selection; not offline input or service admission. */
import {
  boundedText,
  exactKeys,
  fixedError,
  preparationPolicy,
  preparationTeardownMilliseconds,
} from "./boundary.mjs";
import { createBoundedBuildContext } from "./build-context.mjs";

export const createBuildArchive = (context, options) => {
  try {
    return createBoundedBuildContext(context, options);
  } catch (error) {
    throw buildPhaseFailure(error, "context", [
      "integration.images.interrupted",
      "integration.images.timeout",
    ]);
  }
};

export const selectBuildOutput = (value) => {
  if (value === undefined) return "image";
  if (value !== "image" && value !== "evidence-tar")
    throw fixedError("integration.images.build.input");
  return value;
};
const validBuildMap = (value) =>
  exactKeys(value, Object.keys(value ?? {})) &&
  Object.entries(value).every(
    ([name, entry]) => boundedText(name, 128) && boundedText(entry, 1_024),
  );
export const validBuildInput = ({
  context,
  dockerfile,
  tag,
  buildArguments,
  labels,
  retirementRequired,
  buildOutput,
}) =>
  typeof context === "string" &&
  typeof dockerfile === "string" &&
  /^(?:[A-Za-z\d][A-Za-z\d._-]{0,127}\.Dockerfile|Dockerfile)$/u.test(
    dockerfile,
  ) &&
  validBuildMap(buildArguments) &&
  validBuildMap(labels) &&
  typeof retirementRequired === "boolean" &&
  (buildOutput === "evidence-tar"
    ? tag === undefined && !retirementRequired
    : typeof tag === "string" &&
      /^[a-z\d][a-z\d._/-]{0,127}:[a-z\d][a-z\d._-]{0,127}$/u.test(tag));
export const imageBuildPolicy = (image, maximumMilliseconds) =>
  preparationPolicy([image], {
    maximumPreparationMilliseconds: maximumMilliseconds,
    teardownMilliseconds: Math.min(
      preparationTeardownMilliseconds,
      Math.floor(maximumMilliseconds / 4),
    ),
  });

export const unavailableProcessDiagnostic = (failure) =>
  Object.freeze({
    observed: false,
    exited: false,
    signaled: false,
    timedOut: failure?.code === "ETIMEDOUT",
    joined: false,
    outputBytes: 0,
    outputTruncated: false,
    stderrClass: "unknown",
  });
export const settledBuildFailure = (authority, failure) => {
  const diagnostic = authority.firstFailureDiagnostic;
  const operation = [
    "preflight",
    "builder-create",
    "builder-bootstrap",
    "image-build",
  ].includes(diagnostic?.operationKind)
    ? diagnostic.operationKind
    : "unknown-operation";
  const stderrClass = [
    "resource-conflict",
    "build-failed",
    "bootstrap-failed",
    "permission-denied",
    "unknown",
  ].includes(diagnostic?.process?.stderrClass)
    ? diagnostic.process.stderrClass
    : "unknown";
  return fixedError(
    `integration.images.build.${operation}.${stderrClass}`,
    failure?.code === "ETIMEDOUT",
  );
};
export const buildPhaseFailure = (error, phase, retainedCodes) =>
  retainedCodes.includes(error?.message) ||
  /^integration\.images\.build\.context-[a-z-]+$/u.test(error?.message)
    ? error
    : fixedError(`integration.images.build.${phase}`);

export const selectBuildNetwork = (value) => {
  if (value === undefined) return "default";
  if (value !== "default" && value !== "none")
    throw fixedError("integration.images.build.input");
  return value;
};

export const builderNetworkFor = (selection) =>
  selectBuildNetwork(selection) === "none" ? "none" : "bridge";

export const buildArgumentsFor = ({
  buildArguments,
  buildNetwork,
  buildOutput,
  baseContext,
  builder,
  dockerfile,
  labels,
  platform,
  tag,
}) => {
  const network = selectBuildNetwork(buildNetwork);
  const result = [
    "build",
    "--builder",
    builder,
    "--file",
    dockerfile,
    ...(selectBuildOutput(buildOutput) === "image"
      ? ["--load"]
      : ["--output", "type=tar,dest=-"]),
    "--network",
    network,
    "--platform",
    `${platform.os}/${platform.architecture}${
      platform.variant === undefined ? "" : `/${platform.variant}`
    }`,
    "--pull=false",
    ...(selectBuildOutput(buildOutput) === "image" ? ["--tag", tag] : []),
  ];
  // Re-running RUN steps is necessary, but not sufficient, for offline proof.
  if (network === "none") result.push("--no-cache");
  if (baseContext !== undefined)
    result.push("--build-context", `agentscope_base=${baseContext}`);
  for (const [name, value] of Object.entries(buildArguments).sort())
    result.push("--build-arg", `${name}=${value}`);
  for (const [name, value] of Object.entries(labels).sort())
    result.push("--label", `${name}=${value}`);
  result.push("-");
  return result;
};
