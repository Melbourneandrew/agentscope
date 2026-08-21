import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineLocalResourceLifecycleDeclaration } from "./local-resource-lifecycle.js";
import {
  bindLocalResourceConfigurationAuthorityForCore,
  bindLocalResourceConfigurationAuthorityForInvocation,
  commitLocalResourceConfiguration,
  LocalResourceConfigurationCommitError,
  LocalResourceConfigurationAuthorityError,
  type LocalResourceConfigurationCommitEvidence,
} from "./local-resource-configuration-authority.js";
import {
  applyLocalResourceLifecyclePlan,
  applyLocalResourceMaintenancePlan,
  bindLocalResourceDoctorContextForCore,
  bindLocalResourceMaintenanceContextForCore,
  bindLocalResourceMaintenanceRecoveryContextForCore,
  completeLocalResourceLifecycle,
  compileLocalResourceLifecycleHandlerRegistry,
  defineLocalResourceLifecycleHandler,
  inspectLocalResourceLifecyclePlan,
  inspectLocalResourceDoctor,
  inspectLocalResourceMaintenancePlan,
  inspectRetainedLocalResourceDelete,
  isLocalResourceLifecycleHandlerRegistry,
  localResourceLifecycleHandlerRegistryUsesDestinationRegistry,
  getLocalResourceLifecycleHandlerCapability,
  LocalResourceLifecycleHandlerError,
  recoverLocalResourceLifecycle,
  recoverLocalResourceMaintenance,
  type LocalResourceLifecycleContext,
} from "./local-resource-handler.js";
import {
  bindLocalResourceLifecycleContextForCore,
  bindLocalResourceLifecycleRecoveryContextForCore,
  createLocalResourceLifecycleDeadlineForCore,
} from "./local-resource-handler.js";
import {
  compileDestinationRegistry,
  defineDestinationDescriptor,
} from "./descriptor.js";
import { createDestinationReporter } from "./reporter.js";

const schema = z.strictObject({ maximumTraceCount: z.number().int() });
void schema.shape;

const declaration = (
  destinationType = "@agentscope/destination-local-sqlite",
  operations: readonly (
    | "backup"
    | "configure"
    | "delete"
    | "doctor"
    | "recover"
    | "restore"
    | "unconfigure"
  )[] = ["configure", "delete", "recover", "unconfigure"],
  artifactFingerprintCharacter = "a",
) =>
  defineLocalResourceLifecycleDeclaration({
    artifactGrammarFingerprint: `sha256-${artifactFingerprintCharacter.repeat(64)}`,
    artifactGrammarVersion: 1,
    artifactKinds: ["active-database", "lifecycle-intent"],
    capabilityVersion: 1,
    destinationType,
    operations,
    receiptReasons: ["destination-busy"],
    recoveryHandlerId: `${destinationType}/lifecycle-v1`,
    settingKeys: ["maximumTraceCount"],
    settingsVersion: 1,
  });

const descriptor = (
  destinationType = "@agentscope/destination-local-sqlite",
  operations?: readonly (
    | "backup"
    | "configure"
    | "delete"
    | "doctor"
    | "recover"
    | "restore"
    | "unconfigure"
  )[],
  artifactFingerprintCharacter = "a",
) =>
  defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType,
    commandName: destinationType.endsWith("-alt")
      ? "local-sqlite-alt"
      : "local-sqlite",
    settingsVersion: 1,
    settingsSchema: schema,
    defaultSettings: { maximumTraceCount: 100 },
    credentialSlots: [],
    documentationPath: "/docs/local-sqlite",
    deliveryIdentitySupport: "duplicates-possible",
    localResourceLifecycle: declaration(
      destinationType,
      operations,
      artifactFingerprintCharacter,
    ),
    transport: { kind: "local" },
    createReporter: () =>
      createDestinationReporter({
        report: () => Promise.resolve({ outcome: "accepted" }),
      }),
  });

const context = (): LocalResourceLifecycleContext =>
  bindLocalResourceLifecycleContextForCore({
    operation: "configure",
    operationId: "1".repeat(32),
    destinationType: "@agentscope/destination-local-sqlite",
    connectionId: `destination-connection-v1-${"b".repeat(64)}`,
    connectionName: "local",
    owner: {
      processId: 123,
      processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
    },
    settings: { maximumTraceCount: 100 },
    expectedConfigurationGeneration: 1,
    candidateConfigurationGeneration: 2,
    expectedConfigurationDigest: `sha256-${"c".repeat(64)}`,
    candidateConfigurationDigest: `sha256-${"d".repeat(64)}`,
    signal: new AbortController().signal,
    deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
  });

// eslint-disable-next-line max-lines-per-function -- hostile authority cases share one exact branded fixture.
describe("local resource configuration authority", () => {
  it("commits one exact candidate once", async () => {
    const commit = vi.fn(() =>
      Promise.resolve({
        priorGeneration: 1,
        committedGeneration: 2,
        candidateDigest: `sha256-${"d".repeat(64)}`,
      }),
    );
    const authority = bindLocalResourceConfigurationAuthorityForCore({
      destinationType: context().destinationType,
      connectionId: context().connectionId,
      operationId: context().operationId,
      lifecycleFingerprint: `sha256-${"e".repeat(64)}`,
      recoveryHandlerId: "@agentscope/destination-local-sqlite/lifecycle-v1",
      priorGeneration: 1,
      candidateGeneration: 2,
      candidateDigest: `sha256-${"d".repeat(64)}`,
      commit,
    });
    const expected = {
      destinationType: context().destinationType,
      connectionId: context().connectionId,
      operationId: context().operationId,
      lifecycleFingerprint: `sha256-${"e".repeat(64)}`,
      recoveryHandlerId: "@agentscope/destination-local-sqlite/lifecycle-v1",
    };
    await expect(
      commitLocalResourceConfiguration(authority, expected),
    ).resolves.toEqual({
      priorGeneration: 1,
      committedGeneration: 2,
      candidateDigest: `sha256-${"d".repeat(64)}`,
    });
    await expect(
      commitLocalResourceConfiguration(authority, expected),
    ).rejects.toThrow(LocalResourceConfigurationAuthorityError);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("rejects copied, mismatched, malformed, and hostile authorities", async () => {
    let calls = 0;
    const input = {
      destinationType: context().destinationType,
      connectionId: context().connectionId,
      operationId: context().operationId,
      lifecycleFingerprint: `sha256-${"e".repeat(64)}`,
      recoveryHandlerId: "@agentscope/destination-local-sqlite/lifecycle-v1",
      priorGeneration: 1,
      candidateGeneration: 2,
      candidateDigest: `sha256-${"d".repeat(64)}`,
      commit: () => {
        calls += 1;
        return Promise.reject(new Error("CANARY"));
      },
    };
    const authority = bindLocalResourceConfigurationAuthorityForCore(input);
    await expect(
      commitLocalResourceConfiguration({ ...authority }, input),
    ).rejects.toThrow(LocalResourceConfigurationAuthorityError);
    await expect(
      commitLocalResourceConfiguration(authority, {
        ...input,
        operationId: "2".repeat(32),
      }),
    ).rejects.toThrow(LocalResourceConfigurationAuthorityError);
    expect(calls).toBe(0);
    await expect(
      commitLocalResourceConfiguration(authority, input),
    ).rejects.toThrow(LocalResourceConfigurationAuthorityError);
    expect(calls).toBe(1);

    let getterCalls = 0;
    const hostile = Object.defineProperty({ ...input }, "operationId", {
      get() {
        getterCalls += 1;
        return "1".repeat(32);
      },
    });
    expect(() =>
      bindLocalResourceConfigurationAuthorityForCore(hostile),
    ).toThrow(LocalResourceConfigurationAuthorityError);
    expect(getterCalls).toBe(0);
    for (const invalid of [
      null,
      [],
      { ...input, extra: true },
      { ...input, operationId: "0".repeat(32) },
      { ...input, destinationType: "invalid" },
      { ...input, connectionId: "invalid" },
      { ...input, lifecycleFingerprint: "invalid" },
      { ...input, recoveryHandlerId: "invalid" },
      { ...input, priorGeneration: -1 },
      { ...input, candidateGeneration: 4 },
      { ...input, commit: true },
    ])
      expect(() =>
        bindLocalResourceConfigurationAuthorityForCore(invalid as never),
      ).toThrow(LocalResourceConfigurationAuthorityError);

    const ambiguous = bindLocalResourceConfigurationAuthorityForCore({
      ...input,
      commit: () => Promise.reject(new LocalResourceConfigurationCommitError()),
    });
    await expect(
      commitLocalResourceConfiguration(ambiguous, input),
    ).rejects.toThrow(LocalResourceConfigurationCommitError);
    for (const evidence of [
      null,
      {},
      {
        priorGeneration: 1,
        committedGeneration: 2,
        candidateDigest: `sha256-${"d".repeat(64)}`,
        extra: true,
      },
      {
        priorGeneration: -1,
        committedGeneration: 2,
        candidateDigest: `sha256-${"d".repeat(64)}`,
      },
      {
        priorGeneration: 1,
        committedGeneration: 3,
        candidateDigest: `sha256-${"d".repeat(64)}`,
      },
      {
        priorGeneration: 1,
        committedGeneration: 2,
        candidateDigest: "invalid",
      },
    ]) {
      const malformed = bindLocalResourceConfigurationAuthorityForCore({
        ...input,
        commit: () => Promise.resolve(evidence as never),
      });
      await expect(
        commitLocalResourceConfiguration(malformed, input),
      ).rejects.toThrow(LocalResourceConfigurationAuthorityError);
    }
  });

  it("scopes invocation authority to cancellation and commit settlement", async () => {
    const expected = {
      destinationType: context().destinationType,
      connectionId: context().connectionId,
      operationId: context().operationId,
      lifecycleFingerprint: `sha256-${"e".repeat(64)}`,
      recoveryHandlerId: "@agentscope/destination-local-sqlite/lifecycle-v1",
    };
    const input = (
      commit: () => Promise<LocalResourceConfigurationCommitEvidence>,
    ) => ({
      ...expected,
      priorGeneration: 1,
      candidateGeneration: 2,
      candidateDigest: `sha256-${"d".repeat(64)}`,
      commit,
    });
    const evidence = {
      priorGeneration: 1,
      committedGeneration: 2,
      candidateDigest: `sha256-${"d".repeat(64)}`,
    };
    const active = new AbortController();
    const original = bindLocalResourceConfigurationAuthorityForCore(
      input(() => Promise.resolve(evidence)),
    );
    const scopedInvocation =
      bindLocalResourceConfigurationAuthorityForInvocation(
        original,
        active.signal,
      );
    const scoped = scopedInvocation.authority;
    await expect(
      commitLocalResourceConfiguration(scoped, expected),
    ).resolves.toEqual(evidence);
    expect(() =>
      bindLocalResourceConfigurationAuthorityForInvocation(
        original,
        active.signal,
      ),
    ).toThrow(LocalResourceConfigurationAuthorityError);
    expect(() =>
      bindLocalResourceConfigurationAuthorityForInvocation(
        { ...scoped },
        active.signal,
      ),
    ).toThrow(LocalResourceConfigurationAuthorityError);

    const aborted = new AbortController();
    const neverStarted = bindLocalResourceConfigurationAuthorityForInvocation(
      bindLocalResourceConfigurationAuthorityForCore(
        input(() => Promise.resolve(evidence)),
      ),
      aborted.signal,
    ).authority;
    aborted.abort();
    await expect(
      commitLocalResourceConfiguration(neverStarted, expected),
    ).rejects.toThrow(LocalResourceConfigurationAuthorityError);

    let release!: (value: LocalResourceConfigurationCommitEvidence) => void;
    const pending = new Promise<LocalResourceConfigurationCommitEvidence>(
      (resolve) => {
        release = resolve;
      },
    );
    const interrupted = new AbortController();
    const inFlight = bindLocalResourceConfigurationAuthorityForInvocation(
      bindLocalResourceConfigurationAuthorityForCore(input(() => pending)),
      interrupted.signal,
    ).authority;
    const committing = commitLocalResourceConfiguration(inFlight, expected);
    interrupted.abort();
    release(evidence);
    await expect(committing).rejects.toThrow(
      LocalResourceConfigurationCommitError,
    );
  });
});

// eslint-disable-next-line max-lines-per-function -- one exact fixture exercises the complete maintenance/Doctor family boundary.
describe("local resource maintenance and Doctor boundary", () => {
  const maintenanceDescriptor = descriptor(undefined, [
    "backup",
    "configure",
    "delete",
    "doctor",
    "recover",
    "restore",
    "unconfigure",
  ]);
  const destinationRegistry = compileDestinationRegistry([
    maintenanceDescriptor,
  ]);
  const capability = maintenanceDescriptor.localResourceLifecycle!;
  const unused = () => Promise.reject(new Error("unused"));
  const planEvidence = Object.freeze({
    namespaceFingerprint: `sha256-${"1".repeat(64)}`,
    physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
    displayPath: "/owned/local.sqlite",
    persistentDataNotice: true as const,
    retentionPolicy: Object.freeze({
      maximumAgeNanoseconds: "1",
      maximumTraceCount: 1,
      maximumPayloadBytes: 1,
      physicalCleanupTrigger: "next-authorized-mutation" as const,
    }),
  });
  const backupAuthority = Object.freeze({
    backupId: "3".repeat(32),
    receiptDigest: `sha256-${"4".repeat(64)}`,
    snapshotPhysicalIdentity: "dev:1:ino:3",
  });
  const handlerRegistry = (
    overrides: Readonly<{
      plan?: unknown;
      apply?: unknown;
      recover?: unknown;
      doctor?: unknown;
    }> = {},
  ) =>
    compileLocalResourceLifecycleHandlerRegistry(destinationRegistry, [
      defineLocalResourceLifecycleHandler({
        capability,
        complete: () => Promise.resolve(),
        inspectPlan: unused,
        inspectRetainedDelete: unused,
        apply: unused,
        recover: unused,
        inspectMaintenancePlan: (value) =>
          Promise.resolve(
            (overrides.plan === undefined
              ? {
                  planEvidence,
                  resourceSelector: value.resourceSelector,
                  selectedBackupAuthority:
                    value.operation === "restore" ? backupAuthority : null,
                }
              : overrides.plan) as never,
          ),
        applyMaintenance: (value) =>
          Promise.resolve(
            (overrides.apply === undefined
              ? value.operation === "backup"
                ? {
                    ok: true as const,
                    state: "backed-up" as const,
                    backupAuthority,
                  }
                : { ok: true as const, state: "restored" as const }
              : overrides.apply) as never,
          ),
        recoverMaintenance: () =>
          Promise.resolve(
            (overrides.recover === undefined
              ? { ok: true, state: "rolled-back" }
              : overrides.recover) as never,
          ),
        inspectDoctor: () =>
          Promise.resolve(
            (overrides.doctor === undefined
              ? {
                  state: "available",
                  lifecycleState: "clean",
                  databaseState: "present",
                  backupState: "available",
                  sharedLeaseCount: 0,
                  publishedBackupCount: 1,
                  retentionPolicy: planEvidence.retentionPolicy,
                  databaseDerivedRetention: {
                    cutoff: "unavailable",
                    clockContinuity: "unavailable",
                    rowCount: "unavailable",
                    payloadBytes: "unavailable",
                  },
                }
              : overrides.doctor) as never,
          ),
      }),
    ]);
  const input = (operation: "backup" | "restore") =>
    bindLocalResourceMaintenanceContextForCore({
      operation,
      operationId: "5".repeat(32),
      resourceSelector: "3".repeat(32),
      destinationType: capability.destinationType,
      connectionId: `destination-connection-v1-${"6".repeat(64)}`,
      connectionName: "local",
      owner: {
        processId: 123,
        processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
      },
      settings: { maximumTraceCount: 1 },
      configurationGeneration: 1,
      configurationDigest: `sha256-${"8".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
    });

  it("normalizes maintenance plans, results, recovery, and Doctor evidence", async () => {
    const registry = handlerRegistry();
    const backup = input("backup");
    const evidence = await inspectLocalResourceMaintenancePlan(
      registry,
      backup,
    );
    await expect(
      applyLocalResourceMaintenancePlan(registry, backup, evidence),
    ).resolves.toEqual({
      ok: true,
      state: "backed-up",
      backupAuthority,
    });
    const recovery = bindLocalResourceMaintenanceRecoveryContextForCore({
      operation: "backup",
      operationId: backup.operationId,
      resourceSelector: backup.resourceSelector,
      destinationType: backup.destinationType,
      connectionId: backup.connectionId,
      owner: backup.owner,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      configurationGeneration: backup.configurationGeneration,
      configurationDigest: backup.configurationDigest,
      signal: backup.signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
    });
    await expect(
      recoverLocalResourceMaintenance(registry, recovery),
    ).resolves.toEqual({ ok: true, state: "rolled-back" });
    const doctor = bindLocalResourceDoctorContextForCore({
      destinationType: backup.destinationType,
      connectionId: backup.connectionId,
      connectionName: backup.connectionName,
      settings: backup.settings,
      configurationGeneration: backup.configurationGeneration,
      configurationDigest: backup.configurationDigest,
      signal: backup.signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
    });
    await expect(
      inspectLocalResourceDoctor(registry, doctor),
    ).resolves.toMatchObject({
      state: "available",
      databaseDerivedRetention: { cutoff: "unavailable" },
    });
  });

  it("rejects accessor-backed context data without invoking caller code", () => {
    let calls = 0;
    const hostile = Object.defineProperty(
      { ...input("backup") },
      "resourceSelector",
      {
        enumerable: true,
        get: () => {
          calls += 1;
          return "3".repeat(32);
        },
      },
    );
    expect(() =>
      bindLocalResourceMaintenanceContextForCore(hostile as never),
    ).toThrow(LocalResourceLifecycleHandlerError);
    expect(calls).toBe(0);
  });

  it("requires maintenance and Doctor implementations for advertised operations", () => {
    expect(() =>
      compileLocalResourceLifecycleHandlerRegistry(destinationRegistry, [
        defineLocalResourceLifecycleHandler({
          capability,
          complete: unused,
          inspectPlan: unused,
          inspectRetainedDelete: unused,
          apply: unused,
          recover: unused,
        }),
      ]),
    ).toThrow(LocalResourceLifecycleHandlerError);
  });

  it("reconstructs exact maintenance, recovery, and Doctor inputs", () => {
    const branded = input("backup");
    const { localResourceMaintenanceContext: _brand, ...raw } = branded;
    void _brand;
    for (const candidate of [
      null,
      { ...raw, extra: true },
      { ...raw, operation: "delete" },
      { ...raw, destinationType: "bad" },
      { ...raw, connectionName: "" },
      { ...raw, owner: { ...raw.owner, processId: 0 } },
    ])
      expect(() =>
        bindLocalResourceMaintenanceContextForCore(candidate as never),
      ).toThrow(LocalResourceLifecycleHandlerError);

    const recovery = {
      operation: "backup" as const,
      operationId: branded.operationId,
      resourceSelector: branded.resourceSelector,
      destinationType: branded.destinationType,
      connectionId: branded.connectionId,
      owner: branded.owner,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      configurationGeneration: branded.configurationGeneration,
      configurationDigest: branded.configurationDigest,
      signal: branded.signal,
      deadline: branded.deadline,
    };
    for (const candidate of [
      { ...recovery, operationId: "bad" },
      { ...recovery, lifecycleFingerprint: "bad" },
      { ...recovery, recoveryHandlerId: "" },
    ])
      expect(() =>
        bindLocalResourceMaintenanceRecoveryContextForCore(candidate as never),
      ).toThrow(LocalResourceLifecycleHandlerError);

    const doctor = {
      destinationType: branded.destinationType,
      connectionId: branded.connectionId,
      connectionName: branded.connectionName,
      settings: branded.settings,
      configurationGeneration: branded.configurationGeneration,
      configurationDigest: branded.configurationDigest,
      signal: branded.signal,
      deadline: branded.deadline,
    };
    expect(() =>
      bindLocalResourceDoctorContextForCore({
        ...doctor,
        connectionName: "",
      }),
    ).toThrow(LocalResourceLifecycleHandlerError);
  });

  it("fails closed on malformed maintenance plan and result DTOs", async () => {
    const backup = input("backup");
    const restore = input("restore");
    const invalidPlans: unknown[] = [
      null,
      { planEvidence, resourceSelector: backup.resourceSelector },
      {
        planEvidence,
        resourceSelector: "9".repeat(32),
        selectedBackupAuthority: null,
      },
      {
        planEvidence,
        resourceSelector: backup.resourceSelector,
        selectedBackupAuthority: backupAuthority,
      },
      {
        planEvidence,
        resourceSelector: backup.resourceSelector,
        selectedBackupAuthority: {
          ...backupAuthority,
          backupId: "9".repeat(32),
        },
      },
    ];
    for (const plan of invalidPlans)
      await expect(
        inspectLocalResourceMaintenancePlan(handlerRegistry({ plan }), backup),
      ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    for (const selectedBackupAuthority of [
      null,
      "bad",
      { ...backupAuthority, extra: true },
      { ...backupAuthority, receiptDigest: "bad" },
      { ...backupAuthority, backupId: "9".repeat(32) },
    ])
      await expect(
        inspectLocalResourceMaintenancePlan(
          handlerRegistry({
            plan: {
              planEvidence,
              resourceSelector: restore.resourceSelector,
              selectedBackupAuthority,
            },
          }),
          restore,
        ),
      ).rejects.toThrow(LocalResourceLifecycleHandlerError);

    const evidence = await inspectLocalResourceMaintenancePlan(
      handlerRegistry(),
      backup,
    );
    const invalidResults: unknown[] = [
      null,
      { ok: true, state: "backed-up" },
      {
        ok: true,
        state: "backed-up",
        backupAuthority: { ...backupAuthority, backupId: "9".repeat(32) },
      },
      { ok: true, state: "restored" },
      { ok: false, state: "bad", code: "bad" },
    ];
    for (const apply of invalidResults)
      await expect(
        applyLocalResourceMaintenancePlan(
          handlerRegistry({ apply }),
          backup,
          evidence,
        ),
      ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    const restoreEvidence = await inspectLocalResourceMaintenancePlan(
      handlerRegistry(),
      restore,
    );
    await expect(
      applyLocalResourceMaintenancePlan(
        handlerRegistry({
          apply: {
            ok: true,
            state: "backed-up",
            backupAuthority,
          },
        }),
        restore,
        restoreEvidence,
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    await expect(
      applyLocalResourceMaintenancePlan(
        handlerRegistry({
          apply: { ok: false, state: "unchanged", code: "capacity" },
        }),
        backup,
        evidence,
      ),
    ).resolves.toEqual({ ok: false, state: "unchanged", code: "capacity" });
  });

  it("fails closed on malformed Doctor DTOs and unbranded invocation", async () => {
    const backup = input("backup");
    const doctor = bindLocalResourceDoctorContextForCore({
      destinationType: backup.destinationType,
      connectionId: backup.connectionId,
      connectionName: backup.connectionName,
      settings: backup.settings,
      configurationGeneration: backup.configurationGeneration,
      configurationDigest: backup.configurationDigest,
      signal: backup.signal,
      deadline: backup.deadline,
    });
    const baseInspection = await inspectLocalResourceDoctor(
      handlerRegistry(),
      doctor,
    );
    for (const result of [
      null,
      { ...baseInspection, extra: true },
      { ...baseInspection, state: "bad" },
      { ...baseInspection, sharedLeaseCount: 65 },
      { ...baseInspection, retentionPolicy: { maximumAgeNanoseconds: "0" } },
      { ...baseInspection, databaseDerivedRetention: null },
      {
        ...baseInspection,
        databaseDerivedRetention: {
          ...baseInspection.databaseDerivedRetention,
          cutoff: "available",
        },
      },
    ])
      await expect(
        inspectLocalResourceDoctor(handlerRegistry({ doctor: result }), doctor),
      ).rejects.toThrow(LocalResourceLifecycleHandlerError);

    await expect(
      inspectLocalResourceMaintenancePlan(handlerRegistry(), {
        ...backup,
      }),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    await expect(
      applyLocalResourceMaintenancePlan(
        handlerRegistry(),
        { ...backup },
        {
          planEvidence,
          resourceSelector: backup.resourceSelector,
          selectedBackupAuthority: null,
        },
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    const missing = bindLocalResourceMaintenanceContextForCore({
      operation: backup.operation,
      operationId: backup.operationId,
      resourceSelector: backup.resourceSelector,
      destinationType: "@agentscope/destination-missing",
      connectionId: backup.connectionId,
      connectionName: backup.connectionName,
      owner: backup.owner,
      settings: backup.settings,
      configurationGeneration: backup.configurationGeneration,
      configurationDigest: backup.configurationDigest,
      signal: backup.signal,
      deadline: backup.deadline,
    });
    await expect(
      inspectLocalResourceMaintenancePlan(handlerRegistry(), missing),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    await expect(
      applyLocalResourceMaintenancePlan(handlerRegistry(), missing, {
        planEvidence,
        resourceSelector: missing.resourceSelector,
        selectedBackupAuthority: null,
      }),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    const recovery = bindLocalResourceMaintenanceRecoveryContextForCore({
      operation: backup.operation,
      operationId: backup.operationId,
      resourceSelector: backup.resourceSelector,
      destinationType: backup.destinationType,
      connectionId: backup.connectionId,
      owner: backup.owner,
      lifecycleFingerprint: `sha256-${"9".repeat(64)}`,
      recoveryHandlerId: capability.recoveryHandlerId,
      configurationGeneration: backup.configurationGeneration,
      configurationDigest: backup.configurationDigest,
      signal: backup.signal,
      deadline: backup.deadline,
    });
    await expect(
      recoverLocalResourceMaintenance(handlerRegistry(), { ...recovery }),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    await expect(
      recoverLocalResourceMaintenance(handlerRegistry(), recovery),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    await expect(
      inspectLocalResourceDoctor(handlerRegistry(), { ...doctor }),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    const missingDoctor = bindLocalResourceDoctorContextForCore({
      destinationType: missing.destinationType,
      connectionId: missing.connectionId,
      connectionName: missing.connectionName,
      settings: missing.settings,
      configurationGeneration: missing.configurationGeneration,
      configurationDigest: missing.configurationDigest,
      signal: missing.signal,
      deadline: missing.deadline,
    });
    await expect(
      inspectLocalResourceDoctor(handlerRegistry(), missingDoctor),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
  });
});

// eslint-disable-next-line max-lines-per-function -- registry, retained, recovery, and hostile DTO matrices share one descriptor authority.
describe("local resource lifecycle handler registry", () => {
  it("binds all-and-only exact descriptor capabilities", async () => {
    const registry = compileDestinationRegistry([descriptor()]);
    const capability = registry.descriptors[0]!.localResourceLifecycle!;
    const inspectPlan = vi.fn(() =>
      Promise.resolve({
        namespaceFingerprint: `sha256-${"1".repeat(64)}`,
        physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
        displayPath: "/tmp/agentscope/destinations/local-sqlite",
        persistentDataNotice: true as const,
        retentionPolicy: Object.freeze({
          maximumAgeNanoseconds: "2592000000000000",
          maximumTraceCount: 10_000,
          maximumPayloadBytes: 1_073_741_824,
          physicalCleanupTrigger: "next-authorized-mutation" as const,
        }),
      }),
    );
    const apply = vi.fn(() =>
      Promise.resolve({ ok: true as const, state: "configured" as const }),
    );
    const complete = vi.fn(() => Promise.resolve());
    const handler = defineLocalResourceLifecycleHandler({
      capability,
      complete,
      inspectPlan,
      inspectRetainedDelete: () => Promise.resolve(null),
      apply,
      recover: () => Promise.reject(new Error("unused")),
    });
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    expect(isLocalResourceLifecycleHandlerRegistry(handlers)).toBe(true);
    expect(isLocalResourceLifecycleHandlerRegistry({ ...handlers })).toBe(
      false,
    );
    expect(
      localResourceLifecycleHandlerRegistryUsesDestinationRegistry(
        handlers,
        registry,
      ),
    ).toBe(true);
    expect(
      getLocalResourceLifecycleHandlerCapability(
        handlers,
        capability.destinationType,
      ),
    ).toBe(capability);
    expect(
      getLocalResourceLifecycleHandlerCapability(handlers, "missing"),
    ).toBeUndefined();
    const evidence = await inspectLocalResourceLifecyclePlan(
      handlers,
      context(),
    );
    expect(evidence.persistentDataNotice).toBe(true);
    const authority = bindLocalResourceConfigurationAuthorityForCore({
      destinationType: context().destinationType,
      connectionId: context().connectionId,
      operationId: context().operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: 1,
      candidateGeneration: 2,
      candidateDigest: context().candidateConfigurationDigest,
      commit: () => Promise.reject(new Error("unused")),
    });
    await expect(
      applyLocalResourceLifecyclePlan(handlers, context(), evidence, authority),
    ).resolves.toEqual({ ok: true, state: "configured" });
    await expect(
      applyLocalResourceLifecyclePlan(
        handlers,
        context(),
        evidence,
        authority,
        {
          receiptDigest: `sha256-${"3".repeat(64)}`,
          databaseFamilyPhysicalIdentity: "dev:1:ino:2",
        },
      ),
    ).resolves.toEqual({ ok: true, state: "configured" });
    expect(inspectPlan).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledTimes(2);
    const currentContext = context();
    await completeLocalResourceLifecycle(handlers, currentContext);
    expect(complete).toHaveBeenCalledOnce();
    await expect(
      completeLocalResourceLifecycle(handlers, { ...currentContext }),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
  });

  it("rejects missing, duplicate, copied, executable, and mismatched handlers", () => {
    const registry = compileDestinationRegistry([descriptor()]);
    const capability = registry.descriptors[0]!.localResourceLifecycle!;
    const implementation = {
      capability,
      complete: () => Promise.resolve(),
      inspectPlan: () => Promise.reject(new Error("unused")),
      inspectRetainedDelete: () => Promise.resolve(null),
      apply: () => Promise.reject(new Error("unused")),
      recover: () => Promise.reject(new Error("unused")),
    };
    const handler = defineLocalResourceLifecycleHandler(implementation);
    expect(() =>
      compileLocalResourceLifecycleHandlerRegistry(registry, []),
    ).toThrow(LocalResourceLifecycleHandlerError);
    expect(() =>
      compileLocalResourceLifecycleHandlerRegistry(registry, null as never),
    ).toThrow(LocalResourceLifecycleHandlerError);
    const sparse = new Array(1) as never;
    expect(() =>
      compileLocalResourceLifecycleHandlerRegistry(registry, sparse),
    ).toThrow(LocalResourceLifecycleHandlerError);
    expect(() =>
      compileLocalResourceLifecycleHandlerRegistry(registry, [
        handler,
        handler,
      ]),
    ).toThrow(LocalResourceLifecycleHandlerError);
    expect(() =>
      compileLocalResourceLifecycleHandlerRegistry(registry, [{ ...handler }]),
    ).toThrow(LocalResourceLifecycleHandlerError);
    expect(() =>
      compileLocalResourceLifecycleHandlerRegistry(registry, [null as never]),
    ).toThrow(LocalResourceLifecycleHandlerError);
    const driftedRegistry = compileDestinationRegistry([
      descriptor(capability.destinationType, undefined, "b"),
    ]);
    expect(() =>
      compileLocalResourceLifecycleHandlerRegistry(driftedRegistry, [handler]),
    ).toThrow(LocalResourceLifecycleHandlerError);
    const otherRegistry = compileDestinationRegistry([
      descriptor("@agentscope/destination-other"),
    ]);
    const otherCapability =
      otherRegistry.descriptors[0]!.localResourceLifecycle!;
    const otherHandler = defineLocalResourceLifecycleHandler({
      ...implementation,
      capability: otherCapability,
    });
    expect(() =>
      compileLocalResourceLifecycleHandlerRegistry(registry, [otherHandler]),
    ).toThrow(LocalResourceLifecycleHandlerError);
    let calls = 0;
    const hostile = Object.defineProperty({ ...implementation }, "apply", {
      get() {
        calls += 1;
        return implementation.apply;
      },
    });
    expect(() => defineLocalResourceLifecycleHandler(hostile)).toThrow(
      LocalResourceLifecycleHandlerError,
    );
    expect(calls).toBe(0);
    for (const invalid of [
      null,
      [],
      { ...implementation, extra: true },
      { ...implementation, apply: true },
      { ...implementation, inspectPlan: true },
      { ...implementation, capability: declaration() },
    ])
      expect(() =>
        defineLocalResourceLifecycleHandler(invalid as never),
      ).toThrow(LocalResourceLifecycleHandlerError);
  });

  // eslint-disable-next-line max-lines-per-function -- exact malformed plan, context, apply, and recovery matrices share one handler fixture.
  it("rejects malformed deadlines, contexts, evidence, and handler results", async () => {
    for (const invalid of [0, -1, 60_001, Number.NaN])
      expect(() =>
        createLocalResourceLifecycleDeadlineForCore(invalid),
      ).toThrow(LocalResourceLifecycleHandlerError);
    const registry = compileDestinationRegistry([descriptor()]);
    const capability = registry.descriptors[0]!.localResourceLifecycle!;
    let planValue: unknown = null;
    let applyValue: unknown = null;
    let recoverValue: unknown = null;
    let applyRejects = false;
    let recoverRejects = false;
    const handler = defineLocalResourceLifecycleHandler({
      capability,
      complete: () => Promise.resolve(),
      inspectPlan: () => Promise.resolve(planValue as never),
      inspectRetainedDelete: () => Promise.resolve(null),
      apply: () =>
        applyRejects
          ? Promise.reject(new Error("apply-CANARY"))
          : Promise.resolve(applyValue as never),
      recover: () =>
        recoverRejects
          ? Promise.reject(new Error("recover-CANARY"))
          : Promise.resolve(recoverValue as never),
    });
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    for (const invalid of [
      null,
      {},
      {
        namespaceFingerprint: "invalid",
        physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
        displayPath: "/owned",
        persistentDataNotice: true,
        retentionPolicy: {},
      },
      {
        namespaceFingerprint: `sha256-${"1".repeat(64)}`,
        physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
        displayPath: "/owned",
        persistentDataNotice: true,
        retentionPolicy: null,
      },
      {
        namespaceFingerprint: `sha256-${"1".repeat(64)}`,
        physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
        displayPath: "/owned",
        persistentDataNotice: true,
        retentionPolicy: {
          maximumAgeNanoseconds: "01",
          maximumTraceCount: 0,
          maximumPayloadBytes: 0,
          physicalCleanupTrigger: "future",
        },
      },
      {
        namespaceFingerprint: `sha256-${"1".repeat(64)}`,
        physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
        displayPath: "/owned",
        persistentDataNotice: true,
        retentionPolicy: {
          maximumAgeNanoseconds: "1",
          maximumTraceCount: 1,
          maximumPayloadBytes: 1,
          physicalCleanupTrigger: "next-authorized-mutation",
          extra: true,
        },
      },
    ]) {
      planValue = invalid;
      await expect(
        inspectLocalResourceLifecyclePlan(handlers, context()),
      ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    }
    const evidence = {
      namespaceFingerprint: `sha256-${"1".repeat(64)}`,
      physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
      displayPath: "/owned",
      persistentDataNotice: true as const,
      retentionPolicy: {
        maximumAgeNanoseconds: "1",
        maximumTraceCount: 1,
        maximumPayloadBytes: 1,
        physicalCleanupTrigger: "next-authorized-mutation" as const,
      },
    };
    const value = context();
    await expect(
      inspectLocalResourceLifecyclePlan(handlers, { ...value }),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    const authority = bindLocalResourceConfigurationAuthorityForCore({
      destinationType: value.destinationType,
      connectionId: value.connectionId,
      operationId: value.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: 1,
      candidateGeneration: 2,
      candidateDigest: value.candidateConfigurationDigest,
      commit: () => Promise.reject(new Error("unused")),
    });
    for (const invalid of [
      null,
      {},
      { ok: true, state: "future" },
      { ok: false, state: "future", code: "future" },
    ]) {
      applyValue = invalid;
      await expect(
        applyLocalResourceLifecyclePlan(handlers, value, evidence, authority),
      ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    }
    await expect(
      applyLocalResourceLifecyclePlan(
        handlers,
        { ...value },
        evidence,
        authority,
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    const recovery = bindLocalResourceLifecycleRecoveryContextForCore({
      operation: "configure",
      operationId: value.operationId,
      destinationType: value.destinationType,
      connectionId: value.connectionId,
      owner: value.owner,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      expectedConfigurationGeneration: 1,
      expectedConfigurationDigest: value.expectedConfigurationDigest,
      authorizedCandidates: [
        { generation: 2, digest: value.candidateConfigurationDigest },
      ],
      configurationState: "prior",
      signal: value.signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
    });
    for (const invalid of [null, {}, { ok: true, state: "future" }]) {
      recoverValue = invalid;
      await expect(
        recoverLocalResourceLifecycle(handlers, recovery),
      ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    }
    await expect(
      recoverLocalResourceLifecycle(handlers, { ...recovery }),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    applyRejects = true;
    await expect(
      applyLocalResourceLifecyclePlan(handlers, value, evidence, authority),
    ).rejects.toThrow("apply-CANARY");
    recoverRejects = true;
    await expect(
      recoverLocalResourceLifecycle(handlers, recovery),
    ).rejects.toThrow("recover-CANARY");
  });

  it("contains synchronous, non-Promise, aborted, rejected, and hanging callbacks", async () => {
    const registry = compileDestinationRegistry([descriptor()]);
    const capability = registry.descriptors[0]!.localResourceLifecycle!;
    let behavior:
      "abort" | "hang" | "non-promise" | "reject" | "reject-error" | "throw" =
      "throw";
    let controller = new AbortController();
    const handler = defineLocalResourceLifecycleHandler({
      capability,
      complete: () => Promise.resolve(),
      inspectPlan: (() => {
        if (behavior === "throw") throw new Error("CANARY");
        if (behavior === "non-promise") return true;
        if (behavior === "reject")
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- hostile callback deliberately rejects a non-Error.
          return Promise.reject("CANARY");
        if (behavior === "reject-error")
          return Promise.reject(new Error("CANARY"));
        if (behavior === "abort") controller.abort();
        return new Promise(() => undefined);
      }) as never,
      inspectRetainedDelete: () => Promise.resolve(null),
      apply: () => Promise.reject(new Error("unused")),
      recover: () => Promise.reject(new Error("unused")),
    });
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    const withSignal = (signal: AbortSignal, timeout = 10_000) => {
      const value = context();
      return bindLocalResourceLifecycleContextForCore({
        operation: value.operation,
        operationId: value.operationId,
        destinationType: value.destinationType,
        connectionId: value.connectionId,
        connectionName: value.connectionName,
        owner: value.owner,
        settings: value.settings,
        expectedConfigurationGeneration: value.expectedConfigurationGeneration,
        candidateConfigurationGeneration:
          value.candidateConfigurationGeneration,
        expectedConfigurationDigest: value.expectedConfigurationDigest,
        candidateConfigurationDigest: value.candidateConfigurationDigest,
        signal,
        deadline: createLocalResourceLifecycleDeadlineForCore(timeout),
      });
    };
    for (const value of ["throw", "non-promise", "reject"] as const) {
      behavior = value;
      await expect(
        inspectLocalResourceLifecyclePlan(
          handlers,
          withSignal(new AbortController().signal),
        ),
      ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    }
    behavior = "reject-error";
    await expect(
      inspectLocalResourceLifecyclePlan(
        handlers,
        withSignal(new AbortController().signal),
      ),
    ).rejects.toThrow("CANARY");
    behavior = "abort";
    controller = new AbortController();
    await expect(
      inspectLocalResourceLifecyclePlan(
        handlers,
        withSignal(controller.signal),
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    behavior = "hang";
    await expect(
      inspectLocalResourceLifecyclePlan(
        handlers,
        withSignal(new AbortController().signal, 1),
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      inspectLocalResourceLifecyclePlan(handlers, withSignal(aborted.signal)),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
  });

  // eslint-disable-next-line max-lines-per-function -- one cancellation fixture proves both fulfilled and rejected callback settlement boundaries.
  it("joins cancelled mutations and revokes their configuration authority", async () => {
    const registry = compileDestinationRegistry([descriptor()]);
    const capability = registry.descriptors[0]!.localResourceLifecycle!;
    const source = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let releaseComplete!: () => void;
    let enterComplete!: () => void;
    const completeBlocked = new Promise<void>((resolve) => {
      releaseComplete = resolve;
    });
    const completeEntered = new Promise<void>((resolve) => {
      enterComplete = resolve;
    });
    let lateAuthorityDenied = false;
    const handler = defineLocalResourceLifecycleHandler({
      capability,
      complete: async () => {
        enterComplete();
        await completeBlocked;
        throw new Error("CANARY");
      },
      inspectPlan: () => Promise.reject(new Error("unused")),
      inspectRetainedDelete: () => Promise.resolve(null),
      apply: async (value) => {
        entered();
        await blocked;
        try {
          await commitLocalResourceConfiguration(value.configurationAuthority, {
            destinationType: value.destinationType,
            connectionId: value.connectionId,
            operationId: value.operationId,
            lifecycleFingerprint: capability.fingerprint,
            recoveryHandlerId: capability.recoveryHandlerId,
          });
        } catch (error) {
          lateAuthorityDenied =
            error instanceof LocalResourceConfigurationAuthorityError;
        }
        return { ok: true, state: "configured" };
      },
      recover: () => Promise.reject(new Error("unused")),
    });
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    const base = context();
    const value = bindLocalResourceLifecycleContextForCore({
      operation: base.operation,
      operationId: base.operationId,
      destinationType: base.destinationType,
      connectionId: base.connectionId,
      connectionName: base.connectionName,
      owner: base.owner,
      settings: base.settings,
      expectedConfigurationGeneration: base.expectedConfigurationGeneration,
      candidateConfigurationGeneration: base.candidateConfigurationGeneration,
      expectedConfigurationDigest: base.expectedConfigurationDigest,
      candidateConfigurationDigest: base.candidateConfigurationDigest,
      signal: source.signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
    });
    let commits = 0;
    const authority = bindLocalResourceConfigurationAuthorityForCore({
      destinationType: value.destinationType,
      connectionId: value.connectionId,
      operationId: value.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: 1,
      candidateGeneration: 2,
      candidateDigest: value.candidateConfigurationDigest,
      commit: () => {
        commits += 1;
        return Promise.resolve({
          priorGeneration: 1,
          committedGeneration: 2,
          candidateDigest: value.candidateConfigurationDigest,
        });
      },
    });
    const execution = applyLocalResourceLifecyclePlan(
      handlers,
      value,
      {
        namespaceFingerprint: `sha256-${"1".repeat(64)}`,
        physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
        displayPath: "/owned",
        persistentDataNotice: true,
        retentionPolicy: {
          maximumAgeNanoseconds: "1",
          maximumTraceCount: 1,
          maximumPayloadBytes: 1,
          physicalCleanupTrigger: "next-authorized-mutation",
        },
      },
      authority,
    );
    await didEnter;
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    source.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(execution).rejects.toThrow(LocalResourceLifecycleHandlerError);
    expect(lateAuthorityDenied).toBe(true);
    expect(commits).toBe(0);

    const completeSource = new AbortController();
    const completeBase = context();
    const completeContext = bindLocalResourceLifecycleContextForCore({
      operation: completeBase.operation,
      operationId: completeBase.operationId,
      destinationType: completeBase.destinationType,
      connectionId: completeBase.connectionId,
      connectionName: completeBase.connectionName,
      owner: completeBase.owner,
      settings: completeBase.settings,
      expectedConfigurationGeneration:
        completeBase.expectedConfigurationGeneration,
      candidateConfigurationGeneration:
        completeBase.candidateConfigurationGeneration,
      expectedConfigurationDigest: completeBase.expectedConfigurationDigest,
      candidateConfigurationDigest: completeBase.candidateConfigurationDigest,
      signal: completeSource.signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
    });
    const completing = completeLocalResourceLifecycle(
      handlers,
      completeContext,
    );
    await completeEntered;
    completeSource.abort();
    releaseComplete();
    await expect(completing).rejects.toThrow(
      LocalResourceLifecycleHandlerError,
    );
  });

  it("joins a detached configuration commit before mutation settlement", async () => {
    const registry = compileDestinationRegistry([descriptor()]);
    const capability = registry.descriptors[0]!.localResourceLifecycle!;
    let detachedError: unknown;
    const handler = defineLocalResourceLifecycleHandler({
      capability,
      complete: () => Promise.resolve(),
      inspectPlan: () => Promise.reject(new Error("unused")),
      inspectRetainedDelete: () => Promise.resolve(null),
      apply: (value) => {
        void commitLocalResourceConfiguration(value.configurationAuthority, {
          destinationType: value.destinationType,
          connectionId: value.connectionId,
          operationId: value.operationId,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
        }).catch((error: unknown) => {
          detachedError = error;
        });
        return Promise.resolve({ ok: true, state: "configured" });
      },
      recover: () => Promise.reject(new Error("unused")),
    });
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    const value = context();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let durableMutation = false;
    const authority = bindLocalResourceConfigurationAuthorityForCore({
      destinationType: value.destinationType,
      connectionId: value.connectionId,
      operationId: value.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: 1,
      candidateGeneration: 2,
      candidateDigest: value.candidateConfigurationDigest,
      commit: async () => {
        await blocked;
        durableMutation = true;
        return {
          priorGeneration: 1,
          committedGeneration: 2,
          candidateDigest: value.candidateConfigurationDigest,
        };
      },
    });
    const execution = applyLocalResourceLifecyclePlan(
      handlers,
      value,
      {
        namespaceFingerprint: `sha256-${"1".repeat(64)}`,
        physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
        displayPath: "/owned",
        persistentDataNotice: true,
        retentionPolicy: {
          maximumAgeNanoseconds: "1",
          maximumTraceCount: 1,
          maximumPayloadBytes: 1,
          physicalCleanupTrigger: "next-authorized-mutation",
        },
      },
      authority,
    );
    let settled = false;
    void execution.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect({ durableMutation, settled }).toEqual({
      durableMutation: false,
      settled: false,
    });
    release();
    await expect(execution).resolves.toEqual({
      ok: true,
      state: "configured",
    });
    expect({ detachedError, durableMutation, settled }).toEqual({
      detachedError: undefined,
      durableMutation: true,
      settled: true,
    });
  });

  // eslint-disable-next-line max-lines-per-function -- hostile branded and retained DTO matrices share one exact registry fixture.
  it("fails closed at every branded context and retained-authority boundary", async () => {
    const base = context();
    for (const invalid of [
      { ...base, operation: "future" },
      { ...base, operationId: "0".repeat(32) },
      { ...base, candidateConfigurationGeneration: 4 },
      { ...base, deadline: { expiresAtMonotonicMilliseconds: 1 } },
    ])
      expect(() =>
        bindLocalResourceLifecycleContextForCore(invalid as never),
      ).toThrow(LocalResourceLifecycleHandlerError);
    const recoveryInput = {
      operation: "configure" as const,
      operationId: base.operationId,
      destinationType: base.destinationType,
      connectionId: base.connectionId,
      owner: base.owner,
      lifecycleFingerprint: `sha256-${"1".repeat(64)}`,
      recoveryHandlerId: "@agentscope/destination-local-sqlite/lifecycle-v1",
      expectedConfigurationGeneration: 1,
      expectedConfigurationDigest: base.expectedConfigurationDigest,
      authorizedCandidates: [
        { generation: 2, digest: base.candidateConfigurationDigest },
      ],
      configurationState: "prior" as const,
      signal: base.signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
    };
    for (const invalid of [
      { ...recoveryInput, configurationState: "future" },
      { ...recoveryInput, authorizedCandidates: [] },
      {
        ...recoveryInput,
        authorizedCandidates: [{ generation: 3, digest: "invalid" }],
      },
    ])
      expect(() =>
        bindLocalResourceLifecycleRecoveryContextForCore(invalid as never),
      ).toThrow(LocalResourceLifecycleHandlerError);

    const registry = compileDestinationRegistry([descriptor()]);
    const capability = registry.descriptors[0]!.localResourceLifecycle!;
    let retained: unknown = null;
    let applyResult: unknown = {
      ok: false,
      state: "prepared",
      code: "busy",
    };
    const handler = defineLocalResourceLifecycleHandler({
      capability,
      complete: () => Promise.resolve(),
      inspectPlan: () =>
        Promise.resolve({
          namespaceFingerprint: `sha256-${"1".repeat(64)}`,
          physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
          displayPath: "/owned",
          persistentDataNotice: true,
          retentionPolicy: {
            maximumAgeNanoseconds: "1",
            maximumTraceCount: 1,
            maximumPayloadBytes: 1,
            physicalCleanupTrigger: "next-authorized-mutation",
          },
        }),
      inspectRetainedDelete: () => Promise.resolve(retained as never),
      apply: () => Promise.resolve(applyResult as never),
      recover: () => Promise.resolve(applyResult as never),
    });
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    await expect(
      inspectRetainedLocalResourceDelete(
        handlers,
        "INVALID",
        base.signal,
        createLocalResourceLifecycleDeadlineForCore(10_000),
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    await expect(
      inspectRetainedLocalResourceDelete(
        handlers,
        base.connectionId,
        base.signal,
        createLocalResourceLifecycleDeadlineForCore(10_000),
      ),
    ).resolves.toBeNull();
    for (const invalid of [
      true,
      {},
      {
        destinationType: "invalid",
        connectionId: "invalid",
        connectionName: "local",
        planEvidence: {},
        retainedAuthority: {},
      },
      {
        destinationType: capability.destinationType,
        connectionId: base.connectionId,
        connectionName: "local",
        planEvidence: {},
        retainedAuthority: null,
      },
      {
        destinationType: capability.destinationType,
        connectionId: base.connectionId,
        connectionName: "local",
        planEvidence: {},
        retainedAuthority: {},
      },
      {
        destinationType: capability.destinationType,
        connectionId: base.connectionId,
        connectionName: "retained",
        planEvidence: {
          namespaceFingerprint: `sha256-${"1".repeat(64)}`,
          physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
          displayPath: "/owned",
          persistentDataNotice: true,
          retentionPolicy: {
            maximumAgeNanoseconds: "1",
            maximumTraceCount: 1,
            maximumPayloadBytes: 1,
            physicalCleanupTrigger: "next-authorized-mutation",
          },
        },
        retainedAuthority: {
          receiptDigest: "invalid",
          databaseFamilyPhysicalIdentity: "invalid value",
        },
      },
      {
        destinationType: capability.destinationType,
        connectionId: base.connectionId,
        connectionName: "retained",
        planEvidence: {
          namespaceFingerprint: `sha256-${"1".repeat(64)}`,
          physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
          displayPath: "/owned",
          persistentDataNotice: true,
          retentionPolicy: {
            maximumAgeNanoseconds: "1",
            maximumTraceCount: 1,
            maximumPayloadBytes: 1,
            physicalCleanupTrigger: "next-authorized-mutation",
          },
        },
        retainedAuthority: null,
      },
      {
        destinationType: capability.destinationType,
        connectionId: base.connectionId,
        connectionName: "retained",
        planEvidence: {
          namespaceFingerprint: `sha256-${"1".repeat(64)}`,
          physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
          displayPath: "/owned",
          persistentDataNotice: true,
          retentionPolicy: {
            maximumAgeNanoseconds: "1",
            maximumTraceCount: 1,
            maximumPayloadBytes: 1,
            physicalCleanupTrigger: "next-authorized-mutation",
          },
        },
        retainedAuthority: {
          receiptDigest: `sha256-${"3".repeat(64)}`,
          databaseFamilyPhysicalIdentity: "invalid value",
          extra: true,
        },
      },
    ]) {
      retained = invalid;
      await expect(
        inspectRetainedLocalResourceDelete(
          handlers,
          base.connectionId,
          base.signal,
          createLocalResourceLifecycleDeadlineForCore(10_000),
        ),
      ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    }
    const authority = bindLocalResourceConfigurationAuthorityForCore({
      destinationType: base.destinationType,
      connectionId: base.connectionId,
      operationId: base.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: 1,
      candidateGeneration: 2,
      candidateDigest: base.candidateConfigurationDigest,
      commit: () => Promise.reject(new Error("unused")),
    });
    await expect(
      applyLocalResourceLifecyclePlan(
        handlers,
        base,
        await inspectLocalResourceLifecyclePlan(handlers, base),
        authority,
      ),
    ).resolves.toEqual({ ok: false, state: "prepared", code: "busy" });
    const recoveryAuthority = bindLocalResourceConfigurationAuthorityForCore({
      destinationType: base.destinationType,
      connectionId: base.connectionId,
      operationId: base.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      priorGeneration: 1,
      candidateGeneration: 2,
      candidateDigest: base.candidateConfigurationDigest,
      commit: () => Promise.reject(new Error("unused")),
    });
    const recovery = bindLocalResourceLifecycleRecoveryContextForCore({
      ...recoveryInput,
      lifecycleFingerprint: capability.fingerprint,
      configurationAuthority: recoveryAuthority,
    });
    await expect(
      recoverLocalResourceLifecycle(handlers, recovery),
    ).resolves.toEqual({ ok: false, state: "prepared", code: "busy" });
    applyResult = {
      ok: true,
      state: "retained",
      retainedAuthority: {
        receiptDigest: `sha256-${"3".repeat(64)}`,
        databaseFamilyPhysicalIdentity: "dev:1:ino:2",
      },
    };
    await expect(
      applyLocalResourceLifecyclePlan(
        handlers,
        base,
        await inspectLocalResourceLifecyclePlan(handlers, base),
        authority,
      ),
    ).resolves.toEqual(applyResult);
    await expect(
      recoverLocalResourceLifecycle(
        handlers,
        bindLocalResourceLifecycleRecoveryContextForCore({
          ...recoveryInput,
          lifecycleFingerprint: `sha256-${"9".repeat(64)}`,
        }),
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
  });

  it("normalizes retained authority and dispatches exact recovery", async () => {
    const registry = compileDestinationRegistry([descriptor()]);
    const capability = registry.descriptors[0]!.localResourceLifecycle!;
    const handler = defineLocalResourceLifecycleHandler({
      capability,
      complete: () => Promise.resolve(),
      inspectPlan: () => Promise.reject(new Error("unused")),
      inspectRetainedDelete: () =>
        Promise.resolve({
          destinationType: capability.destinationType,
          connectionId: context().connectionId,
          connectionName: "retained",
          planEvidence: {
            namespaceFingerprint: `sha256-${"1".repeat(64)}`,
            physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
            displayPath: "/owned/local",
            persistentDataNotice: true,
            retentionPolicy: {
              maximumAgeNanoseconds: "2592000000000000",
              maximumTraceCount: 10_000,
              maximumPayloadBytes: 1_073_741_824,
              physicalCleanupTrigger: "next-authorized-mutation",
            },
          },
          retainedAuthority: {
            receiptDigest: `sha256-${"3".repeat(64)}`,
            databaseFamilyPhysicalIdentity: "dev:1:ino:2",
          },
        }),
      apply: () => Promise.reject(new Error("unused")),
      recover: () =>
        Promise.resolve({ ok: true as const, state: "rolled-back" as const }),
    });
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    await expect(
      inspectRetainedLocalResourceDelete(
        handlers,
        context().connectionId,
        new AbortController().signal,
        createLocalResourceLifecycleDeadlineForCore(10_000),
      ),
    ).resolves.toMatchObject({
      connectionName: "retained",
      retainedAuthority: {
        databaseFamilyPhysicalIdentity: "dev:1:ino:2",
      },
    });
    const value = context();
    await expect(
      recoverLocalResourceLifecycle(
        handlers,
        bindLocalResourceLifecycleRecoveryContextForCore({
          operation: "configure",
          operationId: value.operationId,
          destinationType: value.destinationType,
          connectionId: value.connectionId,
          owner: value.owner,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 1,
          expectedConfigurationDigest: value.expectedConfigurationDigest,
          authorizedCandidates: [
            { generation: 2, digest: value.candidateConfigurationDigest },
          ],
          configurationState: "prior",
          signal: value.signal,
          deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
        }),
      ),
    ).resolves.toEqual({ ok: true, state: "rolled-back" });
  });

  it("rejects unsupported operations and ambiguous retained matches", async () => {
    const noDeleteRegistry = compileDestinationRegistry([
      descriptor("@agentscope/destination-local-sqlite", [
        "configure",
        "recover",
        "unconfigure",
      ]),
    ]);
    const noDeleteCapability =
      noDeleteRegistry.descriptors[0]!.localResourceLifecycle!;
    const noDeleteHandler = defineLocalResourceLifecycleHandler({
      capability: noDeleteCapability,
      complete: () => Promise.resolve(),
      inspectPlan: () => Promise.reject(new Error("must not run")),
      inspectRetainedDelete: () => Promise.reject(new Error("must not run")),
      apply: () => Promise.reject(new Error("must not run")),
      recover: () => Promise.reject(new Error("must not run")),
    });
    const noDeleteHandlers = compileLocalResourceLifecycleHandlerRegistry(
      noDeleteRegistry,
      [noDeleteHandler],
    );
    const base = context();
    const deleteContext = bindLocalResourceLifecycleContextForCore({
      ...base,
      operation: "delete",
    });
    await expect(
      inspectLocalResourceLifecyclePlan(noDeleteHandlers, deleteContext),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    await expect(
      applyLocalResourceLifecyclePlan(
        noDeleteHandlers,
        deleteContext,
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
    await expect(
      inspectRetainedLocalResourceDelete(
        noDeleteHandlers,
        base.connectionId,
        base.signal,
        createLocalResourceLifecycleDeadlineForCore(10_000),
      ),
    ).resolves.toBeNull();
    await expect(
      inspectRetainedLocalResourceDelete(
        { ...noDeleteHandlers },
        base.connectionId,
        base.signal,
        createLocalResourceLifecycleDeadlineForCore(10_000),
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);

    const types = [
      "@agentscope/destination-local-sqlite",
      "@agentscope/destination-local-sqlite-alt",
    ] as const;
    const registry = compileDestinationRegistry(
      types.map((type) => descriptor(type)),
    );
    const retainedResult = (destinationType: string, connectionId: string) => ({
      destinationType,
      connectionId,
      connectionName: "retained",
      planEvidence: {
        namespaceFingerprint: `sha256-${"1".repeat(64)}`,
        physicalEvidenceFingerprint: `sha256-${"2".repeat(64)}`,
        displayPath: "/owned/local",
        persistentDataNotice: true as const,
        retentionPolicy: {
          maximumAgeNanoseconds: "1",
          maximumTraceCount: 1,
          maximumPayloadBytes: 1,
          physicalCleanupTrigger: "next-authorized-mutation" as const,
        },
      },
      retainedAuthority: {
        receiptDigest: `sha256-${"3".repeat(64)}`,
        databaseFamilyPhysicalIdentity: "dev:1:ino:2",
      },
    });
    const ambiguousHandlers = compileLocalResourceLifecycleHandlerRegistry(
      registry,
      registry.descriptors.map((item) =>
        defineLocalResourceLifecycleHandler({
          capability: item.localResourceLifecycle!,
          complete: () => Promise.resolve(),
          inspectPlan: () => Promise.reject(new Error("unused")),
          inspectRetainedDelete: (name) =>
            Promise.resolve(retainedResult(item.destinationType, name)),
          apply: () => Promise.reject(new Error("unused")),
          recover: () => Promise.reject(new Error("unused")),
        }),
      ),
    );
    await expect(
      inspectRetainedLocalResourceDelete(
        ambiguousHandlers,
        base.connectionId,
        base.signal,
        createLocalResourceLifecycleDeadlineForCore(10_000),
      ),
    ).rejects.toThrow(LocalResourceLifecycleHandlerError);
  });

  it("retains exact historical recovery identities beside the current handler", async () => {
    const currentRegistry = compileDestinationRegistry([descriptor()]);
    const historicalRegistry = compileDestinationRegistry([
      descriptor("@agentscope/destination-local-sqlite", undefined, "b"),
    ]);
    const currentCapability =
      currentRegistry.descriptors[0]!.localResourceLifecycle!;
    const historicalCapability =
      historicalRegistry.descriptors[0]!.localResourceLifecycle!;
    const historicalRecover = vi.fn(() =>
      Promise.resolve({ ok: true as const, state: "rolled-back" as const }),
    );
    const historicalComplete = vi.fn(() => Promise.resolve());
    const unused = () => Promise.reject(new Error("unused"));
    const handlers = compileLocalResourceLifecycleHandlerRegistry(
      currentRegistry,
      [
        defineLocalResourceLifecycleHandler({
          capability: currentCapability,
          complete: unused,
          inspectPlan: unused,
          inspectRetainedDelete: unused,
          apply: unused,
          recover: unused,
        }),
        defineLocalResourceLifecycleHandler({
          capability: historicalCapability,
          complete: historicalComplete,
          inspectPlan: unused,
          inspectRetainedDelete: unused,
          apply: unused,
          recover: historicalRecover,
        }),
      ],
    );
    expect(
      getLocalResourceLifecycleHandlerCapability(
        handlers,
        currentCapability.destinationType,
      ),
    ).toBe(currentCapability);
    const base = context();
    const recovery = bindLocalResourceLifecycleRecoveryContextForCore({
      operation: "configure",
      operationId: base.operationId,
      destinationType: base.destinationType,
      connectionId: base.connectionId,
      owner: base.owner,
      lifecycleFingerprint: historicalCapability.fingerprint,
      recoveryHandlerId: historicalCapability.recoveryHandlerId,
      expectedConfigurationGeneration: 1,
      expectedConfigurationDigest: base.expectedConfigurationDigest,
      authorizedCandidates: [
        { generation: 2, digest: base.candidateConfigurationDigest },
      ],
      configurationState: "prior",
      signal: base.signal,
      deadline: createLocalResourceLifecycleDeadlineForCore(10_000),
    });
    await expect(
      recoverLocalResourceLifecycle(handlers, recovery),
    ).resolves.toEqual({ ok: true, state: "rolled-back" });
    await completeLocalResourceLifecycle(handlers, recovery);
    expect(historicalRecover).toHaveBeenCalledOnce();
    expect(historicalComplete).toHaveBeenCalledOnce();
  });
});
