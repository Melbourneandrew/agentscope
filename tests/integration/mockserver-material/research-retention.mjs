/** Research data only. A packet never authenticates caches, dependencies or support. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { parseMockServerResearchInventory } from "./research-inventory.mjs";

const inventoryLimit = 8 * 1024 * 1024;
const receiptLimit = 16 * 1024;
const files = ["inventory.json", "receipt.json"];
const fail = () => {
  throw new Error("integration.mockserver-material.research-retention");
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const keys = (value, names) =>
  value !== null &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype &&
  same(Object.keys(value).sort(), [...names].sort());
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const monotonic = (value) => Number.isFinite(value) && value >= 0;

// No accessors, proxies, inherited fields, sparse arrays or toJSON hooks are read.
const copyData = (input) => {
  let budget = 4096;
  const copy = (value, depth) => {
    if (--budget < 0 || depth > 8) fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length <= 4096) return value;
    if (typeof value !== "object" || types.isProxy(value)) fail();
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype) fail();
    const names = Object.keys(value);
    if (Reflect.ownKeys(value).length !== names.length + (array ? 1 : 0))
      fail();
    if (
      array &&
      (names.length !== value.length ||
        names.some((name, i) => name !== String(i)))
    )
      fail();
    const result = array ? [] : {};
    for (const name of names) {
      if (name === "__proto__" || name === "toJSON") fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !("value" in descriptor)) fail();
      Object.defineProperty(result, name, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(result);
  };
  return copy(input, 0);
};

const provenance = (input) => {
  const value = copyData(input);
  if (
    !keys(value, [
      "request",
      "sourceTree",
      "controllerAuthority",
      "runToken",
      "manifestIdentity",
      "preparedEvidenceSha256",
      "bootstrapVerificationSha256",
      "recipeSourcesSha256",
    ])
  )
    fail();
  const request = value.request;
  if (
    !keys(request, [
      "kind",
      "repository",
      "revision",
      "runId",
      "attempt",
      "workflowRef",
      "workflowRevision",
    ]) ||
    !Object.values(request).every((part) => typeof part === "string") ||
    !Object.entries(value)
      .filter(([key]) => key !== "request")
      .every(([, part]) => typeof part === "string") ||
    request.kind !== "supplier" ||
    !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(
      request.repository,
    ) ||
    !/^[a-f0-9]{40}$/u.test(request.revision) ||
    request.workflowRevision !== request.revision ||
    !/^[1-9]\d{0,19}$/u.test(request.runId) ||
    !/^[1-9]\d{0,5}$/u.test(request.attempt) ||
    typeof request.workflowRef !== "string" ||
    !/^[A-Za-z0-9_./@-]{1,512}$/u.test(request.workflowRef) ||
    !request.workflowRef.startsWith(
      `${request.repository}/.github/workflows/integration.yml@refs/heads/`,
    ) ||
    request.workflowRef.endsWith("/") ||
    request.workflowRef.includes("..") ||
    !/^[a-f0-9]{40}$/u.test(value.sourceTree) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.controllerAuthority) ||
    !/^[a-f0-9]{16}$/u.test(value.runToken) ||
    typeof value.manifestIdentity !== "string" ||
    !/^sha256-[a-f0-9]{64}$/u.test(value.manifestIdentity) ||
    ![
      value.preparedEvidenceSha256,
      value.bootstrapVerificationSha256,
      value.recipeSourcesSha256,
    ].every(digest)
  )
    fail();
  return value;
};
const stage = (input) => {
  const value = copyData(input);
  if (
    !keys(value, ["started", "finished", "deadline", "clientSettlement"]) ||
    ![value.started, value.finished, value.deadline].every(monotonic) ||
    value.finished < value.started ||
    value.finished >= value.deadline ||
    value.clientSettlement !== "closed-and-registered-for-outer-retirement"
  )
    fail();
  return value;
};
const identity = (status) =>
  Object.freeze({
    dev: status.dev,
    ino: status.ino,
    uid: status.uid,
    gid: status.gid,
    mode: status.mode & 0o7777,
  });
const fileIdentity = (status) =>
  Object.freeze({
    ...identity(status),
    bytes: status.size,
    nlink: status.nlink,
    mtimeMs: status.mtimeMs,
    ctimeMs: status.ctimeMs,
  });
const validIdentity = (value, file) =>
  keys(
    value,
    file
      ? [
          "dev",
          "ino",
          "uid",
          "gid",
          "mode",
          "bytes",
          "nlink",
          "mtimeMs",
          "ctimeMs",
        ]
      : ["dev", "ino", "uid", "gid", "mode"],
  ) &&
  [value.dev, value.ino, value.uid, value.gid].every(integer) &&
  value.ino > 0 &&
  value.mode === (file ? 0o600 : 0o700) &&
  (!file ||
    (integer(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= inventoryLimit &&
      value.nlink === 1 &&
      monotonic(value.mtimeMs) &&
      monotonic(value.ctimeMs)));
const guard = (deadline, signal) => {
  if (!monotonic(deadline) || signal.aborted || performance.now() >= deadline)
    fail();
};
const directory = (path, privateMode = true) => {
  if (realpathSync(path) !== resolve(path)) fail();
  const status = lstatSync(path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid?.() ||
    status.gid !== process.getgid?.() ||
    (privateMode
      ? (status.mode & 0o7777) !== 0o700
      : (status.mode & 0o022) !== 0)
  )
    fail();
  return identity(status);
};
const fileStatus = (status, maximum) => {
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.uid !== process.getuid?.() ||
    status.gid !== process.getgid?.() ||
    (status.mode & 0o7777) !== 0o600 ||
    status.size < 1 ||
    status.size > maximum
  )
    fail();
  return fileIdentity(status);
};
const read = (path, maximum, check) => {
  check();
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fileStatus(fstatSync(fd), maximum);
    const bytes = Buffer.alloc(before.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      check();
      const length = readSync(
        fd,
        bytes,
        offset,
        Math.min(65536, bytes.length - offset),
        offset,
      );
      if (length < 1) fail();
      offset += length;
    }
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      !same(before, fileStatus(fstatSync(fd), maximum)) ||
      !same(before, fileStatus(lstatSync(path), maximum))
    )
      fail();
    check();
    return Object.freeze({ bytes, identity: before });
  } finally {
    closeSync(fd);
  }
};
const write = (path, bytes, check) => {
  check();
  const fd = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    for (let offset = 0; offset < bytes.length;) {
      check();
      const length = writeSync(
        fd,
        bytes,
        offset,
        Math.min(65536, bytes.length - offset),
        offset,
      );
      if (length < 1) fail();
      offset += length;
    }
    check();
    fsyncSync(fd);
    check();
    if (
      !same(
        fileStatus(fstatSync(fd), bytes.length),
        fileStatus(lstatSync(path), bytes.length),
      )
    )
      fail();
  } finally {
    closeSync(fd);
  }
};
const syncDirectory = (path, check) => {
  check();
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(fd);
    check();
  } finally {
    closeSync(fd);
  }
};
const receipt = (input) => {
  const value = copyData(input);
  if (
    !keys(value, [
      "schemaVersion",
      "evidenceScope",
      "consumedDependencyClosure",
      "supportAdmission",
      "provenance",
      "stage",
      "cleanup",
      "directory",
      "inventory",
    ]) ||
    value.schemaVersion !== 1 ||
    value.evidenceScope !== "untrusted-cache-and-jar-research-only" ||
    value.consumedDependencyClosure !== "not-proved" ||
    value.supportAdmission !== "not-claimed"
  )
    fail();
  provenance(value.provenance);
  stage(value.stage);
  const cleanup = value.cleanup;
  if (
    !keys(cleanup, [
      "disposition",
      "completed",
      "deadline",
      "outerHostRetirement",
    ]) ||
    cleanup.disposition !== "canonical-clean-complete" ||
    cleanup.outerHostRetirement !== "external-not-observed" ||
    ![cleanup.completed, cleanup.deadline].every(monotonic) ||
    cleanup.completed < value.stage.finished ||
    cleanup.completed >= cleanup.deadline ||
    cleanup.deadline < value.stage.deadline ||
    !validIdentity(value.directory, false) ||
    !keys(value.inventory, ["identity", "sha256", "observedBytes"]) ||
    !validIdentity(value.inventory.identity, true) ||
    !digest(value.inventory.sha256) ||
    !integer(value.inventory.observedBytes) ||
    value.inventory.observedBytes < 1 ||
    value.inventory.observedBytes > 1024 * 1024 * 1024
  )
    fail();
  return value;
};

const packetEntries = (path, deadline, signal) => {
  const names = [];
  guard(deadline, signal);
  const handle = opendirSync(path, { bufferSize: 3 });
  try {
    while (names.length < 3) {
      guard(deadline, signal);
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  guard(deadline, signal);
  return names.sort();
};

/** Called only by the existing controller after canonical clean; failure leaves evidence quarantined. */
export const retainMockServerResearch = ({
  parent,
  inventory,
  provenance: inputProvenance,
  stage: inputStage,
  deadline,
  signal,
}) => {
  guard(deadline, signal);
  const parsed = parseMockServerResearchInventory(inventory);
  const bytes = encoded(parsed.record);
  const binding = provenance(inputProvenance);
  const stageRecord = stage(inputStage);
  const parentIdentity = directory(parent, false);
  const path = resolve(parent, "mockserver-research");
  // No adoption, replacement or deletion of a partial/stale/unknown directory.
  guard(deadline, signal);
  if (stageRecord.deadline > deadline) fail();
  mkdirSync(path, { mode: 0o700 });
  const rootIdentity = directory(path);
  const check = () => {
    guard(deadline, signal);
    if (
      !same(parentIdentity, directory(parent, false)) ||
      !same(rootIdentity, directory(path))
    )
      fail();
  };
  write(resolve(path, files[0]), bytes, check);
  const retained = read(resolve(path, files[0]), inventoryLimit, check);
  if (hash(retained.bytes) !== parsed.sha256) fail();
  const record = receipt({
    schemaVersion: 1,
    evidenceScope: "untrusted-cache-and-jar-research-only",
    consumedDependencyClosure: "not-proved",
    supportAdmission: "not-claimed",
    provenance: binding,
    stage: stageRecord,
    cleanup: {
      disposition: "canonical-clean-complete",
      completed: performance.now(),
      deadline,
      outerHostRetirement: "external-not-observed",
    },
    directory: rootIdentity,
    inventory: {
      identity: retained.identity,
      sha256: parsed.sha256,
      observedBytes: parsed.observedBytes,
    },
  });
  const receiptBytes = encoded(record);
  if (receiptBytes.length > receiptLimit) fail();
  syncDirectory(path, check);
  write(resolve(path, files[1]), receiptBytes, check); // complete receipt is always last
  syncDirectory(path, check);
  syncDirectory(parent, check);
  const verified = verifyMockServerResearch({
    parent,
    expectedProvenance: binding,
    deadline,
    signal,
  });
  check();
  return verified;
};

/** Independent before-upload filesystem verification. The caller must also prove settled exit 3. */
export const verifyMockServerResearch = ({
  parent,
  expectedProvenance,
  expectedSource,
  deadline,
  signal,
}) => {
  guard(deadline, signal);
  if (expectedProvenance !== undefined && expectedSource !== undefined) fail();
  const expected = copyData(expectedSource ?? expectedProvenance);
  const parentIdentity = directory(parent, false);
  const path = resolve(parent, "mockserver-research");
  const rootIdentity = directory(path);
  const check = () => {
    guard(deadline, signal);
    if (
      !same(parentIdentity, directory(parent, false)) ||
      !same(rootIdentity, directory(path)) ||
      !same(packetEntries(path, deadline, signal), files)
    )
      fail();
  };
  check();
  const receiptFile = read(resolve(path, files[1]), receiptLimit, check);
  const decoded = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(receiptFile.bytes);
  const record = receipt(JSON.parse(decoded));
  if (
    !same(encoded(record), receiptFile.bytes) ||
    !keys(
      expected,
      expectedSource === undefined
        ? Object.keys(record.provenance)
        : ["request", "sourceTree", "manifestIdentity", "recipeSourcesSha256"],
    ) ||
    Object.keys(expected).some(
      (key) => !same(record.provenance[key], expected[key]),
    ) ||
    !same(record.directory, rootIdentity)
  )
    fail();
  const inventoryFile = read(resolve(path, files[0]), inventoryLimit, check);
  const parsed = parseMockServerResearchInventory(inventoryFile.bytes);
  if (
    !same(record.inventory.identity, inventoryFile.identity) ||
    record.inventory.sha256 !== parsed.sha256 ||
    record.inventory.observedBytes !== parsed.observedBytes
  )
    fail();
  check();
  return Object.freeze({
    directory: path,
    inventorySha256: parsed.sha256,
    receiptSha256: hash(receiptFile.bytes),
    evidenceScope: "untrusted-cache-and-jar-research-only",
  });
};
