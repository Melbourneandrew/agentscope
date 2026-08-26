import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parseJsonc } from "../lib/crabbox-coordinator-policy.mjs";
import {
  validateProviderZero,
  validateTerminalProfile,
} from "../crabbox-coordinator-retirement-profile.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const script = resolve(
  repositoryRoot,
  "scripts/crabbox-coordinator-retirement-profile.mjs",
);
const admission = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "ops/crabbox-coordinator/admission.json"),
    "utf8",
  ),
);
const terminalProfile = parseJsonc(
  await readFile(
    resolve(
      repositoryRoot,
      "ops/crabbox-coordinator/terminal-profile.template.jsonc",
    ),
    "utf8",
  ),
);

function terminalFixture(overrides = {}) {
  const record = {
    environmentId: "asgcf_0123456789abcdef0123456789abcdef",
    accountId: "cloudflare-account-example",
    workerVersionId: "worker-version-1",
    durableObjectNamespaceId: "fleet-namespace-1",
    hetznerProjectId: "fleet-project-1",
  };
  const providerZero = {
    schemaVersion: 1,
    environmentId: record.environmentId,
    accountId: record.accountId,
    workerName: admission.deployment.workerName,
    workerVersionId: record.workerVersionId,
    durableObjectNamespaceId: record.durableObjectNamespaceId,
    currentMigrationTag: admission.deployment.migrationTag,
    hetznerProjectId: record.hetznerProjectId,
    provider: "hetzner",
    observerRole: "candidate-human-recovery-inventory",
    observedAt: new Date(Date.now() - 30_000).toISOString(),
    servers: 0,
    sshKeys: 0,
    coordinatorActiveLeases: 0,
    coordinatorPendingCreates: 0,
    ledgerContinuous: true,
    acquisitionFrozen: true,
    inFlightTransitionsResolved: true,
    launcherCredentialRevoked: true,
    retirementTombstoneSha256: "1".repeat(64),
    terminalEvidenceSha256: "2".repeat(64),
    ...overrides,
  };
  return { record, providerZero };
}

test("validates the exact terminal profile and fully bound provider-zero candidate", () => {
  const item = terminalFixture();
  validateProviderZero(item.providerZero, item.record, admission, Date.now());
  validateTerminalProfile(terminalProfile, admission);
});

test("refuses altered terminal compatibility or prior migration history", () => {
  const incompatible = structuredClone(terminalProfile);
  incompatible.compatibility_date = "2026-05-01";
  assert.throws(
    () => validateTerminalProfile(incompatible, admission),
    /differs from canonical admission/,
  );

  const alteredHistory = structuredClone(terminalProfile);
  alteredHistory.migrations[0].new_classes = ["OtherClass"];
  assert.throws(
    () => validateTerminalProfile(alteredHistory, admission),
    /differs from canonical admission/,
  );
});

test("refuses retirement while a provider server survives", () => {
  const item = terminalFixture({ servers: 1 });
  assert.throws(
    () =>
      validateProviderZero(
        item.providerZero,
        item.record,
        admission,
        Date.now(),
      ),
    /stale or not terminal/,
  );
});

test("refuses provider-zero evidence from another project", () => {
  const item = terminalFixture({ hetznerProjectId: "other-project" });
  assert.throws(
    () =>
      validateProviderZero(
        item.providerZero,
        item.record,
        admission,
        Date.now(),
      ),
    /stale or not terminal/,
  );
});

test("the CLI refuses an output outside the exact Worker source before staging", async () => {
  const root = await mkdtemp(
    resolve(tmpdir(), "agentscope-crabbox-retirement-"),
  );
  const source = resolve(root, "source");
  const worker = resolve(source, "worker");
  await mkdir(worker, { recursive: true });
  const item = terminalFixture();
  const recordPath = resolve(root, "record.json");
  const providerZeroPath = resolve(root, "provider-zero.json");
  const signaturePath = resolve(root, "provider-zero.sig");
  const keyPath = resolve(root, "candidate.pem");
  const keys = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(`${JSON.stringify(item.providerZero, null, 2)}\n`);
  await writeFile(recordPath, `${JSON.stringify(item.record)}\n`);
  await writeFile(providerZeroPath, bytes);
  await writeFile(
    signaturePath,
    `${sign(null, bytes, keys.privateKey).toString("base64")}\n`,
  );
  await writeFile(
    keyPath,
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--source",
      source,
      "--record",
      recordPath,
      "--provider-zero",
      providerZeroPath,
      "--provider-zero-signature",
      signaturePath,
      "--candidate-key",
      keyPath,
      "--output",
      resolve(root, "terminal.jsonc"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /output must be/);
});
