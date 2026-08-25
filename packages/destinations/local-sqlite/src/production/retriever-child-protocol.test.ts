/* eslint-disable max-lines-per-function -- closed hostile DTO matrices are deliberately expressed as complete single tests. */

import {
  createDestinationConnectionId,
  createDestinationTypeId,
  createTraceLocator,
} from "@agentscope/destinations-core";
import {
  createTraceGetRequest,
  createTraceSearchRequest,
  normalizeTraceSearchQuery,
} from "@agentscope/destinations-core/testing";
import { describe, expect, it } from "vitest";

import {
  compileLocalSqliteGetPlan,
  compileLocalSqliteSearchPlan,
} from "../retriever/index.js";
import {
  decodeLocalSqliteRetrieverChildRequest,
  decodeLocalSqliteRetrieverChildResult,
  encodeLocalSqliteRetrieverChildRequest,
  encodeLocalSqliteRetrieverChildResult,
  type LocalSqliteRetrieverChildRequest,
} from "./retriever-child-protocol.js";

const connectionId = createDestinationConnectionId(
  `destination-connection-v1-${"a".repeat(64)}`,
);
const destinationType = createDestinationTypeId(
  "@agentscope/destination-local-sqlite",
);
const bounds = Object.freeze({
  maximumResponseBytes: 1_000_000,
  maximumWorkMilliseconds: 1_000,
});
const searchPlan = compileLocalSqliteSearchPlan(
  createTraceSearchRequest(
    normalizeTraceSearchQuery(
      { limit: 10, tags: ["tag-a"] },
      {
        commandStartedAt: "2099-01-01T00:00:00.000Z",
        knownHarnessIds: ["codex"],
        ordering: "start-time-desc-trace-id-asc",
      },
    ),
    { connectionId, destinationType },
  ),
  bounds,
)!;
const getPlan = compileLocalSqliteGetPlan(
  createTraceGetRequest(
    createTraceLocator({
      connectionId,
      destinationType,
      traceId: "1".repeat(32),
    }),
    { connectionId, destinationType },
  ),
  bounds,
)!;

const request = (
  operation: "search" | "get" = "search",
): LocalSqliteRetrieverChildRequest =>
  Object.freeze({
    type: "retrieve",
    nonce: "2".repeat(32),
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
    operation,
    plan: operation === "search" ? searchPlan : getPlan,
  });

describe("Local SQLite Retriever child protocol", () => {
  it("admits only exact package-compiled plans and physical authority", () => {
    for (const operation of ["search", "get"] as const) {
      const canonical = request(operation);
      expect(
        decodeLocalSqliteRetrieverChildRequest(
          encodeLocalSqliteRetrieverChildRequest(canonical).trimEnd(),
        ),
      ).toEqual(canonical);
      expect(
        decodeLocalSqliteRetrieverChildRequest(
          JSON.stringify({
            ...canonical,
            plan: { ...canonical.plan, sql: `${canonical.plan.sql} -- unsafe` },
          }),
        ),
      ).toBeUndefined();
      expect(
        decodeLocalSqliteRetrieverChildRequest(
          JSON.stringify({
            ...canonical,
            databaseFamily: [
              ...canonical.databaseFamily,
              {
                name: "traces.sqlite-journal",
                physicalIdentity: "dev:1:ino:3",
              },
            ],
          }),
        ),
      ).toBeUndefined();
    }
  });

  it("rejects every malformed request authority before child work", () => {
    const canonical = request();
    const family = canonical.databaseFamily;
    for (const candidate of [
      "x".repeat(131_073),
      "{",
      JSON.stringify({}),
      JSON.stringify({ ...canonical, type: "other" }),
      JSON.stringify({ ...canonical, nonce: 1 }),
      JSON.stringify({ ...canonical, nonce: "0".repeat(32) }),
      JSON.stringify({ ...canonical, databasePath: "relative/traces.sqlite" }),
      JSON.stringify({ ...canonical, databasePath: "/owned/other.sqlite" }),
      JSON.stringify({ ...canonical, databasePath: "/owned/traces.sqlite\0" }),
      JSON.stringify({
        ...canonical,
        databasePath: `/owned/${"x".repeat(4_097)}`,
      }),
      JSON.stringify({ ...canonical, databaseFamily: [] }),
      JSON.stringify({ ...canonical, databaseFamily: [...family, ...family] }),
      JSON.stringify({
        ...canonical,
        databaseFamily: [{ name: "other", physicalIdentity: "dev:1:ino:2" }],
      }),
      JSON.stringify({
        ...canonical,
        databaseFamily: [{ name: "traces.sqlite", physicalIdentity: "bad" }],
      }),
      JSON.stringify({ ...canonical, maximumWorkMilliseconds: 0 }),
      JSON.stringify({ ...canonical, maximumWorkMilliseconds: 60_001 }),
      JSON.stringify({ ...canonical, maximumWorkMilliseconds: 1.5 }),
      JSON.stringify({ ...canonical, policy: {} }),
      JSON.stringify({
        ...canonical,
        policy: { ...canonical.policy, maximumAgeNanoseconds: "0" },
      }),
      JSON.stringify({
        ...canonical,
        policy: {
          ...canonical.policy,
          maximumAgeNanoseconds: "31536000000000001",
        },
      }),
      JSON.stringify({
        ...canonical,
        policy: { ...canonical.policy, maximumPayloadBytes: 0 },
      }),
      JSON.stringify({
        ...canonical,
        policy: { ...canonical.policy, maximumPayloadBytes: 10_737_418_241 },
      }),
      JSON.stringify({
        ...canonical,
        policy: { ...canonical.policy, maximumPayloadBytes: 1.5 },
      }),
      JSON.stringify({
        ...canonical,
        policy: { ...canonical.policy, maximumTraceCount: 0 },
      }),
      JSON.stringify({
        ...canonical,
        policy: { ...canonical.policy, maximumTraceCount: 1_000_001 },
      }),
      JSON.stringify({
        ...canonical,
        policy: { ...canonical.policy, maximumTraceCount: 1.5 },
      }),
      JSON.stringify({ ...canonical, operation: "other" }),
      JSON.stringify({
        ...canonical,
        plan: { ...canonical.plan, maximumResponseBytes: 0 },
      }),
      JSON.stringify({
        ...canonical,
        plan: { ...canonical.plan, snapshotToken: 1 },
      }),
      JSON.stringify({
        ...canonical,
        plan: { ...canonical.plan, snapshotToken: "bad" },
      }),
      JSON.stringify({
        ...canonical,
        plan: {
          ...canonical.plan,
          parameters: { ...canonical.plan.parameters, maximumRows: 999 },
        },
      }),
      JSON.stringify({
        ...canonical,
        plan: {
          ...canonical.plan,
          parameters: { ...canonical.plan.parameters, dimensionKind0: "other" },
        },
      }),
      ...[
        { fromSortKey: "bad" },
        { traceId: "bad" },
        { traceId: "0".repeat(32) },
        {
          cursorStart: "bad",
          cursorTraceId: "1".repeat(32),
          snapshotToken: "3".repeat(64),
        },
        {
          cursorStart: "0".repeat(20),
          cursorTraceId: "bad",
          snapshotToken: "3".repeat(64),
        },
        {
          cursorStart: "0".repeat(20),
          cursorTraceId: "0".repeat(32),
          snapshotToken: "3".repeat(64),
        },
      ].map(({ snapshotToken, ...parameters }) =>
        JSON.stringify({
          ...canonical,
          plan: {
            ...canonical.plan,
            ...(snapshotToken === undefined ? {} : { snapshotToken }),
            parameters: { ...canonical.plan.parameters, ...parameters },
          },
        }),
      ),
      JSON.stringify({
        ...canonical,
        plan: { ...canonical.plan, maximumWorkMilliseconds: 999 },
      }),
    ])
      expect(decodeLocalSqliteRetrieverChildRequest(candidate)).toBeUndefined();
  });

  it("admits only exact success and fixed failure results", () => {
    const success = Object.freeze({
      type: "retrieval-result" as const,
      nonce: "2".repeat(32),
      ok: true,
      evidence: Object.freeze({
        rows: Object.freeze([]),
        responseByteLimitReached: false,
        retentionCutoffSortKey: "0".repeat(20),
        snapshotToken: "3".repeat(64),
      }),
    });
    expect(
      decodeLocalSqliteRetrieverChildResult(
        encodeLocalSqliteRetrieverChildResult(success).trimEnd(),
      ),
    ).toEqual(success);
    expect(
      decodeLocalSqliteRetrieverChildResult(
        JSON.stringify({ ...success, unexpected: true }),
      ),
    ).toBeUndefined();
    expect(
      decodeLocalSqliteRetrieverChildResult(
        JSON.stringify({
          type: "retrieval-result",
          nonce: "2".repeat(32),
          ok: false,
        }),
      ),
    ).toEqual({
      type: "retrieval-result",
      nonce: "2".repeat(32),
      ok: false,
    });
    for (const candidate of [
      "x".repeat(49 * 1024 * 1024 + 1),
      "{",
      JSON.stringify({}),
      JSON.stringify({ ...success, type: "other" }),
      JSON.stringify({ ...success, nonce: 1 }),
      JSON.stringify({ ...success, nonce: "0".repeat(32) }),
      JSON.stringify({ ...success, ok: "true" }),
      JSON.stringify({
        type: "retrieval-result",
        nonce: "2".repeat(32),
        ok: true,
      }),
      JSON.stringify({ ...success, ok: false }),
    ])
      expect(decodeLocalSqliteRetrieverChildResult(candidate)).toBeUndefined();
  });
});

/* eslint-enable max-lines-per-function */
