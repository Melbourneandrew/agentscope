import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parseJsonc } from "../lib/crabbox-coordinator-policy.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const script = resolve(repositoryRoot, "scripts/crabbox-coordinator-plan.mjs");
const admissionPath = resolve(
  repositoryRoot,
  "ops/crabbox-coordinator/admission.json",
);
const manifestPath = resolve(
  repositoryRoot,
  "ops/crabbox-coordinator/permission-manifest.json",
);
const templatePath = resolve(
  repositoryRoot,
  "ops/crabbox-coordinator/deployment-profile.template.jsonc",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildObservation(now) {
  const quota = () => ({
    limit: 100_000,
    used: 0,
    sourceIdentity: "cloudflare-product-inventory-1",
  });
  return {
    schemaVersion: 1,
    accountId: "cloudflare-account-example",
    credentialRole: "candidate-billing-product-read-only",
    workersPlan: "free-no-overage",
    paidOrOverageEnabled: false,
    allAccountConsumersIncluded: true,
    quotas: {
      workersRequestsDaily: quota(),
      workersCpuMsDaily: quota(),
      durableObjectRequestsDaily: quota(),
      durableObjectStorageGb: quota(),
      pagesFunctionsRequestsDaily: quota(),
    },
    observedAt: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    observationId: "plan-observation-1",
  };
}

function buildPlan({
  admission,
  admissionBytes,
  manifestBytes,
  profileBytes,
  environmentId,
  observation,
  now,
}) {
  return {
    schemaVersion: 1,
    kind: "deploy",
    accountId: observation.accountId,
    environmentId,
    workerName: admission.deployment.workerName,
    sourceCommit: admission.coordinator.commit,
    toolchainIdentity: {
      nodeVersion: admission.toolchains.node.version,
      nodeArchiveSha256: admission.toolchains.node.archiveSha256,
      wranglerVersion: admission.coordinator.wranglerVersion,
      workerLockSha256: admission.coordinator.workerLockSha256,
      goVersion: admission.toolchains.go.version,
      goArchiveSha256: admission.toolchains.go.archiveSha256,
      crabboxClientSha256: "9".repeat(64),
    },
    admissionSha256: sha256(admissionBytes),
    permissionManifestSha256: sha256(manifestBytes),
    profileSha256: sha256(profileBytes),
    observablePrestateSha256: "1".repeat(64),
    observationId: observation.observationId,
    currentWorkerVersionId: "no-existing-version",
    durableObjectNamespaceId: "planned-durable-object-namespace",
    currentMigrationTag: admission.deployment.migrationTag,
    hetznerProjectId: "fleet-only-project",
    providerZeroSha256: null,
    retirementTombstoneSha256: null,
    acquisitionFreezeId: null,
    launcherCredentialRevocationId: null,
    operations: [
      {
        action: "worker.secret.put",
        target: admission.deployment.workerName,
        requestId: "put-shared-secret",
        secretName: "CRABBOX_SHARED_TOKEN",
        slotId: "crabbox-shared",
        slotVersion: "v1",
      },
      {
        action: "worker.deploy",
        target: admission.deployment.workerName,
        requestId: "deploy-worker",
        profileSha256: sha256(profileBytes),
        expectedPreviousVersionId: "no-existing-version",
      },
    ],
    rollbackActions: [
      {
        action: "worker.rollback",
        target: admission.deployment.workerName,
        requestId: "rollback-worker",
        versionId: "no-existing-version",
        compatibleMigrationTag: admission.deployment.migrationTag,
      },
    ],
    issuedAt: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    nonce: "owner-approved-plan-1",
    intendedTerminalStateSha256: "2".repeat(64),
  };
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "agentscope-crabbox-plan-"));
  const admissionBytes = await readFile(admissionPath);
  const admission = JSON.parse(admissionBytes);
  const manifestBytes = await readFile(manifestPath);
  const environmentId = "asgcf_0123456789abcdef0123456789abcdef";
  const profile = parseJsonc(
    (await readFile(templatePath, "utf8")).replace(
      "__AGENTSCOPE_ENVIRONMENT_ID__",
      environmentId,
    ),
  );
  const profileBytes = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`);
  const profilePath = resolve(root, "profile.json");
  await writeFile(profilePath, profileBytes);
  const owner = generateKeyPairSync("ed25519");
  const observer = generateKeyPairSync("ed25519");
  const ownerKeyPath = resolve(root, "owner.pem");
  const observationKeyPath = resolve(root, "observation.pem");
  await writeFile(
    ownerKeyPath,
    owner.publicKey.export({ type: "spki", format: "pem" }),
  );
  await writeFile(
    observationKeyPath,
    observer.publicKey.export({ type: "spki", format: "pem" }),
  );
  const now = Date.now();
  const observation = buildObservation(now);
  const observationPath = resolve(root, "observation.json");
  const observationSignaturePath = resolve(root, "observation.sig");
  const planPath = resolve(root, "plan.json");
  const planSignaturePath = resolve(root, "plan.sig");
  async function writeObservation(value = observation) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await writeFile(observationPath, bytes);
    await writeFile(
      observationSignaturePath,
      `${sign(null, bytes, observer.privateKey).toString("base64")}\n`,
    );
  }
  const plan = buildPlan({
    admission,
    admissionBytes,
    manifestBytes,
    profileBytes,
    environmentId,
    observation,
    now,
  });
  async function writePlan(value = plan, signer = owner.privateKey) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await writeFile(planPath, bytes);
    await writeFile(
      planSignaturePath,
      `${sign(null, bytes, signer).toString("base64")}\n`,
    );
  }
  await writeObservation();
  await writePlan();
  const args = [
    script,
    "--plan",
    planPath,
    "--plan-signature",
    planSignaturePath,
    "--candidate-owner-key",
    ownerKeyPath,
    "--observation",
    observationPath,
    "--observation-signature",
    observationSignaturePath,
    "--candidate-observation-key",
    observationKeyPath,
    "--profile",
    profilePath,
  ];
  return { args, observation, plan, writeObservation, writePlan };
}

function run(args) {
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

test("validates canonical structure but never grants mutation authority", async () => {
  const item = await fixture();
  const result = run(item.args);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.canonicalPolicyValidated, true);
  assert.equal(evidence.candidateSignaturesValid, true);
  assert.equal(evidence.authorityAdmitted, false);
  assert.equal(evidence.continuouslyEnforced, false);
  assert.equal(evidence.consumed, false);
  assert.equal(evidence.mutationAuthorized, false);
});

test("rejects an altered canonical admission identity", async () => {
  const item = await fixture();
  await item.writePlan({ ...item.plan, admissionSha256: "3".repeat(64) });
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /canonical policy/);
});

test("rejects an incomplete deployment profile", async () => {
  const item = await fixture();
  const profileIndex = item.args.indexOf("--profile") + 1;
  await writeFile(
    item.args[profileIndex],
    `${JSON.stringify({ name: item.plan.workerName, vars: {} })}\n`,
  );
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /live Worker profile differs from canonical admission/,
  );
});

test("rejects stale signed quota evidence", async () => {
  const item = await fixture();
  await item.writeObservation({
    ...item.observation,
    observedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale, future-dated, or exceeds/);
});

test("rejects a secret value or digest embedded in an operation", async () => {
  const item = await fixture();
  await item.writePlan({
    ...item.plan,
    operations: [
      { ...item.plan.operations[0], valueDigest: "3".repeat(64) },
      item.plan.operations[1],
    ],
  });
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /operation fields differ/);
});

test("rejects cross-kind operations", async () => {
  const item = await fixture();
  await item.writePlan({
    ...item.plan,
    kind: "account-workers-dev-enable",
    operations: [
      {
        action: "account.workersDev.enable",
        target: item.plan.accountId,
        requestId: "enable-account-workers-dev",
        accountId: item.plan.accountId,
      },
      item.plan.operations[1],
    ],
    rollbackActions: [],
  });
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not admitted for plan kind/);
});

test("rejects deletion-first retirement even with bound resource identities", async () => {
  const item = await fixture();
  const terminalProfile = parseJsonc(
    await readFile(
      resolve(
        repositoryRoot,
        "ops/crabbox-coordinator/terminal-profile.template.jsonc",
      ),
      "utf8",
    ),
  );
  const terminalBytes = Buffer.from(
    `${JSON.stringify(terminalProfile, null, 2)}\n`,
  );
  const profilePath = item.args[item.args.indexOf("--profile") + 1];
  await writeFile(profilePath, terminalBytes);
  await item.writePlan({
    ...item.plan,
    kind: "retire",
    profileSha256: sha256(terminalBytes),
    providerZeroSha256: "4".repeat(64),
    retirementTombstoneSha256: "5".repeat(64),
    acquisitionFreezeId: "freeze-1",
    launcherCredentialRevocationId: "launcher-revocation-1",
    operations: [
      {
        action: "worker.durableObjectClass.delete",
        target: item.plan.workerName,
        requestId: "delete-class-first",
        namespaceId: item.plan.durableObjectNamespaceId,
        className: "FleetDurableObject",
        migrationTag: "v2-retire-fleet-durable-object",
        providerZeroSha256: "4".repeat(64),
        retirementTombstoneSha256: "5".repeat(64),
      },
    ],
    rollbackActions: [],
  });
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /irreversible admitted order/);
});
