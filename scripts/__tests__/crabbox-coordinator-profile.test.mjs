import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const script = resolve(
  repositoryRoot,
  "scripts/crabbox-coordinator-profile.mjs",
);
const admission = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "ops/crabbox-coordinator/admission.json"),
    "utf8",
  ),
);

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "agentscope-crabbox-profile-"));
  const source = resolve(root, "source");
  const worker = resolve(source, "worker");
  await mkdir(worker, { recursive: true });
  await writeFile(resolve(source, "LICENSE"), "fixture license\n");
  await writeFile(resolve(worker, "package-lock.json"), "fixture lock\n");
  spawnSync("/usr/bin/git", ["init", "-q", source]);
  spawnSync("/usr/bin/git", ["-C", source, "add", "."]);
  spawnSync("/usr/bin/git", [
    "-C",
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const commit = spawnSync(
    "/usr/bin/git",
    ["-C", source, "rev-parse", "HEAD"],
    {
      encoding: "utf8",
    },
  ).stdout.trim();
  const record = resolve(root, "record.json");
  await writeFile(
    record,
    `${JSON.stringify({
      environmentId: "asgcf_0123456789abcdef0123456789abcdef",
      workerName: "agentscope-crabbox-development",
      cloudflarePlan: "free",
      accountMode: "owner-personal-shared",
    })}\n`,
  );
  return { root, source, worker, record, commit };
}

test("refuses source outside the admitted immutable identity", async () => {
  const item = await fixture();
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--source",
      item.source,
      "--record",
      item.record,
      "--output",
      resolve(item.worker, "wrangler.agentscope.jsonc"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /source is not the clean admitted commit|license or Worker lock digest/,
  );
});

test("refuses an output path outside the exact Worker source", async () => {
  const item = await fixture();
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--source",
      item.source,
      "--record",
      item.record,
      "--output",
      resolve(item.root, "profile.jsonc"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /output must be/);
});

test("refuses a non-Free Cloudflare deployment record", async () => {
  const item = await fixture();
  await writeFile(
    item.record,
    `${JSON.stringify({
      environmentId: "asgcf_0123456789abcdef0123456789abcdef",
      workerName: "agentscope-crabbox-development",
      cloudflarePlan: "paid",
      accountMode: "owner-personal-shared",
    })}\n`,
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--source",
      item.source,
      "--record",
      item.record,
      "--output",
      resolve(item.worker, "wrangler.agentscope.jsonc"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /free plan/);
});

test("refuses an unapproved Cloudflare account mode", async () => {
  const item = await fixture();
  await writeFile(
    item.record,
    `${JSON.stringify({
      environmentId: "asgcf_0123456789abcdef0123456789abcdef",
      workerName: "agentscope-crabbox-development",
      cloudflarePlan: "free",
      accountMode: "dedicated",
    })}\n`,
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--source",
      item.source,
      "--record",
      item.record,
      "--output",
      resolve(item.worker, "wrangler.agentscope.jsonc"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared account/);
});

test("the committed admission preserves secret-role and public-binding boundaries", () => {
  assert.deepEqual(admission.deployment.secretPolicy, {
    pairwiseDistinctValues: true,
    retainValueDigest: false,
    sharedTokenDeniedOnAdminRoute: true,
    providerTokenMayAuthenticateCoordinator: false,
  });
  assert.deepEqual(admission.deployment.publicBindingPolicy, {
    scriptWorkersDevOnly: true,
    previewUrls: false,
    zoneRoutes: false,
    workerDomains: false,
    customDomains: false,
    pagesBindings: false,
    accessApplications: false,
    accountSharedStorage: false,
  });
});

test("the committed admission keeps the initial fleet bounds", () => {
  assert.deepEqual(admission.fleet, {
    provider: "hetzner",
    serverType: "cx33",
    location: "fsn1",
    image: "ubuntu-24.04",
    architecture: "amd64",
    maxWorkers: 4,
    maxTtlMinutes: 90,
    maxIdleMinutes: 20,
    maxMonthlyReservationUsd: 25,
    keep: false,
    checkpoints: false,
  });
});
