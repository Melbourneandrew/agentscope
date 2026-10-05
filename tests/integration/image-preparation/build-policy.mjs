/** Closed build network selection; not offline input or service admission. */
import { fixedError } from "./boundary.mjs";

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
    "--load",
    "--network",
    network,
    "--platform",
    `${platform.os}/${platform.architecture}${
      platform.variant === undefined ? "" : `/${platform.variant}`
    }`,
    "--pull=false",
    "--tag",
    tag,
  ];
  // Re-running RUN steps is necessary, but not sufficient, for offline proof.
  if (network === "none") result.push("--no-cache");
  for (const [name, value] of Object.entries(buildArguments).sort())
    result.push("--build-arg", `${name}=${value}`);
  for (const [name, value] of Object.entries(labels).sort())
    result.push("--label", `${name}=${value}`);
  result.push("-");
  return result;
};
