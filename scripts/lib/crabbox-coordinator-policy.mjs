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

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function assertExactJson(label, actual, expected) {
  if (
    JSON.stringify(canonicalize(actual)) !==
    JSON.stringify(canonicalize(expected))
  ) {
    throw new Error(`${label} differs from canonical admission`);
  }
}

export function expectedLiveProfile(admission, environmentId) {
  const expected = admission.deployment;
  return {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: expected.workerName,
    main: "src/index.ts",
    compatibility_date: expected.compatibilityDate,
    compatibility_flags: expected.compatibilityFlags,
    alias: expected.aliases,
    workers_dev: expected.workersDev,
    preview_urls: expected.previewUrls,
    version_metadata: { binding: expected.versionMetadataBinding },
    triggers: { crons: [expected.cron] },
    vars: {
      AGENTSCOPE_CRABBOX_ENVIRONMENT_ID: environmentId,
      ...expected.variableValues,
    },
    durable_objects: {
      bindings: [
        {
          name: expected.durableObjectBinding,
          class_name: expected.durableObjectClass,
        },
      ],
    },
    migrations: [
      {
        tag: expected.migrationTag,
        new_sqlite_classes: [expected.durableObjectClass],
      },
    ],
  };
}

export function expectedTerminalProfile(admission) {
  const expected = admission.deployment;
  const terminal = expected.terminalProfile;
  return {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: expected.workerName,
    main: terminal.entryPointName,
    compatibility_date: expected.compatibilityDate,
    compatibility_flags: expected.compatibilityFlags,
    workers_dev: terminal.workersDev,
    preview_urls: terminal.previewUrls,
    migrations: [
      {
        tag: expected.migrationTag,
        new_sqlite_classes: [expected.durableObjectClass],
      },
      {
        tag: terminal.migrationTag,
        deleted_classes: [terminal.deletedClass],
      },
    ],
  };
}

export function validateLiveProfile(profile, admission, environmentId) {
  assertExactJson(
    "live Worker profile",
    profile,
    expectedLiveProfile(admission, environmentId),
  );
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
