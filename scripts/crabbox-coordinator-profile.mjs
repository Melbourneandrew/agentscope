#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  parseJsonc,
  readCanonicalPolicy,
  sha256,
  validateLiveProfile,
  writeOwnedAtomic,
} from "./lib/crabbox-coordinator-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyRoot = resolve(repositoryRoot, "ops/crabbox-coordinator");
const templatePath = resolve(policyRoot, "deployment-profile.template.jsonc");
const placeholder = "__AGENTSCOPE_ENVIRONMENT_ID__";

function fail(message) {
  process.stderr.write(`crabbox coordinator profile: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: crabbox-coordinator-profile.mjs --source <crabbox> --record <record.json> --output <profile.jsonc>",
      );
    }
    parsed[key.slice(2)] = value;
  }
  if (!parsed.source || !parsed.record || !parsed.output) {
    throw new Error("--source, --record, and --output are required");
  }
  return parsed;
}

function git(source, args) {
  const result = spawnSync("/usr/bin/git", ["-C", source, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      SYSTEM_VERSION_COMPAT: "0",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const source = resolve(args.source);
  const recordPath = resolve(args.record);
  const outputPath = resolve(args.output);
  const workerRoot = resolve(source, "worker");
  if (
    dirname(outputPath) !== workerRoot ||
    basename(outputPath) !== "wrangler.agentscope.jsonc"
  ) {
    throw new Error(
      "output must be <exact-crabbox-source>/worker/wrangler.agentscope.jsonc",
    );
  }

  const { admission, admissionBytes, manifestBytes } =
    await readCanonicalPolicy();
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  const environmentPattern = new RegExp(
    admission.deployment.environmentIdPattern,
  );
  if (!environmentPattern.test(record.environmentId ?? "")) {
    throw new Error("external record has no admitted immutable environmentId");
  }
  if (
    record.workerName !== admission.deployment.workerName ||
    record.cloudflarePlan !== "free" ||
    record.accountMode !== admission.deployment.accountMode
  ) {
    throw new Error(
      "external record does not bind the admitted Worker, shared account, and free plan",
    );
  }

  const sourceHead = git(source, ["rev-parse", "HEAD"]);
  const sourceStatus = git(source, ["status", "--porcelain=v1"])
    .split("\n")
    .filter(Boolean)
    .filter((line) => line !== "?? worker/wrangler.agentscope.jsonc");
  if (
    sourceHead !== admission.coordinator.commit ||
    sourceStatus.length !== 0
  ) {
    throw new Error("Crabbox source is not the clean admitted commit");
  }
  const license = await readFile(resolve(source, "LICENSE"));
  const lock = await readFile(resolve(workerRoot, "package-lock.json"));
  if (
    sha256(license) !== admission.coordinator.licenseSha256 ||
    sha256(lock) !== admission.coordinator.workerLockSha256
  ) {
    throw new Error(
      "Crabbox license or Worker lock digest differs from admission",
    );
  }

  const template = await readFile(templatePath, "utf8");
  if (template.split(placeholder).length !== 2) {
    throw new Error(
      "deployment template must contain exactly one environment placeholder",
    );
  }
  const rendered = template.replace(placeholder, record.environmentId);
  const profile = parseJsonc(rendered);
  validateLiveProfile(profile, admission, record.environmentId);
  await writeOwnedAtomic(
    outputPath,
    workerRoot,
    `${JSON.stringify(profile, null, 2)}\n`,
  );

  const evidence = {
    schemaVersion: 1,
    canonicalAdmissionSha256: sha256(admissionBytes),
    canonicalPermissionManifestSha256: sha256(manifestBytes),
    sourceCommit: sourceHead,
    workerLockSha256: sha256(lock),
    profileSha256: sha256(Buffer.from(`${JSON.stringify(profile, null, 2)}\n`)),
    workerName: profile.name,
    environmentId: record.environmentId,
    cloudflarePlan: record.cloudflarePlan,
    accountMode: record.accountMode,
    secretNames: admission.deployment.secretNames,
    secretPolicy: admission.deployment.secretPolicy,
    publicBindingPolicy: admission.deployment.publicBindingPolicy,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
