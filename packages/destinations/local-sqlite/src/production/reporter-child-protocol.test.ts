import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeLocalSqliteReporterChildPermission,
  decodeLocalSqliteReporterChildReady,
  decodeLocalSqliteReporterChildRequest,
  decodeLocalSqliteReporterChildRequestHeader,
  decodeLocalSqliteReporterChildResult,
  decodeLocalSqliteReporterChildTrace,
  encodeLocalSqliteReporterChildMessage,
  encodeLocalSqliteReporterChildRequestHeader,
  encodeLocalSqliteReporterChildTrace,
  localSqliteReporterChildBatchFits,
  type LocalSqliteReporterChildRequest,
} from "./reporter-child-protocol.js";

const payloadUtf8 = '{"schemaVersion":1}';

const request = (): LocalSqliteReporterChildRequest =>
  Object.freeze({
    type: "attempt",
    nonce: "1".repeat(32),
    databasePath: "/owned/traces.sqlite",
    databaseFamily: Object.freeze([
      Object.freeze({
        name: "traces.sqlite",
        physicalIdentity: "dev:1:ino:2",
      }),
    ]),
    maximumWorkMilliseconds: 1_000,
    policy: Object.freeze({
      maximumAgeNanoseconds: "1",
      maximumPayloadBytes: 1,
      maximumTraceCount: 1,
    }),
    prepared: Object.freeze([
      Object.freeze({
        deliveryIdentity: "2".repeat(64),
        traceId: "3".repeat(32),
        startTimeUnixNano: "4",
        startTimeSortKey: "4".padStart(20, "0"),
        admissionTimeUnixNano: "5",
        admissionTimeSortKey: "5".padStart(20, "0"),
        protocolCompatibilityId: "p".repeat(1_024),
        payloadUtf8,
        payloadSha256: createHash("sha256")
          .update(payloadUtf8, "utf8")
          .digest("hex"),
        payloadBytes: Buffer.byteLength(payloadUtf8, "utf8"),
        dimensions: Object.freeze([]),
      }),
    ]),
    admissionTimeUnixNano: "5",
  });

/* eslint-disable max-lines-per-function -- one protocol matrix keeps the canonical request and every closed child message adjacent. */
describe("Local SQLite Reporter child protocol", () => {
  it("enforces the exact aggregate payload ceiling without allocating payload fixtures", () => {
    expect(
      localSqliteReporterChildBatchFits([
        { payloadBytes: 16 * 1024 * 1024 },
        { payloadBytes: 16 * 1024 * 1024 },
      ]),
    ).toBe(true);
    expect(
      localSqliteReporterChildBatchFits([
        { payloadBytes: 16 * 1024 * 1024 },
        { payloadBytes: 16 * 1024 * 1024 },
        { payloadBytes: 1 },
      ]),
    ).toBe(false);
  });

  it("round-trips the streaming header and trace records", () => {
    const canonical = request();
    expect(
      decodeLocalSqliteReporterChildRequestHeader(
        encodeLocalSqliteReporterChildRequestHeader(canonical),
      ),
    ).toEqual({
      type: "attempt-header",
      nonce: canonical.nonce,
      databasePath: canonical.databasePath,
      databaseFamily: canonical.databaseFamily,
      maximumWorkMilliseconds: canonical.maximumWorkMilliseconds,
      policy: canonical.policy,
      preparedCount: 1,
      admissionTimeUnixNano: canonical.admissionTimeUnixNano,
    });
    expect(
      decodeLocalSqliteReporterChildTrace(
        encodeLocalSqliteReporterChildTrace(
          canonical.nonce,
          canonical.prepared[0]!,
        ),
        canonical.nonce,
        canonical.admissionTimeUnixNano,
      ),
    ).toEqual(canonical.prepared[0]);
  });

  it("rejects every malformed streaming header authority", () => {
    const canonical = request();
    const header = JSON.parse(
      encodeLocalSqliteReporterChildRequestHeader(canonical),
    ) as Record<string, unknown>;
    const family = canonical.databaseFamily;
    for (const candidate of [
      "x".repeat(65_537),
      JSON.stringify({}),
      JSON.stringify({ ...header, type: "attempt" }),
      JSON.stringify({ ...header, nonce: "0".repeat(32) }),
      JSON.stringify({ ...header, nonce: 1 }),
      JSON.stringify({ ...header, databasePath: "relative/traces.sqlite" }),
      JSON.stringify({ ...header, databasePath: "/owned/other.sqlite" }),
      JSON.stringify({
        ...header,
        databasePath: `/owned/${"x".repeat(4_097)}`,
      }),
      JSON.stringify({ ...header, databasePath: "/owned/traces.sqlite\0" }),
      JSON.stringify({ ...header, databaseFamily: [] }),
      JSON.stringify({ ...header, databaseFamily: [...family, ...family] }),
      JSON.stringify({
        ...header,
        databaseFamily: [{ name: "other", physicalIdentity: "dev:1:ino:2" }],
      }),
      JSON.stringify({
        ...header,
        databaseFamily: [{ name: "traces.sqlite", physicalIdentity: "bad" }],
      }),
      JSON.stringify({ ...header, maximumWorkMilliseconds: 0 }),
      JSON.stringify({ ...header, maximumWorkMilliseconds: 60_001 }),
      JSON.stringify({ ...header, maximumWorkMilliseconds: 1.5 }),
      JSON.stringify({ ...header, policy: {} }),
      JSON.stringify({ ...header, preparedCount: 0 }),
      JSON.stringify({ ...header, preparedCount: 33 }),
      JSON.stringify({ ...header, preparedCount: 1.5 }),
      JSON.stringify({ ...header, admissionTimeUnixNano: "01" }),
    ])
      expect(
        decodeLocalSqliteReporterChildRequestHeader(candidate),
      ).toBeUndefined();
  });

  it("rejects malformed streaming trace authority", () => {
    const canonical = request();
    const trace = canonical.prepared[0]!;
    const record = {
      type: "trace",
      nonce: canonical.nonce,
      value: trace,
    };
    for (const candidate of [
      "x".repeat(17 * 1024 * 1024 + 1),
      JSON.stringify({}),
      JSON.stringify({ ...record, type: "attempt" }),
      JSON.stringify({ ...record, nonce: "0".repeat(32) }),
      JSON.stringify({ ...record, value: { ...trace, payloadSha256: "bad" } }),
    ])
      expect(
        decodeLocalSqliteReporterChildTrace(
          candidate,
          canonical.nonce,
          canonical.admissionTimeUnixNano,
        ),
      ).toBeUndefined();
    expect(
      decodeLocalSqliteReporterChildTrace(
        JSON.stringify(record),
        canonical.nonce,
        "2",
      ),
    ).toBeUndefined();
  });
  it("admits only the exact physical and canonical prepared authority", () => {
    const canonical = request();
    expect(
      decodeLocalSqliteReporterChildRequest(
        encodeLocalSqliteReporterChildMessage(canonical).trimEnd(),
      ),
    ).toEqual(canonical);
    expect(
      decodeLocalSqliteReporterChildRequest(
        JSON.stringify({
          ...canonical,
          databaseFamily: [
            { name: "traces.sqlite", physicalIdentity: "dev:1:ino:3" },
          ],
          unexpected: true,
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeLocalSqliteReporterChildRequest(
        JSON.stringify({ ...canonical, prepared: [] }),
      ),
    ).toBeUndefined();
    expect(
      decodeLocalSqliteReporterChildRequest(
        JSON.stringify({
          ...canonical,
          prepared: [
            {
              ...canonical.prepared[0],
              protocolCompatibilityId: "p".repeat(1_025),
            },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeLocalSqliteReporterChildRequest(
        JSON.stringify({
          ...canonical,
          prepared: [
            {
              ...canonical.prepared[0],
              payloadSha256: "4".repeat(64),
            },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeLocalSqliteReporterChildRequest(
        JSON.stringify({
          ...canonical,
          prepared: [
            {
              ...canonical.prepared[0],
              dimensions: [
                { kind: "tag", value: "b", ordinal: 0 },
                { kind: "tag", value: "a", ordinal: 1 },
              ],
            },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("decodes the closed ready, permission, result, and receipt vocabularies", () => {
    const nonce = "1".repeat(32);
    expect(
      decodeLocalSqliteReporterChildReady(
        JSON.stringify({
          type: "ready",
          nonce,
          pid: 123,
          startIdentity: "2".repeat(32),
        }),
      ),
    ).toEqual({
      type: "ready",
      nonce,
      pid: 123,
      startIdentity: "2".repeat(32),
    });
    expect(
      decodeLocalSqliteReporterChildReady(
        JSON.stringify({
          type: "ready",
          nonce,
          pid: 0,
          startIdentity: "2".repeat(32),
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeLocalSqliteReporterChildPermission(
        JSON.stringify({ type: "permission", nonce }),
      ),
    ).toEqual({ type: "permission", nonce });
    expect(
      decodeLocalSqliteReporterChildPermission(
        JSON.stringify({ type: "permission", nonce: "bad" }),
      ),
    ).toBeUndefined();
    for (const receipt of [
      { outcome: "accepted" },
      { outcome: "unavailable", reason: "destination-busy" },
    ])
      expect(
        decodeLocalSqliteReporterChildResult(
          JSON.stringify({ type: "result", nonce, receipt }),
        ),
      ).toEqual({ type: "result", nonce, receipt });

    for (const candidate of [
      "{",
      JSON.stringify({ type: "ready", nonce, pid: 0, startIdentity: nonce }),
      JSON.stringify({ type: "permission", nonce: "bad" }),
      JSON.stringify({
        type: "result",
        nonce,
        receipt: { outcome: "unknown" },
      }),
      JSON.stringify({
        type: "result",
        nonce,
        receipt: { outcome: "unavailable", reason: "provider-canary" },
      }),
      JSON.stringify({
        type: "result",
        nonce,
        receipt: { outcome: "accepted", reason: "destination-busy" },
      }),
    ])
      expect(decodeLocalSqliteReporterChildResult(candidate)).toBeUndefined();
  });

  it("rejects oversized, malformed, duplicate, and noncanonical trace batches", () => {
    const canonical = request();
    const trace = canonical.prepared[0]!;
    for (const candidate of [
      "{",
      JSON.stringify({ ...canonical, maximumWorkMilliseconds: 0 }),
      JSON.stringify({
        ...canonical,
        prepared: [trace, trace],
      }),
      JSON.stringify({
        ...canonical,
        prepared: [
          {
            ...trace,
            dimensions: [
              { kind: "tag", value: "tag", ordinal: 0 },
              { kind: "branch", value: "branch", ordinal: 0 },
            ],
          },
        ],
      }),
      JSON.stringify({
        ...canonical,
        prepared: [
          {
            ...trace,
            dimensions: [{ kind: "tag", value: "x".repeat(1_025), ordinal: 0 }],
          },
        ],
      }),
    ])
      expect(decodeLocalSqliteReporterChildRequest(candidate)).toBeUndefined();
  });
});
/* eslint-enable max-lines-per-function */
