import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  bindPreparedCliEvidence,
  bindCodexScenarioEvidence,
  bindClaudeScenarioEvidence,
  bindScenarioEvidence,
  bindIntegrationArtifacts,
  parseAdmissionDocument,
  projectOperatorControlsReport,
  requireActualSemanticAdmission,
} from "../release-lane/admission.mjs";
import { canonicalJson, sha256 } from "../release-lane/validation.mjs";
import { deriveIdentityBundle } from "@agentscope/protocol";

const entrySource = readFileSync(
  new URL("../record-release-stage.mjs", import.meta.url),
  "utf8",
);
function releaseFanInBoundary() {
  const source = entrySource.slice(
    entrySource.indexOf("function bindReleaseSbom("),
    entrySource.indexOf("function retainReleaseCandidate("),
  );
  const tarball = Buffer.from(
    "synthetic trusted packaging seam, not admission",
  );
  const inspected = {
    sha256: sha256(tarball),
    bytes: tarball.length,
    integrity: "synthetic",
    inventory: [
      {
        path: "package/dist/bin/agentscope.js",
        sha256: sha256(Buffer.from("bin")),
      },
    ],
  };
  const selected = {
    runId: 5,
    runAttempt: 1,
    candidateArtifactId: 6,
    scenarioArtifactId: 7,
  };
  const revision = "a".repeat(40);
  const sbom = {
    spdxVersion: "SPDX-2.3",
    packages: [
      {
        SPDXID: "SPDXRef-Package",
        name: "agentscope-cli",
        versionInfo: "0.1.0",
        checksums: [
          { algorithm: "SHA256", checksumValue: inspected.sha256.slice(7) },
        ],
      },
    ],
    files: [
      {
        fileName: "dist/bin/agentscope.js",
        checksums: [
          {
            algorithm: "SHA256",
            checksumValue: inspected.inventory[0].sha256.slice(7),
          },
        ],
      },
    ],
  };
  const statements = [
    {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: "agentscope-cli-0.1.0.tgz",
          digest: { sha256: inspected.sha256.slice(7) },
        },
      ],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          externalParameters: { sourceRevision: revision },
          internalParameters: {
            observedInvocation: {
              environment: "github-actions",
              authenticated: false,
              repository: "Melbourneandrew/agentscope",
              runId: "5",
              runAttempt: "1",
              sourceRevision: revision,
            },
          },
        },
      },
    },
  ];
  const candidateInput = {
    tarball,
    tarballPath: "held",
    preparedBytes: Buffer.from("prepared"),
    evidenceFiles: [
      {
        name: "runs/held/evidence.json",
        bytes: 1,
        digest: sha256(Buffer.from("e")),
      },
    ],
    roleBytes: {
      "sbom.json": Buffer.from(JSON.stringify(sbom)),
      "attestations.json": Buffer.from(JSON.stringify(statements)),
    },
  };
  const calls = [];
  const functions = runInNewContext(
    source + "\n({bindReleaseMaterials, assembleReleaseCandidate});",
    {
      Buffer,
      TextDecoder,
      canonicalJson,
      sha256,
      process: { env: { GITHUB_SHA: revision } },
      fail: () => {
        throw new Error("release.recording.unresolved");
      },
      inspectCandidateTarball: () => inspected,
      assembleCandidateAssets: (input) => {
        calls.push(input);
        return { manifest: { sourceRevision: revision } };
      },
      bindPreparedCliEvidence: (...input) => calls.push(input),
    },
  );
  return { functions, candidateInput, selected, sbom, statements, calls };
}
test("actual entry material projection uses the same held tar and preserves unsigned role bytes", () => {
  const value = releaseFanInBoundary();
  const roles = { ...value.candidateInput.roleBytes };
  value.functions.assembleReleaseCandidate(
    value.candidateInput,
    [{ family: "codex" }, { family: "claude-code" }],
    value.selected,
  );
  expect(value.calls).toHaveLength(2);
  expect(value.calls[0].tarball).toBe(value.candidateInput.tarball);
  for (const [name, bytes] of Object.entries(roles))
    expect(value.calls[0].roleBytes[name]).toBe(bytes);
  expect(Object.keys(value.calls[0].roleBytes).sort()).toEqual([
    "attestations.json",
    "checksum-manifest.json",
    "evidence-index.json",
    "sbom.json",
    "support-admission.json",
  ]);
  const index = JSON.parse(value.calls[0].roleBytes["evidence-index.json"]);
  expect(index.producingRun).toEqual(value.selected);
  expect(index.files).toEqual(value.candidateInput.evidenceFiles);
  expect(value.calls[1][0]).toBe(value.candidateInput.preparedBytes);
});
test.each([
  "tar",
  "sbom-hash",
  "sbom-files",
  "subject",
  "source",
  "run",
  "attempt",
  "authority",
])("material %s substitution refuses before assembly", (kind) => {
  const value = releaseFanInBoundary();
  if (kind === "tar") value.candidateInput.tarball = Buffer.from("substituted");
  if (kind === "sbom-hash")
    value.sbom.packages[0].checksums[0].checksumValue = "b".repeat(64);
  if (kind === "sbom-files") value.sbom.files = [];
  if (kind === "subject")
    value.statements[0].subject[0].digest.sha256 = "b".repeat(64);
  if (kind === "source")
    value.statements[0].predicate.buildDefinition.externalParameters.sourceRevision =
      "b".repeat(40);
  const invocation =
    value.statements[0].predicate.buildDefinition.internalParameters
      .observedInvocation;
  if (kind === "run") invocation.runId = "8";
  if (kind === "attempt") invocation.runAttempt = "2";
  if (kind === "authority") invocation.authenticated = true;
  value.candidateInput.roleBytes["sbom.json"] = Buffer.from(
    JSON.stringify(value.sbom),
  );
  value.candidateInput.roleBytes["attestations.json"] = Buffer.from(
    JSON.stringify(value.statements),
  );
  expect(() =>
    value.functions.assembleReleaseCandidate(
      value.candidateInput,
      [],
      value.selected,
    ),
  ).toThrow();
  expect(value.calls).toEqual([]);
});
function retainedCandidateMetadata() {
  const start = entrySource.indexOf("function selectRetainedCandidate(");
  const body = entrySource.slice(
    start,
    entrySource.indexOf("async function prepareSemantic(", start),
  );
  const select = runInNewContext(body + "\nselectRetainedCandidate;", {
    fail: () => {
      throw new Error("metadata");
    },
  });
  const run = { id: 5, run_attempt: 1, head_sha: "a".repeat(40) };
  const job = {
    name: "verify-candidate",
    run_id: 5,
    run_attempt: 1,
    head_sha: run.head_sha,
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-08T00:00:00Z",
    completed_at: "2026-10-08T00:01:00Z",
  };
  const artifact = {
    id: 7,
    name: "release-certified-candidate",
    expired: false,
    size_in_bytes: 100,
    digest: `sha256:${"b".repeat(64)}`,
    workflow_run: { id: 5, head_sha: run.head_sha },
    created_at: "2026-10-08T00:00:30Z",
    updated_at: "2026-10-08T00:00:30Z",
  };
  return {
    select,
    run,
    job,
    artifact,
    jobs: { total_count: 1, jobs: [job] },
    artifacts: { total_count: 1, artifacts: [artifact] },
  };
}
test("retained main candidate selects a unique immutable ID inside its successful job", () => {
  const value = retainedCandidateMetadata();
  expect(value.select(value.run, value.jobs, value.artifacts)).toBe(7);
});
test.each([
  "attempt",
  "source",
  "run",
  "expired",
  "late",
  "duplicate",
  "pagination",
  "failure",
])("retained candidate %s cannot authenticate by artifact name", (kind) => {
  const value = retainedCandidateMetadata();
  if (kind === "attempt") value.job.run_attempt = 2;
  if (kind === "source") value.artifact.workflow_run.head_sha = "c".repeat(40);
  if (kind === "run") value.job.run_id = 8;
  if (kind === "expired") value.artifact.expired = true;
  if (kind === "late") value.artifact.updated_at = "2026-10-08T00:02:00Z";
  if (kind === "duplicate") {
    value.artifacts.artifacts.push({ ...value.artifact });
    value.artifacts.total_count = 2;
  }
  if (kind === "pagination") value.jobs.total_count = 101;
  if (kind === "failure") value.job.conclusion = "failure";
  expect(() => value.select(value.run, value.jobs, value.artifacts)).toThrow();
});

function fixture() {
  const tarball = Buffer.from("synthetic artifact binding only");
  const material = {
    evidenceVersion: 1,
    candidateRevision: "a".repeat(40),
    platform: { os: "linux", architecture: "x64", nodeVersion: "22.0.0" },
    lockfile: {
      fileName: "pnpm-lock.yaml",
      bytes: 1,
      sha256: `sha256-${"b".repeat(64)}`,
    },
    artifacts: [
      {
        id: "agentscope-cli",
        kind: "npm-tarball",
        fileName: "agentscope-cli.tgz",
        bytes: tarball.length,
        sha256: sha256(tarball).replace("sha256:", "sha256-"),
      },
    ],
    scenarioNetworkPolicy: "offline-no-package-or-registry-download",
  };
  const evidence = {
    ...material,
    bundleIdentity: sha256(canonicalJson(material)).replace(
      "sha256:",
      "sha256-",
    ),
  };
  const manifest = {
    sourceRevision: material.candidateRevision,
    tarball: {
      bytes: tarball.length,
      sha256: sha256(tarball),
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    },
  };
  return { tarball, evidence, manifest };
}
const encode = (value) => Buffer.from(JSON.stringify(value));
const digest = (value) =>
  sha256(canonicalJson(value)).replace("sha256:", "sha256-");
function codexNativeFixture() {
  const scenarioId = "codex-tui",
    turn = "codex:native-turn";
  const ids = deriveIdentityBundle({
    harnessRegistryId: "codex",
    operationIdScope: "session-global",
    session: { kind: "boundary-scoped" },
    boundary: {
      kind: "hook-invocation",
      id: turn,
      generation: 0,
      positionKind: "sequence",
      exclusiveEndPosition: 1,
    },
    operations: [
      {
        logicalKey: "codex-turn",
        locator: { kind: "native-operation", nativeId: turn },
      },
      {
        logicalKey: "codex-llm",
        parentLogicalKey: "codex-turn",
        locator: { kind: "native-operation", nativeId: `${turn}:llm` },
      },
    ],
  });
  const observation = {
    observationVersion: 1,
    kind: "codex-tui-trace",
    nativeSessionId: "native-session",
    nativeTurnId: "native-turn",
    nativeModelName: "native-model",
    modelRequestBodySha256: "b".repeat(64),
    canonicalGraphDigest: "c".repeat(64),
    traceId: ids.traceId,
    spanIds: [ids.spans["codex-turn"], ids.spans["codex-llm"]],
    contextDisposition: "unversioned-workspace-redacted",
    resourceSpanCount: 1,
    spanNames: ["codex.turn", "codex.response"],
    parentLinked: true,
    doctorErrors: 0,
    uninstallDisposition: "committed",
    sessionStartCommandDurationMilliseconds: null,
  };
  const lifecycle = {
    evidenceVersion: 1,
    resultStatus: "complete",
    scenarioId,
    artifactFileName: "codex-result.json",
    certificationReadiness: null,
    lifecycle: [
      "install",
      "configure",
      "hook",
      "execute",
      "export",
      "retrieve",
      "uninstall",
    ],
    eventKinds: ["hook", "model", "destination"],
  };
  const model = {
    ledgerVersion: 1,
    scenarioId,
    entries: [
      {
        routeId: "codex-tui-responses",
        provider: "openai",
        method: "POST",
        path: "/v1/responses",
        bodyBytes: 10,
      },
    ],
  };
  const destination = {
    ledgerVersion: 1,
    scenarioId,
    ingestion: [
      {
        operation: "otlp",
        method: "POST",
        path: "/api/public/otel/v1/traces",
        bodyBytes: 10,
        outcome: "accepted",
      },
    ],
    retrieval: [],
  };
  return { lifecycle, model, destination, observation };
}
function codexEvidenceFixture(prepared) {
  const runId = "1".repeat(16),
    scenarioId = "codex-tui";
  const request = {
    process: {
      requestFingerprint: `sha256:${"d".repeat(64)}`,
      monotonicShutdownDeadlineMs: 100,
    },
    completion: { kind: "semantic-marker" },
    readiness: { kind: "semantic-marker" },
    initialGeometry: { rows: 24, columns: 80 },
    interaction: { actions: [{ action: "eof" }], trigger: "semantic-ready" },
    interpreter: { path: "/node", sha256: "e".repeat(64) },
    scriptSha256: "f".repeat(64),
  };
  const preimage = {
    processRequestFingerprint: request.process.requestFingerprint,
    completion: request.completion,
    readiness: request.readiness,
    initialGeometry: request.initialGeometry,
    interaction: request.interaction,
    interpreter: request.interpreter,
    scriptSha256: request.scriptSha256,
    inputBytes: 0,
    inputSha256: "a".repeat(64),
  };
  const receipt = {
    receiptVersion: 1,
    transport: "pty",
    scenarioId,
    runId,
    request,
    ...preimage,
    requestFingerprint: sha256(JSON.stringify(preimage)),
    returnedAtMs: 99,
    outcome: "completed",
    exitCode: 0,
    signal: null,
    cleanup: "clean",
    residualProcessCount: 0,
    finalSnapshot: { semanticState: "completed" },
    processJoined: true,
    terminalInputJoined: true,
    terminalOutputJoined: true,
    terminalTransportClosed: true,
  };
  const evidence = {
    evidenceVersion: 2,
    runId,
    scenarioId,
    candidateRevision: prepared.candidateRevision,
    candidateBundleIdentity: prepared.bundleIdentity,
    manifestIdentity: `sha256-${"e".repeat(64)}`,
    executionMode: "interactive",
    builtImageDigest: `sha256:${"a".repeat(64)}`,
    baseImageIdentity: { image: "base" },
    mockServerImageIdentity: { image: "mock" },
    headlessTerminalReceipt: null,
    ptyTerminalReceipt: receipt,
    outcome: "passed",
    cleanup: {
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
    },
  };
  return evidence;
}
function codexSupportFixture(f, family = "codex") {
  const { prepared, evidence, lifecycle, model, destination, observation } = f;
  const { runId, scenarioId, ptyTerminalReceipt: receipt } = evidence;
  const seed = {
    productIdentity: "agentscope-cli",
    runId,
    candidateDigest: prepared.bundleIdentity,
    manifestIdentity: evidence.manifestIdentity,
    scenarioId,
    execution: { mode: "interactive", outputContract: "semantic-pty" },
    harness: { registryIdentity: `@agentscope/harness-${family}` },
    preparedImage: { scenarioImageDigest: evidence.builtImageDigest },
  };
  const execution = Object.fromEntries(
    [
      "baseImageIdentity",
      "builtImageDigest",
      "candidateBundleIdentity",
      "executionMode",
      "manifestIdentity",
      "mockServerImageIdentity",
      "scenarioId",
    ].map((key) => [key, evidence[key]]),
  );
  execution.receipt = receipt;
  const binding = {
    seed,
    controller: {
      hostKind: "github-hosted",
      workspaceRevision: prepared.candidateRevision,
    },
    completion: {
      completionVersion: 1,
      runId,
      requestFingerprint: receipt.requestFingerprint,
      scenarioImageDigest: evidence.builtImageDigest,
      observationPlaneDigest: digest({
        native: {
          ...lifecycle,
          modelLedger: model,
          destinationLedger: destination,
          harnessObservation: observation,
        },
        execution,
      }),
      cleanupEvidenceDigest: digest(evidence.cleanup),
      outcome: "scenario-terminal-clean",
      remainingOwnedResources: 0,
    },
  };
  const material = {
    manifestVersion: 1,
    disposition: "real-scenario-evidence-awaiting-release-gate",
    entries: [
      {
        harnessType: `@agentscope/harness-${family}`,
        binding,
        realScenarioDigest: digest(binding),
      },
    ],
  };
  return { ...material, manifestIdentity: digest(material) };
}
function codexFixture() {
  const prepared = fixture().evidence;
  const f = {
    prepared,
    evidence: codexEvidenceFixture(prepared),
    ...codexNativeFixture(),
  };
  return { ...f, support: codexSupportFixture(f) };
}
const codexFiles = (f) =>
  Object.fromEntries(
    [
      ["evidence.json", f.evidence],
      ["fixture-lifecycle.json", f.lifecycle],
      ["model-ledger.json", f.model],
      ["destination-ledger.json", f.destination],
      ["harness-observation.json", f.observation],
    ].map(([name, value]) => [name, encode(value)]),
  );
const bindCodex = (f) =>
  bindCodexScenarioEvidence(
    encode(f.prepared),
    encode(f.support),
    codexFiles(f),
  );
// Synthetic preimages exercise the serializer contract, not actual capture.
function claudeFixture() {
  const f = codexFixture();
  f.evidence.runId = "2".repeat(16);
  f.evidence.scenarioId =
    f.lifecycle.scenarioId =
    f.model.scenarioId =
    f.destination.scenarioId =
      "claude-code-interactive";
  f.evidence.ptyTerminalReceipt.runId = f.evidence.runId;
  f.evidence.ptyTerminalReceipt.scenarioId = f.evidence.scenarioId;
  f.model.entries = [1, 2].map(() => ({
    routeId: "anthropic-messages",
    provider: "anthropic",
    method: "POST",
    path: "/v1/messages",
    bodyBytes: 10,
  }));
  f.destination.ingestion = Array.from({ length: 4 }, () => ({
    ...f.destination.ingestion[0],
  }));
  f.observation = {
    observationVersion: 1,
    kind: "claude-code-trace",
    nativeSessionId: "12345678-1234-1234-1234-123456789abc",
    nativeToolUseId: "toolu_agentscope_claude_read_1",
    modelRequestBodySha256: ["a".repeat(64), "b".repeat(64)],
    doctorErrors: 0,
    uninstallDisposition: "committed",
    hookObservations: ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].map(
      (eventName, index) => ({
        eventName,
        traceId: String(index + 1).repeat(32),
        canonicalGraphDigest: "c".repeat(64),
        contextDisposition: "unversioned-workspace-redacted",
        spanIds:
          index === 0 ? ["a".repeat(16)] : ["a".repeat(16), "b".repeat(16)],
      }),
    ),
  };
  f.support = codexSupportFixture(f, "claude-code");
  return f;
}
const bindClaude = (f) =>
  bindClaudeScenarioEvidence(
    encode(f.prepared),
    encode(f.support),
    codexFiles(f),
  );
test("binds all four actual-shape Claude projections without granting synthetic admission", () => {
  const f = claudeFixture();
  expect(bindClaude(f).family).toBe("claude-code");
  expect(() =>
    requireActualSemanticAdmission([bindCodex(codexFixture()), bindClaude(f)]),
  ).toThrow("actual-otlp-evidence-missing");
});
test.each([
  (f) => {
    f.observation.kind = "claude-code-native";
  },
  (f) => {
    f.observation.nativeSessionId = "invalid";
  },
  (f) => {
    f.observation.nativeSessionId = [f.observation.nativeSessionId];
  },
  (f) => {
    f.observation.nativeToolUseId = "other";
  },
  (f) => {
    f.observation.modelRequestBodySha256.pop();
  },
  (f) => {
    f.observation.hookObservations.reverse();
  },
  (f) => {
    f.observation.hookObservations[1].traceId =
      f.observation.hookObservations[0].traceId;
  },
  (f) => {
    f.observation.hookObservations[1].spanIds[1] =
      f.observation.hookObservations[1].spanIds[0];
  },
  (f) => {
    f.observation.hookObservations[0].canonicalGraph = {};
  },
  (f) => {
    f.model.entries.pop();
  },
  (f) => {
    f.destination.ingestion.pop();
  },
  (f) => {
    f.lifecycle.resultStatus = "partial";
  },
  (f) => {
    f.evidence.ptyTerminalReceipt.processJoined = false;
  },
])(
  "Claude digest recomputation cannot excuse contradictory projection %#",
  (change) => {
    const f = claudeFixture();
    change(f);
    f.support = codexSupportFixture(f, "claude-code");
    expect(() => bindClaude(f)).toThrow();
  },
);
test("Claude changed body/hash/context preimages fail without private completion", () => {
  const f = claudeFixture();
  f.observation.modelRequestBodySha256.reverse();
  expect(() => bindClaude(f)).toThrow();
  expect(() =>
    bindScenarioEvidence(
      encode(f.prepared),
      encode(f.support),
      codexFiles(f),
      "fixture-process",
    ),
  ).toThrow();
});
test("preserves additional matched Claude requests instead of filtering to a two-row proof", () => {
  const f = claudeFixture();
  f.model.entries.push({ ...f.model.entries[0] });
  f.support = codexSupportFixture(f, "claude-code");
  expect(bindClaude(f).family).toBe("claude-code");
  f.model.entries[2].routeId = "unrecognized-profile";
  f.support = codexSupportFixture(f, "claude-code");
  expect(() => bindClaude(f)).toThrow();
});
function sourceMaterialFixture(f, family) {
  const material = {
    kind: "npm",
    platformIdentity: `sha256-${"9".repeat(64)}`,
  };
  const admission = {
    evidenceSlot: `${family}-component`,
    eligibleRange: { minimumInclusive: "1.0.0", maximumExclusive: "2.0.0" },
    distributionReference: `npm:@vendor/${family}@1.0.0`,
  };
  const fixture = {
    fixtureVersion: 1,
    harnessId: family,
    harnessVersion: "1.0.0",
    governance: {
      provenance: {
        captureKind: "disposable-hermetic",
        artifactAuthority: {
          status: "authenticated",
          digest: digest(material),
        },
      },
      representative: {
        scenarioId: f.evidence.scenarioId,
        representativeVersion: "1.0.0",
        evidenceSlot: admission.evidenceSlot,
      },
    },
  };
  const bytes = {
    fixtureBytes: encode(fixture),
    adapterBytes: Buffer.from("synthetic adapter bytes"),
    mappingBytes: Buffer.from("synthetic mapping bytes"),
  };
  const component = {
    componentEvidenceDigest: `component-sha256-${"8".repeat(64)}`,
  };
  for (const [role, key] of [
    ["fixture", "fixtureBytes"],
    ["adapterArtifact", "adapterBytes"],
    ["mappingArtifact", "mappingBytes"],
  ])
    component[role] = { path: role, sha256: sha256(bytes[key]).slice(7) };
  admission.component = component;
  return {
    bytes,
    row: {
      evidenceId: family,
      harnessId: family,
      harnessPackage: `@agentscope/harness-${family}`,
      representativeVersion: "1.0.0",
      material,
      admission,
    },
    scenario: {
      scenarioId: f.evidence.scenarioId,
      harnessEvidenceId: family,
      executionMode: "interactive",
      outputContract: "semantic-pty",
      destinations: ["otlp-ledger"],
      modelRoutes: [family],
      tags: ["pr"],
    },
  };
}
function bindSourceFixture(f, family, source, catalog) {
  f.evidence.manifestIdentity = catalog.manifestIdentity;
  f.support = codexSupportFixture(f, family);
  const entry = f.support.entries[0],
    seed = entry.binding.seed;
  const row = source.row;
  seed.admissionVersion = 1;
  entry.binding.controller.authorityIdentity =
    f.controllerAuthority ?? `sha256:${"4".repeat(64)}`;
  seed.platformIdentity = row.material.platformIdentity;
  seed.destinationCombinationIdentity = digest({
    destinations: source.scenario.destinations,
    modelRoutes: source.scenario.modelRoutes,
  });
  seed.harness = {
    registryIdentity: row.harnessPackage,
    exactVersion: row.representativeVersion,
    distributionReference: row.admission.distributionReference,
    artifactDigest: digest(row.material),
    evidenceSlot: row.admission.evidenceSlot,
    eligibleRange: row.admission.eligibleRange,
  };
  seed.harness.artifactAuthorityDigest = digest(
    Object.fromEntries(
      [
        "registryIdentity",
        "exactVersion",
        "distributionReference",
        "artifactDigest",
      ].map((key) => [key, seed.harness[key]]),
    ),
  );
  seed.catalogRowIdentity = digest({
    productIdentity: "agentscope-cli",
    harness: {
      registryIdentity: row.harnessPackage,
      evidenceSlot: row.admission.evidenceSlot,
      exactVersion: row.representativeVersion,
    },
    execution: seed.execution,
    platformIdentity: seed.platformIdentity,
    destinationCombinationIdentity: seed.destinationCombinationIdentity,
  });
  seed.component = {
    fixtureDigest: digestBytes(source.bytes.fixtureBytes),
    adapterArtifactDigest: digestBytes(source.bytes.adapterBytes),
    mappingArtifactDigest: digestBytes(source.bytes.mappingBytes),
    componentEvidenceDigest: row.admission.component.componentEvidenceDigest,
  };
  Object.assign(entry, {
    catalogRowIdentity: seed.catalogRowIdentity,
    testedVersion: row.representativeVersion,
    evidenceSlot: row.admission.evidenceSlot,
    contractSuiteDigest: digest(seed.component),
    realScenarioDigest: digest(entry.binding),
  });
  const preimage = Object.fromEntries(
    Object.entries(f.support).filter(([key]) => key !== "manifestIdentity"),
  );
  f.support.manifestIdentity = digest(preimage);
  return bindScenarioEvidence(
    encode(f.prepared),
    encode(f.support),
    codexFiles(f),
    family,
    { catalogBytes: encode(catalog), ...source.bytes },
  );
}
const digestBytes = (bytes) => sha256(bytes).replace("sha256:", "sha256-");
function twoFamilySourceFixture(change = () => {}) {
  const fixtures = [codexFixture(), claudeFixture()];
  const families = ["codex", "claude-code"];
  const sources = fixtures.map((f, index) =>
    sourceMaterialFixture(f, families[index]),
  );
  const material = {
    manifestVersion: 1,
    requiredRepresentativeIds: families,
    evidence: sources.map((source) => source.row),
    scenarios: sources.map((source) => source.scenario),
  };
  const catalog = { ...material, manifestIdentity: digest(material) };
  change({ fixtures, sources, catalog });
  catalog.manifestIdentity = digest({
    manifestVersion: catalog.manifestVersion,
    requiredRepresentativeIds: [...catalog.requiredRepresentativeIds].sort(),
    evidence: [...catalog.evidence].sort((a, b) =>
      a.evidenceId.localeCompare(b.evidenceId),
    ),
    scenarios: catalog.scenarios
      .map((scenario) => ({
        ...scenario,
        modelRoutes: [...scenario.modelRoutes].sort(),
        tags: [...scenario.tags].sort(),
        destinations: [...scenario.destinations].sort(),
      }))
      .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId)),
  });
  return fixtures.map((f, index) =>
    bindSourceFixture(f, families[index], sources[index], catalog),
  );
}
test("synthetic authenticated-shape coverage requires both component-bound families; it is not actual admission evidence", () => {
  const values = twoFamilySourceFixture();
  expect(requireActualSemanticAdmission(values)).toHaveLength(2);
  for (const wrong of [
    [values[0]],
    [values[0], values[0]],
    values.map((value) => ({ ...value })),
    { state: "certified" },
  ])
    expect(() => requireActualSemanticAdmission(wrong)).toThrow();
});
test.each([
  ({ sources }) => {
    sources[0].bytes.fixtureBytes = encode({ fixtureVersion: 1 });
  },
  ({ sources }) => {
    sources[1].row.material.kind = "certification-fixture";
  },
  ({ sources }) => {
    sources[1].bytes.adapterBytes = Buffer.from("changed");
  },
  ({ sources }) => {
    sources[1].row.admission.component.componentEvidenceDigest =
      "not-component-evidence";
  },
  ({ fixtures }) => {
    fixtures[1].prepared.candidateRevision = "b".repeat(40);
  },
  ({ fixtures }) => {
    fixtures[1].controllerAuthority = `sha256:${"5".repeat(64)}`;
  },
])("source/component/substituted candidate cannot authorize %#", (change) => {
  expect(() =>
    requireActualSemanticAdmission(twoFamilySourceFixture(change)),
  ).toThrow();
});
test("synthetic existing Codex preimages bind without granting alpha admission", () => {
  const f = codexFixture();
  expect(bindCodex(f)).toMatchObject({
    runId: f.evidence.runId,
    candidateBundleIdentity: f.prepared.bundleIdentity,
  });
  expect(() => requireActualSemanticAdmission(bindCodex(f))).toThrow(
    "actual-otlp-evidence-missing",
  );
});
test.each([
  (f) => {
    f.observation.nativeTurnId = "substituted";
  },
  (f) => {
    f.observation.spanIds.reverse();
  },
  (f) => {
    f.observation.parentLinked = false;
  },
  (f) => {
    f.observation.rawGraph = {};
  },
  (f) => {
    f.observation.nativeSessionId = "substituted";
  },
  (f) => {
    f.observation.nativeModelName = "substituted";
  },
  (f) => {
    f.observation.modelRequestBodySha256 = "d".repeat(64);
  },
  (f) => {
    f.model.entries[0].bodyBytes++;
  },
  (f) => {
    f.destination.ingestion[0].outcome = "failed";
  },
  (f) => {
    f.evidence.candidateRevision = "b".repeat(40);
  },
  (f) => {
    f.evidence.cleanup.remaining.images = 1;
  },
  (f) => {
    f.evidence.ptyTerminalReceipt.terminalTransportClosed = false;
  },
  (f) => {
    f.evidence.ptyTerminalReceipt.returnedAtMs = 101;
  },
  (f) => {
    f.evidence.ptyTerminalReceipt.request.interaction.actions = [];
  },
  (f) => {
    f.support.entries = [];
  },
])("rejects changed native/completion/cleanup preimage %#", (change) => {
  const f = codexFixture();
  change(f);
  expect(() => bindCodex(f)).toThrow();
});
test.each([
  (f) => {
    f.observation.nativeSessionId = "";
  },
  (f) => {
    f.observation.parentLinked = false;
  },
  (f) => {
    f.observation.rawGraph = {};
  },
  (f) => {
    f.model.entries[0].provider = "other";
  },
  (f) => {
    f.model.entries[0].bodyBytes = 0;
  },
  (f) => {
    f.destination.ingestion[0].path = "/other";
  },
  (f) => {
    f.evidence.cleanup.remaining.images = 1;
  },
  (f) => {
    f.evidence.ptyTerminalReceipt.processJoined = false;
  },
  (f) => {
    f.evidence.ptyTerminalReceipt.returnedAtMs = 101;
  },
])(
  "digest recomputation does not excuse contradictory bounded facts %#",
  (change) => {
    const f = codexFixture();
    change(f);
    f.support = codexSupportFixture(f);
    expect(() => bindCodex(f)).toThrow();
  },
);
test("transient file-byte map refuses proxy/accessor inputs before caller effects", () => {
  const f = codexFixture();
  const files = codexFiles(f);
  let calls = 0;
  const proxy = new Proxy(files, {
    ownKeys() {
      calls++;
      return [];
    },
    get() {
      calls++;
    },
  });
  const accessor = { ...files };
  Object.defineProperty(accessor, "evidence.json", {
    enumerable: true,
    get() {
      calls++;
      return files["evidence.json"];
    },
  });
  const revoked = Proxy.revocable(files, {});
  revoked.revoke();
  for (const input of [proxy, accessor, revoked.proxy])
    expect(() =>
      bindCodexScenarioEvidence(encode(f.prepared), encode(f.support), input),
    ).toThrow();
  expect(calls).toBe(0);
});
function controlsFixture() {
  return {
    state: "operator-controls-observed",
    repository: "Melbourneandrew/agentscope",
    ownerId: 25971425,
    ownerLogin: "Melbourneandrew",
    inspectedAt: "2026-10-08T00:00:00.000Z",
    responseCount: 8,
    responses: [
      "/user",
      "/rulesets?per_page=100",
      "/rulesets/24696278",
      "/rulesets/24696353",
      "/immutable-releases",
      "/branches/main/protection",
      "/environments/npm-release",
      "/environments/npm-release/deployment-branch-policies?per_page=100",
    ].map((path) => ({ path, bytes: 1, digest: `sha256:${"a".repeat(64)}` })),
  };
}
const controlsExpiry = "2026-10-08T00:15:00.000Z";
function integrationFixture() {
  const revision = "a".repeat(40);
  const run = {
    id: 123,
    head_sha: revision,
    repository: { full_name: "Melbourneandrew/agentscope" },
    head_repository: { full_name: "Melbourneandrew/agentscope" },
    path: ".github/workflows/integration.yml",
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
  };
  const jobs = {
    total_count: 2,
    jobs: ["Prepare immutable candidate", "Hermetic shard 0-of-1 replay 1"].map(
      (name) => ({
        name,
        run_id: 123,
        head_sha: revision,
        status: "completed",
        conclusion: "success",
        started_at: "2026-10-08T00:00:00Z",
        completed_at: "2026-10-08T00:02:00Z",
      }),
    ),
  };
  const artifacts = {
    total_count: 2,
    artifacts: [
      `integration-candidate-${revision}`,
      "integration-0-of-1-1",
    ].map((name, index) => ({
      name,
      id: index + 1,
      size_in_bytes: 1,
      expired: false,
      workflow_run: { id: 123, head_sha: revision },
      created_at: "2026-10-08T00:01:00Z",
      updated_at: "2026-10-08T00:01:00Z",
      digest: `sha256:${"b".repeat(64)}`,
    })),
  };
  return { revision, run, jobs, artifacts };
}
const bindArtifacts = (f) =>
  bindIntegrationArtifacts(
    encode(f.run),
    encode(f.jobs),
    encode(f.artifacts),
    123,
    f.revision,
  );
test("binds immutable IDs to the successful selected attempt, not job labels as semantic proof", () => {
  expect(bindArtifacts(integrationFixture())).toEqual({
    candidateArtifactId: 1,
    scenarioArtifactId: 2,
    runAttempt: 2,
  });
});
test.each([
  (f) => {
    f.run.event = "pull_request";
  },
  (f) => {
    f.run.head_sha = "b".repeat(40);
  },
  (f) => {
    f.run.path = ".github/workflows/release.yml";
  },
  (f) => {
    f.run.conclusion = "failure";
  },
  (f) => {
    f.run.head_repository.full_name = "other/agentscope";
  },
  (f) => {
    f.jobs.total_count++;
  },
  (f) => {
    f.jobs.jobs[1].conclusion = "failure";
  },
  (f) => {
    f.jobs.jobs[1].run_attempt = 1;
  },
  (f) => {
    f.artifacts.artifacts[1].created_at = "2026-10-07T00:01:00Z";
  },
  (f) => {
    f.artifacts.artifacts[1].updated_at = "2026-10-08T00:03:00Z";
  },
  (f) => {
    f.artifacts.artifacts[1].expired = true;
  },
  (f) => {
    f.artifacts.artifacts[1].workflow_run.id = 456;
  },
  (f) => {
    f.artifacts.artifacts.push(f.artifacts.artifacts[1]);
    f.artifacts.total_count++;
  },
])(
  "refuses substituted/truncated/old-attempt Integration artifacts %#",
  (change) => {
    const f = integrationFixture();
    change(f);
    expect(() => bindArtifacts(f)).toThrow();
  },
);
const controlsConsumption = "2026-10-08T00:10:00.000Z";
test("projects finite owner controls without widening recorder DTO grammar", () => {
  const report = JSON.stringify(controlsFixture());
  expect(
    projectOperatorControlsReport(report, controlsExpiry, controlsConsumption),
  ).toEqual({
    controlsReportDigest: sha256(Buffer.from(report)),
    controlsInspectedAt: "2026-10-08T00:00:00.000Z",
  });
});
test.each([
  (r) => {
    r.ownerId = 1;
  },
  (r) => {
    r.ownerLogin = "other";
  },
  (r) => {
    r.repository = "other/repository";
  },
  (r) => {
    r.responses.pop();
  },
  (r) => {
    r.responses.reverse();
  },
  (r) => {
    r.responses[3] = r.responses[2];
  },
  (r) => {
    r.responses[2].path = ["/rulesets/11"];
  },
  (r) => {
    r.responses[2].path = ["/rulesets/11"];
    r.responses[3].path = ["/rulesets/11"];
  },
  (r) => {
    r.responses[0].bytes = 1_048_577;
  },
  (r) => {
    r.responses[0].digest = "success";
  },
  (r) => {
    r.responses[0].body = "unretained settings";
  },
  (r) => {
    r.inspectedAt = "2026-10-08T00:11:00.000Z";
  },
])("rejects changed finite controls report %#", (change) => {
  const report = controlsFixture();
  change(report);
  expect(() =>
    projectOperatorControlsReport(
      JSON.stringify(report),
      controlsExpiry,
      controlsConsumption,
    ),
  ).toThrow();
});
test("does not renew an old controls report after queueing", () => {
  const report = JSON.stringify(controlsFixture());
  for (const [expires, observed] of [
    [controlsExpiry, "2026-10-08T00:15:00.001Z"],
    ["2026-10-08T00:16:00.000Z", controlsConsumption],
    [controlsExpiry, "2026-10-07T23:59:59.999Z"],
    [controlsExpiry, "invalid"],
  ])
    expect(() =>
      projectOperatorControlsReport(report, expires, observed),
    ).toThrow();
  expect(() =>
    projectOperatorControlsReport(
      " ".repeat(4097),
      controlsExpiry,
      controlsConsumption,
    ),
  ).toThrow();
});
test("binds CLI bytes independently of prepared bundle identity", () => {
  const f = fixture();
  const bound = bindPreparedCliEvidence(
    encode(f.evidence),
    encode(f.manifest),
    f.tarball,
  );
  expect(bound.cliSha256).not.toBe(bound.bundleIdentity);
  expect(Object.isFrozen(bound)).toBe(true);
});
test("rejects changed bytes, SRI, revision and duplicate CLI rows", () => {
  for (const change of [
    (f) => {
      f.tarball = Buffer.from("other");
    },
    (f) => {
      f.manifest.tarball.integrity = "sha512-wrong";
    },
    (f) => {
      f.manifest.sourceRevision = "b".repeat(40);
    },
    (f) => {
      f.evidence.artifacts.push(f.evidence.artifacts[0]);
    },
  ]) {
    const f = fixture();
    change(f);
    expect(() =>
      bindPreparedCliEvidence(
        encode(f.evidence),
        encode(f.manifest),
        f.tarball,
      ),
    ).toThrow();
  }
});
test("certified label or successful job cannot supply missing OTLP evidence", () => {
  expect(() =>
    requireActualSemanticAdmission({
      state: "certified",
      conclusion: "success",
    }),
  ).toThrow("release.admission.actual-otlp-evidence-missing");
});
test("bounded bytes reject Proxy before traps and reject excessive depth", () => {
  let traps = 0;
  const hostile = new Proxy(Buffer.from("{}"), {
    get() {
      traps++;
      throw new Error("caller");
    },
  });
  expect(() => parseAdmissionDocument(hostile)).toThrow();
  expect(traps).toBe(0);
  expect(() =>
    parseAdmissionDocument(Buffer.from("[".repeat(18) + "0" + "]".repeat(18))),
  ).toThrow();
});
