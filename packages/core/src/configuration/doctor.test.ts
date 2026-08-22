import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compileCredentialBackendRegistry,
  createCredentialOwnership,
  createCredentialResolutionContext,
  createStoredCredentialReference,
  defineStoredCredentialBackendAdapter,
  type CredentialResolutionFailure,
} from "./credential-adapter.js";
import {
  DoctorError,
  inspectAgentscopeDoctor,
  repairDoctorConfigurationTransaction,
  repairDoctorOperationalStateLock,
} from "./doctor.js";
import { createAgentscopeHomeResolver } from "./home.js";
import {
  createOperationalStateStore,
  recordSanitizedDiagnostic,
} from "./operational-state.js";
import {
  parseAgentscopeConfiguration,
  serializeAgentscopeConfiguration,
} from "./schema.js";
import {
  ConfigurationCrashSimulation,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createConfigurationStoreForTesting,
  createCredentialMutationIntent,
  writeConfigurationSnapshot,
} from "./transaction.js";

const connectionId = `destination-connection-v1-${"a".repeat(64)}`;
const referenceId = `credential-reference-v1-${"b".repeat(64)}`;
const generationId = `credential-generation-v1-${"c".repeat(64)}`;
const schema = z.strictObject({ project: z.string() });
void schema.shape;
z.toJSONSchema(schema);
const destination = defineDestinationDescriptor({
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-example",
  commandName: "example",
  settingsVersion: 1,
  settingsSchema: schema,
  defaultSettings: { project: "default" },
  credentialSlots: [
    { id: "api-key", required: true },
    { id: "token", required: false },
  ],
  documentationPath: "/docs/destinations/example",
  deliveryIdentitySupport: "duplicates-possible",
  transport: { kind: "local" },
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
});
const destinations = compileDestinationRegistry([destination]);
const owner = createConfigurationProcessIdentity(
  91,
  `process-start-v1-${"d".repeat(64)}`,
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = async (failure?: CredentialResolutionFailure) => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-doctor-"));
  roots.push(root);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: join(root, "home") },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  const backend = defineStoredCredentialBackendAdapter("linux-secret-service", {
    createPending: () => Promise.resolve({ ok: true, referenceId }),
    resolve: () =>
      Promise.resolve(
        failure
          ? { ok: false as const, code: failure }
          : { ok: true as const, secret: "CANARY_SECRET" },
      ),
    activate: () => Promise.resolve(true),
    removePending: () => Promise.resolve(true),
    removeOwned: () => Promise.resolve(true),
  });
  const credentialRegistry = compileCredentialBackendRegistry([backend]);
  return {
    home,
    configurationStore: createConfigurationStore(home, destinations),
    operationalStateStore: createOperationalStateStore(home, owner),
    credentialRegistry,
    context: createCredentialResolutionContext(
      "hook-equivalent",
      new AbortController().signal,
    ),
  };
};

const configured = () => {
  const reference = createStoredCredentialReference(
    "linux-secret-service",
    referenceId,
    generationId,
  );
  const tokenReference = createStoredCredentialReference(
    "linux-secret-service",
    referenceId,
    generationId,
  );
  return {
    reference,
    snapshot: parseAgentscopeConfiguration(
      {
        configurationVersion: 2,
        generation: 0,
        destinations: {
          "@agentscope/destination-example": {
            namespaceVersion: 1,
            settingsVersion: 1,
            connections: [
              {
                connectionId,
                name: "primary",
                settings: { project: "example" },
                credentialReferences: {
                  "api-key": reference,
                  token: tokenReference,
                },
              },
            ],
          },
        },
        routing: {
          version: 1,
          selectedConnectionIds: [connectionId],
          hookDeadlineMilliseconds: 2_000,
        },
        policy: { version: 1, reference: "policy-v1" },
      },
      destinations,
    ),
  };
};

const emptySnapshot = (generation: number) =>
  parseAgentscopeConfiguration(
    {
      configurationVersion: 2,
      generation,
      destinations: {},
      routing: {
        version: 1,
        selectedConnectionIds: [],
        hookDeadlineMilliseconds: 2_000,
      },
      policy: { version: 1, reference: "policy-v1" },
    },
    destinations,
  );

const inspect = (
  state: Awaited<ReturnType<typeof fixture>>,
  configurationStore = state.configurationStore,
  ownerState: () => "dead" | "live" | "unknown" = () => "dead",
) =>
  inspectAgentscopeDoctor({
    configurationStore,
    operationalStateStore: state.operationalStateStore,
    credentialRegistry: state.credentialRegistry,
    credentialResolutionContext: state.context,
    ownerState,
  });

describe("Agentscope Doctor inspection", () => {
  it("reports valid configuration, opaque credential resolution, and bounded health", async () => {
    const state = await fixture();
    const { snapshot } = configured();
    await writeConfigurationSnapshot(state.configurationStore, {
      expectedGeneration: null,
      candidate: snapshot,
      owner,
    });
    await recordSanitizedDiagnostic(state.operationalStateStore, {
      code: "credential-locked",
      severity: "warning",
      configurationGeneration: 0,
    });
    const configBefore = await readFile(state.home.configFile, "utf8");
    const modifiedBefore = (await stat(state.home.configFile)).mtimeMs;

    const report = await inspectAgentscopeDoctor({
      configurationStore: state.configurationStore,
      operationalStateStore: state.operationalStateStore,
      credentialRegistry: state.credentialRegistry,
      credentialResolutionContext: state.context,
      ownerState: () => "dead",
    });

    expect(report.configuration).toMatchObject({
      state: "valid",
      generation: 0,
    });
    if (report.configuration.state !== "valid") throw new Error("unreachable");
    expect(report.configuration.identity).toMatch(/^sha256-[0-9a-f]{64}$/u);
    expect(report.connections).toEqual([
      {
        destinationType: "@agentscope/destination-example",
        connectionId,
      },
    ]);
    expect(report.transaction).toEqual({ state: "clean" });
    expect(report.credentials).toMatchObject([
      {
        destinationType: "@agentscope/destination-example",
        connectionId,
        slot: "api-key",
        backend: "linux-secret-service",
        state: "available",
      },
      {
        destinationType: "@agentscope/destination-example",
        connectionId,
        slot: "token",
        backend: "linux-secret-service",
        state: "available",
      },
    ]);
    expect(report.operationalState).toMatchObject({ state: "available" });
    expect(report.findings.map((entry) => entry.code)).toEqual([
      "doctor.configuration.valid",
      "doctor.transaction.clean",
      "doctor.credential-mutation.clean",
      "doctor.credential.available",
      "doctor.credential.available",
      "doctor.operational-state.available",
    ]);
    expect(JSON.stringify(report)).not.toContain("CANARY_SECRET");
    expect(Object.isFrozen(report.findings)).toBe(true);
    expect(await readFile(state.home.configFile, "utf8")).toBe(configBefore);
    expect((await stat(state.home.configFile)).mtimeMs).toBe(modifiedBefore);
  });
});

describe("Agentscope Doctor credential and input boundaries", () => {
  it.each([
    ["locked", "doctor.credential.locked", "unlock-credential-store"],
    ["missing", "doctor.credential.missing", "configure"],
    ["malformed", "doctor.credential.malformed", "configure"],
    ["denied", "doctor.credential.denied", "retry"],
    ["unavailable", "doctor.credential.unavailable", "retry"],
  ] as const)(
    "maps %s resolution to fixed guidance",
    async (failure, code, action) => {
      const state = await fixture(failure);
      const { snapshot } = configured();
      await writeConfigurationSnapshot(state.configurationStore, {
        expectedGeneration: null,
        candidate: snapshot,
        owner,
      });
      const report = await inspectAgentscopeDoctor({
        configurationStore: state.configurationStore,
        operationalStateStore: state.operationalStateStore,
        credentialRegistry: state.credentialRegistry,
        credentialResolutionContext: state.context,
        ownerState: () => "dead",
      });
      expect(report.credentials[0]?.state).toBe(failure);
      expect(report.findings).toContainEqual({
        code,
        severity: failure === "locked" ? "warning" : "error",
        suggestedAction: action,
      });
    },
  );

  it("reports missing configuration without creating operational state", async () => {
    const state = await fixture();
    const report = await inspectAgentscopeDoctor({
      configurationStore: state.configurationStore,
      operationalStateStore: state.operationalStateStore,
      credentialRegistry: state.credentialRegistry,
      credentialResolutionContext: state.context,
      ownerState: () => "dead",
    });
    expect(report.configuration).toEqual({ state: "missing" });
    expect(report.credentials).toEqual([]);
    expect(report.findings[0]).toEqual({
      code: "doctor.configuration.missing",
      severity: "error",
      suggestedAction: "configure",
    });
    await expect(stat(state.home.healthDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects hostile or unbranded inspection authority", async () => {
    const state = await fixture();
    await expect(inspectAgentscopeDoctor(null as never)).rejects.toThrowError(
      DoctorError,
    );
    await expect(
      inspectAgentscopeDoctor(
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("CANARY_SECRET");
            },
          },
        ) as never,
      ),
    ).rejects.toThrowError(DoctorError);
    const hostile = Object.defineProperty({}, "configurationStore", {
      get: () => {
        throw new Error("CANARY_SECRET");
      },
    });
    await expect(
      inspectAgentscopeDoctor(hostile as never),
    ).rejects.toThrowError(DoctorError);
    await expect(
      inspectAgentscopeDoctor({
        configurationStore: {} as never,
        operationalStateStore: state.operationalStateStore,
        credentialRegistry: state.credentialRegistry,
        credentialResolutionContext: state.context,
        ownerState: () => "dead",
      }),
    ).rejects.toThrowError(DoctorError);
  });
});

describe("Agentscope Doctor repair", () => {
  it("reports and repairs only a provably dead configuration transaction", async () => {
    const state = await fixture();
    const crashing = createConfigurationStoreForTesting(
      state.home,
      destinations,
      {
        createTransactionId: () =>
          `configuration-transaction-v1-${"e".repeat(64)}`,
        afterStep: (step) => {
          if (step === "candidate-durable")
            throw new ConfigurationCrashSimulation();
        },
      },
    );
    await expect(
      writeConfigurationSnapshot(crashing, {
        expectedGeneration: null,
        candidate: emptySnapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);

    expect((await inspect(state, crashing, () => "live")).transaction).toEqual({
      state: "active",
    });
    expect(
      (await inspect(state, crashing, () => "unknown")).transaction,
    ).toEqual({ state: "owner-unknown" });
    const recoverable = await inspect(state, crashing);
    expect(recoverable.transaction).toEqual({
      state: "recoverable",
      committed: false,
      generation: null,
    });
    expect(recoverable.findings).toContainEqual({
      code: "doctor.transaction.recoverable",
      severity: "warning",
      suggestedAction: "repair-configuration-transaction",
    });
    await expect(
      repairDoctorConfigurationTransaction(crashing, () => "dead"),
    ).resolves.toEqual({
      recovered: true,
      committed: false,
      generation: null,
    });
  });

  it("reports and repairs only a provably dead operational-state writer", async () => {
    const state = await fixture();
    await mkdir(state.home.healthDirectory, { recursive: true });
    await writeFile(
      join(state.home.healthDirectory, "operational-state.lock"),
      `${JSON.stringify({
        version: 1,
        owner,
        token: "9".repeat(32),
      })}\n`,
    );
    expect(
      (await inspect(state, undefined, () => "live")).findings,
    ).toContainEqual({
      code: "doctor.operational-state.lock-active",
      severity: "info",
      suggestedAction: "retry",
    });
    expect(
      (await inspect(state, undefined, () => "unknown")).findings,
    ).toContainEqual({
      code: "doctor.operational-state.lock-owner-unknown",
      severity: "warning",
      suggestedAction: "retry",
    });
    const report = await inspect(state);
    expect(report.operationalState).toMatchObject({
      state: "available",
      writerLock: { state: "recoverable" },
    });
    expect(report.findings).toContainEqual({
      code: "doctor.operational-state.lock-recoverable",
      severity: "warning",
      suggestedAction: "repair-operational-state-lock",
    });
    await expect(
      repairDoctorOperationalStateLock(
        state.operationalStateStore,
        () => "dead",
      ),
    ).resolves.toEqual({ recovered: true });
    await writeFile(
      join(state.home.healthDirectory, "operational-state.lock"),
      "{}\n",
    );
    expect((await inspect(state)).findings).toContainEqual({
      code: "doctor.operational-state.lock-invalid",
      severity: "warning",
      suggestedAction: "retry",
    });
  });
});

describe("Agentscope Doctor credential mutation inspection", () => {
  it("reports a dead credential mutation intent without deleting it", async () => {
    const state = await fixture();
    const reference = createStoredCredentialReference(
      "linux-secret-service",
      referenceId,
      generationId,
    );
    await createCredentialMutationIntent(state.configurationStore, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: createCredentialOwnership({
        destinationType: "@agentscope/destination-example",
        connectionId,
        slot: "api-key",
      }),
      reference,
    });
    expect(
      (await inspect(state, undefined, () => "live")).findings,
    ).toContainEqual({
      code: "doctor.credential-mutation.active",
      severity: "info",
      suggestedAction: "retry",
    });
    expect(
      (await inspect(state, undefined, () => "unknown")).findings,
    ).toContainEqual({
      code: "doctor.credential-mutation.owner-unknown",
      severity: "warning",
      suggestedAction: "inspect-credential-mutation",
    });
    const report = await inspect(state);
    expect(report.credentialMutation).toEqual({ state: "recoverable" });
    expect(report.findings).toContainEqual({
      code: "doctor.credential-mutation.recoverable",
      severity: "warning",
      suggestedAction: "inspect-credential-mutation",
    });
    await expect(
      stat(join(state.home.mutationDirectory, "credential.lock")),
    ).resolves.toBeDefined();
    await writeFile(
      join(state.home.mutationDirectory, "credential.lock"),
      "{}\n",
    );
    expect((await inspect(state)).findings).toContainEqual({
      code: "doctor.credential-mutation.invalid",
      severity: "error",
      suggestedAction: "inspect-credential-mutation",
    });
  });
});

describe("Agentscope Doctor interrupted recovery claims", () => {
  it("requires reconciliation for a claim-only configuration transaction", async () => {
    const state = await fixture();
    const crashing = createConfigurationStoreForTesting(
      state.home,
      destinations,
      {
        afterStep: (step) => {
          if (step === "candidate-durable")
            throw new ConfigurationCrashSimulation();
        },
      },
    );
    await expect(
      writeConfigurationSnapshot(crashing, {
        expectedGeneration: null,
        candidate: emptySnapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);
    const fixed = join(state.home.mutationDirectory, "config.lock");
    await link(
      fixed,
      join(state.home.mutationDirectory, "config.recovery.lock"),
    );
    await unlink(fixed);
    const report = await inspect(state, crashing);
    expect(report.transaction).toEqual({ state: "reconciliation-required" });
    expect(report.findings).toContainEqual({
      code: "doctor.transaction.reconciliation-required",
      severity: "error",
      suggestedAction: "reconcile-recovery-claim",
    });
  });

  it("requires reconciliation for a claim-only credential intent", async () => {
    const state = await fixture();
    await createCredentialMutationIntent(state.configurationStore, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: createCredentialOwnership({
        destinationType: "@agentscope/destination-example",
        connectionId,
        slot: "api-key",
      }),
      reference: createStoredCredentialReference(
        "linux-secret-service",
        referenceId,
        generationId,
      ),
    });
    const fixed = join(state.home.mutationDirectory, "credential.lock");
    await link(
      fixed,
      join(state.home.mutationDirectory, "credential.recovery.lock"),
    );
    await unlink(fixed);
    const report = await inspect(state);
    expect(report.credentialMutation).toEqual({
      state: "reconciliation-required",
    });
    expect(report.findings).toContainEqual({
      code: "doctor.credential-mutation.reconciliation-required",
      severity: "error",
      suggestedAction: "reconcile-recovery-claim",
    });
  });

  it("requires reconciliation for a claim-only operational lock", async () => {
    const state = await fixture();
    await mkdir(state.home.healthDirectory, { recursive: true });
    const fixed = join(state.home.healthDirectory, "operational-state.lock");
    await writeFile(
      fixed,
      `${JSON.stringify({ version: 1, owner, token: "9".repeat(32) })}\n`,
    );
    await link(
      fixed,
      join(state.home.healthDirectory, "operational-state.recovery.lock"),
    );
    await unlink(fixed);
    const report = await inspect(state);
    expect(report.operationalState).toMatchObject({
      writerLock: { state: "reconciliation-required" },
    });
    expect(report.findings).toContainEqual({
      code: "doctor.operational-state.lock-reconciliation-required",
      severity: "error",
      suggestedAction: "reconcile-recovery-claim",
    });
  });
});

describe("Agentscope Doctor fixed failure states", () => {
  it("reports invalid and unsupported configuration and invalid operational state", async () => {
    const state = await fixture();
    await mkdir(state.home.healthDirectory, { recursive: true });
    await writeFile(state.home.configFile, "not-json");
    await writeFile(
      join(state.home.healthDirectory, "operational-state-v1.json"),
      "not-json",
    );
    let report = await inspect(state);
    expect(report.configuration).toEqual({ state: "invalid" });
    expect(report.operationalState).toEqual({ state: "invalid" });
    expect(report.findings).toContainEqual({
      code: "doctor.operational-state.invalid",
      severity: "warning",
      suggestedAction: "retry",
    });

    const unsupported = parseAgentscopeConfiguration(
      {
        configurationVersion: 2,
        generation: 0,
        destinations: {
          "@agentscope/destination-unknown": {
            namespaceVersion: 1,
            settingsVersion: 1,
            connections: [],
          },
        },
        routing: {
          version: 1,
          selectedConnectionIds: [],
          hookDeadlineMilliseconds: 2_000,
        },
        policy: { version: 1, reference: "policy-v1" },
      },
      destinations,
    );
    await writeFile(
      state.home.configFile,
      serializeAgentscopeConfiguration(unsupported),
    );
    report = await inspect(state);
    expect(report.configuration).toEqual({ state: "unsupported" });

    const unavailableState = await fixture();
    await mkdir(unavailableState.home.root, { recursive: true });
    const target = join(unavailableState.home.root, "config-target");
    await writeFile(target, serializeAgentscopeConfiguration(emptySnapshot(0)));
    await symlink(target, unavailableState.home.configFile);
    report = await inspect(unavailableState);
    expect(report.configuration).toEqual({ state: "unavailable" });
  });

  it("reports transaction conflicts, invalid evidence, and unavailable paths", async () => {
    const conflictState = await fixture();
    const crashing = createConfigurationStoreForTesting(
      conflictState.home,
      destinations,
      {
        createTransactionId: () =>
          `configuration-transaction-v1-${"f".repeat(64)}`,
        afterStep: (step) => {
          if (step === "candidate-durable")
            throw new ConfigurationCrashSimulation();
        },
      },
    );
    await expect(
      writeConfigurationSnapshot(crashing, {
        expectedGeneration: null,
        candidate: emptySnapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);
    await writeFile(
      conflictState.home.configFile,
      `${JSON.stringify(emptySnapshot(4).document)}\n`,
    );
    expect((await inspect(conflictState, crashing)).transaction).toEqual({
      state: "conflict",
    });

    const invalidState = await fixture();
    await mkdir(invalidState.home.mutationDirectory, { recursive: true });
    const lock = join(invalidState.home.mutationDirectory, "config.lock");
    await writeFile(lock, "{}\n");
    expect((await inspect(invalidState)).transaction).toEqual({
      state: "invalid",
    });
    await rm(lock);
    const target = join(invalidState.home.root, "lock-target");
    await writeFile(target, "{}\n");
    await symlink(target, lock);
    expect((await inspect(invalidState)).transaction).toEqual({
      state: "unavailable",
    });
  });
});
