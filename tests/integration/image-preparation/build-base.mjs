/** One finite local OCI input, owned by the existing builder operation. */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { fixedError } from "./boundary.mjs";
import {
  acquireManifestProof,
  acquireNodeBaseLayer,
  decodeProof,
  deriveManifestProof,
  registryTransport,
} from "./registry.mjs";

const image =
  "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2";
const manifestDigest =
  "sha256:bb6834c0669aa71cbc8d94606561a721adf489f6b93d7b8b825f0cf1b498c2c4";
const configDigest =
  "sha256:a1bea2f8c1ee78866f82039a60baa1c3a480872018aa0ef4891000ec793ed82b";
const totalBytes = 405_976_201;
const digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = () => {
  throw fixedError("integration.images.build.base");
};
const active = (deadline, signal) => {
  if (signal?.aborted) throw fixedError("integration.images.interrupted");
  if (performance.now() >= deadline)
    throw fixedError("integration.images.timeout", true);
};
const directory = (path) => {
  try {
    const status = lstatSync(path, { bigint: true });
    if (
      !status.isDirectory() ||
      realpathSync(path) !== path ||
      Number(status.mode & 0o777n) !== 0o700 ||
      Number(status.uid) !== process.getuid()
    )
      fail();
    return { path, status };
  } catch {
    fail();
  }
};
const sameDirectory = (entry) => {
  const current = directory(entry.path);
  if (
    current.status.dev !== entry.status.dev ||
    current.status.ino !== entry.status.ino
  )
    fail();
};
const sameFile = (left, right) =>
  ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (field) => left[field] === right[field],
  );

const proofObjects = (entry) => {
  if (entry?.image !== image) fail();
  const rootRaw = decodeProof(entry.rootManifest);
  const selectedRaw = decodeProof(entry.selectedManifest);
  const configRaw = decodeProof(entry.configBlob);
  const proof = deriveManifestProof({
    image,
    platform: entry.platform,
    rootRaw,
    selectedRaw,
    configRaw,
  });
  if (
    proof.manifestDigest !== manifestDigest ||
    proof.configDigest !== configDigest ||
    proof.platform.os !== "linux" ||
    proof.platform.architecture !== "amd64" ||
    proof.platform.variant !== undefined ||
    rootRaw.length !== 6410 ||
    selectedRaw.length !== 2493 ||
    configRaw.length !== 6629
  )
    fail();
  const manifest = JSON.parse(selectedRaw.toString("utf8"));
  const layers = manifest.layers;
  if (
    manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    layers.length !== 8 ||
    new Set(layers.map((layer) => layer.digest)).size !== 8 ||
    layers.some(
      (layer) =>
        !/^sha256:[a-f\d]{64}$/u.test(layer.digest) ||
        layer.mediaType !== "application/vnd.oci.image.layer.v1.tar+gzip" ||
        !Number.isSafeInteger(layer.size) ||
        layer.size < 1 ||
        layer.size > 211_394_364,
    ) ||
    layers.reduce((sum, layer) => sum + layer.size, 0) !== 405_960_347
  )
    fail();
  const index = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: manifest.mediaType,
          digest: manifestDigest,
          size: selectedRaw.length,
          platform: proof.platform,
        },
      ],
    })}\n`,
  );
  const layout = Buffer.from('{"imageLayoutVersion":"1.0.0"}\n');
  if (index.length !== 291 || layout.length !== 31) fail();
  return {
    proof,
    layers,
    files: [
      [image.split("@")[1], rootRaw],
      [manifestDigest, selectedRaw],
      [configDigest, configRaw],
      ["index.json", index],
      ["oci-layout", layout],
    ],
  };
};

const createRoot = (owned, context) => {
  owned.parent = directory(dirname(resolve(context)));
  owned.context = directory(resolve(context));
  owned.path = resolve(
    owned.parent.path,
    `agentscope-build-base-${randomBytes(8).toString("hex")}`,
  );
  sameDirectory(owned.parent);
  mkdirSync(owned.path, { mode: 0o700 });
  owned.created = true;
  owned.root = directory(owned.path);
  owned.directories.push(owned.root);
  for (const name of ["blobs", "blobs/sha256"]) {
    sameDirectory(owned.root);
    const path = resolve(owned.path, name);
    mkdirSync(path, { mode: 0o700 });
    owned.directories.push(directory(path));
  }
};
const put = (owned, name, bytes, deadline, signal) => {
  active(deadline, signal);
  for (const entry of owned.directories) sameDirectory(entry);
  if (owned.bytes + bytes.length > totalBytes || owned.files.length >= 13)
    fail();
  const path = resolve(
    owned.path,
    name.startsWith("sha256:") ? `blobs/sha256/${name.slice(7)}` : name,
  );
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const file = {
      path,
      expectedDigest: digest(bytes),
      status: fstatSync(fd, { bigint: true }),
    };
    owned.files.push(file);
    for (let offset = 0; offset < bytes.length;) {
      active(deadline, signal);
      const count = writeSync(
        fd,
        bytes,
        offset,
        Math.min(1_048_576, bytes.length - offset),
      );
      if (count < 1) fail();
      offset += count;
    }
    file.status = fstatSync(fd, { bigint: true });
    if (
      !file.status.isFile() ||
      file.status.size !== BigInt(bytes.length) ||
      file.status.nlink !== 1n ||
      Number(file.status.mode & 0o777n) !== 0o600 ||
      Number(file.status.uid) !== process.getuid()
    )
      fail();
    owned.bytes += bytes.length;
  } catch (error) {
    if (
      ["integration.images.interrupted", "integration.images.timeout"].includes(
        error?.message,
      )
    )
      throw error;
    fail();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
const checkFile = (file, deadline, signal) => {
  let fd;
  try {
    active(deadline, signal);
    fd = openSync(
      file.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const status = fstatSync(fd, { bigint: true });
    if (!status.isFile() || !sameFile(status, file.status)) fail();
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1_048_576);
    let remaining = Number(status.size);
    while (remaining > 0) {
      active(deadline, signal);
      const count = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, remaining),
        null,
      );
      if (count < 1) fail();
      hash.update(chunk.subarray(0, count));
      remaining -= count;
    }
    if (
      readSync(fd, chunk, 0, 1, null) !== 0 ||
      `sha256:${hash.digest("hex")}` !== file.expectedDigest ||
      !sameFile(status, fstatSync(fd, { bigint: true })) ||
      !sameFile(status, lstatSync(file.path, { bigint: true }))
    )
      fail();
  } catch (error) {
    if (
      ["integration.images.interrupted", "integration.images.timeout"].includes(
        error?.message,
      )
    )
      throw error;
    fail();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
const inventory = (owned, deadline, signal) => {
  const expected = new Set([
    ...owned.files.map((file) => file.path),
    ...owned.directories.slice(1).map((entry) => entry.path),
  ]);
  for (const entry of owned.directories) {
    active(deadline, signal);
    sameDirectory(entry);
    const handle = opendirSync(entry.path, { bufferSize: 1 });
    try {
      for (let count = 0; ; count += 1) {
        active(deadline, signal);
        const child = handle.readSync();
        if (child === null) break;
        if (count >= 13 || !expected.delete(resolve(entry.path, child.name)))
          fail();
      }
    } finally {
      handle.closeSync();
    }
  }
  if (expected.size !== 0) fail();
};
const validate = (owned, deadline, signal) => {
  sameDirectory(owned.parent);
  sameDirectory(owned.context);
  inventory(owned, deadline, signal);
  for (const file of owned.files) checkFile(file, deadline, signal);
  active(deadline, signal);
};
const remove = (owned, deadline) => {
  if (!owned.created) return;
  if (owned.root === undefined) fail();
  validate(owned, deadline);
  for (const file of owned.files) {
    active(deadline);
    sameDirectory(owned.root);
    checkFile(file, deadline);
    unlinkSync(file.path);
  }
  for (const entry of [...owned.directories].reverse()) {
    active(deadline);
    sameDirectory(owned.parent);
    sameDirectory(entry);
    rmdirSync(entry.path);
  }
  owned.created = false;
  active(deadline);
};

/** A callback uses the existing build authority, not a second executor. */
export const withBuildBase = async (
  input,
  operation,
  markUncertain,
  canRemove,
) => {
  if (input.baseImage === undefined) return operation(undefined);
  const { client, context, policy, signal } = input;
  if (input.baseImage !== image) fail();
  const entries = client.evidence.images.filter(
    (entry) => entry.image === image,
  );
  if (entries.length !== 1) fail();
  const material = proofObjects(entries[0]);
  const owned = { created: false, bytes: 0, files: [], directories: [] };
  let primary;
  let failed = false;
  let value;
  try {
    active(policy.workDeadline, signal);
    createRoot(owned, context);
    const transport = registryTransport;
    const tokenCache = new Map();
    const current = await acquireManifestProof({
      image,
      platform: entries[0].platform,
      policy,
      signal,
      transport,
      tokenCache,
    });
    if (JSON.stringify(current) !== JSON.stringify(material.proof)) fail();
    for (const [name, bytes] of material.files)
      put(owned, name, bytes, policy.workDeadline, signal);
    for (const layer of material.layers) {
      const bytes = await acquireNodeBaseLayer({
        ...layer,
        image,
        policy,
        signal,
        tokenCache,
        transport,
      });
      active(policy.workDeadline, signal);
      if (bytes.length !== layer.size || digest(bytes) !== layer.digest) fail();
      put(owned, layer.digest, bytes, policy.workDeadline, signal);
    }
    if (
      owned.bytes !== totalBytes ||
      owned.files.length !== 13 ||
      owned.directories.length !== 3
    )
      fail();
    validate(owned, policy.workDeadline, signal);
    value = await operation({
      context: `oci-layout://${owned.path}@${manifestDigest}`,
      validate: () => validate(owned, policy.workDeadline, signal),
    });
    validate(owned, policy.deadline, signal);
  } catch (error) {
    primary = error;
    failed = true;
  }
  try {
    if (owned.created && !canRemove()) fail();
    remove(owned, policy.deadline);
  } catch (error) {
    markUncertain();
    if (!failed) {
      primary = error;
      failed = true;
    }
  }
  if (failed) throw primary;
  return value;
};
