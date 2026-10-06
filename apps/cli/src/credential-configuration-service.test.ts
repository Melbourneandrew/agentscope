import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileCredentialBackendRegistry,
  createCredentialResolutionContext,
  defineStoredCredentialBackendAdapter,
  type StoredCredentialBackendImplementation,
} from "@agentscope/core";
import {
  createAgentscopeHomeResolver,
  configureDestinationConnection,
} from "@agentscope/core/configuration-management";
import type * as ConfigurationManagement from "@agentscope/core/configuration-management";
import {
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createProductionCliServicesForTesting } from "./production-services.js";
import { readHiddenCredentialForCli } from "./credential-input.js";

vi.mock("./credential-input.js", () => ({
  readHiddenCredentialForCli: vi.fn(),
}));
vi.mock("@agentscope/core/configuration-management", async (original) => {
  const actual = await original<typeof ConfigurationManagement>();
  return {
    ...actual,
    configureDestinationConnection: vi.fn(
      actual.configureDestinationConnection,
    ),
  };
});
const roots: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(readHiddenCredentialForCli).mockReset();
  Object.defineProperty(process, "platform", platform);
  for (const [stream, descriptor] of [
    [process.stdin, stdinTty],
    [process.stderr, stderrTty],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const settingsSchema = z.strictObject({ project: z.string() });
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);
const registry = compileDestinationRegistry([
  defineDestinationDescriptor({
    commandName: "example",
    destinationType: "@agentscope/destination-example",
    descriptorVersion: 1,
    settingsVersion: 1,
    settingsSchema,
    defaultSettings: { project: "default" },
    credentialSlots: [
      { id: "public-key", required: true },
      { id: "secret-key", required: true },
    ],
    documentationPath: "/docs/destinations/example",
    deliveryIdentitySupport: "duplicates-possible",
    transport: { kind: "local" },
    createReporter: () =>
      createDestinationReporter({
        report: () => Promise.resolve(createReporterReceipt("accepted")),
      }),
  }),
]);

const fixture = async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: true,
  });
  const root = await mkdtemp(
    join(tmpdir(), "agentscope-cli-credential-composition-"),
  );
  roots.push(root);
  const values = new Map<string, string>();
  const events: string[] = [];
  let removalRefused = false;
  const implementation: StoredCredentialBackendImplementation = {
    createPending: ({ ownership, generationId, secret }) => {
      events.push(`create:${ownership.slot}`);
      const referenceId = `credential-reference-v1-${createHash("sha256").update(ownership.destinationType).update("\0").update(ownership.connectionId).update("\0").update(ownership.slot).update("\0").update(generationId).digest("hex")}`;
      values.set(referenceId, secret);
      return Promise.resolve({ ok: true, referenceId });
    },
    resolve: ({ reference }) =>
      Promise.resolve(
        reference.backend !== "ci-environment" &&
          values.has(reference.referenceId)
          ? { ok: true, secret: values.get(reference.referenceId)! }
          : { ok: false, code: "missing" },
      ),
    activate: () => {
      events.push("activate");
      return Promise.resolve(true);
    },
    removePending: ({ reference }) => {
      events.push("remove-pending");
      if (reference.backend !== "ci-environment")
        values.delete(reference.referenceId);
      return Promise.resolve(true);
    },
    removeOwned: ({ reference }) => {
      events.push("remove-owned");
      if (removalRefused) return Promise.resolve(false);
      if (reference.backend !== "ci-environment")
        values.delete(reference.referenceId);
      return Promise.resolve(true);
    },
  };
  const abort = new AbortController();
  const context = createCredentialResolutionContext(
    "hook-equivalent",
    abort.signal,
    performance.now() + 60_000,
  );
  const services = createProductionCliServicesForTesting({
    registry,
    environment: { PUBLIC_KEY: "ci-public", SECRET_KEY: "ci-secret" },
    homeResolver: createAgentscopeHomeResolver({
      environment: { AGENTSCOPE_HOME: root },
      environmentOverrideAuthority: "test",
      platform: process.platform,
    }),
    credentialBackendRegistry: compileCredentialBackendRegistry([
      defineStoredCredentialBackendAdapter("macos-keychain", implementation),
    ]),
    commandBoundary: { credentialContext: context, outputMode: "human" },
  });
  expect(
    (await services.init({ apply: true, presentPlan: () => Promise.resolve() }))
      .status,
  ).toBe("success");
  const input = {
    type: "example",
    name: "primary",
    settingsJson: '{"project":"default"}',
    credentialEnvironment: [],
    humanInteractive: true,
  };
  vi.mocked(readHiddenCredentialForCli).mockImplementation((slot, received) => {
    expect(received).toBe(context);
    events.push(`input:${slot}`);
    return Promise.resolve(`private-${slot}`);
  });
  return {
    services,
    input,
    events,
    values,
    context,
    abort,
    refuseRemoval: () => {
      removalRefused = true;
    },
  };
};

describe("CLI configuration collection and commit boundaries", () => {
  it("retains the observed CI configuration commit if cancellation arrives after CAS", async () => {
    const value = await fixture();
    const actual = await vi.importActual<typeof ConfigurationManagement>(
      "@agentscope/core/configuration-management",
    );
    vi.mocked(configureDestinationConnection).mockImplementationOnce(
      async (...args) => {
        const committed = await actual.configureDestinationConnection(...args);
        value.abort.abort();
        return committed;
      },
    );
    const result = await value.services.configureDestination({
      ...value.input,
      humanInteractive: false,
      credentialEnvironment: ["public-key=PUBLIC_KEY", "secret-key=SECRET_KEY"],
    });
    expect(result).toEqual({
      status: "failure",
      diagnostic: {
        category: "unavailable",
        code: "configuration.unavailable",
        facts: { configurationCommitted: true },
      },
    });
    const listed = await value.services.listDestinations();
    expect(
      listed.status === "success" && listed.value.connections[0]?.name,
    ).toBe("primary");
    expect(value.events).toEqual([]);
  });
  it("preserves complete explicit CI input without prompting or native creation", async () => {
    const value = await fixture();
    const result = await value.services.configureDestination({
      ...value.input,
      humanInteractive: false,
      credentialEnvironment: ["public-key=PUBLIC_KEY", "secret-key=SECRET_KEY"],
    });
    expect(result.status).toBe("success");
    expect(readHiddenCredentialForCli).not.toHaveBeenCalled();
    expect(value.events).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/ci-public|ci-secret/);
  });
  it("does not fill a partial CI assignment with hidden input", async () => {
    const value = await fixture();
    const result = await value.services.configureDestination({
      ...value.input,
      credentialEnvironment: ["public-key=PUBLIC_KEY"],
    });
    expect(result.status).toBe("failure");
    expect(readHiddenCredentialForCli).not.toHaveBeenCalled();
    expect(value.events).toEqual([]);
  });
  it("cancellation during collection prevents every stored mutation", async () => {
    const value = await fixture();
    vi.mocked(readHiddenCredentialForCli).mockImplementation((slot) => {
      value.abort.abort();
      return Promise.resolve(`private-${slot}`);
    });
    const result = await value.services.configureDestination(value.input);
    expect(result.status).toBe("failure");
    expect(value.values.size).toBe(0);
    expect(value.events).toEqual([]);
  });
});

describe("ordinary CLI stored credential composition", () => {
  it("retains owned values and stops after the backend refuses deletion", async () => {
    const value = await fixture();
    await value.services.configureDestination(value.input);
    value.refuseRemoval();
    const result = await value.services.unconfigureDestination({
      name: "primary",
      retireCredentials: true,
    });
    expect(result.status).toBe("failure");
    expect(value.values.size).toBe(2);
    expect(
      value.events.filter((event) => event === "remove-owned"),
    ).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/private-|credential-reference/);
  });
  it("collects all hidden values before native creation and exposes no secret/reference", async () => {
    const value = await fixture();
    const result = await value.services.configureDestination(value.input);
    expect(result.status).toBe("success");
    expect(value.events.slice(0, 4)).toEqual([
      "input:public-key",
      "input:secret-key",
      "create:public-key",
      "create:secret-key",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private-|credential-reference/);
  });
  it("retains values by default and performs canonical complete retirement only explicitly", async () => {
    const retained = await fixture();
    await retained.services.configureDestination(retained.input);
    expect(
      (await retained.services.unconfigureDestination({ name: "primary" }))
        .status,
    ).toBe("success");
    expect(retained.values.size).toBe(2);
    expect(retained.events).not.toContain("remove-owned");
    const retired = await fixture();
    await retired.services.configureDestination(retired.input);
    expect(
      (
        await retired.services.unconfigureDestination({
          name: "primary",
          retireCredentials: true,
        })
      ).status,
    ).toBe("success");
    expect(retired.values.size).toBe(0);
    expect(
      retired.events.filter((event) => event === "remove-owned"),
    ).toHaveLength(2);
  });
  it.each(["json", "non-tty", "cancelled", "second-input-failure"])(
    "refuses %s before native creation",
    async (mode) => {
      const value = await fixture();
      if (mode === "non-tty")
        Object.defineProperty(process.stdin, "isTTY", {
          configurable: true,
          value: false,
        });
      if (mode === "cancelled") value.abort.abort();
      if (mode === "second-input-failure")
        vi.mocked(readHiddenCredentialForCli)
          .mockResolvedValueOnce("private-first")
          .mockRejectedValueOnce(new Error("private-error-canary"));
      const result = await value.services.configureDestination({
        ...value.input,
        humanInteractive: mode !== "json",
      });
      expect(result.status).toBe("failure");
      expect(value.events.some((event) => event.startsWith("create:"))).toBe(
        false,
      );
      expect(JSON.stringify(result)).not.toContain("private-");
    },
  );
});
