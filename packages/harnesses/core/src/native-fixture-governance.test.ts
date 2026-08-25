import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  auditNativeFixtureInventory,
  assertNativeFixtureAdmissionProvenance,
  NativeFixtureGovernanceError,
  parseHarnessSanitizedFixture,
  serializeHarnessSanitizedFixture,
  type HarnessSanitizedFixture,
} from "./native-fixture-governance.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = (): HarnessSanitizedFixture => ({
  fixtureVersion: 1,
  fixtureId: "codex-session-v1",
  harnessId: "codex",
  harnessVersion: "1.2.3",
  governance: {
    provenance: {
      captureKind: "synthetic",
      sourceReference: "urn:agentscope:synthetic:codex-session-v1",
      artifactAuthority: {
        status: "unresolved",
        reason: "independent-integrity-unavailable",
      },
      captureRecipe: "codex-session-recipe-v1",
    },
    license: {
      spdxExpression: "Apache-2.0",
      redistribution: "reviewed-for-repository",
      sourceReference: "https://example.invalid/codex/license",
    },
    redaction: {
      profileVersion: 1,
      classification: "sanitized-native-fixture",
      rawContentRetained: false,
      removedCategories: [
        "credentials",
        "raw-transcript",
        "terminal-output",
        "user-content",
        "user-paths",
      ],
    },
    review: {
      status: "approved",
      reviewedAt: "2026-08-25",
      references: ["github-pr:agentscope#101", "github-pr:agentscope#102"],
    },
    representative: {
      scenarioId: "codex-headless-v1",
      representativeVersion: "1.2.3",
      evidenceSlot: "codex-v1",
    },
  },
  nativeIdentityKind: "session",
  nativeIdentity: "synthetic-session-1",
  sourceGeneration: 1,
  positionKind: "sequence",
  availableStartPosition: 1,
  boundaryKind: "turn",
  boundaryId: "synthetic-turn-2",
  exclusiveEndPosition: 2,
  expectedFields: ["llm.model_name", "tool.name"],
  sanitizedPayload: {
    model: "synthetic-model",
    operation: "summarize",
    tool_count: 1,
  },
});

const expectCode = (operation: () => unknown, code: string): void => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(NativeFixtureGovernanceError);
    expect((error as NativeFixtureGovernanceError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
};

const writeInventoryFixture = async (
  value: unknown = fixture(),
  harnessId = "codex",
  fileName = "codex-session-v1.json",
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-native-fixtures-"));
  roots.push(root);
  const directory = join(root, harnessId, "fixtures", "native");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, fileName),
    typeof value === "string"
      ? value
      : serializeHarnessSanitizedFixture(value as HarnessSanitizedFixture),
  );
  return root;
};

describe("native fixture schema", () => {
  it("reconstructs an exact frozen governance record", () => {
    const input = fixture();
    const parsed = parseHarnessSanitizedFixture(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.governance.review.references)).toBe(true);
    expect(Object.isFrozen(parsed.sanitizedPayload)).toBe(true);
  });

  it("rejects unreviewed provenance and representative drift", () => {
    const input = fixture();
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...input,
          governance: {
            ...input.governance,
            review: { ...input.governance.review, references: ["review:one"] },
          },
        }),
      "harness.fixture.review.references",
    );
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...input,
          governance: {
            ...input.governance,
            representative: {
              ...input.governance.representative,
              representativeVersion: "1.2.4",
            },
          },
        }),
      "harness.fixture.representative.version-link",
    );
  });

  it.each([
    ["credential key", { api_key: "synthetic" }, "harness.fixture.payload.key"],
    [
      "raw transcript",
      { transcript: "synthetic" },
      "harness.fixture.payload.key",
    ],
    ["terminal output", { stdout: "synthetic" }, "harness.fixture.payload.key"],
    [
      "user path",
      { workspace: "/home/example/project" },
      "harness.fixture.payload.value",
    ],
    [
      "secret-shaped value",
      { model: "sk-synthetic" },
      "harness.fixture.payload.value",
    ],
    [
      "unsanitized prose",
      { operation: "tell me a story" },
      "harness.fixture.payload.value",
    ],
  ])("rejects %s content", (_name, sanitizedPayload, code) => {
    expectCode(
      () => parseHarnessSanitizedFixture({ ...fixture(), sanitizedPayload }),
      code,
    );
  });

  it("rejects accessor and extra-key objects", () => {
    const accessor = { ...fixture() } as Record<string, unknown>;
    Object.defineProperty(accessor, "fixtureId", {
      enumerable: true,
      get: () => "codex-session-v1",
    });
    expectCode(
      () => parseHarnessSanitizedFixture(accessor),
      "harness.fixture.shape",
    );
    expectCode(
      () => parseHarnessSanitizedFixture({ ...fixture(), unexpected: true }),
      "harness.fixture.shape",
    );
  });
});

describe("native fixture schema adversarial inputs", () => {
  it("rejects non-record, proxy, symbol, and non-plain inputs", () => {
    for (const input of [null, [], "fixture"]) {
      expectCode(
        () => parseHarnessSanitizedFixture(input),
        "harness.fixture.shape",
      );
    }
    const throwing = new Proxy(fixture(), {
      ownKeys: () => {
        throw new Error("synthetic proxy failure");
      },
    });
    expectCode(
      () => parseHarnessSanitizedFixture(throwing),
      "harness.fixture.shape",
    );
    const symbol = { ...fixture(), [Symbol("synthetic")]: true };
    expectCode(
      () => parseHarnessSanitizedFixture(symbol),
      "harness.fixture.shape",
    );
    expectCode(
      () => parseHarnessSanitizedFixture(Object.create(null) as unknown),
      "harness.fixture.shape",
    );
  });

  it("rejects malformed scalar, enum, range, and payload bounds", () => {
    const base = fixture();
    const invalid: readonly [unknown, string][] = [
      [{ ...base, fixtureVersion: 2 }, "harness.fixture.version"],
      [{ ...base, fixtureId: "Not Valid" }, "harness.fixture.id"],
      [{ ...base, sourceGeneration: -1 }, "harness.fixture.source-generation"],
      [
        { ...base, nativeIdentityKind: "process" },
        "harness.fixture.native-identity-kind",
      ],
      [{ ...base, positionKind: "cursor" }, "harness.fixture.position-kind"],
      [{ ...base, boundaryKind: "record" }, "harness.fixture.boundary-kind"],
      [{ ...base, expectedFields: [] }, "harness.fixture.expected-fields"],
      [
        { ...base, expectedFields: ["tool.name", "tool.name"] },
        "harness.fixture.expected-fields",
      ],
      [
        { ...base, exclusiveEndPosition: base.availableStartPosition },
        "harness.fixture.position-order",
      ],
      [{ ...base, sanitizedPayload: {} }, "harness.fixture.payload.bounds"],
      [
        { ...base, sanitizedPayload: { enabled: true } },
        "valid-boolean-payload",
      ],
    ];
    for (const [input, code] of invalid) {
      if (code === "valid-boolean-payload") {
        expect(parseHarnessSanitizedFixture(input).sanitizedPayload).toEqual({
          enabled: true,
        });
      } else {
        expectCode(() => parseHarnessSanitizedFixture(input), code);
      }
    }
  });
});

describe("native fixture governance metadata", () => {
  it("validates source, redaction, review, and licensing governance", () => {
    const base = fixture();
    const withProvenance = (provenance: unknown) => ({
      ...base,
      governance: { ...base.governance, provenance },
    });
    expect(
      parseHarnessSanitizedFixture(
        withProvenance({
          ...base.governance.provenance,
          captureKind: "disposable-hermetic",
          sourceReference: "https://example.invalid/vendor/artifact",
          artifactAuthority: {
            status: "authenticated",
            digest: `sha256-${"b".repeat(64)}`,
          },
        }),
      ).governance.provenance.captureKind,
    ).toBe("disposable-hermetic");
    for (const input of [
      withProvenance({ ...base.governance.provenance, captureKind: "host" }),
      withProvenance({ ...base.governance.provenance, sourceReference: 1 }),
      withProvenance({
        ...base.governance.provenance,
        sourceReference: "host-path",
      }),
      withProvenance({
        ...base.governance.provenance,
        captureKind: "disposable-hermetic",
        sourceReference: "not-a-url",
        artifactAuthority: {
          status: "authenticated",
          digest: `sha256-${"b".repeat(64)}`,
        },
      }),
      withProvenance({
        ...base.governance.provenance,
        captureKind: "disposable-hermetic",
        sourceReference: "http://example.invalid/artifact",
        artifactAuthority: {
          status: "authenticated",
          digest: `sha256-${"b".repeat(64)}`,
        },
      }),
    ]) {
      expect(() => parseHarnessSanitizedFixture(input)).toThrow(
        NativeFixtureGovernanceError,
      );
    }
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...base,
          governance: {
            ...base.governance,
            license: { ...base.governance.license, redistribution: "unknown" },
          },
        }),
      "harness.fixture.governance.disposition",
    );
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...base,
          governance: {
            ...base.governance,
            redaction: {
              ...base.governance.redaction,
              removedCategories: ["credentials"],
            },
          },
        }),
      "harness.fixture.redaction.categories",
    );
  });
});

describe("native fixture admission provenance", () => {
  it("keeps unresolved synthetic fixtures out of admission", () => {
    const synthetic = fixture();
    expectCode(
      () => assertNativeFixtureAdmissionProvenance(synthetic),
      "harness.fixture.provenance.admission-unresolved",
    );
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...synthetic,
          governance: {
            ...synthetic.governance,
            provenance: {
              ...synthetic.governance.provenance,
              artifactAuthority: {
                status: "authenticated",
                digest: `sha256-${"c".repeat(64)}`,
              },
            },
          },
        }),
      "harness.fixture.provenance.artifact-authority",
    );
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...synthetic,
          governance: {
            ...synthetic.governance,
            provenance: {
              ...synthetic.governance.provenance,
              captureKind: "disposable-hermetic",
              sourceReference: "https://example.invalid/vendor/artifact",
              artifactAuthority: {
                status: "unknown",
                digest: `sha256-${"c".repeat(64)}`,
              },
            },
          },
        }),
      "harness.fixture.provenance.artifact-authority",
    );
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...synthetic,
          governance: {
            ...synthetic.governance,
            provenance: {
              ...synthetic.governance.provenance,
              artifactAuthority: {
                status: "unresolved",
                reason: "placeholder-hash",
              },
            },
          },
        }),
      "harness.fixture.provenance.artifact-authority",
    );
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...synthetic,
          governance: {
            ...synthetic.governance,
            provenance: {
              ...synthetic.governance.provenance,
              captureKind: "disposable-hermetic",
              sourceReference: "https://example.invalid/vendor/artifact",
            },
          },
        }),
      "harness.fixture.provenance.artifact-authority",
    );
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...synthetic,
          governance: {
            ...synthetic.governance,
            provenance: {
              ...synthetic.governance.provenance,
              captureKind: "disposable-hermetic",
              sourceReference: "https://example.invalid/vendor/artifact",
              artifactAuthority: {
                status: "authenticated",
                digest: "locally-computed",
              },
            },
          },
        }),
      "harness.fixture.provenance.artifact-digest",
    );

    const authenticated = parseHarnessSanitizedFixture({
      ...synthetic,
      governance: {
        ...synthetic.governance,
        provenance: {
          ...synthetic.governance.provenance,
          captureKind: "disposable-hermetic",
          sourceReference: "https://example.invalid/vendor/artifact",
          artifactAuthority: {
            status: "authenticated",
            digest: `sha256-${"d".repeat(64)}`,
          },
        },
      },
    });
    expect(assertNativeFixtureAdmissionProvenance(authenticated)).toEqual({
      captureKind: "disposable-hermetic",
      sourceReference: "https://example.invalid/vendor/artifact",
      sourceArtifactDigest: `sha256-${"d".repeat(64)}`,
    });
  });
});

describe("native fixture inventory scanner", () => {
  it("accepts canonical path-linked fixture files", async () => {
    const root = await writeInventoryFixture();
    const inventory = await auditNativeFixtureInventory(root);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      harnessId: "codex",
      fixtureId: "codex-session-v1",
      harnessVersion: "1.2.3",
      relativePath: "codex/fixtures/native/codex-session-v1.json",
      artifactAuthority: "unresolved",
    });
    expect(inventory[0]?.sha256).toMatch(/^sha256-[a-f0-9]{64}$/u);
  });

  it("rejects raw-byte secrets before parsing", async () => {
    const text = serializeHarnessSanitizedFixture(fixture()).replace(
      '"synthetic-model"',
      '"Bearer synthetic-credential"',
    );
    const root = await writeInventoryFixture(text);
    await expect(auditNativeFixtureInventory(root)).rejects.toThrow(
      "harness.fixture.inventory.content",
    );
  });

  it("rejects path mismatch and noncanonical duplicate-key JSON", async () => {
    const mismatched = await writeInventoryFixture(
      fixture(),
      "claude-code",
      "codex-session-v1.json",
    );
    await expect(auditNativeFixtureInventory(mismatched)).rejects.toThrow(
      "harness.fixture.inventory.path-link",
    );

    const canonical = serializeHarnessSanitizedFixture(fixture());
    const duplicate = canonical.replace(
      '"fixtureVersion": 1,',
      '"fixtureVersion": 1,\n  "fixtureVersion": 1,',
    );
    const duplicated = await writeInventoryFixture(duplicate);
    await expect(auditNativeFixtureInventory(duplicated)).rejects.toThrow(
      "harness.fixture.inventory.canonical-json",
    );
  });

  it("rejects malformed, unexpected, and oversized inventory entries", async () => {
    const malformed = await writeInventoryFixture("{not-json");
    await expect(auditNativeFixtureInventory(malformed)).rejects.toThrow(
      "harness.fixture.inventory.json",
    );

    const unexpectedRoot = await mkdtemp(
      join(tmpdir(), "agentscope-native-fixtures-"),
    );
    roots.push(unexpectedRoot);
    const nativeRoot = join(unexpectedRoot, "codex", "fixtures", "native");
    await mkdir(nativeRoot, { recursive: true });
    await writeFile(join(nativeRoot, "unexpected.txt"), "synthetic");
    await expect(auditNativeFixtureInventory(unexpectedRoot)).rejects.toThrow(
      "harness.fixture.inventory.entry-kind",
    );

    const oversizedRoot = await mkdtemp(
      join(tmpdir(), "agentscope-native-fixtures-"),
    );
    roots.push(oversizedRoot);
    const oversizedNative = join(oversizedRoot, "codex", "fixtures", "native");
    await mkdir(oversizedNative, { recursive: true });
    await writeFile(
      join(oversizedNative, "oversized.json"),
      "x".repeat(65_537),
    );
    await expect(auditNativeFixtureInventory(oversizedRoot)).rejects.toThrow(
      "harness.fixture.inventory.file",
    );
  });

  it("surfaces non-absence inventory filesystem failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentscope-native-fixtures-"));
    roots.push(root);
    await mkdir(join(root, "codex"));
    await writeFile(join(root, "codex", "fixtures"), "synthetic");
    await expect(auditNativeFixtureInventory(root)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("returns a stable sorted inventory", async () => {
    const first = fixture();
    const root = await writeInventoryFixture(first);
    const second = {
      ...first,
      fixtureId: "codex-session-v2",
      governance: {
        ...first.governance,
        provenance: {
          ...first.governance.provenance,
          sourceReference: "urn:agentscope:synthetic:codex-session-v2",
        },
      },
    } as const;
    await writeFile(
      join(root, "codex", "fixtures", "native", "codex-session-v2.json"),
      serializeHarnessSanitizedFixture(second),
    );
    const inventory = await auditNativeFixtureInventory(root);
    expect(inventory.map(({ fixtureId }) => fixtureId)).toEqual([
      "codex-session-v1",
      "codex-session-v2",
    ]);
  });

  it("audits the checked-in inventory without requiring future adapters", async () => {
    const harnessPackagesRoot = resolve(import.meta.dirname, "../..");
    await expect(
      auditNativeFixtureInventory(harnessPackagesRoot),
    ).resolves.toEqual([]);
  });
});
