import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  "scripts/crabbox-coordinator-retirement-profile.mjs",
);

async function fixture(overrides = {}) {
  const root = await mkdtemp(
    resolve(tmpdir(), "agentscope-crabbox-retirement-"),
  );
  const source = resolve(root, "source");
  const worker = resolve(source, "worker");
  await mkdir(worker, { recursive: true });
  const environmentId = "asgcf_0123456789abcdef0123456789abcdef";
  const record = resolve(root, "record.json");
  await writeFile(record, `${JSON.stringify({ environmentId })}\n`);
  const providerZero = {
    schemaVersion: 1,
    environmentId,
    provider: "hetzner",
    observerRole: "human-recovery-inventory",
    observedAt: new Date(Date.now() - 30_000).toISOString(),
    servers: 0,
    sshKeys: 0,
    coordinatorActiveLeases: 0,
    coordinatorPendingCreates: 0,
    ledgerContinuous: true,
    ...overrides,
  };
  const observation = resolve(root, "provider-zero.json");
  const signaturePath = resolve(root, "provider-zero.sig");
  const keyPath = resolve(root, "recovery.pem");
  const keys = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(`${JSON.stringify(providerZero, null, 2)}\n`);
  await writeFile(observation, bytes);
  await writeFile(
    signaturePath,
    `${sign(null, bytes, keys.privateKey).toString("base64")}\n`,
  );
  await writeFile(
    keyPath,
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const output = resolve(worker, "wrangler.agentscope-terminal.jsonc");
  return {
    args: [
      script,
      "--source",
      source,
      "--record",
      record,
      "--provider-zero",
      observation,
      "--provider-zero-signature",
      signaturePath,
      "--recovery-key",
      keyPath,
      "--output",
      output,
    ],
    output,
    worker,
  };
}

test("renders the no-authority terminal profile only from signed provider-zero evidence", async () => {
  const item = await fixture();
  const result = spawnSync(process.execPath, item.args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.runtimeAuthority, false);
  const profile = JSON.parse(await readFile(item.output, "utf8"));
  assert.equal(profile.workers_dev, false);
  assert.equal(
    profile.migrations.at(-1).deleted_classes[0],
    "FleetDurableObject",
  );
  assert.equal(
    await readFile(
      resolve(item.worker, "terminal-worker.agentscope.mjs"),
      "utf8",
    ),
    "// Intentionally empty terminal retirement artifact: no runtime exports or authority.\n",
  );
});

test("refuses retirement while a provider server survives", async () => {
  const item = await fixture({ servers: 1 });
  const result = spawnSync(process.execPath, item.args, { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale or not terminal/);
});

test("refuses an output outside the exact Worker source", async () => {
  const item = await fixture();
  item.args[item.args.length - 1] = resolve(
    dirname(item.worker),
    "terminal.jsonc",
  );
  const result = spawnSync(process.execPath, item.args, { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /output must be/);
});
