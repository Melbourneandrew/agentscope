import assert from "node:assert/strict";
import { test } from "vitest";

import {
  proposeStageRecord,
  validateStageCheckpoint,
  validateProbeMaterial,
} from "../release-lane/production-recorder.mjs";
import { canonicalJson, sha256 } from "../release-lane/validation.mjs";

const hash = `sha256:${"a".repeat(64)}`;
test("probe material binds actual preparation run/attempt, not a fabricated product", () => {
  const material = {
    schemaVersion: 1,
    kind: "inert-probe-material",
    preparationRunId: 40,
    preparationRunAttempt: 1,
    sourceRevision: "b".repeat(40),
    workflowDigest: hash,
    releaseScriptsDigest: hash,
    version: "0.0.0-oidc-probe.40-1",
    tarballFilename: "agentscope-cli-0.0.0-oidc-probe.40-1.tgz",
    tarballSha256: hash,
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    inventoryDigest: hash,
  };
  assert.equal(validateProbeMaterial(material).version, material.version);
  for (const change of [
    { preparationRunId: 41 },
    { preparationRunAttempt: 2 },
    { kind: "product" },
    { version: "0.1.0" },
    { tarballFilename: "../probe.tgz" },
    { workflowDigest: [] },
  ])
    assert.throws(() => validateProbeMaterial({ ...material, ...change }));
  assert.throws(() =>
    validateProbeMaterial({ ...material, draftReleaseDatabaseId: 7 }),
  );
});
const controlsReport = JSON.stringify({
  state: "operator-controls-observed",
  repository: "Melbourneandrew/agentscope",
  ownerId: 25971425,
  ownerLogin: "Melbourneandrew",
  inspectedAt: "2026-10-07T00:00:00.000Z",
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
  ].map((path) => ({ path, bytes: 1, digest: hash })),
});
function fixture(kind = "product", response = "received") {
  const checkpoint = {
    transactionId: "transaction-1",
    draftReleaseDatabaseId: kind === "product" ? 123 : null,
    ownerIdentity: "Melbourneandrew",
    pendingStagesState: "none-conflicting",
    issuedAt: "2026-10-07T00:00:00.000Z",
    expiresAt: "2026-10-07T00:15:00.000Z",
    consumedAt: "2026-10-07T00:01:00.000Z",
    state: "consumed-for-stage",
    authenticationDigest: hash,
    phase: "pre-stage",
    sourceRevision: "b".repeat(40),
    candidateManifestDigest: hash,
    expectedSequence: 3,
    expectedPriorDigest: hash,
    controlsReport,
    controlsReportDigest: sha256(Buffer.from(controlsReport)),
    controlsInspectedAt: "2026-10-07T00:00:00.000Z",
  };
  const tuple = {
    kind,
    transactionId: checkpoint.transactionId,
    candidateManifestDigest: hash,
    tarballSha256: hash,
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    sourceRevision: "b".repeat(40),
    protectedTag: kind === "product" ? "v0.1.0" : null,
    package: "agentscope-cli",
    version: kind === "product" ? "0.1.0" : "0.0.0-oidc-probe.nonce-1",
    distTag: kind === "product" ? "alpha" : "oidc-probe",
    workflowDigest: hash,
    releaseScriptsDigest: hash,
    ownerCheckpointDigest: sha256(canonicalJson(checkpoint)),
  };
  return {
    tuple,
    head: {
      schemaVersion: 1,
      sequence: 4,
      digest: hash,
      previousDigest: hash,
      transition: "pre-stage-intent",
      ownerCheckpointDigest: tuple.ownerCheckpointDigest,
      transactionId: tuple.transactionId,
      draftReleaseDatabaseId: checkpoint.draftReleaseDatabaseId,
      candidateManifestDigest: hash,
      sourceRevision: tuple.sourceRevision,
      kind,
    },
    expectedSequence: 4,
    expectedPriorDigest: hash,
    ownerCheckpoint: checkpoint,
    stageResult: {
      schemaVersion: 1,
      tuple: { ...tuple },
      response,
      stageId: response === "received" ? "stage-1" : null,
    },
    observedAt: "2026-10-07T01:00:00.000Z",
    actor: "recorder-1",
  };
}

test.each(["product"])(
  "constructs inert %s stage proposal, never append authority",
  (kind) => {
    const input = fixture(kind);
    const output = proposeStageRecord(input);
    assert.equal(output.disposition, "inert-append-proposal-not-authorized");
    assert.equal(output.expectedSequence, 4);
    assert.equal(output.expectedPriorDigest, hash);
    assert.equal(output.record.sequence, 5);
    assert.equal(output.record.previousDigest, hash);
    assert.equal(output.record.transition, "stage-recorded");
    assert.equal(output.record.payload.kind, kind);
    assert.equal(
      output.record.payload.draftReleaseDatabaseId,
      kind === "product" ? 123 : null,
    );
    const { digest, ...unsigned } = output.record;
    assert.equal(digest, sha256(canonicalJson(unsigned)));
    input.stageResult.stageId = "changed";
    assert.equal(output.record.payload.stageId, "stage-1");
    assert.ok(
      Object.isFrozen(output) && Object.isFrozen(output.record.payload),
    );
  },
);
test("refuses probe results at the product recorder boundary", () => {
  assert.throws(() => proposeStageRecord(fixture("probe")));
});
test("stage expiry gates mutation without discarding a later recorded outcome", () => {
  const input = fixture();
  const stage = {
    tuple: input.tuple,
    head: input.head,
    ownerCheckpoint: input.ownerCheckpoint,
    observedAt: "2026-10-07T00:14:59.999Z",
  };
  assert.equal(validateStageCheckpoint(stage).kind, "product");
  for (const observedAt of [
    "2026-10-07T00:15:00.000Z",
    "2026-10-07T01:00:00.000Z",
    "2026-10-07T00:00:00.000Z",
  ])
    assert.throws(() => validateStageCheckpoint({ ...stage, observedAt }));
  assert.equal(proposeStageRecord(input).record.transition, "stage-recorded");
});
test("refuses the former unconsumed draft-prepared head", () => {
  const input = fixture();
  input.head.transition = "draft-prepared";
  assert.throws(() => proposeStageRecord(input));
});
test.each(["missing", "ambiguous"])(
  "quarantines %s as unresolved, never accepted",
  (response) => {
    const output = proposeStageRecord(fixture("product", response));
    assert.equal(output.record.transition, "quarantine-still-draft");
    assert.equal(output.record.payload.stageId, null);
    assert.equal(
      output.record.payload.failureClass,
      `${response}-stage-response`,
    );
    assert.equal(output.record.payload.state, "frozen-unresolved");
    assert.equal(output.record.payload.terminal, false);
  },
);
test.each([
  "sequence",
  "digest",
  "transactionId",
  "transition",
  "kind",
  "candidateManifestDigest",
  "sourceRevision",
  "draftReleaseDatabaseId",
])("rejects drift in head %s", (key) => {
  const input = fixture();
  input.head[key] =
    key === "sequence"
      ? 5
      : key === "draftReleaseDatabaseId"
        ? "synthetic-release-1"
        : "drift";
  assert.throws(() => proposeStageRecord(input));
});
test.each(["expectedSequence", "expectedPriorDigest"])(
  "rejects stale compare-and-swap %s",
  (key) => {
    const input = fixture();
    input[key] = key === "expectedSequence" ? 3 : `sha256:${"c".repeat(64)}`;
    assert.throws(() => proposeStageRecord(input));
  },
);
test.each([
  { state: "unconsumed" },
  { pendingStagesState: "unknown" },
  { ownerIdentity: "other-owner" },
  { transactionId: "other" },
  { draftReleaseDatabaseId: 124 },
  { consumedAt: "2026-10-07T00:16:00.000Z" },
  { issuedAt: "invalid" },
  { expiresAt: "2026-10-07T00:16:00.000Z" },
  { phase: "pre-release" },
  { sourceRevision: "c".repeat(40) },
  { candidateManifestDigest: `sha256:${"c".repeat(64)}` },
  { expectedSequence: 2 },
  { expectedPriorDigest: `sha256:${"c".repeat(64)}` },
  { controlsReport: "{}" },
  { controlsReportDigest: `sha256:${"c".repeat(64)}` },
  { controlsInspectedAt: "2026-10-07T00:01:00.000Z" },
])("rejects invalid checkpoint %j even if selfhash is updated", (change) => {
  const input = fixture();
  Object.assign(input.ownerCheckpoint, change);
  input.tuple.ownerCheckpointDigest = sha256(
    canonicalJson(input.ownerCheckpoint),
  );
  input.stageResult.tuple.ownerCheckpointDigest =
    input.tuple.ownerCheckpointDigest;
  input.head.ownerCheckpointDigest = input.tuple.ownerCheckpointDigest;
  assert.throws(() => proposeStageRecord(input));
});
test("rejects substituted checkpoint digest and observation before consumption", () => {
  const input = fixture();
  input.ownerCheckpoint.ownerIdentity = "owner-2";
  assert.throws(() => proposeStageRecord(input));
  const early = fixture();
  early.observedAt = "2026-10-07T00:00:00.000Z";
  assert.throws(() => proposeStageRecord(early));
});
test("refuses hostile inputs and synthetic extra authority without executing getters", () => {
  let calls = 0;
  const input = fixture();
  Object.defineProperty(input.ownerCheckpoint, "ownerIdentity", {
    get() {
      calls += 1;
      return "owner-1";
    },
  });
  assert.throws(() => proposeStageRecord(input));
  assert.equal(calls, 0);
  assert.throws(() => proposeStageRecord({ ...fixture(), simulation: true }));
  const revoked = Proxy.revocable(fixture(), {});
  revoked.revoke();
  assert.throws(() => proposeStageRecord(revoked.proxy));
});
