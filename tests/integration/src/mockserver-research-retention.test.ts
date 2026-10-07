import { performance } from "node:perf_hooks";
import { syncBuiltinESMExports } from "node:module";
import fs, {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSupervisedProcess } from "../supervisor.mjs";
import {
  retainMockServerResearch,
  verifyMockServerResearch,
  type MockServerResearchProvenance,
} from "../mockserver-material/research-retention.mjs";
import { mockServerResearchStopFitsTerminalObservation } from "./mockserver-research-request.js";
import {
  recordControllerFailureDiagnostic,
  readControllerFailureDiagnostic,
} from "./controller-failure-diagnostic.js";

const roots: string[] = [];
const stageProbe = vi.hoisted(() => ({
  primary: new Error("integration.images.cleanup"),
  cleanup: new Error("integration.images.close"),
  uncertain: false,
  closeFails: false,
  primaryFails: true,
}));
vi.mock("../dist/controller.js", () => ({
  requireDisposableOuterHostCapability: () => ({
    binding: {
      workspaceRoot: "/synthetic",
      privateStorage: {
        root: "/synthetic/private",
        authorityDigest: "sha256:" + "a".repeat(64),
      },
      dockerExecutable: "/usr/bin/docker",
      dockerEnvironment: {},
    },
  }),
  integrationStageSignal: () => new AbortController().signal,
  remainingIntegrationOperationMilliseconds: () => 300_000,
  registerIntegrationRunIds: vi.fn(),
}));
vi.mock("../dist/index.js", () => ({
  compileCapabilityManifest: () => ({
    manifestIdentity: "sha256-" + "a".repeat(64),
  }),
  verifyManifestEvidence: vi.fn(),
}));
vi.mock(
  "../dist/controller-failure-diagnostic.js",
  async () => import("./controller-failure-diagnostic.js"),
);
vi.mock("../harness-material-io.mjs", () => ({
  readMaterialSource: () => ({
    bytes: Buffer.from("{}"),
    sha256: "a".repeat(64),
  }),
}));
vi.mock("../image-preparation.mjs", () => ({
  readPreparedImageEvidence: () => ({
    dockerSocket: { path: "/synthetic/socket" },
  }),
  createPreparedDockerClient: () => ({}),
  preparedDockerClientRequiresOuterHostRetirement: () => stageProbe.uncertain,
  imagePreparationFailureRequiresOuterHostRetirement: () => false,
  closePreparedDockerClient: () => {
    if (stageProbe.closeFails) throw stageProbe.cleanup;
  },
}));
vi.mock("../mockserver-material/prepare-supplier.mjs", () => ({
  researchMockServerSupplier: () => {
    if (stageProbe.primaryFails) return Promise.reject(stageProbe.primary);
    return Promise.resolve({
      inventory: inventory(),
      bootstrapVerification: {},
    });
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const child = () =>
  runSupervisedProcess({
    arguments_: ["-e", "process.exit(3)"],
    environment: {},
    executable: process.execPath,
    maximumMilliseconds: 2_000,
    stdio: "ignore",
  });

describe("existing supervisor research terminal observations", () => {
  it("observes a normally joined synthetic exit3 without an intervention", async () => {
    const result = await child();
    expect(result).toMatchObject({
      code: 3,
      signal: null,
      contained: true,
      residualWorkObserved: false,
      terminationInitiated: false,
      completedWithinDeadline: true,
    });
    expect(mockServerResearchStopFitsTerminalObservation(result)).toBe(true);
  });

  it("rejects a late terminal observation even before the timer callback runs", async () => {
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      calls += 1;
      return calls < 5 ? 10 : 2_011;
    });
    const result = await child();
    expect(result.code).toBe(3);
    expect(result.terminationInitiated).toBe(false);
    expect(result.completedWithinDeadline).toBe(false);
    expect(mockServerResearchStopFitsTerminalObservation(result)).toBe(false);
  });
});

const hash = "a".repeat(64);
const inventory = () =>
  Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      evidenceScope: "untrusted-cache-and-jar-research-only",
      consumedDependencyClosure: "not-proved",
      caches: [
        { path: "maven-repository", type: "directory", mode: 0o700 },
        { path: "npm-cache", type: "directory", mode: 0o700 },
      ],
      artifact: {
        path: "source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar",
        type: "file",
        bytes: 1,
        mode: 0o644,
        sha256: hash,
      },
    })}\n`,
  );
const binding = (): MockServerResearchProvenance => ({
  request: {
    kind: "supplier",
    repository: "owner/repo",
    revision: "a".repeat(40),
    runId: "1234",
    attempt: "1",
    workflowRef:
      "owner/repo/.github/workflows/integration.yml@refs/heads/research",
    workflowRevision: "a".repeat(40),
  },
  sourceTree: "b".repeat(40),
  controllerAuthority: `sha256:${hash}`,
  runToken: "a".repeat(16),
  manifestIdentity: `sha256-${hash}`,
  preparedEvidenceSha256: hash,
  bootstrapVerificationSha256: hash,
  recipeSourcesSha256: hash,
});
const fixture = () => {
  const parent = realpathSync(
    mkdtempSync(resolve(tmpdir(), "agentscope-research-retention-")),
  );
  roots.push(parent);
  const started = performance.now();
  const deadline = started + 10_000;
  const provenance = binding();
  const signal = new AbortController().signal;
  return {
    parent,
    deadline,
    provenance,
    signal,
    inventory: inventory(),
    stage: {
      started,
      finished: started,
      deadline: started + 5_000,
      clientSettlement: "closed-and-registered-for-outer-retirement" as const,
    },
    verification: { parent, deadline, expectedProvenance: provenance, signal },
    path: resolve(parent, "mockserver-research"),
  };
};

describe("dedicated noncertifying research packet", () => {
  it("rechecks the original cutoff after parsing and before creating a prefix", () => {
    const input = fixture();
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() =>
      ++calls === 1 ? 10 : 20,
    );
    expect(() =>
      retainMockServerResearch({
        ...input,
        deadline: 20,
        stage: { ...input.stage, started: 0, finished: 1, deadline: 15 },
      }),
    ).toThrow("research-retention");
    expect(existsSync(input.path)).toBe(false);
  });
  it("retains inventory first and a separately verified receipt last", () => {
    const input = fixture();
    const retained = retainMockServerResearch(input);
    expect(verifyMockServerResearch(input.verification)).toEqual(retained);
    const receipt = JSON.parse(
      readFileSync(resolve(input.path, "receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      supportAdmission: "not-claimed",
      consumedDependencyClosure: "not-proved",
      cleanup: {
        disposition: "canonical-clean-complete",
        outerHostRetirement: "external-not-observed",
      },
      stage: { clientSettlement: "closed-and-registered-for-outer-retirement" },
      provenance: input.provenance,
    });
  });
  it("does not adopt or delete a prior complete packet", () => {
    const input = fixture();
    const first = retainMockServerResearch(input);
    expect(() => retainMockServerResearch(input)).toThrow();
    expect(verifyMockServerResearch(input.verification)).toEqual(first);
  });
  it("leaves an inventory-only prefix quarantined on deadline, never complete", () => {
    const input = fixture();
    const now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() =>
      existsSync(resolve(input.path, "inventory.json")) ? input.deadline : now,
    );
    expect(() => retainMockServerResearch(input)).toThrow("research-retention");
    expect(existsSync(resolve(input.path, "inventory.json"))).toBe(true);
    expect(existsSync(resolve(input.path, "receipt.json"))).toBe(false);
    vi.restoreAllMocks();
    expect(() => verifyMockServerResearch(input.verification)).toThrow();
  });
  it("fails after a late receipt commit rather than returning completed output", () => {
    const input = fixture();
    const now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() =>
      existsSync(resolve(input.path, "receipt.json")) ? input.deadline : now,
    );
    expect(() => retainMockServerResearch(input)).toThrow("research-retention");
    expect(existsSync(resolve(input.path, "receipt.json"))).toBe(true);
  });
  it("admits no directory or file after cancellation or an expired entry", () => {
    for (const cancelled of [true, false]) {
      const input = fixture();
      const abort = new AbortController();
      if (cancelled) abort.abort();
      expect(() =>
        retainMockServerResearch({
          ...input,
          signal: abort.signal,
          deadline: cancelled ? input.deadline : performance.now(),
        }),
      ).toThrow("research-retention");
      expect(existsSync(input.path)).toBe(false);
    }
  });
});

describe("research packet substitution boundary", () => {
  it("checks the independent source expectation without treating runtime observations as external authority", () => {
    const input = fixture();
    const result = retainMockServerResearch(input);
    const { request, sourceTree, manifestIdentity, recipeSourcesSha256 } =
      input.provenance;
    const expectedSource = {
      request,
      sourceTree,
      manifestIdentity,
      recipeSourcesSha256,
    };
    const verification = {
      parent: input.parent,
      deadline: input.deadline,
      signal: input.signal,
      expectedSource,
    };
    expect(verifyMockServerResearch(verification)).toEqual(result);
    const extraSource = { ...expectedSource, extra: true };
    expect(() =>
      verifyMockServerResearch({
        ...verification,
        expectedSource: { ...expectedSource, sourceTree: "c".repeat(40) },
      }),
    ).toThrow("research-retention");
    expect(() =>
      verifyMockServerResearch({
        ...verification,
        expectedSource: extraSource,
      }),
    ).toThrow("research-retention");
  });
  it.each([
    "extra",
    "missing",
    "symlink",
    "hardlink",
    "mode",
    "content",
    "replaced-root",
    "oversize",
  ])("rejects %s filesystem evidence", (attack) => {
    const input = fixture();
    retainMockServerResearch(input);
    const target = resolve(input.path, "inventory.json");
    if (attack === "extra") writeFileSync(resolve(input.path, "extra"), "no");
    if (attack === "missing") rmSync(target);
    if (attack === "symlink") {
      renameSync(target, resolve(input.parent, "saved"));
      symlinkSync(resolve(input.parent, "saved"), target);
    }
    if (attack === "hardlink") linkSync(target, resolve(input.parent, "alias"));
    if (attack === "mode") chmodSync(target, 0o644);
    if (attack === "content")
      writeFileSync(
        target,
        inventory().toString().replace(hash, "b".repeat(64)),
      );
    if (attack === "replaced-root") {
      renameSync(input.path, resolve(input.parent, "original"));
      symlinkSync(resolve(input.parent, "original"), input.path);
    }
    if (attack === "oversize")
      writeFileSync(target, Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(() => verifyMockServerResearch(input.verification)).toThrow();
  });
  it.each(["runId", "attempt", "revision"])(
    "rejects a mixed %s provenance",
    (field) => {
      const input = fixture();
      retainMockServerResearch(input);
      const changed = binding();
      const request = {
        ...changed.request,
        [field]: field === "revision" ? "b".repeat(40) : "2",
      };
      expect(() =>
        verifyMockServerResearch({
          ...input.verification,
          expectedProvenance: { ...changed, request },
        }),
      ).toThrow("research-retention");
    },
  );
  it("rejects source/recipe substitutions and alternative receipt encodings", () => {
    const input = fixture();
    retainMockServerResearch(input);
    expect(() =>
      verifyMockServerResearch({
        ...input.verification,
        expectedProvenance: {
          ...binding(),
          recipeSourcesSha256: "b".repeat(64),
        },
      }),
    ).toThrow("research-retention");
    const target = resolve(input.path, "receipt.json");
    const original = readFileSync(target, "utf8");
    writeFileSync(target, ` ${original}`);
    expect(() => verifyMockServerResearch(input.verification)).toThrow(
      "research-retention",
    );
  });
});

describe("hostile research provenance", () => {
  it.each([
    "runId",
    "attempt",
    "revision",
    "repository",
    "sourceTree",
    "runToken",
    "controllerAuthority",
  ])("rejects coercible %s values", (field) => {
    for (const value of [1234, ["1234"]]) {
      const input = fixture();
      const target = Object.hasOwn(input.provenance.request, field)
        ? input.provenance.request
        : input.provenance;
      Reflect.set(target, field, value);
      expect(() => retainMockServerResearch(input)).toThrow(
        "research-retention",
      );
      expect(existsSync(input.path)).toBe(false);
    }
  });
  it("rejects hostile provenance accessors and proxies without invoking hooks", () => {
    const input = fixture();
    const trap = vi.fn(() => {
      throw new Error("untrusted hook");
    });
    const getter = binding();
    Object.defineProperty(getter, "sourceTree", {
      get: trap,
      enumerable: true,
    });
    const proxy = new Proxy(binding(), { ownKeys: trap });
    for (const provenance of [getter, proxy])
      expect(() => retainMockServerResearch({ ...input, provenance })).toThrow(
        "research-retention",
      );
    expect(trap).not.toHaveBeenCalled();
    expect(existsSync(input.path)).toBe(false);
  });
});

describe("research stage unsettled diagnostic identity", () => {
  it.each(["uncertain", "both-fail", "close-only"])(
    "preserves %s primary/cleanup identity using the existing brand",
    async (mode) => {
      stageProbe.uncertain = mode === "uncertain";
      stageProbe.closeFails = mode !== "uncertain";
      stageProbe.primaryFails = mode !== "close-only";
      const { runMockServerResearchStage } =
        await import("../mockserver-material/research-stage.mjs");
      let observed: Error | undefined;
      try {
        await runMockServerResearchStage({
          request: binding().request,
          sourceTree: "a".repeat(40),
        });
      } catch (error) {
        observed = error as Error;
      }
      expect(observed?.message).toBe(
        "integration.controller.unsettled-operation",
      );
      expect(observed?.cause).toBe(
        mode === "close-only" ? stageProbe.cleanup : stageProbe.primary,
      );
      if (mode === "both-fail")
        expect(
          Object.getOwnPropertyDescriptor(observed!, "cleanupCause")?.value,
        ).toBe(stageProbe.cleanup);
      const wrapper = new Error("wrapper");
      recordControllerFailureDiagnostic(wrapper, {
        primaryCause: observed,
        retirementRequired: true,
        cleanupAttempted: false,
        stage: "prepareModelRoutes",
      });
      expect(readControllerFailureDiagnostic(wrapper)).toMatchObject({
        kind: "operation-grace-unsettled",
        cleanup: "not-attempted",
        stage: "prepareModelRoutes",
      });
    },
  );
  it("enumerates no more than the first excess entry and closes the actual directory handle", () => {
    const input = fixture();
    retainMockServerResearch(input);
    for (let index = 0; index < 20; index++)
      writeFileSync(resolve(input.path, "extra-" + index), "x");
    const real = fs.opendirSync;
    let reads = 0;
    let closes = 0;
    vi.spyOn(fs, "opendirSync").mockImplementation((path, options) => {
      const handle = real(path, options);
      const read = handle.readSync.bind(handle);
      const close = handle.closeSync.bind(handle);
      handle.readSync = () => {
        reads++;
        return read();
      };
      handle.closeSync = () => {
        closes++;
        close();
      };
      return handle;
    });
    syncBuiltinESMExports();
    expect(() => verifyMockServerResearch(input.verification)).toThrow(
      "research-retention",
    );
    expect(reads).toBe(3);
    expect(closes).toBe(1);
  });
});
