import {
  COMMON_NATIVE_SEMANTIC_FIELDS,
  completeNativeCaptureBoundary,
  createNativeFieldProvenance,
  createNativeUnavailableField,
  resolveNativeCaptureStart,
  type NativeCaptureBoundary,
  type NativeCheckpointResolver,
  type NativeFieldProvenance,
  type NativeUnavailableField,
} from "@agentscope/harnesses-core";

import { parseCodexBoundedDuplicateAwareJson } from "./strict-json.js";

type FieldProvenanceCandidate = NativeFieldProvenance;
type FieldUnavailableCandidate = NativeUnavailableField;
type SemanticFieldCandidate = Readonly<{
  field: string;
  value: string | number;
  provenance: FieldProvenanceCandidate;
}>;
type OperationCandidate = Readonly<{
  logicalKey: string;
  parentLogicalKey?: string;
  locator: Readonly<{ kind: "native-operation"; nativeId: string }>;
  kind: "AGENT" | "LLM" | "TOOL";
  name: string;
  nameProvenance: FieldProvenanceCandidate;
  fields: readonly SemanticFieldCandidate[];
  unavailable: readonly FieldUnavailableCandidate[];
  events: readonly never[];
  links: readonly never[];
}>;

export type CodexCapturedTraceCandidate = Readonly<{
  captureBoundary: NativeCaptureBoundary;
  rootContext: Readonly<{
    fields: readonly SemanticFieldCandidate[];
    unavailable: readonly FieldUnavailableCandidate[];
  }>;
  operations: readonly OperationCandidate[];
}>;

const safeTokenPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const decodedRootHooks = new WeakSet<object>();
const decodedRootHookAdd = decodedRootHooks.add.bind(decodedRootHooks);
const decodedRootHookHas = decodedRootHooks.has.bind(decodedRootHooks);

const setOwnArrayValue = <T>(values: T[], index: number, value: T): void => {
  Object.defineProperty(values, String(index), {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

const appendOwnArrayValue = <T>(values: T[], value: T): void => {
  setOwnArrayValue(values, values.length, value);
};

export const CODEX_0_149_1_ROOT_HOOK_SCHEMA_AUTHORITY = Object.freeze({
  representativeVersion: "0.149.1",
  sourceCommit: "ff29a44391deccde0aba0f8390337d7f3c319ea4",
  schemas: Object.freeze({
    SessionStart: Object.freeze({
      sourcePath:
        "codex-rs/hooks/schema/generated/session-start.command.input.schema.json",
      sourceSha256:
        "690c0eef7c9f3ddcd41e24207b81b362101a300b4abec076b990a1cd79a66e20",
      requiredKeys: Object.freeze([
        "cwd",
        "hook_event_name",
        "model",
        "permission_mode",
        "session_id",
        "source",
        "transcript_path",
      ]),
    }),
    Stop: Object.freeze({
      sourcePath:
        "codex-rs/hooks/schema/generated/stop.command.input.schema.json",
      sourceSha256:
        "7db4793c404b5c46b230c27b9507eb1a558fd958689d8715221c5dd81351a06a",
      requiredKeys: Object.freeze([
        "cwd",
        "hook_event_name",
        "last_assistant_message",
        "model",
        "permission_mode",
        "session_id",
        "stop_hook_active",
        "transcript_path",
        "turn_id",
      ]),
    }),
    SessionEnd: Object.freeze({
      sourcePath:
        "codex-rs/hooks/schema/generated/session-end.command.input.schema.json",
      sourceSha256:
        "23b1b69f92fa8ac29f8319478984b5aa5aaf09e5ca355ce90aa010452937e41c",
      requiredKeys: Object.freeze([
        "cwd",
        "hook_event_name",
        "reason",
        "session_id",
        "transcript_path",
      ]),
    }),
  }),
});

const hasExactOwnKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return false;
    let matched = false;
    for (let candidate = 0; candidate < expected.length; candidate += 1)
      if (key === expected[candidate]) matched = true;
    if (!matched) return false;
  }
  return true;
};

export class CodexMappingError extends Error {
  public readonly code = "codex.mapping.invalid";

  public constructor() {
    super("codex.mapping.invalid");
    this.name = "CodexMappingError";
  }
}

const invalid = (): never => {
  throw new CodexMappingError();
};

export type CodexRootHookInput = Readonly<{
  eventName: "SessionStart" | "Stop" | "SessionEnd";
  sessionId: string;
  turnId: string | null;
  model: string | null;
  transcriptAvailable: boolean;
}>;

export type CodexSanitizedNativeObservation = Readonly<{
  nativeIdentity: string;
  sourceGeneration: number;
  availableStartPosition: number;
  boundaryId: string;
  exclusiveEndPosition: number;
  modelSystem: string | null;
  modelProvider: string | null;
  modelName: string | null;
  reasoningLevel: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  toolName: string | null;
  toolId: string | null;
  errorType: string | null;
}>;

const ownDataRecord = (value: unknown): Record<string, unknown> => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 32) return invalid();
    const output = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") return invalid();
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || descriptor.enumerable !== true)
        return invalid();
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value as unknown,
        writable: true,
      });
    }
    return output;
  } catch (error) {
    if (error instanceof CodexMappingError) throw error;
    return invalid();
  }
};

const safeToken = (value: unknown): string =>
  typeof value === "string" && safeTokenPattern.test(value) ? value : invalid();

const nonnegativeInteger = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalid();

const validNullableString = (value: unknown): boolean =>
  value === null || typeof value === "string";

const validPermissionMode = (value: unknown): boolean =>
  value === "default" ||
  value === "acceptEdits" ||
  value === "plan" ||
  value === "dontAsk" ||
  value === "bypassPermissions";

const validRootHookSchema = (
  eventName: CodexRootHookInput["eventName"],
  record: Record<string, unknown>,
): boolean => {
  const schema = CODEX_0_149_1_ROOT_HOOK_SCHEMA_AUTHORITY.schemas[eventName];
  if (
    !hasExactOwnKeys(record, schema.requiredKeys) ||
    typeof record.cwd !== "string" ||
    typeof record.session_id !== "string" ||
    !validNullableString(record.transcript_path) ||
    (typeof record.transcript_path === "string" &&
      record.transcript_path.length > 4_096)
  )
    return false;
  if (eventName === "SessionEnd") return record.reason === "other";
  if (
    typeof record.model !== "string" ||
    !validPermissionMode(record.permission_mode)
  )
    return false;
  if (eventName === "SessionStart")
    return (
      record.source === "startup" ||
      record.source === "resume" ||
      record.source === "clear" ||
      record.source === "compact"
    );
  return (
    typeof record.turn_id === "string" &&
    validNullableString(record.last_assistant_message) &&
    typeof record.stop_hook_active === "boolean"
  );
};

export const decodeCodexRootHookInput = (
  bytes: Uint8Array,
): CodexRootHookInput => {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
      bytes.byteLength === 0 ||
      bytes.byteLength > 65_536
    )
      return invalid();
    const copy = new Uint8Array(bytes.byteLength);
    for (let index = 0; index < bytes.byteLength; index += 1)
      copy[index] = bytes[index]!;
    const parsed = parseCodexBoundedDuplicateAwareJson(copy, 65_536);
    const record = ownDataRecord(parsed);
    const eventName = record.hook_event_name;
    if (
      eventName !== "SessionStart" &&
      eventName !== "Stop" &&
      eventName !== "SessionEnd"
    )
      return invalid();
    if (!validRootHookSchema(eventName, record)) return invalid();
    const sessionId = safeToken(record.session_id);
    const turnId =
      record.turn_id === undefined ? null : safeToken(record.turn_id);
    if (eventName === "Stop" && turnId === null) return invalid();
    const model = eventName === "SessionEnd" ? null : safeToken(record.model);
    const transcript = record.transcript_path;
    const result = Object.freeze({
      eventName,
      sessionId,
      turnId,
      model,
      transcriptAvailable: typeof transcript === "string",
    });
    decodedRootHookAdd(result);
    return result;
  } catch (error) {
    if (error instanceof CodexMappingError) throw error;
    return invalid();
  }
};

const parseObservation = (
  input: CodexSanitizedNativeObservation,
): CodexSanitizedNativeObservation => {
  const record = ownDataRecord(input);
  const expected = [
    "availableStartPosition",
    "boundaryId",
    "completionTokens",
    "errorType",
    "exclusiveEndPosition",
    "modelName",
    "modelProvider",
    "modelSystem",
    "nativeIdentity",
    "promptTokens",
    "reasoningLevel",
    "reasoningTokens",
    "sourceGeneration",
    "toolId",
    "toolName",
    "totalTokens",
  ];
  if (!hasExactOwnKeys(record, expected)) return invalid();
  const optionalToken = (value: unknown): number | null =>
    value === null ? null : nonnegativeInteger(value);
  const promptTokens = optionalToken(record.promptTokens);
  const completionTokens = optionalToken(record.completionTokens);
  const reasoningTokens = optionalToken(record.reasoningTokens);
  const totalTokens = optionalToken(record.totalTokens);
  const availableStartPosition = nonnegativeInteger(
    record.availableStartPosition,
  );
  const exclusiveEndPosition = nonnegativeInteger(record.exclusiveEndPosition);
  const anyUsageMissing =
    promptTokens === null ||
    completionTokens === null ||
    reasoningTokens === null ||
    totalTokens === null;
  const anyUsagePresent =
    promptTokens !== null ||
    completionTokens !== null ||
    reasoningTokens !== null ||
    totalTokens !== null;
  if (anyUsageMissing && anyUsagePresent) return invalid();
  if (
    promptTokens !== null &&
    completionTokens !== null &&
    reasoningTokens !== null &&
    totalTokens !== null &&
    (reasoningTokens > completionTokens ||
      totalTokens !== promptTokens + completionTokens)
  )
    return invalid();
  if (exclusiveEndPosition <= availableStartPosition) return invalid();
  const toolName = record.toolName === null ? null : safeToken(record.toolName);
  const toolId = record.toolId === null ? null : safeToken(record.toolId);
  if ((toolName === null) !== (toolId === null)) return invalid();
  const optionalTokenString = (value: unknown): string | null =>
    value === null ? null : safeToken(value);
  const modelSystem = optionalTokenString(record.modelSystem);
  const modelProvider = optionalTokenString(record.modelProvider);
  const modelName = optionalTokenString(record.modelName);
  const reasoningLevel = optionalTokenString(record.reasoningLevel);
  const anyModelMissing =
    modelSystem === null ||
    modelProvider === null ||
    modelName === null ||
    reasoningLevel === null;
  const anyModelPresent =
    modelSystem !== null ||
    modelProvider !== null ||
    modelName !== null ||
    reasoningLevel !== null;
  if (anyModelMissing && anyModelPresent) return invalid();
  return Object.freeze({
    nativeIdentity: safeToken(record.nativeIdentity),
    sourceGeneration: nonnegativeInteger(record.sourceGeneration),
    availableStartPosition,
    boundaryId: safeToken(record.boundaryId),
    exclusiveEndPosition,
    modelSystem,
    modelProvider,
    modelName,
    reasoningLevel,
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    toolName,
    toolId,
    errorType: record.errorType === null ? null : safeToken(record.errorType),
  });
};

const provenance = (
  field: string,
  source: "hook-payload" | "native-artifact",
): FieldProvenanceCandidate => createNativeFieldProvenance(field, source);

const semanticField = (
  field: string,
  value: string | number,
  source: "hook-payload" | "native-artifact",
): SemanticFieldCandidate =>
  Object.freeze({ field, value, provenance: provenance(field, source) });

export type CodexMappedNativeObservation = Readonly<{
  candidate: CodexCapturedTraceCandidate;
  contract: Readonly<{
    boundary: NativeCaptureBoundary;
    provenance: readonly NativeFieldProvenance[];
    unavailable: readonly NativeUnavailableField[];
  }>;
}>;

type MappedFields = Readonly<{
  modelFields: readonly SemanticFieldCandidate[];
  tokenFields: readonly SemanticFieldCandidate[];
  errorFields: readonly SemanticFieldCandidate[];
  toolFields: readonly SemanticFieldCandidate[];
  llmUnavailable: readonly FieldUnavailableCandidate[];
  rootUnavailable: readonly FieldUnavailableCandidate[];
  unavailable: readonly FieldUnavailableCandidate[];
  provenance: readonly FieldProvenanceCandidate[];
}>;

const concatenateFrozen = <T>(
  groups: readonly (readonly T[])[],
): readonly T[] => {
  const output: T[] = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]!;
    for (let itemIndex = 0; itemIndex < group.length; itemIndex += 1)
      appendOwnArrayValue(output, group[itemIndex]!);
  }
  return Object.freeze(output);
};

const unavailableFields = (
  fields: readonly string[],
): readonly FieldUnavailableCandidate[] => {
  const unavailable: FieldUnavailableCandidate[] = [];
  for (let index = 0; index < fields.length; index += 1)
    setOwnArrayValue(
      unavailable,
      index,
      createNativeUnavailableField({
        field: fields[index]!,
        source: "native-artifact",
        state: "unavailable",
        reason: "not-emitted",
      }),
    );
  return Object.freeze(unavailable);
};

const correlateRootHook = (
  value: CodexSanitizedNativeObservation,
  hook: CodexRootHookInput | undefined,
): "hook-payload" | "native-artifact" => {
  if (hook === undefined) return "native-artifact";
  if (
    !decodedRootHookHas(hook) ||
    hook.eventName !== "Stop" ||
    hook.sessionId !== value.nativeIdentity ||
    hook.turnId !== value.boundaryId
  )
    return invalid();
  if (hook.model === null || value.modelName === null) return "native-artifact";
  if (hook.model !== value.modelName) return invalid();
  return "hook-payload";
};

const createToolMapping = (
  value: CodexSanitizedNativeObservation,
): Readonly<{
  fields: readonly SemanticFieldCandidate[];
}> => {
  if (value.toolName !== null && value.toolId !== null)
    return Object.freeze({
      fields: Object.freeze([
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.toolName,
          value.toolName,
          "native-artifact",
        ),
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.toolId,
          value.toolId,
          "native-artifact",
        ),
      ]),
    });
  return Object.freeze({
    fields: Object.freeze([]),
  });
};

const createModelFields = (
  value: CodexSanitizedNativeObservation,
  modelNameSource: "hook-payload" | "native-artifact",
): readonly SemanticFieldCandidate[] =>
  value.modelSystem === null ||
  value.modelProvider === null ||
  value.modelName === null ||
  value.reasoningLevel === null
    ? Object.freeze([])
    : Object.freeze([
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.modelSystem,
          value.modelSystem,
          "native-artifact",
        ),
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.modelProvider,
          value.modelProvider,
          "native-artifact",
        ),
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.modelName,
          value.modelName,
          modelNameSource,
        ),
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.modelInvocationParameters,
          `{"reasoning_effort":${JSON.stringify(value.reasoningLevel)}}`,
          "native-artifact",
        ),
      ]);

const createTokenFields = (
  value: CodexSanitizedNativeObservation,
): readonly SemanticFieldCandidate[] =>
  value.promptTokens === null ||
  value.completionTokens === null ||
  value.reasoningTokens === null ||
  value.totalTokens === null
    ? Object.freeze([])
    : Object.freeze([
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.modelPromptTokenCount,
          value.promptTokens,
          "native-artifact",
        ),
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.modelCompletionTokenCount,
          value.completionTokens,
          "native-artifact",
        ),
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.modelReasoningTokenCount,
          value.reasoningTokens,
          "native-artifact",
        ),
        semanticField(
          COMMON_NATIVE_SEMANTIC_FIELDS.modelTotalTokenCount,
          value.totalTokens,
          "native-artifact",
        ),
      ]);

const createMappedFields = (
  value: CodexSanitizedNativeObservation,
  modelNameSource: "hook-payload" | "native-artifact",
): MappedFields => {
  const modelFieldNames = [
    COMMON_NATIVE_SEMANTIC_FIELDS.modelSystem,
    COMMON_NATIVE_SEMANTIC_FIELDS.modelProvider,
    COMMON_NATIVE_SEMANTIC_FIELDS.modelName,
    COMMON_NATIVE_SEMANTIC_FIELDS.modelInvocationParameters,
  ];
  const modelFields = createModelFields(value, modelNameSource);
  const tokenFieldNames = [
    COMMON_NATIVE_SEMANTIC_FIELDS.modelPromptTokenCount,
    COMMON_NATIVE_SEMANTIC_FIELDS.modelCompletionTokenCount,
    COMMON_NATIVE_SEMANTIC_FIELDS.modelReasoningTokenCount,
    COMMON_NATIVE_SEMANTIC_FIELDS.modelTotalTokenCount,
  ];
  const tokenFields = createTokenFields(value);
  const errorFields =
    value.errorType === null
      ? Object.freeze([])
      : Object.freeze([
          semanticField(
            COMMON_NATIVE_SEMANTIC_FIELDS.errorType,
            value.errorType,
            "native-artifact",
          ),
        ]);
  const modelAndTokenUnavailable = concatenateFrozen([
    modelFields.length === 0 ? unavailableFields(modelFieldNames) : [],
    tokenFields.length === 0 ? unavailableFields(tokenFieldNames) : [],
  ]);
  const errorUnavailable =
    value.errorType === null
      ? Object.freeze([
          createNativeUnavailableField({
            field: COMMON_NATIVE_SEMANTIC_FIELDS.errorType,
            source: "native-artifact",
            state: "unavailable",
            reason: "not-emitted",
          }),
        ])
      : Object.freeze([]);
  const tool = createToolMapping(value);
  const toolFields = tool.fields;
  const llmUnavailable = concatenateFrozen([
    modelAndTokenUnavailable,
    errorUnavailable,
  ]);
  const rootUnavailable = Object.freeze([]);
  const fields = concatenateFrozen([
    modelFields,
    tokenFields,
    errorFields,
    toolFields,
  ]);
  const provenanceFields: FieldProvenanceCandidate[] = [
    provenance("span.name", "native-artifact"),
  ];
  for (let index = 0; index < fields.length; index += 1)
    appendOwnArrayValue(provenanceFields, fields[index]!.provenance);
  return Object.freeze({
    modelFields,
    tokenFields,
    errorFields,
    toolFields,
    llmUnavailable,
    rootUnavailable,
    unavailable: concatenateFrozen([llmUnavailable, rootUnavailable]),
    provenance: Object.freeze(provenanceFields),
  });
};

const createOperations = (
  value: CodexSanitizedNativeObservation,
  fields: MappedFields,
): readonly OperationCandidate[] => {
  const root: OperationCandidate = Object.freeze({
    logicalKey: "codex-turn",
    locator: Object.freeze({
      kind: "native-operation" as const,
      nativeId: value.boundaryId,
    }),
    kind: "AGENT" as const,
    name: "codex.turn",
    nameProvenance: provenance("span.name", "native-artifact"),
    fields: Object.freeze([]),
    unavailable: fields.rootUnavailable,
    events: Object.freeze([]),
    links: Object.freeze([]),
  });
  const llm: OperationCandidate = Object.freeze({
    logicalKey: "codex-llm",
    parentLogicalKey: "codex-turn",
    locator: Object.freeze({
      kind: "native-operation" as const,
      nativeId: `${value.boundaryId}:llm`,
    }),
    kind: "LLM" as const,
    name: "codex.response",
    nameProvenance: provenance("span.name", "native-artifact"),
    fields: concatenateFrozen([
      fields.modelFields,
      fields.tokenFields,
      fields.errorFields,
    ]),
    unavailable: fields.llmUnavailable,
    events: Object.freeze([]),
    links: Object.freeze([]),
  });
  if (value.toolName === null || value.toolId === null)
    return Object.freeze([root, llm]);
  const tool: OperationCandidate = Object.freeze({
    logicalKey: "codex-tool",
    parentLogicalKey: "codex-turn",
    locator: Object.freeze({
      kind: "native-operation" as const,
      nativeId: value.toolId,
    }),
    kind: "TOOL" as const,
    name: value.toolName,
    nameProvenance: provenance("span.name", "native-artifact"),
    fields: fields.toolFields,
    unavailable: Object.freeze([]),
    events: Object.freeze([]),
    links: Object.freeze([]),
  });
  return Object.freeze([root, llm, tool]);
};

export const mapCodexSanitizedNativeObservation = (
  input: CodexSanitizedNativeObservation,
  resolver: NativeCheckpointResolver,
  hook?: CodexRootHookInput,
): CodexMappedNativeObservation => {
  const value = parseObservation(input);
  const modelNameSource = correlateRootHook(value, hook);
  const start = resolveNativeCaptureStart(
    {
      nativeIdentityKind: "session",
      nativeIdentity: value.nativeIdentity,
      sourceGeneration: value.sourceGeneration,
      positionKind: "sequence",
      availableStartPosition: value.availableStartPosition,
    },
    resolver,
  );
  const boundary = completeNativeCaptureBoundary(start, {
    boundaryKind: "turn",
    boundaryId: value.boundaryId,
    exclusiveEndPosition: value.exclusiveEndPosition,
  });
  const fields = createMappedFields(value, modelNameSource);
  return Object.freeze({
    candidate: Object.freeze({
      captureBoundary: boundary,
      rootContext: Object.freeze({
        fields: Object.freeze([]),
        unavailable: Object.freeze([]),
      }),
      operations: createOperations(value, fields),
    }),
    contract: Object.freeze({
      boundary,
      provenance: fields.provenance,
      unavailable: fields.unavailable,
    }),
  });
};
