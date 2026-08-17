export const protocolPackageId = "@agentscope/protocol" as const;

export {
  CODEC_PROFILE,
  CODEC_PROFILE_FINGERPRINT,
  CodecProfileError,
} from "./codecs/codec-profile.js";
export {
  encodeOtlpJson,
  encodeOtlpProtobuf,
  OtlpCodecError,
} from "./codecs/otlp-producer.js";
export {
  readExternalOtlpJson,
  readExternalOtlpProtobuf,
  type ExternalOtlpBatch,
  type ExternalOtlpReadResult,
  type ExternalOtlpTraceUnit,
} from "./codecs/otlp-reader.js";
export {
  readOtlpExportJsonResponse,
  readOtlpExportProtobufResponse,
  type OtlpExportResponseReadResult,
  type OtlpExportResponseSummary,
} from "./codecs/otlp-response.js";
export {
  readPersistedCanonicalEnvelope,
  SUPPORTED_PERSISTED_MANIFEST_IDS,
  type PersistedCanonicalEnvelope,
  type PersistedEnvelopeReadResult,
} from "./codecs/persisted-reader.js";

export {
  CANONICAL_COMPOUND_RULES,
  CANONICAL_RESOURCE_ATTRIBUTES,
  CanonicalTraceGraphSchema,
  parseCanonicalTraceGraph,
  safeParseCanonicalTraceGraph,
  type CanonicalTraceGraph,
} from "./schema/canonical-graph.js";
export {
  agentscopeExtensionRegistry,
  ExtensionRegistryError,
  getAgentscopeExtension,
  validateExtensionRegistry,
  type AgentscopeExtensionDescriptor,
  type ExtensionApplicability,
} from "./schema/extensions.js";
export {
  OTLP_GRAPH_LIMITS,
  OtlpAnyValueSchema,
  OtlpKeyValueSchema,
  OtlpResourceSpansSchema,
  OtlpScopeSpansSchema,
  OtlpSpanIdSchema,
  OtlpSpanSchema,
  OtlpTraceIdSchema,
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpResourceSpans,
  type OtlpSpan,
} from "./schema/otlp.js";
export {
  getAcceptedSemanticAttributeDescriptor,
  getSemanticAttributeDescriptor,
  getStructuralSemanticDescriptor,
  isOpenInferenceSemanticNamespace,
  isSemanticCandidateUpstreamConstraintValid,
  REDACTION_TRANSFORMS,
  semanticProfileDescriptors,
  SEMANTIC_PROFILE_FINGERPRINT,
  SEMANTIC_PROFILE_IDENTITY,
  SemanticProfileError,
  type SemanticAttributeDescriptor,
  type RedactionOutcome,
  type RedactionRoute,
  type RedactionTransform,
  type StructuralSemanticDescriptor,
} from "./schema/semantic-profile.js";
export {
  createSemanticOtlpValue,
  isSemanticCandidateValueValid,
  OPENINFERENCE_SPAN_KINDS,
  SemanticValueError,
  type OpenInferenceSpanKindValue,
} from "./schema/openinference.js";
export { standardsManifest } from "./standards/manifest.js";
export {
  FEEDBACK_PROFILE,
  FEEDBACK_PROFILE_FINGERPRINT,
  feedbackAttributesAreValid,
  isFeedbackAttributeKey,
} from "./schema/feedback-profile.js";
export {
  SUPPORTED_PROTOCOL_GENERATIONS,
  type CompatibilitySupport,
} from "./schema/compatibility-profile.js";
export {
  isRedactedCanonicalTrace,
  serializeRedactedCanonicalTrace,
  type CanonicalTraceEnvelope,
  type RedactedCanonicalTrace,
} from "./schema/redacted-envelope.js";
export {
  deriveIdentityBundle,
  IDENTITY_PROFILE,
  IDENTITY_PROFILE_FINGERPRINT,
  identitySpanFlagsAreValid,
  IdentityError,
  type BoundaryIdentity,
  type DeliveryIdentity,
  type IdentityBundle,
  type IdentityStability,
  type SessionIdentity,
  type W3CSpanId,
  type W3CTraceId,
} from "./schema/identity.js";
export {
  NATIVE_IDENTITY_KINDS,
  type NativeIdentityKind,
} from "./schema/identity-profile.js";
export {
  createTimingProvenanceValue,
  getTimingCompatibilityRule,
  isTimingProvenanceCompatible,
  NATIVE_STATES,
  PROVENANCE_SOURCES,
  TIMING_BASES,
  TIMING_LOCATIONS,
  TIMING_PROFILE_FINGERPRINT,
  timingProfile,
  TimingProfileError,
  type NativeState,
  type ProvenanceSource,
  type TimingBasis,
  type TimingCompatibilityRule,
  type TimingLocation,
} from "./schema/timing-profile.js";
export {
  buildSpanEvidenceLedger,
  getProvenanceTargets,
  isProvenanceGroupField,
  PROVENANCE_GROUP_PROFILE_IDENTITY,
  PROVENANCE_GROUP_SPECS,
  ProvenanceLedgerError,
  resolveFieldProvenance,
  type UnavailableProvenanceClaim,
} from "./schema/provenance-groups.js";
