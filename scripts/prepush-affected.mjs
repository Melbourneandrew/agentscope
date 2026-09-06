import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const rootPolicyPath =
  /^(?:\.github\/|scripts\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|nx\.json$|eslint\.config\.mjs$|tsconfig(?:\.[^/]+)?\.json$|vitest\.config\.ts$)/u;

export const selectPrepushMode = (
  changedFiles,
  affectedProjects,
  baseAvailable,
) => ({
  full:
    !baseAvailable || changedFiles.some((path) => rootPolicyPath.test(path)),
  verifyCliArtifact:
    !baseAvailable ||
    changedFiles.some((path) => rootPolicyPath.test(path)) ||
    affectedProjects.includes("agentscope-cli"),
});

const capture = (executable, arguments_) =>
  spawnSync(executable, arguments_, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });

const lines = (value) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const run = (arguments_) => {
  const result = spawnSync("pnpm", arguments_, {
    cwd: resolve(import.meta.dirname, ".."),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) process.kill(process.pid, result.signal);
  if (result.status !== 0) process.exit(result.status ?? 1);
};

export const executePrepush = () => {
  const base = process.env.NX_BASE ?? "origin/main";
  const baseCheck = capture("git", [
    "rev-parse",
    "--verify",
    `${base}^{commit}`,
  ]);
  let changedFiles = [];
  let affectedProjects = [];
  let baseAvailable = baseCheck.status === 0;
  if (baseAvailable) {
    const changed = capture("git", ["diff", "--name-only", `${base}...HEAD`]);
    const affected = capture("pnpm", [
      "nx",
      "show",
      "projects",
      "--affected",
      `--base=${base}`,
      "--head=HEAD",
    ]);
    baseAvailable = changed.status === 0 && affected.status === 0;
    if (baseAvailable) {
      changedFiles = lines(changed.stdout);
      affectedProjects = lines(affected.stdout);
    }
  }
  const plan = selectPrepushMode(changedFiles, affectedProjects, baseAvailable);
  run(["verify:targets"]);
  run(["format:check"]);
  const selection = plan.full
    ? ["run-many", "--all"]
    : ["affected", `--base=${base}`, "--head=HEAD"];
  run(["nx", selection[0], "-t", "build", ...selection.slice(1)]);
  run(["nx", selection[0], "-t", "lint,typecheck,test", ...selection.slice(1)]);
  if (plan.verifyCliArtifact) run(["verify:cli-artifact"]);
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  executePrepush();
