"use strict";

const { copyFileSync, renameSync } = require("node:fs");

const root = "/work/node_modules/agentscope-cli/dist/internal/local-sqlite";
const loaded =
  require("/work/node_modules/agentscope-cli/dist/internal/local-sqlite/loader/owned-loader.cjs").load(
    Object.freeze({
      manifestDigest: process.env.AGENTSCOPE_NATIVE_MANIFEST_DIGEST,
      nativeTupleId: "node127-linux-x64-glibc",
      platformTupleId: "linux-x64-node22-ci-ext4-proposed",
    }),
  );
const runtime = `${root}/runtime/better-sqlite3.cjs`;
const original = `${runtime}.original`;
renameSync(runtime, original);
copyFileSync(original, runtime);
let code;
try {
  loaded.open(":memory:");
} catch (error) {
  code = error?.code;
}
if (code !== "destination.local-sqlite.native-unavailable")
  throw new Error("destination.local-sqlite.loader-replacement.accepted");
process.stdout.write(
  `${JSON.stringify({ outcome: "native-unavailable", databaseOpened: false })}\n`,
);
