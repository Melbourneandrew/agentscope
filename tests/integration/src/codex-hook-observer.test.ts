import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const observer = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "codex-hook-observer.mjs",
);
const roots: string[] = [];
const fixture = (output = "") => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-codex-hook-"));
  roots.push(root);
  const launcher = join(root, "launcher.mjs");
  writeFileSync(
    launcher,
    `#!/usr/bin/env node\nfor await (const _ of process.stdin) {}\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    { mode: 0o755 },
  );
  return { root, launcher, ledger: join(root, "ledger") };
};
const invoke = (
  value: ReturnType<typeof fixture>,
  event: "SessionStart" | "Stop" | "SessionEnd",
  sessionId = "session-1",
) =>
  spawnSync(
    process.execPath,
    [
      observer,
      "--event",
      event,
      "--launcher",
      value.launcher,
      "--ledger",
      value.ledger,
    ],
    {
      input: JSON.stringify({
        hook_event_name: event,
        session_id: sessionId,
        ...(event === "Stop" ? { turn_id: "turn-1" } : {}),
      }),
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 65_536,
    },
  );
const readEvent = (path: string): string => {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("event" in value) ||
    typeof value.event !== "string"
  )
    throw new Error("invalid fixture record");
  return value.event;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("Codex hook observer", () => {
  it("records the exact launcher-backed lifecycle in order", () => {
    const value = fixture();
    for (const event of ["SessionStart", "Stop", "SessionEnd"] as const)
      expect(invoke(value, event).status).toBe(0);
    expect(
      ["SessionStart", "Stop", "SessionEnd"].map((event) =>
        readEvent(join(value.ledger, `${event}.json`)),
      ),
    ).toEqual(["SessionStart", "Stop", "SessionEnd"]);
  });

  it("rejects duplicate, reordered, and substituted-session events", () => {
    const duplicate = fixture();
    expect(invoke(duplicate, "SessionStart").status).toBe(0);
    expect(invoke(duplicate, "SessionStart").status).not.toBe(0);
    const reordered = fixture();
    expect(invoke(reordered, "Stop").status).not.toBe(0);
    const substituted = fixture();
    expect(invoke(substituted, "SessionStart").status).toBe(0);
    expect(invoke(substituted, "Stop", "session-2").status).not.toBe(0);
  });

  it("rejects launcher output instead of fabricating a clean hook", () => {
    const value = fixture("unexpected");
    expect(invoke(value, "SessionStart").status).not.toBe(0);
  });
});
