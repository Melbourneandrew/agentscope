import { createHash } from "node:crypto";

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

const freeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";
const startTime = "2026-01-02T03:04:05.000Z";
const endTime = "2026-01-02T03:04:06.000Z";

const projection = {
  root: "agentscope_root",
  session: "agentscope_session",
  harness: "agentscope_harness",
  branch: "agentscope_branch",
  repository: "agentscope_repository",
  spanCount: "agentscope_span_count",
  modelCount: "agentscope_models_count",
  modelIndexPrefix: "agentscope_model_",
  tagCount: "agentscope_tags_count",
  tagIndexPrefix: "agentscope_tag_",
  modelTagPrefix: "agentscope:model:",
  maximumModels: 32,
  maximumTags: 32,
  maximumValueCharacters: 200,
} as const;

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
                    attributes: Object.entries(rootMetadata).map(
                      ([key, value]) => ({
                        key,
                        value: { stringValue: value },
                      }),
                    ),
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
        filter: JSON.stringify([
          {
            type: "stringObject",
            column: "metadata",
            key: projection.root,
            operator: "=",
            value: "true",
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

const profileSources = {
  langfuseOpenApi: {
    kind: "official-source",
    repository: "https://github.com/langfuse/langfuse",
    revision: "249b25734235d6b66fa36e57adb2c6cac0f40f98",
    path: "web/public/generated/api/openapi.yml",
    sha256: "9ba51a22782a481ee2bf57513541a2bc3df1388e8d2c5c5a081f3a8e7e08366d",
  },
  langfuseV3Observations: {
    kind: "official-source",
    repository: "https://github.com/langfuse/langfuse",
    revision: "f6c77b70842bd84e3f22d820471345819cd9a1b4",
    tag: "v3.225.3",
    paths: [
      "web/src/features/public-api/types/observations.ts",
      "web/src/pages/api/public/observations/index.ts",
      "packages/shared/src/eventsTable.ts",
      "packages/shared/src/server/repositories/events.ts",
    ],
  },
  langfuseJavascriptAttributes: {
    kind: "official-source",
    repository: "https://github.com/langfuse/langfuse-js",
    revision: "a7c9634286f5d6810dddf60bb94181c011a6f5b3",
    path: "packages/core/src/constants.ts",
    sha256: "96233c37efdd82beb4f65fd088d93b7f23e7d67fdfe01eaff2be7a4691e60724",
  },
  langfusePythonAttributes: {
    kind: "official-source",
    repository: "https://github.com/langfuse/langfuse-python",
    revision: "3b1357c2206dae90d0a2bcdc65b1bcf768c29543",
    path: "langfuse/_client/attributes.py",
    sha256: "e7016e216e1aac43dde20cdceeabe4a66ee88056bebfcc8b49ca1b07708e6376",
  },
  officialDocumentation: {
    kind: "official-documentation",
    repository: "https://github.com/langfuse/langfuse-docs",
    revision: "b235e0dee03a8c6abcfd631c9c1341d232cbfa02",
    urls: [
      "https://langfuse.com/integrations/native/opentelemetry",
      "https://langfuse.com/docs/api-and-data-platform/features/observations-api",
      "https://langfuse.com/docs/api-and-data-platform/features/public-api",
      "https://langfuse.com/self-hosting/upgrade/versioning",
    ],
  },
} as const;

const portableFilters = {
  traceId: { v2: "traceId", v1: "traceId" },
  from: { v2: "fromStartTime:inclusive", v1: "fromStartTime:inclusive" },
  to: { v2: "toStartTime:exclusive", v1: "toStartTime:exclusive" },
  harness: {
    v2: `metadata:${projection.harness}:=`,
    v1: `metadata:${projection.harness}:=`,
  },
  branch: {
    v2: `metadata:${projection.branch}:=`,
    v1: `metadata:${projection.branch}:=`,
  },
  model: {
    v2: `traceTags:all of:${projection.modelTagPrefix}`,
    v1: `traceTags:all of:${projection.modelTagPrefix}`,
  },
  session: { v2: "sessionId", v1: `metadata:${projection.session}:=` },
  tags: { v2: "traceTags:all of", v1: "traceTags:all of" },
} as const;

const portableFilterConformance = [
  {
    profile: "v2",
    filter: "traceId",
    request: {
      query: "traceId",
      positive: traceId,
      negative: "fedcba9876543210fedcba9876543210",
    },
  },
  {
    profile: "v2",
    filter: "from",
    request: { query: "fromStartTime", positive: startTime, negative: endTime },
  },
  {
    profile: "v2",
    filter: "to",
    request: { query: "toStartTime", positive: endTime, negative: startTime },
  },
  {
    profile: "v2",
    filter: "harness",
    request: {
      metadata: projection.harness,
      positive: "codex",
      negative: "claude-code",
    },
  },
  {
    profile: "v2",
    filter: "branch",
    request: {
      metadata: projection.branch,
      positive: "main",
      negative: "release",
    },
  },
  {
    profile: "v2",
    filter: "model",
    request: {
      traceTags: "all of",
      positive: `${projection.modelTagPrefix}gpt-5`,
      negative: `${projection.modelTagPrefix}different-model`,
    },
  },
  {
    profile: "v2",
    filter: "session",
    request: {
      query: "sessionId",
      positive: "session-fixture",
      negative: "session-miss",
    },
  },
  {
    profile: "v2",
    filter: "tags",
    request: { traceTags: "all of", positive: "fixture", negative: "tag-miss" },
  },
  {
    profile: "v1-events",
    filter: "traceId",
    request: {
      query: "traceId",
      positive: traceId,
      negative: "fedcba9876543210fedcba9876543210",
    },
  },
  {
    profile: "v1-events",
    filter: "from",
    request: { query: "fromStartTime", positive: startTime, negative: endTime },
  },
  {
    profile: "v1-events",
    filter: "to",
    request: { query: "toStartTime", positive: endTime, negative: startTime },
  },
  {
    profile: "v1-events",
    filter: "harness",
    request: {
      metadata: projection.harness,
      positive: "codex",
      negative: "claude-code",
    },
  },
  {
    profile: "v1-events",
    filter: "branch",
    request: {
      metadata: projection.branch,
      positive: "main",
      negative: "release",
    },
  },
  {
    profile: "v1-events",
    filter: "model",
    request: {
      traceTags: "all of",
      positive: `${projection.modelTagPrefix}gpt-5`,
      negative: `${projection.modelTagPrefix}different-model`,
    },
  },
  {
    profile: "v1-events",
    filter: "session",
    request: {
      metadata: projection.session,
      positive: "session-fixture",
      negative: "session-miss",
    },
  },
  {
    profile: "v1-events",
    filter: "tags",
    request: { traceTags: "all of", positive: "fixture", negative: "tag-miss" },
  },
] as const;

const manifestSource = {
  contractVersion: 1,
  status: "provisional-contract-only",
  liveValidationTask: "agentscope-vah.12.6",
  authority: {
    selection: "configuration-commit-only",
    configurationIdentityIncludes: ["profile-id", "manifest-id"],
    doctor: "observational-only",
    profileChange: "new-configuration-generation-invalidates-cursors",
    retrievalCapability:
      "withheld-unless-profile-and-complete-portable-filter-conformance",
    incompatiblePortableFilter: "retrieval-capability-withheld",
  },
  sources: profileSources,
  projection,
  rootObservation: {
    selector: `metadata:${projection.root}:=:true`,
    cardinality: "exactly-one-per-trace",
    missing: "malformed-response",
    duplicate: "malformed-response",
    summaryProjection: "root-observation-only",
  },
  portableFilters,
  portableFilterConformance,
  profiles: [
    {
      profileId: "langfuse-cloud-v4",
      server: { deployment: "cloud", range: "current-public-api" },
      reporter: {
        path: "/api/public/otel/v1/traces",
        encodings: ["application/json", "application/x-protobuf"],
        authentication: "basic-public-key-secret-key",
        headers: { "x-langfuse-ingestion-version": "4" },
      },
      retriever: {
        path: "/api/public/v2/observations",
        pagination: "cursor",
        defaultLimit: 50,
        maximumLimit: 1000,
        ordering: "start-time-desc-hash32-trace-id-desc-span-id-desc",
        consistency: "best-effort",
        summaryFieldGroups: [
          "core",
          "basic",
          "time",
          "metadata",
          "trace_context",
        ],
        getFieldGroups: [
          "core",
          "basic",
          "time",
          "io",
          "metadata",
          "model",
          "usage",
          "prompt",
          "metrics",
          "trace_context",
        ],
      },
    },
    {
      profileId: "langfuse-self-hosted-v4",
      server: { deployment: "self-hosted", range: ">=4.0.0 <5.0.0" },
      reporter: {
        path: "/api/public/otel/v1/traces",
        encodings: ["application/json", "application/x-protobuf"],
        authentication: "basic-public-key-secret-key",
        headers: { "x-langfuse-ingestion-version": "4" },
      },
      retriever: {
        path: "/api/public/v2/observations",
        pagination: "cursor",
        defaultLimit: 50,
        maximumLimit: 1000,
        ordering: "start-time-desc-hash32-trace-id-desc-span-id-desc",
        consistency: "best-effort",
        summaryFieldGroups: [
          "core",
          "basic",
          "time",
          "metadata",
          "trace_context",
        ],
        getFieldGroups: [
          "core",
          "basic",
          "time",
          "io",
          "metadata",
          "model",
          "usage",
          "prompt",
          "metrics",
          "trace_context",
        ],
      },
    },
    {
      profileId: "langfuse-self-hosted-v3-events-3.225.3",
      server: { deployment: "self-hosted", range: "=3.225.3" },
      reporter: {
        path: "/api/public/otel/v1/traces",
        encodings: ["application/json", "application/x-protobuf"],
        authentication: "basic-public-key-secret-key",
        headers: {},
      },
      retriever: {
        path: "/api/public/observations",
        mandatoryQuery: { useEventsTable: "true" },
        pagination: "page-offset",
        defaultLimit: 50,
        maximumLimit: 100,
        ordering: "start-time-desc-hash32-trace-id-desc-span-id-desc",
        consistency: "best-effort",
        responseTags: "omitted-use-reserved-metadata-mirror",
      },
    },
  ],
  rateLimit: {
    status: 429,
    retryHeader: "retry-after",
    result: "rate-limited",
    providerBody: "discarded",
  },
  cleanup: {
    method: "DELETE",
    pathTemplate: "/api/public/traces/{traceId}",
    completion: "asynchronous-poll-required",
    immediateCompletionClaimed: false,
  },
  v1SelectorConformance: [
    { caseId: "present-true", value: "true", conforms: true },
    { caseId: "omitted", value: null, conforms: false },
    { caseId: "false", value: "false", conforms: false },
    { caseId: "mutated", value: "1", conforms: false },
  ],
  fixtureDigests: fixtures.map((fixture) => ({
    fixtureId: fixture.fixtureId,
    sha256: sha256(fixture),
  })),
  evidence: [
    {
      claimId: "otlp-http-contract",
      disposition: "provisional-official",
      sources: ["langfuseOpenApi", "officialDocumentation"],
      fixtures: ["otlp-v4-json-root-v1"],
    },
    {
      claimId: "observations-v2-contract",
      disposition: "provisional-official",
      sources: ["langfuseOpenApi", "officialDocumentation"],
      fixtures: [
        "observations-v2-root-search-v1",
        "observations-v2-rate-limit-v1",
      ],
    },
    {
      claimId: "observations-v1-events-contract",
      disposition: "provisional-official",
      sources: ["langfuseV3Observations"],
      fixtures: ["observations-v1-events-root-search-v1"],
    },
    {
      claimId: "trace-cleanup-contract",
      disposition: "provisional-official",
      sources: ["langfuseOpenApi", "officialDocumentation"],
      fixtures: ["trace-delete-accepted-v1"],
    },
    {
      claimId: "otlp-to-observation-projection",
      disposition: "live-validation-required",
      task: "agentscope-vah.12.6",
      fixtures: ["otlp-v4-json-root-v1", "observations-v2-root-search-v1"],
    },
    {
      claimId: "visibility-latency",
      disposition: "live-validation-required",
      task: "agentscope-vah.12.6",
      fixtures: ["otlp-v4-json-root-v1"],
    },
    {
      claimId: "filter-round-trip",
      disposition: "live-validation-required",
      task: "agentscope-vah.12.6",
      fixtures: [
        "observations-v2-root-search-v1",
        "observations-v1-events-root-search-v1",
      ],
    },
    {
      claimId: "asynchronous-cleanup-completion",
      disposition: "live-validation-required",
      task: "agentscope-vah.12.6",
      fixtures: ["trace-delete-accepted-v1"],
    },
  ],
} as const;

export const LANGFUSE_COMPATIBILITY_MANIFEST = freeze({
  manifestId: `sha256:${sha256(manifestSource)}`,
  ...manifestSource,
});
