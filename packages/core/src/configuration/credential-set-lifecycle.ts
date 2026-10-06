import { randomBytes } from "node:crypto";
import { types } from "node:util";

import {
  createCredentialOwnership,
  deriveStoredCredentialReference,
  getStoredCredentialImplementation,
  isCredentialOwnership,
  isCredentialResolutionContext,
  readResolvedCredentialForCore,
  resolveCredentialReference,
  type CredentialBackendRegistry,
  type CredentialOwnership,
  type CredentialResolutionContext,
  type StoredCredentialBackend,
} from "./credential-adapter.js";
import type { CredentialSetMutationIntent } from "./credential-intent-record.js";
import {
  credentialWriteFailureEvidence,
  optionalSnapshot,
  completeCredentialSetCandidate as completeCandidate,
  credentialSetReferences as referencesFrom,
  snapshotContainsReference,
  CredentialLifecycleError,
  type CredentialConfigurationResult,
} from "./credential-reference-evidence.js";
import type {
  AgentscopeConfigurationSnapshot,
  ConfigurationCredentialReference,
} from "./schema.js";
import {
  completeCredentialMutationIntent,
  createCredentialMutationIntent,
  inspectConfigurationTransaction,
  isCredentialMutationIntentActiveForCore,
  isConfigurationProcessIdentity,
  isConfigurationStore,
  readConfigurationBackupSnapshot,
  readConfigurationSnapshot,
  writeConfigurationSnapshot,
  type ConfigurationProcessIdentity,
  type ConfigurationStore,
} from "./transaction.js";

type SlotInput = Readonly<{ ownership: CredentialOwnership; secret: string }>;
type FailureCode = Extract<
  CredentialConfigurationResult,
  { ok: false }
>["code"];
export type ConfigureCredentialSetInput = Readonly<{
  store: ConfigurationStore;
  owner: ConfigurationProcessIdentity;
  expectedGeneration: number | null;
  backend: StoredCredentialBackend;
  requests: readonly SlotInput[];
  resolutionContext: CredentialResolutionContext;
  createCandidate: (
    references: Readonly<Record<string, ConfigurationCredentialReference>>,
  ) => AgentscopeConfigurationSnapshot;
}>;
export type CredentialSetConfigurationResult =
  | Readonly<{
      ok: true;
      state: "active";
      snapshot: AgentscopeConfigurationSnapshot;
      references: Readonly<Record<string, ConfigurationCredentialReference>>;
    }>
  | Readonly<{
      ok: false;
      state: "compensated" | "orphan-pending" | "referenced-pending";
      code: FailureCode;
      configurationCommitted: boolean;
      references: Readonly<Record<string, ConfigurationCredentialReference>>;
    }>;

const invalid = (): never => {
  throw new CredentialLifecycleError();
};
const own = (value: unknown, keys: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || types.isProxy(value))
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
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

const exactInput = (
  input: ConfigureCredentialSetInput,
): ConfigureCredentialSetInput => {
  const values = own(
    input,
    "backend,createCandidate,expectedGeneration,owner,requests,resolutionContext,store",
  );
  if (
    !isConfigurationStore(values.store) ||
    !isConfigurationProcessIdentity(values.owner) ||
    !isCredentialResolutionContext(values.resolutionContext) ||
    values.resolutionContext.context !== "hook-equivalent" ||
    typeof values.createCandidate !== "function" ||
    (values.expectedGeneration !== null &&
      (!Number.isSafeInteger(values.expectedGeneration) ||
        (values.expectedGeneration as number) < 0)) ||
    !Array.isArray(values.requests) ||
    types.isProxy(values.requests)
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(
    values.requests,
  ) as unknown as PropertyDescriptorMap;
  const length: unknown = descriptors.length?.value;
  if (
    typeof length !== "number" ||
    length < 1 ||
    length > 16 ||
    Reflect.ownKeys(descriptors).length !== length + 1
  )
    return invalid();
  const requests: SlotInput[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return invalid();
    const slot = own(descriptor.value, "ownership,secret");
    if (
      !isCredentialOwnership(slot.ownership) ||
      typeof slot.secret !== "string" ||
      slot.secret.length < 1 ||
      slot.secret.length > 8_192 ||
      slot.secret.includes("\0") ||
      Buffer.from(slot.secret, "utf8").toString("utf8") !== slot.secret
    )
      return invalid();
    requests.push(
      Object.freeze({ ownership: slot.ownership, secret: slot.secret }),
    );
  }
  requests.sort((left, right) =>
    left.ownership.slot < right.ownership.slot
      ? -1
      : left.ownership.slot > right.ownership.slot
        ? 1
        : 0,
  );
  const first = requests[0];
  if (
    !first ||
    requests.some(
      (request, index) =>
        request.ownership.destinationType !== first.ownership.destinationType ||
        request.ownership.connectionId !== first.ownership.connectionId ||
        (index > 0 &&
          request.ownership.slot === requests[index - 1]?.ownership.slot),
    )
  )
    return invalid();
  return Object.freeze({
    ...values,
    requests: Object.freeze(requests),
  }) as ConfigureCredentialSetInput;
};

const failed = (
  intent: CredentialSetMutationIntent,
  state: "compensated" | "orphan-pending" | "referenced-pending",
  code: FailureCode,
  configurationCommitted = false,
): CredentialSetConfigurationResult =>
  Object.freeze({
    ok: false,
    state,
    code,
    configurationCommitted,
    references: referencesFrom(intent),
  });

const compensate = async (
  registry: CredentialBackendRegistry,
  input: ConfigureCredentialSetInput,
  intent: CredentialSetMutationIntent,
  code: FailureCode,
): Promise<CredentialSetConfigurationResult> => {
  const implementation = getStoredCredentialImplementation(
    registry,
    input.backend,
  );
  let complete = true;
  for (const entry of intent.entries) {
    try {
      if (!(await isCredentialMutationIntentActiveForCore(input.store, intent)))
        return failed(
          intent,
          "orphan-pending",
          "core.credential.compensation-failed",
        );
      if (
        !(await implementation.removePending({
          reference: entry.reference,
          signal: input.resolutionContext.signal,
        }))
      )
        complete = false;
    } catch {
      complete = false;
    }
  }
  if (!complete)
    return failed(
      intent,
      "orphan-pending",
      "core.credential.compensation-failed",
    );
  try {
    await completeCredentialMutationIntent(input.store, intent);
  } catch {
    return failed(
      intent,
      "orphan-pending",
      "core.credential.intent-finalization-failed",
    );
  }
  return failed(intent, "compensated", code);
};

const stage = async (
  registry: CredentialBackendRegistry,
  input: ConfigureCredentialSetInput,
  intent: CredentialSetMutationIntent,
): Promise<FailureCode | undefined> => {
  const implementation = getStoredCredentialImplementation(
    registry,
    input.backend,
  );
  for (const [index, entry] of intent.entries.entries()) {
    if (input.resolutionContext.signal.aborted)
      return "core.credential.create-failed";
    const request = input.requests[index];
    /* v8 ignore next -- the minted entries are derived one-for-one from the frozen input requests. */
    if (!request) return invalid();
    try {
      const created = own(
        await implementation.createPending({
          ownership: request.ownership,
          generationId: entry.reference.generationId,
          secret: request.secret,
          signal: input.resolutionContext.signal,
        }),
        "ok,referenceId",
      );
      if (
        created.ok !== true ||
        created.referenceId !== entry.reference.referenceId
      )
        return "core.credential.create-failed";
    } catch {
      return "core.credential.create-failed";
    }
  }
  return undefined;
};

const preflight = async (
  registry: CredentialBackendRegistry,
  input: ConfigureCredentialSetInput,
  intent: CredentialSetMutationIntent,
): Promise<FailureCode | undefined> => {
  for (const [index, entry] of intent.entries.entries()) {
    if (input.resolutionContext.signal.aborted)
      return "core.credential.preflight-unavailable";
    const result = await resolveCredentialReference(
      registry,
      entry.reference,
      input.resolutionContext,
    );
    if (input.resolutionContext.signal.aborted)
      return "core.credential.preflight-unavailable";
    if (!result.ok) return `core.credential.preflight-${result.code}`;
    if (
      readResolvedCredentialForCore(result.credential) !==
      input.requests[index]?.secret
    )
      return "core.credential.preflight-malformed";
  }
  return undefined;
};

const activateSet = async (
  registry: CredentialBackendRegistry,
  input: ConfigureCredentialSetInput,
  record: CredentialSetMutationIntent,
): Promise<boolean> => {
  const implementation = getStoredCredentialImplementation(
    registry,
    input.backend,
  );
  for (const entry of record.entries) {
    if (input.resolutionContext.signal.aborted) return false;
    try {
      if (
        !(await implementation.activate({
          reference: entry.reference,
          signal: input.resolutionContext.signal,
        }))
      )
        return false;
      if (input.resolutionContext.signal.aborted) return false;
    } catch {
      return false;
    }
  }
  return true;
};

export const configureCredentialSetForCore = async (
  registry: CredentialBackendRegistry,
  supplied: ConfigureCredentialSetInput,
): Promise<CredentialSetConfigurationResult> => {
  const input = exactInput(supplied);
  if (input.resolutionContext.signal.aborted) return invalid();
  getStoredCredentialImplementation(registry, input.backend);
  const entries = input.requests.map((request) =>
    Object.freeze({
      ownership: request.ownership,
      reference: deriveStoredCredentialReference(
        input.backend,
        request.ownership,
        `credential-generation-v1-${randomBytes(32).toString("hex")}`,
      ),
    }),
  );
  const planned: CredentialSetMutationIntent = Object.freeze({
    recordVersion: 2,
    operation: "create",
    owner: input.owner,
    entries: Object.freeze(entries),
  });
  let record: CredentialSetMutationIntent;
  try {
    record = await createCredentialMutationIntent(input.store, planned);
  } catch {
    return failed(planned, "compensated", "core.credential.create-failed");
  }
  const stageFailure = await stage(registry, input, record);
  if (stageFailure) return failed(record, "orphan-pending", stageFailure);
  const preflightFailure = await preflight(registry, input, record);
  if (preflightFailure)
    return compensate(registry, input, record, preflightFailure);
  let candidate: AgentscopeConfigurationSnapshot;
  try {
    candidate = input.createCandidate(referencesFrom(record));
    if (!completeCandidate(candidate, record)) throw new Error();
  } catch {
    return compensate(
      registry,
      input,
      record,
      "core.credential.candidate-invalid",
    );
  }
  if (input.resolutionContext.signal.aborted)
    return compensate(
      registry,
      input,
      record,
      "core.credential.preflight-unavailable",
    );
  try {
    await writeConfigurationSnapshot(input.store, {
      expectedGeneration: input.expectedGeneration,
      candidate,
      owner: input.owner,
      credentialMutationIntent: record,
    });
  } catch {
    const evidence = await Promise.all(
      record.entries.map((entry) =>
        credentialWriteFailureEvidence(input.store, entry.reference),
      ),
    );
    if (!evidence.every((value) => value === "unreferenced"))
      return failed(
        record,
        evidence.every((value) => value === "referenced")
          ? "referenced-pending"
          : "orphan-pending",
        "core.credential.configuration-failed",
        evidence.every((value) => value === "referenced"),
      );
    return compensate(
      registry,
      input,
      record,
      "core.credential.configuration-failed",
    );
  }
  try {
    await completeCredentialMutationIntent(input.store, record);
  } catch {
    return failed(
      record,
      "referenced-pending",
      "core.credential.intent-finalization-failed",
      true,
    );
  }
  if (!(await activateSet(registry, input, record)))
    return failed(
      record,
      "referenced-pending",
      "core.credential.activation-failed",
      true,
    );
  return Object.freeze({
    ok: true,
    state: "active",
    snapshot: candidate,
    references: referencesFrom(record),
  });
};

export const recoverCredentialSetForCore = async (
  registry: CredentialBackendRegistry,
  store: ConfigurationStore,
  intent: CredentialSetMutationIntent,
  context: CredentialResolutionContext,
): Promise<
  Readonly<{ ok: true; state: "referenced-intent-cleared" | "orphan-removed" }>
> => {
  if (
    !isCredentialResolutionContext(context) ||
    context.signal.aborted ||
    !(await isCredentialMutationIntentActiveForCore(store, intent))
  )
    return invalid();
  const active = await optionalSnapshot(readConfigurationSnapshot, store);
  const backup = await optionalSnapshot(readConfigurationBackupSnapshot, store);
  if (
    (await inspectConfigurationTransaction(store, () => "unknown")).state !==
    "clean"
  )
    return invalid();
  if (active && completeCandidate(active, intent)) {
    await completeCredentialMutationIntent(store, intent);
    return Object.freeze({ ok: true, state: "referenced-intent-cleared" });
  }
  if (
    intent.entries.some(
      (entry) =>
        snapshotContainsReference(active, entry.reference) ||
        snapshotContainsReference(backup, entry.reference),
    )
  )
    return invalid();
  for (const entry of intent.entries) {
    if (context.signal.aborted) return invalid();
    if (!(await isCredentialMutationIntentActiveForCore(store, intent)))
      return invalid();
    const implementation = getStoredCredentialImplementation(
      registry,
      entry.reference.backend,
    );
    if (
      !(await implementation.removeOwned({
        ownership: createCredentialOwnership(entry.ownership),
        reference: entry.reference,
        signal: context.signal,
      }))
    )
      return invalid();
    if (context.signal.aborted) return invalid();
  }
  await completeCredentialMutationIntent(store, intent);
  return Object.freeze({ ok: true, state: "orphan-removed" });
};
