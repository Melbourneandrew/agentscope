import { types } from "node:util";
import {
  createCredentialOwnership,
  getStoredCredentialImplementation,
  isCredentialResolutionContext,
  type CredentialBackendRegistry,
  type CredentialResolutionContext,
} from "./credential-adapter.js";
import type { CredentialRetirementIntent } from "./credential-intent-record.js";
import {
  exactConnectionRemoval,
  retirementEntries,
  retirementIdentity,
  retirementState,
} from "./credential-retirement-evidence.js";
import {
  CredentialLifecycleError,
  optionalSnapshot,
} from "./credential-reference-evidence.js";
import {
  serializeAgentscopeConfiguration,
  type AgentscopeConfigurationSnapshot,
} from "./schema.js";
import {
  completeCredentialMutationIntent,
  createCredentialMutationIntent,
  inspectConfigurationTransaction,
  isConfigurationProcessIdentity,
  isConfigurationStore,
  isCredentialMutationIntentActiveForCore,
  readConfigurationBackupSnapshot,
  readConfigurationSnapshot,
  readRetirementReconciliationIntentForCore,
  retirementFinalCandidateForCore,
  writeConfigurationSnapshot,
  type ConfigurationOwnerState,
  type ConfigurationProcessIdentity,
  type ConfigurationStore,
} from "./transaction.js";

type Context = Readonly<{
  store: ConfigurationStore;
  resolutionContext: CredentialResolutionContext;
}>;
export type RetireCredentialConnectionInput = Context &
  Readonly<{
    owner: ConfigurationProcessIdentity;
    connectionId: string;
    preimage: AgentscopeConfigurationSnapshot;
    removal: AgentscopeConfigurationSnapshot;
    final: AgentscopeConfigurationSnapshot;
  }>;
export type ReconcileCredentialRetirementInput = Context &
  Readonly<{
    owner: ConfigurationProcessIdentity;
    ownerState: (
      owner: ConfigurationProcessIdentity,
    ) => ConfigurationOwnerState;
  }>;
const invalid = (): never => {
  throw new CredentialLifecycleError();
};
const own = (input: unknown, keys: string): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || types.isProxy(input))
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !== keys ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value as unknown,
    ]),
  );
};
const context = (values: Record<string, unknown>): void => {
  if (
    !isConfigurationStore(values.store) ||
    !isConfigurationProcessIdentity(values.owner) ||
    !isCredentialResolutionContext(values.resolutionContext) ||
    values.resolutionContext.context !== "hook-equivalent"
  )
    return invalid();
};
const notAborted = (value: Context): void => {
  if (value.resolutionContext.signal.aborted) return invalid();
};
const proof = async (value: Context, intent: CredentialRetirementIntent) => {
  notAborted(value);
  if (
    !(await isCredentialMutationIntentActiveForCore(value.store, intent)) ||
    (await inspectConfigurationTransaction(value.store, () => "unknown"))
      .state !== "clean"
  )
    return invalid();
  const active = await readConfigurationSnapshot(value.store);
  const backup = await optionalSnapshot(
    readConfigurationBackupSnapshot,
    value.store,
  );
  notAborted(value);
  if (
    !(await isCredentialMutationIntentActiveForCore(value.store, intent)) ||
    (await inspectConfigurationTransaction(value.store, () => "unknown"))
      .state !== "clean"
  )
    return invalid();
  return retirementState(active, backup, intent);
};
const removeAll = async (
  registry: CredentialBackendRegistry,
  value: Context,
  intent: CredentialRetirementIntent,
  recheckOwner?: () => Promise<void>,
): Promise<void> => {
  for (const entry of intent.entries) {
    await recheckOwner?.();
    if ((await proof(value, intent)) !== "final") return invalid();
    const implementation = getStoredCredentialImplementation(
      registry,
      entry.reference.backend,
    );
    notAborted(value);
    try {
      if (
        (await implementation.removeOwned({
          ownership: createCredentialOwnership(entry.ownership),
          reference: entry.reference,
          signal: value.resolutionContext.signal,
        })) !== true
      )
        return invalid();
    } catch {
      return invalid();
    }
  }
  await recheckOwner?.();
  if ((await proof(value, intent)) !== "final") return invalid();
  await completeCredentialMutationIntent(value.store, intent);
};

export const retireCredentialConnectionForCore = async (
  registry: CredentialBackendRegistry,
  input: RetireCredentialConnectionInput,
): Promise<void> => {
  const values = own(
    input,
    "connectionId,final,owner,preimage,removal,resolutionContext,store",
  );
  context(values);
  if (typeof values.connectionId !== "string") return invalid();
  const value = Object.freeze(values) as RetireCredentialConnectionInput;
  notAborted(value);
  for (const snapshot of [value.preimage, value.removal, value.final])
    serializeAgentscopeConfiguration(snapshot);
  if (
    !value.preimage.mutationSafe ||
    !value.removal.mutationSafe ||
    !value.final.mutationSafe ||
    !exactConnectionRemoval(
      value.preimage,
      value.removal,
      value.final,
      value.connectionId,
    )
  )
    return invalid();
  const entries = retirementEntries(value.preimage, value.connectionId);
  getStoredCredentialImplementation(registry, entries[0]!.reference.backend);
  const intent = await createCredentialMutationIntent(value.store, {
    recordVersion: 3,
    operation: "retire",
    owner: value.owner,
    entries,
    preimage: retirementIdentity(value.preimage),
    removal: retirementIdentity(value.removal),
    final: retirementIdentity(value.final),
  });
  if ((await proof(value, intent)) !== "preimage") return invalid();
  await writeConfigurationSnapshot(value.store, {
    owner: value.owner,
    expectedGeneration: intent.preimage.generation,
    candidate: value.removal,
    credentialMutationIntent: intent,
  });
  if ((await proof(value, intent)) !== "removal") return invalid();
  await writeConfigurationSnapshot(value.store, {
    owner: value.owner,
    expectedGeneration: intent.removal.generation,
    candidate: value.final,
    credentialMutationIntent: intent,
  });
  await removeAll(registry, value, intent);
};

export const reconcileCredentialRetirementForCore = async (
  registry: CredentialBackendRegistry,
  input: ReconcileCredentialRetirementInput,
): Promise<void> => {
  const values = own(input, "owner,ownerState,resolutionContext,store");
  context(values);
  if (typeof values.ownerState !== "function") return invalid();
  const value = Object.freeze(values) as ReconcileCredentialRetirementInput;
  notAborted(value);
  const intent = await readRetirementReconciliationIntentForCore(
    value.store,
    value.ownerState,
  );
  const recheckOwner = async (): Promise<void> => {
    const current = await readRetirementReconciliationIntentForCore(
      value.store,
      value.ownerState,
    );
    if (JSON.stringify(current) !== JSON.stringify(intent)) return invalid();
  };
  const state = await proof(value, intent);
  if (state === "preimage") {
    await recheckOwner();
    if ((await proof(value, intent)) !== "preimage") return invalid();
    await completeCredentialMutationIntent(value.store, intent);
    return;
  }
  if (state === "removal") {
    await recheckOwner();
    const candidate = await retirementFinalCandidateForCore(
      value.store,
      intent,
    );
    notAborted(value);
    await writeConfigurationSnapshot(value.store, {
      owner: value.owner,
      expectedGeneration: intent.removal.generation,
      candidate,
      credentialMutationIntent: intent,
    });
  } else if (state !== "final") return invalid();
  await removeAll(registry, value, intent, recheckOwner);
};
