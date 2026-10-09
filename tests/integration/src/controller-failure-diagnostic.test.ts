import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { imagePreparationFailureRequiresOuterHostRetirement } from "../image-preparation.mjs";
import {
  createPullOperation,
  prepareImageOperation,
  readImagePreparationDiagnostic,
  recordUnexpectedEngineStatus,
} from "../image-preparation/preparation.mjs";
import {
  formatControllerFailureDiagnostic,
  readControllerFailureDiagnostic,
} from "./controller-failure-diagnostic.js";
import {
  IntegrationControllerFailure,
  runIntegrationStages,
  settleAbortableOperation,
} from "./controller.js";
import type { IntegrationStageDependencies } from "./controller.js";
import { SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES } from "./substrate-certification.js";
// @ts-expect-error private transport diagnostic has no public declaration
import * as requestDiagnosticModule from "../image-preparation/boundary.mjs";
const { readImageRequestDiagnostic, recordImageRequestDiagnostic } =
  requestDiagnosticModule as {
    readImageRequestDiagnostic: (error: unknown) => unknown;
    recordImageRequestDiagnostic: <ErrorType>(
      error: ErrorType,
      phase: string,
      outcome: string,
      status?: number,
    ) => ErrorType;
  };

const storage = {
  cleanupFails: false,
  cleanups: 0,
  created: 0,
  cleanupDeadlines: [] as number[],
};
const storageDependencies = {
  createPrivateClientRoot: () => {
    storage.created += 1;
    return { root: "/synthetic-private-root" };
  },
  cleanupPrivateClient: (_owned: unknown, deadline: number) => {
    storage.cleanups += 1;
    storage.cleanupDeadlines.push(deadline);
    if (storage.cleanupFails) throw new Error("SYNTHETIC-PRIVATE-CONTENT");
  },
};
beforeEach(() => {
  storage.cleanupFails = false;
  storage.cleanups = 0;
  storage.created = 0;
  storage.cleanupDeadlines = [];
});

const image = `registry.invalid/example@sha256:${"a".repeat(64)}`;
const policy = { workDeadline: 100, reconciliationDeadline: 200 };
const pullInput = {
  daemon: { apiVersion: "1.45" },
  image,
  platform: { os: "linux", architecture: "amd64" },
  policy,
  transport: undefined,
};
const syntheticPull = async (trigger: string, reconciliationFails = false) => {
  const inspectLocalImage = vi.fn(() => {
    if (reconciliationFails)
      return Promise.reject(new Error("SYNTHETIC-RECONCILIATION-CONTENT"));
    return Promise.resolve();
  });
  const engineCall = vi.fn(() => {
    if (trigger === "transport")
      return Promise.reject(new Error("integration.images.transport"));
    if (trigger === "timeout")
      return Promise.reject(
        Object.assign(new Error("integration.images.timeout"), {
          code: "ETIMEDOUT",
        }),
      );
    if (trigger === "abort")
      return Promise.reject(new Error("integration.images.interrupted"));
    if (trigger === "unexpected-status")
      return Promise.reject(
        recordUnexpectedEngineStatus(new Error("integration.images.daemon")),
      );
    if (trigger === "unknown")
      return Promise.reject(new Error("SYNTHETIC-VENDOR-CONTENT"));
    const body =
      trigger === "empty-events"
        ? "\n"
        : trigger === "malformed-event"
          ? "{SYNTHETIC-CONTENT"
          : trigger === "daemon-error-event"
            ? '{"error":"SYNTHETIC-VENDOR-CONTENT"}'
            : '{"status":"complete"}';
    return Promise.resolve({ body: Buffer.from(body) });
  });
  const pull = createPullOperation({
    engineCall,
    inspectLocalImage,
    platformText: () => "linux/amd64",
  });
  let failure: unknown;
  try {
    await pull(pullInput);
  } catch (error) {
    failure = error;
  }
  return { failure, engineCall, inspectLocalImage };
};

const controllerCodes = (primaryCause: unknown, cleanupCause?: unknown) => {
  const failure = new IntegrationControllerFailure({
    primaryCause,
    cleanupCause,
    retirementRequired: false,
    stage: "runScenarios",
  });
  return readControllerFailureDiagnostic(failure).firstCodes;
};
describe("closed certification failure codes", () => {
  it.each(Object.values(SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES))(
    "projects only the existing exact certification code %s",
    (primary) => {
      expect(controllerCodes(new Error(primary))).toEqual({
        primary,
        causal: "unknown",
        cleanup: "unknown",
      });
      expect(
        controllerCodes(
          new Error("integration.controller.unsettled-operation", {
            cause: new Error(primary),
          }),
          new Error(primary),
        ),
      ).toEqual({
        primary: "integration.controller.unsettled-operation",
        causal: primary,
        cleanup: primary,
      });
      for (const value of [
        `${primary}.PRIVATE`,
        `${primary}\nPRIVATE`,
        "integration.certification.unlisted",
      ])
        expect(controllerCodes(new Error(value))).toBeUndefined();
      expect(controllerCodes({ message: primary })).toBeUndefined();
      expect(
        controllerCodes(
          new Error("UNKNOWN", {
            cause: new Error(primary),
          }),
        ),
      ).toBeUndefined();
    },
  );

  it("does not read substituted certification messages through accessors or proxies", () => {
    const primary = SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES["leaked-child"];
    let reads = 0;
    const accessor = new Error(primary);
    Object.defineProperty(accessor, "message", {
      get: () => {
        reads += 1;
        return primary;
      },
    });
    const proxy = new Proxy(new Error(primary), {
      get: () => {
        reads += 1;
        return primary;
      },
    });
    expect(controllerCodes(accessor)).toBeUndefined();
    expect(controllerCodes(proxy)).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe("closed first controller failure codes", () => {
  it.each([
    "integration.harness-scenario-admission.invalid",
    "integration.harness-admission.invalid",
  ])("retains only the fixed direct admission code %s", (primary) => {
    expect(
      controllerCodes(
        new Error(primary, {
          cause: new Error("integration.images.transport"),
        }),
      ),
    ).toEqual({
      primary,
      causal: "unknown",
      cleanup: "unknown",
    });
    expect(controllerCodes(new Error(`${primary}.PRIVATE`))).toBeUndefined();
  });
  it.each([
    "preflight",
    "validate-package",
    "validate-descriptors",
    "download-key",
    "download-manifest",
    "download-signature",
    "download-platform-package",
    "integrity",
    "download-binary",
    "download-tarball",
    "download-attestation",
    "compile-audit",
    "verify",
    "verify-context",
    "verify-build",
    "verify-build-input",
    "verify-build-context",
    "verify-build-authority",
    "verify-build-preflight",
    "verify-build-create",
    "verify-build-bootstrap",
    "verify-build-image-build",
    "verify-build-containment",
    "verify-build-timeout",
    "verify-retire",
    "compile-authority",
    "publish",
  ])(
    "retains one actual material envelope phase %s without inspecting deeper causes",
    (phase) => {
      const cause = new Error(`integration.harness-material.${phase}`, {
        cause: new Error("PRIVATE_DEEP_CAUSE"),
      });
      const primary = new Error("integration.harness-material.failed", {
        cause,
      });
      expect(
        controllerCodes(
          primary,
          new Error("integration.isolation.cleanup-inventory"),
        ),
      ).toEqual({
        primary: "integration.harness-material.failed",
        causal: `integration.harness-material.${phase}`,
        cleanup: "integration.isolation.cleanup-inventory",
      });
    },
  );
  it("retains one known controller envelope and first cleanup code", () => {
    const primary = new Error("integration.controller.unsettled-operation", {
      cause: new Error("integration.isolation.mockserver-terminal"),
    });
    expect(
      controllerCodes(
        primary,
        new Error("integration.isolation.cleanup-network-remove"),
      ),
    ).toEqual({
      primary: "integration.controller.unsettled-operation",
      causal: "integration.isolation.mockserver-terminal",
      cleanup: "integration.isolation.cleanup-network-remove",
    });
  });
  it("does not unwrap an arbitrary envelope or walk past a known envelope", () => {
    const known = new Error("integration.images.transport");
    expect(
      controllerCodes(new Error("PRIVATE", { cause: known })),
    ).toBeUndefined();
    expect(
      controllerCodes(
        new Error("integration.harness-material.failed", {
          cause: new Error("PRIVATE", { cause: known }),
        }),
      ),
    ).toEqual({
      primary: "integration.harness-material.failed",
      causal: "unknown",
      cleanup: "unknown",
    });
    expect(
      controllerCodes(
        new Error("integration.isolation.context", { cause: known }),
      ),
    ).toEqual({
      primary: "integration.isolation.context",
      causal: "unknown",
      cleanup: "unknown",
    });
  });
});
describe("closed controller code hostile inputs", () => {
  it("rejects nonallowlisted suffixes, plain values, accessors and proxies without traps", () => {
    let traps = 0;
    const getter = () => {
      traps++;
      throw new Error("PRIVATE");
    };
    const messageAccessor = Object.defineProperty(new Error(), "message", {
      get: getter,
    });
    const proxy = new Proxy(new Error("integration.images.transport"), {
      get: getter,
      getOwnPropertyDescriptor: getter,
    });
    for (const value of [
      messageAccessor,
      proxy,
      { message: "integration.images.transport" },
      new Error(
        "integration.harness-material.download-attestation-root-upstream",
      ),
      new Error(
        "integration.harness-material.verify-build-image-build.PRIVATE",
      ),
      new Error("integration.harness-material.verify-build-unknown"),
      new Error("integration.isolation.context" + "PRIVATE".repeat(100)),
    ])
      expect(controllerCodes(value)).toBeUndefined();
    const primary = Object.defineProperty(
      new Error("integration.harness-material.failed"),
      "cause",
      { get: getter },
    );
    expect(controllerCodes(primary)).toEqual({
      primary: "integration.harness-material.failed",
      causal: "unknown",
      cleanup: "unknown",
    });
    expect(traps).toBe(0);
  });
});

describe("content-free image preparation request hints", () => {
  it("keeps an observed pull request failure uncertain even after successful reconciliation", async () => {
    const primary = recordImageRequestDiagnostic(
      new Error("integration.images.transport"),
      "image-pull",
      "request-error",
    );
    const inspectLocalImage = vi.fn(() => Promise.resolve());
    const pull = createPullOperation({
      engineCall: () => Promise.reject(primary),
      inspectLocalImage,
      platformText: () => "linux/amd64",
    });
    const failure = await pull(pullInput).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "integration.images.daemon-uncertain",
    });
    expect(inspectLocalImage).toHaveBeenCalledOnce();
    expect(readImagePreparationDiagnostic(failure)).toEqual({
      primary: "pull-outcome-unknown",
      cleanup: "none",
      trigger: "transport",
      reconciliation: "completed",
      request: { phase: "image-pull", outcome: "request-error" },
    });
    expect(imagePreparationFailureRequiresOuterHostRetirement(failure)).toBe(
      true,
    );
  });
  it.each([false, true])(
    "retains the first observed request hint through preparation cleanup failure=%s and the controller envelope",
    async (cleanupFails) => {
      storage.cleanupFails = cleanupFails;
      const primary = new Error("integration.images.transport");
      recordImageRequestDiagnostic(
        primary,
        "registry-auth",
        "unexpected-status",
        503,
      );
      recordImageRequestDiagnostic(
        primary,
        "daemon-info",
        "request-error",
        401,
      );
      let failure: unknown;
      try {
        await prepareImageOperation(
          { admitPreparedSet: () => undefined },
          {
            ...storageDependencies,
            engineTransport: () => undefined,
            prepareImageSet: () => Promise.reject(primary),
          },
          [image],
          {
            socketIdentityForTesting: {
              path: "/synthetic.sock",
              device: "1",
              inode: "2",
              mode: "3",
              owner: "4",
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      if (cleanupFails)
        expect(failure).toMatchObject({
          message: "integration.images.cleanup",
        });
      else expect(failure).toBe(primary);
      expect(storage.cleanups).toBe(1);
      const expected = {
        phase: "registry-auth",
        outcome: "unexpected-status",
        status: 503,
      };
      expect(readImagePreparationDiagnostic(failure)?.request).toEqual(
        expected,
      );
      const wrapped = new IntegrationControllerFailure({
        primaryCause: new Error("integration.images.transport", {
          cause: failure,
        }),
        retirementRequired: true,
        stage: "prepareImages",
      });
      expect(
        readControllerFailureDiagnostic(wrapped).imagePreparation?.request,
      ).toEqual(expected);
    },
  );
  it("keeps invalid phases/outcomes and absent status unknown without property inspection", () => {
    const failure = Object.defineProperty(new Error("PRIVATE"), "code", {
      get: () => {
        throw new Error("must-not-read");
      },
    });
    expect(
      recordImageRequestDiagnostic(
        failure,
        "https://PRIVATE",
        "request-error",
        503,
      ),
    ).toBe(failure);
    recordImageRequestDiagnostic(failure, "daemon-info", "PRIVATE", 503);
    expect(readImageRequestDiagnostic(failure)).toBeUndefined();
    recordImageRequestDiagnostic(failure, "daemon-info", "request-error", 0);
    expect(readImageRequestDiagnostic(failure)).toEqual({
      phase: "daemon-info",
      outcome: "request-error",
    });
    expect(readImagePreparationDiagnostic(failure)).toBeUndefined();
    expect(formatControllerFailureDiagnostic(failure)).not.toContain("PRIVATE");
  });
});
describe("content-free image preparation diagnostics", () => {
  it.each([
    "transport",
    "timeout",
    "abort",
    "unexpected-status",
    "empty-events",
    "malformed-event",
    "daemon-error-event",
    "unknown",
  ])(
    "retains %s without converting reconciliation into success",
    async (trigger) => {
      for (const reconciliationFails of [false, true]) {
        const { failure, inspectLocalImage } = await syntheticPull(
          trigger,
          reconciliationFails,
        );
        expect(failure).toMatchObject({
          message:
            trigger === "abort"
              ? "integration.images.interrupted-uncertain"
              : "integration.images.daemon-uncertain",
        });
        expect(readImagePreparationDiagnostic(failure)).toEqual({
          primary: "pull-outcome-unknown",
          cleanup: "none",
          trigger,
          reconciliation: reconciliationFails ? "failed" : "completed",
        });
        expect(inspectLocalImage).toHaveBeenCalledExactlyOnceWith({
          daemon: pullInput.daemon,
          image,
          missingAllowed: true,
          policy: { ...policy, workDeadline: 200 },
          signal: undefined,
          transport: undefined,
        });
        expect(
          JSON.stringify(readImagePreparationDiagnostic(failure)),
        ).not.toContain("SYNTHETIC");
      }
    },
  );

  it("never claims success when a pull response is lost after daemon mutation", async () => {
    let mutationObserved = false;
    const pull = createPullOperation({
      engineCall: () => {
        mutationObserved = true;
        return Promise.reject(new Error("integration.images.transport"));
      },
      inspectLocalImage: () => Promise.resolve({ present: true }),
      platformText: () => "linux/amd64",
    });
    let failure: unknown;
    try {
      await pull(pullInput);
    } catch (error) {
      failure = error;
    }
    expect(mutationObserved).toBe(true);
    expect(failure).toMatchObject({
      message: "integration.images.daemon-uncertain",
    });
    expect(readImagePreparationDiagnostic(failure)?.reconciliation).toBe(
      "completed",
    );
  });

  it("successful pull events have no failure projection or reconciliation", async () => {
    const result = await syntheticPull("success");
    expect(result.failure).toBeUndefined();
    expect(result.inspectLocalImage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains preparation primary beside cleanup failure: %s",
    async (withPrimary) => {
      const { failure: primary } = await syntheticPull("transport");
      if (!(primary instanceof Error))
        throw new Error("expected synthetic pull failure");
      storage.cleanupFails = true;
      const state = { admitPreparedSet: vi.fn() };
      const dependencies = {
        ...storageDependencies,
        engineTransport: () => undefined,
        prepareImageSet: () =>
          withPrimary ? Promise.reject(primary) : Promise.resolve({}),
      };
      let failure: unknown;
      try {
        await prepareImageOperation(state, dependencies, [image], {
          socketIdentityForTesting: {
            path: "/synthetic.sock",
            device: "1",
            inode: "2",
            mode: "600",
            owner: "0",
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "integration.images.cleanup" });
      expect(readImagePreparationDiagnostic(failure)).toEqual({
        primary: withPrimary ? "pull-outcome-unknown" : "none",
        trigger: withPrimary ? "transport" : "unknown",
        reconciliation: withPrimary ? "completed" : "not-attempted",
        cleanup: "private-cleanup-failed",
      });
      expect(storage).toMatchObject({ created: 1, cleanups: 1 });
      expect(storage.cleanupDeadlines).toHaveLength(1);
      expect(Number.isFinite(storage.cleanupDeadlines[0])).toBe(true);
      expect(state.admitPreparedSet).not.toHaveBeenCalled();
    },
  );
});

const stages = (): IntegrationStageDependencies => ({
  clean: vi.fn(async () => {}),
  maintainArtifacts: vi.fn(async () => {}),
  prepareCandidate: vi.fn(async () => {}),
  prepareImages: vi.fn(async () => {}),
  prepareModelRoutes: vi.fn(async () => {}),
  runScenarios: vi.fn(async () => {}),
  select: vi.fn(async () => {}),
});

const actualPreparationEntryWrapper = (error: unknown): unknown => {
  const source = readFileSync(
    new URL("../prepare-images.mjs", import.meta.url),
    "utf8",
  );
  expect(Buffer.byteLength(source)).toBeLessThan(8_192);
  const marker = "} catch (error) {";
  const start = source.indexOf(marker);
  const end = source.indexOf("} finally {", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start + marker.length, end);
  try {
    runInNewContext(
      `(() => {${body}})()`,
      {
        error,
        Error,
        imagePreparationFailureRequiresOuterHostRetirement,
        process: {
          stderr: {
            write: (value: string) => {
              expect(value).toBe("integration.images.cleanup\n");
            },
          },
        },
      },
      { timeout: 100 },
    );
  } catch (wrapped) {
    expect(wrapped).toMatchObject({
      message: "integration.images.cleanup",
      cause: error,
    });
    return wrapped;
  }
  throw new Error("expected actual entry failure");
};

describe("actual preparation entry propagation", () => {
  it.each([false, true])(
    "retains primary/private cleanup through the real wrapper: %s",
    async (withPrimary) => {
      const { failure: primary } = await syntheticPull("transport");
      if (!(primary instanceof Error))
        throw new Error("expected synthetic pull failure");
      storage.cleanupFails = true;
      let inner: unknown;
      try {
        await prepareImageOperation(
          { admitPreparedSet: vi.fn() },
          {
            ...storageDependencies,
            engineTransport: () => undefined,
            prepareImageSet: () =>
              withPrimary ? Promise.reject(primary) : Promise.resolve({}),
          },
          [image],
          {
            socketIdentityForTesting: {
              path: "/synthetic.sock",
              device: "1",
              inode: "2",
              mode: "600",
              owner: "0",
            },
          },
        );
      } catch (error) {
        inner = error;
      }
      const wrapped = actualPreparationEntryWrapper(inner);
      const dependencies = stages();
      vi.mocked(dependencies.prepareImages).mockRejectedValue(wrapped);
      let failure: unknown;
      try {
        await runIntegrationStages("lifecycle", dependencies);
      } catch (error) {
        failure = error;
      }
      expect(readControllerFailureDiagnostic(failure)).toMatchObject({
        stage: "prepareImages",
        kind: withPrimary ? "pull-outcome-unknown" : "preparation-failed",
        imagePreparation: {
          primary: withPrimary ? "pull-outcome-unknown" : "none",
          cleanup: "private-cleanup-failed",
          trigger: withPrimary ? "transport" : "unknown",
        },
        failure: "integration.controller.retire-outer-host",
      });
      expect(dependencies.runScenarios).not.toHaveBeenCalled();
      expect(formatControllerFailureDiagnostic(failure)).not.toContain(
        "SYNTHETIC",
      );
    },
  );
});

describe("controller failure projection and unchanged retirement", () => {
  it("normalizes a forged runtime stage instead of printing arbitrary content", () => {
    const failure = new IntegrationControllerFailure({
      primaryCause: new Error("SYNTHETIC"),
      retirementRequired: true,
      stage: "SYNTHETIC" as unknown as "select",
    });
    expect(readControllerFailureDiagnostic(failure).stage).toBe("unknown");
    expect(formatControllerFailureDiagnostic(failure)).not.toContain(
      "SYNTHETIC",
    );
  });
  it("distinguishes actual grace-unsettled from wrapped pull uncertainty", async () => {
    const { failure: imageFailure } = await syntheticPull("empty-events");
    const dependencies = stages();
    vi.mocked(dependencies.prepareImages).mockRejectedValue(
      new Error("integration.controller.unsettled-operation", {
        cause: imageFailure,
      }),
    );
    let failure: unknown;
    try {
      await runIntegrationStages("lifecycle", dependencies);
    } catch (error) {
      failure = error;
    }
    expect(readControllerFailureDiagnostic(failure)).toMatchObject({
      stage: "prepareImages",
      kind: "pull-outcome-unknown",
      cleanup: "not-attempted",
      failure: "integration.controller.retire-outer-host",
      imagePreparation: {
        trigger: "empty-events",
        reconciliation: "completed",
      },
    });
    expect(dependencies.clean).not.toHaveBeenCalled();
    expect(dependencies.prepareModelRoutes).not.toHaveBeenCalled();
    expect(dependencies.runScenarios).not.toHaveBeenCalled();

    const generic = stages();
    vi.mocked(generic.prepareImages).mockImplementation(() =>
      settleAbortableOperation(2, () => new Promise(() => {}), 2),
    );
    try {
      await runIntegrationStages("lifecycle", generic);
    } catch (error) {
      failure = error;
    }
    expect(readControllerFailureDiagnostic(failure)).toMatchObject({
      stage: "prepareImages",
      kind: "operation-grace-unsettled",
      imagePreparation: null,
    });
    expect(generic.clean).not.toHaveBeenCalled();
    expect(generic.prepareModelRoutes).not.toHaveBeenCalled();
  });

  it.each([
    "prepareCandidate",
    "select",
    "prepareImages",
    "prepareModelRoutes",
    "runScenarios",
    "maintainArtifacts",
    "clean",
  ] as const)(
    "binds the reached failure stage %s without exposing its message",
    async (stage) => {
      const dependencies = stages();
      vi.mocked(dependencies[stage]).mockRejectedValue(
        new Error("SYNTHETIC-VENDOR-CONTENT"),
      );
      let failure: unknown;
      try {
        await runIntegrationStages(
          stage === "prepareCandidate" ? "candidate" : "lifecycle",
          dependencies,
        );
      } catch (error) {
        failure = error;
      }
      expect(readControllerFailureDiagnostic(failure).stage).toBe(stage);
      expect(formatControllerFailureDiagnostic(failure)).not.toContain(
        "SYNTHETIC",
      );
    },
  );
});

describe("hostile diagnostic objects", () => {
  it("requires the exact private cause identity and never follows a second wrapper", async () => {
    const { failure: leaf } = await syntheticPull("transport");
    if (!(leaf instanceof Error))
      throw new Error("expected synthetic pull failure");
    const once = new Error("integration.images.daemon-uncertain", {
      cause: leaf,
    });
    const accepted = new IntegrationControllerFailure({
      primaryCause: once,
      retirementRequired: true,
    });
    expect(readControllerFailureDiagnostic(accepted).kind).toBe(
      "pull-outcome-unknown",
    );
    for (const cause of [
      once,
      { ...leaf },
      JSON.parse(JSON.stringify(leaf)) as unknown,
    ]) {
      const rejected = new IntegrationControllerFailure({
        primaryCause: new Error("integration.images.daemon-uncertain", {
          cause,
        }),
        retirementRequired: true,
      });
      expect(
        readControllerFailureDiagnostic(rejected).imagePreparation,
      ).toBeNull();
      expect(readControllerFailureDiagnostic(rejected).kind).toBe("unknown");
    }
  });

  it("rejects forged, proxy, accessor and recursive causes without executing getters", () => {
    let accesses = 0;
    const accessor = new Error("integration.controller.unsettled-operation");
    Object.defineProperty(accessor, "cause", {
      get: () => {
        accesses += 1;
        throw new Error("SYNTHETIC");
      },
    });
    const hostile = new Proxy(
      {},
      {
        get: () => {
          accesses += 1;
          throw new Error("SYNTHETIC");
        },
        getOwnPropertyDescriptor: () => {
          accesses += 1;
          throw new Error("SYNTHETIC");
        },
      },
    );
    const recursive = new Error("integration.controller.unsettled-operation");
    Object.defineProperty(recursive, "cause", { value: recursive });
    for (const value of [null, "SYNTHETIC", {}, hostile, accessor, recursive]) {
      expect(readControllerFailureDiagnostic(value).kind).toBe("unknown");
      expect(readImagePreparationDiagnostic(value)).toBeUndefined();
      const recorded = new IntegrationControllerFailure({
        primaryCause: value,
        retirementRequired: true,
      });
      expect(readControllerFailureDiagnostic(recorded).kind).toBe("unknown");
      expect(formatControllerFailureDiagnostic(recorded)).not.toContain(
        "SYNTHETIC",
      );
      expect(formatControllerFailureDiagnostic(recorded).length).toBeLessThan(
        1024,
      );
    }
    expect(accesses).toBe(0);
  });
});
