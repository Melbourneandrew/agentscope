import {
  NATIVE_IDENTITY_KINDS,
  type NativeIdentityKind,
} from "@agentscope/protocol";

export const NATIVE_POSITION_KINDS = Object.freeze([
  "byte-offset",
  "event-index",
  "line",
  "sequence",
] as const);
export type NativePositionKind = (typeof NATIVE_POSITION_KINDS)[number];

export const NATIVE_BOUNDARY_KINDS = Object.freeze([
  "hook-invocation",
  "session",
  "transcript-range",
  "turn",
] as const);
export type NativeBoundaryKind = (typeof NATIVE_BOUNDARY_KINDS)[number];

export type NativeCheckpointRequest = Readonly<{
  nativeIdentityKind: NativeIdentityKind;
  nativeIdentity: string;
  sourceGeneration: number;
  positionKind: NativePositionKind;
  availableStartPosition: number;
}>;

export type NativeCheckpointResume = Readonly<{
  disposition: "retained" | "replay-required" | "source-loss" | "unavailable";
  startPosition: number;
}>;

export type NativeCheckpointResolver = (
  request: NativeCheckpointRequest,
) => NativeCheckpointResume;

declare const nativeCaptureStartBrand: unique symbol;
export interface NativeCaptureStart {
  readonly [nativeCaptureStartBrand]: true;
}

export type NativeCaptureBoundary = Readonly<{
  session: Readonly<{
    kind: "native-session";
    nativeIdentityKind: NativeIdentityKind;
    nativeIdentity: string;
  }>;
  boundaryKind: NativeBoundaryKind;
  boundaryId: string;
  generation: number;
  positionKind: NativePositionKind;
  startPosition: number;
  exclusiveEndPosition: number;
}>;

export type EphemeralCaptureBoundary = Readonly<{
  session: Readonly<{ kind: "boundary-scoped" | "attempt-scoped" }>;
  boundaryKind: NativeBoundaryKind;
  boundaryId: string;
  generation: number;
  positionKind: NativePositionKind;
  startPosition: number;
  exclusiveEndPosition: number;
}>;

export type NativeMappingSource = "hook-payload" | "native-artifact";
export type NativeUnavailableState =
  "unavailable" | "not-applicable" | "observed-empty";
export type NativeUnavailableReason =
  | "not-emitted"
  | "resolution-failed"
  | "unsupported"
  | "not-applicable"
  | "detached-head"
  | "empty-native-value";

export type NativeFieldProvenance = Readonly<{
  field: string;
  source: NativeMappingSource;
}>;
export type NativeUnavailableField = NativeFieldProvenance &
  Readonly<{
    state: NativeUnavailableState;
    reason: NativeUnavailableReason;
  }>;

export const COMMON_NATIVE_SEMANTIC_FIELDS = Object.freeze({
  modelSystem: "llm.system",
  modelProvider: "llm.provider",
  modelName: "llm.model_name",
  modelInvocationParameters: "llm.invocation_parameters",
  modelPromptTokenCount: "llm.token_count.prompt",
  modelCompletionTokenCount: "llm.token_count.completion",
  modelReasoningTokenCount: "llm.token_count.completion_details.reasoning",
  modelTotalTokenCount: "llm.token_count.total",
  toolName: "tool.name",
  toolId: "tool.id",
  errorType: "error.type",
  errorMessage: "exception.message",
  skillName: "tool.name",
  childAgentName: "agent.name",
  childAgentNodeId: "graph.node.id",
  childAgentParentNodeId: "graph.node.parent_id",
} as const);

const maximumNativeIdentityLength = 1_024;
const maximumIdentifierLength = 1_024;
const identityKinds: ReadonlySet<string> = new Set(NATIVE_IDENTITY_KINDS);
const positionKinds: ReadonlySet<string> = new Set(NATIVE_POSITION_KINDS);
const boundaryKinds: ReadonlySet<string> = new Set(NATIVE_BOUNDARY_KINDS);
const resumeDispositions = new Set([
  "retained",
  "replay-required",
  "source-loss",
  "unavailable",
]);
const mappingSources = new Set(["hook-payload", "native-artifact"]);
const unavailableStates = new Set([
  "unavailable",
  "not-applicable",
  "observed-empty",
]);
const unavailableReasons = new Set([
  "not-emitted",
  "resolution-failed",
  "unsupported",
  "not-applicable",
  "detached-head",
  "empty-native-value",
]);
const unavailablePairs = new Set([
  "not-applicable:detached-head",
  "not-applicable:not-applicable",
  "observed-empty:empty-native-value",
  "unavailable:not-emitted",
  "unavailable:resolution-failed",
  "unavailable:unsupported",
]);
const unavailablePairIsValid = (state: unknown, reason: unknown): boolean =>
  unavailablePairs.has(`${String(state)}:${String(reason)}`);
const forbiddenCoreFields = new Set([
  "agentscope.workspace.directory",
  "agentscope.git.worktree",
  "agentscope.git.repository_root",
  "vcs.ref.head.name",
  "vcs.ref.head.revision",
  "vcs.ref.type",
]);
const identifierPattern = /^[a-z][a-z\d]*(?:[._:/-][a-z\d]+)*$/u;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before callback-controlled mutation.
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;

type StoredStart = {
  request: NativeCheckpointRequest;
  resume: NativeCheckpointResume;
  completed: boolean;
};
const startState = new WeakMap<object, StoredStart>();

export class NativeMappingError extends Error {
  public constructor() {
    super("harness.native-mapping.invalid");
    this.name = "NativeMappingError";
  }
}

const invalid = (): never => {
  throw new NativeMappingError();
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return invalid();
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return invalid();
    result[key] = descriptor.value as unknown;
  }
  return Object.freeze(result);
};

const boundedIdentifier = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumIdentifierLength ||
    !identifierPattern.test(value)
  )
    return invalid();
  return value;
};

const nonnegativeSafeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalid();
  return value;
};

const parseCheckpointRequest = (value: unknown): NativeCheckpointRequest => {
  const record = exactRecord(value, [
    "nativeIdentityKind",
    "nativeIdentity",
    "sourceGeneration",
    "positionKind",
    "availableStartPosition",
  ]);
  if (
    !identityKinds.has(record.nativeIdentityKind as string) ||
    typeof record.nativeIdentity !== "string" ||
    record.nativeIdentity.length === 0 ||
    record.nativeIdentity.length > maximumNativeIdentityLength ||
    !positionKinds.has(record.positionKind as string)
  )
    return invalid();
  return Object.freeze({
    nativeIdentityKind: record.nativeIdentityKind as NativeIdentityKind,
    nativeIdentity: record.nativeIdentity,
    sourceGeneration: nonnegativeSafeInteger(record.sourceGeneration),
    positionKind: record.positionKind as NativePositionKind,
    availableStartPosition: nonnegativeSafeInteger(
      record.availableStartPosition,
    ),
  });
};

const parseResume = (
  value: unknown,
  availableStartPosition: number,
): NativeCheckpointResume => {
  const record = exactRecord(value, ["disposition", "startPosition"]);
  const startPosition = nonnegativeSafeInteger(record.startPosition);
  if (
    !resumeDispositions.has(record.disposition as string) ||
    startPosition < availableStartPosition ||
    ((record.disposition === "replay-required" ||
      record.disposition === "source-loss" ||
      record.disposition === "unavailable") &&
      startPosition !== availableStartPosition)
  )
    return invalid();
  return Object.freeze({
    disposition: record.disposition as NativeCheckpointResume["disposition"],
    startPosition,
  });
};

export const resolveNativeCaptureStart = (
  input: NativeCheckpointRequest,
  resolver: NativeCheckpointResolver,
): NativeCaptureStart => {
  const request = parseCheckpointRequest(input);
  let rawResume: unknown;
  try {
    rawResume = resolver(request);
  } catch {
    return invalid();
  }
  try {
    void reflectApply(promiseThen, rawResume, [
      () => undefined,
      () => undefined,
    ]);
  } catch {
    // Only real Promises need late-rejection observation; ordinary DTOs fail this intrinsic call.
  }
  const resume = parseResume(rawResume, request.availableStartPosition);
  const authority = Object.freeze({}) as NativeCaptureStart;
  startState.set(authority, { request, resume, completed: false });
  return authority;
};

export const completeNativeCaptureBoundary = (
  authority: NativeCaptureStart,
  input: Readonly<{
    boundaryKind: NativeBoundaryKind;
    boundaryId: string;
    exclusiveEndPosition: number;
  }>,
): NativeCaptureBoundary => {
  const state = startState.get(authority);
  if (!state || state.completed) return invalid();
  const record = exactRecord(input, [
    "boundaryKind",
    "boundaryId",
    "exclusiveEndPosition",
  ]);
  if (!boundaryKinds.has(record.boundaryKind as string)) return invalid();
  const exclusiveEndPosition = nonnegativeSafeInteger(
    record.exclusiveEndPosition,
  );
  if (exclusiveEndPosition <= state.resume.startPosition) return invalid();
  const boundaryId = boundedIdentifier(record.boundaryId);
  state.completed = true;
  return Object.freeze({
    session: Object.freeze({
      kind: "native-session" as const,
      nativeIdentityKind: state.request.nativeIdentityKind,
      nativeIdentity: state.request.nativeIdentity,
    }),
    boundaryKind: record.boundaryKind as NativeBoundaryKind,
    boundaryId,
    generation: state.request.sourceGeneration,
    positionKind: state.request.positionKind,
    startPosition: state.resume.startPosition,
    exclusiveEndPosition,
  });
};

export const createEphemeralCaptureBoundary = (
  input: Readonly<{
    scope: "boundary-scoped" | "attempt-scoped";
    boundaryKind: NativeBoundaryKind;
    boundaryId: string;
    generation: number;
    positionKind: NativePositionKind;
    startPosition: number;
    exclusiveEndPosition: number;
  }>,
): EphemeralCaptureBoundary => {
  const record = exactRecord(input, [
    "scope",
    "boundaryKind",
    "boundaryId",
    "generation",
    "positionKind",
    "startPosition",
    "exclusiveEndPosition",
  ]);
  if (
    (record.scope !== "boundary-scoped" && record.scope !== "attempt-scoped") ||
    !boundaryKinds.has(record.boundaryKind as string) ||
    !positionKinds.has(record.positionKind as string)
  )
    return invalid();
  const startPosition = nonnegativeSafeInteger(record.startPosition);
  const exclusiveEndPosition = nonnegativeSafeInteger(
    record.exclusiveEndPosition,
  );
  if (exclusiveEndPosition <= startPosition) return invalid();
  return Object.freeze({
    session: Object.freeze({ kind: record.scope }),
    boundaryKind: record.boundaryKind as NativeBoundaryKind,
    boundaryId: boundedIdentifier(record.boundaryId),
    generation: nonnegativeSafeInteger(record.generation),
    positionKind: record.positionKind as NativePositionKind,
    startPosition,
    exclusiveEndPosition,
  });
};

const validateHarnessField = (field: unknown): string => {
  const value = boundedIdentifier(field);
  if (forbiddenCoreFields.has(value)) return invalid();
  return value;
};

export const createNativeFieldProvenance = (
  field: string,
  source: NativeMappingSource,
): NativeFieldProvenance => {
  if (!mappingSources.has(source)) return invalid();
  const validatedField = validateHarnessField(field);
  return Object.freeze({ field: validatedField, source });
};

export const createNativeUnavailableField = (
  input: NativeUnavailableField,
): NativeUnavailableField => {
  const record = exactRecord(input, ["field", "source", "state", "reason"]);
  if (
    !mappingSources.has(record.source as string) ||
    !unavailableStates.has(record.state as string) ||
    !unavailableReasons.has(record.reason as string) ||
    !unavailablePairIsValid(record.state, record.reason)
  )
    return invalid();
  return Object.freeze({
    field: validateHarnessField(record.field),
    source: record.source as NativeMappingSource,
    state: record.state as NativeUnavailableState,
    reason: record.reason as NativeUnavailableReason,
  });
};
