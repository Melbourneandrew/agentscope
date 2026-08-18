import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { resolve } from "node:path";

import { prepareCandidate } from "./dist/artifacts.js";

const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const cliManifest = JSON.parse(
  readFileSync(resolve(workspaceRoot, "apps/cli/package.json"), "utf8"),
);
if (typeof cliManifest.version !== "string")
  throw new Error("integration.artifact.cli-version");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: workspaceRoot,
  encoding: "utf8",
}).trim();
const worktreeState = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all"],
  { cwd: workspaceRoot, encoding: "utf8" },
).trim();
if (worktreeState.length > 0)
  throw new Error("integration.artifact.worktree-dirty");
const integrationArtifacts = resolve(workspaceRoot, "artifacts/integration");
const prepared = prepareCandidate({
  candidateRevision: revision,
  platform: {
    os: platform(),
    architecture: arch(),
    nodeVersion: process.versions.node,
  },
  lockfilePath: resolve(workspaceRoot, "pnpm-lock.yaml"),
  outputRoot: resolve(integrationArtifacts, "candidates"),
  artifacts: [
    {
      id: "agentscope-cli",
      kind: "npm-tarball",
      path: resolve(
        workspaceRoot,
        `artifacts/npm/agentscope-cli-${cliManifest.version}.tgz`,
      ),
    },
  ],
});
mkdirSync(integrationArtifacts, { recursive: true });
const pointer = resolve(integrationArtifacts, "current-candidate.json");
const temporaryPointer = `${pointer}.${process.pid}.tmp`;
writeFileSync(
  temporaryPointer,
  `${JSON.stringify(
    {
      pointerVersion: 1,
      bundleIdentity: prepared.evidence.bundleIdentity,
      candidateRevision: prepared.evidence.candidateRevision,
    },
    undefined,
    2,
  )}\n`,
);
renameSync(temporaryPointer, pointer);
process.stdout.write(
  `${JSON.stringify({ directory: prepared.directory, evidence: prepared.evidence })}\n`,
);
