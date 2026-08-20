import { LANGFUSE_PROJECTION_CONTRACT } from "./compatibility.js";

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
const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";
const startTime = "2026-01-02T03:04:05.000Z";
const endTime = "2026-01-02T03:04:06.000Z";

const rootMetadata = {
  [projection.root]: "true",
  [projection.session]: "session-fixture",
  [projection.harness]: "codex",
  [projection.branch]: "main",
  [projection.repository]: "repository-fixture",
  [projection.spanCount]: "2",
  [projection.modelCount]: "1",
  [`${projection.modelIndexPrefix}00`]: "gpt-5",
  [projection.tagCount]: "1",
  [`${projection.tagIndexPrefix}00`]: "fixture",
} as const;

const rootFilter = {
  type: "stringObject",
  column: "metadata",
  key: projection.root,
  operator: "=",
  value: "true",
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
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                scope: { name: "@agentscope/protocol" },
                spans: [
                  {
                    traceId,
                    spanId,
                    name: "agent-root",
                    startTimeUnixNano: "1767323045000000000",
                    endTimeUnixNano: "1767323046000000000",
                    attributes: rootProjectionAttributes,
                  },
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
        fromStartTime: "2026-01-01T00:00:00.000Z",
        toStartTime: "2026-01-03T00:00:00.000Z",
        limit: "50",
        sessionId: "session-fixture",
        filter: JSON.stringify([rootFilter]),
      },
      body: null,
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        data: [
          {
            id: spanId,
            traceId,
            projectId: "project-fixture",
            parentObservationId: null,
            type: "SPAN",
            startTime,
            endTime,
            isRootObservation: true,
            name: "agent-root",
            level: "DEFAULT",
            statusMessage: null,
            sessionId: "session-fixture",
            metadata: rootMetadata,
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
        fromStartTime: "2026-01-01T00:00:00.000Z",
        toStartTime: "2026-01-03T00:00:00.000Z",
        filter: JSON.stringify([
          rootFilter,
          {
            type: "stringObject",
            column: "metadata",
            key: projection.session,
            operator: "=",
            value: "session-fixture",
          },
          {
            type: "arrayOptions",
            column: "traceTags",
            operator: "all of",
            value: ["agentscope:model:gpt-5", "fixture"],
          },
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
            id: spanId,
            projectId: "project-fixture",
            traceId,
            parentObservationId: null,
            name: "agent-root",
            type: "SPAN",
            environment: "default",
            startTime,
            endTime,
            version: null,
            createdAt: startTime,
            updatedAt: endTime,
            input: null,
            output: null,
            metadata: rootMetadata,
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
  {
    fixtureId: "trace-delete-accepted-v1",
    profileId: "langfuse-cloud-v4",
    request: {
      method: "DELETE",
      path: `/api/public/traces/${traceId}`,
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

const metadataFilter = (key: string, value: string) => ({
  type: "stringObject",
  column: "metadata",
  key,
  operator: "=",
  value,
});

const tagsFilter = (value: string) => ({
  type: "arrayOptions",
  column: "traceTags",
  operator: "all of",
  value: [value],
});

const filterQuery = (
  profile: FilterProfile,
  query: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  profile === "v2"
    ? {
        fields: "core,basic,time,metadata,trace_context",
        limit: "50",
        filter: JSON.stringify([rootFilter]),
        ...query,
      }
    : {
        page: "1",
        limit: "50",
        useEventsTable: "true",
        filter: JSON.stringify([rootFilter]),
        ...query,
      };

const filterRequest = (
  profile: FilterProfile,
  query: Readonly<Record<string, string>>,
) => ({
  method: "GET" as const,
  path:
    profile === "v2"
      ? "/api/public/v2/observations"
      : "/api/public/observations",
  headers: { authorization: "[credential-slot]" },
  query: filterQuery(profile, query),
  body: null,
});

const predicateQuery = (
  profile: FilterProfile,
  filter: FilterName,
  value: string,
): Readonly<Record<string, string>> => {
  switch (filter) {
    case "traceId":
      return { traceId: value };
    case "from":
      return { fromStartTime: value };
    case "to":
      return { toStartTime: value };
    case "harness":
      return {
        filter: JSON.stringify([
          rootFilter,
          metadataFilter(projection.harness, value),
        ]),
      };
    case "branch":
      return {
        filter: JSON.stringify([
          rootFilter,
          metadataFilter(projection.branch, value),
        ]),
      };
    case "model":
      return {
        filter: JSON.stringify([
          rootFilter,
          tagsFilter(`${projection.modelTagPrefix}${value}`),
        ]),
      };
    case "session":
      return profile === "v2"
        ? { sessionId: value }
        : {
            filter: JSON.stringify([
              rootFilter,
              metadataFilter(projection.session, value),
            ]),
          };
    case "tags":
      return {
        filter: JSON.stringify([rootFilter, tagsFilter(value)]),
      };
  }
};

const predicateValues = {
  traceId: [traceId, "fedcba9876543210fedcba9876543210"],
  from: [startTime, endTime],
  to: [endTime, startTime],
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
        expectedTraceIds: disposition === "match" ? [traceId] : [],
      })),
    ),
) satisfies LangfuseFilterConformanceFixture[];

export const LANGFUSE_FILTER_CONFORMANCE_FIXTURES = freeze(
  filterConformanceFixtures,
);
