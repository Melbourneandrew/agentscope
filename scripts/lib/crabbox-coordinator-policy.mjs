import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const policyRoot = resolve(repositoryRoot, "ops/crabbox-coordinator");
export const canonicalAdmissionPath = resolve(policyRoot, "admission.json");
export const canonicalPermissionManifestPath = resolve(
  policyRoot,
  "permission-manifest.json",
);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseJsonc(value) {
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

export function assertExactSet(label, actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `${label} differs: ${JSON.stringify(left)} != ${JSON.stringify(right)}`,
    );
  }
}

export function validateLiveProfile(profile, admission, environmentId) {
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

export async function assertOwnedPhysicalParent(outputPath, expectedParent) {
  const physicalExpected = await realpath(expectedParent);
  const physicalParent = await realpath(dirname(outputPath));
  if (physicalParent !== physicalExpected) {
    throw new Error(
      "output parent differs from the physical owned Worker directory",
    );
  }
  try {
    const current = await lstat(outputPath);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error(
        "output target must be absent or a regular file, never a symlink",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function writeOwnedAtomic(outputPath, expectedParent, value) {
  await assertOwnedPhysicalParent(outputPath, expectedParent);
  const temporary = resolve(expectedParent, `.agentscope-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertOwnedPhysicalParent(outputPath, expectedParent);
    await rename(temporary, outputPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readCanonicalPolicy() {
  const [admissionBytes, manifestBytes] = await Promise.all([
    readFile(canonicalAdmissionPath),
    readFile(canonicalPermissionManifestPath),
  ]);
  return {
    admissionBytes,
    manifestBytes,
    admission: JSON.parse(admissionBytes),
    manifest: JSON.parse(manifestBytes),
  };
}

function git(source, args) {
  const result = spawnSync("/usr/bin/git", ["-C", source, ...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", SYSTEM_VERSION_COMPAT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function verifyPinnedSource(
  source,
  admission,
  allowedUntracked = [],
) {
  const head = git(source, ["rev-parse", "HEAD"]);
  const status = git(source, ["status", "--porcelain=v1"])
    .split("\n")
    .filter(Boolean)
    .filter((line) => !allowedUntracked.includes(line));
  const [license, lock] = await Promise.all([
    readFile(resolve(source, "LICENSE")),
    readFile(resolve(source, "worker/package-lock.json")),
  ]);
  if (
    head !== admission.coordinator.commit ||
    status.length !== 0 ||
    sha256(license) !== admission.coordinator.licenseSha256 ||
    sha256(lock) !== admission.coordinator.workerLockSha256
  ) {
    throw new Error(
      "Crabbox source, license, lock, or worktree differs from admission",
    );
  }
  return { head, lockSha256: sha256(lock) };
}
