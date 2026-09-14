import { describe, expect, it } from "vitest";

import {
  boundedRequestLedger,
  readBoundedJsonResponse,
  waitWithinObservationDeadline,
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

  it("never lets an observation backoff survive its absolute deadline", async () => {
    const boundedWait = waitWithinObservationDeadline;
    let now = 14_000;
    const waits: number[] = [];
    const wait = (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    };
    await expect(
      boundedWait({
        deadline: 15_000,
        maximumWaitMilliseconds: 500,
        now: () => now,
        wait,
      }),
    ).resolves.toBeUndefined();
    expect(waits).toEqual([500]);
    now = 14_900;
    await expect(
      boundedWait({
        deadline: 15_000,
        maximumWaitMilliseconds: 500,
        now: () => now,
        wait,
      }),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(waits).toEqual([500, 100]);
    await expect(
      boundedWait({
        deadline: 15_000,
        maximumWaitMilliseconds: 500,
        now: () => now,
        wait,
      }),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(waits).toEqual([500, 100]);
  });
});
