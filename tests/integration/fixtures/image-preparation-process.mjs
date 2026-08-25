#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.env.AGENTSCOPE_IMAGE_FIXTURE_MODE ?? "success";
const stateRoot = process.env.AGENTSCOPE_IMAGE_FIXTURE_ROOT;
if (typeof stateRoot !== "string") process.exit(70);
const heartbeat = resolve(stateRoot, "heartbeat");
const ready = resolve(stateRoot, "ready");
const attempt = resolve(stateRoot, "attempt");
const record = resolve(stateRoot, "record.json");
const descendantMode = process.argv[2] === "descendant";

if (descendantMode) {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  setInterval(() => appendFileSync(heartbeat, "."), 10);
} else {
  const commandArguments = process.argv.slice(2);
  const command = commandArguments[0];
  const dockerConfig = process.env.DOCKER_CONFIG;
  if (typeof dockerConfig !== "string") process.exit(71);
  writeFileSync(
    record,
    JSON.stringify({
      commandArguments,
      dockerAuthConfigPresent: "DOCKER_AUTH_CONFIG" in process.env,
      dockerConfigPath: dockerConfig,
      dockerConfig: JSON.parse(
        readFileSync(resolve(dockerConfig, "config.json"), "utf8"),
      ),
    }),
  );
  const shouldHang =
    command === "pull" &&
    (mode === "hang" ||
      (mode === "hang-once" &&
        (() => {
          try {
            readFileSync(attempt);
            return false;
          } catch {
            writeFileSync(attempt, "attempted");
            return true;
          }
        })()));
  if (shouldHang) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "descendant"],
      {
        env: process.env,
        stdio: "ignore",
      },
    );
    const temporary = `${ready}.${process.pid}.tmp`;
    writeFileSync(temporary, String(child.pid));
    renameSync(temporary, ready);
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
  } else if (command === "pull" && mode === "oversized") {
    process.stdout.write("x".repeat(65_537));
    setInterval(() => {}, 1_000);
  } else if (command === "pull") {
    process.exit(0);
  } else if (
    JSON.stringify(commandArguments.slice(0, 4)) ===
    JSON.stringify(["image", "inspect", "--format", "{{.Id}}"])
  ) {
    process.stdout.write(`sha256:${"a".repeat(64)}\n`);
  } else {
    process.exit(72);
  }
}
