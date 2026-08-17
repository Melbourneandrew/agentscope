import { fingerprintCanonicalMaterial } from "../schema/extensions.js";
import { deepFreeze } from "../schema/immutable.js";
import codecProfile from "../standards/codec-profile.json" with { type: "json" };
import { standardsManifest } from "../standards/manifest.js";

export class CodecProfileError extends Error {
  public constructor() {
    super("protocol.codec.profile.invalid");
    this.name = "CodecProfileError";
  }
}

const invalid = (): never => {
  throw new CodecProfileError();
};

const exactKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value).sort();
  const target = [...expected].sort();
  return (
    keys.length === target.length && keys.every((key, i) => key === target[i])
  );
};

const exactObject = (
  value: unknown,
  keys: readonly string[],
): value is object =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  exactKeys(value, keys);

const supplyChainIsValid = (value: typeof codecProfile) =>
  exactObject(value.otlp, [
    "release",
    "commit",
    "requestType",
    "responseType",
  ]) &&
  exactObject(value.generator, [
    "cli",
    "plugin",
    "runtime",
    "options",
    "normalizedSource",
    "generatedOrder",
  ]) &&
  exactObject(value.generator.cli, ["package", "version", "integrity"]) &&
  exactObject(value.generator.plugin, ["package", "version", "integrity"]) &&
  exactObject(value.generator.runtime, ["package", "version", "integrity"]) &&
  value.otlp.release === standardsManifest.artifacts.otlpProtocol.release &&
  value.otlp.commit === standardsManifest.artifacts.otlpProtocol.commit &&
  value.otlp.requestType ===
    "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest" &&
  value.otlp.responseType ===
    "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse" &&
  value.generator.cli.package === "@bufbuild/buf" &&
  value.generator.cli.version === "1.72.0" &&
  value.generator.cli.integrity ===
    "sha512-BwBKTX/WXkhAhqWJGrEKnqU03/4tK1O0OozSlwUMBCOEo8pLL3xu3M24RT3+umExEeM0wjlANO6axqGWMqtt4Q==" &&
  value.generator.plugin.package === "@bufbuild/protoc-gen-es" &&
  value.generator.plugin.version === "2.14.0" &&
  value.generator.plugin.integrity ===
    "sha512-/Rrui0BJWSRONiKGYzqWq9ivGN3+cYkmc47QWITufr7K6yDb8HfssuJUSQZeptyg/rHbHrfDzCUjzoJ2pwuafg==" &&
  value.generator.runtime.package === "@bufbuild/protobuf" &&
  value.generator.runtime.version === "2.14.0" &&
  value.generator.runtime.integrity ===
    "sha512-C3UGsiCwSprE2NKIIFA3hCDlpXTMCAXRZuEVp88L1GY36Y41+rYL5fryE+nOFhp4p4JPQvdV8PQ4DWgHgeTE+w==" &&
  value.generator.options.join(",") === "target=ts,import_extension=js" &&
  value.generator.normalizedSource === "raw-upstream-bytes" &&
  value.generator.generatedOrder === "lexicographic-path" &&
  value.inputs.length === 4 &&
  value.outputs.length === 4 &&
  new Set(value.inputs.map(({ path }) => path)).size === 4 &&
  new Set(value.outputs.map(({ path }) => path)).size === 4 &&
  value.inputs.every((entry) => exactObject(entry, ["path", "sha256"])) &&
  value.outputs.every((entry) => exactObject(entry, ["path", "sha256"])) &&
  [...value.inputs, ...value.outputs].every(
    ({ path, sha256 }) =>
      /^[a-z\d_./-]+$/u.test(path) && /^[\da-f]{64}$/u.test(sha256),
  );

const producerBehaviorIsValid = (value: typeof codecProfile.producer) =>
  exactObject(value, ["input", "outputPurpose", "json", "protobuf"]) &&
  exactObject(value.json, [
    "fieldNames",
    "identities",
    "bytes",
    "int64",
    "enums",
    "unknownFields",
  ]) &&
  exactObject(value.protobuf, [
    "unknownFields",
    "deterministicForPinnedGenerator",
  ]) &&
  value.input === "runtime-branded-redacted-canonical-trace" &&
  value.outputPurpose === "otlp-export-request-graph-only" &&
  value.json.fieldNames === "lowerCamel-only" &&
  value.json.identities === "lowercase-hex" &&
  value.json.bytes === "standard-base64-padded" &&
  value.json.int64 === "canonical-decimal-string" &&
  value.json.enums === "integer" &&
  value.json.unknownFields === "none" &&
  value.protobuf.unknownFields === "none" &&
  value.protobuf.deterministicForPinnedGenerator === true;

const externalBehaviorIsValid = (value: typeof codecProfile.externalReceiver) =>
  exactObject(value, [
    "trust",
    "unitDisposition",
    "unknownJsonFields",
    "unknownProtobufFields",
    "unknownAgentscopeAttributes",
    "knownUnsupportedValues",
    "json",
    "protobuf",
    "budgets",
  ]) &&
  exactObject(value.json, [
    "fieldNames",
    "rejectSnakeCase",
    "duplicateKeys",
    "nullValues",
    "identities",
    "bytes",
    "int32",
    "int64",
    "floatingPoint",
    "enums",
    "invalidUtf8",
    "loneSurrogates",
  ]) &&
  exactObject(value.protobuf, [
    "inputOwnership",
    "unknownGroups",
    "singularDuplicates",
  ]) &&
  value.trust === "untrusted-unbranded-batch" &&
  value.unitDisposition === "trace-atomic-reject-or-canonical" &&
  value.unknownJsonFields === "ignore" &&
  value.unknownProtobufFields === "drop" &&
  value.unknownAgentscopeAttributes === "reject-trace" &&
  value.knownUnsupportedValues === "reject-trace" &&
  value.json.fieldNames === "lowerCamel-only" &&
  value.json.rejectSnakeCase === true &&
  value.json.duplicateKeys === "last-wins-same-field-reject-oneof-ambiguity" &&
  value.json.nullValues === "unset-known-field" &&
  value.json.identities === "case-insensitive-hex-normalize-lowercase" &&
  value.json.bytes === "standard-or-urlsafe-base64-padded-or-unpadded" &&
  value.json.int32 === "number-or-string-integer" &&
  value.json.int64 === "quoted-exact-bare-binary64-integer" &&
  value.json.floatingPoint === "number-or-string-including-nan-and-infinity" &&
  value.json.enums === "integer-only" &&
  value.json.invalidUtf8 === "reject" &&
  value.json.loneSurrogates === "reject" &&
  value.protobuf.inputOwnership ===
    "owned-snapshot-before-preflight-and-decode" &&
  value.protobuf.unknownGroups === "skip-matching-bounded" &&
  value.protobuf.singularDuplicates === "last-wins-message-merge" &&
  exactObject(value.budgets, [
    "maximumJsonBytes",
    "maximumProtobufBytes",
    "maximumDepth",
    "maximumNodes",
    "maximumObjectKeys",
    "maximumArrayItems",
    "maximumStringBytes",
    "maximumWireFields",
    "maximumLengthDelimitedBytes",
    "maximumResourceSpans",
    "maximumScopeSpans",
    "maximumSpans",
    "maximumAttributes",
    "maximumEvents",
    "maximumLinks",
  ]) &&
  Object.values(value.budgets).every(
    (limit) => Number.isSafeInteger(limit) && limit > 0,
  );

const persistedBehaviorIsValid = (
  value: typeof codecProfile.persistedEnvelopeReader,
) =>
  exactObject(value, [
    "trust",
    "maximumBytes",
    "maximumDepth",
    "maximumNodes",
    "maximumObjectKeys",
    "maximumArrayItems",
    "maximumStringBytes",
    "unknownFields",
    "versionDispatch",
    "supportedManifests",
    "unsupportedResult",
    "malformedResult",
  ]) &&
  value.trust === "untrusted-unbranded-envelope" &&
  value.unknownFields === "reject" &&
  value.versionDispatch === "exact-envelope-version-and-manifest-id" &&
  value.unsupportedResult === "protocol.reader.unsupported" &&
  value.malformedResult === "protocol.reader.invalid" &&
  value.supportedManifests.length === 2 &&
  value.supportedManifests.every((entry) =>
    exactObject(entry, ["selector", "envelopeVersion", "migration"]),
  ) &&
  value.supportedManifests[0]?.selector === "manifest" &&
  value.supportedManifests[0]?.envelopeVersion === 1 &&
  value.supportedManifests[0]?.migration === "v1-to-v2-strict-feedback-empty" &&
  value.supportedManifests[1]?.selector === "current" &&
  value.supportedManifests[1]?.envelopeVersion === 1 &&
  value.supportedManifests[1]?.migration === "identity-strict-v2" &&
  [
    value.maximumBytes,
    value.maximumDepth,
    value.maximumNodes,
    value.maximumObjectKeys,
    value.maximumArrayItems,
    value.maximumStringBytes,
  ].every((limit) => Number.isSafeInteger(limit) && limit > 0);

const behaviorIsValid = (value: typeof codecProfile) =>
  value.profileVersion === 1 &&
  exactObject(value, [
    "profileVersion",
    "otlp",
    "generator",
    "inputs",
    "outputs",
    "producer",
    "externalReceiver",
    "persistedEnvelopeReader",
    "response",
  ]) &&
  producerBehaviorIsValid(value.producer) &&
  externalBehaviorIsValid(value.externalReceiver) &&
  persistedBehaviorIsValid(value.persistedEnvelopeReader) &&
  exactKeys(value.response, ["errorMessage", "partialSuccess"]) &&
  value.response.errorMessage === "bounded-and-never-diagnostic" &&
  value.response.partialSuccess === "structural-only-no-receipt-classification";

/** Internal compiler seam for coordinated descriptor-mutation tests. */
export const codecProfileBehaviorIsValidForTesting = (value: unknown) => {
  try {
    return behaviorIsValid(value as typeof codecProfile);
  } catch {
    return false;
  }
};

export const validateCodecProfile = (value: typeof codecProfile) => {
  try {
    if (
      value.profileVersion !== standardsManifest.codecProfile.profileVersion ||
      fingerprintCanonicalMaterial(value) !==
        standardsManifest.codecProfile.profileFingerprint ||
      !supplyChainIsValid(value) ||
      !behaviorIsValid(value)
    ) {
      invalid();
    }
  } catch {
    throw new CodecProfileError();
  }
};

validateCodecProfile(codecProfile);

export const CODEC_PROFILE = deepFreeze(codecProfile);
export const CODEC_PROFILE_FINGERPRINT =
  standardsManifest.codecProfile.profileFingerprint;
