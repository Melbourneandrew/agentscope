#!/usr/bin/env node

import { verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import {
  readCanonicalPolicy,
  sha256,
  validateLiveProfile,
} from "./lib/crabbox-coordinator-policy.mjs";
import { validateTerminalProfile } from "./crabbox-coordinator-retirement-profile.mjs";

const digestPattern = /^[a-f0-9]{64}$/u;
const environmentPattern = /^asgcf_[a-f0-9]{32}$/u;
const identifierPattern = /^[A-Za-z0-9._:-]{1,200}$/u;

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function terminalContractSha256(plan, admission) {
  const contract = {
    accountId: plan.accountId,
    environmentId: plan.environmentId,
    kind: plan.kind,
    permissionManifestSha256: plan.permissionManifestSha256,
    profileSha256: plan.profileSha256,
    workerName: plan.workerName,
  };
  if (plan.kind === "retire") {
    Object.assign(contract, {
      cron: "absent",
      durableObjectClass: "deleted:FleetDurableObject",
      providerZeroSha256: plan.providerZeroSha256,
      retirementTombstoneSha256: plan.retirementTombstoneSha256,
      secretNames: [],
      scriptWorkersDev: false,
      worker: "absent",
    });
  } else if (plan.kind === "account-workers-dev-enable") {
    Object.assign(contract, {
      accountWorkersDev: `enabled:${plan.operations[0]?.subdomain ?? "invalid"}`,
      worker: "unchanged",
    });
  } else {
    Object.assign(contract, {
      cron: admission.deployment.cron,
      durableObjectBinding: admission.deployment.durableObjectBinding,
      durableObjectClass: admission.deployment.durableObjectClass,
      migrationTag: plan.currentMigrationTag,
      secretNames: admission.deployment.secretNames,
      scriptWorkersDev: true,
      worker: "present",
    });
    Object.assign(
      contract,
      plan.currentWorkerVersionId === "absent"
        ? {
            durableObjectNamespace: "create-exactly-one-owned-namespace",
            migrationTag: "v1",
          }
        : {
            durableObjectNamespace: plan.durableObjectNamespaceId,
            migrationTag: plan.currentMigrationTag,
          },
    );
  }
  return sha256(JSON.stringify(canonicalJson(contract)));
}

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
      throw new Error("plan verifier arguments must be --name value pairs");
    }
    parsed[key.slice(2)] = value;
  }
  const required = [
    "plan",
    "plan-signature",
    "candidate-owner-key",
    "observation",
    "observation-signature",
    "candidate-observation-key",
    "profile",
  ];
  for (const key of required) {
    if (!parsed[key]) {
      throw new Error(`--${key} is required`);
    }
  }
  return parsed;
}

function exactKeys(label, value, keys) {
  if (
    JSON.stringify(Object.keys(value ?? {}).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    throw new Error(`${label} fields differ from the admitted schema`);
  }
}

function assertIdentifier(label, value) {
  if (!identifierPattern.test(value ?? "")) {
    throw new Error(`${label} is not a bounded identity`);
  }
}

function assertDigest(label, value) {
  if (!digestPattern.test(value ?? "")) {
    throw new Error(`${label} is not a SHA-256 identity`);
  }
}

function verifyCandidateSignature(label, payload, signatureText, publicKey) {
  const signature = Buffer.from(signatureText.trim(), "base64");
  if (signature.length === 0 || !verify(null, payload, publicKey, signature)) {
    throw new Error(`${label} candidate signature is invalid`);
  }
}

function validateQuotaProjection(quotas, quotaNames) {
  exactKeys("quota projection", quotas, quotaNames);
  for (const name of quotaNames) {
    const quota = quotas[name];
    exactKeys(`quota ${name}`, quota, ["limit", "used", "sourceIdentity"]);
    if (
      !Number.isFinite(quota.limit) ||
      quota.limit <= 0 ||
      !Number.isFinite(quota.used) ||
      quota.used < 0 ||
      quota.used > quota.limit ||
      quota.used * 100 >= quota.limit * 80 ||
      !identifierPattern.test(quota.sourceIdentity ?? "")
    ) {
      throw new Error(`quota ${name} is incomplete`);
    }
  }
}

function validateObservation(observation, plan, admission, now) {
  exactKeys("plan observation", observation, [
    "schemaVersion",
    "accountId",
    "credentialRole",
    "workersPlan",
    "paidOrOverageEnabled",
    "allAccountConsumersIncluded",
    "quotas",
    "observedAt",
    "expiresAt",
    "observationId",
  ]);
  if (
    observation.schemaVersion !== 1 ||
    observation.accountId !== plan.accountId ||
    observation.credentialRole !== "candidate-billing-product-read-only" ||
    observation.workersPlan !== admission.deployment.workersPlan ||
    observation.paidOrOverageEnabled !== false ||
    observation.allAccountConsumersIncluded !== true
  ) {
    throw new Error(
      "observation does not describe the admitted Free/no-overage account state",
    );
  }
  assertIdentifier("observationId", observation.observationId);
  validateQuotaProjection(
    observation.quotas,
    admission.deployment.requiredQuotaProjections,
  );
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
      "observation is stale, future-dated, or exceeds its admitted lifetime",
    );
  }
}

function validateToolchain(toolchain, admission) {
  exactKeys("toolchain identity", toolchain, [
    "nodeVersion",
    "nodeArchiveSha256",
    "wranglerVersion",
    "workerLockSha256",
    "goVersion",
    "goArchiveSha256",
    "crabboxClientSha256",
  ]);
  const expected = {
    nodeVersion: admission.toolchains.node.version,
    nodeArchiveSha256: admission.toolchains.node.archiveSha256,
    wranglerVersion: admission.coordinator.wranglerVersion,
    workerLockSha256: admission.coordinator.workerLockSha256,
    goVersion: admission.toolchains.go.version,
    goArchiveSha256: admission.toolchains.go.archiveSha256,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (toolchain[name] !== value) {
      throw new Error(`toolchain ${name} differs from canonical admission`);
    }
  }
  assertDigest("crabboxClientSha256", toolchain.crabboxClientSha256);
}

function operationSchema(action) {
  const schemas = {
    "worker.deploy": [
      "action",
      "target",
      "requestId",
      "profileSha256",
      "expectedPreviousVersionId",
    ],
    "worker.rollback": [
      "action",
      "target",
      "requestId",
      "versionId",
      "compatibleMigrationTag",
    ],
    "worker.secret.put": [
      "action",
      "target",
      "requestId",
      "secretName",
      "slotId",
      "slotVersion",
    ],
    "worker.secret.delete": [
      "action",
      "target",
      "requestId",
      "secretName",
      "slotId",
      "slotVersion",
    ],
    "worker.schedule.delete": ["action", "target", "requestId"],
    "worker.scriptWorkersDev.disable": ["action", "target", "requestId"],
    "account.workersDev.enable": ["action", "target", "requestId", "subdomain"],
    "worker.terminalArtifact.deploy": [
      "action",
      "target",
      "requestId",
      "profileSha256",
      "entryPointSha256",
      "providerZeroSha256",
      "retirementTombstoneSha256",
    ],
    "worker.version.delete": ["action", "target", "requestId", "versionId"],
    "worker.delete": ["action", "target", "requestId"],
  };
  return schemas[action];
}

function allowedActions(kind) {
  return {
    deploy: new Set(["worker.secret.put", "worker.deploy"]),
    "rotate-secrets": new Set(["worker.secret.put"]),
    rollback: new Set(["worker.rollback"]),
    "account-workers-dev-enable": new Set(["account.workersDev.enable"]),
    retire: new Set([
      "worker.schedule.delete",
      "worker.scriptWorkersDev.disable",
      "worker.secret.delete",
      "worker.terminalArtifact.deploy",
      "worker.version.delete",
      "worker.delete",
    ]),
  }[kind];
}

function validateOperationAdmission(operation, plan, admission, manifest) {
  const schema = operationSchema(operation.action);
  const manifestActions = new Set([
    ...manifest.ordinaryMutationActions,
    ...manifest.separateOwnerPlanActions,
    ...manifest.retirementOnlyActions,
  ]);
  if (
    !schema ||
    !allowedActions(plan.kind)?.has(operation.action) ||
    !manifestActions.has(operation.action) ||
    manifest.forbiddenActions.includes(operation.action)
  ) {
    throw new Error(
      `operation ${operation.action} is not admitted for plan kind ${plan.kind}`,
    );
  }
  exactKeys("operation", operation, schema);
  assertIdentifier("requestId", operation.requestId);
  if (
    operation.target !== plan.workerName &&
    operation.action !== "account.workersDev.enable"
  ) {
    throw new Error("operation target differs from the exact Worker");
  }
  if (operation.action === "account.workersDev.enable") {
    if (
      operation.target !== plan.accountId ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(operation.subdomain ?? "")
    ) {
      throw new Error(
        "account workers.dev operation differs from the exact account/subdomain authority",
      );
    }
  }
  if (operation.action.includes("secret.")) {
    if (
      !admission.deployment.secretNames.includes(operation.secretName) ||
      !identifierPattern.test(operation.slotId ?? "") ||
      !identifierPattern.test(operation.slotVersion ?? "")
    ) {
      throw new Error(
        "secret operation is not bound to an admitted opaque slot/version",
      );
    }
  }
}

function validateOperationBindings(operation, plan, admission) {
  for (const [name, value] of Object.entries(operation)) {
    if (name.endsWith("Sha256")) {
      assertDigest(name, value);
    } else if (name.endsWith("Id") && name !== "requestId") {
      assertIdentifier(name, value);
    }
  }
  if (
    operation.cron !== undefined &&
    operation.cron !== admission.deployment.cron
  ) {
    throw new Error("scheduled trigger differs from canonical admission");
  }
  if (
    operation.profileSha256 !== undefined &&
    operation.profileSha256 !== plan.profileSha256
  ) {
    throw new Error("operation profile differs from the signed plan profile");
  }
  if (
    operation.action === "worker.rollback" &&
    operation.compatibleMigrationTag !== plan.currentMigrationTag
  ) {
    throw new Error(
      "rollback migration compatibility differs from current state",
    );
  }
  if (
    operation.action === "worker.terminalArtifact.deploy" &&
    (operation.entryPointSha256 !==
      admission.deployment.terminalProfile.entryPointSha256 ||
      operation.providerZeroSha256 !== plan.providerZeroSha256 ||
      operation.retirementTombstoneSha256 !== plan.retirementTombstoneSha256)
  ) {
    throw new Error(
      "terminal artifact operation differs from retirement authority",
    );
  }
}

function validateOperation(operation, plan, admission, manifest) {
  validateOperationAdmission(operation, plan, admission, manifest);
  validateOperationBindings(operation, plan, admission);
}

function validateKindSequence(plan, admission) {
  const actions = plan.operations.map(({ action }) => action);
  if (plan.kind === "deploy") {
    const initial = plan.currentWorkerVersionId === "absent";
    const required = initial
      ? [
          "worker.deploy",
          ...admission.deployment.secretNames.map(() => "worker.secret.put"),
        ]
      : ["worker.deploy"];
    if (JSON.stringify(actions) !== JSON.stringify(required)) {
      throw new Error(
        "deploy plan does not match the authoritative launcher sequence",
      );
    }
    if (
      plan.operations[0].expectedPreviousVersionId !==
      plan.currentWorkerVersionId
    ) {
      throw new Error("deploy does not bind the exact previous version");
    }
    if (
      (initial && plan.rollbackActions.length !== 0) ||
      (!initial &&
        (plan.rollbackActions.length !== 1 ||
          plan.rollbackActions[0].action !== "worker.rollback" ||
          plan.rollbackActions[0].versionId !== plan.currentWorkerVersionId))
    ) {
      throw new Error("deploy rollback does not match the authoritative state");
    }
    if (
      initial &&
      JSON.stringify(
        plan.operations.slice(1).map(({ secretName }) => secretName),
      ) !== JSON.stringify(admission.deployment.secretNames)
    ) {
      throw new Error("deploy does not bind the exact secret order");
    }
  }
  if (plan.kind === "rotate-secrets") {
    const required = admission.deployment.secretNames.map(
      () => "worker.secret.put",
    );
    if (
      plan.currentWorkerVersionId === "absent" ||
      JSON.stringify(actions) !== JSON.stringify(required) ||
      plan.rollbackActions.length !== 0 ||
      JSON.stringify(plan.operations.map(({ secretName }) => secretName)) !==
        JSON.stringify(admission.deployment.secretNames)
    ) {
      throw new Error(
        "secret rotation does not match the authoritative launcher sequence",
      );
    }
  }
  if (
    plan.kind === "rollback" &&
    JSON.stringify(actions) !== JSON.stringify(["worker.rollback"])
  ) {
    throw new Error(
      "rollback plan must contain exactly one rollback operation",
    );
  }
  if (
    plan.kind === "account-workers-dev-enable" &&
    JSON.stringify(actions) !== JSON.stringify(["account.workersDev.enable"])
  ) {
    throw new Error(
      "account workers.dev plan must contain only its exact activation",
    );
  }
  if (plan.kind === "retire") {
    const secretDeletes = admission.deployment.secretNames.map(
      () => "worker.secret.delete",
    );
    const requiredPrefix = [
      "worker.schedule.delete",
      "worker.scriptWorkersDev.disable",
      ...secretDeletes,
      "worker.terminalArtifact.deploy",
    ];
    if (
      JSON.stringify(actions.slice(0, requiredPrefix.length)) !==
        JSON.stringify(requiredPrefix) ||
      actions.at(-1) !== "worker.delete" ||
      actions
        .slice(requiredPrefix.length, -1)
        .some((action) => action !== "worker.version.delete") ||
      plan.rollbackActions.length !== 0
    ) {
      throw new Error(
        "retirement operations do not follow the irreversible admitted order",
      );
    }
    const secretNames = plan.operations
      .slice(2, 2 + secretDeletes.length)
      .map(({ secretName }) => secretName);
    if (
      JSON.stringify(secretNames) !==
      JSON.stringify(admission.deployment.secretNames)
    ) {
      throw new Error(
        "retirement does not delete the exact coordinator secret sequence",
      );
    }
  }
}

function validatePlanIdentity(plan, context) {
  const {
    admission,
    admissionBytes,
    manifestBytes,
    profile,
    profileBytes,
    observation,
  } = context;
  if (
    plan.schemaVersion !== 1 ||
    !allowedActions(plan.kind) ||
    !environmentPattern.test(plan.environmentId ?? "") ||
    plan.workerName !== admission.deployment.workerName ||
    (plan.kind !== "retire" &&
      plan.environmentId !== profile.vars?.AGENTSCOPE_CRABBOX_ENVIRONMENT_ID) ||
    plan.sourceCommit !== admission.coordinator.commit ||
    plan.observationId !== observation.observationId ||
    plan.currentMigrationTag !== admission.deployment.migrationTag
  ) {
    throw new Error(
      "plan identity differs from canonical deployment authority",
    );
  }
  for (const name of [
    "accountId",
    "currentWorkerVersionId",
    "durableObjectNamespaceId",
    "hetznerProjectId",
    "nonce",
  ]) {
    assertIdentifier(name, plan[name]);
  }
  for (const [name, value] of [
    ["admissionSha256", plan.admissionSha256],
    ["permissionManifestSha256", plan.permissionManifestSha256],
    ["profileSha256", plan.profileSha256],
    ["observablePrestateSha256", plan.observablePrestateSha256],
    ["intendedTerminalStateSha256", plan.intendedTerminalStateSha256],
  ]) {
    assertDigest(name, value);
  }
  if (
    plan.compatibleVersionDetailSha256 !== "none" &&
    !digestPattern.test(plan.compatibleVersionDetailSha256 ?? "")
  ) {
    throw new Error("compatible version detail identity is invalid");
  }
  const requiresCompatibleVersion =
    plan.kind === "rollback" ||
    (plan.kind === "deploy" && plan.currentWorkerVersionId !== "absent");
  if (
    (requiresCompatibleVersion &&
      !digestPattern.test(plan.compatibleVersionDetailSha256 ?? "")) ||
    (!requiresCompatibleVersion &&
      plan.compatibleVersionDetailSha256 !== "none")
  ) {
    throw new Error("compatible version detail does not match plan kind");
  }
  if (
    plan.admissionSha256 !== sha256(admissionBytes) ||
    plan.permissionManifestSha256 !== sha256(manifestBytes) ||
    plan.profileSha256 !== sha256(profileBytes)
  ) {
    throw new Error(
      "plan differs from canonical policy or supplied profile identity",
    );
  }
  if (
    plan.intendedTerminalStateSha256 !== terminalContractSha256(plan, admission)
  ) {
    throw new Error(
      "intended terminal state differs from the canonical contract",
    );
  }
  validateToolchain(plan.toolchainIdentity, admission);
}

function validateRetirementAuthority(plan) {
  const retirementFields = [
    "providerZeroSha256",
    "retirementTombstoneSha256",
    "acquisitionFreezeId",
    "launcherCredentialRevocationId",
  ];
  if (plan.kind === "retire") {
    assertDigest("providerZeroSha256", plan.providerZeroSha256);
    assertDigest("retirementTombstoneSha256", plan.retirementTombstoneSha256);
    assertIdentifier("acquisitionFreezeId", plan.acquisitionFreezeId);
    assertIdentifier(
      "launcherCredentialRevocationId",
      plan.launcherCredentialRevocationId,
    );
  } else if (retirementFields.some((name) => plan[name] !== null)) {
    throw new Error("retirement authority appears outside a retirement plan");
  }
}

function validatePlanOperations(plan, context) {
  const { admission, manifest, now } = context;
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
  for (const operation of plan.operations) {
    validateOperation(operation, plan, admission, manifest);
  }
  for (const operation of plan.rollbackActions) {
    validateOperation(
      operation,
      { ...plan, kind: "rollback" },
      admission,
      manifest,
    );
  }
  validateKindSequence(plan, admission);
}

function validatePlan(plan, context) {
  exactKeys("plan", plan, [
    "schemaVersion",
    "kind",
    "accountId",
    "environmentId",
    "workerName",
    "sourceCommit",
    "toolchainIdentity",
    "admissionSha256",
    "permissionManifestSha256",
    "profileSha256",
    "observablePrestateSha256",
    "observationId",
    "currentWorkerVersionId",
    "durableObjectNamespaceId",
    "currentMigrationTag",
    "compatibleVersionDetailSha256",
    "hetznerProjectId",
    "providerZeroSha256",
    "retirementTombstoneSha256",
    "acquisitionFreezeId",
    "launcherCredentialRevocationId",
    "operations",
    "rollbackActions",
    "issuedAt",
    "expiresAt",
    "nonce",
    "intendedTerminalStateSha256",
  ]);
  validatePlanIdentity(plan, context);
  validateRetirementAuthority(plan);
  validatePlanOperations(plan, context);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const paths = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, resolve(value)]),
  );
  const [
    planBytes,
    planSignature,
    candidateOwnerKey,
    observationBytes,
    observationSignature,
    candidateObservationKey,
    profileBytes,
  ] = await Promise.all([
    readFile(paths.plan),
    readFile(paths["plan-signature"], "utf8"),
    readFile(paths["candidate-owner-key"]),
    readFile(paths.observation),
    readFile(paths["observation-signature"], "utf8"),
    readFile(paths["candidate-observation-key"]),
    readFile(paths.profile),
  ]);
  verifyCandidateSignature(
    "owner plan",
    planBytes,
    planSignature,
    candidateOwnerKey,
  );
  verifyCandidateSignature(
    "plan observation",
    observationBytes,
    observationSignature,
    candidateObservationKey,
  );
  const { admission, admissionBytes, manifest, manifestBytes } =
    await readCanonicalPolicy();
  const plan = JSON.parse(planBytes);
  const observation = JSON.parse(observationBytes);
  const profile = JSON.parse(profileBytes);
  if (plan.kind === "retire") {
    validateTerminalProfile(profile, admission);
  } else {
    validateLiveProfile(profile, admission, plan.environmentId);
  }
  const now = Date.now();
  validateObservation(observation, plan, admission, now);
  validatePlan(plan, {
    admission,
    admissionBytes,
    manifest,
    manifestBytes,
    profile,
    profileBytes,
    observation,
    now,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 2,
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
        canonicalPolicyValidated: true,
        candidateSignaturesValid: true,
        authorityAdmitted: false,
        continuouslyEnforced: false,
        consumed: false,
        mutationAuthorized: false,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
