import { performance } from "node:perf_hooks";
import {
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core";
import { createReporterDeadline } from "@agentscope/destinations-core/core-orchestration";
import type * as Protocol from "@agentscope/protocol";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  compileCredentialBackendRegistry,
  defineStoredCredentialBackendAdapter,
  type CredentialResolutionContext,
} from "../configuration/credential-adapter.js";
import { parseAgentscopeConfiguration } from "../configuration/schema.js";
import { BUILTIN_REDACTION_POLICY_REFERENCES } from "../redaction/policy.js";
import { routeRedactedTraceBatch } from "./delivery.js";

const clock = vi.hoisted(() => {
  const value = { now: 100 };
  vi.spyOn(globalThis.performance, "now").mockImplementation(() => value.now);
  return value;
});

// This isolated caller-clock fixture substitutes only trace branding. Existing
// delivery suites own canonical capture/redaction and destination acceptance.
vi.mock("@agentscope/protocol", async (original) => ({
  ...(await original<typeof Protocol>()),
  isRedactedCanonicalTrace: () => true,
}));

const fixture = (
  resolve: (
    context: CredentialResolutionContext,
  ) => Promise<Readonly<{ ok: true; secret: string }>>,
  beforeReporter: () => void = () => {},
) => {
  const settingsSchema = z.strictObject({});
  void settingsSchema.shape;
  z.toJSONSchema(settingsSchema);
  const report = vi.fn(() =>
    Promise.resolve(createReporterReceipt("accepted")),
  );
  const descriptor = defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType: "@agentscope/destination-deadline-test",
    commandName: "deadline-test",
    settingsVersion: 1,
    settingsSchema,
    defaultSettings: {},
    credentialSlots: [{ id: "token", required: true }],
    documentationPath: "/docs/destinations/deadline-test",
    deliveryIdentitySupport: "duplicates-possible",
    transport: { kind: "local" },
    createReporter: () => {
      beforeReporter();
      return createDestinationReporter({ report });
    },
  });
  const configuration = parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation: 1,
      destinations: {
        "@agentscope/destination-deadline-test": {
          namespaceVersion: 1,
          settingsVersion: 1,
          connections: [
            {
              connectionId: `destination-connection-v1-${"a".repeat(64)}`,
              name: "deadline",
              settings: {},
              credentialReferences: {
                token: {
                  referenceVersion: 1,
                  backend: "macos-keychain",
                  referenceId: `credential-reference-v1-${"b".repeat(64)}`,
                  generationId: `credential-generation-v1-${"c".repeat(64)}`,
                },
              },
            },
          ],
        },
      },
      routing: {
        version: 1,
        selectedConnectionIds: [`destination-connection-v1-${"a".repeat(64)}`],
        hookDeadlineMilliseconds: 5_000,
      },
      policy: {
        version: 1,
        reference: BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      },
    },
    compileDestinationRegistry([descriptor]),
  );
  const registry = compileCredentialBackendRegistry([
    defineStoredCredentialBackendAdapter("macos-keychain", {
      createPending: () => Promise.resolve({ ok: false, code: "denied" }),
      activate: () => Promise.resolve(false),
      removePending: () => Promise.resolve(false),
      removeOwned: () => Promise.resolve(false),
      resolve: ({ context }) => resolve(context),
    }),
  ]);
  const route = (deadline: ReturnType<typeof createReporterDeadline>) =>
    routeRedactedTraceBatch({
      traces: [
        {
          delivery: { identity: "clock-fixture" },
        } as Protocol.RedactedCanonicalTrace,
      ],
      configuration,
      credentialBackendRegistry: registry,
      transportExecutor: () => Promise.reject(new Error("unused")),
      deadline,
      admissionTimeUnixNano: "1",
    });
  return { report, route };
};

afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => vi.restoreAllMocks());

describe("delivery credential setup absolute cutoff", () => {
  it("caps credential resolution at setup entry plus the existing one second", async () => {
    clock.now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    const deadline = createReporterDeadline(5_000);
    clock.now = 350;
    let captured: CredentialResolutionContext | undefined;
    const value = fixture((context) => {
      captured = context;
      return Promise.resolve({ ok: true, secret: "CANARY" });
    });
    const result = await value.route(deadline);
    expect(captured?.expiresAtMonotonicMilliseconds).toBe(1_350);
    expect(result.connections[0]?.outcome).toBe("accepted");
    expect(value.report).toHaveBeenCalledOnce();
  });

  it("uses an earlier ReporterDeadline without resetting the setup budget", async () => {
    clock.now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    const deadline = createReporterDeadline(500);
    clock.now = 400;
    let captured: CredentialResolutionContext | undefined;
    const value = fixture((context) => {
      captured = context;
      return Promise.resolve({ ok: true, secret: "CANARY" });
    });
    await value.route(deadline);
    expect(captured?.expiresAtMonotonicMilliseconds).toBe(600);
  });

  it("does not admit a late credential success when the timer callback is delayed", async () => {
    clock.now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    const deadline = createReporterDeadline(5_000);
    const value = fixture((context) => {
      clock.now = context.expiresAtMonotonicMilliseconds!;
      return Promise.resolve({ ok: true, secret: "CANARY" });
    });
    const result = await value.route(deadline);
    expect(result.connections[0]?.outcome).toBe("unavailable");
    expect(value.report).not.toHaveBeenCalled();
  });

  it("observes a late backend rejection after the original setup timer expires", async () => {
    vi.useFakeTimers();
    clock.now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    const deadline = createReporterDeadline(5_000);
    let reject: ((reason: Error) => void) | undefined;
    let context: CredentialResolutionContext | undefined;
    const value = fixture((captured) => {
      context = captured;
      return new Promise((_resolve, reject_) => {
        reject = reject_;
      });
    });
    const pending = value.route(deadline);
    clock.now = 1_100;
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).connections[0]?.outcome).toBe("unavailable");
    expect(context?.signal.aborted).toBe(true);
    reject?.(new Error("CANARY"));
    await Promise.resolve();
    expect(value.report).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("delivery setup admission edge", () => {
  it("does not promote a reporter factory that returns after setup expiry", async () => {
    clock.now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    const deadline = createReporterDeadline(5_000);
    const value = fixture(
      () => Promise.resolve({ ok: true, secret: "CANARY" }),
      () => {
        clock.now = 1_100;
      },
    );
    expect((await value.route(deadline)).connections[0]?.outcome).toBe(
      "unavailable",
    );
    expect(value.report).not.toHaveBeenCalled();
  });
});
