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
const rootHookEvents = new Set(["SessionStart", "Stop", "SessionEnd"]);
const decodedRootHooks = new WeakSet<object>();

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
    if (
      Reflect.ownKeys(descriptors).length > 32 ||
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")
    )
      return invalid();
    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
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
    const parsed = parseCodexBoundedDuplicateAwareJson(bytes.slice(), 65_536);
    const record = ownDataRecord(parsed);
    const eventName = record.hook_event_name;
    if (typeof eventName !== "string" || !rootHookEvents.has(eventName))
      return invalid();
    const sessionId = safeToken(record.session_id);
    const turnId =
      record.turn_id === undefined ? null : safeToken(record.turn_id);
    if (eventName === "Stop" && turnId === null) return invalid();
    const model = record.model === undefined ? null : safeToken(record.model);
    const transcript = record.transcript_path;
    if (
      transcript !== undefined &&
      transcript !== null &&
      (typeof transcript !== "string" || transcript.length > 4_096)
    )
      return invalid();
    if (
      eventName === "SessionStart" &&
      !["startup", "resume", "clear", "compact"].includes(String(record.source))
    )
      return invalid();
    if (eventName === "SessionEnd" && record.reason !== "other")
      return invalid();
    const result = Object.freeze({
      eventName: eventName as CodexRootHookInput["eventName"],
      sessionId,
      turnId,
      model,
      transcriptAvailable: typeof transcript === "string",
    });
    decodedRootHooks.add(result);
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
  if (Object.keys(record).sort().join("\0") !== expected.join("\0"))
    return invalid();
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
  const usage = [promptTokens, completionTokens, reasoningTokens, totalTokens];
  if (
    usage.some((value) => value === null) &&
    usage.some((value) => value !== null)
  )
    return invalid();
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
  const model = [modelSystem, modelProvider, modelName, reasoningLevel];
  if (
    model.some((value) => value === null) &&
    model.some((value) => value !== null)
  )
    return invalid();
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

const unavailableFields = (
  fields: readonly string[],
): readonly FieldUnavailableCandidate[] =>
  Object.freeze(
    fields.map((field) =>
      createNativeUnavailableField({
        field,
        source: "native-artifact",
        state: "unavailable",
        reason: "not-emitted",
      }),
    ),
  );

const correlateRootHook = (
  value: CodexSanitizedNativeObservation,
  hook: CodexRootHookInput | undefined,
): "hook-payload" | "native-artifact" => {
  if (hook === undefined) return "native-artifact";
  if (
    !decodedRootHooks.has(hook) ||
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
  const modelAndTokenUnavailable = Object.freeze([
    ...(modelFields.length === 0 ? unavailableFields(modelFieldNames) : []),
    ...(tokenFields.length === 0 ? unavailableFields(tokenFieldNames) : []),
  ]);
  const errorUnavailable = Object.freeze([
    ...(value.errorType === null
      ? [
          createNativeUnavailableField({
            field: COMMON_NATIVE_SEMANTIC_FIELDS.errorType,
            source: "native-artifact",
            state: "unavailable",
            reason: "not-emitted",
          }),
        ]
      : []),
  ]);
  const tool = createToolMapping(value);
  const toolFields = tool.fields;
  const llmUnavailable = Object.freeze([
    ...modelAndTokenUnavailable,
    ...errorUnavailable,
  ]);
  const rootUnavailable = Object.freeze([]);
  const fields = [
    ...modelFields,
    ...tokenFields,
    ...errorFields,
    ...toolFields,
  ];
  return Object.freeze({
    modelFields,
    tokenFields,
    errorFields,
    toolFields,
    llmUnavailable,
    rootUnavailable,
    unavailable: Object.freeze([...llmUnavailable, ...rootUnavailable]),
    provenance: Object.freeze([
      provenance("span.name", "native-artifact"),
      ...fields.map((field) => field.provenance),
    ]),
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
    fields: Object.freeze([
      ...fields.modelFields,
      ...fields.tokenFields,
      ...fields.errorFields,
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
