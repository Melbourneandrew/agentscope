/** Read-only before-upload verifier, not a scenario or support admission. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { git } from "./dist/controller-host-identity.js";
import { parseMockServerResearchRequest } from "./dist/mockserver-research-request.js";
import {
  compileCapabilityManifest,
  verifyManifestEvidence,
} from "./dist/index.js";
import { readMaterialSource } from "./harness-material-io.mjs";
import { mockServerResearchRecipeDigest } from "./mockserver-material/research-stage.mjs";
import { verifyMockServerResearch } from "./mockserver-material/research-retention.mjs";

const entered = performance.now();
const outer = process.env.AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS;
if (outer === undefined || !/^\d{7,15}$/u.test(outer))
  throw new Error("integration.mockserver-material.research-retention");
const budget = Math.min(
  5_000,
  Number(outer) -
    Number(readFileSync("/proc/uptime", "utf8").split(" ", 1)[0]) * 1000,
);
if (!Number.isFinite(budget) || budget <= 0)
  throw new Error("integration.mockserver-material.research-retention");
const deadline = entered + budget;
const remaining = () => {
  const value = Math.floor(deadline - performance.now());
  if (value < 1)
    throw new Error("integration.mockserver-material.research-retention");
  return Math.min(30_000, value);
};
const request = parseMockServerResearchRequest(
  process.env,
  "github-hosted",
  "lifecycle",
);
if (request.kind !== "supplier")
  throw new Error("integration.mockserver-material.research-request");
const workspaceRoot = resolve(import.meta.dirname, "../..");
if (git(workspaceRoot, ["rev-parse", "HEAD"], remaining()) !== request.revision)
  throw new Error("integration.mockserver-material.research-retention");
const manifest = compileCapabilityManifest(
  JSON.parse(
    readMaterialSource(
      resolve(import.meta.dirname, "capability-manifest.json"),
    ).bytes.toString("utf8"),
  ),
);
verifyManifestEvidence(manifest, import.meta.dirname);
verifyMockServerResearch({
  parent: resolve(workspaceRoot, "artifacts/integration"),
  deadline,
  signal: new AbortController().signal,
  expectedSource: {
    request,
    sourceTree: git(workspaceRoot, ["rev-parse", "HEAD^{tree}"], remaining()),
    manifestIdentity: manifest.manifestIdentity,
    recipeSourcesSha256: mockServerResearchRecipeDigest(),
  },
});
console.log("integration.mockserver-material.research-verified-not-certified");
