import * as fs from "node:fs";
import { resolve } from "node:path";

import * as validation from "./validation.mjs";

const digest = /^sha256-[a-f0-9]{64}$/u;
const ociDigest = /^sha256:[a-f0-9]{64}$/u;
const runPattern = /^[a-f0-9]{16}$/u;
const harnesses = [
  "@agentscope/harness-codex",
  "@agentscope/harness-claude-code",
];
const phases = "install configure hook execute export retrieve uninstall".split(
  " ",
);
const maximumBytes = 1_048_576;
const equal = (left, right) =>
  validation.canonicalJson(left) === validation.canonicalJson(right);
const hash = (value) => validation.sha256(validation.canonicalJson(value));
const integrationHash = (value) => hash(value).replace("sha256:", "sha256-");
const requireValue = (condition) =>
  validation.assert(condition, "Release evidence binding drifted");
const boundedArray = (value, maximum = 64) => {
  requireValue(
    Array.isArray(value) && value.length > 0 && value.length <= maximum,
  );
  return value;
};
const unique = (values) => requireValue(new Set(values).size === values.length);
const keys = (value, names) =>
  validation.assertExactKeys(
    value,
    typeof names === "string" ? names.split(" ") : names,
    "release evidence",
  );

// Only inert retained JSON is read. No controller/kernel authority is recreated.
export function readReleaseEvidence(root, relativePath) {
  requireValue(
    typeof relativePath === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9./_-]{0,255}$/u.test(relativePath),
  );
  const parts = relativePath.split("/");
  requireValue(
    parts.every((part) => part !== "" && part !== "." && part !== ".."),
  );
  let path = resolve(root);
  requireValue(
    fs.lstatSync(path).isDirectory() && !fs.lstatSync(path).isSymbolicLink(),
  );
  for (const part of parts.slice(0, -1)) {
    path = resolve(path, part);
    requireValue(
      fs.lstatSync(path).isDirectory() && !fs.lstatSync(path).isSymbolicLink(),
    );
  }
  const descriptor = fs.openSync(
    resolve(path, parts.at(-1)),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    requireValue(
      before.isFile() &&
        before.size > 0n &&
        before.size <= BigInt(maximumBytes),
    );
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fs.fstatSync(descriptor, { bigint: true });
    requireValue(
      bytes.length <= maximumBytes &&
        BigInt(bytes.length) === before.size &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mode === after.mode &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
    );
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    fs.closeSync(descriptor);
  }
}

function candidateMatches(candidate, manifest) {
  keys(
    candidate,
    "evidenceVersion bundleIdentity candidateRevision platform lockfile artifacts scenarioNetworkPolicy",
  );
  const { bundleIdentity, ...material } = candidate;
  requireValue(
    candidate.evidenceVersion === 1 &&
      digest.test(bundleIdentity) &&
      integrationHash(material) === bundleIdentity &&
      candidate.candidateRevision === manifest.sourceRevision &&
      candidate.scenarioNetworkPolicy ===
        "offline-no-package-or-registry-download",
  );
  keys(candidate.platform, ["os", "architecture", "nodeVersion"]);
  const files = [candidate.lockfile, ...boundedArray(candidate.artifacts, 32)];
  for (const value of files) {
    keys(
      value,
      value === candidate.lockfile
        ? ["fileName", "bytes", "sha256"]
        : ["id", "kind", "fileName", "bytes", "sha256"],
    );
    requireValue(
      digest.test(value.sha256) &&
        Number.isSafeInteger(value.bytes) &&
        value.bytes > 0 &&
        value.bytes <= 256 * 1024 * 1024 &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value.fileName),
    );
  }
  unique(files.map(({ fileName }) => fileName));
  unique(candidate.artifacts.map(({ id }) => id));
  const cli = candidate.artifacts.filter(({ id }) => id === "agentscope-cli");
  requireValue(
    cli.length === 1 &&
      cli[0].kind === "npm-tarball" &&
      cli[0].bytes === manifest.tarball.bytes &&
      cli[0].sha256.replace("sha256-", "sha256:") === manifest.tarball.sha256,
  );
}

function catalogRow(seed) {
  return {
    productIdentity: seed.productIdentity,
    harness: {
      registryIdentity: seed.harness.registryIdentity,
      evidenceSlot: seed.harness.evidenceSlot,
      exactVersion: seed.harness.exactVersion,
    },
    execution: seed.execution,
    platformIdentity: seed.platformIdentity,
    destinationCombinationIdentity: seed.destinationCombinationIdentity,
  };
}

function validateRow(row) {
  keys(
    row,
    "productIdentity harness execution platformIdentity destinationCombinationIdentity",
  );
  keys(row.harness, ["registryIdentity", "evidenceSlot", "exactVersion"]);
  keys(row.execution, ["mode", "outputContract"]);
  requireValue(
    row.productIdentity === "agentscope-cli" &&
      harnesses.includes(row.harness.registryIdentity) &&
      /^[a-z][a-z0-9-]{0,63}$/u.test(row.harness.evidenceSlot) &&
      /^\d+\.\d+\.\d+$/u.test(row.harness.exactVersion) &&
      ((row.execution.mode === "headless" &&
        row.execution.outputContract === "jsonl") ||
        (row.execution.mode === "interactive" &&
          row.execution.outputContract === "semantic-pty")) &&
      digest.test(row.platformIdentity) &&
      row.destinationCombinationIdentity ===
        integrationHash({ destinations: ["otlp-ledger"] }),
  );
  return integrationHash(row);
}

function validateEntry(entry, candidate, manifest) {
  keys(
    entry,
    "harnessType evidenceSlot testedVersion catalogRowIdentity contractSuiteDigest realScenarioDigest binding",
  );
  keys(entry.binding, ["seed", "controller", "completion"]);
  const { seed, controller, completion } = entry.binding;
  keys(
    seed,
    "admissionVersion runId candidateDigest manifestIdentity scenarioId catalogRowIdentity productIdentity harness execution component platformIdentity destinationCombinationIdentity preparedImage",
  );
  keys(controller, ["authorityIdentity", "hostKind", "workspaceRevision"]);
  keys(
    completion,
    "completionVersion runId requestFingerprint observationPlaneDigest cleanupEvidenceDigest scenarioImageDigest outcome remainingOwnedResources",
  );
  const rowIdentity = validateRow(catalogRow(seed));
  requireValue(
    seed.admissionVersion === 1 &&
      runPattern.test(seed.runId) &&
      seed.candidateDigest === candidate.bundleIdentity &&
      digest.test(seed.manifestIdentity) &&
      /^[a-z][a-z0-9-]{0,63}$/u.test(seed.scenarioId) &&
      seed.catalogRowIdentity === rowIdentity &&
      entry.catalogRowIdentity === rowIdentity &&
      entry.harnessType === seed.harness.registryIdentity &&
      entry.evidenceSlot === seed.harness.evidenceSlot &&
      entry.testedVersion === seed.harness.exactVersion &&
      controller.hostKind === "github-hosted" &&
      ociDigest.test(controller.authorityIdentity) &&
      controller.workspaceRevision === manifest.sourceRevision &&
      completion.completionVersion === 1 &&
      completion.runId === seed.runId &&
      completion.outcome === "scenario-terminal-clean" &&
      completion.remainingOwnedResources === 0 &&
      ociDigest.test(completion.requestFingerprint) &&
      digest.test(completion.observationPlaneDigest) &&
      digest.test(completion.cleanupEvidenceDigest) &&
      digest.test(completion.scenarioImageDigest),
  );
  keys(
    seed.harness,
    "registryIdentity evidenceSlot exactVersion eligibleRange distributionReference artifactDigest artifactAuthorityDigest",
  );
  keys(seed.harness.eligibleRange, ["minimumInclusive", "maximumExclusive"]);
  const versions = [
    seed.harness.eligibleRange.minimumInclusive,
    seed.harness.exactVersion,
    seed.harness.eligibleRange.maximumExclusive,
  ];
  requireValue(
    versions.every((value) => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(value)),
  );
  const ordered = versions.map((version) =>
    version
      .split(".")
      .map((part) => part.padStart(6, "0"))
      .join(""),
  );
  requireValue(ordered[0] <= ordered[1] && ordered[1] < ordered[2]);
  const artifact = {
    registryIdentity: seed.harness.registryIdentity,
    exactVersion: seed.harness.exactVersion,
    distributionReference: seed.harness.distributionReference,
    artifactDigest: seed.harness.artifactDigest,
  };
  requireValue(
    digest.test(artifact.artifactDigest) &&
      seed.harness.artifactAuthorityDigest === integrationHash(artifact),
  );
  keys(
    seed.component,
    "fixtureDigest adapterArtifactDigest mappingArtifactDigest componentEvidenceDigest",
  );
  requireValue(
    [
      seed.component.fixtureDigest,
      seed.component.adapterArtifactDigest,
      seed.component.mappingArtifactDigest,
    ].every((value) => digest.test(value)) &&
      /^component-sha256-[a-f0-9]{64}$/u.test(
        seed.component.componentEvidenceDigest,
      ) &&
      entry.contractSuiteDigest === integrationHash(seed.component) &&
      entry.realScenarioDigest === integrationHash(entry.binding),
  );
  keys(
    seed.preparedImage,
    "image manifestDigest configDigest platformIdentity scenarioImageDigest",
  );
  requireValue(
    /^[a-z0-9][a-z0-9./_-]{0,159}@sha256:[a-f0-9]{64}$/u.test(
      seed.preparedImage.image,
    ) &&
      ociDigest.test(seed.preparedImage.manifestDigest) &&
      ociDigest.test(seed.preparedImage.configDigest) &&
      seed.preparedImage.platformIdentity === seed.platformIdentity &&
      seed.preparedImage.scenarioImageDigest === completion.scenarioImageDigest,
  );
  return rowIdentity;
}

function validateLedger(ledger, seed) {
  keys(ledger, ["ledgerVersion", "scenarioId", "ingestion", "retrieval"]);
  requireValue(
    ledger.ledgerVersion === 1 &&
      ledger.scenarioId === seed.scenarioId &&
      Array.isArray(ledger.retrieval) &&
      ledger.retrieval.length <= 32,
  );
  for (const entry of [
    ...boundedArray(ledger.ingestion, 32),
    ...ledger.retrieval,
  ]) {
    keys(entry, ["operation", "method", "path", "bodyBytes", "outcome"]);
    requireValue(
      [entry.operation, entry.method, entry.path, entry.outcome].every(
        (value) => typeof value === "string" && value.length <= 256,
      ) &&
        Number.isSafeInteger(entry.bodyBytes) &&
        entry.bodyBytes >= 0 &&
        entry.bodyBytes <= 16 * 1024 * 1024,
    );
  }
  requireValue(
    ledger.ingestion.some(
      (entry) =>
        entry.operation === "otlp-ingest" &&
        entry.method === "POST" &&
        entry.path === "/v1/traces" &&
        entry.outcome === "accepted" &&
        entry.bodyBytes > 0,
    ),
  );
}

function verifyReceipt(receipt, seed, completion) {
  requireValue(
    receipt?.runId === seed.runId &&
      receipt.requestFingerprint === completion.requestFingerprint &&
      receipt.outcome === "completed" &&
      receipt.exitCode === 0 &&
      receipt.signal === null &&
      receipt.cleanup === "clean" &&
      receipt.residualProcessCount === 0 &&
      receipt.processJoined === true,
  );
  requireValue(
    seed.execution.mode === "interactive"
      ? receipt.terminalInputJoined === true &&
          receipt.terminalOutputJoined === true &&
          receipt.terminalTransportClosed === true
      : receipt.stdinJoined === true &&
          receipt.stdoutJoined === true &&
          receipt.stderrJoined === true,
  );
}

function verifyObservation(entry, files) {
  const { seed, completion } = entry.binding;
  const evidence = files.get("evidence.json");
  const lifecycle = files.get("fixture-lifecycle.json");
  const modelLedger = files.get("model-ledger.json");
  const destinationLedger = files.get("destination-ledger.json");
  requireValue(
    evidence?.evidenceVersion === 2 &&
      evidence.runId === seed.runId &&
      evidence.scenarioId === seed.scenarioId &&
      evidence.candidateBundleIdentity === seed.candidateDigest &&
      evidence.candidateRevision ===
        entry.binding.controller.workspaceRevision &&
      evidence.manifestIdentity === seed.manifestIdentity &&
      evidence.executionMode === seed.execution.mode &&
      evidence.outcome === "passed" &&
      evidence.builtImageDigest === completion.scenarioImageDigest &&
      evidence.cleanup?.outcome === "complete" &&
      completion.cleanupEvidenceDigest === integrationHash(evidence.cleanup),
  );
  const receipt =
    seed.execution.mode === "interactive"
      ? evidence.ptyTerminalReceipt
      : evidence.headlessTerminalReceipt;
  keys(evidence.cleanup, ["outcome", "removalFailureCount", "remaining"]);
  keys(
    evidence.cleanup.remaining,
    "containers networks images volumes buildContexts activeRunMarkers",
  );
  requireValue(
    evidence.cleanup.removalFailureCount === 0 &&
      Object.values(evidence.cleanup.remaining).every((count) => count === 0),
  );
  verifyReceipt(receipt, seed, completion);
  keys(
    lifecycle,
    "evidenceVersion resultStatus scenarioId artifactFileName certificationReadiness lifecycle eventKinds",
  );
  requireValue(
    lifecycle.evidenceVersion === 1 &&
      lifecycle.resultStatus === "complete" &&
      lifecycle.scenarioId === seed.scenarioId &&
      /^agentscope-cli(?:-[0-9.]+)?\.tgz$/u.test(lifecycle.artifactFileName) &&
      lifecycle.certificationReadiness === null &&
      equal(lifecycle.lifecycle, phases),
  );
  unique(boundedArray(lifecycle.eventKinds, 32));
  keys(modelLedger, ["ledgerVersion", "scenarioId", "entries"]);
  requireValue(
    modelLedger.ledgerVersion === 1 &&
      modelLedger.scenarioId === seed.scenarioId,
  );
  boundedArray(modelLedger.entries, 32);
  validateLedger(destinationLedger, seed);
  const native = { ...lifecycle, modelLedger, destinationLedger };
  if (files.has("harness-observation.json"))
    native.harnessObservation = files.get("harness-observation.json");
  const observation = {
    native,
    execution: {
      baseImageIdentity: evidence.baseImageIdentity,
      builtImageDigest: evidence.builtImageDigest,
      candidateBundleIdentity: evidence.candidateBundleIdentity,
      executionMode: evidence.executionMode,
      manifestIdentity: evidence.manifestIdentity,
      mockServerImageIdentity: evidence.mockServerImageIdentity,
      receipt,
      scenarioId: evidence.scenarioId,
    },
  };
  requireValue(
    completion.observationPlaneDigest === integrationHash(observation),
  );
}

// This consumes concrete records sealed by the existing certification digest.
// It does not prove the still-missing packed advertised roster or admit publication.
export function validateReleaseEvidence({
  manifest,
  certificationRecord,
  supportAdmission,
  evidenceIndex,
  readEvidence,
}) {
  requireValue(
    hash(supportAdmission) === certificationRecord.supportAdmissionDigest &&
      hash(evidenceIndex) === certificationRecord.evidenceIndexDigest,
  );
  keys(
    supportAdmission,
    "manifestVersion disposition manifestIdentity entries",
  );
  const { manifestIdentity, ...material } = supportAdmission;
  requireValue(
    supportAdmission.manifestVersion === 1 &&
      supportAdmission.disposition ===
        "real-scenario-evidence-awaiting-release-gate" &&
      integrationHash(material) === manifestIdentity,
  );
  keys(evidenceIndex, ["indexVersion", "advertisedRows", "candidate", "runs"]);
  requireValue(evidenceIndex.indexVersion === 1);
  candidateMatches(evidenceIndex.candidate, manifest);
  const required = boundedArray(evidenceIndex.advertisedRows)
    .map(validateRow)
    .sort();
  unique(required);
  requireValue(
    harnesses.every((harness) =>
      evidenceIndex.advertisedRows.some(
        (row) => row.harness.registryIdentity === harness,
      ),
    ),
  );
  const entries = boundedArray(supportAdmission.entries);
  const observed = entries
    .map((entry) => validateEntry(entry, evidenceIndex.candidate, manifest))
    .sort();
  unique(observed);
  requireValue(equal(observed, required));
  const runs = boundedArray(evidenceIndex.runs);
  unique(runs.map(({ runId }) => runId));
  requireValue(
    equal(
      runs.map(({ runId }) => runId).sort(),
      entries.map(({ binding }) => binding.seed.runId).sort(),
    ),
  );
  const seenPaths = new Set();
  for (const entry of entries) {
    const run = runs.find(({ runId }) => runId === entry.binding.seed.runId);
    keys(run, ["runId", "files"]);
    const files = new Map();
    for (const file of boundedArray(run.files, 6)) {
      keys(file, ["path", "sha256"]);
      const prefix = `runs/${run.runId}/`;
      requireValue(
        typeof file.path === "string" &&
          file.path.startsWith(prefix) &&
          ociDigest.test(file.sha256) &&
          !seenPaths.has(file.path),
      );
      seenPaths.add(file.path);
      const name = file.path.slice(prefix.length);
      requireValue(
        [
          "evidence.json",
          "fixture-lifecycle.json",
          "model-ledger.json",
          "destination-ledger.json",
          "harness-observation.json",
        ].includes(name),
      );
      const value = readEvidence(file.path);
      requireValue(hash(value) === file.sha256);
      files.set(name, value);
    }
    verifyObservation(entry, files);
  }
  return Object.freeze({
    concreteRows: entries.length,
    publicationAdmission: "not-claimed",
    advertisedRosterCompleteness: "not-claimed",
  });
}
