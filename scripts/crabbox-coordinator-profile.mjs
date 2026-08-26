#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyRoot = resolve(repositoryRoot, "ops/crabbox-coordinator");
const admissionPath = resolve(policyRoot, "admission.json");
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseTemplate(value) {
  let normalized = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      normalized += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      normalized += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (/\s/u.test(value[next] ?? "")) {
        next += 1;
      }
      if (value[next] === "}" || value[next] === "]") {
        continue;
      }
    }
    normalized += character;
  }
  return JSON.parse(normalized);
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

function assertExactSet(label, actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `${label} differs: ${JSON.stringify(left)} != ${JSON.stringify(right)}`,
    );
  }
}

function validateProfile(profile, admission, environmentId) {
  const expected = admission.deployment;
  assertExactSet(
    "top-level profile keys",
    Object.keys(profile),
    expected.topLevelKeys,
  );
  if (profile.name !== expected.workerName || profile.main !== "src/index.ts") {
    throw new Error("Worker identity or entry point differs from admission");
  }
  if (profile.compatibility_date !== expected.compatibilityDate) {
    throw new Error("compatibility date differs from admission");
  }
  if (
    profile.workers_dev !== true ||
    profile.preview_urls !== false ||
    "assets" in profile
  ) {
    throw new Error(
      "workers.dev, preview, or asset policy differs from admission",
    );
  }
  if (
    JSON.stringify(profile.compatibility_flags) !==
      JSON.stringify(expected.compatibilityFlags) ||
    profile.version_metadata?.binding !== expected.versionMetadataBinding
  ) {
    throw new Error(
      "compatibility flags or version metadata binding differs from admission",
    );
  }
  if (JSON.stringify(profile.alias) !== JSON.stringify(expected.aliases)) {
    throw new Error("Worker module aliases differ from admission");
  }
  assertExactSet(
    "variable allowlist",
    Object.keys(profile.vars ?? {}),
    expected.variableNames,
  );
  if (profile.vars.AGENTSCOPE_CRABBOX_ENVIRONMENT_ID !== environmentId) {
    throw new Error("environment identity was not bound exactly");
  }
  for (const [name, value] of Object.entries(expected.variableValues)) {
    if (profile.vars[name] !== value) {
      throw new Error(`variable ${name} differs from admission`);
    }
  }
  const bindings = profile.durable_objects?.bindings ?? [];
  if (
    bindings.length !== 1 ||
    bindings[0].name !== expected.durableObjectBinding ||
    bindings[0].class_name !== expected.durableObjectClass
  ) {
    throw new Error("Durable Object binding differs from admission");
  }
  const migrations = profile.migrations ?? [];
  if (
    migrations.length !== 1 ||
    migrations[0].tag !== expected.migrationTag ||
    JSON.stringify(migrations[0].new_sqlite_classes) !==
      JSON.stringify([expected.durableObjectClass])
  ) {
    throw new Error("Durable Object migration differs from admission");
  }
  if (
    JSON.stringify(profile.triggers?.crons) !== JSON.stringify([expected.cron])
  ) {
    throw new Error("cron trigger differs from admission");
  }
  const prohibitedFragments = [
    "AWS",
    "AZURE",
    "GCP",
    "DAYTONA",
    "TAILSCALE",
    "GITHUB",
  ];
  for (const key of Object.keys(profile.vars ?? {})) {
    if (prohibitedFragments.some((fragment) => key.includes(fragment))) {
      throw new Error(`prohibited provider or integration variable: ${key}`);
    }
  }
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

  const admission = JSON.parse(await readFile(admissionPath, "utf8"));
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
  const profile = parseTemplate(rendered);
  validateProfile(profile, admission, record.environmentId);
  await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, {
    mode: 0o600,
  });

  const evidence = {
    schemaVersion: 1,
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
