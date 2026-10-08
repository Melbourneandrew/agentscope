import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson, sha256 } from "./validation.mjs";

const reject = () => {
  throw new Error("release.admission.evidence");
};
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
).get;

function boundedDocument(value, depth = 0, count = { value: 0 }) {
  if (++count.value > 8192 || depth > 16) reject();
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value))
      boundedDocument(entry, depth + 1, count);
  }
  return value;
}
function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  )
    reject();
}

function preparedEvidence(value) {
  keys(value, [
    "evidenceVersion",
    "bundleIdentity",
    "candidateRevision",
    "platform",
    "lockfile",
    "artifacts",
    "scenarioNetworkPolicy",
  ]);
  keys(value.platform, ["os", "architecture", "nodeVersion"]);
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > 32
  )
    reject();
  if (
    ![value.platform.os, value.platform.architecture].every(
      (part) => typeof part === "string" && /^[a-z0-9-]{1,32}$/u.test(part),
    ) ||
    !/^\d+\.\d+\.\d+$/u.test(value.platform.nodeVersion) ||
    !/^[a-f0-9]{40,64}$/u.test(value.candidateRevision)
  )
    reject();
  const files = [value.lockfile, ...value.artifacts];
  for (const file of files) {
    keys(
      file,
      file === value.lockfile
        ? ["fileName", "bytes", "sha256"]
        : ["id", "kind", "fileName", "bytes", "sha256"],
    );
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(file.fileName) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 268_435_456 ||
      !/^sha256-[a-f0-9]{64}$/u.test(file.sha256)
    )
      reject();
    if (
      file !== value.lockfile &&
      (!/^[a-z][a-z0-9-]{0,63}$/u.test(file.id) ||
        !["npm-tarball", "runtime-archive", "runtime-binary"].includes(
          file.kind,
        ))
    )
      reject();
  }
  if (
    value.lockfile.fileName !== "pnpm-lock.yaml" ||
    new Set(files.map((file) => file.fileName)).size !== files.length ||
    new Set(value.artifacts.map((file) => file.id)).size !==
      value.artifacts.length
  )
    reject();
}

// Parse owned byte snapshots, not caller-selected object getters or labels.
export function parseAdmissionDocument(bytes) {
  if (
    types.isProxy(bytes) ||
    !Buffer.isBuffer(bytes) ||
    byteLength.call(bytes) > 1_048_576
  )
    reject();
  try {
    return boundedDocument(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return reject();
  }
}

// Inert projection of an operator attestation, not server authentication or
// release permission. The existing owner checkpoint must authenticate its
// submitter and bind this exact string to the phase, candidate and chain head.
// Keep the array inside the encoded string; recorder DTOs remain array-free.
export function projectOperatorControlsReport(encoded, expiresAt, observedAt) {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 4096)
    reject();
  const report = parseAdmissionDocument(Buffer.from(encoded));
  keys(report, [
    "state",
    "repository",
    "ownerId",
    "ownerLogin",
    "inspectedAt",
    "responseCount",
    "responses",
  ]);
  if (
    report.state !== "operator-controls-observed" ||
    report.repository !== "Melbourneandrew/agentscope" ||
    report.ownerId !== 25971425 ||
    report.ownerLogin !== "Melbourneandrew" ||
    report.responseCount !== 8 ||
    !Array.isArray(report.responses) ||
    report.responses.length !== 8
  )
    reject();
  const paths = [
    "/user",
    "/rulesets?per_page=100",
    null,
    null,
    "/immutable-releases",
    "/branches/main/protection",
    "/environments/npm-release",
    "/environments/npm-release/deployment-branch-policies?per_page=100",
  ];
  report.responses.forEach((response, index) => {
    keys(response, ["path", "bytes", "digest"]);
    if (
      typeof response.path !== "string" ||
      (paths[index] === null
        ? !/^\/rulesets\/[1-9][0-9]{0,15}$/u.test(response.path)
        : response.path !== paths[index]) ||
      !Number.isSafeInteger(response.bytes) ||
      response.bytes < 1 ||
      response.bytes > 1_048_576 ||
      typeof response.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(response.digest)
    )
      reject();
  });
  if (report.responses[2].path === report.responses[3].path) reject();
  const times = [report.inspectedAt, expiresAt, observedAt];
  if (
    times.some(
      (time) =>
        typeof time !== "string" ||
        !Number.isFinite(Date.parse(time)) ||
        new Date(Date.parse(time)).toISOString() !== time,
    )
  )
    reject();
  const [inspected, expires, observed] = times.map(Date.parse);
  if (
    expires <= inspected ||
    expires - inspected > 900_000 ||
    observed < inspected ||
    observed > expires
  )
    reject();
  return Object.freeze({
    controlsReportDigest: sha256(Buffer.from(encoded)),
    controlsInspectedAt: report.inspectedAt,
  });
}

// This is artifact binding only. It never promotes the producer's awaiting-
// release-gate disposition, a job conclusion, or a certification label.
export function bindPreparedCliEvidence(evidenceBytes, manifestBytes, tarball) {
  const evidence = parseAdmissionDocument(evidenceBytes);
  const manifest = parseAdmissionDocument(manifestBytes);
  if (types.isProxy(tarball) || !Buffer.isBuffer(tarball)) reject();
  const size = byteLength.call(tarball);
  if (size < 1 || size > 52_428_800) reject();
  if (
    evidence?.evidenceVersion !== 1 ||
    evidence.candidateRevision !== manifest?.sourceRevision ||
    evidence.scenarioNetworkPolicy !==
      "offline-no-package-or-registry-download" ||
    !Array.isArray(evidence.artifacts) ||
    evidence.artifacts.length < 1 ||
    evidence.artifacts.length > 32
  )
    reject();
  preparedEvidence(evidence);
  const { bundleIdentity, ...material } = evidence;
  if (
    sha256(canonicalJson(material)).replace("sha256:", "sha256-") !==
    bundleIdentity
  )
    reject();
  const selected = evidence.artifacts.filter(
    (item) => item?.id === "agentscope-cli",
  );
  const digest = sha256(tarball);
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (
    selected.length !== 1 ||
    selected[0].kind !== "npm-tarball" ||
    selected[0].bytes !== size ||
    selected[0].sha256 !== digest.replace("sha256:", "sha256-") ||
    manifest.tarball?.bytes !== size ||
    manifest.tarball.sha256 !== digest ||
    manifest.tarball.integrity !== integrity
  )
    reject();
  return Object.freeze({
    sourceRevision: evidence.candidateRevision,
    bundleIdentity,
    cliSha256: digest,
    cliIntegrity: integrity,
  });
}

// No retained producer currently supplies the genuine OTLP semantic graph
// required by 7z5. Missing actual evidence is a concrete prerequisite, not an
// assertion that existing byte/digest or scenario records certify it.
export function requireActualSemanticAdmission() {
  throw new Error("release.admission.actual-otlp-evidence-missing");
}
