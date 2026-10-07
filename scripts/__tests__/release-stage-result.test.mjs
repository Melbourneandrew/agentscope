import assert from "node:assert/strict";
import { test } from "vitest";

import {
  purePolicyFiles,
  requiredPolicyFiles,
} from "../workspace-policy-inventory.mjs";
import { canonicalJson, sha256 } from "../release-lane/validation.mjs";
import { validateStageResult } from "../release-lane/stage-result.mjs";

const hash = `sha256:${"a".repeat(64)}`;
const tuple = (kind = "product") => ({
  kind,
  transactionId: "transaction-1",
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
  ownerCheckpointDigest: hash,
});
const result = (binding, response = "received") => ({
  schemaVersion: 1,
  tuple: binding,
  response,
  stageId: response === "received" ? "stage-1" : null,
});

test.each(["product", "probe"])(
  "validates exact %s tuple without authenticating it",
  (kind) => {
    const binding = tuple(kind);
    const raw = result(binding);
    const projected = validateStageResult(raw, binding);
    assert.equal(projected.stageResultDigest, sha256(canonicalJson(raw)));
    assert.equal(projected.stageId, "stage-1");
    assert.ok(Object.isFrozen(projected) && Object.isFrozen(projected.tuple));
    binding.version = "substituted";
    assert.notEqual(projected.tuple.version, binding.version);
  },
);
test.each(["missing", "ambiguous"])(
  "preserves %s without inventing stage identity",
  (response) => {
    const binding = tuple();
    assert.equal(
      validateStageResult(result(binding, response), binding).stageId,
      null,
    );
  },
);
test.each([
  "candidateManifestDigest",
  "tarballSha256",
  "workflowDigest",
  "releaseScriptsDigest",
  "ownerCheckpointDigest",
  "sourceRevision",
  "transactionId",
])("rejects substituted %s", (key) => {
  const binding = tuple();
  const substituted = {
    ...binding,
    [key]:
      key === "sourceRevision"
        ? "c".repeat(40)
        : key === "transactionId"
          ? "transaction-2"
          : `sha256:${"c".repeat(64)}`,
  };
  assert.throws(() => validateStageResult(result(substituted), binding));
});
test.each([
  { kind: "synthetic" },
  { transactionId: 123 },
  { package: "@agentscope/core" },
  { distTag: "latest" },
  { protectedTag: null },
  { version: "0.1.1" },
  { integrity: "invalid" },
])("rejects invalid tuple %j", (change) => {
  const binding = { ...tuple(), ...change };
  assert.throws(() => validateStageResult(result(binding), binding));
});
test.each([
  { response: "success" },
  { stageId: "" },
  { stageId: "stage/unsafe" },
  { stageId: "a".repeat(129) },
  { response: "missing", stageId: "stage-1" },
  { schemaVersion: 2 },
  { extra: true },
])("rejects malformed result %j", (change) => {
  const binding = tuple();
  assert.throws(() =>
    validateStageResult({ ...result(binding), ...change }, binding),
  );
});
test("refuses proxies/getters/cycles/oversize without invoking caller code", () => {
  const binding = tuple();
  let calls = 0;
  const proxy = new Proxy(result(binding), {
    ownKeys() {
      calls += 1;
      return [];
    },
  });
  assert.throws(() => validateStageResult(proxy, binding));
  const accessor = result(binding);
  Object.defineProperty(accessor, "stageId", {
    get() {
      calls += 1;
      return "stage-1";
    },
  });
  assert.throws(() => validateStageResult(accessor, binding));
  const cyclic = result(binding);
  cyclic.tuple = cyclic;
  assert.throws(() => validateStageResult(cyclic, binding));
  assert.throws(() =>
    validateStageResult(
      { ...result(binding), stageId: "a".repeat(4097) },
      binding,
    ),
  );
  assert.equal(calls, 0);
});
test("classifies both new suites exactly once as required pure policy", () => {
  for (const name of [
    "release-production-recorder.test.mjs",
    "release-stage-result.test.mjs",
  ]) {
    assert.equal(purePolicyFiles.filter((file) => file === name).length, 1);
    assert.equal(requiredPolicyFiles.filter((file) => file === name).length, 1);
  }
});
