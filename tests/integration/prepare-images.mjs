import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { compileCapabilityManifest } from "./dist/index.js";

const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const artifactsRoot = resolve(workspaceRoot, "artifacts/integration");
const manifest = compileCapabilityManifest(
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ),
);
const selection = JSON.parse(
  readFileSync(resolve(artifactsRoot, "current-selection.json"), "utf8"),
);
if (
  selection.selectionVersion !== 1 ||
  selection.manifestIdentity !== manifest.manifestIdentity ||
  !Array.isArray(selection.scenarioIds)
)
  throw new Error("integration.images.selection");
const scenarios = new Map(
  manifest.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
);
const images = [
  ...new Set(
    selection.scenarioIds.flatMap((scenarioId) => {
      const scenario = scenarios.get(scenarioId);
      if (!scenario) throw new Error("integration.images.selection");
      return [scenario.image, scenario.mockServerImage];
    }),
  ),
].sort();
const prepared = images.map((image) => {
  execFileSync("docker", ["pull", image], { stdio: "inherit" });
  const localImageDigest = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { encoding: "utf8" },
  ).trim();
  if (!/^sha256:[a-f\d]{64}$/u.test(localImageDigest))
    throw new Error("integration.images.digest");
  return { image, localImageDigest: localImageDigest.replace(":", "-") };
});
mkdirSync(artifactsRoot, { recursive: true });
const target = resolve(artifactsRoot, "current-images.json");
const temporary = `${target}.${process.pid}.tmp`;
writeFileSync(
  temporary,
  `${JSON.stringify(
    {
      imageEvidenceVersion: 1,
      manifestIdentity: manifest.manifestIdentity,
      images: prepared,
    },
    undefined,
    2,
  )}\n`,
);
renameSync(temporary, target);
console.log(JSON.stringify(prepared));
