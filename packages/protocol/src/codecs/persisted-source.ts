import {
  safeParseCanonicalTraceGraph,
  type CanonicalTraceGraph,
} from "../schema/canonical-graph.js";
import { fingerprintCanonicalMaterial } from "../schema/extensions.js";
import type { IdentityStability } from "../schema/identity.js";
import { deepFreeze } from "../schema/immutable.js";
import { standardsManifest } from "../standards/manifest.js";
import { CODEC_PROFILE } from "./codec-profile.js";
import {
  isJsonNumber,
  parseBoundedJson,
  type ParsedJson,
  type ParsedJsonObject,
} from "./json-parser.js";

export type PersistedCanonicalEnvelope = Readonly<{
  envelopeVersion: 1;
  protocolManifestId: string;
  delivery: Readonly<{
    identity: string;
    stability: IdentityStability;
  }>;
  graph: CanonicalTraceGraph;
}>;

export type PersistedEnvelopeReadResult =
  | Readonly<{ ok: true; envelope: PersistedCanonicalEnvelope }>
  | Readonly<{
      ok: false;
      code: "protocol.reader.invalid" | "protocol.reader.unsupported";
    }>;

export type PersistedEnvelopeSupport = Readonly<{
  manifestId: string;
  envelopeVersion: number;
  protocolContractVersion?: number;
}>;

export const HISTORICAL_V1_MANIFEST_ID =
  "agentscope-protocol-1_otel-1.60.0_otlp-1.11.0_otel-semconv-1.44.0_openinference-js-2.7.0_profile-1-sha256-dc5795cc6d080352aa296d6034715c04621b9e03223f86d2cca53c3677d9f252_identity-1-sha256-2c10f312f8e0bf8e6e040843cf88bc5d384993609a4843038fd8e2ed27d8f66b_extensions-1-sha256-24ad1108f9c1ebc9f6e160977337034de1ee80183cfcb07d39d825b84414f1c2_codec-1-sha256-d6d556675a221e421cf1547a613d26418460b1aeea13b964c2ca546f80d09c2e_compatibility-1-sha256-3f8b0767f3582527e0424679e0e79780b767c48a4ca2c4672ce847b6ad9f0408";

const expectedDescriptor = () =>
  ({
    descriptorVersion: 1,
    schemaKind: "canonical-envelope-v1",
    trust: "untrusted-unbranded-envelope",
    unknownFields: "reject",
    manifestBinding: "exact-supported-outer-and-resource",
    envelope: {
      keys: ["envelopeVersion", "protocolManifestId", "delivery", "graph"],
      version: 1,
      deliveryKeys: ["identity", "stability"],
      deliveryIdentityPattern: "^[\\da-f]{64}$",
      deliveryIdentityAllZero: "reject",
      stabilityValues: [
        "session-stable",
        "boundary-scoped-at-least-once",
        "attempt-scoped-at-least-once",
      ],
    },
    jsonBudgets: {
      maximumBytes: CODEC_PROFILE.persistedEnvelopeReader.maximumBytes,
      maximumDepth: CODEC_PROFILE.persistedEnvelopeReader.maximumDepth,
      maximumNodes: CODEC_PROFILE.persistedEnvelopeReader.maximumNodes,
      maximumObjectKeys:
        CODEC_PROFILE.persistedEnvelopeReader.maximumObjectKeys,
      maximumArrayItems:
        CODEC_PROFILE.persistedEnvelopeReader.maximumArrayItems,
      maximumStringBytes:
        CODEC_PROFILE.persistedEnvelopeReader.maximumStringBytes,
    },
    graphValidation: "strict-source-generation-canonical-profile",
    canonicalProfileFingerprint:
      standardsManifest.canonicalProfile.profileFingerprint,
  }) as const;

export const HISTORICAL_V1_SOURCE_SCHEMA_DESCRIPTOR = deepFreeze({
  ...expectedDescriptor(),
  canonicalProfileFingerprint:
    "sha256-dc5795cc6d080352aa296d6034715c04621b9e03223f86d2cca53c3677d9f252",
});

export const PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR =
  deepFreeze(expectedDescriptor());

export const validatePersistedSourceSchemaDescriptorForTesting = (
  input: unknown,
) => {
  if (
    fingerprintCanonicalMaterial(input) !==
    fingerprintCanonicalMaterial(expectedDescriptor())
  ) {
    throw new Error("protocol.persisted-source.invalid");
  }
  return deepFreeze(input);
};

validatePersistedSourceSchemaDescriptorForTesting(
  PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR,
);

const invalidResult = deepFreeze({
  ok: false as const,
  code: "protocol.reader.invalid" as const,
});
const unsupportedResult = deepFreeze({
  ok: false as const,
  code: "protocol.reader.unsupported" as const,
});

const isRecord = (value: ParsedJson): value is ParsedJsonObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !isJsonNumber(value);

const hasExactKeys = (value: ParsedJsonObject, expected: readonly string[]) => {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
};

const materialize = (value: ParsedJson): unknown => {
  if (isJsonNumber(value)) {
    const number = Number(value.lexical);
    if (!Number.isFinite(number)) throw new Error("invalid");
    return number;
  }
  if (Array.isArray(value))
    return (value as readonly ParsedJson[]).map((entry) => materialize(entry));
  if (isRecord(value)) {
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value))
      output[key] = materialize(value[key]!);
    return output;
  }
  return value;
};

const descriptor = PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR;
const stabilityValues = new Set<IdentityStability>(
  descriptor.envelope.stabilityValues,
);
const deliveryIdentityPattern = new RegExp(
  descriptor.envelope.deliveryIdentityPattern,
  "u",
);
const isIdentityStability = (value: string): value is IdentityStability =>
  stabilityValues.has(value as IdentityStability);

const matchingSupport = (
  supports: readonly PersistedEnvelopeSupport[],
  manifestId: string,
  envelopeVersion: number,
) =>
  supports.find(
    (support) =>
      support.manifestId === manifestId &&
      support.envelopeVersion === envelopeVersion,
  );

const feedbackKey = /^(?:(?:trace|session)\.)?(?:annotations|evaluations)\./u;
const migrateHistoricalV1Graph = (graph: unknown) => {
  const migrated = structuredClone(graph) as {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key?: unknown; value?: unknown }> };
      scopeSpans?: Array<{
        scope?: { version?: string };
        spans?: Array<{ attributes?: Array<{ key?: unknown }> }>;
      }>;
    }>;
  };
  /* v8 ignore next -- strict historical source schema requires resourceSpans */
  for (const resource of migrated.resourceSpans ?? []) {
    /* v8 ignore next -- the v1 fixture has a resource attribute collection */
    for (const attribute of resource.resource?.attributes ?? []) {
      if (
        attribute.key === "agentscope.protocol.manifest_id" &&
        typeof attribute.value === "object" &&
        attribute.value !== null &&
        "stringValue" in attribute.value
      )
        (attribute.value as { stringValue: string }).stringValue =
          standardsManifest.manifestId;
    }
    /* v8 ignore next -- strict historical source schema requires scopeSpans */
    for (const scope of resource.scopeSpans ?? []) {
      if (scope.scope?.version !== "1") throw new Error("invalid");
      scope.scope.version = String(standardsManifest.protocolContractVersion);
      /* v8 ignore next -- strict historical source schema requires spans */
      for (const span of scope.spans ?? []) {
        /* v8 ignore next -- absence of attributes is a valid feedback-empty v1 span */
        if (
          (span.attributes ?? []).some(
            ({ key }) =>
              typeof key === "string" &&
              (feedbackKey.test(key) ||
                key === "agentscope.feedback.transport"),
          )
        )
          throw new Error("invalid");
      }
    }
  }
  return migrated;
};

export const readPersistedEnvelopeAgainstSupport = (
  input: unknown,
  supports: readonly PersistedEnvelopeSupport[],
): PersistedEnvelopeReadResult => {
  try {
    const parsed = parseBoundedJson(input, descriptor.jsonBudgets);
    if (
      !isRecord(parsed) ||
      (descriptor.unknownFields === "reject" &&
        !hasExactKeys(parsed, descriptor.envelope.keys))
    ) {
      return invalidResult;
    }
    const record = parsed as ParsedJsonObject;
    const version = record.envelopeVersion;
    const manifest = record.protocolManifestId;
    if (
      !isJsonNumber(version) ||
      !Number.isSafeInteger(Number(version.lexical)) ||
      typeof manifest !== "string"
    ) {
      return invalidResult;
    }
    const numericVersion = Number(version.lexical);
    const support = matchingSupport(supports, manifest, numericVersion);
    if (support === undefined) return unsupportedResult;
    const delivery = record.delivery;
    if (delivery === undefined || !isRecord(delivery)) return invalidResult;
    const deliveryRecord = delivery as ParsedJsonObject;
    if (
      !hasExactKeys(deliveryRecord, descriptor.envelope.deliveryKeys) ||
      typeof deliveryRecord.identity !== "string" ||
      !deliveryIdentityPattern.test(deliveryRecord.identity) ||
      (descriptor.envelope.deliveryIdentityAllZero === "reject" &&
        /^0+$/u.test(deliveryRecord.identity)) ||
      typeof deliveryRecord.stability !== "string" ||
      !isIdentityStability(deliveryRecord.stability)
    ) {
      return invalidResult;
    }
    const sourceGraph = materialize(record.graph!);
    const graph = safeParseCanonicalTraceGraph(
      support.protocolContractVersion === 1
        ? migrateHistoricalV1Graph(sourceGraph)
        : sourceGraph,
    );
    if (!graph.success) return invalidResult;
    return deepFreeze({
      ok: true,
      envelope: {
        envelopeVersion: descriptor.envelope.version,
        protocolManifestId:
          support.protocolContractVersion === 1
            ? standardsManifest.manifestId
            : manifest,
        delivery: {
          identity: deliveryRecord.identity,
          stability: deliveryRecord.stability,
        },
        graph: graph.data,
      },
    });
  } catch {
    return invalidResult;
  }
};
