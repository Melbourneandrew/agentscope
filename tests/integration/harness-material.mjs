/* eslint import-x/no-cycle: "off" -- authenticated prepared-Docker capability */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:https";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";

import {
  compileNpmAttestationAudit,
  compileNpmVerifierPolicy,
  compileVerifiedNpmHarnessMaterial,
  compileVerifiedSignedManifestHarnessMaterial,
} from "./dist/harness-material.js";
import {
  buildPreparedDockerImage,
  retirePreparedDockerImage,
} from "./image-preparation.mjs";

const maximumAuditBytes = 8 * 1024 * 1024;
const maximumAggregateArchiveBytes = 320 * 1024 * 1024;
const maximumHeaderBytes = 16 * 1024;
const materialRetirementReserveMilliseconds = 5_000;
const materialSettlementReserveMilliseconds = 1_000;
const commandSource = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "harness-material-command.mjs",
);
const preparedMaterials = new WeakMap();

const fail = () => {
  throw new Error("integration.harness-material.failed");
};
const phaseFailure = (phase) =>
  new Error("integration.harness-material.failed", {
    cause: new Error(`integration.harness-material.${phase}`),
  });

const remaining = (deadline) => {
  const value = Math.floor(deadline - performance.now());
  if (!Number.isSafeInteger(value) || value < 1) fail();
  return value;
};

const exactDirectory = (path) => {
  const status = lstatSync(path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o7777) !== 0o700 ||
    status.uid !== process.getuid?.() ||
    status.gid !== process.getgid?.()
  )
    fail();
  return Object.freeze({ dev: status.dev, ino: status.ino, path });
};

const sameDirectory = (identity) => {
  const current = exactDirectory(identity.path);
  if (current.dev !== identity.dev || current.ino !== identity.ino) fail();
};

export const retireEmptyAuthenticatedHarnessMaterialDirectory = (identity) => {
  sameDirectory(identity);
  // rmdir refuses unexpected children; rm on a directory fails with EISDIR
  // on Linux even when the authenticated verifier root is empty.
  rmdirSync(identity.path);
};

const commandSourceAuthority = (() => {
  const descriptor = openSync(
    commandSource,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.byteLength !== before.size ||
      bytes.byteLength < 1 ||
      bytes.byteLength > 1_048_576
    )
      fail();
    return Object.freeze({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    closeSync(descriptor);
  }
})();

const writeExclusive = (path, bytes) => {
  const descriptor = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.size !== bytes.byteLength ||
    (status.mode & 0o7777) !== 0o600
  )
    fail();
};

export const classifyMaterialResponseForTesting = (response, expectedBytes) => {
  if (response.statusCode === 429) return "rate-limit";
  if (response.statusCode >= 500 && response.statusCode <= 599)
    return "upstream";
  if (response.statusCode !== 200) return "status";
  if (response.headers.location !== undefined) return "redirect";
  if (response.headers["content-encoding"] !== undefined) return "encoding";
  if (
    response.headers["content-length"] !== undefined &&
    response.headers["content-length"] !== String(expectedBytes)
  ) {
    const observed = response.headers["content-length"];
    if (typeof observed !== "string" || !/^[0-9]+$/u.test(observed))
      return "hdr-invalid";
    const length = BigInt(observed);
    if (length === BigInt(expectedBytes)) return "hdr-noncanon";
    return length < BigInt(expectedBytes) ? "hdr-short" : "hdr-long";
  }
};

const headerReasons = ["hdr-short", "hdr-long", "hdr-noncanon", "hdr-invalid"];
const downloadFailureReasons = new Map([
  ["registry identity", "identity"],
  ["integration.harness-material.failed", "deadline"],
  ...[
    "rate-limit",
    "upstream",
    "status",
    "redirect",
    "encoding",
    ...headerReasons,
    "size",
    "incomplete",
    "interrupted",
    "deadline",
  ].map((reason) => [reason, reason]),
]);
export const classifyMaterialDownloadFailureForTesting = (error) =>
  downloadFailureReasons.get(error instanceof Error ? error.message : "") ??
  "transport";

export const classifyAttestationFailurePhaseForTesting = (descriptor, error) =>
  `download-attestation-${descriptor.installName === descriptor.packageName ? "root" : "variant"}-${classifyMaterialDownloadFailureForTesting(error)}`;

const materialRequestOptions = (url) => ({
  agent: false,
  ca: rootCertificates,
  hostname: url.hostname,
  maxHeaderSize: maximumHeaderBytes,
  method: "GET",
  path: `${url.pathname}${url.search}`,
  protocol: "https:",
  rejectUnauthorized: true,
  servername: url.hostname,
});
const authorizedMaterialUrl = (url) =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.hash === "" &&
  url.port === "";

const download = (
  descriptor,
  signal,
  deadline,
  transport = request,
  metadata = false,
) =>
  new Promise((resolveDownload, rejectDownload) => {
    if (signal.aborted) {
      rejectDownload(new Error("interrupted"));
      return;
    }
    const url = new URL(descriptor.tarballUrl ?? descriptor.url);
    if (!authorizedMaterialUrl(url)) {
      rejectDownload(new Error("registry identity"));
      return;
    }
    let settled = false;
    let requestHandle;
    let responseHandle;
    let terminalError;
    let terminalValue;
    let requestClosed = false;
    let responseClosed = false;
    const chunks = [];
    let bytes = 0;
    const settle = () => {
      if (settled) return;
      if (terminalError === undefined) {
        if (signal.aborted) terminalError = new Error("interrupted");
        else if (performance.now() >= deadline)
          terminalError = new Error("deadline");
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (terminalError === undefined && terminalValue !== undefined)
        resolveDownload(terminalValue);
      else rejectDownload(terminalError ?? new Error("incomplete"));
    };
    const maybeSettle = () => {
      if (requestClosed && (responseHandle === undefined || responseClosed))
        settle();
    };
    const stop = (error) => {
      terminalError ??= error;
      responseHandle?.destroy();
      requestHandle?.destroy();
    };
    const onAbort = () => stop(new Error("interrupted"));
    const timer = setTimeout(
      () => stop(new Error("deadline")),
      remaining(deadline),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    requestHandle = transport(materialRequestOptions(url), (response) => {
      responseHandle = response;
      const advertised = response.headers["content-length"];
      const expectedBytes = metadata
        ? typeof advertised === "string" &&
          /^[1-9][0-9]{0,5}$/u.test(advertised)
          ? Number(advertised)
          : undefined
        : descriptor.bytes;
      const rejection =
        metadata && advertised !== undefined && expectedBytes === undefined
          ? "hdr-invalid"
          : metadata && expectedBytes > descriptor.maximumBytes
            ? "size"
            : classifyMaterialResponseForTesting(response, expectedBytes);
      response.once("aborted", () => stop(new Error("incomplete")));
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > (metadata ? descriptor.maximumBytes : descriptor.bytes))
          stop(new Error("size"));
        else chunks.push(chunk);
      });
      response.once("error", stop);
      response.once("end", () => {
        if (
          bytes < 1 ||
          (expectedBytes !== undefined && bytes !== expectedBytes) ||
          (metadata && !response.complete)
        )
          stop(new Error("size"));
        else terminalValue = Buffer.concat(chunks);
      });
      response.once("close", () => {
        responseClosed = true;
        if (metadata && terminalValue === undefined)
          terminalError ??= new Error("incomplete");
        maybeSettle();
      });
      if (rejection !== undefined) stop(new Error(rejection));
    });
    requestHandle.once("error", stop);
    requestHandle.once("close", () => {
      requestClosed = true;
      maybeSettle();
    });
    requestHandle.end();
  });

export const downloadRegularHarnessMaterialForTesting = (
  descriptor,
  signal,
  deadline,
  transport,
) => download(descriptor, signal, deadline, transport);

// The API envelope is bounded transport, not an immutable artifact. Its
// canonical signed bundles are pinned by the compiler and then checked against
// the SAME bundles returned by fresh pinned npm cryptographic verification.
export const downloadAttestationMetadata = (
  descriptor,
  signal,
  deadline,
  transport = request,
) => {
  if (
    !Number.isSafeInteger(descriptor.maximumBytes) ||
    descriptor.maximumBytes < 1 ||
    descriptor.maximumBytes > 65_536
  )
    fail();
  return download(descriptor, signal, deadline, transport, true);
};

const assertNpmPackageDescriptors = (material) => {
  for (const descriptor of material.packages)
    if (
      new URL(descriptor.tarballUrl).origin !==
        new URL(material.registry).origin ||
      descriptor.attestations.url !==
        `https://registry.npmjs.org/-/npm/v1/attestations/${descriptor.packageName.replace("/", "%2f")}@${descriptor.version}`
    )
      fail();
};

const acquireNpmAttestation = async (descriptor, signal, deadline, onPhase) => {
  onPhase("download-attestation");
  let bytes;
  try {
    bytes = await downloadAttestationMetadata(
      descriptor.attestations,
      signal,
      deadline,
    );
  } catch (error) {
    onPhase(classifyAttestationFailurePhaseForTesting(descriptor, error));
    throw error;
  }
  return bytes;
};

const verifierImage = (client, image) => {
  const matches = client?.evidence?.images?.filter(
    (candidate) => candidate.image === image,
  );
  if (matches?.length !== 1) fail();
  return matches[0];
};
const runMaterialVerification = async ({
  client,
  deadline,
  material,
  operation,
  onPhase = () => {},
  policy,
  root,
  runId,
  signal,
}) => {
  onPhase("verify-context");
  if (signal.aborted) fail();
  const image = verifierImage(client, material.verifierImage);
  const context = resolve(root, "verifier");
  if (!existsSync(context)) mkdirSync(context, { mode: 0o700 });
  exactDirectory(context);
  writeExclusive(
    resolve(context, "material-command.mjs"),
    commandSourceAuthority.bytes,
  );
  writeExclusive(
    resolve(context, "policy.json"),
    Buffer.from(`${JSON.stringify(policy)}\n`),
  );
  const dockerfile = [
    "ARG BASE_IMAGE",
    "FROM ${BASE_IMAGE}",
    "WORKDIR /verify",
    "COPY . /verify/",
    `RUN --network=${operation === "gpg-verify" ? "none" : "default"} ${JSON.stringify(["node", "/verify/material-command.mjs", operation, "/verify"])}`,
    "RUN rm -rf /verify/home /verify/gpg-home /verify/node_modules /verify/package-lock.json /verify/package.json /verify/audit.json",
  ].join("\n");
  writeExclusive(
    resolve(context, "Verifier.Dockerfile"),
    Buffer.from(`${dockerfile}\n`),
  );
  const tag = `agentscope-material-verifier:${createHash("sha256")
    .update(`${runId}:${operation}:${commandSourceAuthority.sha256}`)
    .digest("hex")
    .slice(0, 24)}`;
  const retirementBoundary = deadline - materialSettlementReserveMilliseconds;
  const buildDeadline =
    retirementBoundary - materialRetirementReserveMilliseconds;
  onPhase("verify-build");
  const imageId = await buildPreparedDockerImage(client, {
    buildArguments: { BASE_IMAGE: material.verifierImage },
    context,
    dockerfile: "Verifier.Dockerfile",
    labels: {
      "com.agentscope.integration": "true",
      "com.agentscope.integration.run": runId,
    },
    maximumBuildContextBytes: maximumAuditBytes,
    maximumMilliseconds: remaining(buildDeadline),
    retirementRequired: true,
    signal,
    tag,
  });
  const retirementDeadline = Math.min(
    retirementBoundary,
    performance.now() + materialRetirementReserveMilliseconds,
  );
  onPhase("verify-retire");
  await retirePreparedDockerImage(client, {
    deadline: retirementDeadline,
    imageId,
    signal,
    tag,
  });
  if (signal.aborted || performance.now() >= deadline) fail();
  return {
    controllerSha256: commandSourceAuthority.sha256,
    image: image.image,
    imageConfigDigest: image.configDigest,
    imageId,
    imageManifestDigest: image.manifestDigest,
  };
};

// One acquisition authority must span download, verification, publication,
// and identity-checked cleanup without delegating a restartable sub-phase.
export const prepareNpmHarnessMaterial = async (input) => {
  let owned;
  let phase = "preflight";
  try {
    const {
      dockerClient,
      evidenceId,
      material,
      privateRoot,
      runId,
      signal,
      maximumMilliseconds,
    } = input;
    if (
      material?.kind !== "npm" ||
      !Number.isSafeInteger(maximumMilliseconds) ||
      maximumMilliseconds < 1 ||
      maximumMilliseconds > 300_000 ||
      !/^[a-f0-9]{16}$/u.test(runId ?? "") ||
      signal?.aborted
    )
      fail();
    const parent = exactDirectory(privateRoot);
    const root = resolve(privateRoot, `harness-${evidenceId}`);
    mkdirSync(root, { mode: 0o700 });
    owned = exactDirectory(root);
    if (owned.dev !== parent.dev || !root.startsWith(`${parent.path}/`)) fail();
    const deadline = performance.now() + maximumMilliseconds;
    const aggregateBytes = material.packages.reduce(
      (total, descriptor) =>
        total + descriptor.bytes + descriptor.attestations.maximumBytes,
      0,
    );
    if (
      !Number.isSafeInteger(aggregateBytes) ||
      aggregateBytes < 1 ||
      aggregateBytes > maximumAggregateArchiveBytes
    )
      fail();
    phase = "validate-package";
    assertNpmPackageDescriptors(material);
    const tarballs = new Map();
    const attestations = new Map();
    for (const descriptor of material.packages) {
      phase = "download-tarball";
      const archive = await download(descriptor, signal, deadline);
      tarballs.set(`${descriptor.packageName}@${descriptor.version}`, archive);
      const attestationBytes = await acquireNpmAttestation(
        descriptor,
        signal,
        deadline,
        (value) => {
          phase = value;
        },
      );
      attestations.set(
        `${descriptor.packageName}@${descriptor.version}`,
        attestationBytes,
      );
    }
    phase = "compile-audit";
    const audit = compileNpmAttestationAudit(material, attestations);
    const policy = compileNpmVerifierPolicy(material, audit);
    phase = "verify";
    const verifier = await runMaterialVerification({
      client: dockerClient,
      deadline,
      material,
      operation: "npm-verify",
      onPhase: (value) => {
        phase = value;
      },
      policy,
      root,
      runId,
      signal,
    });
    phase = "compile-authority";
    const authority = compileVerifiedNpmHarnessMaterial({
      audit,
      evidenceId,
      material,
      tarballs,
      verifier: { ...verifier, name: "npm" },
    });
    phase = "publish";
    if (performance.now() >= deadline) fail();
    const token = Object.freeze({
      authorityVersion: 1,
      authorityKind: "authenticated-harness-material",
    });
    sameDirectory(owned);
    rmSync(resolve(root, "verifier"), { force: true, recursive: true });
    for (const bytes of attestations.values()) bytes.fill(0);
    if (performance.now() >= deadline) fail();
    preparedMaterials.set(token, { authority, owned, tarballs });
    if (performance.now() >= deadline) {
      preparedMaterials.delete(token);
      fail();
    }
    return token;
  } catch {
    if (owned !== undefined) {
      try {
        sameDirectory(owned);
        rmSync(owned.path, { recursive: true });
      } catch {
        // The disposable outer-host controller retains the root for exact
        // failure reconciliation when its identity can no longer be proved.
      }
    }
    throw phaseFailure(phase);
  }
};

const runSignedManifestVerification = async ({
  deadline,
  dockerClient,
  material,
  objects,
  root,
  runId,
  signal,
}) => {
  const context = resolve(root, "verifier");
  mkdirSync(context, { mode: 0o700 });
  for (const name of ["key", "manifest", "signature"])
    writeExclusive(resolve(context, name), objects[name]);
  const verifier = await runMaterialVerification({
    client: dockerClient,
    deadline,
    material,
    operation: "gpg-verify",
    policy: {
      primaryFingerprint: material.signingKey.fingerprint,
      signatureHashAlgorithm: material.signingKey.signatureHashAlgorithm,
      signerFingerprint: material.signingKey.signerFingerprint,
      uid: material.signingKey.uid,
    },
    root,
    runId,
    signal,
  });
  return {
    primaryFingerprint: material.signingKey.fingerprint,
    manifestSha256: createHash("sha256").update(objects.manifest).digest("hex"),
    signatureHashAlgorithm: material.signingKey.signatureHashAlgorithm,
    uid: material.signingKey.uid,
    signerFingerprint: material.signingKey.signerFingerprint,
    verifier: {
      ...verifier,
      name: "gpg",
    },
  };
};

const prepareSignedManifestHarnessMaterial = async (input) => {
  let owned;
  try {
    const {
      dockerClient,
      evidenceId,
      material,
      privateRoot,
      runId,
      signal,
      maximumMilliseconds,
    } = input;
    if (
      material?.kind !== "signed-release-manifest" ||
      !Number.isSafeInteger(maximumMilliseconds) ||
      maximumMilliseconds < 1 ||
      maximumMilliseconds > 300_000 ||
      !/^[a-f0-9]{16}$/u.test(runId ?? "") ||
      signal?.aborted
    )
      fail();
    const parent = exactDirectory(privateRoot);
    const root = resolve(privateRoot, `harness-${evidenceId}`);
    mkdirSync(root, { mode: 0o700 });
    owned = exactDirectory(root);
    if (owned.dev !== parent.dev || !root.startsWith(`${parent.path}/`)) fail();
    const deadline = performance.now() + maximumMilliseconds;
    const descriptors = {
      binary: material.binary,
      key: material.signingKey,
      manifest: material.manifest,
      signature: material.signature,
    };
    const totalBytes = Object.values(descriptors).reduce(
      (total, descriptor) => total + descriptor.bytes,
      0,
    );
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 1 ||
      totalBytes > maximumAggregateArchiveBytes
    )
      fail();
    const objects = {};
    for (const [name, descriptor] of Object.entries(descriptors))
      objects[name] = await download(descriptor, signal, deadline);
    const verification = await runSignedManifestVerification({
      deadline,
      dockerClient,
      material,
      objects,
      root,
      runId,
      signal,
    });
    const authority = compileVerifiedSignedManifestHarnessMaterial({
      binary: objects.binary,
      evidenceId,
      manifestBytes: objects.manifest,
      material,
      signatureBytes: objects.signature,
      signingKeyBytes: objects.key,
      verification,
    });
    if (performance.now() >= deadline) fail();
    sameDirectory(owned);
    for (const name of ["verifier"])
      rmSync(resolve(root, name), { force: true, recursive: true });
    if (performance.now() >= deadline) fail();
    const token = Object.freeze({
      authorityVersion: 1,
      authorityKind: "authenticated-harness-material",
    });
    preparedMaterials.set(token, {
      authority,
      binary: objects.binary,
      owned,
    });
    if (performance.now() >= deadline) {
      preparedMaterials.delete(token);
      fail();
    }
    return token;
  } catch (error) {
    if (owned !== undefined) {
      try {
        sameDirectory(owned);
        rmSync(owned.path, { recursive: true });
      } catch {
        // Outer disposable-host reconciliation retains ambiguous state.
      }
    }
    if (
      error instanceof Error &&
      error.message === "integration.harness-material.failed"
    )
      throw error;
    fail();
  }
};

const prepared = (token) => {
  const value = preparedMaterials.get(token);
  if (value === undefined) fail();
  return value;
};

export const inspectPreparedNpmHarnessMaterial = (token) =>
  prepared(token).authority;

export const stagePreparedNpmHarnessMaterial = (token, target) => {
  const value = prepared(token);
  mkdirSync(target, { mode: 0o700 });
  exactDirectory(target);
  for (const descriptor of value.authority.packages) {
    const bytes = value.tarballs.get(
      `${descriptor.packageName}@${descriptor.version}`,
    );
    if (bytes === undefined) fail();
    writeExclusive(resolve(target, descriptor.fileName), bytes);
  }
};

export const retirePreparedNpmHarnessMaterial = (token) => {
  const value = prepared(token);
  for (const bytes of value.tarballs.values()) bytes.fill(0);
  retireEmptyAuthenticatedHarnessMaterialDirectory(value.owned);
  preparedMaterials.delete(token);
};

export const prepareHarnessMaterial = async (input) => {
  if (input.material?.kind === "npm") return prepareNpmHarnessMaterial(input);
  if (input.material?.kind === "signed-release-manifest")
    return prepareSignedManifestHarnessMaterial(input);
  fail();
};

export const inspectPreparedHarnessMaterial = (token) =>
  prepared(token).authority;

export const stagePreparedHarnessMaterial = (token, target) => {
  const value = prepared(token);
  if (value.authority.kind === "npm") {
    stagePreparedNpmHarnessMaterial(token, target);
    return;
  }
  mkdirSync(target, { mode: 0o700 });
  exactDirectory(target);
  writeExclusive(
    resolve(target, value.authority.binary.fileName),
    value.binary,
  );
};

export const retirePreparedHarnessMaterial = (token) => {
  const value = prepared(token);
  if (value.authority.kind === "npm") {
    retirePreparedNpmHarnessMaterial(token);
    return;
  }
  value.binary.fill(0);
  retireEmptyAuthenticatedHarnessMaterialDirectory(value.owned);
  preparedMaterials.delete(token);
};
