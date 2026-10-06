import { types } from "node:util";
import {
  createCredentialOwnership,
  type CredentialOwnership,
  type CredentialResolutionFailure,
} from "./credential-adapter.js";
import type { CredentialSetMutationIntent } from "./credential-intent-record.js";
import {
  serializeAgentscopeConfiguration,
  type AgentscopeConfigurationSnapshot,
  type ConfigurationCredentialReference,
} from "./schema.js";
import {
  ConfigurationStoreError,
  inspectConfigurationTransaction,
  readConfigurationBackupSnapshot,
  readConfigurationSnapshot,
  type ConfigurationStore,
} from "./transaction.js";

export class CredentialLifecycleError extends Error {
  public readonly code = "core.credential.lifecycle-invalid";

  public constructor() {
    super("core.credential.lifecycle-invalid");
    this.name = "CredentialLifecycleError";
  }
}

export type CredentialConfigurationResult =
  | Readonly<{
      ok: true;
      state: "active";
      snapshot: AgentscopeConfigurationSnapshot;
      reference: ConfigurationCredentialReference;
    }>
  | Readonly<{
      ok: false;
      state: "compensated" | "orphan-pending" | "referenced-pending";
      code:
        | "core.credential.create-failed"
        | "core.credential.preflight-unavailable"
        | "core.credential.preflight-locked"
        | "core.credential.preflight-denied"
        | "core.credential.preflight-missing"
        | "core.credential.preflight-malformed"
        | "core.credential.candidate-invalid"
        | "core.credential.configuration-failed"
        | "core.credential.compensation-failed"
        | "core.credential.intent-finalization-failed"
        | "core.credential.activation-failed";
      configurationCommitted: boolean;
      reference?: ConfigurationCredentialReference;
    }>;

export const preflightCode = (
  failure: CredentialResolutionFailure,
): Extract<CredentialConfigurationResult, { ok: false }>["code"] =>
  `core.credential.preflight-${failure}`;

export const credentialSetReferences = (
  intent: CredentialSetMutationIntent,
): Readonly<Record<string, ConfigurationCredentialReference>> =>
  Object.freeze(
    Object.fromEntries(
      intent.entries.map((entry) => [entry.ownership.slot, entry.reference]),
    ),
  );

export const completeCredentialSetCandidate = (
  snapshot: AgentscopeConfigurationSnapshot,
  intent: CredentialSetMutationIntent,
): boolean => {
  if (types.isPromise(snapshot)) {
    void Promise.prototype.then.call(
      snapshot,
      () => undefined,
      () => undefined,
    );
    return false;
  }
  serializeAgentscopeConfiguration(snapshot);
  const first = intent.entries[0];
  /* v8 ignore next -- callers hold a minted version-2 record whose codec requires a nonempty set. */
  if (!first) return false;
  const connection = snapshot.connections.find(
    (value) => value.connectionId === first.ownership.connectionId,
  );
  return (
    connection !== undefined &&
    Object.keys(connection.credentialReferences).sort().join(",") ===
      intent.entries.map((entry) => entry.ownership.slot).join(",") &&
    intent.entries.every((entry) =>
      referencedByCandidate(
        snapshot,
        createCredentialOwnership(entry.ownership),
        entry.reference,
      ),
    )
  );
};

export const referencedByCandidate = (
  candidate: AgentscopeConfigurationSnapshot,
  ownership: CredentialOwnership,
  reference: ConfigurationCredentialReference,
): boolean => {
  const connection = candidate.connections.find(
    (value) => value.connectionId === ownership.connectionId,
  );
  if (!connection || connection.destinationType !== ownership.destinationType)
    return false;
  const actual = connection.credentialReferences[ownership.slot];
  return (
    actual !== undefined && JSON.stringify(actual) === JSON.stringify(reference)
  );
};

export const sameReference = (
  left: ConfigurationCredentialReference | undefined,
  right: ConfigurationCredentialReference,
): boolean =>
  left !== undefined && JSON.stringify(left) === JSON.stringify(right);

export const referenceAt = (
  snapshot: AgentscopeConfigurationSnapshot,
  ownership: CredentialOwnership,
): ConfigurationCredentialReference | undefined => {
  const connection = snapshot.connections.find(
    (value) => value.connectionId === ownership.connectionId,
  );
  return connection?.destinationType === ownership.destinationType
    ? connection.credentialReferences[ownership.slot]
    : undefined;
};

export const snapshotContainsReference = (
  snapshot: AgentscopeConfigurationSnapshot | undefined,
  reference: ConfigurationCredentialReference,
): boolean =>
  snapshot?.connections.some((connection) =>
    Object.values(connection.credentialReferences).some((value) =>
      sameReference(value, reference),
    ),
  ) ?? false;

export const optionalSnapshot = async (
  read: (store: ConfigurationStore) => Promise<AgentscopeConfigurationSnapshot>,
  store: ConfigurationStore,
): Promise<AgentscopeConfigurationSnapshot | undefined> => {
  try {
    return await read(store);
  } catch (error) {
    if (
      error instanceof ConfigurationStoreError &&
      error.code === "core.configuration.missing"
    )
      return undefined;
    throw error;
  }
};

export const credentialWriteFailureEvidence = async (
  store: ConfigurationStore,
  reference: ConfigurationCredentialReference,
): Promise<"referenced" | "unreferenced" | "uncertain"> => {
  try {
    const active = await optionalSnapshot(readConfigurationSnapshot, store);
    if (snapshotContainsReference(active, reference)) return "referenced";
    if (
      (await inspectConfigurationTransaction(store, () => "unknown")).state !==
      "clean"
    )
      return "uncertain";
    const backup = await optionalSnapshot(
      readConfigurationBackupSnapshot,
      store,
    );
    return snapshotContainsReference(backup, reference)
      ? "uncertain"
      : "unreferenced";
  } catch {
    return "uncertain";
  }
};
