import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commitLocalResourceConfiguration,
  compileLocalResourceLifecycleHandlerRegistry,
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
  defineLocalResourceLifecycleDeclaration,
  defineLocalResourceLifecycleHandler,
  type LocalResourceLifecyclePlanEvidence,
} from "@agentscope/destinations-core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgentscopeHomeFromOwnedRootForCore } from "./home.js";
import {
  ConfigurationManagementError,
  applyDestinationLifecyclePlan,
  applyAgentscopeConfigurationInitialization,
  configureDestinationConnection,
  createCiEnvironmentCredentialPreflight,
  createConfigurationManagementRuntime,
  initializeAgentscopeConfiguration,
  inspectAgentscopeConfigurationInitialization,
  inspectDestinationConfigureLifecyclePlan,
  inspectDestinationLifecyclePlan,
  listDestinationConnections,
  recoverDestinationLifecycleMutation,
  setDestinationRouting,
  unconfigureDestinationConnection,
} from "./management.js";
import {
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createConfigurationStoreForTesting,
  ConfigurationCrashSimulation,
  readConfigurationSnapshot,
} from "./transaction.js";

const settingsSchema = z.strictObject({ project: z.string() });
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);
const descriptor = defineDestinationDescriptor({
  commandName: "example",
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
  credentialSlots: [],
  defaultSettings: { project: "default" },
  deliveryIdentitySupport: "duplicates-possible",
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-example",
  documentationPath: "/docs/destinations/example",
  settingsSchema,
  settingsVersion: 1,
  transport: { kind: "local" },
});
const secretDescriptor = defineDestinationDescriptor({
  commandName: "secret-example",
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
  credentialSlots: [{ id: "api-key", required: true }],
  defaultSettings: { project: "default" },
  deliveryIdentitySupport: "duplicates-possible",
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-secret-example",
  documentationPath: "/docs/destinations/secret-example",
  settingsSchema,
  settingsVersion: 1,
  transport: {
    kind: "remote",
    resolveEndpoint: () => ({
      allowInsecureLoopback: false,
      url: "https://example.com/v1/traces",
    }),
  },
});
const registry = compileDestinationRegistry([descriptor, secretDescriptor]);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-management-"));
  roots.push(root);
  const home = createAgentscopeHomeFromOwnedRootForCore(root, process.platform);
  const store = createConfigurationStore(home, registry);
  const owner = createConfigurationProcessIdentity(
    process.pid,
    `process-start-v1-${"a".repeat(64)}`,
  );
  return {
    root,
    runtime: createConfigurationManagementRuntime(registry, store, owner),
    store,
  };
};

const environmentReference = {
  backend: "ci-environment" as const,
  environmentVariable: "EXAMPLE_API_KEY",
  generationId: `credential-generation-v1-${"b".repeat(64)}`,
  referenceVersion: 1 as const,
};

describe("Core-owned destination configuration management", () => {
  it("rejects unbranded runtimes, registries, stores, and owners", async () => {
    const { runtime, store } = await fixture();
    const independentlyCompiledRegistry = compileDestinationRegistry([
      descriptor,
      secretDescriptor,
    ]);
    expect(() =>
      createConfigurationManagementRuntime(
        independentlyCompiledRegistry,
        store,
        createConfigurationProcessIdentity(
          process.pid,
          `process-start-v1-${"e".repeat(64)}`,
        ),
      ),
    ).toThrowError(ConfigurationManagementError);
    expect(() =>
      createConfigurationManagementRuntime(
        registry,
        {} as never,
        createConfigurationProcessIdentity(
          process.pid,
          `process-start-v1-${"c".repeat(64)}`,
        ),
      ),
    ).toThrowError(ConfigurationManagementError);
    expect(() =>
      createConfigurationManagementRuntime(
        {} as never,
        store,
        createConfigurationProcessIdentity(
          process.pid,
          `process-start-v1-${"d".repeat(64)}`,
        ),
      ),
    ).toThrowError(ConfigurationManagementError);
    await expect(
      listDestinationConnections({ ...runtime }),
    ).rejects.toThrowError(ConfigurationManagementError);
  });

  it("returns exact missing-state failures before initialization", async () => {
    const { runtime } = await fixture();
    await expect(listDestinationConnections(runtime)).rejects.toMatchObject({
      code: "core.configuration.missing",
    });
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "example",
        credentialReferences: {},
        name: "local",
        settings: { project: "agentscope" },
      }),
    ).rejects.toMatchObject({ code: "core.configuration.missing" });
    await expect(setDestinationRouting(runtime, [])).rejects.toMatchObject({
      code: "core.configuration.missing",
    });
    await expect(
      unconfigureDestinationConnection(runtime, "local"),
    ).rejects.toMatchObject({ code: "core.configuration.missing" });
  });
});

describe("destination configuration lifecycle", () => {
  it("initializes once and atomically configures, routes, and unconfigures", async () => {
    const { runtime, store } = await fixture();
    await expect(initializeAgentscopeConfiguration(runtime)).resolves.toEqual({
      created: true,
      generation: 0,
    });
    await expect(initializeAgentscopeConfiguration(runtime)).resolves.toEqual({
      created: false,
      generation: 0,
    });
    const configured = await configureDestinationConnection(runtime, {
      commandName: "example",
      credentialReferences: {},
      name: "local",
      settings: { project: "agentscope" },
    });
    expect(configured).toMatchObject({
      connection: { name: "local", routed: false, transport: "local" },
      generation: 1,
    });
    expect(await listDestinationConnections(runtime)).toEqual([
      configured.connection,
    ]);
    await expect(setDestinationRouting(runtime, ["local"])).resolves.toEqual({
      generation: 2,
      selected: ["local"],
    });
    expect((await listDestinationConnections(runtime))[0]).toMatchObject({
      routed: true,
    });
    await expect(
      unconfigureDestinationConnection(runtime, "local"),
    ).resolves.toEqual({
      generation: 3,
      name: "local",
    });
    expect(await listDestinationConnections(runtime)).toEqual([]);
    expect(
      (await readConfigurationSnapshot(store)).selectedConnectionIds,
    ).toEqual([]);
  });

  it("binds initialization to an exact one-use inspected plan", async () => {
    const { root, runtime } = await fixture();
    const createPlan =
      await inspectAgentscopeConfigurationInitialization(runtime);
    expect(createPlan).toMatchObject({ action: "create", generation: null });
    await expect(
      applyAgentscopeConfigurationInitialization({ ...createPlan }),
    ).rejects.toThrowError(ConfigurationManagementError);
    await expect(
      applyAgentscopeConfigurationInitialization(createPlan),
    ).resolves.toEqual({ created: true, generation: 0 });
    await expect(
      applyAgentscopeConfigurationInitialization(createPlan),
    ).rejects.toThrowError(ConfigurationManagementError);

    const unchangedPlan =
      await inspectAgentscopeConfigurationInitialization(runtime);
    await configureDestinationConnection(runtime, {
      commandName: "example",
      credentialReferences: {},
      name: "later",
      settings: { project: "agentscope" },
    });
    await expect(
      applyAgentscopeConfigurationInitialization(unchangedPlan),
    ).rejects.toMatchObject({ code: "core.configuration.conflict" });

    const missingPlan =
      await inspectAgentscopeConfigurationInitialization(runtime);
    await rm(join(root, "config.json"));
    await expect(
      applyAgentscopeConfigurationInitialization(missingPlan),
    ).rejects.toMatchObject({ code: "core.configuration.missing" });
  });
});

// eslint-disable-next-line max-lines-per-function -- one descriptor and handler bind the complete plan authority fixture.
describe("local-resource configuration lifecycle plans", () => {
  const declaration = defineLocalResourceLifecycleDeclaration({
    artifactGrammarFingerprint: `sha256-${"1".repeat(64)}`,
    artifactGrammarVersion: 1,
    artifactKinds: ["active-database", "lifecycle-intent", "ownership-receipt"],
    capabilityVersion: 1,
    destinationType: "@agentscope/destination-planned-local",
    operations: ["configure", "delete", "recover", "unconfigure"],
    receiptReasons: ["destination-busy"],
    recoveryHandlerId: "@agentscope/destination-planned-local/lifecycle-v1",
    settingKeys: ["project"],
    settingsVersion: 1,
  });
  const plannedDescriptor = defineDestinationDescriptor({
    commandName: "planned-local",
    createReporter: () =>
      createDestinationReporter({
        report: () => Promise.resolve(createReporterReceipt("accepted")),
      }),
    credentialSlots: [],
    defaultSettings: { project: "default" },
    deliveryIdentitySupport: "duplicates-possible",
    descriptorVersion: 1,
    destinationType: "@agentscope/destination-planned-local",
    documentationPath: "/docs/destinations/planned-local",
    localResourceLifecycle: declaration,
    settingsSchema,
    settingsVersion: 1,
    transport: { kind: "local" },
  });

  // eslint-disable-next-line max-lines-per-function -- one sequence proves configure, retained ownership, and two-generation deletion.
  it("retains on unconfigure and advances two generations before delete", async () => {
    const localRegistry = compileDestinationRegistry([plannedDescriptor]);
    const events: string[] = [];
    let failAfterCommit = false;
    let failCompletion = false;
    let recoverCalls = 0;
    const capability = localRegistry.descriptors[0]!.localResourceLifecycle!;
    let retained:
      | Readonly<{
          destinationType: string;
          connectionId: string;
          connectionName: string;
          planEvidence: LocalResourceLifecyclePlanEvidence;
          retainedAuthority: Readonly<{
            receiptDigest: string;
            databaseFamilyPhysicalIdentity: string;
          }>;
        }>
      | undefined;
    const handler = defineLocalResourceLifecycleHandler({
      capability,
      complete: () => {
        if (failCompletion) {
          failCompletion = false;
          return Promise.reject(new Error("simulated completion crash"));
        }
        return Promise.resolve();
      },
      inspectPlan: (context) => {
        events.push(`inspect:${context.operation}`);
        return Promise.resolve({
          namespaceFingerprint: `sha256-${"2".repeat(64)}`,
          physicalEvidenceFingerprint: `sha256-${"3".repeat(64)}`,
          displayPath: "/owned/local",
          persistentDataNotice: true,
          retentionPolicy: Object.freeze({
            maximumAgeNanoseconds: "2592000000000000",
            maximumTraceCount: 10_000,
            maximumPayloadBytes: 1_073_741_824,
            physicalCleanupTrigger: "next-authorized-mutation" as const,
          }),
        });
      },
      inspectRetainedDelete: (connectionId) => {
        events.push("inspect-retained");
        return Promise.resolve(
          retained?.connectionId === connectionId
            ? Object.freeze({
                ...retained,
                connectionName: "retained" as const,
              })
            : null,
        );
      },
      apply: async (context) => {
        events.push(`prepare:${context.operation}`);
        const evidence = await commitLocalResourceConfiguration(
          context.configurationAuthority,
          {
            destinationType: context.destinationType,
            connectionId: context.connectionId,
            operationId: context.operationId,
            lifecycleFingerprint: capability.fingerprint,
            recoveryHandlerId: capability.recoveryHandlerId,
          },
        );
        events.push(`commit:${evidence.committedGeneration}`);
        if (failAfterCommit) throw new Error("simulated post-commit crash");
        if (context.operation === "unconfigure")
          retained = Object.freeze({
            destinationType: context.destinationType,
            connectionId: context.connectionId,
            connectionName: context.connectionName,
            planEvidence: context.planEvidence,
            retainedAuthority: Object.freeze({
              receiptDigest: `sha256-${"4".repeat(64)}`,
              databaseFamilyPhysicalIdentity: "dev:1:ino:2",
            }),
          });
        if (context.operation === "delete") retained = undefined;
        if (context.operation === "unconfigure")
          return {
            ok: true,
            state: "retained",
            retainedAuthority: retained!.retainedAuthority,
          };
        return {
          ok: true,
          state: context.operation === "delete" ? "deleted" : "configured",
        };
      },
      recover: async (context) => {
        recoverCalls += 1;
        events.push(`recover:${context.configurationState}`);
        if (context.configurationAuthority)
          await commitLocalResourceConfiguration(
            context.configurationAuthority,
            {
              destinationType: context.destinationType,
              connectionId: context.connectionId,
              operationId: context.operationId,
              lifecycleFingerprint: capability.fingerprint,
              recoveryHandlerId: capability.recoveryHandlerId,
            },
          );
        if (context.operation === "unconfigure") {
          const recoveredRetained = Object.freeze({
            destinationType: context.destinationType,
            connectionId: context.connectionId,
            connectionName: "retained",
            planEvidence: {
              namespaceFingerprint: `sha256-${"2".repeat(64)}`,
              physicalEvidenceFingerprint: `sha256-${"3".repeat(64)}`,
              displayPath: "/owned/local",
              persistentDataNotice: true as const,
              retentionPolicy: {
                maximumAgeNanoseconds: "2592000000000000",
                maximumTraceCount: 10_000,
                maximumPayloadBytes: 1_073_741_824,
                physicalCleanupTrigger: "next-authorized-mutation" as const,
              },
            },
            retainedAuthority: Object.freeze({
              receiptDigest: `sha256-${"4".repeat(64)}`,
              databaseFamilyPhysicalIdentity: "dev:1:ino:2",
            }),
          });
          retained = recoveredRetained;
          return {
            ok: true,
            state: "retained",
            retainedAuthority: recoveredRetained.retainedAuthority,
          };
        }
        return {
          ok: true,
          state: context.operation === "delete" ? "deleted" : "configured",
        };
      },
    });
    const lifecycleHandlers = compileLocalResourceLifecycleHandlerRegistry(
      localRegistry,
      [handler],
    );
    const root = await mkdtemp(join(tmpdir(), "agentscope-lifecycle-plan-"));
    roots.push(root);
    const home = createAgentscopeHomeFromOwnedRootForCore(
      root,
      process.platform,
    );
    let crashCandidateNumber = 0;
    let observedCandidates = 0;
    const store = createConfigurationStoreForTesting(home, localRegistry, {
      afterStep: (step) => {
        if (step !== "candidate-durable" || crashCandidateNumber === 0) return;
        observedCandidates += 1;
        if (observedCandidates === crashCandidateNumber)
          throw new ConfigurationCrashSimulation();
      },
    });
    const owner = createConfigurationProcessIdentity(
      process.pid,
      `process-start-v1-${"9".repeat(64)}`,
    );
    const runtime = createConfigurationManagementRuntime(
      localRegistry,
      store,
      owner,
      lifecycleHandlers,
    );
    await initializeAgentscopeConfiguration(runtime);
    const configure = await inspectDestinationConfigureLifecyclePlan(
      runtime,
      {
        commandName: "planned-local",
        credentialReferences: {},
        name: "local",
        settings: { project: "agentscope" },
      },
      new AbortController().signal,
    );
    await expect(applyDestinationLifecyclePlan(configure)).resolves.toEqual({
      generation: 1,
      name: "local",
      state: "configured",
    });

    const unconfigure = await inspectDestinationLifecyclePlan(
      runtime,
      "unconfigure",
      "local",
      new AbortController().signal,
    );
    expect(unconfigure).toMatchObject({
      operation: "unconfigure",
      displayPath: "/owned/local",
      persistentDataNotice: true,
      retentionPolicy: {
        maximumAgeNanoseconds: "2592000000000000",
        maximumTraceCount: 10_000,
        maximumPayloadBytes: 1_073_741_824,
        physicalCleanupTrigger: "next-authorized-mutation",
      },
    });
    expect(events).toEqual([
      "inspect:configure",
      "prepare:configure",
      "commit:1",
      "inspect:unconfigure",
    ]);
    const retainedResult = await applyDestinationLifecyclePlan(unconfigure);
    expect(retainedResult).toMatchObject({
      generation: 2,
      name: "local",
      state: "retained",
    });
    expect(retainedResult.retainedDeleteSelector).toMatch(
      /^destination-connection-v1-[0-9a-f]{64}$/u,
    );
    await expect(
      applyDestinationLifecyclePlan(unconfigure),
    ).rejects.toMatchObject({
      code: "core.configuration.invalid",
    });
    expect((await readConfigurationSnapshot(store)).connections).toHaveLength(
      0,
    );

    const deletion = await inspectDestinationLifecyclePlan(
      runtime,
      "delete",
      retainedResult.retainedDeleteSelector!,
      new AbortController().signal,
    );
    await expect(applyDestinationLifecyclePlan(deletion)).resolves.toEqual({
      generation: 4,
      name: "retained",
      state: "deleted",
    });
    expect(events).toEqual([
      "inspect:configure",
      "prepare:configure",
      "commit:1",
      "inspect:unconfigure",
      "prepare:unconfigure",
      "commit:2",
      "inspect-retained",
      "prepare:delete",
      "commit:4",
    ]);
    const final = await readConfigurationSnapshot(store);
    expect(final.generation).toBe(4);
    expect(final.connections).toHaveLength(0);

    const interrupted = await inspectDestinationConfigureLifecyclePlan(
      runtime,
      {
        commandName: "planned-local",
        credentialReferences: {},
        name: "recovered",
        settings: { project: "agentscope" },
      },
      new AbortController().signal,
    );
    failAfterCommit = true;
    await expect(
      applyDestinationLifecyclePlan(interrupted),
    ).rejects.toMatchObject({
      code: "core.destination.lifecycle-outcome-unknown",
    });
    expect((await readConfigurationSnapshot(store)).generation).toBe(5);
    await expect(
      recoverDestinationLifecycleMutation(
        runtime,
        () => "dead",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ generation: 5, state: "configured" });
    expect(events.at(-1)).toBe("recover:committed");

    failAfterCommit = false;
    const retainedAgain = await applyDestinationLifecyclePlan(
      await inspectDestinationLifecyclePlan(
        runtime,
        "unconfigure",
        "recovered",
        new AbortController().signal,
      ),
    );
    expect(retainedAgain).toMatchObject({
      generation: 6,
      state: "retained",
    });
    const interruptedDelete = await inspectDestinationLifecyclePlan(
      runtime,
      "delete",
      retainedAgain.retainedDeleteSelector!,
      new AbortController().signal,
    );
    observedCandidates = 0;
    crashCandidateNumber = 2;
    await expect(
      applyDestinationLifecyclePlan(interruptedDelete),
    ).rejects.toMatchObject({
      code: "core.destination.lifecycle-outcome-unknown",
    });
    crashCandidateNumber = 0;
    await expect(
      recoverDestinationLifecycleMutation(
        runtime,
        () => "dead",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ generation: 8, state: "deleted" });

    const completionCrash = await inspectDestinationConfigureLifecyclePlan(
      runtime,
      {
        commandName: "planned-local",
        credentialReferences: {},
        name: "completion-recovered",
        settings: { project: "agentscope" },
      },
      new AbortController().signal,
    );
    failCompletion = true;
    const recoverCallsBeforeCompletionCleanup = recoverCalls;
    await expect(
      applyDestinationLifecyclePlan(completionCrash),
    ).rejects.toMatchObject({
      code: "core.destination.lifecycle-outcome-unknown",
    });
    expect((await readConfigurationSnapshot(store)).generation).toBe(9);
    await expect(
      recoverDestinationLifecycleMutation(
        runtime,
        () => "unknown",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ generation: 9, state: "configured" });
    expect(recoverCalls).toBe(recoverCallsBeforeCompletionCleanup);

    const interruptedUnconfigure = await inspectDestinationLifecyclePlan(
      runtime,
      "unconfigure",
      "completion-recovered",
      new AbortController().signal,
    );
    failAfterCommit = true;
    await expect(
      applyDestinationLifecyclePlan(interruptedUnconfigure),
    ).rejects.toMatchObject({
      code: "core.destination.lifecycle-outcome-unknown",
    });
    failAfterCommit = false;
    const recoveredRetained = await recoverDestinationLifecycleMutation(
      runtime,
      () => "dead",
      new AbortController().signal,
    );
    expect(recoveredRetained).toMatchObject({
      generation: 10,
      state: "retained",
    });
    expect(recoveredRetained.retainedDeleteSelector).toMatch(
      /^destination-connection-v1-[0-9a-f]{64}$/u,
    );
    await expect(
      applyDestinationLifecyclePlan(
        await inspectDestinationLifecyclePlan(
          runtime,
          "delete",
          recoveredRetained.retainedDeleteSelector!,
          new AbortController().signal,
        ),
      ),
    ).resolves.toEqual({ generation: 12, name: "retained", state: "deleted" });

    await applyDestinationLifecyclePlan(
      await inspectDestinationConfigureLifecyclePlan(
        runtime,
        {
          commandName: "planned-local",
          credentialReferences: {},
          name: "completion-unconfigure",
          settings: { project: "agentscope" },
        },
        new AbortController().signal,
      ),
    );
    const completionUnconfigure = await inspectDestinationLifecyclePlan(
      runtime,
      "unconfigure",
      "completion-unconfigure",
      new AbortController().signal,
    );
    failCompletion = true;
    const recoveryCallsBeforeRetainedCompletion = recoverCalls;
    await expect(
      applyDestinationLifecyclePlan(completionUnconfigure),
    ).rejects.toMatchObject({
      code: "core.destination.lifecycle-outcome-unknown",
    });
    const completionRecoveredRetained =
      await recoverDestinationLifecycleMutation(
        runtime,
        () => "unknown",
        new AbortController().signal,
      );
    expect(completionRecoveredRetained).toMatchObject({
      generation: 14,
      state: "retained",
    });
    expect(completionRecoveredRetained.retainedDeleteSelector).toMatch(
      /^destination-connection-v1-[0-9a-f]{64}$/u,
    );
    expect(recoverCalls).toBe(recoveryCallsBeforeRetainedCompletion);
  });
});

describe("destination credential configuration", () => {
  it("validates descriptor settings and credential references before writes", async () => {
    const { runtime } = await fixture();
    await initializeAgentscopeConfiguration(runtime);
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "secret-example",
        credentialReferences: {},
        name: "remote",
        settings: { project: "agentscope" },
      }),
    ).rejects.toThrowError(ConfigurationManagementError);
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "secret-example",
        credentialReferences: { "api-key": environmentReference },
        name: "remote",
        settings: { project: "agentscope" },
      }),
    ).rejects.toMatchObject({
      code: "core.destination.credential-unavailable",
    });
    await expect(
      configureDestinationConnection(
        runtime,
        {
          commandName: "secret-example",
          credentialReferences: { "api-key": environmentReference },
          name: "remote",
          settings: { project: "agentscope" },
        },
        createCiEnvironmentCredentialPreflight(
          { EXAMPLE_API_KEY: "secret" },
          new AbortController().signal,
        ),
      ),
    ).resolves.toMatchObject({
      connection: { name: "remote", transport: "remote" },
    });
    await expect(
      unconfigureDestinationConnection(runtime, "remote"),
    ).rejects.toMatchObject({
      code: "core.destination.credential-removal-required",
    });
  });

  it("preflights CI credential references before configuration mutation", async () => {
    const { runtime, store } = await fixture();
    await initializeAgentscopeConfiguration(runtime);
    for (const environment of [{}, { EXAMPLE_API_KEY: 42 }]) {
      await expect(
        configureDestinationConnection(
          runtime,
          {
            commandName: "secret-example",
            credentialReferences: { "api-key": environmentReference },
            name: "remote",
            settings: { project: "agentscope" },
          },
          createCiEnvironmentCredentialPreflight(
            environment,
            new AbortController().signal,
          ),
        ),
      ).rejects.toMatchObject({
        code: "core.destination.credential-unavailable",
      });
      expect((await readConfigurationSnapshot(store)).generation).toBe(0);
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      configureDestinationConnection(
        runtime,
        {
          commandName: "secret-example",
          credentialReferences: { "api-key": environmentReference },
          name: "remote",
          settings: { project: "agentscope" },
        },
        createCiEnvironmentCredentialPreflight(
          { EXAMPLE_API_KEY: "secret" },
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({
      code: "core.destination.credential-unavailable",
    });
    expect((await readConfigurationSnapshot(store)).generation).toBe(0);
  });
});

describe("destination configuration rejection and cleanup", () => {
  it("rejects duplicates, unknown routes, and hostile credential records", async () => {
    const { runtime } = await fixture();
    await initializeAgentscopeConfiguration(runtime);
    await configureDestinationConnection(runtime, {
      commandName: "example",
      credentialReferences: {},
      name: "local",
      settings: { project: "agentscope" },
    });
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "example",
        credentialReferences: {},
        name: "local",
        settings: { project: "other" },
      }),
    ).rejects.toMatchObject({ code: "core.destination.connection-exists" });
    await expect(
      setDestinationRouting(runtime, ["missing"]),
    ).rejects.toMatchObject({
      code: "core.destination.connection-missing",
    });
    await expect(
      setDestinationRouting(runtime, ["local", "local"]),
    ).rejects.toMatchObject({ code: "core.configuration.invalid" });
    await expect(
      unconfigureDestinationConnection(runtime, "missing"),
    ).rejects.toMatchObject({ code: "core.destination.connection-missing" });
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "unknown",
        credentialReferences: {},
        name: "unknown",
        settings: {},
      }),
    ).rejects.toMatchObject({ code: "core.destination.type-missing" });
    const hostile = {} as Record<string, typeof environmentReference>;
    Object.defineProperty(hostile, "api-key", {
      enumerable: true,
      get: () => environmentReference,
    });
    await expect(
      configureDestinationConnection(runtime, {
        commandName: "secret-example",
        credentialReferences: hostile,
        name: "second",
        settings: { project: "agentscope" },
      }),
    ).rejects.toThrowError(ConfigurationManagementError);
  });

  it("retains a destination namespace until its final connection is removed", async () => {
    const { runtime } = await fixture();
    await initializeAgentscopeConfiguration(runtime);
    for (const name of ["first", "second"])
      await configureDestinationConnection(runtime, {
        commandName: "example",
        credentialReferences: {},
        name,
        settings: { project: name },
      });
    await expect(
      unconfigureDestinationConnection(runtime, "first"),
    ).resolves.toMatchObject({ name: "first" });
    await expect(listDestinationConnections(runtime)).resolves.toMatchObject([
      { name: "second" },
    ]);
  });
});
