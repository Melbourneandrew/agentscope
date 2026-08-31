import { publishManifestFields } from "./publish-manifest-contract.mjs";

const runtimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

export function createPublishManifest(developmentManifest) {
  for (const field of runtimeDependencyFields) {
    for (const [dependency, version] of Object.entries(
      developmentManifest[field] ?? {},
    )) {
      if (dependency.startsWith("@agentscope/")) {
        throw new Error(
          `Private runtime dependency is not publishable: ${dependency}`,
        );
      }
      if (String(version).startsWith("workspace:")) {
        throw new Error(
          `Workspace runtime dependency is not publishable: ${dependency}`,
        );
      }
    }
  }

  return Object.fromEntries(
    publishManifestFields.flatMap((field) =>
      developmentManifest[field] === undefined
        ? []
        : [[field, developmentManifest[field]]],
    ),
  );
}
