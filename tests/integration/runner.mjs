import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const endpoint = process.env.AGENTSCOPE_COLLECTOR_URL;
if (!endpoint) throw new Error("AGENTSCOPE_COLLECTOR_URL is required");
const candidateRoot = process.env.AGENTSCOPE_CANDIDATE_ROOT;
if (!candidateRoot) throw new Error("AGENTSCOPE_CANDIDATE_ROOT is required");

const digest = (bytes) =>
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
const pointer = JSON.parse(
  readFileSync(join(candidateRoot, "current-candidate.json"), "utf8"),
);
if (
  pointer.pointerVersion !== 1 ||
  !/^sha256-[a-f\d]{64}$/u.test(pointer.bundleIdentity)
)
  throw new Error("candidate pointer is invalid");
const selection = JSON.parse(
  readFileSync(join(candidateRoot, "current-selection.json"), "utf8"),
);
const manifest = JSON.parse(
  readFileSync("tests/integration/capability-manifest.json", "utf8"),
);
const knownScenarios = new Set(
  manifest.scenarios.map(({ scenarioId }) => scenarioId),
);
if (
  selection.selectionVersion !== 1 ||
  selection.manifestIdentity !== manifest.manifestIdentity ||
  !Array.isArray(selection.scenarioIds) ||
  selection.scenarioIds.length < 1 ||
  selection.scenarioIds.some(
    (scenarioId) =>
      typeof scenarioId !== "string" || !knownScenarios.has(scenarioId),
  )
)
  throw new Error("scenario selection is invalid");
const directory = join(candidateRoot, "candidates", pointer.bundleIdentity);
const evidence = JSON.parse(
  readFileSync(join(directory, "evidence.json"), "utf8"),
);
if (
  evidence.bundleIdentity !== pointer.bundleIdentity ||
  evidence.candidateRevision !== pointer.candidateRevision ||
  evidence.scenarioNetworkPolicy !== "offline-no-package-or-registry-download"
)
  throw new Error("candidate evidence is invalid");
if (
  JSON.stringify(readdirSync(directory).sort()) !==
  JSON.stringify(["evidence.json", "files"])
)
  throw new Error("candidate artifact inventory is invalid");
const declared = [evidence.lockfile, ...evidence.artifacts];
const declaredNames = declared.map(({ fileName }) => fileName).sort();
if (
  JSON.stringify(readdirSync(join(directory, "files")).sort()) !==
  JSON.stringify(declaredNames)
)
  throw new Error("candidate artifact inventory is invalid");
for (const file of declared) {
  const path = join(directory, "files", file.fileName);
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size !== file.bytes ||
    digest(readFileSync(path)) !== file.sha256
  )
    throw new Error("candidate artifact is invalid");
}

const response = await fetch(endpoint);
if (!response.ok)
  throw new Error(`collector health check failed: ${response.status}`);
console.log("Integration runner scaffold reached the isolated collector.");
