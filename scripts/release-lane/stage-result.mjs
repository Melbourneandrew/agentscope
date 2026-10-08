import { types } from "node:util";

import { canonicalJson, sha256 } from "./validation.mjs";
import { parseAdmissionDocument } from "./admission.mjs";

const fail = () => {
  throw new Error("release.stage-result.invalid");
};
const digest = /^sha256:[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const tupleKeys = [
  "kind",
  "transactionId",
  "candidateManifestDigest",
  "tarballSha256",
  "integrity",
  "sourceRevision",
  "protectedTag",
  "package",
  "version",
  "distTag",
  "workflowDigest",
  "releaseScriptsDigest",
  "ownerCheckpointDigest",
];

// Snapshot inert inputs, never execute getters, toJSON, iterators or proxy traps.
// A digest establishes byte equality only; it never authenticates its producer.
export function snapshotRecorderInput(input) {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set();
  const copy = (value, depth) => {
    if (++nodes > 256 || depth > 8) fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      if (bytes > 16_384 || value.length > 4096) fail();
      return value;
    }
    if (typeof value !== "object" || types.isProxy(value) || seen.has(value))
      fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    seen.add(value);
    const result = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 32) fail();
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 64) fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !descriptor.enumerable
      )
        fail();
      result[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(value);
    return Object.freeze(result);
  };
  return copy(input, 0);
}

export function recorderExactKeys(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  )
    fail();
}

export function validateStageTuple(input) {
  const tuple = snapshotRecorderInput(input);
  recorderExactKeys(tuple, tupleKeys);
  if (
    typeof tuple.transactionId !== "string" ||
    !identifier.test(tuple.transactionId) ||
    tuple.package !== "agentscope-cli" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(tuple.integrity) ||
    !/^[a-f0-9]{40}$/u.test(tuple.sourceRevision)
  )
    fail();
  for (const key of [
    "candidateManifestDigest",
    "tarballSha256",
    "workflowDigest",
    "releaseScriptsDigest",
    "ownerCheckpointDigest",
  ]) {
    if (typeof tuple[key] !== "string" || !digest.test(tuple[key])) fail();
  }
  if (tuple.kind === "product") {
    if (
      tuple.version !== "0.1.0" ||
      tuple.distTag !== "alpha" ||
      tuple.protectedTag !== "v0.1.0"
    )
      fail();
  } else if (tuple.kind === "probe") {
    if (
      !/^0\.0\.0-oidc-probe\.[a-z0-9][a-z0-9-]{0,63}$/u.test(tuple.version) ||
      tuple.distTag !== "oidc-probe" ||
      tuple.protectedTag !== null
    )
      fail();
  } else fail();
  return tuple;
}

// Shared product/probe projection. Authentication of retained workflow bytes and
// provenance is a future integration responsibility, not a caller boolean here.
export function validateStageResult(input, expectedInput) {
  const expected = validateStageTuple(expectedInput);
  const result = snapshotRecorderInput(input);
  recorderExactKeys(result, ["schemaVersion", "tuple", "response", "stageId"]);
  const tuple = validateStageTuple(result.tuple);
  if (
    result.schemaVersion !== 1 ||
    canonicalJson(tuple) !== canonicalJson(expected)
  )
    fail();
  if (result.response === "received") {
    if (typeof result.stageId !== "string" || !identifier.test(result.stageId))
      fail();
  } else if (
    !["missing", "ambiguous"].includes(result.response) ||
    result.stageId !== null
  )
    fail();
  return Object.freeze({
    ...result,
    tuple,
    stageResultDigest: sha256(canonicalJson(result)),
  });
}

// npm 11.17's stage publish --json emits { [packageName]: tarballContents },
// adding stageId only after the registry response. Project that standard output
// into the existing result; missing/uncertain responses never invent an ID or
// authorize a retry. The workflow must separately authenticate this producer.
export function projectNpmStageResponse(bytes, expectedInput) {
  const tuple = validateStageTuple(expectedInput);
  let response = "ambiguous";
  let stageId = null;
  if (!types.isProxy(bytes) && Buffer.isBuffer(bytes) && bytes.length === 0) {
    response = "missing";
  } else {
    try {
      const output = parseAdmissionDocument(bytes);
      recorderExactKeys(output, [tuple.package]);
      const packageResult = output[tuple.package];
      if (
        packageResult?.name !== tuple.package ||
        packageResult.version !== tuple.version ||
        packageResult.id !== `${tuple.package}@${tuple.version}` ||
        packageResult.integrity !== tuple.integrity ||
        typeof packageResult.stageId !== "string" ||
        !identifier.test(packageResult.stageId)
      )
        fail();
      response = "received";
      stageId = packageResult.stageId;
    } catch {
      // Preserve uncertainty, not npm output or a fabricated stage identity.
    }
  }
  return Object.freeze({ schemaVersion: 1, tuple, response, stageId });
}
