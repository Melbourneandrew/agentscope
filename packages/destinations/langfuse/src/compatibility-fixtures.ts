import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { encodeOtlpJson } from "@agentscope/protocol";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";

import {
  deriveLangfuseProjectionFilterKey,
  LANGFUSE_CAPSULE_CONTRACT,
  LANGFUSE_PROJECTION_CONTRACT,
} from "./compatibility.js";

export type LangfuseJson =
  | null
  | boolean
  | number
  | string
  | readonly LangfuseJson[]
  | { readonly [key: string]: LangfuseJson };

export type LangfuseHttpFixture = Readonly<{
  fixtureId: string;
  profileId: string;
  request: Readonly<{
    method: "DELETE" | "GET" | "POST";
    path: string;
    headers: Readonly<Record<string, string>>;
    query: Readonly<Record<string, string>>;
    body: LangfuseJson;
  }>;
  response: Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: LangfuseJson;
  }>;
}>;

export type LangfuseFilterConformanceFixture = Readonly<{
  fixtureId: string;
  profileId: string;
  profile: "v1-events" | "v2";
  filter:
    | "branch"
    | "from"
    | "harness"
    | "model"
    | "session"
    | "tags"
    | "to"
    | "traceId";
  disposition: "match" | "miss";
  request: Readonly<{
    method: "GET";
    path: string;
    headers: Readonly<Record<string, string>>;
    query: Readonly<Record<string, string>>;
    body: null;
  }>;
  expectedTraceIds: readonly string[];
}>;

const freeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

const projection = LANGFUSE_PROJECTION_CONTRACT;
const capsule = LANGFUSE_CAPSULE_CONTRACT;
const fixtureTrace = createSanitizedRedactedCanonicalTraceFixture({
  sessionId: "session-fixture",
  tags: ["fixture"],
  modelName: "gpt-5",
});
const fixtureGraphJson = encodeOtlpJson(fixtureTrace);
const fixtureGraph = JSON.parse(fixtureGraphJson) as {
  resourceSpans: {
    resource?: LangfuseJson;
    scopeSpans: {
      scope?: LangfuseJson;
      spans: {
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        [key: string]: LangfuseJson | undefined;
      }[];
    }[];
  }[];
};
const fixtureRoot = fixtureGraph.resourceSpans
  .flatMap(({ scopeSpans }) => scopeSpans)
  .flatMap(({ spans }) => spans)
  .find(({ parentSpanId }) => parentSpanId === undefined)!;
const fixtureResourceAttributes = (
  fixtureGraph.resourceSpans[0]!.resource as {
    attributes: readonly { key: string; value: LangfuseJson }[];
  }
).attributes;
const traceId = fixtureRoot.traceId;
const spanId = fixtureRoot.spanId;
const capsuleNonce = "11111111111111111111111111111111";
const capsuleId = (role: "header" | "carrier", index: number) =>
  createHash("sha256")
    .update(
      `agentscope:langfuse:capsule:v1:${traceId}:${capsuleNonce}:${role}:${String(index)}`,
    )
    .digest("hex")
    .slice(0, 16);
const capsuleHeaderId = capsuleId("header", 0);
const capsuleCarrierId = capsuleId("carrier", 0);
const milliseconds = (nanoseconds: string) =>
  new Date(Number(BigInt(nanoseconds) / 1_000_000n)).toISOString();
const startTime = milliseconds(fixtureRoot.startTimeUnixNano);
const endTime = milliseconds(fixtureRoot.endTimeUnixNano);
const filterTraceId = "0123456789abcdef0123456789abcdef";
const filterStartTime = "2026-01-02T03:04:05.000Z";
const filterEndTime = "2026-01-02T03:04:06.000Z";

const rootMetadata = {
  [projection.root]: "true",
  [projection.session]: "session-fixture",
  [projection.harness]: "codex",
  [projection.branch]: "main",
  [projection.repository]: "repository-fixture",
  [projection.status]: "unset",
  [projection.spanCount]: "3",
  [projection.modelCount]: "1",
  [`${projection.modelIndexPrefix}00`]: "gpt-5",
  [deriveLangfuseProjectionFilterKey("model", "gpt-5")]: "gpt-5",
  [projection.tagCount]: "1",
  [`${projection.tagIndexPrefix}00`]: "fixture",
  [deriveLangfuseProjectionFilterKey("tag", "fixture")]: "fixture",
} as const;

const rootFilter = {
  type: "stringObject",
  column: "metadata",
  key: capsule.keys.marker,
  operator: "=",
  value: capsule.marker,
} as const;

const filter = (
  type: string,
  column: string,
  operator: string,
  value: unknown,
  key?: string,
) => ({
  type,
  column,
  ...(key === undefined ? {} : { key }),
  operator,
  value,
});

const metadataFilter = (key: string, value: string) =>
  filter("stringObject", "metadata", "=", value, key);

const exactModelFilter = (value: string) =>
  metadataFilter(deriveLangfuseProjectionFilterKey("model", value), value);
const exactTagFilter = (value: string) =>
  metadataFilter(deriveLangfuseProjectionFilterKey("tag", value), value);

const fixtureGraphBytes = Buffer.from(fixtureGraphJson, "utf8");
const capsuleGraphDigest = createHash("sha256")
  .update(fixtureGraphBytes)
  .digest("hex");
const capsuleChunks = Array.from(
  {
    length: Math.ceil(
      fixtureGraphBytes.toString("base64url").length / capsule.chunkCharacters,
    ),
  },
  (_, index) =>
    fixtureGraphBytes
      .toString("base64url")
      .slice(
        index * capsule.chunkCharacters,
        (index + 1) * capsule.chunkCharacters,
      ),
);

const headerMetadata = {
  ...rootMetadata,
  [capsule.keys.marker]: capsule.marker,
  [capsule.keys.nonce]: capsuleNonce,
  [capsule.keys.version]: capsule.version,
  [capsule.keys.graphBytes]: String(fixtureGraphBytes.byteLength),
  [capsule.keys.graphDigest]: capsuleGraphDigest,
  [capsule.keys.carrierCount]: "1",
  [capsule.keys.chunkCount]: String(capsuleChunks.length),
} as const;

const rootProjectionAttributes = [
  ...Object.entries(rootMetadata).map(([key, value]) => ({
    key: `langfuse.observation.metadata.${key}`,
    value: { stringValue: value },
  })),
  ...Object.entries(rootMetadata).map(([key, value]) => ({
    key: `langfuse.trace.metadata.${key}`,
    value: { stringValue: value },
  })),
  { key: "session.id", value: { stringValue: "session-fixture" } },
  {
    key: "langfuse.trace.tags",
    value: {
      arrayValue: {
        values: [
          { stringValue: "agentscope:model:gpt-5" },
          { stringValue: "fixture" },
        ],
      },
    },
  },
] as const;

const capsuleMetadataAttributes = (
  metadata: Readonly<Record<string, string>>,
) =>
  Object.entries(metadata).map(([key, value]) => ({
    key: `${projection.wire.observationMetadataPrefix}${key}`,
    value: { stringValue: value },
  }));

const closedCapsuleSpan = (
  id: string,
  name: string,
  attributes: readonly LangfuseJson[],
) => ({
  traceId,
  spanId: id,
  parentSpanId: spanId,
  name,
  kind: 1,
  startTimeUnixNano: fixtureRoot.startTimeUnixNano,
  endTimeUnixNano: fixtureRoot.startTimeUnixNano,
  attributes,
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  links: [],
  droppedLinksCount: 0,
  flags: 0,
  status: { code: 0 },
});

const basePortableFilters = [
  rootFilter,
  filter(
    "datetime",
    "startTime",
    ">=",
    new Date(Date.parse(startTime) - 1_000).toISOString(),
  ),
  filter("datetime", "startTime", "<", endTime),
  exactModelFilter("gpt-5"),
  filter("string", "sessionId", "=", "session-fixture"),
  exactTagFilter("fixture"),
] as const;

const fixtures = [
  {
    fixtureId: "otlp-v4-json-root-v1",
    profileId: "langfuse-cloud-v4",
    request: {
      method: "POST",
      path: "/api/public/otel/v1/traces",
      headers: {
        authorization: "[credential-slot]",
        "content-type": "application/json",
        "x-langfuse-ingestion-version": "4",
      },
      query: {},
      body: {
        resourceSpans: [
          ...(fixtureGraph.resourceSpans as unknown as readonly LangfuseJson[]),
          {
            resource: {
              attributes: fixtureResourceAttributes.filter(({ key }) =>
                capsule.transportSpan.resourceAttributeKeys.includes(
                  key as "agentscope.protocol.manifest_id" | "service.name",
                ),
              ),
              droppedAttributesCount: 0,
            },
            scopeSpans: [
              {
                scope: { name: capsule.scopeName },
                spans: [
                  closedCapsuleSpan(capsuleHeaderId, capsule.headerName, [
                    ...rootProjectionAttributes,
                    ...capsuleMetadataAttributes({
                      [capsule.keys.marker]: capsule.marker,
                      [capsule.keys.nonce]: capsuleNonce,
                      [capsule.keys.version]: capsule.version,
                      [capsule.keys.graphBytes]: String(
                        fixtureGraphBytes.byteLength,
                      ),
                      [capsule.keys.graphDigest]: capsuleGraphDigest,
                      [capsule.keys.carrierCount]: "1",
                      [capsule.keys.chunkCount]: String(capsuleChunks.length),
                    }),
                    {
                      key: projection.wire.sessionAttribute,
                      value: { stringValue: "session-fixture" },
                    },
                  ]),
                  closedCapsuleSpan(capsuleCarrierId, capsule.carrierName, [
                    ...capsuleMetadataAttributes({
                      [capsule.keys.nonce]: capsuleNonce,
                      [capsule.keys.version]: capsule.version,
                      [capsule.keys.graphDigest]: capsuleGraphDigest,
                      [capsule.keys.carrierIndex]: "0",
                    }),
                    {
                      key: `${projection.wire.observationMetadataPrefix}${capsule.keys.chunks}`,
                      value: {
                        arrayValue: {
                          values: capsuleChunks.map((value) => ({
                            stringValue: value,
                          })),
                        },
                      },
                    },
                  ]),
                ],
              },
            ],
          },
        ],
      },
    },
    response: { status: 200, headers: {}, body: {} },
  },
  {
    fixtureId: "observations-v2-root-search-v1",
    profileId: "langfuse-cloud-v4",
    request: {
      method: "GET",
      path: "/api/public/v2/observations",
      headers: { authorization: "[credential-slot]" },
      query: {
        fields: "core,basic,time,metadata,trace_context",
        limit: "50",
        filter: JSON.stringify(basePortableFilters),
      },
      body: null,
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        data: [
          {
            id: capsuleHeaderId,
            traceId,
            projectId: "project-fixture",
            parentObservationId: spanId,
            type: "SPAN",
            startTime,
            endTime: startTime,
            isRootObservation: false,
            name: capsule.headerName,
            level: "DEFAULT",
            statusMessage: null,
            sessionId: "session-fixture",
            metadata: headerMetadata,
            tags: ["agentscope:model:gpt-5", "fixture"],
            modelId: null,
            inputPrice: null,
            outputPrice: null,
            totalPrice: null,
          },
        ],
        meta: { cursor: "SANITIZED_CURSOR" },
      },
    },
  },
  {
    fixtureId: "observations-v1-events-root-search-v1",
    profileId: "langfuse-self-hosted-v3-events-3.225.3",
    request: {
      method: "GET",
      path: "/api/public/observations",
      headers: { authorization: "[credential-slot]" },
      query: {
        page: "1",
        limit: "50",
        useEventsTable: "true",
        filter: JSON.stringify([
          ...basePortableFilters.filter(
            (entry) => !(entry.column === "sessionId"),
          ),
          metadataFilter(projection.session, "session-fixture"),
        ]),
      },
      body: null,
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        data: [
          {
            id: capsuleHeaderId,
            projectId: "project-fixture",
            traceId,
            parentObservationId: spanId,
            name: capsule.headerName,
            type: "SPAN",
            environment: "default",
            startTime,
            endTime: startTime,
            version: null,
            createdAt: startTime,
            updatedAt: endTime,
            input: null,
            output: null,
            metadata: headerMetadata,
            level: "DEFAULT",
            statusMessage: null,
            model: null,
            modelParameters: null,
            completionStartTime: null,
            promptId: null,
            promptName: null,
            promptVersion: null,
            usageDetails: {},
            costDetails: {},
            usage: { unit: "TOKENS", input: 0, output: 0, total: 0 },
            unit: "TOKENS",
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            usagePricingTierName: null,
            usagePricingTierId: null,
            modelId: null,
            inputPrice: null,
            outputPrice: null,
            totalPrice: null,
            calculatedInputCost: null,
            calculatedOutputCost: null,
            calculatedTotalCost: null,
            latency: 1,
            timeToFirstToken: null,
          },
        ],
        meta: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
      },
    },
  },
  {
    fixtureId: "observations-v2-rate-limit-v1",
    profileId: "langfuse-cloud-v4",
    request: {
      method: "GET",
      path: "/api/public/v2/observations",
      headers: { authorization: "[credential-slot]" },
      query: { limit: "50" },
      body: null,
    },
    response: {
      status: 429,
      headers: { "retry-after": "30" },
      body: { message: "SANITIZED_PROVIDER_MESSAGE" },
    },
  },
  ...[
    {
      fixtureId: "observations-v1-events-selector-omitted-v1",
      selector: undefined,
    },
    {
      fixtureId: "observations-v1-events-selector-false-v1",
      selector: "false",
    },
    {
      fixtureId: "observations-v1-events-selector-mutated-v1",
      selector: "1",
    },
  ].map(({ fixtureId, selector }) => ({
    fixtureId,
    profileId: "langfuse-self-hosted-v3-events-3.225.3",
    request: {
      method: "GET" as const,
      path: "/api/public/observations",
      headers: { authorization: "[credential-slot]" },
      query: {
        page: "1",
        limit: "50",
        ...(selector === undefined ? {} : { useEventsTable: selector }),
        filter: JSON.stringify([rootFilter]),
      },
      body: null,
    },
    response: {
      status: 400,
      headers: { "content-type": "application/json" },
      body: { message: "SANITIZED_PROVIDER_MESSAGE" },
    },
  })),
  {
    fixtureId: "trace-delete-accepted-v1",
    profileId: "langfuse-cloud-v4",
    request: {
      method: "DELETE",
      path: `/api/public/traces/${filterTraceId}`,
      headers: { authorization: "[credential-slot]" },
      query: {},
      body: null,
    },
    response: { status: 200, headers: {}, body: { message: "Trace deleted" } },
  },
] as const satisfies readonly LangfuseHttpFixture[];

export const LANGFUSE_SANITIZED_HTTP_FIXTURES = freeze(fixtures);
type FilterName = LangfuseFilterConformanceFixture["filter"];
type FilterProfile = LangfuseFilterConformanceFixture["profile"];

const filterQuery = (
  profile: FilterProfile,
  filters: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, string>> =>
  profile === "v2"
    ? {
        fields: "core,basic,time,metadata,trace_context",
        limit: "50",
        filter: JSON.stringify(filters),
      }
    : {
        page: "1",
        limit: "50",
        useEventsTable: "true",
        filter: JSON.stringify(filters),
      };

const filterRequest = (
  profile: FilterProfile,
  filters: readonly Readonly<Record<string, unknown>>[],
) => ({
  method: "GET" as const,
  path:
    profile === "v2"
      ? "/api/public/v2/observations"
      : "/api/public/observations",
  headers: { authorization: "[credential-slot]" },
  query: filterQuery(profile, filters),
  body: null,
});

const predicateQuery = (
  profile: FilterProfile,
  filterName: FilterName,
  value: string,
): readonly Readonly<Record<string, unknown>>[] => {
  const fixedUpperBound = filter("datetime", "startTime", "<", filterEndTime);
  switch (filterName) {
    case "traceId":
      return [
        rootFilter,
        filter("string", "traceId", "=", value),
        fixedUpperBound,
      ];
    case "from":
      return [
        rootFilter,
        filter("datetime", "startTime", ">=", value),
        fixedUpperBound,
      ];
    case "to":
      return [rootFilter, filter("datetime", "startTime", "<", value)];
    case "harness":
      return [
        rootFilter,
        fixedUpperBound,
        metadataFilter(projection.harness, value),
      ];
    case "branch":
      return [
        rootFilter,
        fixedUpperBound,
        metadataFilter(projection.branch, value),
      ];
    case "model":
      return [rootFilter, fixedUpperBound, exactModelFilter(value)];
    case "session":
      return [
        rootFilter,
        fixedUpperBound,
        profile === "v2"
          ? filter("string", "sessionId", "=", value)
          : metadataFilter(projection.session, value),
      ];
    case "tags":
      return [rootFilter, fixedUpperBound, exactTagFilter(value)];
  }
};

const predicateValues = {
  traceId: [filterTraceId, "fedcba9876543210fedcba9876543210"],
  from: [filterStartTime, filterEndTime],
  to: [filterEndTime, filterStartTime],
  harness: ["codex", "claude-code"],
  branch: ["main", "release"],
  model: ["gpt-5", "different-model"],
  session: ["session-fixture", "session-miss"],
  tags: ["fixture", "tag-miss"],
} as const satisfies Record<FilterName, readonly [string, string]>;

const filterConformanceProfiles = [
  { profile: "v2", profileId: "langfuse-cloud-v4" },
  { profile: "v2", profileId: "langfuse-self-hosted-v4" },
  {
    profile: "v1-events",
    profileId: "langfuse-self-hosted-v3-events-3.225.3",
  },
] as const;

const filterConformanceFixtures = filterConformanceProfiles.flatMap(
  ({ profile, profileId }) =>
    (Object.keys(predicateValues) as FilterName[]).flatMap((filter) =>
      (["match", "miss"] as const).map((disposition, index) => ({
        fixtureId: `${profileId}-${filter}-${disposition}-v1`,
        profileId,
        profile,
        filter,
        disposition,
        request: filterRequest(
          profile,
          predicateQuery(profile, filter, predicateValues[filter][index]!),
        ),
        expectedTraceIds: disposition === "match" ? [filterTraceId] : [],
      })),
    ),
) satisfies LangfuseFilterConformanceFixture[];

export const LANGFUSE_FILTER_CONFORMANCE_FIXTURES = freeze(
  filterConformanceFixtures,
);
