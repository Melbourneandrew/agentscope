import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  link as nodeLink,
  open as nodeOpen,
  rename as nodeRename,
  unlink as nodeUnlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  getDestinationDescriptor,
  type DestinationRegistry,
} from "@agentscope/destinations-core/configuration";
import { z } from "zod";

import {
  ensureAgentscopeHomeLayout,
  isAgentscopeHome,
  type AgentscopeHome,
} from "./home.js";
import { cloneConfigurationDocument } from "./plain-data.js";
import {
  parseAgentscopeConfiguration,
  parseConfigurationCredentialReference,
  serializeAgentscopeConfiguration,
  type AgentscopeConfigurationSnapshot,
  type ConfigurationCredentialReference,
} from "./schema.js";

export const MAXIMUM_CONFIGURATION_FILE_BYTES = 1_572_864;
const CONFIGURATION_FILE_MODE = 0o600;
const LOCK_FILE_NAME = "config.lock";
const RECOVERY_CLAIM_FILE_NAME = "config.recovery.lock";
const CREDENTIAL_INTENT_FILE_NAME = "credential.lock";
const CREDENTIAL_RECOVERY_CLAIM_FILE_NAME = "credential.recovery.lock";
const LOCAL_RESOURCE_INTENT_FILE_NAME = "local-resource.lock";
const LOCAL_RESOURCE_RECOVERY_CLAIM_FILE_NAME = "local-resource.recovery.lock";
const LOCAL_RESOURCE_COMPLETION_FILE_NAME = "local-resource.completion.lock";
const MAXIMUM_CREDENTIAL_INTENT_BYTES = 4_096;
/* v8 ignore next -- every supported Node platform exposes O_NOFOLLOW. */
const noFollow = constants.O_NOFOLLOW ?? 0;
const readFlags = constants.O_RDONLY | noFollow;
const createFlags =
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;
const processStartIdentityPattern = /^process-start-v1-[0-9a-f]{64}$/u;
const transactionIdentityPattern =
  /^configuration-transaction-v1-[0-9a-f]{64}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

export const CONFIGURATION_TRANSACTION_STEPS = Object.freeze([
  "lock-durable",
  "candidate-durable",
  "backup-durable",
  "active-reverified",
  "active-replaced",
] as const);
export type ConfigurationTransactionStep =
  (typeof CONFIGURATION_TRANSACTION_STEPS)[number];

export type ConfigurationProcessIdentity = Readonly<{
  processId: number;
  processStartIdentity: string;
}>;

export type ConfigurationStore = Readonly<{
  readonly configurationStore: "agentscope-core";
}>;

export type ConfigurationWriteInput = Readonly<{
  expectedGeneration: number | null;
  candidate: AgentscopeConfigurationSnapshot;
  owner: ConfigurationProcessIdentity;
  credentialMutationIntent?: CredentialMutationIntent;
  localResourceMutationIntent?: LocalResourceMutationIntent;
}>;

export type HookConfigurationReadResult =
  | Readonly<{ ok: true; snapshot: AgentscopeConfigurationSnapshot }>
  | Readonly<{
      ok: false;
      code:
        | "core.configuration.missing"
        | "core.configuration.invalid"
        | "core.configuration.unsupported"
        | "core.configuration.unavailable";
    }>;

export type ConfigurationOwnerState = "dead" | "live" | "unknown";

export type ConfigurationRecoveryResult = Readonly<{
  recovered: true;
  committed: boolean;
  generation: number | null;
}>;

export type ConfigurationTransactionInspection =
  | Readonly<{ state: "clean" }>
  | Readonly<{
      state: "active" | "owner-unknown" | "reconciliation-required";
    }>
  | Readonly<{
      state: "recoverable";
      committed: boolean;
      generation: number | null;
    }>
  | Readonly<{ state: "conflict" | "invalid" | "unavailable" }>;

export type CredentialMutationIntent = Readonly<{
  recordVersion: 1;
  operation: "create" | "retire";
  owner: ConfigurationProcessIdentity;
  ownership: Readonly<{
    destinationType: string;
    connectionId: string;
    slot: string;
  }>;
  reference: ConfigurationCredentialReference;
}>;

export type CredentialMutationInspection = Readonly<{
  state:
    | "clean"
    | "active"
    | "owner-unknown"
    | "recoverable"
    | "reconciliation-required"
    | "invalid"
    | "unavailable";
}>;

export type LocalResourceMutationIntent = Readonly<{
  recordVersion: 1;
  operation: "configure" | "delete" | "unconfigure";
  operationId: string;
  owner: ConfigurationProcessIdentity;
  destinationType: string;
  connectionId: string;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  expectedGeneration: number;
  expectedDigest: string;
  authorizedCandidates: readonly Readonly<{
    generation: number;
    digest: string;
  }>[];
}>;

export type LocalResourceMutationInspection = Readonly<{
  state:
    | "clean"
    | "active"
    | "owner-unknown"
    | "recoverable"
    | "reconciliation-required"
    | "invalid"
    | "unavailable";
}>;

export type ConfigurationStoreErrorCode =
  | "core.configuration.conflict"
  | "core.configuration.contention"
  | "core.configuration.downgrade"
  | "core.configuration.invalid"
  | "core.configuration.missing"
  | "core.configuration.recovery-owner-live"
  | "core.configuration.recovery-owner-unknown"
  | "core.configuration.unavailable";

export class ConfigurationStoreError extends Error {
  public constructor(public readonly code: ConfigurationStoreErrorCode) {
    super(code);
    this.name = "ConfigurationStoreError";
  }
}

export class ConfigurationCrashSimulation extends Error {
  public constructor() {
    super("core.configuration.crash-simulation");
    this.name = "ConfigurationCrashSimulation";
  }
}

type ConfigurationFileSystem = Readonly<{
  link?: typeof nodeLink;
  open: typeof nodeOpen;
  rename: typeof nodeRename;
  unlink: typeof nodeUnlink;
}>;

type ConfigurationStoreInternals = Readonly<{
  home: AgentscopeHome;
  registry: DestinationRegistry;
  fileSystem: ConfigurationFileSystem;
  readForHook?: (
    file: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  createTransactionId: () => string;
  afterStep?: (step: ConfigurationTransactionStep) => void;
}>;

const storeRegistry = new WeakMap<object, ConfigurationStoreInternals>();
const processIdentityRegistry = new WeakSet<object>();
const credentialMutationIntentRegistry = new WeakSet<object>();
const claimedCredentialIntents = new WeakSet<object>();
const localResourceMutationIntentRegistry = new WeakSet<object>();
const claimedLocalResourceIntents = new WeakSet<object>();
const completedLocalResourceIntents = new WeakSet<object>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const lockRecordSchema = z.strictObject({
  recordVersion: z.literal(1),
  transactionId: z.string().regex(transactionIdentityPattern),
  owner: z.strictObject({
    processId: z.number().int().positive().safe(),
    processStartIdentity: z.string().regex(processStartIdentityPattern),
  }),
  expectedGeneration: z.number().int().nonnegative().safe().nullable(),
  expectedDigest: z.string().regex(digestPattern).nullable(),
  candidateGeneration: z.number().int().nonnegative().safe(),
  candidateDigest: z.string().regex(digestPattern),
  candidateFileName: z.string().regex(/^\.config\.[0-9a-f]{64}\.candidate$/u),
  backupStageFileName: z.string().regex(/^\.config\.[0-9a-f]{64}\.backup$/u),
});

const credentialIntentSchema = z.strictObject({
  recordVersion: z.literal(1),
  operation: z.enum(["create", "retire"]),
  owner: lockRecordSchema.shape.owner,
  ownership: z.strictObject({
    destinationType: z
      .string()
      .regex(/^@agentscope\/destination-[a-z0-9-]{1,64}$/u),
    connectionId: z.string().regex(/^destination-connection-v1-[0-9a-f]{64}$/u),
    slot: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  }),
  reference: z.unknown(),
});

const localResourceIntentSchema = z.strictObject({
  recordVersion: z.literal(1),
  operation: z.enum(["configure", "delete", "unconfigure"]),
  operationId: z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/u),
  owner: lockRecordSchema.shape.owner,
  destinationType: z
    .string()
    .regex(/^@agentscope\/destination-[a-z0-9-]{1,64}$/u),
  connectionId: z.string().regex(/^destination-connection-v1-[0-9a-f]{64}$/u),
  lifecycleFingerprint: z.string().regex(/^sha256-[0-9a-f]{64}$/u),
  recoveryHandlerId: z.string().min(1).max(256),
  expectedGeneration: z.number().int().nonnegative().safe(),
  expectedDigest: z.string().regex(/^sha256-[0-9a-f]{64}$/u),
  authorizedCandidates: z
    .array(
      z.strictObject({
        generation: z.number().int().nonnegative().safe(),
        digest: z.string().regex(/^sha256-[0-9a-f]{64}$/u),
      }),
    )
    .min(1)
    .max(2),
});

type ConfigurationLockRecord = z.infer<typeof lockRecordSchema>;

const credentialIntentPath = (state: ConfigurationStoreInternals): string =>
  join(state.home.mutationDirectory, CREDENTIAL_INTENT_FILE_NAME);

const localResourceIntentPath = (state: ConfigurationStoreInternals): string =>
  join(state.home.mutationDirectory, LOCAL_RESOURCE_INTENT_FILE_NAME);

const localResourceRecoveryClaimPath = (
  state: ConfigurationStoreInternals,
): string =>
  join(state.home.mutationDirectory, LOCAL_RESOURCE_RECOVERY_CLAIM_FILE_NAME);

const localResourceCompletionPath = (
  state: ConfigurationStoreInternals,
): string =>
  join(state.home.mutationDirectory, LOCAL_RESOURCE_COMPLETION_FILE_NAME);

const recoveryClaimPath = (state: ConfigurationStoreInternals): string =>
  join(state.home.mutationDirectory, RECOVERY_CLAIM_FILE_NAME);

const credentialRecoveryClaimPath = (
  state: ConfigurationStoreInternals,
): string =>
  join(state.home.mutationDirectory, CREDENTIAL_RECOVERY_CLAIM_FILE_NAME);

const linkForState = (
  state: ConfigurationStoreInternals,
  source: string,
  destination: string,
): Promise<void> => (state.fileSystem.link ?? nodeLink)(source, destination);

const parseCredentialIntent = (value: string): CredentialMutationIntent => {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_CREDENTIAL_INTENT_BYTES)
    return invalid("core.configuration.invalid");
  try {
    const parsed = credentialIntentSchema.safeParse(
      JSON.parse(value) as unknown,
    );
    if (!parsed.success) return invalid("core.configuration.invalid");
    const record = Object.freeze({
      recordVersion: 1 as const,
      operation: parsed.data.operation,
      owner: Object.freeze(parsed.data.owner),
      ownership: Object.freeze(parsed.data.ownership),
      reference: parseConfigurationCredentialReference(parsed.data.reference),
    });
    if (`${JSON.stringify(record)}\n` !== value)
      return invalid("core.configuration.invalid");
    return record;
  } catch (error) {
    if (error instanceof ConfigurationStoreError) throw error;
    return invalid("core.configuration.invalid");
  }
};

const nativeFileSystem: ConfigurationFileSystem = Object.freeze({
  link: nodeLink,
  open: nodeOpen,
  rename: nodeRename,
  unlink: nodeUnlink,
});

const invalid = (code: ConfigurationStoreErrorCode): never => {
  throw new ConfigurationStoreError(code);
};

const nodeErrorCode = (error: unknown): string | undefined => {
  /* v8 ignore next -- Node filesystem failures are Error objects; this guard
     keeps runtime-cast test adapters total without invoking hostile values. */
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
};

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const closeQuietly = async (handle: FileHandle | undefined): Promise<void> => {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // A failed close is reported through the operation that owns the handle.
  }
};

const readBoundedFile = async (
  fileSystem: ConfigurationFileSystem,
  file: string,
): Promise<string | undefined> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(file, readFlags);
    const state = await handle.stat();
    if (!state.isFile() || state.size > MAXIMUM_CONFIGURATION_FILE_BYTES)
      return invalid("core.configuration.invalid");
    const buffer = Buffer.alloc(MAXIMUM_CONFIGURATION_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAXIMUM_CONFIGURATION_FILE_BYTES)
      return invalid("core.configuration.invalid");
    try {
      return utf8Decoder.decode(buffer.subarray(0, offset));
    } catch {
      return invalid("core.configuration.invalid");
    }
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    if (error instanceof ConfigurationStoreError) throw error;
    return invalid("core.configuration.unavailable");
  } finally {
    await closeQuietly(handle);
  }
};

const readBoundedHookFile = async (
  file: string,
  signal: AbortSignal,
): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = createReadStream(file, {
    flags: (readFlags | constants.O_NONBLOCK) as unknown as string,
    highWaterMark: 64 * 1_024,
    start: 0,
    end: MAXIMUM_CONFIGURATION_FILE_BYTES,
    signal,
  });
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Uint8Array);
      total += bytes.byteLength;
      if (total > MAXIMUM_CONFIGURATION_FILE_BYTES)
        return invalid("core.configuration.invalid");
      chunks.push(bytes);
    }
    try {
      return utf8Decoder.decode(Buffer.concat(chunks, total));
    } catch {
      return invalid("core.configuration.invalid");
    }
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    if (error instanceof ConfigurationStoreError) throw error;
    return invalid("core.configuration.unavailable");
  } finally {
    stream.destroy();
  }
};

const writeDurableExclusive = async (
  fileSystem: ConfigurationFileSystem,
  file: string,
  value: string,
): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(file, createFlags, CONFIGURATION_FILE_MODE);
    await handle.writeFile(value, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
  } finally {
    await closeQuietly(handle);
  }
};

const syncDirectory = async (
  fileSystem: ConfigurationFileSystem,
  directory: string,
): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(directory, readFlags);
    await handle.sync();
  } finally {
    await closeQuietly(handle);
  }
};

const unlinkIfPresent = async (
  fileSystem: ConfigurationFileSystem,
  file: string,
): Promise<void> => {
  try {
    await fileSystem.unlink(file);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
};

const stored = (store: ConfigurationStore): ConfigurationStoreInternals =>
  storeRegistry.get(store) ?? invalid("core.configuration.invalid");

export const configurationStoreHomeForCore = (
  store: ConfigurationStore,
): AgentscopeHome => stored(store).home;

const validateOwner = (
  owner: ConfigurationProcessIdentity,
): ConfigurationProcessIdentity => {
  const parsed = lockRecordSchema.shape.owner.safeParse(owner);
  if (!parsed.success) return invalid("core.configuration.invalid");
  return Object.freeze(parsed.data);
};

export const createConfigurationProcessIdentity = (
  processId: unknown,
  processStartIdentity: unknown,
): ConfigurationProcessIdentity => {
  const identity = validateOwner({
    processId: processId as number,
    processStartIdentity: processStartIdentity as string,
  });
  processIdentityRegistry.add(identity);
  return identity;
};

const createStore = (
  home: AgentscopeHome,
  registry: DestinationRegistry,
  overrides: Partial<ConfigurationStoreInternals> = {},
): ConfigurationStore => {
  if (!isAgentscopeHome(home)) return invalid("core.configuration.invalid");
  try {
    getDestinationDescriptor(
      registry,
      "@agentscope/destination-registry-probe",
    );
  } catch {
    return invalid("core.configuration.invalid");
  }
  const store = Object.freeze({
    configurationStore: "agentscope-core" as const,
  });
  storeRegistry.set(store, {
    home,
    registry,
    fileSystem: overrides.fileSystem ?? nativeFileSystem,
    ...(overrides.readForHook ? { readForHook: overrides.readForHook } : {}),
    createTransactionId:
      overrides.createTransactionId ??
      (() => `configuration-transaction-v1-${randomBytes(32).toString("hex")}`),
    ...(overrides.afterStep ? { afterStep: overrides.afterStep } : {}),
  });
  return store;
};

export const createConfigurationStore = (
  home: AgentscopeHome,
  registry: DestinationRegistry,
): ConfigurationStore => createStore(home, registry);

export const isConfigurationStore = (
  value: unknown,
): value is ConfigurationStore =>
  typeof value === "object" && value !== null && storeRegistry.has(value);

export const configurationStoreUsesRegistry = (
  store: ConfigurationStore,
  registry: DestinationRegistry,
): boolean => storeRegistry.get(store)?.registry === registry;

export const isConfigurationProcessIdentity = (
  value: unknown,
): value is ConfigurationProcessIdentity =>
  typeof value === "object" &&
  value !== null &&
  processIdentityRegistry.has(value);

export const createConfigurationStoreForTesting = (
  home: AgentscopeHome,
  registry: DestinationRegistry,
  overrides: Partial<ConfigurationStoreInternals>,
): ConfigurationStore => createStore(home, registry, overrides);

const parseCurrent = (
  value: string | undefined,
  registry: DestinationRegistry,
): AgentscopeConfigurationSnapshot | undefined => {
  if (value === undefined) return undefined;
  try {
    const snapshot = parseAgentscopeConfiguration(
      JSON.parse(value) as unknown,
      registry,
    );
    if (serializeAgentscopeConfiguration(snapshot) !== value)
      return invalid("core.configuration.invalid");
    return snapshot;
  } catch {
    return invalid("core.configuration.invalid");
  }
};

const observeUnexpectedPromise = (value: unknown): void => {
  if (!(value instanceof Promise)) return;
  void Promise.prototype.then.call(
    value,
    () => undefined,
    () => undefined,
  );
};

export const readConfigurationSnapshot = async (
  store: ConfigurationStore,
): Promise<AgentscopeConfigurationSnapshot> => {
  const state = stored(store);
  const value = await readBoundedFile(state.fileSystem, state.home.configFile);
  return (
    parseCurrent(value, state.registry) ?? invalid("core.configuration.missing")
  );
};

export const readConfigurationBackupSnapshot = async (
  store: ConfigurationStore,
): Promise<AgentscopeConfigurationSnapshot> => {
  const state = stored(store);
  const value = await readBoundedFile(
    state.fileSystem,
    state.home.configBackupFile,
  );
  return (
    parseCurrent(value, state.registry) ?? invalid("core.configuration.missing")
  );
};

export const readConfigurationForHook = async (
  store: ConfigurationStore,
  signal?: AbortSignal,
): Promise<HookConfigurationReadResult> => {
  try {
    const state = stored(store);
    const snapshot =
      signal === undefined
        ? await readConfigurationSnapshot(store)
        : (parseCurrent(
            await (state.readForHook ?? readBoundedHookFile)(
              state.home.configFile,
              signal,
            ),
            state.registry,
          ) ?? invalid("core.configuration.missing"));
    return snapshot.mutationSafe
      ? Object.freeze({ ok: true as const, snapshot })
      : Object.freeze({
          ok: false as const,
          code: "core.configuration.unsupported" as const,
        });
  } catch (error) {
    /* v8 ignore next 2 -- every read boundary normalizes to ConfigurationStoreError. */
    if (!(error instanceof ConfigurationStoreError))
      return Object.freeze({
        ok: false as const,
        code: "core.configuration.unavailable" as const,
      });
    const code =
      error.code === "core.configuration.missing" ||
      error.code === "core.configuration.invalid"
        ? error.code
        : "core.configuration.unavailable";
    return Object.freeze({ ok: false as const, code });
  }
};

const assertWriteInput = (
  input: ConfigurationWriteInput,
): Readonly<{
  expectedGeneration: number | null;
  candidate: AgentscopeConfigurationSnapshot;
  candidateText: string;
  owner: ConfigurationProcessIdentity;
  credentialMutationIntent: CredentialMutationIntent | undefined;
  localResourceMutationIntent: LocalResourceMutationIntent | undefined;
  // eslint-disable-next-line complexity -- hostile exact-record validation remains in one noncoercing boundary.
}> => {
  const descriptors =
    typeof input === "object" && input !== null
      ? Object.getOwnPropertyDescriptors(input)
      : undefined;
  if (
    !descriptors ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    ![
      "candidate,credentialMutationIntent,expectedGeneration,owner",
      "candidate,expectedGeneration,localResourceMutationIntent,owner",
      "candidate,expectedGeneration,owner",
    ].includes(Object.keys(descriptors).sort().join(",")) ||
    Reflect.ownKeys(descriptors).some((key) => {
      const descriptor = descriptors[key as keyof typeof descriptors];
      return !descriptor || !("value" in descriptor);
    })
  )
    return invalid("core.configuration.invalid");
  const expectedGeneration = descriptors.expectedGeneration?.value as unknown;
  const candidate = descriptors.candidate?.value as unknown;
  const owner = descriptors.owner?.value as unknown;
  const credentialMutationIntent = descriptors.credentialMutationIntent
    ?.value as unknown;
  const localResourceMutationIntent = descriptors.localResourceMutationIntent
    ?.value as unknown;
  if (
    (!Number.isSafeInteger(expectedGeneration) &&
      expectedGeneration !== null) ||
    (typeof expectedGeneration === "number" && expectedGeneration < 0) ||
    typeof candidate !== "object" ||
    candidate === null ||
    typeof owner !== "object" ||
    owner === null ||
    !processIdentityRegistry.has(owner) ||
    (credentialMutationIntent !== undefined &&
      (typeof credentialMutationIntent !== "object" ||
        credentialMutationIntent === null ||
        !credentialMutationIntentRegistry.has(credentialMutationIntent))) ||
    (localResourceMutationIntent !== undefined &&
      (typeof localResourceMutationIntent !== "object" ||
        localResourceMutationIntent === null ||
        !localResourceMutationIntentRegistry.has(
          localResourceMutationIntent,
        ))) ||
    (credentialMutationIntent !== undefined &&
      localResourceMutationIntent !== undefined)
  )
    return invalid("core.configuration.invalid");
  const typedCandidate = candidate as AgentscopeConfigurationSnapshot;
  const candidateText = serializeAgentscopeConfiguration(typedCandidate);
  /* v8 ignore next 2 -- the branded configuration schema's tighter aggregate
     bound makes this outer file cap unreachable for a genuine snapshot. */
  if (
    Buffer.byteLength(candidateText, "utf8") > MAXIMUM_CONFIGURATION_FILE_BYTES
  )
    return invalid("core.configuration.invalid");
  if (!typedCandidate.mutationSafe)
    return invalid("core.configuration.downgrade");
  const typedExpected = expectedGeneration as number | null;
  const expectedCandidateGeneration = (typedExpected ?? -1) + 1;
  if (typedCandidate.generation !== expectedCandidateGeneration)
    return invalid("core.configuration.conflict");
  return Object.freeze({
    expectedGeneration: typedExpected,
    candidate: typedCandidate,
    candidateText,
    owner: owner as ConfigurationProcessIdentity,
    credentialMutationIntent: credentialMutationIntent as
      CredentialMutationIntent | undefined,
    localResourceMutationIntent: localResourceMutationIntent as
      LocalResourceMutationIntent | undefined,
  });
};

const parseLocalResourceIntent = (
  value: string,
): LocalResourceMutationIntent => {
  try {
    if (Buffer.byteLength(value, "utf8") > MAXIMUM_CREDENTIAL_INTENT_BYTES)
      return invalid("core.configuration.invalid");
    const parsed = localResourceIntentSchema.parse(JSON.parse(value));
    for (
      let index = 0;
      index < parsed.authorizedCandidates.length;
      index += 1
    ) {
      if (
        parsed.authorizedCandidates[index]!.generation !==
        parsed.expectedGeneration + index + 1
      )
        return invalid("core.configuration.invalid");
    }
    return Object.freeze({
      ...parsed,
      owner: Object.freeze(parsed.owner),
      authorizedCandidates: Object.freeze(
        parsed.authorizedCandidates.map((candidate) =>
          Object.freeze(candidate),
        ),
      ),
    });
  } catch (error) {
    if (error instanceof ConfigurationStoreError) throw error;
    return invalid("core.configuration.invalid");
  }
};

const sameLocalResourceIntent = (
  left: LocalResourceMutationIntent,
  right: LocalResourceMutationIntent,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const authorizeLocalResourceFence = async (
  state: ConfigurationStoreInternals,
  intent: LocalResourceMutationIntent | undefined,
  candidate: AgentscopeConfigurationSnapshot,
  candidateText: string,
): Promise<void> => {
  const fixedValue = await readBoundedFile(
    state.fileSystem,
    localResourceIntentPath(state),
  );
  const claimValue = await readBoundedFile(
    state.fileSystem,
    localResourceRecoveryClaimPath(state),
  );
  const completionValue = await readBoundedFile(
    state.fileSystem,
    localResourceCompletionPath(state),
  );
  if (
    claimValue !== undefined &&
    (intent === undefined ||
      !localResourceMutationIntentRegistry.has(intent) ||
      !claimedLocalResourceIntents.has(intent) ||
      !sameLocalResourceIntent(parseLocalResourceIntent(claimValue), intent))
  )
    return invalid("core.configuration.contention");
  if (
    completionValue !== undefined &&
    (intent === undefined ||
      !localResourceMutationIntentRegistry.has(intent) ||
      !completedLocalResourceIntents.has(intent) ||
      !sameLocalResourceIntent(
        parseLocalResourceIntent(completionValue),
        intent,
      ))
  )
    return invalid("core.configuration.contention");
  if (
    [fixedValue, claimValue, completionValue]
      .filter((value): value is string => value !== undefined)
      .some(
        (value, _index, values) =>
          !sameLocalResourceIntent(
            parseLocalResourceIntent(value),
            parseLocalResourceIntent(values[0]!),
          ),
      )
  )
    return invalid("core.configuration.contention");
  const value = completionValue ?? claimValue ?? fixedValue;
  if (value === undefined) {
    if (intent !== undefined) return invalid("core.configuration.conflict");
    return;
  }
  if (
    intent === undefined ||
    !localResourceMutationIntentRegistry.has(intent) ||
    !sameLocalResourceIntent(parseLocalResourceIntent(value), intent) ||
    !intent.authorizedCandidates.some(
      (authorized) =>
        authorized.generation === candidate.generation &&
        authorized.digest === `sha256-${digest(candidateText)}`,
    )
  )
    return invalid("core.configuration.contention");
};

const configurationFencePresent = async (
  state: ConfigurationStoreInternals,
): Promise<boolean> =>
  (await readBoundedFile(
    state.fileSystem,
    join(state.home.mutationDirectory, LOCK_FILE_NAME),
  )) !== undefined ||
  (await readBoundedFile(state.fileSystem, recoveryClaimPath(state))) !==
    undefined;

const localResourceFencePresent = async (
  state: ConfigurationStoreInternals,
): Promise<boolean> =>
  (await readBoundedFile(state.fileSystem, localResourceIntentPath(state))) !==
    undefined ||
  (await readBoundedFile(
    state.fileSystem,
    localResourceRecoveryClaimPath(state),
  )) !== undefined ||
  (await readBoundedFile(
    state.fileSystem,
    localResourceCompletionPath(state),
  )) !== undefined;

const authorizeCredentialFence = async (
  state: ConfigurationStoreInternals,
  intent: CredentialMutationIntent | undefined,
): Promise<void> => {
  const value = await readBoundedFile(
    state.fileSystem,
    credentialIntentPath(state),
  );
  if (
    (await readBoundedFile(
      state.fileSystem,
      credentialRecoveryClaimPath(state),
    )) !== undefined
  )
    return invalid("core.configuration.contention");
  if (value === undefined) {
    if (intent !== undefined) return invalid("core.configuration.conflict");
    return;
  }
  if (
    intent === undefined ||
    !credentialMutationIntentRegistry.has(intent) ||
    !sameCredentialIntent(parseCredentialIntent(value), intent)
  )
    return invalid("core.configuration.contention");
};

const transactionPaths = (
  state: ConfigurationStoreInternals,
  transactionId: string,
): Readonly<{
  lock: string;
  candidate: string;
  backupStage: string;
}> => {
  if (!transactionIdentityPattern.test(transactionId))
    return invalid("core.configuration.invalid");
  const suffix = transactionId.slice("configuration-transaction-v1-".length);
  return Object.freeze({
    lock: join(state.home.mutationDirectory, LOCK_FILE_NAME),
    candidate: join(state.home.root, `.config.${suffix}.candidate`),
    backupStage: join(state.home.root, `.config.${suffix}.backup`),
  });
};

const verifyExpected = (
  activeText: string | undefined,
  active: AgentscopeConfigurationSnapshot | undefined,
  expectedGeneration: number | null,
  expectedDigest: string | null,
): void => {
  if (expectedGeneration === null) {
    if (activeText !== undefined || active !== undefined)
      return invalid("core.configuration.conflict");
    return;
  }
  if (
    !activeText ||
    !active ||
    active.generation !== expectedGeneration ||
    digest(activeText) !== expectedDigest
  )
    return invalid("core.configuration.conflict");
};

const acquireLock = async (
  state: ConfigurationStoreInternals,
  path: string,
  record: ConfigurationLockRecord,
): Promise<void> => {
  try {
    if (
      (await readBoundedFile(state.fileSystem, recoveryClaimPath(state))) !==
      undefined
    )
      return invalid("core.configuration.contention");
    await writeDurableExclusive(
      state.fileSystem,
      path,
      `${JSON.stringify(record)}\n`,
    );
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
    if (
      (await readBoundedFile(state.fileSystem, recoveryClaimPath(state))) !==
      undefined
    ) {
      const current = await readLock(state);
      if (JSON.stringify(current) === JSON.stringify(record))
        await state.fileSystem.unlink(path);
      return invalid("core.configuration.contention");
    }
    state.afterStep?.("lock-durable");
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST")
      return invalid("core.configuration.contention");
    throw error;
  }
};

const cleanupTransaction = async (
  state: ConfigurationStoreInternals,
  paths: ReturnType<typeof transactionPaths>,
  expected: ConfigurationLockRecord,
  lock = paths.lock,
): Promise<void> => {
  await unlinkIfPresent(state.fileSystem, paths.candidate);
  await unlinkIfPresent(state.fileSystem, paths.backupStage);
  const current = await readLock(state, lock);
  if (JSON.stringify(current) !== JSON.stringify(expected))
    return invalid("core.configuration.conflict");
  await state.fileSystem.unlink(lock);
  await syncDirectory(state.fileSystem, state.home.root);
  await syncDirectory(state.fileSystem, state.home.mutationDirectory);
};

export const writeConfigurationSnapshot = async (
  store: ConfigurationStore,
  input: ConfigurationWriteInput,
): Promise<AgentscopeConfigurationSnapshot> => {
  const state = stored(store);
  const validated = assertWriteInput(input);
  try {
    await ensureAgentscopeHomeLayout(state.home);
  } catch {
    return invalid("core.configuration.unavailable");
  }
  const transactionId = state.createTransactionId();
  const paths = transactionPaths(state, transactionId);
  const initialText = await readBoundedFile(
    state.fileSystem,
    state.home.configFile,
  );
  const initial = parseCurrent(initialText, state.registry);
  const expectedDigest = initialText === undefined ? null : digest(initialText);
  verifyExpected(
    initialText,
    initial,
    validated.expectedGeneration,
    expectedDigest,
  );
  const record: ConfigurationLockRecord = {
    recordVersion: 1,
    transactionId,
    owner: validated.owner,
    expectedGeneration: validated.expectedGeneration,
    expectedDigest,
    candidateGeneration: validated.candidate.generation,
    candidateDigest: digest(validated.candidateText),
    candidateFileName: paths.candidate.slice(state.home.root.length + 1),
    backupStageFileName: paths.backupStage.slice(state.home.root.length + 1),
  };
  let lockAcquired = false;
  try {
    await acquireLock(state, paths.lock, record);
    lockAcquired = true;
    await authorizeCredentialFence(state, validated.credentialMutationIntent);
    await authorizeLocalResourceFence(
      state,
      validated.localResourceMutationIntent,
      validated.candidate,
      validated.candidateText,
    );
    const lockedText = await readBoundedFile(
      state.fileSystem,
      state.home.configFile,
    );
    verifyExpected(
      lockedText,
      parseCurrent(lockedText, state.registry),
      validated.expectedGeneration,
      expectedDigest,
    );
    await writeDurableExclusive(
      state.fileSystem,
      paths.candidate,
      validated.candidateText,
    );
    await syncDirectory(state.fileSystem, state.home.root);
    state.afterStep?.("candidate-durable");
    if (initialText !== undefined) {
      await writeDurableExclusive(
        state.fileSystem,
        paths.backupStage,
        initialText,
      );
      await state.fileSystem.rename(
        paths.backupStage,
        state.home.configBackupFile,
      );
      await syncDirectory(state.fileSystem, state.home.root);
    }
    state.afterStep?.("backup-durable");
    const currentText = await readBoundedFile(
      state.fileSystem,
      state.home.configFile,
    );
    verifyExpected(
      currentText,
      parseCurrent(currentText, state.registry),
      validated.expectedGeneration,
      expectedDigest,
    );
    state.afterStep?.("active-reverified");
    const currentLock = await readLock(state);
    if (JSON.stringify(currentLock) !== JSON.stringify(record))
      return invalid("core.configuration.conflict");
    await state.fileSystem.rename(paths.candidate, state.home.configFile);
    await syncDirectory(state.fileSystem, state.home.root);
    state.afterStep?.("active-replaced");
    await cleanupTransaction(state, paths, record);
    lockAcquired = false;
    return validated.candidate;
  } catch (error) {
    if (error instanceof ConfigurationCrashSimulation) throw error;
    if (lockAcquired) {
      try {
        await cleanupTransaction(state, paths, record);
      } catch {
        // The immutable lock remains recovery evidence if cleanup itself fails.
      }
    }
    if (error instanceof ConfigurationStoreError) throw error;
    return invalid("core.configuration.unavailable");
  }
};

const readLock = async (
  state: ConfigurationStoreInternals,
  path = join(state.home.mutationDirectory, LOCK_FILE_NAME),
): Promise<ConfigurationLockRecord> => {
  const value = await readBoundedFile(state.fileSystem, path);
  if (value === undefined) return invalid("core.configuration.missing");
  try {
    const parsed = lockRecordSchema.safeParse(JSON.parse(value) as unknown);
    if (!parsed.success) return invalid("core.configuration.invalid");
    if (`${JSON.stringify(parsed.data)}\n` !== value)
      return invalid("core.configuration.invalid");
    return parsed.data;
  } catch {
    return invalid("core.configuration.invalid");
  }
};

const validatedRecoveryPaths = (
  state: ConfigurationStoreInternals,
  record: ConfigurationLockRecord,
): ReturnType<typeof transactionPaths> => {
  const paths = transactionPaths(state, record.transactionId);
  if (
    record.candidateFileName !==
      paths.candidate.slice(state.home.root.length + 1) ||
    record.backupStageFileName !==
      paths.backupStage.slice(state.home.root.length + 1)
  )
    return invalid("core.configuration.invalid");
  return paths;
};

const recoveryEvidence = async (
  state: ConfigurationStoreInternals,
  record: ConfigurationLockRecord,
): Promise<Readonly<{ committed: boolean; generation: number | null }>> => {
  const activeText = await readBoundedFile(
    state.fileSystem,
    state.home.configFile,
  );
  const active = parseCurrent(activeText, state.registry);
  const generation = active?.generation ?? null;
  const committed = generation === record.candidateGeneration;
  const stillPrior = generation === record.expectedGeneration;
  const expectedDigest = committed
    ? record.candidateDigest
    : record.expectedDigest;
  if (
    (!committed && !stillPrior) ||
    (activeText === undefined
      ? expectedDigest !== null
      : digest(activeText) !== expectedDigest)
  )
    return invalid("core.configuration.conflict");
  return Object.freeze({ committed, generation });
};

const ownerDisposition = (
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
  record: Readonly<{ owner: ConfigurationProcessIdentity }>,
): ConfigurationOwnerState => {
  try {
    const candidate: unknown = ownerState(Object.freeze(record.owner));
    observeUnexpectedPromise(candidate);
    if (candidate === "dead" || candidate === "live" || candidate === "unknown")
      return candidate;
  } catch {
    // Every hostile owner probe collapses to unknown.
  }
  return "unknown";
};

const readCredentialIntent = async (
  state: ConfigurationStoreInternals,
): Promise<CredentialMutationIntent> => {
  const value = await readBoundedFile(
    state.fileSystem,
    credentialIntentPath(state),
  );
  if (value === undefined) return invalid("core.configuration.missing");
  return parseCredentialIntent(value);
};

const sameCredentialIntent = (
  left: CredentialMutationIntent,
  right: CredentialMutationIntent,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const readLocalResourceIntent = async (
  state: ConfigurationStoreInternals,
  path = localResourceIntentPath(state),
): Promise<LocalResourceMutationIntent> => {
  const value = await readBoundedFile(state.fileSystem, path);
  if (value === undefined) return invalid("core.configuration.missing");
  return parseLocalResourceIntent(value);
};

export const createLocalResourceMutationIntent = async (
  store: ConfigurationStore,
  input: LocalResourceMutationIntent,
  // eslint-disable-next-line max-lines-per-function, complexity -- exact hostile reconstruction and reciprocal publication are one atomic boundary.
): Promise<LocalResourceMutationIntent> => {
  const state = stored(store);
  let record: LocalResourceMutationIntent;
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      return invalid("core.configuration.invalid");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = [
      "authorizedCandidates",
      "connectionId",
      "destinationType",
      "expectedDigest",
      "expectedGeneration",
      "lifecycleFingerprint",
      "operation",
      "operationId",
      "owner",
      "recordVersion",
      "recoveryHandlerId",
    ];
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !keys.includes(key),
      ) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return invalid("core.configuration.invalid");
    const candidatesValue = descriptors.authorizedCandidates?.value as unknown;
    if (!Array.isArray(candidatesValue))
      return invalid("core.configuration.invalid");
    const arrayDescriptors = Object.getOwnPropertyDescriptors(
      candidatesValue,
    ) as unknown as PropertyDescriptorMap;
    const length = arrayDescriptors.length?.value as unknown;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 2 ||
      Reflect.ownKeys(arrayDescriptors).length !== length + 1 ||
      Reflect.ownKeys(arrayDescriptors).some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(?:0|1)$/u.test(key)),
      )
    )
      return invalid("core.configuration.invalid");
    const authorizedCandidates = [];
    for (let index = 0; index < length; index += 1) {
      const arrayDescriptor = arrayDescriptors[String(index)];
      if (!arrayDescriptor || !("value" in arrayDescriptor))
        return invalid("core.configuration.invalid");
      const candidate = arrayDescriptor.value as unknown;
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        Object.getPrototypeOf(candidate) !== Object.prototype
      )
        return invalid("core.configuration.invalid");
      const candidateDescriptors = Object.getOwnPropertyDescriptors(candidate);
      if (
        Object.keys(candidateDescriptors).sort().join(",") !==
          "digest,generation" ||
        Reflect.ownKeys(candidateDescriptors).length !== 2 ||
        Object.values(candidateDescriptors).some(
          (descriptor) => !("value" in descriptor),
        )
      )
        return invalid("core.configuration.invalid");
      authorizedCandidates.push({
        generation: candidateDescriptors.generation?.value as unknown,
        digest: candidateDescriptors.digest?.value as unknown,
      });
    }
    const ownerValue = descriptors.owner?.value as unknown;
    if (!isConfigurationProcessIdentity(ownerValue))
      return invalid("core.configuration.invalid");
    record = parseLocalResourceIntent(
      `${JSON.stringify({
        recordVersion: descriptors.recordVersion?.value,
        operation: descriptors.operation?.value,
        operationId: descriptors.operationId?.value,
        owner: ownerValue,
        destinationType: descriptors.destinationType?.value,
        connectionId: descriptors.connectionId?.value,
        lifecycleFingerprint: descriptors.lifecycleFingerprint?.value,
        recoveryHandlerId: descriptors.recoveryHandlerId?.value,
        expectedGeneration: descriptors.expectedGeneration?.value,
        expectedDigest: descriptors.expectedDigest?.value,
        authorizedCandidates,
      })}\n`,
    );
    await ensureAgentscopeHomeLayout(state.home);
    if (
      (await configurationFencePresent(state)) ||
      (await readBoundedFile(state.fileSystem, credentialIntentPath(state))) !==
        undefined ||
      (await readBoundedFile(
        state.fileSystem,
        credentialRecoveryClaimPath(state),
      )) !== undefined ||
      (await readBoundedFile(
        state.fileSystem,
        localResourceRecoveryClaimPath(state),
      )) !== undefined ||
      (await readBoundedFile(
        state.fileSystem,
        localResourceCompletionPath(state),
      )) !== undefined
    )
      return invalid("core.configuration.contention");
    await writeDurableExclusive(
      state.fileSystem,
      localResourceIntentPath(state),
      `${JSON.stringify(record)}\n`,
    );
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
    if (
      (await configurationFencePresent(state)) ||
      (await readBoundedFile(state.fileSystem, credentialIntentPath(state))) !==
        undefined ||
      (await readBoundedFile(
        state.fileSystem,
        credentialRecoveryClaimPath(state),
      )) !== undefined ||
      (await readBoundedFile(
        state.fileSystem,
        localResourceRecoveryClaimPath(state),
      )) !== undefined ||
      (await readBoundedFile(
        state.fileSystem,
        localResourceCompletionPath(state),
      )) !== undefined
    ) {
      const current = await readLocalResourceIntent(state);
      if (sameLocalResourceIntent(current, record))
        await state.fileSystem.unlink(localResourceIntentPath(state));
      return invalid("core.configuration.contention");
    }
    localResourceMutationIntentRegistry.add(record);
    return record;
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST")
      return invalid("core.configuration.contention");
    if (error instanceof ConfigurationStoreError) throw error;
    return invalid("core.configuration.unavailable");
  }
};

export const completeLocalResourceMutationIntent = async (
  store: ConfigurationStore,
  expected: LocalResourceMutationIntent,
): Promise<void> => {
  if (
    typeof expected !== "object" ||
    expected === null ||
    !localResourceMutationIntentRegistry.has(expected)
  )
    return invalid("core.configuration.invalid");
  const state = stored(store);
  if (completedLocalResourceIntents.has(expected)) {
    const completed = await readLocalResourceIntent(
      state,
      localResourceCompletionPath(state),
    );
    if (!sameLocalResourceIntent(completed, expected))
      return invalid("core.configuration.conflict");
    return;
  }
  const path = claimedLocalResourceIntents.has(expected)
    ? localResourceRecoveryClaimPath(state)
    : localResourceIntentPath(state);
  const current = await readLocalResourceIntent(state, path);
  if (!sameLocalResourceIntent(current, expected))
    return invalid("core.configuration.conflict");
  try {
    await linkForState(state, path, localResourceCompletionPath(state));
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
    await state.fileSystem.unlink(path);
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
    completedLocalResourceIntents.add(expected);
  } catch {
    return invalid("core.configuration.unavailable");
  }
};

export const isLocalResourceMutationCompletion = (
  intent: LocalResourceMutationIntent,
): boolean =>
  typeof intent === "object" &&
  intent !== null &&
  localResourceMutationIntentRegistry.has(intent) &&
  completedLocalResourceIntents.has(intent);

export const finalizeLocalResourceMutationCompletion = async (
  store: ConfigurationStore,
  expected: LocalResourceMutationIntent,
): Promise<void> => {
  if (
    typeof expected !== "object" ||
    expected === null ||
    !localResourceMutationIntentRegistry.has(expected) ||
    !completedLocalResourceIntents.has(expected)
  )
    return invalid("core.configuration.invalid");
  const state = stored(store);
  const completion = await readLocalResourceIntent(
    state,
    localResourceCompletionPath(state),
  );
  if (!sameLocalResourceIntent(completion, expected))
    return invalid("core.configuration.conflict");
  try {
    for (const path of [
      localResourceRecoveryClaimPath(state),
      localResourceIntentPath(state),
      localResourceCompletionPath(state),
    ]) {
      const value = await readBoundedFile(state.fileSystem, path);
      if (value === undefined) continue;
      if (!sameLocalResourceIntent(parseLocalResourceIntent(value), expected))
        return invalid("core.configuration.conflict");
      await state.fileSystem.unlink(path);
    }
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
  } catch {
    return invalid("core.configuration.unavailable");
  }
};

export const inspectLocalResourceMutation = async (
  store: ConfigurationStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<LocalResourceMutationInspection> => {
  try {
    const state = stored(store);
    const completion = await readBoundedFile(
      state.fileSystem,
      localResourceCompletionPath(state),
    );
    if (completion !== undefined) {
      parseLocalResourceIntent(completion);
      return Object.freeze({ state: "recoverable" });
    }
    const claim = await readBoundedFile(
      state.fileSystem,
      localResourceRecoveryClaimPath(state),
    );
    if (claim !== undefined) {
      parseLocalResourceIntent(claim);
      return Object.freeze({ state: "reconciliation-required" });
    }
    const record = await readLocalResourceIntent(state);
    const disposition = ownerDisposition(ownerState, record);
    return Object.freeze({
      state:
        disposition === "live"
          ? "active"
          : disposition === "dead"
            ? "recoverable"
            : "owner-unknown",
    });
  } catch (error) {
    if (!(error instanceof ConfigurationStoreError))
      return Object.freeze({ state: "unavailable" });
    if (error.code === "core.configuration.missing")
      return Object.freeze({ state: "clean" });
    if (error.code === "core.configuration.invalid")
      return Object.freeze({ state: "invalid" });
    return Object.freeze({ state: "unavailable" });
  }
};

export const readRecoverableLocalResourceMutationIntent = async (
  store: ConfigurationStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<LocalResourceMutationIntent> => {
  const state = stored(store);
  const completion = await readBoundedFile(
    state.fileSystem,
    localResourceCompletionPath(state),
  );
  if (completion !== undefined) {
    const record = parseLocalResourceIntent(completion);
    completedLocalResourceIntents.add(record);
    localResourceMutationIntentRegistry.add(record);
    return record;
  }
  const record = await readLocalResourceIntent(state);
  const disposition = ownerDisposition(ownerState, record);
  if (disposition === "live")
    return invalid("core.configuration.recovery-owner-live");
  if (disposition !== "dead")
    return invalid("core.configuration.recovery-owner-unknown");
  try {
    await linkForState(
      state,
      localResourceIntentPath(state),
      localResourceRecoveryClaimPath(state),
    );
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
  } catch {
    return invalid("core.configuration.contention");
  }
  const claimed = await readLocalResourceIntent(
    state,
    localResourceRecoveryClaimPath(state),
  );
  const fixed = await readLocalResourceIntent(state);
  if (
    !sameLocalResourceIntent(claimed, record) ||
    !sameLocalResourceIntent(fixed, record)
  ) {
    await unlinkIfPresent(
      state.fileSystem,
      localResourceRecoveryClaimPath(state),
    );
    return invalid("core.configuration.conflict");
  }
  if (ownerDisposition(ownerState, claimed) !== "dead") {
    await unlinkIfPresent(
      state.fileSystem,
      localResourceRecoveryClaimPath(state),
    );
    return invalid("core.configuration.recovery-owner-unknown");
  }
  await state.fileSystem.unlink(localResourceIntentPath(state));
  await syncDirectory(state.fileSystem, state.home.mutationDirectory);
  claimedLocalResourceIntents.add(claimed);
  localResourceMutationIntentRegistry.add(claimed);
  return claimed;
};

export const createCredentialMutationIntent = async (
  store: ConfigurationStore,
  input: CredentialMutationIntent,
): Promise<CredentialMutationIntent> => {
  const state = stored(store);
  if (typeof input !== "object" || input === null) {
    return invalid("core.configuration.invalid");
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return invalid("core.configuration.invalid");
  }
  if (
    Object.keys(descriptors).sort().join(",") !==
      "operation,owner,ownership,recordVersion,reference" ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor)) ||
    descriptors.recordVersion?.value !== 1 ||
    !isConfigurationProcessIdentity(descriptors.owner?.value)
  )
    return invalid("core.configuration.invalid");
  const ownership = cloneConfigurationDocument(
    descriptors.ownership?.value,
  ) as Record<string, unknown>;
  const reference = cloneConfigurationDocument(
    descriptors.reference?.value,
  ) as Record<string, unknown>;
  const operation = (descriptors.operation as unknown as { value: unknown })
    .value;
  const record = parseCredentialIntent(
    `${JSON.stringify({
      recordVersion: 1,
      operation,
      owner: descriptors.owner.value,
      ownership: {
        destinationType: ownership.destinationType,
        connectionId: ownership.connectionId,
        slot: ownership.slot,
      },
      reference:
        reference.backend === "ci-environment"
          ? {
              referenceVersion: reference.referenceVersion,
              backend: reference.backend,
              environmentVariable: reference.environmentVariable,
              generationId: reference.generationId,
            }
          : {
              referenceVersion: reference.referenceVersion,
              backend: reference.backend,
              referenceId: reference.referenceId,
              generationId: reference.generationId,
            },
    })}\n`,
  );
  try {
    await ensureAgentscopeHomeLayout(state.home);
    if (
      (await configurationFencePresent(state)) ||
      (await localResourceFencePresent(state))
    )
      return invalid("core.configuration.contention");
    if (
      (await readBoundedFile(
        state.fileSystem,
        credentialRecoveryClaimPath(state),
      )) !== undefined
    )
      return invalid("core.configuration.contention");
    await writeDurableExclusive(
      state.fileSystem,
      credentialIntentPath(state),
      `${JSON.stringify(record)}\n`,
    );
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
    if (
      (await readBoundedFile(
        state.fileSystem,
        credentialRecoveryClaimPath(state),
      )) !== undefined ||
      (await configurationFencePresent(state)) ||
      (await localResourceFencePresent(state))
    ) {
      const current = await readCredentialIntent(state);
      if (sameCredentialIntent(current, record))
        await state.fileSystem.unlink(credentialIntentPath(state));
      return invalid("core.configuration.contention");
    }
    credentialMutationIntentRegistry.add(record);
    return record;
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST")
      return invalid("core.configuration.contention");
    /* v8 ignore next -- filesystem and layout helpers in this guarded block
       never produce a pre-normalized ConfigurationStoreError. */
    if (error instanceof ConfigurationStoreError) throw error;
    return invalid("core.configuration.unavailable");
  }
};

export const completeCredentialMutationIntent = async (
  store: ConfigurationStore,
  expected: CredentialMutationIntent,
): Promise<void> => {
  const state = stored(store);
  const path = claimedCredentialIntents.has(expected)
    ? credentialRecoveryClaimPath(state)
    : credentialIntentPath(state);
  const value = await readBoundedFile(state.fileSystem, path);
  if (value === undefined) return invalid("core.configuration.missing");
  const current = parseCredentialIntent(value);
  if (!sameCredentialIntent(current, expected))
    return invalid("core.configuration.conflict");
  try {
    await state.fileSystem.unlink(path);
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
  } catch {
    return invalid("core.configuration.unavailable");
  }
};

export const isCredentialMutationIntentActiveForCore = async (
  store: ConfigurationStore,
  expected: CredentialMutationIntent,
): Promise<boolean> => {
  if (
    typeof expected !== "object" ||
    expected === null ||
    !credentialMutationIntentRegistry.has(expected)
  )
    return false;
  const state = stored(store);
  for (const path of [
    credentialRecoveryClaimPath(state),
    credentialIntentPath(state),
  ]) {
    const value = await readBoundedFile(state.fileSystem, path);
    if (
      value !== undefined &&
      sameCredentialIntent(parseCredentialIntent(value), expected)
    )
      return true;
  }
  return false;
};

export const inspectCredentialMutation = async (
  store: ConfigurationStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<CredentialMutationInspection> => {
  try {
    const state = stored(store);
    const claim = await readBoundedFile(
      state.fileSystem,
      credentialRecoveryClaimPath(state),
    );
    if (claim !== undefined) {
      parseCredentialIntent(claim);
      return Object.freeze({ state: "reconciliation-required" });
    }
    const record = await readCredentialIntent(state);
    const disposition = ownerDisposition(ownerState, record);
    return Object.freeze({
      state:
        disposition === "live"
          ? "active"
          : disposition === "dead"
            ? "recoverable"
            : "owner-unknown",
    });
  } catch (error) {
    /* v8 ignore next -- readCredentialIntent normalizes every public failure
       to ConfigurationStoreError before this inspection boundary. */
    if (!(error instanceof ConfigurationStoreError))
      return Object.freeze({ state: "unavailable" });
    if (error.code === "core.configuration.missing")
      return Object.freeze({ state: "clean" });
    if (error.code === "core.configuration.invalid")
      return Object.freeze({ state: "invalid" });
    return Object.freeze({ state: "unavailable" });
  }
};

export const readRecoverableCredentialMutationIntent = async (
  store: ConfigurationStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<CredentialMutationIntent> => {
  const state = stored(store);
  const record = await readCredentialIntent(state);
  const disposition = ownerDisposition(ownerState, record);
  if (disposition === "live")
    return invalid("core.configuration.recovery-owner-live");
  if (disposition !== "dead")
    return invalid("core.configuration.recovery-owner-unknown");
  try {
    await linkForState(
      state,
      credentialIntentPath(state),
      credentialRecoveryClaimPath(state),
    );
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
  } catch {
    return invalid("core.configuration.contention");
  }
  const claimedValue = await readBoundedFile(
    state.fileSystem,
    credentialRecoveryClaimPath(state),
  );
  const claimed =
    claimedValue === undefined
      ? invalid("core.configuration.conflict")
      : parseCredentialIntent(claimedValue);
  const fixed = await readCredentialIntent(state);
  if (
    !sameCredentialIntent(claimed, record) ||
    !sameCredentialIntent(fixed, record)
  ) {
    await unlinkIfPresent(state.fileSystem, credentialRecoveryClaimPath(state));
    return invalid("core.configuration.conflict");
  }
  if (ownerDisposition(ownerState, claimed) !== "dead") {
    await unlinkIfPresent(state.fileSystem, credentialRecoveryClaimPath(state));
    return invalid("core.configuration.recovery-owner-unknown");
  }
  await state.fileSystem.unlink(credentialIntentPath(state));
  await syncDirectory(state.fileSystem, state.home.mutationDirectory);
  claimedCredentialIntents.add(claimed);
  credentialMutationIntentRegistry.add(claimed);
  return claimed;
};

export const inspectConfigurationTransaction = async (
  store: ConfigurationStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<ConfigurationTransactionInspection> => {
  let state: ConfigurationStoreInternals;
  try {
    state = stored(store);
    const claimValue = await readBoundedFile(
      state.fileSystem,
      recoveryClaimPath(state),
    );
    if (claimValue !== undefined) {
      const claim = await readLock(state, recoveryClaimPath(state));
      validatedRecoveryPaths(state, claim);
      return Object.freeze({ state: "reconciliation-required" });
    }
    const record = await readLock(state);
    validatedRecoveryPaths(state, record);
    const disposition = ownerDisposition(ownerState, record);
    if (disposition === "live") return Object.freeze({ state: "active" });
    if (disposition !== "dead")
      return Object.freeze({ state: "owner-unknown" });
    const evidence = await recoveryEvidence(state, record);
    return Object.freeze({ state: "recoverable", ...evidence });
  } catch (error) {
    /* v8 ignore next 2 -- stored/read/parse/recovery helpers normalize every
       public inspection failure to ConfigurationStoreError. */
    if (!(error instanceof ConfigurationStoreError))
      return Object.freeze({ state: "unavailable" });
    if (error.code === "core.configuration.missing")
      return Object.freeze({ state: "clean" });
    if (error.code === "core.configuration.conflict")
      return Object.freeze({ state: "conflict" });
    if (error.code === "core.configuration.invalid")
      return Object.freeze({ state: "invalid" });
    return Object.freeze({ state: "unavailable" });
  }
};

export const recoverAbandonedConfigurationTransaction = async (
  store: ConfigurationStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
  localResourceIntent?: LocalResourceMutationIntent,
): Promise<ConfigurationRecoveryResult> => {
  const state = stored(store);
  if (await localResourceFencePresent(state)) {
    if (
      !localResourceIntent ||
      !localResourceMutationIntentRegistry.has(localResourceIntent) ||
      !claimedLocalResourceIntents.has(localResourceIntent)
    )
      return invalid("core.configuration.contention");
    const claimed = await readLocalResourceIntent(
      state,
      localResourceRecoveryClaimPath(state),
    );
    if (!sameLocalResourceIntent(claimed, localResourceIntent))
      return invalid("core.configuration.contention");
  } else if (localResourceIntent !== undefined) {
    return invalid("core.configuration.conflict");
  }
  const record = await readLock(state);
  if (
    localResourceIntent &&
    !localResourceIntent.authorizedCandidates.some(
      (candidate) =>
        candidate.generation === record.candidateGeneration &&
        candidate.digest === `sha256-${record.candidateDigest}`,
    )
  )
    return invalid("core.configuration.conflict");
  const disposition = ownerDisposition(ownerState, record);
  if (disposition === "live")
    return invalid("core.configuration.recovery-owner-live");
  if (disposition !== "dead")
    return invalid("core.configuration.recovery-owner-unknown");
  const claim = recoveryClaimPath(state);
  try {
    await linkForState(
      state,
      join(state.home.mutationDirectory, LOCK_FILE_NAME),
      claim,
    );
    await syncDirectory(state.fileSystem, state.home.mutationDirectory);
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST")
      return invalid("core.configuration.contention");
    return invalid("core.configuration.contention");
  }
  const claimed = await readLock(state, claim);
  const fixed = await readLock(state);
  if (
    JSON.stringify(claimed) !== JSON.stringify(record) ||
    JSON.stringify(fixed) !== JSON.stringify(record)
  ) {
    await unlinkIfPresent(state.fileSystem, claim);
    return invalid("core.configuration.conflict");
  }
  if (ownerDisposition(ownerState, claimed) !== "dead") {
    await unlinkIfPresent(state.fileSystem, claim);
    return invalid("core.configuration.recovery-owner-unknown");
  }
  await state.fileSystem.unlink(
    join(state.home.mutationDirectory, LOCK_FILE_NAME),
  );
  await syncDirectory(state.fileSystem, state.home.mutationDirectory);
  const paths = validatedRecoveryPaths(state, claimed);
  const evidence = await recoveryEvidence(state, claimed);
  await cleanupTransaction(state, paths, claimed, claim);
  return Object.freeze({
    recovered: true as const,
    committed: evidence.committed,
    generation: evidence.generation,
  });
};
