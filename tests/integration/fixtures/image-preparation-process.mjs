#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.AGENTSCOPE_IMAGE_FIXTURE_ROOT;
if (typeof root !== "string") process.exit(70);
const mode = process.env.AGENTSCOPE_IMAGE_FIXTURE_MODE ?? "success";
if (process.argv[2] === "descendant") {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  setInterval(() => appendFileSync(resolve(root, "heartbeat"), "."), 10);
} else if (mode === "hang-descendant" || mode === "close-descendant") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "descendant"],
    { env: process.env, stdio: "ignore" },
  );
  writeFileSync(resolve(root, "ready"), String(child.pid));
  if (mode === "hang-descendant") setInterval(() => {}, 1_000);
  else child.unref();
} else if (mode === "oversized") {
  process.stdout.write("x".repeat(16 * 1024 * 1024 + 1));
  setInterval(() => {}, 1_000);
}
