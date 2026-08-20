import {
  encodeOtlpJson,
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpResourceSpans,
  type OtlpSpan,
  type RedactedCanonicalTrace,
} from "@agentscope/protocol";
import { MAXIMUM_TRANSPORT_REQUEST_BYTES } from "@agentscope/destinations-core";

import {
  deriveLangfuseProjectionFilterKey,
  LANGFUSE_PROJECTION_CONTRACT,
} from "../compatibility.js";
import { appendLangfuseGraphCapsule } from "./capsule.js";

type MutableSpan = OtlpSpan;

type MutableResourceSpans = Omit<OtlpResourceSpans, "scopeSpans"> & {
  scopeSpans: {
    spans: MutableSpan[];
  }[];
};

type EncodedTraceRequest = {
  resourceSpans: MutableResourceSpans[];
};

export type LangfuseRootProjection = Readonly<{
  metadata: Readonly<Record<string, string>>;
  sessionId?: string;
  tags: readonly string[];
}>;

const projection = LANGFUSE_PROJECTION_CONTRACT;
const textEncoder = new TextEncoder();
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

export class LangfuseProjectionError extends Error {
  public constructor() {
    super("destination.langfuse.projection.invalid");
    this.name = "LangfuseProjectionError";
  }
}

const invalid = (): never => {
  throw new LangfuseProjectionError();
};

const stringAttribute = (
  attributes: readonly OtlpKeyValue[] | undefined,
  key: string,
): string | undefined => {
  const value = attributes?.find((entry) => entry.key === key)?.value;
  return value !== undefined && "stringValue" in value
    ? value.stringValue
    : undefined;
};

const stringArrayAttribute = (
  attributes: readonly OtlpKeyValue[] | undefined,
  key: string,
): readonly string[] => {
  const value = attributes?.find((entry) => entry.key === key)?.value;
  if (value === undefined) return [];
  if (!("arrayValue" in value)) return invalid();
  return value.arrayValue.values.map((entry) => {
    if (!("stringValue" in entry)) return invalid();
    return entry.stringValue;
  });
};

const exactProjectionValue = (value: string): string => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        return invalid();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return invalid();
  }
  const normalized = value.normalize("NFC");
  if (
    normalized !== value ||
    normalized.length === 0 ||
    [...normalized].length > projection.maximumValueCharacters ||
    hasControlCharacter(normalized)
  )
    return invalid();
  return value;
};

const stableExactValues = (
  values: readonly string[],
  maximum: number,
  reservedPrefix?: string,
): readonly string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const source of values) {
    const value = exactProjectionValue(source);
    if (reservedPrefix !== undefined && value.startsWith(reservedPrefix))
      return invalid();
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (output.length > maximum) return invalid();
  }
  return Object.freeze(output);
};

const asciiCompare = (left: string, right: string): number =>
  left < right ? -1 : 1;

const overlayAttribute = (key: string, value: OtlpAnyValue): OtlpKeyValue => ({
  key,
  value,
});

const reservedMetadataKeys = new Set<string>([
  projection.root,
  projection.session,
  projection.harness,
  projection.branch,
  projection.repository,
  projection.status,
  projection.spanCount,
  projection.modelCount,
  projection.tagCount,
]);

const isReservedMetadataKey = (key: string): boolean =>
  reservedMetadataKeys.has(key) ||
  key.startsWith(projection.modelIndexPrefix) ||
  key.startsWith(projection.tagIndexPrefix);

const isReservedWireAttribute = (key: string): boolean => {
  if (key === projection.wire.traceTagsAttribute) return true;
  for (const prefix of [
    projection.wire.observationMetadataPrefix,
    projection.wire.traceMetadataPrefix,
  ])
    if (key.startsWith(prefix))
      return isReservedMetadataKey(key.slice(prefix.length));
  return false;
};

/* eslint-disable max-lines-per-function -- one atomic projection validator owns the complete collision and boundedness ledger. */
export const projectLangfuseRoot = (
  resourceSpans: MutableResourceSpans,
): LangfuseRootProjection => {
  const spans = resourceSpans.scopeSpans.flatMap((scope) => scope.spans);
  const roots = spans.filter((span) => span.parentSpanId === undefined);
  if (
    roots.length !== 1 ||
    spans.length === 0 ||
    spans.length > projection.maximumSpans
  )
    return invalid();
  const root = roots[0]!;
  if (
    spans.some((span) =>
      (span.attributes ?? []).some(({ key }) => isReservedWireAttribute(key)),
    )
  )
    return invalid();
  const resourceAttributes = resourceSpans.resource?.attributes;
  const optionalMetadata = [
    [projection.session, stringAttribute(root.attributes, "session.id")],
    [
      projection.harness,
      stringAttribute(root.attributes, "agentscope.harness.name"),
    ],
    [
      projection.branch,
      stringAttribute(resourceAttributes, "vcs.ref.head.name"),
    ],
    [
      projection.repository,
      stringAttribute(resourceAttributes, "vcs.repository.name"),
    ],
  ] as const;
  const models = stableExactValues(
    spans.flatMap((span) =>
      projection.modelAttributeKeys.flatMap((key) => {
        const value = stringAttribute(span.attributes, key);
        return value === undefined ? [] : [value];
      }),
    ),
    projection.maximumModels,
  );
  const userTags = stableExactValues(
    spans.flatMap((span) => stringArrayAttribute(span.attributes, "tag.tags")),
    projection.maximumTags,
    projection.modelTagPrefix,
  );
  const modelTags = models.map((model) =>
    exactProjectionValue(`${projection.modelTagPrefix}${model}`),
  );
  const tags = Object.freeze([...modelTags, ...userTags]);
  const metadataEntries: [string, string][] = [
    [projection.root, "true"],
    [
      projection.status,
      root.status?.code === 2
        ? "error"
        : root.status?.code === 1
          ? "ok"
          : "unset",
    ],
    [projection.spanCount, String(spans.length)],
    [projection.modelCount, String(models.length)],
    [projection.tagCount, String(userTags.length)],
  ];
  for (const [key, value] of optionalMetadata)
    if (value !== undefined)
      metadataEntries.push([key, exactProjectionValue(value)]);
  models.forEach((value, index) =>
    metadataEntries.push(
      [
        `${projection.modelIndexPrefix}${String(index).padStart(2, "0")}`,
        value,
      ],
      [deriveLangfuseProjectionFilterKey("model", value), value],
    ),
  );
  userTags.forEach((value, index) =>
    metadataEntries.push(
      [`${projection.tagIndexPrefix}${String(index).padStart(2, "0")}`, value],
      [deriveLangfuseProjectionFilterKey("tag", value), value],
    ),
  );
  metadataEntries.sort(([left], [right]) => asciiCompare(left, right));
  /* v8 ignore next 2 -- the manifest's four fixed, four optional, and two bounded 32-entry mirrors total exactly the asserted maximum. */
  if (metadataEntries.length > projection.maximumMetadataEntries)
    return invalid();
  const sessionId = optionalMetadata[0][1];
  const projectionPreimage = JSON.stringify([
    metadataEntries,
    sessionId === undefined ? null : exactProjectionValue(sessionId),
    tags,
  ]);
  if (
    textEncoder.encode(projectionPreimage).byteLength >
    projection.maximumProjectionBytes
  )
    return invalid();
  const overlays = metadataEntries.flatMap(([key, value]) => [
    overlayAttribute(`${projection.wire.observationMetadataPrefix}${key}`, {
      stringValue: value,
    }),
    overlayAttribute(`${projection.wire.traceMetadataPrefix}${key}`, {
      stringValue: value,
    }),
  ]);
  if (tags.length > 0)
    overlays.push(
      overlayAttribute(projection.wire.traceTagsAttribute, {
        arrayValue: {
          values: tags.map((value) => ({ stringValue: value })),
        },
      }),
    );
  /* v8 ignore next 2 -- two overlays per bounded metadata entry plus one tag overlay remain within the manifest's independent ceiling. */
  if (overlays.length > projection.maximumWireOverlayAttributes)
    return invalid();
  root.attributes = [...(root.attributes ?? []), ...overlays];
  return Object.freeze({
    metadata: Object.freeze(Object.fromEntries(metadataEntries)),
    ...(sessionId === undefined
      ? {}
      : { sessionId: exactProjectionValue(sessionId) }),
    tags,
  });
};
/* eslint-enable max-lines-per-function */

const encodeLangfuseOtlpJsonBatchWithinLimit = (
  traces: readonly [RedactedCanonicalTrace, ...RedactedCanonicalTrace[]],
  maximumBytes: number,
): Uint8Array => {
  const resourceSpans: MutableResourceSpans[] = [];
  const capsuleNonces = new Set<string>();
  let inputBytes = 0;
  for (const trace of traces) {
    const encoded = encodeOtlpJson(trace);
    inputBytes += textEncoder.encode(encoded).byteLength;
    /* v8 ignore next -- Protocol's branded batch and trace bounds keep valid inputs below the stricter transport ceiling. */
    if (inputBytes > maximumBytes) return invalid();
    const request = JSON.parse(encoded) as EncodedTraceRequest;
    const rootResources = request.resourceSpans.filter((resource) =>
      resource.scopeSpans.some((scope) =>
        scope.spans.some((span) => span.parentSpanId === undefined),
      ),
    );
    /* v8 ignore next -- Protocol-branded canonical graphs already require exactly one root across all resources. */
    if (rootResources.length !== 1) return invalid();
    const rootResource = rootResources[0]!;
    projectLangfuseRoot({
      ...rootResource,
      scopeSpans: request.resourceSpans.flatMap(
        (resource) => resource.scopeSpans,
      ),
    });
    const capsule = appendLangfuseGraphCapsule(rootResource, encoded);
    /* v8 ignore next 2 -- independent CSPRNG collision protection retained for multiple logical items in one immutable request plan. */
    if (capsuleNonces.has(capsule.nonce)) return invalid();
    capsuleNonces.add(capsule.nonce);
    resourceSpans.push(...request.resourceSpans);
    resourceSpans.push(capsule.resourceSpans);
  }
  const body = textEncoder.encode(JSON.stringify({ resourceSpans }));
  /* v8 ignore next -- the input and projection ceilings jointly keep valid encoded batches below the transport ceiling. */
  if (body.byteLength > maximumBytes) return invalid();
  return body;
};

export const encodeLangfuseOtlpJsonBatch = (
  traces: readonly [RedactedCanonicalTrace, ...RedactedCanonicalTrace[]],
): Uint8Array =>
  encodeLangfuseOtlpJsonBatchWithinLimit(
    traces,
    MAXIMUM_TRANSPORT_REQUEST_BYTES,
  );
