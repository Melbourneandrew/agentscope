import { createHash } from "node:crypto";

const freeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const LANGFUSE_PROJECTION_CONTRACT = {
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
  maximumSpans: 256,
  maximumValueCharacters: 200,
  maximumMetadataEntries: 72,
  maximumProjectionBytes: 16_384,
  maximumWireOverlayAttributes: 146,
  indexedCountGrammar: "^(?:0|[1-9]|[12][0-9]|3[0-2])$",
  spanCountGrammar: "^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-6])$",
  indexGrammar: "^(?:0[0-9]|[12][0-9]|3[01])$",
  valueGrammar: "nonempty-nfc-utf8-without-control-characters",
  indexedValues: "exactly-count-contiguous-zero-based-two-digit-indices",
  reservedOwnership: "agentscope-exact-keys-and-index-prefixes",
  collisions: "reject-before-transport",
  truncation: "forbidden",
  malformedResponse:
    "missing-extra-duplicate-noncanonical-or-over-limit-mirror",
  wire: {
    observationMetadataPrefix: "langfuse.observation.metadata.",
    traceMetadataPrefix: "langfuse.trace.metadata.",
    sessionAttribute: "session.id",
    traceTagsAttribute: "langfuse.trace.tags",
  },
} as const;
const profileSources = {
  langfuseOpenApi: {
    kind: "official-source",
    repository: "https://github.com/langfuse/langfuse",
    revision: "249b25734235d6b66fa36e57adb2c6cac0f40f98",
    path: "web/public/generated/api/openapi.yml",
    sha256: "9ba51a22782a481ee2bf57513541a2bc3df1388e8d2c5c5a081f3a8e7e08366d",
  },
  langfuseV4ObservationTraversal: {
    kind: "official-source",
    repository: "https://github.com/langfuse/langfuse",
    revision: "249b25734235d6b66fa36e57adb2c6cac0f40f98",
    paths: [
      {
        path: "web/src/features/public-api/types/observations.ts",
        sha256:
          "a07fdbdbf2763135309205ac129fb7ce81788650caa95f6b1fee0a3e62b18e8a",
      },
      {
        path: "packages/shared/src/server/repositories/events.ts",
        sha256:
          "ad9925d263d755b142b0800091570c7a6fd2cdff0bb2bdf4a8e7bf2ce76ec32a",
      },
    ],
  },
  langfuseOtelMetadataProjection: {
    kind: "official-source",
    repository: "https://github.com/langfuse/langfuse",
    revision: "249b25734235d6b66fa36e57adb2c6cac0f40f98",
    paths: [
      {
        path: "packages/shared/src/server/otel/OtelIngestionProcessor.ts",
        sha256:
          "48387fa64242f94504e657edaa1f0c5c7ef8c2cec045ead85468cd4f6b3cdf5f",
      },
      {
        path: "packages/shared/src/server/otel/OtelIngestionProcessor.metadataDropped.test.ts",
        sha256:
          "771573718360a69196b82e7266c13dd5a8c0d0fa1d1fcb54340cff008b326e29",
      },
    ],
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
} as const;

const portableFilters = {
  traceId: { v2: "traceId", v1: "traceId" },
  from: { v2: "fromStartTime:inclusive", v1: "fromStartTime:inclusive" },
  to: { v2: "toStartTime:exclusive", v1: "toStartTime:exclusive" },
  harness: {
    v2: `metadata:${LANGFUSE_PROJECTION_CONTRACT.harness}:=`,
    v1: `metadata:${LANGFUSE_PROJECTION_CONTRACT.harness}:=`,
  },
  branch: {
    v2: `metadata:${LANGFUSE_PROJECTION_CONTRACT.branch}:=`,
    v1: `metadata:${LANGFUSE_PROJECTION_CONTRACT.branch}:=`,
  },
  model: {
    v2: `traceTags:all of:${LANGFUSE_PROJECTION_CONTRACT.modelTagPrefix}`,
    v1: `traceTags:all of:${LANGFUSE_PROJECTION_CONTRACT.modelTagPrefix}`,
  },
  session: {
    v2: "sessionId",
    v1: `metadata:${LANGFUSE_PROJECTION_CONTRACT.session}:=`,
  },
  tags: { v2: "traceTags:all of", v1: "traceTags:all of" },
} as const;

const filterNames = [
  "traceId",
  "from",
  "to",
  "harness",
  "branch",
  "model",
  "session",
  "tags",
] as const;
const filterProfiles = [
  { profile: "v2", profileId: "langfuse-cloud-v4" },
  { profile: "v2", profileId: "langfuse-self-hosted-v4" },
  { profile: "v1-events", profileId: "langfuse-self-hosted-v3-events-3.225.3" },
] as const;
const portableFilterConformance = filterProfiles.flatMap(
  ({ profile, profileId }) =>
    filterNames.flatMap((filter) =>
      (["match", "miss"] as const).map((disposition) => ({
        fixtureId: `${profileId}-${filter}-${disposition}-v1`,
        profileId,
        profile,
        filter,
        disposition,
      })),
    ),
);
const fixtureDigests = [
  {
    fixtureId: "otlp-v4-json-root-v1",
    sha256: "6a1f1ec1af509f2afbed2ecdb35f4d240a2327aebe237a1c4c3ddc49cf3a1c32",
  },
  {
    fixtureId: "observations-v2-root-search-v1",
    sha256: "ac2c8ee9f8a443082645fa2cb381d474ba74d42c93d5efd2d2017c8ebd8a97b0",
  },
  {
    fixtureId: "observations-v1-events-root-search-v1",
    sha256: "2ed8b63d19beb60b9a323384d310520cd42212f8c8580d5968f8c60ff5866331",
  },
  {
    fixtureId: "observations-v2-rate-limit-v1",
    sha256: "86e270d7a8c38106fba1b274ce756939252325c1c0953fc0c0ec5586b1ee5ea1",
  },
  {
    fixtureId: "trace-delete-accepted-v1",
    sha256: "eb66acdf9a8e4e91799e6ae3b37fca58c70a37f78f016c002882c3d381419ed7",
  },
] as const;
const filterFixtureDigests = [
  {
    fixtureId: "langfuse-cloud-v4-traceId-match-v1",
    sha256: "9a127bba27fe3d1bdcdadb92ff6b851afadef15b5a59e73204f69e19596a9556",
  },
  {
    fixtureId: "langfuse-cloud-v4-traceId-miss-v1",
    sha256: "b7b36a13e68c1e121904b5c4b05d3ff88357bcd10f88390da2ccc31e9caf97c8",
  },
  {
    fixtureId: "langfuse-cloud-v4-from-match-v1",
    sha256: "29a56ac16c99c23ba088dd82af3ce16a3a5c44f5244e2b5e6e0b0e5a53f79cb5",
  },
  {
    fixtureId: "langfuse-cloud-v4-from-miss-v1",
    sha256: "a6dcdb17a9cf272fa041ca0e111d78021ba2a1f5460f2c241d54ae93a049bad7",
  },
  {
    fixtureId: "langfuse-cloud-v4-to-match-v1",
    sha256: "cab5a1be2bf615b18c4853baf21bc670d1dfee6aace3f93e02bf1db0a32866bd",
  },
  {
    fixtureId: "langfuse-cloud-v4-to-miss-v1",
    sha256: "add9c733b35d706a12e32c2869a441ae9d6aa16ea6d60d3f5ad6c91362201a74",
  },
  {
    fixtureId: "langfuse-cloud-v4-harness-match-v1",
    sha256: "fcfeedd24edccfcec67f159a626fd52d98e8d46cac71e6c724e88c7983ad9a4a",
  },
  {
    fixtureId: "langfuse-cloud-v4-harness-miss-v1",
    sha256: "d1d263037b8a3cc81a134613deace5934cbb735425f643ad499223319de71505",
  },
  {
    fixtureId: "langfuse-cloud-v4-branch-match-v1",
    sha256: "59341e6924514d768cf74c6278bd9f7fb0fe8d6d7d3659f7724c1fdbc09e1273",
  },
  {
    fixtureId: "langfuse-cloud-v4-branch-miss-v1",
    sha256: "c1b623c0491b57d091a5ceda1de496ecb8e51ddc2050b35fd90338defcae1468",
  },
  {
    fixtureId: "langfuse-cloud-v4-model-match-v1",
    sha256: "5439bee9aef9b0cf8fd1c8eed2c29119bacde85521492dcda679ef813f08f762",
  },
  {
    fixtureId: "langfuse-cloud-v4-model-miss-v1",
    sha256: "9fe736b0830f6510e26b399c7b1434a5c054c92e4d0eb5746af33e2a6ac01ddd",
  },
  {
    fixtureId: "langfuse-cloud-v4-session-match-v1",
    sha256: "9576c4d2fcdcc27fee89ce85c9007f65874c97a6b3342ef9c4b1f53a278f510f",
  },
  {
    fixtureId: "langfuse-cloud-v4-session-miss-v1",
    sha256: "6de3ccdf41857ac5d69cf594faf9cd58c02d0223ebb2734f9160763d996de85e",
  },
  {
    fixtureId: "langfuse-cloud-v4-tags-match-v1",
    sha256: "f7e1a618609620f61c2ac34845ee8ea6910aef9de57487b23cde0edf279a2b40",
  },
  {
    fixtureId: "langfuse-cloud-v4-tags-miss-v1",
    sha256: "ed9a73f28f92e108f52bed7a16b6e49fee7f933eca21ee1cf898154730b481e8",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-traceId-match-v1",
    sha256: "54bd92d2b21942138285f9a5d0ae938bae5c286ec738ed55bbbc3375abf504a6",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-traceId-miss-v1",
    sha256: "525aef1adec46ec291513c4734b003e8f97a96d9acde81034eb7f3585fdba9f4",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-from-match-v1",
    sha256: "c870d2ff0357b7b6726397c02a848d8d78a2953902bc828edb0974bc7971e8f4",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-from-miss-v1",
    sha256: "0882402899cd5d2ce0fa5151b50cb8cfa86886ce550ea6b544229dee964f065f",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-to-match-v1",
    sha256: "150fa26965cf51983c5fa50b8a4e6d2fc1357a3f4d660996025036e208adbc3f",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-to-miss-v1",
    sha256: "e79ba7447ae7ff221795618e696e7da93f7927b833895e8d0b75915edb4a0d12",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-harness-match-v1",
    sha256: "c37319907578053d1d6beab2b003bc98b60129fe51b6fdefc604f121c2adb42a",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-harness-miss-v1",
    sha256: "3184317da5634f67e5ef4a0da917b1b00bed675afd174ae0ea399caa8bb103d8",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-branch-match-v1",
    sha256: "758fa09b6ccc294f796a769f4c0d4daccc3051fd8eea84d6d82c07849e95a449",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-branch-miss-v1",
    sha256: "1c583d75513c946b45a9c94d6baf1b070d2bf5813d83a25b673bb52bda85f5b5",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-model-match-v1",
    sha256: "216856b1eb30c1852307f558eead01600168e12fc2ff2473af7b9b15a3346cde",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-model-miss-v1",
    sha256: "e2965ba20bca108bacfe2bc7518a36eacb104f940c328f7b9ee8e72e53acfc50",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-session-match-v1",
    sha256: "d9b1e7420ed793ad473bf6f8b55232965e937cb14f938af4a0945270d3e4d874",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-session-miss-v1",
    sha256: "f05d8de5ec37524545b8b3676c5d2d302d41f8a3756a937de3263403863636c2",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-tags-match-v1",
    sha256: "cd5a90ad0014b5a9a377a2694cef1fb682f69b9083b77812ae79d31d8d3ae151",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-tags-miss-v1",
    sha256: "9a221fb4a430a7fed102b69c6d81282179d0d30fa3e4f5ee2df5badf38418f71",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-traceId-match-v1",
    sha256: "cb2d7d4d3af410f910e9e59648507d90260ec6f5f660ca047cd222a82685f077",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-traceId-miss-v1",
    sha256: "7d8cca489a01dccba25256f85522a311951106f6c9474168d68cb403af1cd5a2",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-from-match-v1",
    sha256: "eca1f0e29e1b9de13cefe4483bbb14236d751f5ead9511111ec93b6fcb7236ab",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-from-miss-v1",
    sha256: "6f66a29008862c7360bba87c62771ac3073cf42e8dae79e06ebfea780253ea74",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-to-match-v1",
    sha256: "faaddd1ef15aa21ec574a3111600a70897067658e3bde13d059d563011cae469",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-to-miss-v1",
    sha256: "be42f0cad21c9856d1ae22ba837a2597fcc72024a60dae944c544b2e1c177054",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-harness-match-v1",
    sha256: "0c1c5f31785fedeb3a462eb18fa407f637d1073577e7eff39a24b78385efc461",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-harness-miss-v1",
    sha256: "4ce8fb7927a00094a25a973ea51d762c6ae4c82110c6a8ce10e86e6751827ea7",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-branch-match-v1",
    sha256: "1275a4f6c80218040122204106f881bdff66ec597e902e2511b39cb2530c1db5",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-branch-miss-v1",
    sha256: "8866b31bb1516e76e8590f2243756489a9383f39b2370680de8c62691b4400f0",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-model-match-v1",
    sha256: "9f488f760b39b092d5fc4c06950e5a24489d3250975dc9796d18ceaae972e1ad",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-model-miss-v1",
    sha256: "e525bd4c7b54c7b35bdbc7af6c4cfab1e34ea8174e8713595b9cdc0ecbd2b9bd",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-session-match-v1",
    sha256: "af46981164c4733c2b499cb77dd8792812e5d146a74300dbf134c9e65ccb4ce6",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-session-miss-v1",
    sha256: "162a42f52a60e58a984764405563e31b0d018842b0bcf2ed16adab9ced1f9491",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-tags-match-v1",
    sha256: "a67362a291fa26cb5878fbf1757796ecc886c2f6d6a5318769b7ccb346432a24",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-tags-miss-v1",
    sha256: "7881aecdea5ca3d8af90c937d8ae0647029c49f420d562342501b2c5dd7395e8",
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
  projection: LANGFUSE_PROJECTION_CONTRACT,
  rootObservation: {
    selector: `metadata:${LANGFUSE_PROJECTION_CONTRACT.root}:=:true`,
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
        maximumResponseBytes: 1_048_576,
        maximumResponseRows: 1000,
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
        maximumResponseBytes: 1_048_576,
        maximumResponseRows: 1000,
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
        maximumResponseBytes: 1_048_576,
        maximumResponseRows: 100,
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
  fixtureDigests,
  filterFixtureDigests,
  evidence: [
    {
      claimId: "otlp-http-contract",
      disposition: "provisional-official",
      sources: [
        "langfuseOpenApi",
        "langfuseJavascriptAttributes",
        "langfusePythonAttributes",
        "langfuseOtelMetadataProjection",
      ],
      fixtures: ["otlp-v4-json-root-v1"],
    },
    {
      claimId: "observations-v2-contract",
      disposition: "provisional-official",
      sources: ["langfuseOpenApi", "langfuseV4ObservationTraversal"],
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
      claimId: "portable-filter-request-contract",
      disposition: "provisional-official",
      sources: ["langfuseOpenApi", "langfuseV3Observations"],
      filterFixtures: portableFilterConformance.map(
        ({ fixtureId }) => fixtureId,
      ),
    },
    {
      claimId: "trace-cleanup-contract",
      disposition: "provisional-official",
      sources: ["langfuseOpenApi"],
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
      filterFixtures: portableFilterConformance.map(
        ({ fixtureId }) => fixtureId,
      ),
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
