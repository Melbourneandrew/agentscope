import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { parse } from "yaml";

import {
  readReleaseEvidence,
  validateReleaseEvidence,
} from "../release-lane/admission.mjs";
import { canonicalJson, sha256 } from "../release-lane/validation.mjs";

const hash = (value) => sha256(canonicalJson(value));
const ihash = (value) => hash(value).replace("sha256:", "sha256-");
const digest = (character) => `sha256-${character.repeat(64)}`;
const oci = (character) => `sha256:${character.repeat(64)}`;
const sourceRevision = "a".repeat(40);
const roots = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

// Synthetic copies of the existing retained formats, never actual admission evidence.
function createRun(candidate, files, harness, index) {
  const runId = String(index + 1).repeat(16);
  const scenarioId = `${harness}-otlp`;
  const row = {
    productIdentity: "agentscope-cli",
    harness: {
      registryIdentity: `@agentscope/harness-${harness}`,
      evidenceSlot: `${harness}-headless-v1`,
      exactVersion: "1.2.3",
    },
    execution: { mode: "headless", outputContract: "jsonl" },
    platformIdentity: digest("d"),
    destinationCombinationIdentity: ihash({ destinations: ["otlp-ledger"] }),
  };
  const artifact = {
    registryIdentity: row.harness.registryIdentity,
    exactVersion: "1.2.3",
    distributionReference: `npm:${harness}@1.2.3`,
    artifactDigest: digest("e"),
  };
  const component = {
    fixtureDigest: digest("f"),
    adapterArtifactDigest: digest("1"),
    mappingArtifactDigest: digest("2"),
    componentEvidenceDigest: `component-sha256-${"3".repeat(64)}`,
  };
  const seed = {
    admissionVersion: 1,
    runId,
    candidateDigest: candidate.bundleIdentity,
    manifestIdentity: digest("4"),
    scenarioId,
    catalogRowIdentity: ihash(row),
    ...row,
    harness: {
      ...artifact,
      evidenceSlot: row.harness.evidenceSlot,
      eligibleRange: { minimumInclusive: "1.0.0", maximumExclusive: "2.0.0" },
      artifactAuthorityDigest: ihash(artifact),
    },
    component,
    preparedImage: {
      image: `node@${oci("5")}`,
      manifestDigest: oci("6"),
      configDigest: oci("7"),
      platformIdentity: digest("d"),
      scenarioImageDigest: digest("8"),
    },
  };
  return finishRun(seed, candidate, files, row, component);
}

function finishRun(seed, candidate, files, row, component) {
  const { runId, scenarioId } = seed;
  const receipt = {
    runId,
    requestFingerprint: oci("9"),
    outcome: "completed",
    exitCode: 0,
    signal: null,
    cleanup: "clean",
    residualProcessCount: 0,
    processJoined: true,
    stdinJoined: true,
    stdoutJoined: true,
    stderrJoined: true,
  };
  const cleanup = {
    outcome: "complete",
    removalFailureCount: 0,
    remaining: {
      containers: 0,
      networks: 0,
      images: 0,
      volumes: 0,
      buildContexts: 0,
      activeRunMarkers: 0,
    },
  };
  const evidence = {
    evidenceVersion: 2,
    runId,
    scenarioId,
    candidateBundleIdentity: candidate.bundleIdentity,
    candidateRevision: sourceRevision,
    manifestIdentity: seed.manifestIdentity,
    executionMode: "headless",
    outcome: "passed",
    builtImageDigest: digest("8"),
    cleanup,
    headlessTerminalReceipt: receipt,
    ptyTerminalReceipt: null,
    baseImageIdentity: { image: "fixture-base" },
    mockServerImageIdentity: { image: "fixture-mock" },
  };
  const lifecycle = {
    evidenceVersion: 1,
    resultStatus: "complete",
    scenarioId,
    artifactFileName: "agentscope-cli.tgz",
    certificationReadiness: null,
    lifecycle: "install configure hook execute export retrieve uninstall".split(
      " ",
    ),
    eventKinds: ["turn"],
  };
  const { modelLedger, destinationLedger } = fixtureLedgers(scenarioId);
  const observation = {
    native: { ...lifecycle, modelLedger, destinationLedger },
    execution: {
      baseImageIdentity: evidence.baseImageIdentity,
      builtImageDigest: evidence.builtImageDigest,
      candidateBundleIdentity: candidate.bundleIdentity,
      executionMode: "headless",
      manifestIdentity: seed.manifestIdentity,
      mockServerImageIdentity: evidence.mockServerImageIdentity,
      receipt,
      scenarioId,
    },
  };
  const completion = {
    completionVersion: 1,
    runId,
    requestFingerprint: receipt.requestFingerprint,
    observationPlaneDigest: ihash(observation),
    cleanupEvidenceDigest: ihash(cleanup),
    scenarioImageDigest: digest("8"),
    outcome: "scenario-terminal-clean",
    remainingOwnedResources: 0,
  };
  const binding = {
    seed,
    controller: {
      authorityIdentity: oci("a"),
      hostKind: "github-hosted",
      workspaceRevision: sourceRevision,
    },
    completion,
  };
  for (const [name, value] of Object.entries({
    "evidence.json": evidence,
    "fixture-lifecycle.json": lifecycle,
    "model-ledger.json": modelLedger,
    "destination-ledger.json": destinationLedger,
  }))
    files.set(`runs/${runId}/${name}`, value);
  return {
    harnessType: row.harness.registryIdentity,
    evidenceSlot: row.harness.evidenceSlot,
    testedVersion: "1.2.3",
    catalogRowIdentity: ihash(row),
    contractSuiteDigest: ihash(component),
    realScenarioDigest: ihash(binding),
    binding,
  };
}

function fixtureLedgers(scenarioId) {
  const modelLedger = {
    ledgerVersion: 1,
    scenarioId,
    entries: [
      {
        routeId: "model",
        provider: "openai-responses",
        method: "POST",
        path: "/v1/responses",
        bodyBytes: 10,
      },
    ],
  };
  const destinationLedger = {
    ledgerVersion: 1,
    scenarioId,
    ingestion: [
      {
        operation: "otlp-ingest",
        method: "POST",
        path: "/v1/traces",
        bodyBytes: 10,
        outcome: "accepted",
      },
    ],
    retrieval: [],
  };
  return { modelLedger, destinationLedger };
}

function fixture() {
  const manifest = { sourceRevision, tarball: { bytes: 42, sha256: oci("b") } };
  const material = {
    evidenceVersion: 1,
    candidateRevision: sourceRevision,
    platform: { os: "linux", architecture: "x64", nodeVersion: "22.22.0" },
    lockfile: { fileName: "pnpm-lock.yaml", bytes: 20, sha256: digest("c") },
    artifacts: [
      {
        id: "agentscope-cli",
        kind: "npm-tarball",
        fileName: "agentscope-cli.tgz",
        bytes: 42,
        sha256: digest("b"),
      },
    ],
    scenarioNetworkPolicy: "offline-no-package-or-registry-download",
  };
  const candidate = { ...material, bundleIdentity: ihash(material) };
  const files = new Map();
  const entries = ["codex", "claude-code"].map((harness, index) =>
    createRun(candidate, files, harness, index),
  );
  const supportMaterial = {
    manifestVersion: 1,
    disposition: "real-scenario-evidence-awaiting-release-gate",
    entries,
  };
  const supportAdmission = {
    ...supportMaterial,
    manifestIdentity: ihash(supportMaterial),
  };
  const evidenceIndex = {
    indexVersion: 1,
    advertisedRows: entries.map(({ binding: { seed } }) => ({
      productIdentity: seed.productIdentity,
      harness: {
        registryIdentity: seed.harness.registryIdentity,
        evidenceSlot: seed.harness.evidenceSlot,
        exactVersion: seed.harness.exactVersion,
      },
      execution: seed.execution,
      platformIdentity: seed.platformIdentity,
      destinationCombinationIdentity: seed.destinationCombinationIdentity,
    })),
    candidate,
    runs: entries.map(({ binding: { seed } }) => ({
      runId: seed.runId,
      files: [...files]
        .filter(([path]) => path.startsWith(`runs/${seed.runId}/`))
        .map(([path, value]) => ({ path, sha256: hash(value) })),
    })),
  };
  return {
    manifest,
    certificationRecord: {
      supportAdmissionDigest: hash(supportAdmission),
      evidenceIndexDigest: hash(evidenceIndex),
    },
    supportAdmission,
    evidenceIndex,
    files,
    readEvidence: (path) => files.get(path),
  };
}

function reseal(input) {
  for (const entry of input.supportAdmission.entries)
    entry.realScenarioDigest = ihash(entry.binding);
  const { manifestIdentity, ...material } = input.supportAdmission;
  assert.equal(typeof manifestIdentity, "string");
  input.supportAdmission.manifestIdentity = ihash(material);
  for (const run of input.evidenceIndex.runs)
    for (const file of run.files)
      if (input.files.has(file.path))
        file.sha256 = hash(input.files.get(file.path));
  input.certificationRecord.supportAdmissionDigest = hash(
    input.supportAdmission,
  );
  input.certificationRecord.evidenceIndexDigest = hash(input.evidenceIndex);
}

test("consumes exact retained formats without claiming final release admission", () => {
  assert.deepEqual(validateReleaseEvidence(fixture()), {
    concreteRows: 2,
    publicationAdmission: "not-claimed",
    advertisedRosterCompleteness: "not-claimed",
  });
});

test.each([
  ["missing rows", (x) => x.supportAdmission.entries.pop()],
  [
    "duplicate rows",
    (x) => x.supportAdmission.entries.push(x.supportAdmission.entries[0]),
  ],
  [
    "duplicate required rows",
    (x) =>
      x.evidenceIndex.advertisedRows.push(x.evidenceIndex.advertisedRows[0]),
  ],
  [
    "caller subset",
    (x) => {
      x.supportAdmission.entries.pop();
      x.evidenceIndex.advertisedRows.pop();
      x.evidenceIndex.runs.pop();
    },
  ],
  [
    "foreign source",
    (x) =>
      (x.supportAdmission.entries[0].binding.controller.workspaceRevision =
        "b".repeat(40)),
  ],
  [
    "foreign bundle",
    (x) =>
      (x.supportAdmission.entries[0].binding.seed.candidateDigest =
        digest("b")),
  ],
  [
    "nonrelease host",
    (x) =>
      (x.supportAdmission.entries[0].binding.controller.hostKind = "crabbox"),
  ],
  [
    "Local tuple",
    (x) =>
      (x.evidenceIndex.advertisedRows[0].destinationCombinationIdentity = ihash(
        { destinations: ["local-sqlite"] },
      )),
  ],
  [
    "future harness",
    (x) =>
      (x.evidenceIndex.advertisedRows[0].harness.registryIdentity =
        "@agentscope/harness-cursor"),
  ],
  [
    "failed completion",
    (x) =>
      (x.supportAdmission.entries[0].binding.completion.outcome = "failed"),
  ],
  ["missing run", (x) => x.evidenceIndex.runs.pop()],
  ["duplicate run", (x) => x.evidenceIndex.runs.push(x.evidenceIndex.runs[0])],
  ["missing retained file", (x) => x.evidenceIndex.runs[0].files.pop()],
  [
    "foreign file locator",
    (x) =>
      (x.evidenceIndex.runs[0].files[0].path =
        "runs/9999999999999999/evidence.json"),
  ],
  [
    "substituted tarball",
    (x) => {
      x.evidenceIndex.candidate.artifacts[0].sha256 = digest("f");
      const { bundleIdentity, ...m } = x.evidenceIndex.candidate;
      assert.equal(typeof bundleIdentity, "string");
      x.evidenceIndex.candidate.bundleIdentity = ihash(m);
    },
  ],
  [
    "stale observation",
    (x) =>
      (x.files.get("runs/1111111111111111/fixture-lifecycle.json").eventKinds =
        ["different"]),
  ],
  [
    "failed OTLP",
    (x) =>
      (x.files.get(
        "runs/1111111111111111/destination-ledger.json",
      ).ingestion[0].outcome = "unavailable"),
  ],
  [
    "SQLite-only evidence",
    (x) =>
      (x.files.get(
        "runs/1111111111111111/destination-ledger.json",
      ).ingestion[0].operation = "sqlite-insert"),
  ],
  [
    "wrong OTLP route",
    (x) =>
      (x.files.get(
        "runs/1111111111111111/destination-ledger.json",
      ).ingestion[0].path = "/api/public/ingestion"),
  ],
  [
    "zero body",
    (x) =>
      (x.files.get(
        "runs/1111111111111111/destination-ledger.json",
      ).ingestion[0].bodyBytes = 0),
  ],
  [
    "unjoined process",
    (x) =>
      (x.files.get(
        "runs/1111111111111111/evidence.json",
      ).headlessTerminalReceipt.processJoined = false),
  ],
  [
    "unclean resources",
    (x) =>
      (x.files.get(
        "runs/1111111111111111/evidence.json",
      ).cleanup.remaining.containers = 1),
  ],
])("rejects semantically invalid sealed records: %s", (_name, mutate) => {
  const input = fixture();
  mutate(input);
  reseal(input);
  assert.throws(() => validateReleaseEvidence(input));
});

test("rejects changed sidecars before any retained file is read", () => {
  const input = fixture();
  input.evidenceIndex.advertisedRows.pop();
  input.readEvidence = () => assert.fail("untrusted sidecar read");
  assert.throws(() => validateReleaseEvidence(input), /binding drifted/);
});

test("bounded no-follow reader rejects missing, symlink, oversized and escaping inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-release-evidence-"));
  roots.push(root);
  writeFileSync(join(root, "good.json"), '{"fixed":true}');
  assert.deepEqual(readReleaseEvidence(root, "good.json"), { fixed: true });
  symlinkSync(join(root, "good.json"), join(root, "link.json"));
  writeFileSync(join(root, "large.json"), Buffer.alloc(1_048_577));
  for (const path of [
    "missing.json",
    "link.json",
    "large.json",
    "../good.json",
    "/good.json",
  ])
    assert.throws(() => readReleaseEvidence(root, path));
});

test("protected-main caller is exclusively a nonpublishing inert relay and rehearsal", () => {
  const workflow = parse(
    readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["retain-inputs", "rehearse"]);
  const relay = workflow.jobs["retain-inputs"];
  assert.equal(
    relay.if,
    "github.repository == 'Melbourneandrew/agentscope' && github.ref == 'refs/heads/main'",
  );
  assert.deepEqual(relay.permissions, { contents: "read", actions: "read" });
  assert.equal(relay.steps.length, 2);
  assert.equal(
    relay.steps[0].uses,
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  );
  assert.equal(
    relay.steps[1].uses,
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  );
  assert.equal(
    workflow.jobs.rehearse.uses,
    "./.github/workflows/release-candidate-rehearsal.yml",
  );
  assert.equal(workflow.jobs.rehearse.needs, "retain-inputs");
  assert.ok(
    !JSON.stringify(workflow).match(
      /id-token|environment|NPM_TOKEN|NODE_AUTH_TOKEN|npm (?:publish|stage)|contents.*write/u,
    ),
  );
});
