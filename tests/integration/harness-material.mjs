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
const commandSource = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "harness-material-command.mjs",
);
const preparedMaterials = new WeakMap();

const fail = () => {
  throw new Error("integration.harness-material.failed");
};

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

const download = (descriptor, signal, deadline) =>
  new Promise((resolveDownload, rejectDownload) => {
    const url = new URL(descriptor.tarballUrl ?? descriptor.url);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.port !== ""
    ) {
      rejectDownload(new Error("registry identity"));
      return;
    }
    let settled = false;
    let requestHandle;
    let responseHandle;
    let terminalError;
    let terminalValue;
    const chunks = [];
    let bytes = 0;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (terminalError === undefined && terminalValue !== undefined)
        resolveDownload(terminalValue);
      else rejectDownload(terminalError ?? new Error("incomplete"));
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
    requestHandle = request(
      {
        agent: false,
        ca: rootCertificates,
        hostname: url.hostname,
        maxHeaderSize: maximumHeaderBytes,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        protocol: "https:",
        rejectUnauthorized: true,
        servername: url.hostname,
      },
      (response) => {
        responseHandle = response;
        if (
          response.statusCode !== 200 ||
          response.headers.location !== undefined ||
          response.headers["content-encoding"] !== undefined ||
          (response.headers["content-length"] !== undefined &&
            response.headers["content-length"] !== String(descriptor.bytes))
        ) {
          response.destroy();
          stop(new Error("response"));
          return;
        }
        response.on("data", (chunk) => {
          bytes += chunk.byteLength;
          if (bytes > descriptor.bytes) stop(new Error("size"));
          else chunks.push(chunk);
        });
        response.once("error", stop);
        response.once("end", () => {
          if (bytes !== descriptor.bytes) stop(new Error("size"));
          else terminalValue = Buffer.concat(chunks);
        });
      },
    );
    requestHandle.once("error", stop);
    requestHandle.once("close", settle);
    requestHandle.end();
  });

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
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
  policy,
  root,
  runId,
  signal,
}) => {
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
  const imageId = await buildPreparedDockerImage(client, {
    buildArguments: { BASE_IMAGE: material.verifierImage },
    context,
    dockerfile: "Verifier.Dockerfile",
    labels: {
      "com.agentscope.integration": "true",
      "com.agentscope.integration.run": runId,
    },
    maximumBuildContextBytes: maximumAuditBytes,
    maximumMilliseconds: remaining(deadline),
    signal,
    tag,
  });
  await retirePreparedDockerImage(client, { imageId, signal, tag });
  if (signal.aborted) fail();
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
// eslint-disable-next-line max-lines-per-function
export const prepareNpmHarnessMaterial = async (input) => {
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
        total + descriptor.bytes + descriptor.attestations.bytes,
      0,
    );
    if (
      !Number.isSafeInteger(aggregateBytes) ||
      aggregateBytes < 1 ||
      aggregateBytes > maximumAggregateArchiveBytes
    )
      fail();
    const tarballs = new Map();
    const attestations = new Map();
    for (const descriptor of material.packages) {
      if (
        new URL(descriptor.tarballUrl).origin !==
          new URL(material.registry).origin ||
        descriptor.attestations.url !==
          `https://registry.npmjs.org/-/npm/v1/attestations/${descriptor.packageName.replace("/", "%2f")}@${descriptor.version}`
      )
        fail();
      const archive = await download(descriptor, signal, deadline);
      tarballs.set(`${descriptor.packageName}@${descriptor.version}`, archive);
      const attestationBytes = await download(
        descriptor.attestations,
        signal,
        deadline,
      );
      if (
        createHash("sha256").update(attestationBytes).digest("hex") !==
        descriptor.attestations.sha256
      )
        fail();
      attestations.set(
        `${descriptor.packageName}@${descriptor.version}`,
        attestationBytes,
      );
    }
    const audit = compileNpmAttestationAudit(material, attestations);
    const policy = {
      packages: material.packages.map((descriptor) => {
        const verified = audit.verified.find(
          (entry) => entry.name === descriptor.packageName,
        );
        return {
          ...descriptor,
          attestationBundleDigest: createHash("sha256")
            .update(canonical(verified.attestationBundles))
            .digest("hex"),
        };
      }),
      registry: material.registry,
    };
    const verifier = await runMaterialVerification({
      client: dockerClient,
      deadline,
      material,
      operation: "npm-verify",
      policy,
      root,
      runId,
      signal,
    });
    const authority = compileVerifiedNpmHarnessMaterial({
      audit,
      evidenceId,
      material,
      tarballs,
      verifier: { ...verifier, name: "npm" },
    });
    const token = Object.freeze({
      authorityVersion: 1,
      authorityKind: "authenticated-harness-material",
    });
    sameDirectory(owned);
    rmSync(resolve(root, "verifier"), { force: true, recursive: true });
    for (const bytes of attestations.values()) bytes.fill(0);
    preparedMaterials.set(token, { authority, owned, tarballs });
    return token;
  } catch (error) {
    if (owned !== undefined) {
      try {
        sameDirectory(owned);
        rmSync(owned.path, { recursive: true });
      } catch {
        // The disposable outer-host controller retains the root for exact
        // failure reconciliation when its identity can no longer be proved.
      }
    }
    if (
      error instanceof Error &&
      error.message === "integration.harness-material.failed"
    )
      throw error;
    fail(error);
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
    sameDirectory(owned);
    for (const name of ["verifier"])
      rmSync(resolve(root, name), { force: true, recursive: true });
    const token = Object.freeze({
      authorityVersion: 1,
      authorityKind: "authenticated-harness-material",
    });
    preparedMaterials.set(token, {
      authority,
      binary: objects.binary,
      owned,
    });
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
  sameDirectory(value.owned);
  rmSync(value.owned.path);
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
  sameDirectory(value.owned);
  rmSync(value.owned.path);
  preparedMaterials.delete(token);
};
