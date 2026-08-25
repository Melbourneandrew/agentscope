import {
  appendFile,
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  auditNativeFixtureInventory,
  NativeFixtureGovernanceError,
  parseHarnessSanitizedFixture,
  serializeHarnessSanitizedFixture,
  type HarnessSanitizedFixture,
} from "./native-fixture-governance.js";

const roots: string[] = [];
const physicalTemporaryRoot = realpathSync(tmpdir());

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
      reviewedLicenseId: "Apache-2.0",
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

const retainedStringCandidates = (): readonly [unknown, string][] => {
  const token = `github_pat_${"a".repeat(30)}`;
  const base = fixture();
  return [
    [{ ...base, nativeIdentity: token }, "harness.fixture.native-identity"],
    [{ ...base, boundaryId: token }, "harness.fixture.boundary-id"],
    [{ ...base, expectedFields: [token] }, "harness.fixture.expected-fields"],
    [
      { ...base, sanitizedPayload: { [token]: true } },
      "harness.fixture.payload.key",
    ],
    [
      {
        ...base,
        governance: {
          ...base.governance,
          provenance: {
            ...base.governance.provenance,
            sourceReference: `urn:agentscope:synthetic:${token}`,
          },
        },
      },
      "harness.fixture.provenance.source-reference",
    ],
    [
      {
        ...base,
        governance: {
          ...base.governance,
          review: {
            ...base.governance.review,
            references: [token, "review:two"],
          },
        },
      },
      "harness.fixture.review.references",
    ],
  ];
};

const writeInventoryFixture = async (
  value: unknown = fixture(),
  harnessId = "codex",
  fileName = "codex-session-v1.json",
): Promise<string> => {
  const root = await mkdtemp(
    join(physicalTemporaryRoot, "agentscope-native-fixtures-"),
  );
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

describe("native fixture privacy and array boundaries", () => {
  it.each([
    `github_pat_${"a".repeat(30)}`,
    `glpat-${"a".repeat(30)}`,
    `npm_${"a".repeat(30)}`,
  ])("rejects governed baseline token shape %s", (token) => {
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...fixture(),
          sanitizedPayload: { model: token },
        }),
      "harness.fixture.payload.value",
    );
  });

  it("scans every retained free-string category with the baseline", () => {
    for (const [candidate, code] of retainedStringCandidates())
      expectCode(() => parseHarnessSanitizedFixture(candidate), code);
  });

  it("rejects sparse, accessor, symbol, and custom-prototype arrays", () => {
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...fixture(),
          expectedFields: "not-an-array",
        }),
      "harness.fixture.expected-fields",
    );
    const sparse = Array(2) as string[];
    sparse[1] = "tool.name";
    expectCode(
      () =>
        parseHarnessSanitizedFixture({ ...fixture(), expectedFields: sparse }),
      "harness.fixture.expected-fields",
    );

    let getterCalls = 0;
    const accessor = ["llm.model_name", "tool.name"];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "llm.model_name";
      },
    });
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...fixture(),
          expectedFields: accessor,
        }),
      "harness.fixture.expected-fields",
    );
    expect(getterCalls).toBe(0);

    const symbolic = ["llm.model_name", "tool.name"];
    Object.defineProperty(symbolic, Symbol("synthetic"), { value: true });
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...fixture(),
          expectedFields: symbolic,
        }),
      "harness.fixture.expected-fields",
    );

    const custom = ["llm.model_name", "tool.name"];
    Object.setPrototypeOf(custom, Object.create(Array.prototype) as object);
    expectCode(
      () =>
        parseHarnessSanitizedFixture({ ...fixture(), expectedFields: custom }),
      "harness.fixture.expected-fields",
    );

    const throwing = new Proxy(["llm.model_name"], {
      ownKeys: () => {
        throw new Error("synthetic array proxy failure");
      },
    });
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...fixture(),
          expectedFields: throwing,
        }),
      "harness.fixture.expected-fields",
    );
  });
});

describe("native fixture governance array boundaries", () => {
  it("applies the dense-array boundary to review and redaction metadata", () => {
    const base = fixture();
    const sparseReferences = Array(2) as string[];
    sparseReferences[1] = "review:two";
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...base,
          governance: {
            ...base.governance,
            review: { ...base.governance.review, references: sparseReferences },
          },
        }),
      "harness.fixture.review.references",
    );
    const removed = [...base.governance.redaction.removedCategories];
    Object.defineProperty(removed, "0", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute");
      },
    });
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...base,
          governance: {
            ...base.governance,
            redaction: {
              ...base.governance.redaction,
              removedCategories: removed,
            },
          },
        }),
      "harness.fixture.redaction.categories",
    );
    expectCode(
      () =>
        parseHarnessSanitizedFixture({
          ...base,
          governance: {
            ...base.governance,
            redaction: {
              ...base.governance.redaction,
              removedCategories: [
                "credentials",
                "raw-transcript",
                "terminal-output",
                "user-content",
                "wrong-category",
              ],
            },
          },
        }),
      "harness.fixture.redaction.categories",
    );
    for (const references of [
      ["review:one", "review:one"],
      ["review:one", 2],
    ]) {
      expectCode(
        () =>
          parseHarnessSanitizedFixture({
            ...base,
            governance: {
              ...base.governance,
              review: { ...base.governance.review, references },
            },
          }),
        "harness.fixture.review.references",
      );
    }
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

describe("native fixture reviewed license governance", () => {
  it("accepts one reviewed identifier and rejects compound expressions", () => {
    const base = fixture();
    for (const reviewedLicenseId of [
      "MIT",
      "Apache-2.0",
      "LicenseRef-Agentscope-Synthetic",
    ]) {
      expect(
        parseHarnessSanitizedFixture({
          ...base,
          governance: {
            ...base.governance,
            license: { ...base.governance.license, reviewedLicenseId },
          },
        }).governance.license.reviewedLicenseId,
      ).toBe(reviewedLicenseId);
    }
    for (const reviewedLicenseId of [
      "MIT OR Apache-2.0",
      "MIT AND Apache-2.0",
      "GPL-2.0-only WITH Classpath-exception-2.0",
      "MIT OR",
      "(MIT",
      "",
      "x".repeat(65),
    ]) {
      expectCode(
        () =>
          parseHarnessSanitizedFixture({
            ...base,
            governance: {
              ...base.governance,
              license: {
                ...base.governance.license,
                reviewedLicenseId,
              },
            },
          }),
        "harness.fixture.license.reviewed-id",
      );
    }
  });
});

describe("native fixture provenance separation", () => {
  it("keeps synthetic authority unresolved and capture-kind bound", () => {
    const synthetic = fixture();
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

  it.each([
    `github_pat_${"a".repeat(30)}`,
    `glpat-${"a".repeat(30)}`,
    `npm_${"a".repeat(30)}`,
  ])("rejects raw governed token shape %s", async (token) => {
    const text = serializeHarnessSanitizedFixture(fixture()).replace(
      '"synthetic-model"',
      `"${token}"`,
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
      join(physicalTemporaryRoot, "agentscope-native-fixtures-"),
    );
    roots.push(unexpectedRoot);
    const nativeRoot = join(unexpectedRoot, "codex", "fixtures", "native");
    await mkdir(nativeRoot, { recursive: true });
    await writeFile(join(nativeRoot, "unexpected.txt"), "synthetic");
    await expect(auditNativeFixtureInventory(unexpectedRoot)).rejects.toThrow(
      "harness.fixture.inventory.entry-kind",
    );

    const oversizedRoot = await mkdtemp(
      join(physicalTemporaryRoot, "agentscope-native-fixtures-"),
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
    const root = await mkdtemp(
      join(physicalTemporaryRoot, "agentscope-native-fixtures-"),
    );
    roots.push(root);
    await mkdir(join(root, "codex"));
    await writeFile(join(root, "codex", "fixtures"), "synthetic");
    await expect(auditNativeFixtureInventory(root)).rejects.toThrow(
      "harness.fixture.inventory.ancestor",
    );
    await expect(
      auditNativeFixtureInventory(join(root, "missing-root")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("native fixture inventory identity and ordering", () => {
  it("rejects symlinked inventory roots, ancestors, and fixture files", async () => {
    const target = await writeInventoryFixture();
    const linkRoot = `${target}-link`;
    roots.push(linkRoot);
    await symlink(target, linkRoot, "dir");
    await expect(auditNativeFixtureInventory(linkRoot)).rejects.toThrow(
      "harness.fixture.inventory.ancestor",
    );

    const packageRoot = await mkdtemp(
      join(physicalTemporaryRoot, "agentscope-native-fixtures-"),
    );
    roots.push(packageRoot);
    await symlink(join(target, "codex"), join(packageRoot, "codex"), "dir");
    await expect(auditNativeFixtureInventory(packageRoot)).rejects.toThrow(
      "harness.fixture.inventory.entry-kind",
    );

    for (const ancestor of ["fixtures", "native"] as const) {
      const root = await mkdtemp(
        join(physicalTemporaryRoot, "agentscope-native-fixtures-"),
      );
      roots.push(root);
      const packageDirectory = join(root, "codex");
      await mkdir(packageDirectory);
      if (ancestor === "fixtures") {
        await symlink(
          join(target, "codex", "fixtures"),
          join(packageDirectory, "fixtures"),
          "dir",
        );
      } else {
        const fixturesDirectory = join(packageDirectory, "fixtures");
        await mkdir(fixturesDirectory);
        await symlink(
          join(target, "codex", "fixtures", "native"),
          join(fixturesDirectory, "native"),
          "dir",
        );
      }
      await expect(auditNativeFixtureInventory(root)).rejects.toThrow(
        "harness.fixture.inventory.ancestor",
      );
    }

    const fileRoot = await mkdtemp(
      join(physicalTemporaryRoot, "agentscope-native-fixtures-"),
    );
    roots.push(fileRoot);
    const nativeRoot = join(fileRoot, "codex", "fixtures", "native");
    await mkdir(nativeRoot, { recursive: true });
    await symlink(
      join(target, "codex", "fixtures", "native", "codex-session-v1.json"),
      join(nativeRoot, "codex-session-v1.json"),
      "file",
    );
    await expect(auditNativeFixtureInventory(fileRoot)).rejects.toThrow(
      "harness.fixture.inventory.entry-kind",
    );
  });

  it("rejects a symlink above an otherwise real inventory root", async () => {
    const realParent = await mkdtemp(
      join(physicalTemporaryRoot, "agentscope-native-parent-"),
    );
    const linkParent = await mkdtemp(
      join(physicalTemporaryRoot, "agentscope-native-link-"),
    );
    roots.push(realParent, linkParent);
    const packagesRoot = join(realParent, "packages");
    const nativeRoot = join(packagesRoot, "codex", "fixtures", "native");
    await mkdir(nativeRoot, { recursive: true });
    await writeFile(
      join(nativeRoot, "codex-session-v1.json"),
      serializeHarnessSanitizedFixture(fixture()),
    );
    const linked = join(linkParent, "linked");
    await symlink(realParent, linked, "dir");
    await expect(
      auditNativeFixtureInventory(join(linked, "packages")),
    ).rejects.toThrow("harness.fixture.inventory.ancestor");
  });
});

describe("native fixture inventory replacement races", () => {
  it.each([
    ["remove", "harness.fixture.inventory.ancestor"],
    ["symlink", "harness.fixture.inventory.ancestor"],
  ] as const)(
    "rejects physical-root %s after resolution",
    async (kind, code) => {
      const root = await writeInventoryFixture();
      const target = await mkdtemp(
        join(physicalTemporaryRoot, "agentscope-race-target-"),
      );
      roots.push(target);
      let changed = false;
      await expect(
        auditNativeFixtureInventory(root, async (event, path) => {
          if (changed || event !== "ancestry-after-resolution") return;
          changed = true;
          await rm(path, { recursive: true });
          if (kind === "symlink") await symlink(target, path, "dir");
        }),
      ).rejects.toThrow(code);
    },
  );

  it.each(["remove", "symlink"] as const)(
    "rejects physical-root %s before ancestry recheck",
    async (kind) => {
      const root = await writeInventoryFixture();
      const target = await mkdtemp(
        join(physicalTemporaryRoot, "agentscope-race-target-"),
      );
      roots.push(target);
      let changed = false;
      await expect(
        auditNativeFixtureInventory(root, async (event, path) => {
          if (changed || event !== "ancestry-before-recheck") return;
          changed = true;
          await rm(path, { recursive: true });
          if (kind === "symlink") await symlink(target, path, "dir");
        }),
      ).rejects.toThrow("harness.fixture.inventory.ancestor-identity");
    },
  );

  it("surfaces a nonoptional directory authentication race", async () => {
    const root = await writeInventoryFixture();
    let changed = false;
    await expect(
      auditNativeFixtureInventory(root, async (event, path) => {
        if (
          changed ||
          event !== "directory-before-authentication" ||
          !path.endsWith("/codex")
        )
          return;
        changed = true;
        await rm(path, { recursive: true });
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("native fixture nested replacement races", () => {
  it.each([
    ["remove", "harness.fixture.inventory.ancestor-identity"],
    ["replace", "harness.fixture.inventory.ancestor-identity"],
  ] as const)(
    "rejects directory %s before identity recheck",
    async (kind, code) => {
      const root = await writeInventoryFixture();
      let changed = false;
      await expect(
        auditNativeFixtureInventory(root, async (event, path) => {
          if (
            changed ||
            event !== "directory-before-recheck" ||
            !path.endsWith(join("fixtures", "native"))
          )
            return;
          changed = true;
          if (kind === "remove") {
            await rm(path, { recursive: true });
            return;
          }
          await rename(path, `${path}-previous`);
          await mkdir(path);
        }),
      ).rejects.toThrow(code);
    },
  );

  it.each([
    [
      "remove-before-open",
      "file-after-path-authentication",
      "harness.fixture.inventory.file",
    ],
    [
      "replace-before-open",
      "file-after-path-authentication",
      "harness.fixture.inventory.file-identity",
    ],
    [
      "grow-after-open",
      "file-after-open-authentication",
      "harness.fixture.inventory.file",
    ],
    [
      "replace-before-recheck",
      "file-before-path-recheck",
      "harness.fixture.inventory.file-identity",
    ],
  ] as const)("rejects fixture %s", async (kind, selectedEvent, code) => {
    const root = await writeInventoryFixture();
    let changed = false;
    await expect(
      auditNativeFixtureInventory(root, async (event, path) => {
        if (changed || event !== selectedEvent) return;
        changed = true;
        if (kind === "remove-before-open") {
          await rm(path);
          return;
        }
        if (kind === "grow-after-open") {
          await appendFile(path, "x");
          return;
        }
        await rename(path, `${path}-previous`);
        await writeFile(path, serializeHarnessSanitizedFixture(fixture()));
      }),
    ).rejects.toThrow(code);
  });
});

describe("native fixture inventory ordering", () => {
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
    const claude = {
      ...first,
      fixtureId: "claude-session-v1",
      harnessId: "claude-code",
      governance: {
        ...first.governance,
        provenance: {
          ...first.governance.provenance,
          sourceReference: "urn:agentscope:synthetic:claude-session-v1",
        },
        representative: {
          ...first.governance.representative,
          scenarioId: "claude-headless-v1",
        },
      },
    } as const;
    const claudeRoot = join(root, "claude-code", "fixtures", "native");
    await mkdir(claudeRoot, { recursive: true });
    await writeFile(
      join(claudeRoot, "claude-session-v1.json"),
      serializeHarnessSanitizedFixture(claude),
    );
    const inventory = await auditNativeFixtureInventory(root);
    expect(inventory.map(({ relativePath }) => relativePath)).toEqual([
      "claude-code/fixtures/native/claude-session-v1.json",
      "codex/fixtures/native/codex-session-v1.json",
      "codex/fixtures/native/codex-session-v2.json",
    ]);
  });

  it("audits the checked-in inventory without requiring future adapters", async () => {
    const harnessPackagesRoot = resolve(import.meta.dirname, "../..");
    await expect(
      auditNativeFixtureInventory(harnessPackagesRoot),
    ).resolves.toEqual([]);
  });
});
