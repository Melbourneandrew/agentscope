import type {
  CredentialSlotId,
  DestinationConnectionId,
  DestinationTypeId,
} from "@agentscope/destinations-core/configuration";

import {
  isCredentialBackendRegistry,
  isCredentialResolutionContext,
  resolveCredentialReference,
  type CredentialBackend,
  type CredentialBackendRegistry,
  type CredentialResolutionContext,
  type CredentialResolutionFailure,
} from "./credential-adapter.js";
import {
  inspectOperationalState,
  inspectOperationalStateLock,
  isOperationalStateStore,
  recoverAbandonedOperationalStateLock,
  type OperationalStateLockInspection,
  type OperationalStateSnapshot,
  type OperationalStateStore,
} from "./operational-state.js";
import type { ConfigurationCredentialReference } from "./schema.js";
import {
  inspectConfigurationTransaction,
  inspectCredentialMutation,
  isConfigurationStore,
  readConfigurationForHook,
  recoverAbandonedConfigurationTransaction,
  type ConfigurationOwnerState,
  type ConfigurationProcessIdentity,
  type ConfigurationRecoveryResult,
  type ConfigurationStore,
  type ConfigurationTransactionInspection,
  type CredentialMutationInspection,
} from "./transaction.js";

export const DOCTOR_FINDING_CODES = Object.freeze([
  "doctor.configuration.valid",
  "doctor.configuration.missing",
  "doctor.configuration.invalid",
  "doctor.configuration.unsupported",
  "doctor.configuration.unavailable",
  "doctor.transaction.clean",
  "doctor.transaction.active",
  "doctor.transaction.owner-unknown",
  "doctor.transaction.recoverable",
  "doctor.transaction.reconciliation-required",
  "doctor.transaction.conflict",
  "doctor.transaction.invalid",
  "doctor.transaction.unavailable",
  "doctor.credential-mutation.clean",
  "doctor.credential-mutation.active",
  "doctor.credential-mutation.owner-unknown",
  "doctor.credential-mutation.recoverable",
  "doctor.credential-mutation.reconciliation-required",
  "doctor.credential-mutation.invalid",
  "doctor.credential-mutation.unavailable",
  "doctor.credential.available",
  "doctor.credential.unavailable",
  "doctor.credential.locked",
  "doctor.credential.denied",
  "doctor.credential.missing",
  "doctor.credential.malformed",
  "doctor.operational-state.available",
  "doctor.operational-state.invalid",
  "doctor.operational-state.lock-active",
  "doctor.operational-state.lock-owner-unknown",
  "doctor.operational-state.lock-recoverable",
  "doctor.operational-state.lock-reconciliation-required",
  "doctor.operational-state.lock-invalid",
  "doctor.operational-state.lock-unavailable",
] as const);
export type DoctorFindingCode = (typeof DOCTOR_FINDING_CODES)[number];

export type DoctorFinding = Readonly<{
  code: DoctorFindingCode;
  severity: "info" | "warning" | "error";
  suggestedAction:
    | "none"
    | "configure"
    | "retry"
    | "unlock-credential-store"
    | "inspect-credential-mutation"
    | "repair-configuration-transaction"
    | "repair-operational-state-lock"
    | "reconcile-recovery-claim"
    | "inspect-configuration-conflict";
}>;

export type DoctorCredentialInspection = Readonly<{
  destinationType: DestinationTypeId;
  connectionId: DestinationConnectionId;
  slot: CredentialSlotId;
  backend: CredentialBackend;
  state: "available" | CredentialResolutionFailure;
}>;

export type DoctorReport = Readonly<{
  configuration:
    | Readonly<{ state: "valid"; generation: number }>
    | Readonly<{
        state: "missing" | "invalid" | "unsupported" | "unavailable";
      }>;
  transaction: ConfigurationTransactionInspection;
  credentialMutation: CredentialMutationInspection;
  credentials: readonly DoctorCredentialInspection[];
  operationalState:
    | Readonly<{
        state: "available";
        snapshot: OperationalStateSnapshot;
        writerLock: OperationalStateLockInspection;
      }>
    | Readonly<{ state: "invalid" }>;
  findings: readonly DoctorFinding[];
}>;

export type DoctorInspectionInput = Readonly<{
  configurationStore: ConfigurationStore;
  operationalStateStore: OperationalStateStore;
  credentialRegistry: CredentialBackendRegistry;
  credentialResolutionContext: CredentialResolutionContext;
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState;
}>;

export class DoctorError extends Error {
  public readonly code = "core.doctor.invalid";
  public constructor() {
    super("core.doctor.invalid");
    this.name = "DoctorError";
  }
}

const invalid = (): never => {
  throw new DoctorError();
};

const exactInput = (input: DoctorInspectionInput): DoctorInspectionInput => {
  if (typeof input !== "object" || input === null) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !==
      "configurationStore,credentialRegistry,credentialResolutionContext,operationalStateStore,ownerState" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const values = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      (descriptor as PropertyDescriptor & { value: unknown }).value,
    ]),
  ) as unknown as DoctorInspectionInput;
  if (
    !isConfigurationStore(values.configurationStore) ||
    !isOperationalStateStore(values.operationalStateStore) ||
    !isCredentialBackendRegistry(values.credentialRegistry) ||
    !isCredentialResolutionContext(values.credentialResolutionContext) ||
    typeof values.ownerState !== "function"
  )
    return invalid();
  return values;
};

const finding = (
  code: DoctorFindingCode,
  severity: DoctorFinding["severity"],
  suggestedAction: DoctorFinding["suggestedAction"],
): DoctorFinding => Object.freeze({ code, severity, suggestedAction });

const transactionFinding = (
  transaction: ConfigurationTransactionInspection,
): DoctorFinding => {
  switch (transaction.state) {
    case "clean":
      return finding("doctor.transaction.clean", "info", "none");
    case "active":
      return finding("doctor.transaction.active", "info", "retry");
    case "owner-unknown":
      return finding("doctor.transaction.owner-unknown", "warning", "retry");
    case "recoverable":
      return finding(
        "doctor.transaction.recoverable",
        "warning",
        "repair-configuration-transaction",
      );
    case "reconciliation-required":
      return finding(
        "doctor.transaction.reconciliation-required",
        "error",
        "reconcile-recovery-claim",
      );
    case "conflict":
      return finding(
        "doctor.transaction.conflict",
        "error",
        "inspect-configuration-conflict",
      );
    case "invalid":
      return finding("doctor.transaction.invalid", "error", "retry");
    case "unavailable":
      return finding("doctor.transaction.unavailable", "error", "retry");
  }
};

const credentialFinding = (
  state: DoctorCredentialInspection["state"],
): DoctorFinding => {
  if (state === "available")
    return finding("doctor.credential.available", "info", "none");
  if (state === "locked")
    return finding(
      "doctor.credential.locked",
      "warning",
      "unlock-credential-store",
    );
  const action =
    state === "missing" || state === "malformed" ? "configure" : "retry";
  return finding(`doctor.credential.${state}`, "error", action);
};

const credentialMutationFinding = (
  mutation: CredentialMutationInspection,
): DoctorFinding => {
  if (mutation.state === "clean")
    return finding("doctor.credential-mutation.clean", "info", "none");
  if (mutation.state === "active")
    return finding("doctor.credential-mutation.active", "info", "retry");
  if (mutation.state === "owner-unknown")
    return finding(
      "doctor.credential-mutation.owner-unknown",
      "warning",
      "inspect-credential-mutation",
    );
  if (mutation.state === "recoverable")
    return finding(
      "doctor.credential-mutation.recoverable",
      "warning",
      "inspect-credential-mutation",
    );
  if (mutation.state === "reconciliation-required")
    return finding(
      "doctor.credential-mutation.reconciliation-required",
      "error",
      "reconcile-recovery-claim",
    );
  return finding(
    `doctor.credential-mutation.${mutation.state}`,
    "error",
    "inspect-credential-mutation",
  );
};

const inspectCredentials = async (
  registry: CredentialBackendRegistry,
  context: CredentialResolutionContext,
  connections: readonly Readonly<{
    destinationType: DestinationTypeId;
    connectionId: DestinationConnectionId;
    credentialReferences: Readonly<
      Record<CredentialSlotId, ConfigurationCredentialReference>
    >;
  }>[],
): Promise<readonly DoctorCredentialInspection[]> => {
  const inspections: DoctorCredentialInspection[] = [];
  for (const connection of connections) {
    for (const [slot, reference] of Object.entries(
      connection.credentialReferences,
    ).sort(([left], [right]) => left.localeCompare(right))) {
      const result = await resolveCredentialReference(
        registry,
        reference,
        context,
      );
      inspections.push(
        Object.freeze({
          destinationType: connection.destinationType,
          connectionId: connection.connectionId,
          slot: slot as CredentialSlotId,
          backend: reference.backend,
          state: result.ok ? ("available" as const) : result.code,
        }),
      );
    }
  }
  return Object.freeze(inspections);
};

const inspectStoredOperationalState = async (
  store: OperationalStateStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<DoctorReport["operationalState"]> => {
  try {
    return Object.freeze({
      state: "available" as const,
      snapshot: await inspectOperationalState(store),
      writerLock: await inspectOperationalStateLock(store, ownerState),
    });
  } catch {
    return Object.freeze({ state: "invalid" });
  }
};

const operationalLockFinding = (
  state: OperationalStateLockInspection["state"],
): DoctorFinding | undefined => {
  if (state === "clean") return undefined;
  if (state === "active")
    return finding("doctor.operational-state.lock-active", "info", "retry");
  if (state === "owner-unknown")
    return finding(
      "doctor.operational-state.lock-owner-unknown",
      "warning",
      "retry",
    );
  if (state === "recoverable")
    return finding(
      "doctor.operational-state.lock-recoverable",
      "warning",
      "repair-operational-state-lock",
    );
  if (state === "reconciliation-required")
    return finding(
      "doctor.operational-state.lock-reconciliation-required",
      "error",
      "reconcile-recovery-claim",
    );
  return finding(`doctor.operational-state.lock-${state}`, "warning", "retry");
};

const configurationState = (
  result: Exclude<
    Awaited<ReturnType<typeof readConfigurationForHook>>,
    { ok: true }
  >,
): Exclude<DoctorReport["configuration"], { state: "valid" }> => {
  switch (result.code) {
    case "core.configuration.missing":
      return Object.freeze({ state: "missing" });
    case "core.configuration.invalid":
      return Object.freeze({ state: "invalid" });
    case "core.configuration.unsupported":
      return Object.freeze({ state: "unsupported" });
    case "core.configuration.unavailable":
      return Object.freeze({ state: "unavailable" });
  }
};

export const inspectAgentscopeDoctor = async (
  input: DoctorInspectionInput,
): Promise<DoctorReport> => {
  const value = exactInput(input);
  const [configurationRead, transaction, credentialMutation, operationalState] =
    await Promise.all([
      readConfigurationForHook(value.configurationStore),
      inspectConfigurationTransaction(
        value.configurationStore,
        value.ownerState,
      ),
      inspectCredentialMutation(value.configurationStore, value.ownerState),
      inspectStoredOperationalState(
        value.operationalStateStore,
        value.ownerState,
      ),
    ]);
  const configuration = configurationRead.ok
    ? Object.freeze({
        state: "valid" as const,
        generation: configurationRead.snapshot.generation,
      })
    : configurationState(configurationRead);
  const credentials = configurationRead.ok
    ? await inspectCredentials(
        value.credentialRegistry,
        value.credentialResolutionContext,
        configurationRead.snapshot.connections,
      )
    : Object.freeze([]);
  const findings: DoctorFinding[] = [
    configurationRead.ok
      ? finding("doctor.configuration.valid", "info", "none")
      : finding(
          `doctor.configuration.${configuration.state}`,
          "error",
          configuration.state === "missing" ? "configure" : "retry",
        ),
    transactionFinding(transaction),
    credentialMutationFinding(credentialMutation),
    ...credentials.map((credential) => credentialFinding(credential.state)),
    operationalState.state === "available"
      ? finding("doctor.operational-state.available", "info", "none")
      : finding(
          `doctor.operational-state.${operationalState.state}`,
          "warning",
          "retry",
        ),
  ];
  if (operationalState.state === "available") {
    const lockFinding = operationalLockFinding(
      operationalState.writerLock.state,
    );
    if (lockFinding) findings.push(lockFinding);
  }
  return Object.freeze({
    configuration,
    transaction,
    credentialMutation,
    credentials,
    operationalState,
    findings: Object.freeze(findings),
  });
};

export const repairDoctorConfigurationTransaction = (
  store: ConfigurationStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<ConfigurationRecoveryResult> =>
  recoverAbandonedConfigurationTransaction(store, ownerState);

export const repairDoctorOperationalStateLock = (
  store: OperationalStateStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<Readonly<{ recovered: true }>> =>
  recoverAbandonedOperationalStateLock(store, ownerState);
