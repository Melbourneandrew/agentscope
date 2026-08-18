import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const integrationRoot = import.meta.dirname;
const runsRoot = resolve(integrationRoot, "../../artifacts/integration/runs");
mkdirSync(runsRoot, { recursive: true });
const label = "com.agentscope.integration=true";
const labeledContainers = () =>
  execFileSync(
    "docker",
    ["container", "ls", "--all", "--quiet", "--filter", `label=${label}`],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
const noResourcesRemain = () => {
  const checks = [
    ["container", "ls", "--all", "--quiet", "--filter", `label=${label}`],
    ["network", "ls", "--quiet", "--filter", `label=${label}`],
    ["image", "ls", "--quiet", "--filter", `label=${label}`],
  ];
  return checks.every(
    (arguments_) =>
      execFileSync("docker", arguments_, { encoding: "utf8" }).trim() === "",
  );
};
const runDirectories = () =>
  new Set(
    readdirSync(runsRoot, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? [entry.name] : [],
    ),
  );
const wait = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const runMode = async (mode, interrupt) => {
  const before = runDirectories();
  const child = spawn(
    process.execPath,
    [resolve(integrationRoot, "run-scenarios.mjs")],
    {
      env: { ...process.env, AGENTSCOPE_INTEGRATION_TEST_MODE: mode },
      stdio: "ignore",
    },
  );
  if (interrupt) {
    let observed = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (labeledContainers().length > 0) {
        observed = true;
        break;
      }
      await wait(100);
    }
    if (!observed) throw new Error("integration.isolation.verify-start");
    child.kill("SIGINT");
  }
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", resolvePromise);
  });
  if (exitCode === 0) throw new Error("integration.isolation.verify-exit");
  if (!noResourcesRemain())
    throw new Error("integration.isolation.verify-cleanup");
  const created = [...runDirectories()].filter((name) => !before.has(name));
  if (created.length !== 1)
    throw new Error("integration.isolation.verify-evidence");
  return JSON.parse(
    readFileSync(resolve(runsRoot, created[0], "evidence.json"), "utf8"),
  );
};

const failure = await runMode("failure", false);
if (failure.outcome !== "failed")
  throw new Error("integration.isolation.verify-failure");
const interruption = await runMode("interruption", true);
if (interruption.outcome !== "interrupted")
  throw new Error("integration.isolation.verify-interruption");
console.log("Verified Docker teardown after failure and interruption.");
