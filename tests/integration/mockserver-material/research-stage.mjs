/* eslint import-x/no-cycle: "off" -- the existing private controller owns the live capability */
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  integrationStageSignal,
  registerIntegrationRunIds,
  remainingIntegrationOperationMilliseconds,
  requireDisposableOuterHostCapability,
} from "../dist/controller.js";
import {
  compileCapabilityManifest,
  verifyManifestEvidence,
} from "../dist/index.js";
import { readMaterialSource } from "../harness-material-io.mjs";
import {
  closePreparedDockerClient,
  createPreparedDockerClient,
  imagePreparationFailureRequiresOuterHostRetirement,
  preparedDockerClientRequiresOuterHostRetirement,
  readPreparedImageEvidence,
} from "../image-preparation.mjs";
import { researchMockServerSupplier } from "./prepare-supplier.mjs";
import { parseMockServerResearchInventory } from "./research-inventory.mjs";

const recipeSources = Object.freeze([
  "bootstrap-archive.mjs",
  "bootstrap-gpg.mjs",
  "bootstrap-metadata.mjs",
  "bootstrap-pin.json",
  "build-recipe.mjs",
  "build-tool-archive.mjs",
  "build-tool-pin.json",
  "callback-patch.mjs",
  "prepare-bootstrap.mjs",
  "prepare-supplier.mjs",
  "source-archive.mjs",
  "source-pin.json",
  "supplier-command.mjs",
  "supplier-inventory.mjs",
]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
/** A reproducible source observation, not tool/dependency authenticity. */
export const mockServerResearchRecipeDigest = () =>
  hash(
    JSON.stringify(
      recipeSources.map((name) => {
        const source = readMaterialSource(resolve(import.meta.dirname, name));
        return { name, bytes: source.bytes.length, sha256: source.sha256 };
      }),
    ),
  );

/** Uses a fresh existing client; no client or mutation authority crosses stages. */
export const runMockServerResearchStage = async (input) => {
  const capability = requireDisposableOuterHostCapability();
  const { request, sourceTree } = input;
  const started = performance.now();
  const deadline = started + remainingIntegrationOperationMilliseconds(300_000);
  const signal = integrationStageSignal();
  const check = () => {
    if (signal.aborted || performance.now() >= deadline)
      throw new Error("integration.mockserver-material.research-stage");
  };
  check();
  const integrationRoot = resolve(import.meta.dirname, "..");
  const artifactsRoot = resolve(
    capability.binding.workspaceRoot,
    "artifacts/integration",
  );
  const sourceDigest = mockServerResearchRecipeDigest();
  const manifest = compileCapabilityManifest(
    JSON.parse(
      readMaterialSource(
        resolve(integrationRoot, "capability-manifest.json"),
      ).bytes.toString("utf8"),
    ),
  );
  verifyManifestEvidence(manifest, integrationRoot);
  const evidence = readPreparedImageEvidence(
    resolve(artifactsRoot, "current-images.json"),
    manifest.manifestIdentity,
  );
  const evidenceDigest = hash(JSON.stringify(evidence));
  const runToken = randomBytes(8).toString("hex");
  registerIntegrationRunIds([runToken]);
  let client;
  let pending;
  let failed = false;
  let cause;
  try {
    check();
    client = createPreparedDockerClient(evidence, {
      deadline,
      signal,
      dockerEnvironment: capability.binding.dockerEnvironment,
      dockerExecutable: capability.binding.dockerExecutable,
      dockerSocket: evidence.dockerSocket.path,
    });
    const result = await researchMockServerSupplier({
      deadline,
      signal,
      dockerClient: client,
      privateRoot: capability.binding.privateStorage.root,
      runId: runToken,
    });
    check();
    const parsed = parseMockServerResearchInventory(result.inventory);
    if (mockServerResearchRecipeDigest() !== sourceDigest)
      throw new Error("integration.mockserver-material.research-stage");
    pending = Object.freeze({
      inventory: Buffer.from(`${JSON.stringify(parsed.record)}\n`),
      provenance: Object.freeze({
        request,
        sourceTree,
        controllerAuthority: capability.binding.privateStorage.authorityDigest,
        runToken,
        manifestIdentity: manifest.manifestIdentity,
        preparedEvidenceSha256: evidenceDigest,
        bootstrapVerificationSha256: hash(
          JSON.stringify(result.bootstrapVerification),
        ),
        recipeSourcesSha256: sourceDigest,
      }),
    });
  } catch (error) {
    failed = true;
    cause = error;
  }
  if (
    (client !== undefined &&
      preparedDockerClientRequiresOuterHostRetirement(client)) ||
    (failed && imagePreparationFailureRequiresOuterHostRetirement(cause))
  )
    throw new Error("integration.controller.unsettled-operation");
  if (client !== undefined) {
    try {
      closePreparedDockerClient(client);
    } catch {
      throw new Error("integration.controller.unsettled-operation");
    }
  }
  if (failed) throw cause;
  check();
  if (pending === undefined)
    throw new Error("integration.mockserver-material.research-stage");
  return Object.freeze({
    ...pending,
    stage: Object.freeze({
      started,
      finished: performance.now(),
      deadline,
      clientSettlement: "closed-and-registered-for-outer-retirement",
    }),
  });
};
