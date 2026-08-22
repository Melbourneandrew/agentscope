"use strict";

const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

void (async () => {
  const manifestDigest = process.env.AGENTSCOPE_NATIVE_MANIFEST_DIGEST;
  if (!/^sha256:[0-9a-f]{64}$/u.test(manifestDigest))
    throw new Error("destination.local-sqlite.native-execution.invalid");
  const loader =
    require("/work/node_modules/@agentscope/cli/dist/internal/local-sqlite/loader/owned-loader.cjs").load(
      Object.freeze({
        manifestDigest,
        nativeTupleId: "node127-linux-x64-glibc",
        platformTupleId: "linux-x64-node22-ci-ext4-proposed",
      }),
    );
  const database = loader.open("/evidence/proof.sqlite");
  database.exec("CREATE TABLE proof(value TEXT NOT NULL)");
  database.prepare("INSERT INTO proof VALUES (?)").run("packed-ok");
  database.close();

  let networkDenied = false;
  try {
    await fetch("http://198.51.100.1/native-egress-canary", {
      signal: AbortSignal.timeout(500),
    });
  } catch {
    networkDenied = true;
  }
  if (!networkDenied)
    throw new Error("destination.local-sqlite.native-execution.invalid");
  let hostMutationDenied = false;
  try {
    writeFileSync("/host-canary", "mutated");
  } catch {
    hostMutationDenied = true;
  }
  if (!hostMutationDenied)
    throw new Error("destination.local-sqlite.native-execution.invalid");
  const retained = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  retained.unref();
})().catch((error) => {
  process.stderr.write(`${error?.message ?? "native execution failed"}\n`);
  process.exitCode = 1;
});
