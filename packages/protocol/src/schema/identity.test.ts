import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import goldenVectors from "../testing/fixtures/identity-golden-vectors.json" with { type: "json" };
import { standardsManifest } from "../standards/manifest.js";
import { fingerprintCanonicalMaterial } from "./extensions.js";
import {
  IdentityProfileError,
  NATIVE_IDENTITY_KINDS,
  validateIdentityProfileBindingForTesting,
  validateIdentityProfileForTesting,
} from "./identity-profile.js";
import {
  deriveIdentityBundle,
  getDerivedIdentityBundleTopology,
  IDENTITY_PROFILE,
  IDENTITY_PROFILE_FINGERPRINT,
  identitySpanFlagsAreValid,
  IdentityError,
  validateIdentityDigestForTesting,
} from "./identity.js";

const base = () => ({
  harnessRegistryId: "codex",
  session: {
    kind: "native-session",
    nativeIdentityKind: "thread",
    nativeIdentity: "native-123",
  },
  boundary: {
    kind: "turn",
    id: "journal",
    generation: 1,
    positionKind: "event-index",
    exclusiveEndPosition: 2,
  },
  operationIdScope: "session-global",
  operations: [
    { logicalKey: "root", locator: { kind: "source-ordinal", ordinal: 0 } },
    {
      logicalKey: "child",
      parentLogicalKey: "root",
      locator: { kind: "native-operation", nativeId: "call-1" },
    },
  ],
});

describe("ASID identity profile", () => {
  it("derives stable native-session identities and immutable results", () => {
    const result = deriveIdentityBundle(base());
    expect(result).toEqual({
      stability: "session-stable",
      sessionId:
        "2661d46c8bfc9bab4196b2ded178e28b49f9c4ef771594f8ce9d3d68948fc5b2",
      traceId: "aa08d5a47ea4e32a71286e2203da07cf",
      spans: {
        child: "202e4109b71c6c3b",
        root: "298deaa1652a0300",
      },
      boundaryId:
        "5ae6cfdb217c1d36b82ef1ae349ec077cd372c7dc25fe3b1e89065c60f5e9b03",
      deliveryId:
        "593d157433e53872ff65a4a25f1c418d3c9ecaa0b1dd953c51b6cab4340202da",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.spans)).toBe(true);
    expect(getDerivedIdentityBundleTopology(result)).toEqual({
      child: "root",
      root: undefined,
    });
    expect(getDerivedIdentityBundleTopology({ ...result })).toBeUndefined();
    expect(IDENTITY_PROFILE_FINGERPRINT).toMatch(/^sha256-[\da-f]{64}$/u);
    expect(Object.isFrozen(IDENTITY_PROFILE)).toBe(true);
    expect(IDENTITY_PROFILE.enums.nativeIdentityKind).toEqual(
      NATIVE_IDENTITY_KINDS,
    );
    expect(Object.isFrozen(NATIVE_IDENTITY_KINDS)).toBe(true);
  });

  it("pins literal ASID preimages and SHA-256 outputs for every domain", () => {
    for (const vector of Object.values(goldenVectors)) {
      expect(
        createHash("sha256")
          .update(Buffer.from(vector.preimage, "hex"))
          .digest("hex"),
      ).toBe(vector.digest);
      expect(vector.preimage.startsWith("4153494400010001")).toBe(true);
    }
    const native = deriveIdentityBundle(base());
    expect(native.sessionId).toBe(goldenVectors["session-native"].digest);
    expect(native.traceId).toBe(goldenVectors.trace.digest.slice(0, 32));
    expect(native.spans.root).toBe(
      goldenVectors["root-span"].digest.slice(0, 16),
    );
    expect(native.spans.child).toBe(
      goldenVectors["child-span-session-global-native"].digest.slice(0, 16),
    );
    expect(native.boundaryId).toBe(goldenVectors.boundary.digest);
    expect(native.deliveryId).toBe(goldenVectors.delivery.digest);
  });

  it("pins every fallback and locator-domain projection", () => {
    const boundary = deriveIdentityBundle({
      ...base(),
      session: { kind: "boundary-scoped" },
    });
    const attempt = deriveIdentityBundle({
      ...base(),
      session: { kind: "attempt-scoped", invocationNonce: "ab".repeat(32) },
    });
    expect(boundary.sessionId).toBe(goldenVectors["session-boundary"].digest);
    expect(attempt.sessionId).toBe(goldenVectors["session-attempt"].digest);

    const ordinal = deriveIdentityBundle({
      ...base(),
      operations: [
        base().operations[0],
        {
          logicalKey: "ordinal",
          parentLogicalKey: "root",
          locator: { kind: "source-ordinal", ordinal: 2 },
        },
      ],
    });
    expect(ordinal.spans.ordinal).toBe(
      goldenVectors["child-span-session-global-ordinal"].digest.slice(0, 16),
    );
    const parentScoped = deriveIdentityBundle({
      ...base(),
      operationIdScope: "parent-scoped",
      operations: [
        base().operations[0],
        base().operations[1],
        {
          logicalKey: "ordinal",
          parentLogicalKey: "root",
          locator: { kind: "source-ordinal", ordinal: 2 },
        },
      ],
    });
    expect(parentScoped.spans.child).toBe(
      goldenVectors["child-span-parent-native"].digest.slice(0, 16),
    );
    expect(parentScoped.spans.ordinal).toBe(
      goldenVectors["child-span-parent-ordinal"].digest.slice(0, 16),
    );
  });
});

describe("locator scope validation", () => {
  const colliding = (
    scope: "parent-scoped" | "session-global",
    locator: object,
  ) => ({
    ...base(),
    operationIdScope: scope,
    operations: [
      { logicalKey: "root", locator },
      { logicalKey: "child", parentLogicalKey: "root", locator },
    ],
  });

  it("rejects locator collisions that involve the root operation", () => {
    expect(() =>
      deriveIdentityBundle(
        colliding("session-global", {
          kind: "native-operation",
          nativeId: "same",
        }),
      ),
    ).toThrowError("protocol.identity.invalid");
    for (const scope of ["session-global", "parent-scoped"] as const) {
      expect(() =>
        deriveIdentityBundle(
          colliding(scope, { kind: "source-ordinal", ordinal: 0 }),
        ),
      ).toThrowError("protocol.identity.invalid");
    }
  });

  it("enforces parent-scoped native locators per structural parent", () => {
    const operations = [
      { logicalKey: "root", locator: { kind: "source-ordinal", ordinal: 0 } },
      {
        logicalKey: "parent",
        parentLogicalKey: "root",
        locator: { kind: "native-operation", nativeId: "parent" },
      },
      {
        logicalKey: "first",
        parentLogicalKey: "parent",
        locator: { kind: "native-operation", nativeId: "first" },
      },
      {
        logicalKey: "second",
        parentLogicalKey: "parent",
        locator: { kind: "native-operation", nativeId: "second" },
      },
    ];
    expect(
      deriveIdentityBundle({
        ...base(),
        operationIdScope: "parent-scoped",
        operations,
      }).spans,
    ).toHaveProperty("second");
    expect(() =>
      deriveIdentityBundle({
        ...base(),
        operationIdScope: "parent-scoped",
        operations: [
          ...operations,
          {
            logicalKey: "duplicate",
            parentLogicalKey: "parent",
            locator: { kind: "native-operation", nativeId: "first" },
          },
        ],
      }),
    ).toThrowError("protocol.identity.invalid");
  });

  it("rejects duplicate logical keys and multiple roots independently of locators", () => {
    expect(() =>
      deriveIdentityBundle({
        ...base(),
        operations: [
          base().operations[0],
          {
            logicalKey: "root",
            locator: { kind: "source-ordinal", ordinal: 1 },
          },
        ],
      }),
    ).toThrowError("protocol.identity.invalid");
    expect(() =>
      deriveIdentityBundle({
        ...base(),
        operations: [
          base().operations[0],
          {
            logicalKey: "other-root",
            locator: { kind: "source-ordinal", ordinal: 1 },
          },
        ],
      }),
    ).toThrowError("protocol.identity.invalid");
  });
});

describe("identity stability and input safety", () => {
  it("keeps session trace and existing spans stable across append boundaries", () => {
    const first = deriveIdentityBundle(base());
    const appended = deriveIdentityBundle({
      ...base(),
      boundary: { ...base().boundary, exclusiveEndPosition: 3 },
      operations: [
        ...base().operations,
        {
          logicalKey: "later",
          parentLogicalKey: "root",
          locator: { kind: "source-ordinal", ordinal: 2 },
        },
      ],
    });
    expect(appended.sessionId).toBe(first.sessionId);
    expect(appended.traceId).toBe(first.traceId);
    expect(appended.spans.root).toBe(first.spans.root);
    expect(appended.spans.child).toBe(first.spans.child);
    expect(appended.boundaryId).not.toBe(first.boundaryId);
    expect(appended.deliveryId).not.toBe(first.deliveryId);
    const reordered = deriveIdentityBundle({
      ...base(),
      operations: [...base().operations].reverse(),
    });
    expect(reordered).toEqual(first);
  });

  it("distinguishes boundary and attempt fallback stability", () => {
    const boundary = deriveIdentityBundle({
      ...base(),
      session: { kind: "boundary-scoped" },
    });
    const moved = deriveIdentityBundle({
      ...base(),
      session: { kind: "boundary-scoped" },
      boundary: { ...base().boundary, generation: 2, exclusiveEndPosition: 9 },
    });
    const attempt = deriveIdentityBundle({
      ...base(),
      session: { kind: "attempt-scoped", invocationNonce: "ab".repeat(32) },
    });
    expect(boundary.stability).toBe("boundary-scoped-at-least-once");
    expect(moved.traceId).toBe(boundary.traceId);
    expect(attempt.stability).toBe("attempt-scoped-at-least-once");
    expect(attempt.traceId).not.toBe(boundary.traceId);
  });

  it("validates the exact canonical span flag policy", () => {
    expect([0, 1, 256, 257].every(identitySpanFlagsAreValid)).toBe(true);
    for (const invalid of [2, 3, 4, 255, 512, 768, 769, -1, 1.5, "1", null])
      expect(identitySpanFlagsAreValid(invalid)).toBe(false);
  });

  it("rejects zero projections and malformed digest validation inputs", () => {
    expect(validateIdentityDigestForTesting("1".repeat(64), 16)).toBe(
      "1".repeat(32),
    );
    for (const [digest, bytes] of [
      ["0".repeat(64), 16],
      ["0".repeat(16) + "1".repeat(48), 8],
      ["g".repeat(64), 16],
      ["1".repeat(64), 4],
      [null, 16],
    ] as const)
      expect(() => validateIdentityDigestForTesting(digest, bytes)).toThrow(
        IdentityError,
      );
  });

  it("rejects malformed and hostile inputs with one sanitized error", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("CANARY_SECRET");
        },
      },
    );
    for (const value of [null, {}, hostile, { ...base(), extra: true }]) {
      try {
        deriveIdentityBundle(value);
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(IdentityError);
        expect(String(error)).toBe("IdentityError: protocol.identity.invalid");
        expect(String(error)).not.toContain("CANARY_SECRET");
      }
    }
  });
});

describe("identity hostile-input preflight", () => {
  it("totally rejects hostile plain-data shapes and scalar boundaries", () => {
    const accessor = base();
    Object.defineProperty(accessor, "operations", {
      enumerable: true,
      get() {
        throw new Error("CANARY_SECRET");
      },
    });
    const symbolKey = base();
    Object.defineProperty(symbolKey, Symbol("hidden"), { value: true });
    const shared = {
      kind: "native-session",
      nativeIdentityKind: "x",
      nativeIdentity: "y",
    };
    const aliased = { ...base(), session: shared, extra: shared };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const deep = { ...base(), extra: {} as Record<string, unknown> };
    let cursor = deep.extra;
    for (let index = 0; index < 14; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    const wide = {
      ...base(),
      extra: Object.fromEntries(
        Array.from({ length: 513 }, (_, index) => [`k${index}`, index]),
      ),
    };
    const manyNodes = {
      ...base(),
      extra: Array.from({ length: 256 }, () =>
        Array.from({ length: 10 }, () => 1),
      ),
    };
    const tooManyBytes = {
      ...base(),
      extra: Array.from({ length: 128 }, () =>
        Array.from({ length: 10 }, () => "x".repeat(1_024)),
      ),
    };
    const oversizedKey = { ...base(), ["k".repeat(129)]: true };
    const sparseOperations = Array(2);
    sparseOperations[0] = base().operations[0];
    const disguisedSparseOperations = [...base().operations] as unknown[] & {
      extra?: unknown;
    };
    Reflect.deleteProperty(disguisedSparseOperations, "1");
    disguisedSparseOperations.extra = base().operations[1];
    for (const value of [
      undefined,
      true,
      1,
      "trace",
      Symbol("trace"),
      1n,
      () => undefined,
      new Date(),
      new Map(),
      Buffer.from("trace"),
      accessor,
      symbolKey,
      aliased,
      { ...base(), extra: cycle },
      deep,
      wide,
      manyNodes,
      tooManyBytes,
      oversizedKey,
      { ...base(), operations: sparseOperations },
      { ...base(), operations: disguisedSparseOperations },
      { ...base(), boundary: { ...base().boundary, generation: Number.NaN } },
      { ...base(), boundary: { ...base().boundary, generation: -1 } },
      { ...base(), boundary: { ...base().boundary, generation: 1.5 } },
      {
        ...base(),
        boundary: {
          ...base().boundary,
          generation: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      { ...base(), boundary: { ...base().boundary, id: "x".repeat(1_025) } },
      { ...base(), operations: [] },
    ])
      expect(() => deriveIdentityBundle(value)).toThrow(IdentityError);
  });

  it("preserves opaque Unicode bytes without normalization", () => {
    const withIdentity = (nativeIdentity: string) =>
      deriveIdentityBundle({
        ...base(),
        session: { ...base().session, nativeIdentity },
      });
    expect(withIdentity("é").traceId).not.toBe(withIdentity("e\u0301").traceId);
    expect(withIdentity("session-😀\u0000").traceId).toHaveLength(32);
    expect(() => withIdentity("\ud800")).toThrow(IdentityError);
    expect(withIdentity("x".repeat(1_024)).traceId).toHaveLength(32);
    expect(() => withIdentity("x".repeat(1_025))).toThrow(IdentityError);
  });
});

describe("identity graph semantics", () => {
  it("rejects invalid identity enums, variants, and graph topology", () => {
    const invalid = [
      { ...base(), harnessRegistryId: "unknown" },
      { ...base(), operationIdScope: "unknown" },
      { ...base(), boundary: { ...base().boundary, kind: "unknown" } },
      { ...base(), boundary: { ...base().boundary, positionKind: "unknown" } },
      { ...base(), session: { kind: "unknown" } },
      {
        ...base(),
        session: {
          kind: "native-session",
          nativeIdentityKind: "bad space",
          nativeIdentity: "x",
        },
      },
      {
        ...base(),
        session: { kind: "attempt-scoped", invocationNonce: "0".repeat(64) },
      },
      {
        ...base(),
        session: { kind: "attempt-scoped", invocationNonce: "AB".repeat(32) },
      },
      { ...base(), operations: [base().operations[0], base().operations[0]] },
      {
        ...base(),
        operations: [
          base().operations[0],
          { ...base().operations[1], parentLogicalKey: "missing" },
        ],
      },
      {
        ...base(),
        operations: [
          base().operations[0],
          { ...base().operations[1], parentLogicalKey: undefined },
        ],
      },
      {
        ...base(),
        operations: [
          base().operations[0],
          {
            logicalKey: "a",
            parentLogicalKey: "b",
            locator: { kind: "source-ordinal", ordinal: 1 },
          },
          {
            logicalKey: "b",
            parentLogicalKey: "a",
            locator: { kind: "source-ordinal", ordinal: 2 },
          },
        ],
      },
      {
        ...base(),
        operations: [
          base().operations[0],
          base().operations[1],
          { ...base().operations[1], logicalKey: "duplicate-locator" },
        ],
      },
      {
        ...base(),
        operations: [{ ...base().operations[0], locator: { kind: "unknown" } }],
      },
      {
        ...base(),
        operations: [
          {
            ...base().operations[0],
            locator: { kind: "native-operation", nativeId: "" },
          },
        ],
      },
      {
        ...base(),
        operations: [
          {
            ...base().operations[0],
            locator: { kind: "source-ordinal", ordinal: -1 },
          },
        ],
      },
    ];
    for (const value of invalid)
      expect(() => deriveIdentityBundle(value)).toThrow(IdentityError);
  });

  it("allows parent-scoped locator reuse under distinct parents", () => {
    const result = deriveIdentityBundle({
      ...base(),
      operationIdScope: "parent-scoped",
      operations: [
        base().operations[0],
        {
          logicalKey: "p1",
          parentLogicalKey: "root",
          locator: { kind: "source-ordinal", ordinal: 1 },
        },
        {
          logicalKey: "p2",
          parentLogicalKey: "root",
          locator: { kind: "source-ordinal", ordinal: 2 },
        },
        {
          logicalKey: "c1",
          parentLogicalKey: "p1",
          locator: { kind: "native-operation", nativeId: "shared" },
        },
        {
          logicalKey: "c2",
          parentLogicalKey: "p2",
          locator: { kind: "native-operation", nativeId: "shared" },
        },
      ],
    });
    expect(result.spans.c1).not.toBe(result.spans.c2);
  });
});

describe("identity profile governance", () => {
  it("binds the recursively frozen descriptor to the manifest", () => {
    expect(IDENTITY_PROFILE_FINGERPRINT).toBe(
      standardsManifest.identityProfile.profileFingerprint,
    );
    expect(fingerprintCanonicalMaterial(IDENTITY_PROFILE)).toBe(
      IDENTITY_PROFILE_FINGERPRINT,
    );
    expect(Object.isFrozen(IDENTITY_PROFILE.domains.boundary!.fields)).toBe(
      true,
    );
    expect(Reflect.set(IDENTITY_PROFILE.output, "traceIdBytes", 8)).toBe(false);
    expect(
      validateIdentityProfileBindingForTesting(
        standardsManifest.identityProfile,
      ),
    ).toMatchObject({ profileVersion: 1 });
    expect(() =>
      validateIdentityProfileBindingForTesting({
        ...standardsManifest.identityProfile,
        profileFingerprint: "sha256-" + "0".repeat(64),
      }),
    ).toThrow(IdentityProfileError);
  });

  it("rejects drift in every load-bearing descriptor family", () => {
    const mutations: readonly [readonly string[], unknown][] = [
      [["magic"], "NOPE"],
      [["codecVersion"], 2],
      [["header", "domainWidth"], "u32be"],
      [["fieldEncoding", "fieldOrder"], "input"],
      [["fieldTypes", "utf8"], 9],
      [["stringPolicy", "unicodeNormalization"], "NFC"],
      [["inputLimits", "maximumDepth"], 13],
      [["output", "projection"], "rightmost"],
      [
        ["enums", "sessionClass"],
        [...IDENTITY_PROFILE.enums.sessionClass, "new"],
      ],
      [["domains", "trace", "code"], 99],
      [["domains", "trace", "fields", "0", "tag"], 2],
      [["fallback", "boundarySeedExcludes"], ["generation"]],
      [
        ["flags", "allowedSpanFlags"],
        [0, 1, 2, 256, 257],
      ],
      [["privacyExclusions"], ["content"]],
    ];
    for (const [path, replacement] of mutations) {
      const value: unknown = structuredClone(IDENTITY_PROFILE);
      let cursor = value;
      for (const segment of path.slice(0, -1)) {
        if (typeof cursor !== "object" || cursor === null)
          throw new Error("bad fixture");
        cursor = (cursor as Record<string, unknown>)[segment];
      }
      if (typeof cursor !== "object" || cursor === null)
        throw new Error("bad fixture");
      (cursor as Record<string, unknown>)[path.at(-1)!] = replacement;
      expect(() => validateIdentityProfileForTesting(value)).toThrow(
        IdentityProfileError,
      );
      expect(fingerprintCanonicalMaterial(value)).not.toBe(
        IDENTITY_PROFILE_FINGERPRINT,
      );
    }
  });
});
