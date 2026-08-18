import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
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
} from "@agentscope/destinations-core";
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
  createTransactionId: () => string;
  afterStep?: (step: ConfigurationTransactionStep) => void;
}>;

const storeRegistry = new WeakMap<object, ConfigurationStoreInternals>();
const processIdentityRegistry = new WeakSet<object>();
const credentialMutationIntentRegistry = new WeakSet<object>();
const claimedCredentialIntents = new WeakSet<object>();
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

type ConfigurationLockRecord = z.infer<typeof lockRecordSchema>;

const credentialIntentPath = (state: ConfigurationStoreInternals): string =>
  join(state.home.mutationDirectory, CREDENTIAL_INTENT_FILE_NAME);

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
): Promise<HookConfigurationReadResult> => {
  try {
    const snapshot = await readConfigurationSnapshot(store);
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
        !credentialMutationIntentRegistry.has(credentialMutationIntent)))
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
  });
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
    if (await configurationFencePresent(state))
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
      (await configurationFencePresent(state))
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
): Promise<ConfigurationRecoveryResult> => {
  const state = stored(store);
  const record = await readLock(state);
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
