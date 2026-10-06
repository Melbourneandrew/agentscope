import type { CredentialOwnership } from "./credential-adapter.js";
import type {
  AgentscopeConfigurationSnapshot,
  ConfigurationCredentialReference,
} from "./schema.js";
import {
  ConfigurationStoreError,
  inspectConfigurationTransaction,
  readConfigurationBackupSnapshot,
  readConfigurationSnapshot,
  type ConfigurationStore,
} from "./transaction.js";

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

const snapshotContainsReference = (
  snapshot: AgentscopeConfigurationSnapshot | undefined,
  reference: ConfigurationCredentialReference,
): boolean =>
  snapshot?.connections.some((connection) =>
    Object.values(connection.credentialReferences).some((value) =>
      sameReference(value, reference),
    ),
  ) ?? false;

const optionalSnapshot = async (
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
