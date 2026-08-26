#!/usr/bin/env node

import { createHash, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyRoot = resolve(repositoryRoot, "ops/crabbox-coordinator");

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
    "recovery-key",
    "output",
  ]) {
    if (!parsed[key]) {
      throw new Error(`--${key} is required`);
    }
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonc(value) {
  return JSON.parse(value.replace(/,(\s*[}\]])/gu, "$1"));
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const source = resolve(args.source);
  const workerRoot = resolve(source, "worker");
  const output = resolve(args.output);
  const admission = JSON.parse(
    await readFile(resolve(policyRoot, "admission.json"), "utf8"),
  );
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
  const recoveryKey = await readFile(resolve(args["recovery-key"]));
  if (!verify(null, providerZeroBytes, recoveryKey, signature)) {
    throw new Error("provider-zero observation signature is invalid");
  }
  const age = Date.now() - Date.parse(providerZero.observedAt);
  if (
    providerZero.schemaVersion !== 1 ||
    providerZero.environmentId !== record.environmentId ||
    providerZero.provider !== "hetzner" ||
    providerZero.observerRole !== "human-recovery-inventory" ||
    providerZero.servers !== 0 ||
    providerZero.sshKeys !== 0 ||
    providerZero.coordinatorActiveLeases !== 0 ||
    providerZero.coordinatorPendingCreates !== 0 ||
    providerZero.ledgerContinuous !== true ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > admission.deployment.planObservationMaxAgeMinutes * 60_000
  ) {
    throw new Error("provider-zero observation is stale or not terminal");
  }
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
  const expectedKeys = [
    "$schema",
    "compatibility_date",
    "compatibility_flags",
    "main",
    "migrations",
    "name",
    "preview_urls",
    "workers_dev",
  ].sort();
  if (
    JSON.stringify(Object.keys(profile).sort()) !==
      JSON.stringify(expectedKeys) ||
    profile.name !== admission.deployment.workerName ||
    profile.main !== terminal.entryPointName ||
    profile.workers_dev !== false ||
    profile.preview_urls !== false ||
    profile.migrations.at(-1)?.tag !== terminal.migrationTag ||
    JSON.stringify(profile.migrations.at(-1)?.deleted_classes) !==
      JSON.stringify([terminal.deletedClass])
  ) {
    throw new Error(
      "terminal profile differs from the admitted no-authority shape",
    );
  }
  const rendered = `${JSON.stringify(profile, null, 2)}\n`;
  await writeFile(resolve(workerRoot, terminal.entryPointName), entryPoint, {
    mode: 0o600,
  });
  await writeFile(output, rendered, { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        environmentId: record.environmentId,
        providerZeroSha256: sha256(providerZeroBytes),
        terminalProfileSha256: sha256(rendered),
        terminalEntryPointSha256: sha256(entryPoint),
        deletedClass: terminal.deletedClass,
        workersDev: false,
        runtimeAuthority: false,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
