#!/usr/bin/env node

import { verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertExactJson,
  assertExactSet,
  expectedTerminalProfile,
  parseJsonc,
  policyRoot,
  readCanonicalPolicy,
  sha256,
  verifyPinnedSource,
  writeOwnedAtomic,
} from "./lib/crabbox-coordinator-policy.mjs";

function fail(message) {
  process.stderr.write(`crabbox coordinator retirement: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "retirement renderer arguments must be --name value pairs",
      );
    }
    parsed[key.slice(2)] = value;
  }
  for (const key of [
    "source",
    "record",
    "provider-zero",
    "provider-zero-signature",
    "candidate-key",
    "output",
  ]) {
    if (!parsed[key]) {
      throw new Error(`--${key} is required`);
    }
  }
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const source = resolve(args.source);
  const workerRoot = resolve(source, "worker");
  const output = resolve(args.output);
  const { admission, admissionBytes, manifestBytes } =
    await readCanonicalPolicy();
  const terminal = admission.deployment.terminalProfile;
  if (
    dirname(output) !== workerRoot ||
    basename(output) !== terminal.configName
  ) {
    throw new Error(
      `output must be <exact-crabbox-source>/worker/${terminal.configName}`,
    );
  }
  const record = JSON.parse(await readFile(resolve(args.record), "utf8"));
  const providerZeroBytes = await readFile(resolve(args["provider-zero"]));
  const providerZero = JSON.parse(providerZeroBytes);
  const signature = Buffer.from(
    (await readFile(resolve(args["provider-zero-signature"]), "utf8")).trim(),
    "base64",
  );
  const candidateKey = await readFile(resolve(args["candidate-key"]));
  if (!verify(null, providerZeroBytes, candidateKey, signature)) {
    throw new Error("provider-zero candidate signature is invalid");
  }
  validateProviderZero(providerZero, record, admission, Date.now());
  await verifyPinnedSource(source, admission, [
    `?? worker/${terminal.configName}`,
    `?? worker/${terminal.entryPointName}`,
    "?? worker/wrangler.agentscope.jsonc",
  ]);
  const entryPoint = await readFile(
    resolve(policyRoot, terminal.entryPointName),
  );
  if (sha256(entryPoint) !== terminal.entryPointSha256) {
    throw new Error("terminal entry point differs from admission");
  }
  const profile = parseJsonc(
    await readFile(
      resolve(policyRoot, "terminal-profile.template.jsonc"),
      "utf8",
    ),
  );
  validateTerminalProfile(profile, admission);
  const rendered = `${JSON.stringify(profile, null, 2)}\n`;
  await writeOwnedAtomic(
    resolve(workerRoot, terminal.entryPointName),
    workerRoot,
    entryPoint,
  );
  await writeOwnedAtomic(output, workerRoot, rendered);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        environmentId: record.environmentId,
        providerZeroSha256: sha256(providerZeroBytes),
        terminalProfileSha256: sha256(rendered),
        terminalEntryPointSha256: sha256(entryPoint),
        canonicalAdmissionSha256: sha256(admissionBytes),
        canonicalPermissionManifestSha256: sha256(manifestBytes),
        accountId: providerZero.accountId,
        workerVersionId: providerZero.workerVersionId,
        durableObjectNamespaceId: providerZero.durableObjectNamespaceId,
        hetznerProjectId: providerZero.hetznerProjectId,
        retirementTombstoneSha256: providerZero.retirementTombstoneSha256,
        terminalEvidenceSha256: providerZero.terminalEvidenceSha256,
        deletedClass: terminal.deletedClass,
        workersDev: false,
        runtimeAuthority: false,
        authorityAdmitted: false,
        mutationAuthorized: false,
      },
      null,
      2,
    )}\n`,
  );
}

export function validateProviderZero(providerZero, record, admission, now) {
  assertExactSet("provider-zero fields", Object.keys(providerZero ?? {}), [
    "schemaVersion",
    "environmentId",
    "accountId",
    "workerName",
    "workerVersionId",
    "durableObjectNamespaceId",
    "currentMigrationTag",
    "hetznerProjectId",
    "provider",
    "observerRole",
    "observedAt",
    "servers",
    "sshKeys",
    "coordinatorActiveLeases",
    "coordinatorPendingCreates",
    "ledgerContinuous",
    "acquisitionFrozen",
    "inFlightTransitionsResolved",
    "launcherCredentialRevoked",
    "retirementTombstoneSha256",
    "terminalEvidenceSha256",
  ]);
  const age = now - Date.parse(providerZero.observedAt);
  if (
    providerZero.schemaVersion !== 1 ||
    providerZero.environmentId !== record.environmentId ||
    providerZero.accountId !== record.accountId ||
    providerZero.workerName !== admission.deployment.workerName ||
    providerZero.workerVersionId !== record.workerVersionId ||
    providerZero.durableObjectNamespaceId !== record.durableObjectNamespaceId ||
    providerZero.currentMigrationTag !== admission.deployment.migrationTag ||
    providerZero.hetznerProjectId !== record.hetznerProjectId ||
    providerZero.provider !== "hetzner" ||
    providerZero.observerRole !== "candidate-human-recovery-inventory" ||
    providerZero.servers !== 0 ||
    providerZero.sshKeys !== 0 ||
    providerZero.coordinatorActiveLeases !== 0 ||
    providerZero.coordinatorPendingCreates !== 0 ||
    providerZero.ledgerContinuous !== true ||
    providerZero.acquisitionFrozen !== true ||
    providerZero.inFlightTransitionsResolved !== true ||
    providerZero.launcherCredentialRevoked !== true ||
    !/^[a-f0-9]{64}$/u.test(providerZero.retirementTombstoneSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(providerZero.terminalEvidenceSha256 ?? "") ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > admission.deployment.planObservationMaxAgeMinutes * 60_000
  ) {
    throw new Error("provider-zero observation is stale or not terminal");
  }
}

export function validateTerminalProfile(profile, admission) {
  assertExactJson(
    "terminal Worker profile",
    profile,
    expectedTerminalProfile(admission),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
}
