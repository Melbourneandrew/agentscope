#!/usr/bin/env node

import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const environmentPattern = /^asgcf_[a-f0-9]{32}$/u;
const identifierPattern = /^[A-Za-z0-9._:-]{1,160}$/u;

function fail(message) {
  process.stderr.write(`crabbox coordinator plan: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: crabbox-coordinator-plan.mjs --plan <plan.json> --plan-signature <base64-file> --owner-key <public.pem> --observation <observation.json> --observation-signature <base64-file> --observation-key <public.pem> --profile <profile.json> --admission <admission.json> --permission-manifest <manifest.json>",
      );
    }
    parsed[key.slice(2)] = value;
  }
  const required = [
    "plan",
    "plan-signature",
    "owner-key",
    "observation",
    "observation-signature",
    "observation-key",
    "profile",
    "admission",
    "permission-manifest",
  ];
  for (const key of required) {
    if (!parsed[key]) {
      throw new Error(`--${key} is required`);
    }
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(label, value, keys) {
  const actual = Object.keys(value ?? {}).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields differ from the admitted schema`);
  }
}

function verifyDetached(label, payload, signatureText, publicKey) {
  const signature = Buffer.from(signatureText.trim(), "base64");
  if (signature.length === 0 || !verify(null, payload, publicKey, signature)) {
    throw new Error(`${label} signature is invalid`);
  }
}

function assertDigest(label, value) {
  if (!sha256Pattern.test(value ?? "")) {
    throw new Error(`${label} is not a SHA-256 identity`);
  }
}

function validateObservation(observation, plan, admission, now) {
  exactKeys("plan observation", observation, [
    "schemaVersion",
    "accountId",
    "credentialRole",
    "workersPlan",
    "paidOrOverageEnabled",
    "observedAt",
    "expiresAt",
    "observationId",
  ]);
  if (
    observation.schemaVersion !== 1 ||
    observation.accountId !== plan.accountId ||
    observation.credentialRole !== "billing-product-read-only" ||
    observation.workersPlan !== admission.deployment.workersPlan ||
    observation.paidOrOverageEnabled !== false ||
    !identifierPattern.test(observation.observationId ?? "")
  ) {
    throw new Error(
      "plan observation does not prove the admitted Free/no-overage account state",
    );
  }
  const observedAt = Date.parse(observation.observedAt);
  const expiresAt = Date.parse(observation.expiresAt);
  const maxAge = admission.deployment.planObservationMaxAgeMinutes * 60_000;
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    observedAt > now ||
    expiresAt <= now ||
    expiresAt - observedAt > maxAge ||
    now - observedAt > maxAge
  ) {
    throw new Error(
      "plan observation is stale, future-dated, or exceeds its admitted lifetime",
    );
  }
}

function validateOperation(operation, plan, admission, manifest) {
  const allAllowed = new Set([
    ...manifest.ordinaryMutationActions,
    ...manifest.separateOwnerPlanActions,
    ...manifest.retirementOnlyActions,
  ]);
  if (
    !allAllowed.has(operation.action) ||
    manifest.forbiddenActions.includes(operation.action)
  ) {
    throw new Error(`operation ${operation.action} is not admitted`);
  }
  if (
    operation.target !== plan.workerName &&
    operation.action !== "account.workersDev.enable"
  ) {
    throw new Error("operation target differs from the exact Worker");
  }
  if (
    operation.action === "account.workersDev.enable" &&
    plan.kind !== "account-workers-dev-enable"
  ) {
    throw new Error(
      "account workers.dev activation requires its separate plan kind",
    );
  }
  if (
    manifest.retirementOnlyActions.includes(operation.action) &&
    plan.kind !== "retire"
  ) {
    throw new Error("retirement action appears outside a retirement plan");
  }
  if (
    operation.action === "worker.secret.put" ||
    operation.action === "worker.secret.delete"
  ) {
    exactKeys("secret operation", operation, [
      "action",
      "target",
      "secretName",
      "slotId",
      "slotVersion",
    ]);
    if (
      !admission.deployment.secretNames.includes(operation.secretName) ||
      !identifierPattern.test(operation.slotId ?? "") ||
      !identifierPattern.test(operation.slotVersion ?? "")
    ) {
      throw new Error(
        "secret operation is not bound to an admitted opaque slot/version",
      );
    }
  } else {
    exactKeys("operation", operation, ["action", "target"]);
  }
}

function validatePlan({
  plan,
  profile,
  admission,
  manifest,
  observation,
  now,
}) {
  exactKeys("plan", plan, [
    "schemaVersion",
    "kind",
    "accountId",
    "environmentId",
    "workerName",
    "sourceCommit",
    "toolchainIdentity",
    "profileSha256",
    "permissionManifestSha256",
    "observablePrestateSha256",
    "observationId",
    "operations",
    "rollbackActions",
    "issuedAt",
    "expiresAt",
    "nonce",
    "intendedTerminalStateSha256",
  ]);
  if (
    plan.schemaVersion !== 1 ||
    !["deploy", "rollback", "retire", "account-workers-dev-enable"].includes(
      plan.kind,
    ) ||
    !identifierPattern.test(plan.accountId ?? "") ||
    !environmentPattern.test(plan.environmentId ?? "") ||
    plan.workerName !== admission.deployment.workerName ||
    plan.environmentId !== profile.vars?.AGENTSCOPE_CRABBOX_ENVIRONMENT_ID ||
    plan.sourceCommit !== admission.coordinator.commit ||
    plan.observationId !== observation.observationId ||
    !identifierPattern.test(plan.toolchainIdentity ?? "") ||
    !identifierPattern.test(plan.nonce ?? "")
  ) {
    throw new Error("plan identity differs from admitted deployment authority");
  }
  for (const [label, value] of [
    ["profileSha256", plan.profileSha256],
    ["permissionManifestSha256", plan.permissionManifestSha256],
    ["observablePrestateSha256", plan.observablePrestateSha256],
    ["intendedTerminalStateSha256", plan.intendedTerminalStateSha256],
  ]) {
    assertDigest(label, value);
  }
  const issuedAt = Date.parse(plan.issuedAt);
  const expiresAt = Date.parse(plan.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now ||
    expiresAt <= now
  ) {
    throw new Error("plan is future-dated or expired");
  }
  if (
    !Array.isArray(plan.operations) ||
    plan.operations.length === 0 ||
    !Array.isArray(plan.rollbackActions)
  ) {
    throw new Error(
      "plan operations and rollback actions must be closed arrays",
    );
  }
  const operationIdentities = new Set();
  for (const operation of [...plan.operations, ...plan.rollbackActions]) {
    validateOperation(operation, plan, admission, manifest);
    const identity = JSON.stringify(operation);
    if (operationIdentities.has(identity)) {
      throw new Error("plan contains a duplicate operation");
    }
    operationIdentities.add(identity);
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const paths = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, resolve(value)]),
  );
  const [
    planBytes,
    planSignature,
    ownerKey,
    observationBytes,
    observationSignature,
    observationKey,
    profileBytes,
    admissionBytes,
    manifestBytes,
  ] = await Promise.all([
    readFile(paths.plan),
    readFile(paths["plan-signature"], "utf8"),
    readFile(paths["owner-key"]),
    readFile(paths.observation),
    readFile(paths["observation-signature"], "utf8"),
    readFile(paths["observation-key"]),
    readFile(paths.profile),
    readFile(paths.admission),
    readFile(paths["permission-manifest"]),
  ]);
  verifyDetached("owner plan", planBytes, planSignature, ownerKey);
  verifyDetached(
    "plan observation",
    observationBytes,
    observationSignature,
    observationKey,
  );
  const plan = JSON.parse(planBytes);
  const observation = JSON.parse(observationBytes);
  const profile = JSON.parse(profileBytes);
  const admission = JSON.parse(admissionBytes);
  const manifest = JSON.parse(manifestBytes);
  const now = Date.now();
  if (
    sha256(profileBytes) !== plan.profileSha256 ||
    sha256(manifestBytes) !== plan.permissionManifestSha256
  ) {
    throw new Error(
      "plan profile or permission-manifest digest differs from the supplied artifact",
    );
  }
  validateObservation(observation, plan, admission, now);
  validatePlan({ plan, profile, admission, manifest, observation, now });
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        planSha256: sha256(planBytes),
        accountId: plan.accountId,
        environmentId: plan.environmentId,
        workerName: plan.workerName,
        kind: plan.kind,
        nonce: plan.nonce,
        expiresAt: plan.expiresAt,
        observationId: observation.observationId,
        operationCount: plan.operations.length,
        rollbackCount: plan.rollbackActions.length,
        secretValuesPresent: false,
        consumed: false,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
