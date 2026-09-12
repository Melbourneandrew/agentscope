import { describe, expect, it } from "vitest";

import {
  boundedRequestLedger,
  readBoundedJsonResponse,
} from "../codex-runtime-evidence.mjs";

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
});
