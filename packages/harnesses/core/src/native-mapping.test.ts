import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  COMMON_NATIVE_SEMANTIC_FIELDS,
  NativeMappingError,
  completeNativeCaptureBoundary,
  createEphemeralCaptureBoundary,
  createNativeFieldProvenance,
  createNativeUnavailableField,
  resolveNativeCaptureStart,
  type NativeCaptureBoundary,
  type NativeCheckpointRequest,
  type NativeCheckpointResume,
} from "./native-mapping.js";

const request = (
  overrides: Partial<NativeCheckpointRequest> = {},
): NativeCheckpointRequest => ({
  nativeIdentityKind: "thread",
  nativeIdentity: "native-thread-1",
  sourceGeneration: 2,
  positionKind: "event-index",
  availableStartPosition: 3,
  ...overrides,
});

const retained = (
  overrides: Partial<NativeCheckpointResume> = {},
): NativeCheckpointResume => ({
  disposition: "retained",
  startPosition: 5,
  ...overrides,
});

describe("native checkpoint capture authority", () => {
  it("resolves once and completes one matching half-open boundary", () => {
    const resolver = vi.fn(() => retained());
    const start = resolveNativeCaptureStart(request(), resolver);
    const boundary = completeNativeCaptureBoundary(start, {
      boundaryKind: "transcript-range",
      boundaryId: "turn-5",
      exclusiveEndPosition: 8,
    });
    expect(resolver).toHaveBeenCalledWith({
      nativeIdentityKind: "thread",
      nativeIdentity: "native-thread-1",
      sourceGeneration: 2,
      positionKind: "event-index",
      availableStartPosition: 3,
    });
    expect(boundary).toEqual({
      session: {
        kind: "native-session",
        nativeIdentityKind: "thread",
        nativeIdentity: "native-thread-1",
      },
      boundaryKind: "transcript-range",
      boundaryId: "turn-5",
      generation: 2,
      positionKind: "event-index",
      startPosition: 5,
      exclusiveEndPosition: 8,
    });
    expect(Object.isFrozen(boundary)).toBe(true);
    expect(Object.isFrozen(boundary.session)).toBe(true);
    expectTypeOf(boundary).toEqualTypeOf<NativeCaptureBoundary>();
    expect(() =>
      completeNativeCaptureBoundary(start, {
        boundaryKind: "turn",
        boundaryId: "again",
        exclusiveEndPosition: 9,
      }),
    ).toThrow(NativeMappingError);
  });

  it.each([
    [null, retained()],
    [{ ...request(), extra: true }, retained()],
    [request({ nativeIdentityKind: "invalid" as never }), retained()],
    [request({ nativeIdentity: "" }), retained()],
    [request({ nativeIdentity: "x".repeat(1_025) }), retained()],
    [request({ sourceGeneration: -1 }), retained()],
    [request({ positionKind: "invalid" as never }), retained()],
    [request({ availableStartPosition: Number.NaN }), retained()],
    [request(), { disposition: "invalid", startPosition: 5 }],
    [request(), retained({ startPosition: 2 })],
    [request(), { disposition: "replay-required", startPosition: 4 }],
    [request(), { disposition: "source-loss", startPosition: 4 }],
    [request(), { disposition: "unavailable", startPosition: 4 }],
    [request(), { disposition: "retained", startPosition: -1 }],
  ])("rejects malformed request or resume authority", (input, resume) => {
    expect(() =>
      resolveNativeCaptureStart(input as never, () => resume as never),
    ).toThrow(NativeMappingError);
  });

  it("contains resolver throws and observes rejected async misuse", async () => {
    expect(() =>
      resolveNativeCaptureStart(request(), () => {
        throw new Error("CANARY");
      }),
    ).toThrow(NativeMappingError);
    expect(() =>
      resolveNativeCaptureStart(request(), (() =>
        Promise.reject(new Error("CANARY_SECRET"))) as never),
    ).toThrow(NativeMappingError);
    expect(() =>
      resolveNativeCaptureStart(request(), (() =>
        Promise.resolve(retained())) as never),
    ).toThrow(NativeMappingError);
    await Promise.resolve();
  });

  it("rejects forged authority and malformed completion", () => {
    expect(() =>
      completeNativeCaptureBoundary({} as never, {
        boundaryKind: "turn",
        boundaryId: "turn-1",
        exclusiveEndPosition: 6,
      }),
    ).toThrow(NativeMappingError);
    const invalidKind = resolveNativeCaptureStart(request(), () => retained());
    expect(() =>
      completeNativeCaptureBoundary(invalidKind, {
        boundaryKind: "invalid" as never,
        boundaryId: "turn-1",
        exclusiveEndPosition: 6,
      }),
    ).toThrow(NativeMappingError);
    const invalidEnd = resolveNativeCaptureStart(request(), () => retained());
    expect(() =>
      completeNativeCaptureBoundary(invalidEnd, {
        boundaryKind: "turn",
        boundaryId: "turn-1",
        exclusiveEndPosition: 5,
      }),
    ).toThrow(NativeMappingError);
  });
});

describe("native checkpoint hostile containment", () => {
  it("rejects accessors and proxy traps without reading them", () => {
    let reads = 0;
    const accessor = request();
    Object.defineProperty(accessor, "nativeIdentity", {
      enumerable: true,
      get() {
        reads += 1;
        return "native-thread-1";
      },
    });
    expect(() => resolveNativeCaptureStart(accessor, () => retained())).toThrow(
      NativeMappingError,
    );
    expect(reads).toBe(0);
    expect(() =>
      resolveNativeCaptureStart(
        new Proxy(request(), {
          ownKeys() {
            throw new Error("CANARY");
          },
        }),
        () => retained(),
      ),
    ).toThrow(NativeMappingError);
  });

  it("accepts each closed resume disposition at its valid start", () => {
    for (const disposition of [
      "retained",
      "replay-required",
      "source-loss",
      "unavailable",
    ] as const) {
      const startPosition = disposition === "retained" ? 5 : 3;
      const start = resolveNativeCaptureStart(request(), () => ({
        disposition,
        startPosition,
      }));
      expect(
        completeNativeCaptureBoundary(start, {
          boundaryKind: "turn",
          boundaryId: `boundary-${disposition}`,
          exclusiveEndPosition: startPosition + 1,
        }).startPosition,
      ).toBe(startPosition);
    }
  });
});

describe("native boundary and provenance helpers", () => {
  it.each(["boundary-scoped", "attempt-scoped"] as const)(
    "creates a deterministic %s noncheckpointed boundary",
    (scope) => {
      expect(
        createEphemeralCaptureBoundary({
          scope,
          boundaryKind: "hook-invocation",
          boundaryId: "invocation-1",
          generation: 0,
          positionKind: "sequence",
          startPosition: 0,
          exclusiveEndPosition: 1,
        }),
      ).toMatchObject({ session: { kind: scope }, startPosition: 0 });
    },
  );

  it.each([
    { scope: "invalid" },
    { boundaryKind: "invalid" },
    { boundaryId: "bad id" },
    { generation: -1 },
    { positionKind: "invalid" },
    { startPosition: -1 },
    { exclusiveEndPosition: 0 },
  ])("rejects malformed ephemeral boundary member %#", (override) => {
    expect(() =>
      createEphemeralCaptureBoundary({
        scope: "boundary-scoped",
        boundaryKind: "turn",
        boundaryId: "turn-1",
        generation: 0,
        positionKind: "line",
        startPosition: 0,
        exclusiveEndPosition: 1,
        ...override,
      } as never),
    ).toThrow(NativeMappingError);
  });

  it("creates exact native provenance and unavailable evidence", () => {
    expect(COMMON_NATIVE_SEMANTIC_FIELDS).toMatchObject({
      modelName: "llm.model_name",
      modelInvocationParameters: "llm.invocation_parameters",
      modelReasoningTokenCount: "llm.token_count.completion_details.reasoning",
      modelTotalTokenCount: "llm.token_count.total",
      toolName: "tool.name",
      skillName: "tool.name",
      errorType: "error.type",
      errorMessage: "exception.message",
      childAgentName: "agent.name",
    });
    expect(
      createNativeFieldProvenance("llm.model_name", "native-artifact"),
    ).toEqual({ field: "llm.model_name", source: "native-artifact" });
    expect(
      createNativeUnavailableField({
        field: "tool.name",
        source: "hook-payload",
        state: "unavailable",
        reason: "not-emitted",
      }),
    ).toEqual({
      field: "tool.name",
      source: "hook-payload",
      state: "unavailable",
      reason: "not-emitted",
    });
  });

  it.each([
    ["unavailable", "resolution-failed"],
    ["unavailable", "unsupported"],
    ["not-applicable", "not-applicable"],
    ["not-applicable", "detached-head"],
    ["observed-empty", "empty-native-value"],
  ] as const)("accepts the closed %s/%s absence pair", (state, reason) => {
    expect(
      createNativeUnavailableField({
        field: "family.tool.activity",
        source: "native-artifact",
        state,
        reason,
      }),
    ).toMatchObject({ state, reason });
  });

  it.each([
    () => createNativeFieldProvenance("vcs.ref.head.name", "native-artifact"),
    () => createNativeFieldProvenance("bad field", "native-artifact"),
    () => createNativeFieldProvenance("tool.name", "git" as never),
    () =>
      createNativeUnavailableField({
        field: "tool.name",
        source: "native-artifact",
        state: "invalid" as never,
        reason: "not-emitted",
      }),
    () =>
      createNativeUnavailableField({
        field: "tool.name",
        source: "native-artifact",
        state: "unavailable",
        reason: "invalid" as never,
      }),
    () =>
      createNativeUnavailableField({
        field: "tool.name",
        source: "native-artifact",
        state: "observed-empty",
        reason: "not-emitted",
      }),
  ])("rejects forged Core or malformed provenance", (operation) => {
    expect(operation).toThrow(NativeMappingError);
  });
});
