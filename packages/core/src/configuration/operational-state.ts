import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link as nodeLink,
  open as nodeOpen,
  rename as nodeRename,
  unlink as nodeUnlink,
} from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  ensureAgentscopeHomeLayout,
  isAgentscopeHome,
  type AgentscopeHome,
} from "./home.js";
import { cloneConfigurationDocument } from "./plain-data.js";
import {
  isConfigurationProcessIdentity,
  type ConfigurationOwnerState,
  type ConfigurationProcessIdentity,
} from "./transaction.js";

const STATE_FILE_NAME = "operational-state-v1.json";
const LOCK_FILE_NAME = "operational-state.lock";
const RECOVERY_CLAIM_FILE_NAME = "operational-state.recovery.lock";
const MAXIMUM_STATE_BYTES = 262_144;
const MAXIMUM_DIAGNOSTICS = 128;
const MAXIMUM_HEALTH_MARKERS = 64;
const MAXIMUM_CHECKPOINTS = 128;
const DIAGNOSTIC_MAXIMUM_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const CHECKPOINT_MAXIMUM_AGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const FILE_MODE = 0o600;
/* v8 ignore next -- every supported Node platform exposes O_NOFOLLOW. */
const noFollow = constants.O_NOFOLLOW ?? 0;
const readFlags = constants.O_RDONLY | noFollow;
const createFlags =
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;

export const SANITIZED_DIAGNOSTIC_CODES = Object.freeze([
  "configuration-invalid",
  "configuration-recovery-needed",
  "credential-unavailable",
  "credential-locked",
  "credential-denied",
  "credential-missing",
  "credential-malformed",
  "policy-unavailable",
  "capture-failed",
  "checkpoint-unavailable",
  "native-source-loss",
  "redaction-suppressed",
  "no-route",
  "reporter-rejected",
  "reporter-unavailable",
  "reporter-deadline-exceeded",
  "reporter-outcome-unknown",
] as const);
export type SanitizedDiagnosticCode =
  (typeof SANITIZED_DIAGNOSTIC_CODES)[number];
export const PIPELINE_HEALTH_STAGES = Object.freeze([
  "hook-started",
  "capture",
  "redaction",
  "routing",
  "delivery",
  "remote-acceptance",
] as const);
export type PipelineHealthStage = (typeof PIPELINE_HEALTH_STAGES)[number];
export const PIPELINE_HEALTH_OUTCOMES = Object.freeze([
  "completed",
  "suppressed",
  "no-route",
  "accepted",
  "rejected",
  "unavailable",
  "deadline-exceeded",
  "outcome-unknown",
] as const);
export type PipelineHealthOutcome = (typeof PIPELINE_HEALTH_OUTCOMES)[number];

const connectionId = z
  .string()
  .regex(/^destination-connection-v1-[0-9a-f]{64}$/u);
const destinationType = z
  .string()
  .regex(/^@agentscope\/destination-[a-z0-9-]{1,64}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const nonnegative = z.number().int().nonnegative().safe();
const sequenceEntry = {
  sequence: nonnegative,
  observedAtUnixMilliseconds: nonnegative,
};
const diagnosticInputSchema = z.strictObject({
  code: z.enum(SANITIZED_DIAGNOSTIC_CODES),
  severity: z.enum(["info", "warning", "error"]),
  configurationGeneration: nonnegative.nullable(),
  destinationType: destinationType.optional(),
  connectionId: connectionId.optional(),
});
const diagnosticEntrySchema = diagnosticInputSchema.extend(sequenceEntry);
const healthInputSchema = z.strictObject({
  scope: z.enum(["hook", "connection"]),
  stage: z.enum(PIPELINE_HEALTH_STAGES),
  outcome: z.enum(PIPELINE_HEALTH_OUTCOMES),
  configurationGeneration: nonnegative,
  policyMode: z.enum(["baseline", "strict"]),
  destinationType: destinationType.optional(),
  connectionId: connectionId.optional(),
  receipt: z
    .enum([
      "accepted",
      "rejected",
      "unavailable",
      "deadline-exceeded",
      "outcome-unknown",
    ])
    .nullable(),
});
const healthEntrySchema = healthInputSchema.extend(sequenceEntry);
const checkpointInputSchema = z.strictObject({
  adapterId: z.string().regex(/^@agentscope\/harness-[a-z0-9-]{1,64}$/u),
  sourceIdentityDigest: digest,
  sourceGeneration: nonnegative,
  acknowledgedExclusivePosition: nonnegative,
  configurationGeneration: nonnegative,
  connectionId,
});
const checkpointEntrySchema = checkpointInputSchema.extend(sequenceEntry);
const documentSchema = z.strictObject({
  version: z.literal(1),
  nextSequence: nonnegative,
  losses: z.strictObject({
    diagnostics: nonnegative,
    health: nonnegative,
    checkpoints: nonnegative,
  }),
  diagnostics: z.array(diagnosticEntrySchema).max(MAXIMUM_DIAGNOSTICS),
  health: z.array(healthEntrySchema).max(MAXIMUM_HEALTH_MARKERS),
  checkpoints: z.array(checkpointEntrySchema).max(MAXIMUM_CHECKPOINTS),
});
const lockSchema = z.strictObject({
  version: z.literal(1),
  owner: z.strictObject({
    processId: z.number().int().positive().safe(),
    processStartIdentity: z.string().regex(/^process-start-v1-[0-9a-f]{64}$/u),
  }),
  token: z.string().regex(/^[0-9a-f]{32}$/u),
});

export type SanitizedDiagnosticInput = z.infer<typeof diagnosticInputSchema>;
export type PipelineHealthInput = z.infer<typeof healthInputSchema>;
export type CaptureCheckpointInput = z.infer<typeof checkpointInputSchema>;
type SanitizedDiagnosticEntry = z.infer<typeof diagnosticEntrySchema>;
type PipelineHealthEntry = z.infer<typeof healthEntrySchema>;
type CaptureCheckpointEntry = z.infer<typeof checkpointEntrySchema>;
export type OperationalStateSnapshot = Readonly<{
  version: 1;
  nextSequence: number;
  losses: Readonly<{
    diagnostics: number;
    health: number;
    checkpoints: number;
  }>;
  diagnostics: readonly Readonly<SanitizedDiagnosticEntry>[];
  health: readonly Readonly<PipelineHealthEntry>[];
  checkpoints: readonly Readonly<CaptureCheckpointEntry>[];
}>;
export type OperationalStateStore = Readonly<{
  readonly operationalStateStore: "agentscope-core";
}>;
export type OperationalStateWriteResult = Readonly<{
  recorded: boolean;
  code: "recorded" | "invalid" | "unavailable";
  losses: Readonly<{
    diagnostics: number;
    health: number;
    checkpoints: number;
  }>;
}>;
export type OperationalStateLockInspection = Readonly<{
  state:
    | "clean"
    | "active"
    | "owner-unknown"
    | "recoverable"
    | "reconciliation-required"
    | "invalid"
    | "unavailable";
}>;

type OperationalFileSystem = Readonly<{
  link?: typeof nodeLink;
  open: typeof nodeOpen;
  rename: typeof nodeRename;
  unlink: typeof nodeUnlink;
}>;
type StoreInternals = Readonly<{
  home: AgentscopeHome;
  owner: ConfigurationProcessIdentity;
  fileSystem: OperationalFileSystem;
  now: () => number;
  randomId: () => string;
}>;
type Document = z.infer<typeof documentSchema>;
type LockRecord = z.infer<typeof lockSchema>;

const stores = new WeakMap<object, StoreInternals>();
const queues = new WeakMap<object, Promise<void>>();
const nativeFileSystem: OperationalFileSystem = Object.freeze({
  link: nodeLink,
  open: nodeOpen,
  rename: nodeRename,
  unlink: nodeUnlink,
});
const emptyDocument = (): Document => ({
  version: 1,
  nextSequence: 0,
  losses: { diagnostics: 0, health: 0, checkpoints: 0 },
  diagnostics: [],
  health: [],
  checkpoints: [],
});

export class OperationalStateError extends Error {
  public readonly code = "core.operational-state.invalid";
  public constructor() {
    super("core.operational-state.invalid");
    this.name = "OperationalStateError";
  }
}
class OperationalStateUnavailableError extends Error {
  public constructor() {
    super("core.operational-state.unavailable");
    this.name = "OperationalStateUnavailableError";
  }
}
const invalid = (): never => {
  throw new OperationalStateError();
};
const stored = (store: OperationalStateStore): StoreInternals =>
  stores.get(store) ?? invalid();
export const isOperationalStateStore = (
  value: unknown,
): value is OperationalStateStore =>
  typeof value === "object" && value !== null && stores.has(value);
const stateFile = (state: StoreInternals): string =>
  join(state.home.healthDirectory, STATE_FILE_NAME);
const lockFile = (state: StoreInternals): string =>
  join(state.home.healthDirectory, LOCK_FILE_NAME);
const recoveryClaimFile = (state: StoreInternals): string =>
  join(state.home.healthDirectory, RECOVERY_CLAIM_FILE_NAME);
const canonical = (value: Document): string => `${JSON.stringify(value)}\n`;
const temporaryIdentityPattern = /^[0-9a-f]{32}$/u;
const fixedResult = (
  recorded: boolean,
  code: OperationalStateWriteResult["code"],
  document: Document,
): OperationalStateWriteResult =>
  Object.freeze({
    recorded,
    code,
    losses: Object.freeze({ ...document.losses }),
  });

const closeQuietly = async (
  handle: Awaited<ReturnType<typeof nodeOpen>> | undefined,
): Promise<void> => {
  try {
    await handle?.close();
  } catch {
    // The owning operation returns a fixed unavailable result.
  }
};

const nodeErrorCode = (error: unknown): string | undefined => {
  /* v8 ignore next -- Node filesystem failures are objects; this guard keeps
     injected runtime-cast adapters total without invoking hostile values. */
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
};

const syncDirectory = async (state: StoreInternals): Promise<void> => {
  const directory = await state.fileSystem.open(
    state.home.healthDirectory,
    readFlags,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

const acquireLock = async (state: StoreInternals): Promise<LockRecord> => {
  const token = state.randomId();
  if (typeof token !== "string" || !temporaryIdentityPattern.test(token))
    return invalid();
  let handle: Awaited<ReturnType<typeof nodeOpen>> | undefined;
  let created = false;
  try {
    if ((await readLock(state, recoveryClaimFile(state))) !== undefined)
      throw new OperationalStateUnavailableError();
    handle = await state.fileSystem.open(
      lockFile(state),
      createFlags,
      FILE_MODE,
    );
    created = true;
    const record = { version: 1 as const, owner: state.owner, token };
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(state);
    if ((await readLock(state, recoveryClaimFile(state))) !== undefined) {
      const current = await readLock(state);
      if (
        current?.token === record.token &&
        current.owner.processId === record.owner.processId &&
        current.owner.processStartIdentity === record.owner.processStartIdentity
      )
        await state.fileSystem.unlink(lockFile(state));
      created = false;
      throw new OperationalStateUnavailableError();
    }
    return record;
  } catch (error) {
    await closeQuietly(handle);
    if (nodeErrorCode(error) === "EEXIST")
      throw new OperationalStateUnavailableError();
    if (created)
      try {
        await state.fileSystem.unlink(lockFile(state));
      } catch {
        // Partial exclusive lock cleanup is best effort; Doctor handles remnants.
      }
    throw error;
  }
};

const releaseLock = async (
  state: StoreInternals,
  expected: LockRecord,
  path = lockFile(state),
): Promise<void> => {
  const current = await readLock(state, path);
  if (
    current === undefined ||
    current.token !== expected.token ||
    current.owner.processId !== expected.owner.processId ||
    current.owner.processStartIdentity !== expected.owner.processStartIdentity
  )
    throw new OperationalStateUnavailableError();
  await state.fileSystem.unlink(path);
  await syncDirectory(state);
};

const observeUnexpectedPromise = (value: unknown): void => {
  if (!(value instanceof Promise)) return;
  void Promise.prototype.then.call(
    value,
    () => undefined,
    () => undefined,
  );
};

const readLock = async (
  state: StoreInternals,
  path = lockFile(state),
): Promise<z.infer<typeof lockSchema> | undefined> => {
  let handle: Awaited<ReturnType<typeof nodeOpen>> | undefined;
  try {
    handle = await state.fileSystem.open(path, readFlags);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 1_024) return invalid();
    const bytes = Buffer.alloc(1_025);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > 1_024) return invalid();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
    const parsed = lockSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success || `${JSON.stringify(parsed.data)}\n` !== text)
      return invalid();
    return parsed.data;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    if (error instanceof OperationalStateError) throw error;
    throw new OperationalStateUnavailableError();
  } finally {
    await closeQuietly(handle);
  }
};

const lockOwnerState = (
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
  owner: ConfigurationProcessIdentity,
): ConfigurationOwnerState => {
  try {
    const result: unknown = ownerState(Object.freeze(owner));
    observeUnexpectedPromise(result);
    if (result === "dead" || result === "live" || result === "unknown")
      return result;
  } catch {
    // Hostile or asynchronous probes collapse to unknown.
  }
  return "unknown";
};

const readDocument = async (state: StoreInternals): Promise<Document> => {
  let handle: Awaited<ReturnType<typeof nodeOpen>> | undefined;
  try {
    handle = await state.fileSystem.open(stateFile(state), readFlags);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAXIMUM_STATE_BYTES)
      return invalid();
    const bytes = Buffer.alloc(MAXIMUM_STATE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAXIMUM_STATE_BYTES) return invalid();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
    const parsed = documentSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success || canonical(parsed.data) !== text) return invalid();
    return parsed.data;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT"
    )
      return emptyDocument();
    if (error instanceof OperationalStateError) throw error;
    return invalid();
  } finally {
    await closeQuietly(handle);
  }
};

const writeDocument = async (
  state: StoreInternals,
  document: Document,
): Promise<void> => {
  const text = canonical(document);
  /* v8 ignore next 2 -- the closed entry counts and fixed-width vocabulary
     make this outer file cap unreachable for a validated document. */
  if (Buffer.byteLength(text) > MAXIMUM_STATE_BYTES) return invalid();
  const temporaryIdentity = state.randomId();
  if (
    typeof temporaryIdentity !== "string" ||
    !temporaryIdentityPattern.test(temporaryIdentity)
  )
    return invalid();
  const temporary = join(
    state.home.healthDirectory,
    `.operational-state.${temporaryIdentity}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof nodeOpen>> | undefined;
  try {
    handle = await state.fileSystem.open(temporary, createFlags, FILE_MODE);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await state.fileSystem.rename(temporary, stateFile(state));
    await syncDirectory(state);
  } catch (error) {
    await closeQuietly(handle);
    try {
      await state.fileSystem.unlink(temporary);
    } catch {
      // The fixed owned temporary name is best-effort cleanup evidence.
    }
    throw error;
  }
};

const sortEntries = <
  T extends { sequence: number; observedAtUnixMilliseconds: number },
>(
  entries: T[],
): T[] =>
  entries.sort(
    (left, right) =>
      left.observedAtUnixMilliseconds - right.observedAtUnixMilliseconds ||
      left.sequence - right.sequence,
  );

const prune = (document: Document, now: number): Document => {
  const diagnosticCutoff = Math.max(
    0,
    now - DIAGNOSTIC_MAXIMUM_AGE_MILLISECONDS,
  );
  const checkpointCutoff = Math.max(
    0,
    now - CHECKPOINT_MAXIMUM_AGE_MILLISECONDS,
  );
  const diagnostics = document.diagnostics.filter(
    (entry) => entry.observedAtUnixMilliseconds >= diagnosticCutoff,
  );
  const health = document.health.filter(
    (entry) => entry.observedAtUnixMilliseconds >= diagnosticCutoff,
  );
  const checkpoints = document.checkpoints.filter(
    (entry) => entry.observedAtUnixMilliseconds >= checkpointCutoff,
  );
  return {
    ...document,
    losses: {
      diagnostics:
        document.losses.diagnostics +
        document.diagnostics.length -
        diagnostics.length,
      health: document.losses.health + document.health.length - health.length,
      checkpoints:
        document.losses.checkpoints +
        document.checkpoints.length -
        checkpoints.length,
    },
    diagnostics,
    health,
    checkpoints,
  };
};

const bound = (document: Document): Document => {
  const diagnostics = sortEntries(document.diagnostics).slice(
    -MAXIMUM_DIAGNOSTICS,
  );
  const health = sortEntries(document.health).slice(-MAXIMUM_HEALTH_MARKERS);
  const checkpoints = sortEntries(document.checkpoints).slice(
    -MAXIMUM_CHECKPOINTS,
  );
  return {
    ...document,
    losses: {
      diagnostics:
        document.losses.diagnostics +
        document.diagnostics.length -
        diagnostics.length,
      health: document.losses.health + document.health.length - health.length,
      checkpoints:
        document.losses.checkpoints +
        document.checkpoints.length -
        checkpoints.length,
    },
    diagnostics,
    health,
    checkpoints,
  };
};

const exactInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  try {
    const parsed = schema.safeParse(cloneConfigurationDocument(value));
    if (!parsed.success) return invalid();
    return parsed.data;
  } catch {
    return invalid();
  }
};

const diagnosticIsConsistent = (value: SanitizedDiagnosticInput): boolean =>
  (value.destinationType === undefined) === (value.connectionId === undefined);

const healthIsConsistent = (value: PipelineHealthInput): boolean => {
  const hasDestination =
    value.destinationType !== undefined && value.connectionId !== undefined;
  if (value.scope === "hook" ? hasDestination : !hasDestination) return false;
  if (
    value.scope === "hook" &&
    (value.destinationType !== undefined || value.connectionId !== undefined)
  )
    return false;
  return value.receipt === null || value.receipt === value.outcome;
};

const serialize = async <T>(
  store: OperationalStateStore,
  schema: z.ZodType<T>,
  input: unknown,
  update: (
    document: Document,
    value: T,
    sequence: number,
    now: number,
  ) => Document,
): Promise<OperationalStateWriteResult> => {
  const state = stored(store);
  let release!: () => void;
  const previous = queues.get(store) ?? Promise.resolve();
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(
    store,
    previous.then(() => current),
  );
  await previous;
  let document = emptyDocument();
  let lockRecord: LockRecord | undefined;
  try {
    const value = exactInput(schema, input);
    await ensureAgentscopeHomeLayout(state.home);
    lockRecord = await acquireLock(state);
    document = await readDocument(state);
    const now = state.now();
    if (!Number.isSafeInteger(now) || now < 0) return invalid();
    if (document.nextSequence === Number.MAX_SAFE_INTEGER) return invalid();
    document = bound(
      update(prune(document, now), value, document.nextSequence, now),
    );
    document.nextSequence += 1;
    const currentLock = await readLock(state);
    if (
      currentLock === undefined ||
      currentLock.token !== lockRecord.token ||
      currentLock.owner.processId !== lockRecord.owner.processId ||
      currentLock.owner.processStartIdentity !==
        lockRecord.owner.processStartIdentity
    )
      throw new OperationalStateUnavailableError();
    await writeDocument(state, document);
    await releaseLock(state, lockRecord);
    lockRecord = undefined;
    return fixedResult(true, "recorded", document);
  } catch (error) {
    if (lockRecord !== undefined)
      try {
        await releaseLock(state, lockRecord);
      } catch {
        return fixedResult(false, "unavailable", document);
      }
    return fixedResult(
      false,
      error instanceof OperationalStateError ? "invalid" : "unavailable",
      document,
    );
  } finally {
    release();
  }
};

export const createOperationalStateStore = (
  home: AgentscopeHome,
  owner: ConfigurationProcessIdentity,
): OperationalStateStore =>
  createOperationalStateStoreForTesting({ home, owner });

export const createOperationalStateStoreForTesting = (input: {
  home: AgentscopeHome;
  owner: ConfigurationProcessIdentity;
  fileSystem?: OperationalFileSystem;
  now?: () => number;
  randomId?: () => string;
}): OperationalStateStore => {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).some(
      (key) =>
        !["fileSystem", "home", "now", "owner", "randomId"].includes(key),
    ) ||
    !descriptors.home ||
    !descriptors.owner ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const home = descriptors.home.value as unknown;
  const owner = descriptors.owner.value as unknown;
  const fileSystem = descriptors.fileSystem?.value as
    OperationalFileSystem | undefined;
  const now = descriptors.now?.value as (() => number) | undefined;
  const randomId = descriptors.randomId?.value as (() => string) | undefined;
  if (
    !isAgentscopeHome(home) ||
    !isConfigurationProcessIdentity(owner) ||
    (fileSystem !== undefined &&
      (typeof fileSystem !== "object" || fileSystem === null)) ||
    (now !== undefined && typeof now !== "function") ||
    (randomId !== undefined && typeof randomId !== "function")
  )
    return invalid();
  const store = Object.freeze({
    operationalStateStore: "agentscope-core" as const,
  });
  stores.set(
    store,
    Object.freeze({
      home,
      owner,
      fileSystem: fileSystem ?? nativeFileSystem,
      now: now ?? Date.now,
      randomId: randomId ?? (() => randomBytes(16).toString("hex")),
    }),
  );
  return store;
};

export const recordSanitizedDiagnostic = (
  store: OperationalStateStore,
  input: SanitizedDiagnosticInput,
): Promise<OperationalStateWriteResult> => {
  return serialize(
    store,
    diagnosticInputSchema,
    input,
    (document, value, sequence, now) => ({
      ...document,
      diagnostics: diagnosticIsConsistent(value)
        ? [
            ...document.diagnostics,
            { ...value, sequence, observedAtUnixMilliseconds: now },
          ]
        : invalid(),
    }),
  );
};

export const recordPipelineHealth = (
  store: OperationalStateStore,
  input: PipelineHealthInput,
): Promise<OperationalStateWriteResult> =>
  serialize(
    store,
    healthInputSchema,
    input,
    (document, value, sequence, now) => {
      if (!healthIsConsistent(value)) return invalid();
      const health = document.health.filter((entry) =>
        value.scope === "hook"
          ? entry.scope !== "hook"
          : entry.connectionId !== value.connectionId,
      );
      return {
        ...document,
        health: [
          ...health,
          { ...value, sequence, observedAtUnixMilliseconds: now },
        ],
      };
    },
  );

export const recordCaptureCheckpoint = (
  store: OperationalStateStore,
  input: CaptureCheckpointInput,
): Promise<OperationalStateWriteResult> =>
  serialize(
    store,
    checkpointInputSchema,
    input,
    (document, value, sequence, now) => ({
      ...document,
      checkpoints: [
        ...document.checkpoints.filter(
          (entry) =>
            entry.adapterId !== value.adapterId ||
            entry.sourceIdentityDigest !== value.sourceIdentityDigest ||
            entry.connectionId !== value.connectionId,
        ),
        { ...value, sequence, observedAtUnixMilliseconds: now },
      ],
    }),
  );

const freezeDocument = (document: Document): OperationalStateSnapshot =>
  Object.freeze({
    ...document,
    losses: Object.freeze({ ...document.losses }),
    diagnostics: Object.freeze(
      document.diagnostics.map((entry) => Object.freeze({ ...entry })),
    ),
    health: Object.freeze(
      document.health.map((entry) => Object.freeze({ ...entry })),
    ),
    checkpoints: Object.freeze(
      document.checkpoints.map((entry) => Object.freeze({ ...entry })),
    ),
  });

export const inspectOperationalState = async (
  store: OperationalStateStore,
): Promise<OperationalStateSnapshot> => {
  const state = stored(store);
  return freezeDocument(await readDocument(state));
};

export const inspectOperationalStateLock = async (
  store: OperationalStateStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<OperationalStateLockInspection> => {
  try {
    const state = stored(store);
    const claim = await readLock(state, recoveryClaimFile(state));
    if (claim) return Object.freeze({ state: "reconciliation-required" });
    const record = await readLock(state);
    if (!record) return Object.freeze({ state: "clean" });
    const disposition = lockOwnerState(ownerState, record.owner);
    return Object.freeze({
      state:
        disposition === "live"
          ? "active"
          : disposition === "dead"
            ? "recoverable"
            : "owner-unknown",
    });
  } catch (error) {
    return Object.freeze({
      state: error instanceof OperationalStateError ? "invalid" : "unavailable",
    });
  }
};

export const recoverAbandonedOperationalStateLock = async (
  store: OperationalStateStore,
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState,
): Promise<Readonly<{ recovered: true }>> => {
  const state = stored(store);
  const record = await readLock(state);
  if (!record) return invalid();
  if (lockOwnerState(ownerState, record.owner) !== "dead") return invalid();
  const claim = recoveryClaimFile(state);
  try {
    await (state.fileSystem.link ?? nodeLink)(lockFile(state), claim);
    await syncDirectory(state);
  } catch {
    throw new OperationalStateUnavailableError();
  }
  const claimed = await readLock(state, claim);
  const fixed = await readLock(state);
  if (
    !claimed ||
    !fixed ||
    claimed.token !== record.token ||
    fixed.token !== record.token ||
    claimed.owner.processId !== record.owner.processId ||
    fixed.owner.processId !== record.owner.processId ||
    claimed.owner.processStartIdentity !== record.owner.processStartIdentity ||
    fixed.owner.processStartIdentity !== record.owner.processStartIdentity ||
    lockOwnerState(ownerState, claimed.owner) !== "dead"
  ) {
    try {
      await state.fileSystem.unlink(claim);
    } catch {
      // The immutable claim remains conservative recovery evidence.
    }
    throw new OperationalStateUnavailableError();
  }
  await state.fileSystem.unlink(lockFile(state));
  await syncDirectory(state);
  await releaseLock(state, claimed, claim);
  return Object.freeze({ recovered: true as const });
};
