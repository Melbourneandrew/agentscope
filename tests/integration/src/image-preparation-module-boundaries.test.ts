import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as imagePreparation from "../image-preparation.mjs";
import type {
  PreparedDockerClient,
  PreparedDockerImageSet,
} from "../image-preparation.mjs";
import * as stateModule from "../image-preparation/state.mjs";

describe("image-preparation module boundaries", () => {
  it("preserves the exact public facade surface", () => {
    expect(Object.keys(imagePreparation).sort()).toEqual([
      "BUILDKIT_IMAGE",
      "IMAGE_PREPARATION_EXECUTION_POLICY",
      "IMAGE_PREPARATION_LIMITS",
      "assertImagePreparationPlatformForTesting",
      "authenticateDockerSocketAliasForTesting",
      "buildPreparedDockerImage",
      "classifyBuildxStderrForTesting",
      "closePreparedDockerClient",
      "createBoundedBuildContext",
      "createPreparedDockerClient",
      "handlePreparedDockerCleanupFailure",
      "imagePreparationFailureRequiresOuterHostRetirement",
      "markPreparedDockerClientForOuterHostRetirement",
      "prepareDockerInvocation",
      "preparePinnedDockerImages",
      "preparedDockerClientDiagnostic",
      "preparedDockerClientRequiresOuterHostRetirement",
      "probePinnedRegistryTlsForTesting",
      "publishPreparedImageEvidence",
      "readPreparedImageEvidence",
      "retirePreparedDockerImage",
      "retirePreparedImageEvidence",
      "revalidatePreparedImageAdmission",
      "runOwnedImageCommandForTesting",
      "validatePreparedImageEvidence",
    ]);
    expect(imagePreparation.runOwnedImageCommandForTesting.name).toBe(
      "runOwnedImageCommandForTesting",
    );
    expect(imagePreparation.publishPreparedImageEvidence.length).toBe(3);
    expect(imagePreparation.publishPreparedImageEvidence.name).toBe(
      "publishPreparedImageEvidence",
    );
  });

  it("keeps the facade lifecycle authority private from deep importers", () => {
    expect(Object.keys(stateModule)).toEqual(["createImagePreparationState"]);

    const foreignState = stateModule.createImagePreparationState();
    const forgedPrepared = Object.freeze({});
    const forgedClient = Object.freeze({});

    expect(Object.isFrozen(foreignState)).toBe(true);
    expect(Object.isFrozen(foreignState.docker)).toBe(true);
    expect(Object.isFrozen(foreignState.evidence)).toBe(true);
    expect(Object.isFrozen(foreignState.retirement)).toBe(true);
    expect(
      Object.values(foreignState)
        .flatMap((projection) => Object.values(projection))
        .some((value) => value instanceof WeakMap || value instanceof WeakSet),
    ).toBe(false);

    foreignState.docker.admitPreparedSet(forgedPrepared);
    foreignState.docker.admitClient(forgedClient);

    expect(() => {
      imagePreparation.publishPreparedImageEvidence(
        `/tmp/agentscope-forged-image-preparation-${randomUUID()}.json`,
        "sha256:".concat("0".repeat(64)),
        forgedPrepared as unknown as PreparedDockerImageSet,
      );
    }).toThrow("integration.images.publication");
    expect(() => {
      imagePreparation.markPreparedDockerClientForOuterHostRetirement(
        forgedClient as unknown as PreparedDockerClient,
      );
    }).toThrow("integration.images.docker-client");
  });
});
