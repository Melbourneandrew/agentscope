import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

import type {
  OtlpKeyValue,
  OtlpResourceSpans,
  OtlpSpan,
} from "@agentscope/protocol";

import {
  LANGFUSE_CAPSULE_CONTRACT,
  LANGFUSE_PROJECTION_CONTRACT,
} from "../compatibility.js";

export { LANGFUSE_CAPSULE_CONTRACT } from "../compatibility.js";

type MutableResourceSpans = Omit<OtlpResourceSpans, "scopeSpans"> & {
  scopeSpans: {
    scope?: OtlpResourceSpans["scopeSpans"][number]["scope"];
    schemaUrl?: string;
    spans: OtlpSpan[];
  }[];
};

type CapsulePlan = Readonly<{
  nonce: string;
  carrierCount: number;
  resourceSpans: MutableResourceSpans;
}>;

export class LangfuseCapsuleError extends Error {
  public constructor() {
    super("destination.langfuse.capsule.invalid");
    this.name = "LangfuseCapsuleError";
  }
}

const invalid = (): never => {
  throw new LangfuseCapsuleError();
};

const metadataAttribute = (key: string, value: string): OtlpKeyValue => ({
  key: `${LANGFUSE_PROJECTION_CONTRACT.wire.observationMetadataPrefix}${key}`,
  value: { stringValue: value },
});

export const deriveLangfuseCapsuleSpanId = (
  traceId: string,
  nonce: string,
  role: "header" | "carrier",
  index: number,
): string =>
  createHash("sha256")
    .update(
      `agentscope:langfuse:capsule:v1:${traceId}:${nonce}:${role}:${String(index)}`,
    )
    .digest("hex")
    .slice(0, 16);

const closedSpan = (
  root: OtlpSpan,
  name: string,
  id: string,
  attributes: readonly OtlpKeyValue[],
): OtlpSpan => ({
  traceId: root.traceId,
  spanId: id,
  parentSpanId: root.spanId,
  name,
  kind: 1,
  startTimeUnixNano: root.startTimeUnixNano,
  endTimeUnixNano: root.startTimeUnixNano,
  attributes: [...attributes],
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  links: [],
  droppedLinksCount: 0,
  flags: 0,
  status: { code: 0 },
});

const nonce = (): string => {
  const value = randomBytes(16).toString("hex");
  /* v8 ignore next -- the cryptographic source can produce all-zero bytes only with negligible probability; the fail-closed rule remains explicit. */
  if (value === "0".repeat(32)) return invalid();
  return value;
};

/* eslint-disable max-lines-per-function -- one immutable capsule plan binds nonce, IDs, chunks, projection transfer, and closed carrier construction atomically. */
export const appendLangfuseGraphCapsule = (
  resource: MutableResourceSpans,
  graphJson: string,
): CapsulePlan => {
  const bytes = new TextEncoder().encode(graphJson);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > LANGFUSE_CAPSULE_CONTRACT.maximumGraphBytes
  )
    return invalid();
  const spans = resource.scopeSpans.flatMap((scope) => scope.spans);
  const roots = spans.filter((span) => span.parentSpanId === undefined);
  if (roots.length !== 1) return invalid();
  const root = roots[0]!;
  const revision = nonce();
  const graphDigest = createHash("sha256").update(bytes).digest("hex");
  const encoded = Buffer.from(bytes).toString("base64url");
  const chunks = Array.from(
    {
      length: Math.ceil(
        encoded.length / LANGFUSE_CAPSULE_CONTRACT.chunkCharacters,
      ),
    },
    (_, index) =>
      encoded.slice(
        index * LANGFUSE_CAPSULE_CONTRACT.chunkCharacters,
        (index + 1) * LANGFUSE_CAPSULE_CONTRACT.chunkCharacters,
      ),
  );
  const carrierCount = Math.ceil(
    chunks.length / LANGFUSE_CAPSULE_CONTRACT.maximumChunksPerCarrier,
  );
  /* v8 ignore next 4 -- the manifest's graph/chunk ceilings algebraically admit 1..11 carriers; this retains the independent final assertion. */
  if (
    carrierCount < 1 ||
    carrierCount > LANGFUSE_CAPSULE_CONTRACT.maximumCarriers
  )
    return invalid();
  const headerId = deriveLangfuseCapsuleSpanId(
    root.traceId,
    revision,
    "header",
    0,
  );
  const carrierIds = Array.from({ length: carrierCount }, (_, index) =>
    deriveLangfuseCapsuleSpanId(root.traceId, revision, "carrier", index),
  );
  const existingIds = new Set(spans.map((span) => span.spanId));
  const capsuleIds = [headerId, ...carrierIds];
  /* v8 ignore next 5 -- SHA-256-truncated collision is not seedable through the production CSPRNG seam; the independent pre-transport rejection remains authoritative. */
  if (
    new Set(capsuleIds).size !== capsuleIds.length ||
    capsuleIds.some((id) => existingIds.has(id))
  )
    return invalid();

  const projectionAttributes = (root.attributes ?? []).filter((attribute) =>
    attribute.key.startsWith("langfuse."),
  );
  root.attributes = (root.attributes ?? []).filter(
    (attribute) => !attribute.key.startsWith("langfuse."),
  );
  const headerAttributes: OtlpKeyValue[] = [
    ...projectionAttributes,
    metadataAttribute(
      LANGFUSE_CAPSULE_CONTRACT.keys.marker,
      LANGFUSE_CAPSULE_CONTRACT.marker,
    ),
    metadataAttribute(LANGFUSE_CAPSULE_CONTRACT.keys.nonce, revision),
    metadataAttribute(
      LANGFUSE_CAPSULE_CONTRACT.keys.version,
      LANGFUSE_CAPSULE_CONTRACT.version,
    ),
    metadataAttribute(
      LANGFUSE_CAPSULE_CONTRACT.keys.graphBytes,
      String(bytes.byteLength),
    ),
    metadataAttribute(LANGFUSE_CAPSULE_CONTRACT.keys.graphDigest, graphDigest),
    metadataAttribute(
      LANGFUSE_CAPSULE_CONTRACT.keys.carrierCount,
      String(carrierCount),
    ),
    metadataAttribute(
      LANGFUSE_CAPSULE_CONTRACT.keys.chunkCount,
      String(chunks.length),
    ),
  ];
  const session = root.attributes.find(
    (attribute) => attribute.key === "session.id",
  );
  if (session !== undefined) headerAttributes.push(session);
  const carriers = Array.from({ length: carrierCount }, (_, index) => {
    const values = chunks.slice(
      index * LANGFUSE_CAPSULE_CONTRACT.maximumChunksPerCarrier,
      (index + 1) * LANGFUSE_CAPSULE_CONTRACT.maximumChunksPerCarrier,
    );
    return closedSpan(
      root,
      LANGFUSE_CAPSULE_CONTRACT.carrierName,
      carrierIds[index]!,
      [
        metadataAttribute(LANGFUSE_CAPSULE_CONTRACT.keys.nonce, revision),
        metadataAttribute(
          LANGFUSE_CAPSULE_CONTRACT.keys.version,
          LANGFUSE_CAPSULE_CONTRACT.version,
        ),
        metadataAttribute(
          LANGFUSE_CAPSULE_CONTRACT.keys.graphDigest,
          graphDigest,
        ),
        metadataAttribute(
          LANGFUSE_CAPSULE_CONTRACT.keys.carrierIndex,
          String(index),
        ),
        {
          key: `${LANGFUSE_PROJECTION_CONTRACT.wire.observationMetadataPrefix}${LANGFUSE_CAPSULE_CONTRACT.keys.chunks}`,
          value: {
            arrayValue: {
              values: values.map((value) => ({ stringValue: value })),
            },
          },
        },
      ],
    );
  });
  const allowedResourceKeys = new Set<string>(
    LANGFUSE_CAPSULE_CONTRACT.transportSpan.resourceAttributeKeys,
  );
  const resourceSpans: MutableResourceSpans = {
    resource: {
      attributes: (resource.resource?.attributes ?? []).filter(({ key }) =>
        allowedResourceKeys.has(key),
      ),
      droppedAttributesCount: 0,
    },
    scopeSpans: [
      {
        scope: { name: LANGFUSE_CAPSULE_CONTRACT.scopeName },
        spans: [
          closedSpan(
            root,
            LANGFUSE_CAPSULE_CONTRACT.headerName,
            headerId,
            headerAttributes,
          ),
          ...carriers,
        ],
      },
    ],
  };
  return Object.freeze({ nonce: revision, carrierCount, resourceSpans });
};
/* eslint-enable max-lines-per-function */
