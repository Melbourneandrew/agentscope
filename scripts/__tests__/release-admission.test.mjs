import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  bindPreparedCliEvidence,
  bindCodexScenarioEvidence,
  bindIntegrationArtifacts,
  parseAdmissionDocument,
  projectOperatorControlsReport,
  requireActualSemanticAdmission,
} from "../release-lane/admission.mjs";
import { canonicalJson, sha256 } from "../release-lane/validation.mjs";
import { deriveIdentityBundle } from "@agentscope/protocol";

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
function codexSupportFixture(f) {
  const { prepared, evidence, lifecycle, model, destination, observation } = f;
  const { runId, scenarioId, ptyTerminalReceipt: receipt } = evidence;
  const seed = {
    productIdentity: "agentscope-cli",
    runId,
    candidateDigest: prepared.bundleIdentity,
    manifestIdentity: evidence.manifestIdentity,
    scenarioId,
    execution: { mode: "interactive", outputContract: "semantic-pty" },
    harness: { registryIdentity: "@agentscope/harness-codex" },
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
        harnessType: "@agentscope/harness-codex",
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
