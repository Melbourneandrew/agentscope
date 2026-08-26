import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "agentscope-crabbox-plan-"));
  const admission = JSON.parse(await readFile(admissionPath, "utf8"));
  const manifestBytes = await readFile(manifestPath);
  const environmentId = "asgcf_0123456789abcdef0123456789abcdef";
  const profile = {
    name: admission.deployment.workerName,
    vars: { AGENTSCOPE_CRABBOX_ENVIRONMENT_ID: environmentId },
  };
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
  const observation = {
    schemaVersion: 1,
    accountId: "cloudflare-account-example",
    credentialRole: "billing-product-read-only",
    workersPlan: "free-no-overage",
    paidOrOverageEnabled: false,
    observedAt: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    observationId: "plan-observation-1",
  };
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
  const plan = {
    schemaVersion: 1,
    kind: "deploy",
    accountId: observation.accountId,
    environmentId,
    workerName: admission.deployment.workerName,
    sourceCommit: admission.coordinator.commit,
    toolchainIdentity: "node-24.19.0-wrangler-4.114.0",
    profileSha256: sha256(profileBytes),
    permissionManifestSha256: sha256(manifestBytes),
    observablePrestateSha256: "1".repeat(64),
    observationId: observation.observationId,
    operations: [
      {
        action: "worker.secret.put",
        target: admission.deployment.workerName,
        secretName: "CRABBOX_SHARED_TOKEN",
        slotId: "crabbox-shared",
        slotVersion: "v1",
      },
      { action: "worker.deploy", target: admission.deployment.workerName },
    ],
    rollbackActions: [
      { action: "worker.rollback", target: admission.deployment.workerName },
    ],
    issuedAt: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    nonce: "owner-approved-plan-1",
    intendedTerminalStateSha256: "2".repeat(64),
  };
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
    "--owner-key",
    ownerKeyPath,
    "--observation",
    observationPath,
    "--observation-signature",
    observationSignaturePath,
    "--observation-key",
    observationKeyPath,
    "--profile",
    profilePath,
    "--admission",
    admissionPath,
    "--permission-manifest",
    manifestPath,
  ];
  return { args, observation, plan, writeObservation, writePlan };
}

function run(args) {
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

test("verifies a signed closed deployment plan without consuming it", async () => {
  const item = await fixture();
  const result = run(item.args);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.kind, "deploy");
  assert.equal(evidence.secretValuesPresent, false);
  assert.equal(evidence.consumed, false);
});

test("rejects a plan that was not signed by the admitted owner", async () => {
  const item = await fixture();
  await item.writePlan(item.plan, generateKeyPairSync("ed25519").privateKey);
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owner plan signature is invalid/);
});

test("rejects stale Free-plan evidence even when correctly signed", async () => {
  const item = await fixture();
  const stale = {
    ...item.observation,
    observedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await item.writeObservation(stale);
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale, future-dated, or exceeds/);
});

test("rejects a forbidden action under a valid owner signature", async () => {
  const item = await fixture();
  await item.writePlan({
    ...item.plan,
    operations: [{ action: "zone.route.create", target: item.plan.workerName }],
  });
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not admitted/);
});

test("rejects a secret value or digest embedded in an operation", async () => {
  const item = await fixture();
  await item.writePlan({
    ...item.plan,
    operations: [{ ...item.plan.operations[0], valueDigest: "3".repeat(64) }],
  });
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret operation fields differ/);
});

test("requires account workers.dev activation to be a separate plan", async () => {
  const item = await fixture();
  await item.writePlan({
    ...item.plan,
    operations: [
      { action: "account.workersDev.enable", target: item.plan.accountId },
    ],
  });
  const result = run(item.args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires its separate plan kind/);
});
