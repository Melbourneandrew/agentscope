import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  boundedRequestLedger,
  readBoundedJsonResponse,
  readHookLifecycleLedger,
} from "../codex-runtime-evidence.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("Codex bounded native ledgers", () => {
  it("reads one bounded JSON response and rejects overflow or malformed data", async () => {
    await expect(
      readBoundedJsonResponse(
        new Response(JSON.stringify([{ method: "POST" }])),
        128,
      ),
    ).resolves.toEqual([{ method: "POST" }]);
    await expect(
      readBoundedJsonResponse(new Response("x".repeat(129)), 128),
    ).rejects.toThrow("integration.codex.sidecar");
    await expect(
      readBoundedJsonResponse(new Response("{"), 128),
    ).rejects.toThrow("integration.codex.sidecar");
  });

  it("retains all request records and rejects extra capacity or non-records", () => {
    const records = [{ path: "/v1/responses" }, { path: "/unexpected" }];
    expect(boundedRequestLedger(records)).toHaveLength(2);
    expect(() =>
      boundedRequestLedger(Array.from({ length: 9 }, () => ({}))),
    ).toThrow("integration.codex.model-request");
    expect(() => boundedRequestLedger([null])).toThrow(
      "integration.codex.model-request",
    );
  });

  it("reads a closed hook ledger and rejects malformed or oversized input", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-codex-ledger-"));
    roots.push(root);
    const path = join(root, "hooks.jsonl");
    writeFileSync(path, '{"eventName":"SessionStart"}\n', { mode: 0o600 });
    expect(readHookLifecycleLedger(path)).toEqual([
      { eventName: "SessionStart" },
    ]);
    writeFileSync(path, "{}", { mode: 0o600 });
    expect(() => readHookLifecycleLedger(path)).toThrow(
      "integration.codex.hook-lifecycle",
    );
    writeFileSync(path, "x".repeat(16_385), { mode: 0o600 });
    expect(() => readHookLifecycleLedger(path)).toThrow(
      "integration.codex.hook-lifecycle",
    );
  });
});
