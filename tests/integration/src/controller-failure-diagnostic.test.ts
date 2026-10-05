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

const storage = {
  cleanupFails: false,
  cleanups: 0,
  created: 0,
};
const storageDependencies = {
  createPrivateClientRoot: () => {
    storage.created += 1;
    return { root: "/synthetic-private-root" };
  },
  cleanupPrivateClient: () => {
    storage.cleanups += 1;
    if (storage.cleanupFails) throw new Error("SYNTHETIC-PRIVATE-CONTENT");
  },
};
beforeEach(() => {
  storage.cleanupFails = false;
  storage.cleanups = 0;
  storage.created = 0;
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
