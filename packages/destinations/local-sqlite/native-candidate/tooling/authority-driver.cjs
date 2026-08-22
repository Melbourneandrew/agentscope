"use strict";

const { readdirSync } = require("node:fs");

const loader = require("/work/node_modules/@agentscope/cli/dist/internal/local-sqlite/loader/owned-loader.cjs");
const countDescriptors = () => readdirSync("/proc/self/fd").length;
const before = countDescriptors();
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    loader.load({
      manifestDigest: `sha256:${"0".repeat(64)}`,
      nativeTupleId: "node127-linux-x64-glibc",
      platformTupleId: "linux-x64-node22-ci-ext4-proposed",
    });
    throw new Error("destination.local-sqlite.loader-authority.accepted");
  } catch (error) {
    if (error?.code !== "destination.local-sqlite.native-unavailable")
      throw error;
  }
}
let accessorCalls = 0;
const hostile = {};
for (const key of ["manifestDigest", "nativeTupleId", "platformTupleId"])
  Object.defineProperty(hostile, key, {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "hostile";
    },
  });
try {
  loader.load(hostile);
  throw new Error("destination.local-sqlite.loader-accessor.accepted");
} catch (error) {
  if (error?.code !== "destination.local-sqlite.native-unavailable")
    throw error;
}
const after = countDescriptors();
try {
  loader.load(
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("SYNTHETIC_PROXY_CANARY");
        },
      },
    ),
  );
  throw new Error("destination.local-sqlite.loader-proxy.accepted");
} catch (error) {
  if (error?.code !== "destination.local-sqlite.native-unavailable")
    throw error;
}
if (after > before + 1 || accessorCalls !== 0)
  throw new Error("destination.local-sqlite.loader-authority.leaked");
process.stdout.write(
  `${JSON.stringify({ outcome: "rejected", before, after, accessorCalls, proxyCanaryEscaped: false })}\n`,
);
