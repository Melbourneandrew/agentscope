/** Validation, persistence, and publication of prepared-image evidence. */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import {
  IMAGE_PREPARATION_EXECUTION_POLICY,
  digestPattern,
  exactKeys,
  fixedError,
  imagePattern,
  manifestIdentityPattern,
  maximumEvidenceBytes,
  normalizePlatform,
  samePlatform,
  validEvidenceDaemon,
  validPreparationPolicy,
  validSocketEvidence,
  validTerminalCleanup,
} from "./boundary.mjs";
import { decodeProof, deriveManifestProof } from "./registry.mjs";

export const evidenceImage = (value) => {
  if (
    !exactKeys(value, [
      "configDigest",
      "configBlob",
      "image",
      "manifestDigest",
      "platform",
      "rootManifest",
      "selectedManifest",
    ]) ||
    !imagePattern.test(value.image ?? "") ||
    !digestPattern.test(value.manifestDigest ?? "") ||
    !digestPattern.test(value.configDigest ?? "")
  )
    throw fixedError("integration.images.evidence");
  let derived;
  try {
    derived = deriveManifestProof({
      image: value.image,
      platform: value.platform,
      configRaw: decodeProof(value.configBlob),
      rootRaw: decodeProof(value.rootManifest),
      selectedRaw: decodeProof(value.selectedManifest),
    });
  } catch {
    throw fixedError("integration.images.evidence");
  }
  if (
    value.manifestDigest !== derived.manifestDigest ||
    value.configDigest !== derived.configDigest ||
    !samePlatform(value.platform, derived.platform) ||
    !exactKeys(
      value.platform,
      derived.platform.variant === undefined
        ? ["architecture", "os"]
        : ["architecture", "os", "variant"],
    )
  )
    throw fixedError("integration.images.evidence");
  return Object.freeze({ image: value.image, ...derived });
};

const serializePreparedImageEvidence = (
  value,
  maximumBytes = maximumEvidenceBytes,
) => {
  let serialized;
  try {
    serialized = `${JSON.stringify(value, undefined, 2)}\n`;
  } catch {
    throw fixedError("integration.images.evidence");
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > maximumEvidenceBytes ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  )
    throw fixedError("integration.images.evidence");
  return serialized;
};

export const validatePreparedImageEvidence = (value, manifestIdentity) => {
  serializePreparedImageEvidence(value);
  if (
    !exactKeys(value, [
      "dockerDaemon",
      "dockerSocket",
      "imageEvidenceVersion",
      "images",
      "manifestIdentity",
      "preparationPolicy",
      "terminalCleanup",
    ]) ||
    value.imageEvidenceVersion !== 2 ||
    value.manifestIdentity !== manifestIdentity ||
    !manifestIdentityPattern.test(value.manifestIdentity ?? "") ||
    !validSocketEvidence(value.dockerSocket) ||
    !validEvidenceDaemon(value.dockerDaemon) ||
    !validPreparationPolicy(value.preparationPolicy) ||
    !validTerminalCleanup(value.terminalCleanup) ||
    value.dockerDaemon.endpoint !== value.dockerSocket.path ||
    value.dockerDaemon.socketDevice !== value.dockerSocket.device ||
    value.dockerDaemon.socketInode !== value.dockerSocket.inode ||
    !Array.isArray(value.images) ||
    value.images.length === 0 ||
    value.images.length > 256
  )
    throw fixedError("integration.images.evidence");
  const images = value.images.map(evidenceImage);
  const canonicalPlatform = normalizePlatform(
    IMAGE_PREPARATION_EXECUTION_POLICY.platform,
  );
  if (
    new Set(images.map(({ image }) => image)).size !== images.length ||
    images.some(({ platform }) => !samePlatform(platform, canonicalPlatform)) ||
    Buffer.byteLength(JSON.stringify(images), "utf8") > maximumEvidenceBytes
  )
    throw fixedError("integration.images.evidence");
  return Object.freeze({
    imageEvidenceVersion: 2,
    manifestIdentity,
    dockerSocket: Object.freeze({ ...value.dockerSocket }),
    dockerDaemon: Object.freeze({ ...value.dockerDaemon }),
    preparationPolicy: Object.freeze({ ...value.preparationPolicy }),
    terminalCleanup: Object.freeze({ ...value.terminalCleanup }),
    images: Object.freeze(images),
  });
};

export const readPreparedImageEvidence = (path, manifestIdentity) => {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.size < 1 ||
      status.size > maximumEvidenceBytes
    )
      throw fixedError("integration.images.evidence");
    const body = readFileSync(descriptor);
    if (body.byteLength !== status.size)
      throw fixedError("integration.images.evidence");
    return validatePreparedImageEvidence(
      JSON.parse(body.toString("utf8")),
      manifestIdentity,
    );
  } catch {
    throw fixedError("integration.images.evidence");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const publishPreparedImageEvidence = (
  state,
  target,
  manifestIdentity,
  prepared,
  options = {},
) => {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    if (!state.hasPreparedSet(prepared))
      throw fixedError("integration.images.publication");
    const evidence = {
      imageEvidenceVersion: 2,
      manifestIdentity,
      ...prepared,
    };
    validatePreparedImageEvidence(evidence, manifestIdentity);
    const serialized = serializePreparedImageEvidence(
      evidence,
      options.maximumEvidenceBytesForTesting,
    );
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(descriptor, serialized);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
  } catch {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw fixedError("integration.images.cleanup");
    }
    throw fixedError("integration.images.publication");
  }
};

export const retirePreparedImageEvidence = (target) => {
  try {
    unlinkSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw fixedError("integration.images.retirement");
  }
};

export const createEvidenceOperations = (state) =>
  Object.freeze({
    publishPreparedImageEvidence: (
      target,
      manifestIdentity,
      prepared,
      options = {},
    ) =>
      publishPreparedImageEvidence(
        state,
        target,
        manifestIdentity,
        prepared,
        options,
      ),
  });
