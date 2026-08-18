import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const requiredEnvironment = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`integration.runner.environment-${name}`);
  return value;
};
const endpoint = requiredEnvironment("AGENTSCOPE_COLLECTOR_URL");
const candidateRoot = requiredEnvironment("AGENTSCOPE_CANDIDATE_ROOT");
const home = requiredEnvironment("HOME");
const harnessHome = requiredEnvironment("HARNESS_HOME");
const agentscopeHome = requiredEnvironment("AGENTSCOPE_HOME");
const worktree = requiredEnvironment("AGENTSCOPE_WORKTREE");
const ledger = requiredEnvironment("AGENTSCOPE_LEDGER");

const digest = (bytes) =>
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
const assertEmptyDirectory = (path) => {
  if (readdirSync(path).length !== 0)
    throw new Error("integration.runner.home-not-empty");
};
for (const path of [home, harnessHome, agentscopeHome, worktree, ledger])
  assertEmptyDirectory(path);
try {
  writeFileSync("/agentscope-root-write-probe", "forbidden");
  throw new Error("integration.runner.root-writable");
} catch (error) {
  if (error?.message === "integration.runner.root-writable") throw error;
}
mkdirSync(join(worktree, ".git", "refs", "heads"), { recursive: true });
writeFileSync(join(worktree, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(
  join(worktree, ".git", "config"),
  "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
);
writeFileSync(join(worktree, "README.md"), "isolated integration worktree\n");

const pointer = JSON.parse(
  readFileSync(join(candidateRoot, "current-candidate.json"), "utf8"),
);
if (
  pointer.pointerVersion !== 1 ||
  !/^sha256-[a-f\d]{64}$/u.test(pointer.bundleIdentity)
)
  throw new Error("integration.runner.candidate-pointer");
const selection = JSON.parse(
  readFileSync("/opt/agentscope/current-selection.json", "utf8"),
);
const manifest = JSON.parse(
  readFileSync("/opt/agentscope/capability-manifest.json", "utf8"),
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
  throw new Error("integration.runner.selection");
const directory = join(candidateRoot, "candidates", pointer.bundleIdentity);
const evidence = JSON.parse(
  readFileSync(join(directory, "evidence.json"), "utf8"),
);
if (
  evidence.bundleIdentity !== pointer.bundleIdentity ||
  evidence.candidateRevision !== pointer.candidateRevision ||
  evidence.scenarioNetworkPolicy !== "offline-no-package-or-registry-download"
)
  throw new Error("integration.runner.candidate-evidence");
if (
  JSON.stringify(readdirSync(directory).sort()) !==
  JSON.stringify(["evidence.json", "files"])
)
  throw new Error("integration.runner.candidate-inventory");
const declared = [evidence.lockfile, ...evidence.artifacts];
if (
  JSON.stringify(readdirSync(join(directory, "files")).sort()) !==
  JSON.stringify(declared.map(({ fileName }) => fileName).sort())
)
  throw new Error("integration.runner.candidate-inventory");
for (const file of declared) {
  const path = join(directory, "files", file.fileName);
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size !== file.bytes ||
    digest(readFileSync(path)) !== file.sha256
  )
    throw new Error("integration.runner.candidate-file");
}

for (const publicEndpoint of [
  "https://registry.npmjs.org/",
  "https://api.openai.com/",
]) {
  try {
    await fetch(publicEndpoint, { signal: AbortSignal.timeout(750) });
    throw new Error("integration.runner.public-egress");
  } catch (error) {
    if (error?.message === "integration.runner.public-egress") throw error;
  }
}
let response;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    response = await fetch(endpoint);
    if (response.ok) break;
  } catch {
    // The collector may still be starting inside the isolated network.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!response?.ok) throw new Error("integration.runner.collector");
if (process.env.AGENTSCOPE_INTEGRATION_TEST_MODE === "failure")
  throw new Error("integration.runner.expected-failure");
if (process.env.AGENTSCOPE_INTEGRATION_TEST_MODE === "interruption")
  await new Promise(() => setInterval(() => {}, 1_000));
writeFileSync(join(ledger, "scenario.json"), '{"status":"passed"}\n');
console.log("Integration scenario passed with public egress denied.");
