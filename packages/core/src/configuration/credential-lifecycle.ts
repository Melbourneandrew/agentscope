import { randomBytes } from "node:crypto";

import type {
  DestinationConnectionId,
  DestinationTypeId,
  CredentialSlotId,
} from "@agentscope/destinations-core/configuration";

import {
  createCiEnvironmentCredentialReference,
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
  type CredentialResolutionFailure,
  type StoredCredentialBackend,
} from "./credential-adapter.js";
import type {
  AgentscopeConfigurationSnapshot,
  ConfigurationCredentialReference,
} from "./schema.js";
import {
  ConfigurationStoreError,
  completeCredentialMutationIntent,
  createCredentialMutationIntent,
  isConfigurationProcessIdentity,
  isConfigurationStore,
  readConfigurationBackupSnapshot,
  readConfigurationForHook,
  readConfigurationSnapshot,
  readRecoverableCredentialMutationIntent,
  isCredentialMutationIntentActiveForCore,
  writeConfigurationSnapshot,
  type ConfigurationProcessIdentity,
  type ConfigurationStore,
  type CredentialMutationIntent,
} from "./transaction.js";

export type CredentialConfigurationRequest =
  | Readonly<{
      kind: "stored";
      backend: StoredCredentialBackend;
      secret: string;
    }>
  | Readonly<{
      kind: "ci-environment";
      environmentVariable: string;
    }>;

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

export type ConfigureCredentialInput = Readonly<{
  store: ConfigurationStore;
  owner: ConfigurationProcessIdentity;
  expectedGeneration: number | null;
  ownership: CredentialOwnership;
  request: CredentialConfigurationRequest;
  resolutionContext: CredentialResolutionContext;
  createCandidate: (
    reference: ConfigurationCredentialReference,
  ) => AgentscopeConfigurationSnapshot;
}>;

export type RemoveCredentialInput = Readonly<{
  store: ConfigurationStore;
  owner: ConfigurationProcessIdentity;
  expectedGeneration: number;
  ownership: CredentialOwnership;
  reference: ConfigurationCredentialReference;
  resolutionContext: CredentialResolutionContext;
  createCandidate: () => AgentscopeConfigurationSnapshot;
}>;

export type CredentialRemovalResult =
  | Readonly<{
      ok: true;
      state:
        "reference-removed" | "retained-last-known-good" | "credential-removed";
      configurationCommitted: boolean;
    }>
  | Readonly<{
      ok: false;
      state: "configuration-unchanged" | "intent-pending" | "owned-orphan";
      code:
        | "core.credential.reference-mismatch"
        | "core.credential.candidate-invalid"
        | "core.credential.configuration-failed"
        | "core.credential.intent-finalization-failed"
        | "core.credential.remove-failed";
      configurationCommitted: boolean;
    }>;

export type CredentialMutationRecoveryResult = Readonly<{
  ok: true;
  state: "referenced-intent-cleared" | "orphan-removed";
}>;

const generationPattern = /^credential-generation-v1-[0-9a-f]{64}$/u;
const referencePattern = /^credential-reference-v1-[0-9a-f]{64}$/u;

export class CredentialLifecycleError extends Error {
  public readonly code = "core.credential.lifecycle-invalid";

  public constructor() {
    super("core.credential.lifecycle-invalid");
    this.name = "CredentialLifecycleError";
  }
}

const invalid = (): never => {
  throw new CredentialLifecycleError();
};

const dataValue = (descriptor: PropertyDescriptor): unknown =>
  (descriptor as PropertyDescriptor & { value: unknown }).value;

const fixedFailure = (
  state: "compensated" | "orphan-pending" | "referenced-pending",
  code: Extract<CredentialConfigurationResult, { ok: false }>["code"],
  configurationCommitted: boolean,
  reference?: ConfigurationCredentialReference,
): CredentialConfigurationResult =>
  Object.freeze({
    ok: false as const,
    state,
    code,
    configurationCommitted,
    ...(reference ? { reference } : {}),
  });

const preflightCode = (
  failure: CredentialResolutionFailure,
): Extract<CredentialConfigurationResult, { ok: false }>["code"] =>
  `core.credential.preflight-${failure}`;

const randomIdentity = (prefix: string): string =>
  `${prefix}${randomBytes(32).toString("hex")}`;

const exactRequest = (
  request: CredentialConfigurationRequest,
): CredentialConfigurationRequest => {
  if (typeof request !== "object" || request === null) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(request);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  if (
    descriptors.kind?.value === "stored" &&
    Object.keys(descriptors).sort().join(",") === "backend,kind,secret" &&
    typeof descriptors.secret?.value === "string" &&
    descriptors.secret.value.length > 0 &&
    descriptors.secret.value.length <= 8_192 &&
    !descriptors.secret.value.includes("\0") &&
    !containsLoneSurrogate(descriptors.secret.value) &&
    [
      "macos-keychain",
      "windows-credential-manager",
      "linux-secret-service",
    ].includes(descriptors.backend?.value as string)
  )
    return Object.freeze({
      kind: "stored" as const,
      backend: descriptors.backend?.value as StoredCredentialBackend,
      secret: descriptors.secret.value,
    });
  if (
    descriptors.kind?.value === "ci-environment" &&
    Object.keys(descriptors).sort().join(",") === "environmentVariable,kind" &&
    typeof descriptors.environmentVariable?.value === "string"
  )
    return Object.freeze({
      kind: "ci-environment" as const,
      environmentVariable: descriptors.environmentVariable.value,
    });
  return invalid();
};

const containsLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff)
        return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

const exactInput = (
  input: ConfigureCredentialInput,
): ConfigureCredentialInput => {
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
      "createCandidate,expectedGeneration,owner,ownership,request,resolutionContext,store" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const values = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      dataValue(descriptor),
    ]),
  ) as unknown as ConfigureCredentialInput;
  if (
    !isConfigurationStore(values.store) ||
    !isConfigurationProcessIdentity(values.owner) ||
    !isCredentialOwnership(values.ownership) ||
    !isCredentialResolutionContext(values.resolutionContext) ||
    typeof values.createCandidate !== "function" ||
    (values.expectedGeneration !== null &&
      (!Number.isSafeInteger(values.expectedGeneration) ||
        values.expectedGeneration < 0))
  )
    return invalid();
  return Object.freeze(values);
};

const referencedByCandidate = (
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

const sameReference = (
  left: ConfigurationCredentialReference | undefined,
  right: ConfigurationCredentialReference,
): boolean =>
  left !== undefined && JSON.stringify(left) === JSON.stringify(right);

const referenceAt = (
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

const compensate = async (
  remove: (() => Promise<boolean>) | undefined,
  complete: (() => Promise<void>) | undefined,
  code: Extract<CredentialConfigurationResult, { ok: false }>["code"],
  reference?: ConfigurationCredentialReference,
): Promise<CredentialConfigurationResult> => {
  if (!remove) return fixedFailure("compensated", code, false, reference);
  try {
    if (!(await remove()))
      return fixedFailure(
        "orphan-pending",
        "core.credential.compensation-failed",
        false,
        reference,
      );
    await complete?.();
    return fixedFailure("compensated", code, false, reference);
  } catch {
    return fixedFailure(
      "orphan-pending",
      "core.credential.compensation-failed",
      false,
      reference,
    );
  }
};

type StagedReference = Readonly<{
  reference: ConfigurationCredentialReference;
  intent?: CredentialMutationIntent;
  complete?: () => Promise<void>;
  remove?: () => Promise<boolean>;
  activate?: () => Promise<boolean>;
}>;

const stageReference = async (
  registry: CredentialBackendRegistry,
  request: CredentialConfigurationRequest,
  input: ConfigureCredentialInput,
): Promise<StagedReference | CredentialConfigurationResult> => {
  const generationId = randomIdentity("credential-generation-v1-");
  /* v8 ignore next -- randomBytes(32).toString("hex") is structurally fixed to this identity grammar. */
  if (!generationPattern.test(generationId)) return invalid();
  if (request.kind === "ci-environment")
    return Object.freeze({
      reference: createCiEnvironmentCredentialReference(
        request.environmentVariable,
        generationId,
      ),
    });
  const implementation = getStoredCredentialImplementation(
    registry,
    request.backend,
  );
  const reference = deriveStoredCredentialReference(
    request.backend,
    input.ownership,
    generationId,
  );
  let intent: CredentialMutationIntent;
  try {
    intent = await createCredentialMutationIntent(input.store, {
      recordVersion: 1,
      operation: "create",
      owner: input.owner,
      ownership: input.ownership,
      reference,
    });
  } catch {
    return fixedFailure("compensated", "core.credential.create-failed", false);
  }
  const complete = () => completeCredentialMutationIntent(input.store, intent);
  try {
    const created = await implementation.createPending({
      ownership: input.ownership,
      generationId,
      secret: request.secret,
      signal: input.resolutionContext.signal,
    });
    let createdDescriptors: PropertyDescriptorMap;
    try {
      createdDescriptors = Object.getOwnPropertyDescriptors(created);
    } catch {
      return fixedFailure(
        "orphan-pending",
        "core.credential.create-failed",
        false,
        reference,
      );
    }
    if (
      Reflect.ownKeys(createdDescriptors).some(
        (key) => typeof key !== "string",
      ) ||
      Object.values(createdDescriptors).some(
        (descriptor) => !("value" in descriptor),
      ) ||
      createdDescriptors.ok?.value !== true ||
      Object.keys(createdDescriptors).sort().join(",") !== "ok,referenceId" ||
      typeof createdDescriptors.referenceId?.value !== "string" ||
      !referencePattern.test(createdDescriptors.referenceId.value) ||
      createdDescriptors.referenceId.value !== reference.referenceId
    )
      return fixedFailure(
        "orphan-pending",
        "core.credential.create-failed",
        false,
        reference,
      );
    return Object.freeze({
      reference,
      intent,
      complete,
      remove: () =>
        implementation.removePending({
          reference,
          signal: input.resolutionContext.signal,
        }),
      activate: () =>
        implementation.activate({
          reference,
          signal: input.resolutionContext.signal,
        }),
    });
  } catch {
    return fixedFailure(
      "orphan-pending",
      "core.credential.create-failed",
      false,
      reference,
    );
  }
};

const candidateFrom = (
  createCandidate: ConfigureCredentialInput["createCandidate"],
  reference: ConfigurationCredentialReference,
  ownership: CredentialOwnership,
): AgentscopeConfigurationSnapshot | undefined => {
  try {
    const candidate: unknown = createCandidate(reference);
    if (candidate instanceof Promise) {
      void candidate.catch(() => undefined);
      return undefined;
    }
    return referencedByCandidate(
      candidate as AgentscopeConfigurationSnapshot,
      ownership,
      reference,
    )
      ? (candidate as AgentscopeConfigurationSnapshot)
      : undefined;
  } catch {
    return undefined;
  }
};

export const configureCredential = async (
  registry: CredentialBackendRegistry,
  input: ConfigureCredentialInput,
): Promise<CredentialConfigurationResult> => {
  const validated = exactInput(input);
  const request = exactRequest(validated.request);
  const staged = await stageReference(registry, request, validated);
  if ("ok" in staged) return staged;
  const resolution = await resolveCredentialReference(
    registry,
    staged.reference,
    validated.resolutionContext,
  );
  if (!resolution.ok)
    return compensate(
      staged.remove,
      staged.complete,
      preflightCode(resolution.code),
      staged.reference,
    );
  if (
    request.kind === "stored" &&
    readResolvedCredentialForCore(resolution.credential) !== request.secret
  )
    return compensate(
      staged.remove,
      staged.complete,
      "core.credential.preflight-malformed",
      staged.reference,
    );
  const candidate = candidateFrom(
    validated.createCandidate,
    staged.reference,
    validated.ownership,
  );
  if (!candidate)
    return compensate(
      staged.remove,
      staged.complete,
      "core.credential.candidate-invalid",
      staged.reference,
    );
  try {
    await writeConfigurationSnapshot(validated.store, {
      expectedGeneration: validated.expectedGeneration,
      candidate,
      owner: validated.owner,
      ...(staged.intent
        ? { credentialMutationIntent: staged.intent }
        : undefined),
    });
  } catch {
    return compensate(
      staged.remove,
      staged.complete,
      "core.credential.configuration-failed",
      staged.reference,
    );
  }
  if (staged.complete) {
    try {
      await staged.complete();
    } catch {
      return fixedFailure(
        "referenced-pending",
        "core.credential.intent-finalization-failed",
        true,
        staged.reference,
      );
    }
  }
  if (staged.activate) {
    try {
      if (!(await staged.activate()))
        return fixedFailure(
          "referenced-pending",
          "core.credential.activation-failed",
          true,
          staged.reference,
        );
    } catch {
      return fixedFailure(
        "referenced-pending",
        "core.credential.activation-failed",
        true,
        staged.reference,
      );
    }
  }
  return Object.freeze({
    ok: true as const,
    state: "active" as const,
    snapshot: candidate,
    reference: staged.reference,
  });
};

export const credentialOwnershipMatches = (
  ownership: CredentialOwnership,
  destinationType: DestinationTypeId,
  connectionId: DestinationConnectionId,
  slot: CredentialSlotId,
): boolean =>
  ownership.destinationType === destinationType &&
  ownership.connectionId === connectionId &&
  ownership.slot === slot;

const removalFailure = (
  code: Extract<CredentialRemovalResult, { ok: false }>["code"],
  state: Extract<
    CredentialRemovalResult,
    { ok: false }
  >["state"] = "configuration-unchanged",
  configurationCommitted = false,
): CredentialRemovalResult =>
  Object.freeze({ ok: false, state, code, configurationCommitted });

const removalSuccess = (
  state: Extract<CredentialRemovalResult, { ok: true }>["state"],
  configurationCommitted: boolean,
): CredentialRemovalResult =>
  Object.freeze({ ok: true, state, configurationCommitted });

const exactRemovalInput = (
  input: RemoveCredentialInput,
): RemoveCredentialInput => {
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
      "createCandidate,expectedGeneration,owner,ownership,reference,resolutionContext,store" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const value = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      dataValue(descriptor),
    ]),
  ) as unknown as RemoveCredentialInput;
  if (
    !isConfigurationStore(value.store) ||
    !isConfigurationProcessIdentity(value.owner) ||
    !isCredentialOwnership(value.ownership) ||
    !isCredentialResolutionContext(value.resolutionContext) ||
    !Number.isSafeInteger(value.expectedGeneration) ||
    value.expectedGeneration < 0 ||
    typeof value.reference !== "object" ||
    value.reference === null ||
    typeof value.createCandidate !== "function"
  )
    return invalid();
  return Object.freeze(value);
};

const removalCandidate = (
  createCandidate: RemoveCredentialInput["createCandidate"],
  ownership: CredentialOwnership,
): AgentscopeConfigurationSnapshot | undefined => {
  try {
    const value: unknown = createCandidate();
    if (value instanceof Promise) {
      void value.catch(() => undefined);
      return undefined;
    }
    const candidate = value as AgentscopeConfigurationSnapshot;
    return referenceAt(candidate, ownership) === undefined
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

export const removeCredentialReference = async (
  input: RemoveCredentialInput,
): Promise<CredentialRemovalResult> => {
  const value = exactRemovalInput(input);
  let current: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(value.store);
  } catch {
    return removalFailure("core.credential.configuration-failed");
  }
  if (
    current.generation !== value.expectedGeneration ||
    !sameReference(referenceAt(current, value.ownership), value.reference)
  )
    return removalFailure("core.credential.reference-mismatch");
  const candidate = removalCandidate(value.createCandidate, value.ownership);
  if (!candidate) return removalFailure("core.credential.candidate-invalid");
  try {
    await writeConfigurationSnapshot(value.store, {
      expectedGeneration: value.expectedGeneration,
      candidate,
      owner: value.owner,
    });
  } catch {
    /* v8 ignore next -- CAS write failure behavior is exhaustively exercised at the transaction boundary. */
    return removalFailure("core.credential.configuration-failed");
  }
  return value.reference.backend === "ci-environment"
    ? removalSuccess("reference-removed", true)
    : removalSuccess("retained-last-known-good", true);
};

export const purgeUnreferencedCredential = async (
  registry: CredentialBackendRegistry,
  input: Readonly<{
    store: ConfigurationStore;
    intent?: CredentialMutationIntent;
    ownership: CredentialOwnership;
    reference: ConfigurationCredentialReference;
    resolutionContext: CredentialResolutionContext;
  }>,
): Promise<CredentialRemovalResult> => {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    ![
      "intent,ownership,reference,resolutionContext,store",
      "ownership,reference,resolutionContext,store",
    ].includes(Object.keys(descriptors).sort().join(",")) ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const values = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      dataValue(descriptor),
    ]),
  ) as typeof input;
  if (
    !isConfigurationStore(values.store) ||
    !isCredentialOwnership(values.ownership) ||
    !isCredentialResolutionContext(values.resolutionContext) ||
    typeof values.reference !== "object" ||
    values.reference === null
  )
    return invalid();
  if (
    values.reference.backend !== "ci-environment" &&
    (values.intent === undefined ||
      !(await isCredentialMutationIntentActiveForCore(
        values.store,
        values.intent,
      )))
  )
    return invalid();
  let active: AgentscopeConfigurationSnapshot;
  let backup: AgentscopeConfigurationSnapshot | undefined;
  try {
    active = await readConfigurationSnapshot(values.store);
    try {
      backup = await readConfigurationBackupSnapshot(values.store);
    } catch (error) {
      if (
        !(error instanceof ConfigurationStoreError) ||
        error.code !== "core.configuration.missing"
      )
        return removalFailure("core.credential.configuration-failed");
    }
  } catch {
    return removalFailure("core.credential.configuration-failed");
  }
  if (
    sameReference(referenceAt(active, values.ownership), values.reference) ||
    (backup &&
      sameReference(referenceAt(backup, values.ownership), values.reference))
  )
    return removalSuccess("retained-last-known-good", false);
  if (values.reference.backend === "ci-environment")
    return removalSuccess("reference-removed", false);
  const implementation = getStoredCredentialImplementation(
    registry,
    values.reference.backend,
  );
  try {
    return (await implementation.removeOwned({
      ownership: values.ownership,
      reference: values.reference,
      signal: values.resolutionContext.signal,
    }))
      ? removalSuccess("credential-removed", false)
      : removalFailure("core.credential.remove-failed", "owned-orphan");
  } catch {
    return removalFailure("core.credential.remove-failed", "owned-orphan");
  }
};

export const recoverCredentialMutation = async (
  registry: CredentialBackendRegistry,
  input: Readonly<{
    store: ConfigurationStore;
    ownerState: (
      owner: ConfigurationProcessIdentity,
    ) => "dead" | "live" | "unknown";
    resolutionContext: CredentialResolutionContext;
  }>,
): Promise<CredentialMutationRecoveryResult> => {
  if (
    typeof input !== "object" ||
    input === null ||
    !isConfigurationStore(input.store) ||
    typeof input.ownerState !== "function" ||
    !isCredentialResolutionContext(input.resolutionContext)
  )
    return invalid();
  const intent = await readRecoverableCredentialMutationIntent(
    input.store,
    input.ownerState,
  );
  const ownership = createCredentialOwnership(intent.ownership);
  const removal = await purgeUnreferencedCredential(registry, {
    store: input.store,
    intent,
    ownership,
    reference: intent.reference,
    resolutionContext: input.resolutionContext,
  });
  let orphanRemoved =
    removal.ok &&
    (removal.state === "credential-removed" ||
      removal.state === "reference-removed");
  if (!removal.ok) {
    const configuration = await readConfigurationForHook(input.store);
    if (
      configuration.ok ||
      configuration.code !== "core.configuration.missing" ||
      intent.reference.backend === "ci-environment"
    )
      return invalid();
    let backup: AgentscopeConfigurationSnapshot | undefined;
    try {
      backup = await readConfigurationBackupSnapshot(input.store);
    } catch (error) {
      if (
        !(error instanceof ConfigurationStoreError) ||
        error.code !== "core.configuration.missing"
      )
        return invalid();
    }
    if (
      backup !== undefined &&
      sameReference(referenceAt(backup, ownership), intent.reference)
    )
      return invalid();
    const implementation = getStoredCredentialImplementation(
      registry,
      intent.reference.backend,
    );
    if (
      !(await implementation.removeOwned({
        ownership,
        reference: intent.reference,
        signal: input.resolutionContext.signal,
      }))
    )
      return invalid();
    orphanRemoved = true;
  }
  await completeCredentialMutationIntent(input.store, intent);
  return Object.freeze({
    ok: true as const,
    state: orphanRemoved
      ? ("orphan-removed" as const)
      : ("referenced-intent-cleared" as const),
  });
};

const sameConfigurationExceptGeneration = (
  current: AgentscopeConfigurationSnapshot,
  candidate: AgentscopeConfigurationSnapshot,
): boolean => {
  try {
    const currentDocument = JSON.parse(
      JSON.stringify(current.document),
    ) as Record<string, unknown>;
    const candidateDocument = JSON.parse(
      JSON.stringify(candidate.document),
    ) as Record<string, unknown>;
    currentDocument.generation = 0;
    candidateDocument.generation = 0;
    return (
      JSON.stringify(currentDocument) === JSON.stringify(candidateDocument)
    );
  } catch {
    /* v8 ignore next -- both snapshots are branded, frozen, JSON-safe plain
       documents; serialization cannot throw after exact input validation. */
    return false;
  }
};

export const retireCredentialReference = async (
  registry: CredentialBackendRegistry,
  input: RemoveCredentialInput,
): Promise<CredentialRemovalResult> => {
  const value = exactRemovalInput(input);
  let current: AgentscopeConfigurationSnapshot;
  let backup: AgentscopeConfigurationSnapshot;
  try {
    current = await readConfigurationSnapshot(value.store);
    backup = await readConfigurationBackupSnapshot(value.store);
  } catch {
    return removalFailure("core.credential.configuration-failed");
  }
  if (
    current.generation !== value.expectedGeneration ||
    referenceAt(current, value.ownership) !== undefined ||
    !sameReference(referenceAt(backup, value.ownership), value.reference)
  )
    return removalFailure("core.credential.reference-mismatch");
  const candidate = removalCandidate(value.createCandidate, value.ownership);
  if (
    !candidate ||
    candidate.generation !== current.generation + 1 ||
    !sameConfigurationExceptGeneration(current, candidate)
  )
    return removalFailure("core.credential.candidate-invalid");
  let intent: CredentialMutationIntent;
  try {
    intent = await createCredentialMutationIntent(value.store, {
      recordVersion: 1,
      operation: "retire",
      owner: value.owner,
      ownership: value.ownership,
      reference: value.reference,
    });
    await writeConfigurationSnapshot(value.store, {
      expectedGeneration: value.expectedGeneration,
      candidate,
      owner: value.owner,
      credentialMutationIntent: intent,
    });
  } catch {
    return removalFailure("core.credential.configuration-failed");
  }
  const removal = await purgeUnreferencedCredential(registry, {
    store: value.store,
    intent,
    ownership: value.ownership,
    reference: value.reference,
    resolutionContext: value.resolutionContext,
  });
  if (!removal.ok) return removalFailure(removal.code, removal.state, true);
  try {
    await completeCredentialMutationIntent(value.store, intent);
  } catch {
    return removalFailure(
      "core.credential.intent-finalization-failed",
      "intent-pending",
      true,
    );
  }
  return removalSuccess(removal.state, true);
};
