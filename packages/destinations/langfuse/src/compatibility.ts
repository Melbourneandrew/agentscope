import { createHash } from "node:crypto";

export const LANGFUSE_PROFILE_IDS = [
  "langfuse-cloud-v4",
  "langfuse-self-hosted-v4",
  "langfuse-self-hosted-v3-events-3.225.3",
] as const;

export type LangfuseProfileId = (typeof LANGFUSE_PROFILE_IDS)[number];
export type LangfuseDestinationSettings = Readonly<{
  endpoint: string;
  allowInsecureLoopback: boolean;
  profileId: LangfuseProfileId;
  compatibilityManifestId: string;
  encoding: "application/json";
}>;

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
  status: "agentscope_status",
  spanCount: "agentscope_span_count",
  modelCount: "agentscope_models_count",
  modelIndexPrefix: "agentscope_model_",
  modelFilterKeyPrefix: "agentscope_model_exact_",
  tagCount: "agentscope_tags_count",
  tagIndexPrefix: "agentscope_tag_",
  tagFilterKeyPrefix: "agentscope_tag_exact_",
  modelTagPrefix: "agentscope:model:",
  modelAttributeKeys: [
    "llm.model_name",
    "embedding.model_name",
    "reranker.model_name",
  ],
  maximumModels: 32,
  maximumTags: 32,
  maximumSpans: 256,
  maximumValueCharacters: 200,
  valueCharacterUnit: "unicode-scalar-values-in-required-nfc",
  invalidUnicode: "reject-unpaired-utf16-surrogates",
  maximumMetadataEntries: 137,
  maximumProjectionBytes: 16_384,
  projectionByteEncoding: "utf-8-without-bom",
  projectionBytePreimage:
    "ecmascript-json-stringify([ascii-key-sorted-metadata-entry-tuples,session-value,ordered-tag-values])",
  maximumWireOverlayAttributes: 276,
  normalization: "require-unicode-nfc",
  normalizationCollisions: "reject-before-transport",
  modelsSource:
    "all-governed-model-attributes-on-all-spans-first-occurrence-in-canonical-order",
  tagsSource: "all-spans-first-occurrence-in-canonical-order",
  wireTagOrder: "reserved-model-tags-then-safe-user-tags",
  missingOptionalValues: "omit",
  modelTagMaximumIncludesPrefix: true,
  indexedCountGrammar: "^(?:0|[1-9]|[12][0-9]|3[0-2])$",
  spanCountGrammar: "^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-6])$",
  indexGrammar: "^(?:0[0-9]|[12][0-9]|3[01])$",
  valueGrammar: "nonempty-nfc-utf8-without-control-characters",
  indexedValues: "exactly-count-contiguous-zero-based-two-digit-indices",
  filterKeyDerivation: "prefix-plus-sha256-of-exact-nfc-utf8-value",
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
export const LANGFUSE_CAPSULE_CONTRACT = {
  version: "1",
  marker: "agentscope_capsule_v1",
  headerName: "agentscope.capsule.header.v1",
  carrierName: "agentscope.capsule.carrier.v1",
  scopeName: "@agentscope/destination-langfuse/capsule",
  maximumGraphBytes: 131_072,
  chunkCharacters: 180,
  maximumChunksPerCarrier: 96,
  maximumCarriers: 11,
  keys: {
    marker: "agentscope_capsule_marker",
    nonce: "agentscope_capsule_nonce",
    version: "agentscope_capsule_version",
    graphBytes: "agentscope_capsule_graph_bytes",
    graphDigest: "agentscope_capsule_graph_sha256",
    carrierCount: "agentscope_capsule_carrier_count",
    chunkCount: "agentscope_capsule_chunk_count",
    carrierIndex: "agentscope_capsule_carrier_index",
    chunks: "agentscope_capsule_chunks",
  },
  nonceGrammar: "^[0-9a-f]{32}$",
  nonceSource: "node-cryptographic-random-bytes-16-reject-all-zero",
  graphDigest: "sha256-lowercase-hex",
  graphEncoding: "protocol-current-external-otlp-compatible-json-utf8",
  chunkEncoding: "unpadded-base64url-dense-fixed-width-except-final",
  selectedCarrierFailure: "malformed-response-without-fallback",
  graphByteMeasurement: "utf-8-byte-length-without-bom",
  encodedCharacterFormula: "ceil(graph-bytes*8/6)-base64-padding",
  chunkCountFormula: "ceil(encoded-characters/180)",
  carrierCountFormula: "ceil(chunk-count/96)",
  requestMeasurement:
    "utf-8-byte-length-of-final-json-request-including-canonical-spans-and-carriers",
  headerMetadata: [
    "marker",
    "nonce",
    "version",
    "graph-bytes",
    "graph-digest",
    "carrier-count",
    "chunk-count",
    "closed-summary-projection",
  ],
  carrierMetadata: [
    "nonce",
    "version",
    "graph-digest",
    "carrier-index",
    "chunks",
  ],
  transportSpan: {
    traceId: "canonical-trace-id",
    parentSpanId: "canonical-root-span-id",
    startTime: "canonical-trace-start",
    endTime: "canonical-trace-start",
    kind: "INTERNAL-1",
    status: "UNSET-0",
    flags: 0,
    droppedCounts: 0,
    events: "empty",
    links: "empty",
    scope: "dedicated-capsule-scope",
    resource: "closed-routing-and-protocol-manifest-attributes-only",
    resourceAttributeKeys: ["agentscope.protocol.manifest_id", "service.name"],
    attributes: "closed-role-metadata-only",
  },
  duplicateRows: "collapse-only-exact-closed-field-equality",
  providerSelection:
    "validate-complete-bounded-header-response-then-first-provider-order",
} as const;

export const deriveLangfuseProjectionFilterKey = (
  kind: "model" | "tag",
  value: string,
): string =>
  `${
    kind === "model"
      ? LANGFUSE_PROJECTION_CONTRACT.modelFilterKeyPrefix
      : LANGFUSE_PROJECTION_CONTRACT.tagFilterKeyPrefix
  }${createHash("sha256").update(value, "utf8").digest("hex")}`;
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
  traceId: {
    v2: "structured:string:traceId:=",
    v1: "structured:string:traceId:=",
  },
  from: {
    v2: "structured:datetime:startTime:>=",
    v1: "structured:datetime:startTime:>=",
  },
  to: {
    v2: "structured:datetime:startTime:<",
    v1: "structured:datetime:startTime:<",
  },
  harness: {
    v2: `structured:metadata:${LANGFUSE_PROJECTION_CONTRACT.harness}:=`,
    v1: `structured:metadata:${LANGFUSE_PROJECTION_CONTRACT.harness}:=`,
  },
  branch: {
    v2: `structured:metadata:${LANGFUSE_PROJECTION_CONTRACT.branch}:=`,
    v1: `structured:metadata:${LANGFUSE_PROJECTION_CONTRACT.branch}:=`,
  },
  model: {
    v2: "structured:metadata:derived-model-key:=",
    v1: "structured:metadata:derived-model-key:=",
  },
  session: {
    v2: "structured:string:sessionId:=",
    v1: `structured:metadata:${LANGFUSE_PROJECTION_CONTRACT.session}:=`,
  },
  tags: {
    v2: "structured:metadata:derived-tag-key:=",
    v1: "structured:metadata:derived-tag-key:=",
  },
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
    sha256: "9b73475561895aeb7d57f00f8722fb50f52c423a6e4cf0493a732e9ca0555f81",
  },
  {
    fixtureId: "observations-v2-root-search-v1",
    sha256: "d7eb34114f17125edb751e0e8d51892d20c14b104fe8f7d76d815ae46d40737a",
  },
  {
    fixtureId: "observations-v1-events-root-search-v1",
    sha256: "d452d4f1a8318625dbea1be0ee881e8adbbfd150bd68af7996f5267425065cca",
  },
  {
    fixtureId: "observations-v2-rate-limit-v1",
    sha256: "86e270d7a8c38106fba1b274ce756939252325c1c0953fc0c0ec5586b1ee5ea1",
  },
  {
    fixtureId: "observations-v1-events-selector-omitted-v1",
    sha256: "f656ae97c70e95950de55e8bf07fa72d6a82765dbff7fa54aa6944c1ced921fd",
  },
  {
    fixtureId: "observations-v1-events-selector-false-v1",
    sha256: "e142f4a8a8ab889315678b5197c4796101e7d09239ea415fcf984ef8c68d306c",
  },
  {
    fixtureId: "observations-v1-events-selector-mutated-v1",
    sha256: "4d0b56eb8dff73222a80b463903b6c52199839701380bad8ada31ff487fc17a6",
  },
  {
    fixtureId: "trace-delete-accepted-v1",
    sha256: "eb66acdf9a8e4e91799e6ae3b37fca58c70a37f78f016c002882c3d381419ed7",
  },
] as const;
const filterFixtureDigests = [
  {
    fixtureId: "langfuse-cloud-v4-traceId-match-v1",
    sha256: "2a6b81600cdd08d99adc02363bc8f44b0d310215e30cf15c261910696e40457b",
  },
  {
    fixtureId: "langfuse-cloud-v4-traceId-miss-v1",
    sha256: "55dfeacc771d52433ac279979ef7a84fb2a3012cac416414319ec2130c804086",
  },
  {
    fixtureId: "langfuse-cloud-v4-from-match-v1",
    sha256: "94a975414a7835a950a199c8c7c1e330b64ea8429a53932af3b29a61352954a6",
  },
  {
    fixtureId: "langfuse-cloud-v4-from-miss-v1",
    sha256: "8016807e06c5b26d45f54c3d365ee62f898e92e9fda196608e32ea1c148ed9b6",
  },
  {
    fixtureId: "langfuse-cloud-v4-to-match-v1",
    sha256: "514122694a81ae634c87982be96e9f0894a51c0547a51920a6d281eb551c4c22",
  },
  {
    fixtureId: "langfuse-cloud-v4-to-miss-v1",
    sha256: "7c53ddea93b0fb4e448ec6580145add6565dc0236e92863d8a5bdd35ea3bd4ad",
  },
  {
    fixtureId: "langfuse-cloud-v4-harness-match-v1",
    sha256: "6a4781166a6868184b523956b0104b9e9853bb023c7e27b938e34c2b8234f3b9",
  },
  {
    fixtureId: "langfuse-cloud-v4-harness-miss-v1",
    sha256: "146d1dfc90b5faf788206068fea079594356ebce426f098bff893f87fd492544",
  },
  {
    fixtureId: "langfuse-cloud-v4-branch-match-v1",
    sha256: "bca003a7f3471e4f4e795bfcf7c033e5c9f41238330d80b86f5de017434b3c5a",
  },
  {
    fixtureId: "langfuse-cloud-v4-branch-miss-v1",
    sha256: "9bd55635ce3f36ab4e0fb862d2769a70772ac24ee98f0ec6e5058b2e67ad8a63",
  },
  {
    fixtureId: "langfuse-cloud-v4-model-match-v1",
    sha256: "c5008db9771b546bd203fd6b7cc9190f908a9f9ac47d7ebc22d35038cc28eba1",
  },
  {
    fixtureId: "langfuse-cloud-v4-model-miss-v1",
    sha256: "a8cff95ac959dcd4bd50404d7ef5e787650d24e89fd9bf0bf100a62bac3dbbd4",
  },
  {
    fixtureId: "langfuse-cloud-v4-session-match-v1",
    sha256: "67cd12737b1507268758abe0f284a30f1bd26f7f7eaddc3b242dba1036568be1",
  },
  {
    fixtureId: "langfuse-cloud-v4-session-miss-v1",
    sha256: "e7bea92be842d3d958e2b424979c5eaaece741273936bee1809d4ab5b38e74dc",
  },
  {
    fixtureId: "langfuse-cloud-v4-tags-match-v1",
    sha256: "5a74871759f31fd265bd304d1f8ae79208c21487c096ccc9ac7aa8749dd62c82",
  },
  {
    fixtureId: "langfuse-cloud-v4-tags-miss-v1",
    sha256: "d579576598af031db70f86de98c52a883772a4258817ab89ca4daf09d804fef1",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-traceId-match-v1",
    sha256: "70d910465a19f87b58b96bd4667ee61d97eddfec4b970bfffc1ab036824e1721",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-traceId-miss-v1",
    sha256: "21081e2df9b4eef9845eae53367359ec4873d008ccb44065b84f807e4c11c6e8",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-from-match-v1",
    sha256: "845f55b344e293813e371763375fdfe94da5cf5766ac316a6a51253f3922771f",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-from-miss-v1",
    sha256: "89c87caf64e606ade34bc3c19c3cf0302cb77a5b5976e7d6629152a7cecb383f",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-to-match-v1",
    sha256: "a98a4e2752f4dfe88f91c54360d12897c444bed271f06f4a8797ce281e46b66c",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-to-miss-v1",
    sha256: "28cee585cff0ad4adcff179f941578561007a06b5a09477717e18ad445b8e7b4",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-harness-match-v1",
    sha256: "d10966b269326eeb02ea10a2dd9739a6091b2ed54756c9c8498e96dd8a22d26d",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-harness-miss-v1",
    sha256: "fa0e837b9a9d04f3c8a92e4ddb0218b406e29777474c02b9ecc8fa23a852505f",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-branch-match-v1",
    sha256: "f9bb31b340d84c6463173631a5db2d384c272a2136a9d3e2dbf61891bfa616fa",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-branch-miss-v1",
    sha256: "a0f09b810d2ccb4c0dbde632905c0a78b037bab0d9203eaceb1a21098a4de446",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-model-match-v1",
    sha256: "75755d18db4c64716a32ddab98bdc4cf388182f0d781bcb1ed64c7f53bff24fa",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-model-miss-v1",
    sha256: "c07a1fcd116aa1b2178f2579e637ba2e42e249c5eafb9fa4c570c327c215a2a3",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-session-match-v1",
    sha256: "2d71e0fef2cbb26d6460f841a3d390473356b98797a5c2e88dd2d5bf30817b3b",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-session-miss-v1",
    sha256: "2e5d5f3ca7e9c41f70d150d2a5c5894fcb5fd625f90de4abe6e02389d5d9dd7c",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-tags-match-v1",
    sha256: "b44e9c08854ec6d2e505cff5800ddc21d0073d54cc67c1dd35eedfaacfb98adc",
  },
  {
    fixtureId: "langfuse-self-hosted-v4-tags-miss-v1",
    sha256: "a4e977093696846e79d4e147d389e614573a7139f3684c6123688ef8865f49e0",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-traceId-match-v1",
    sha256: "9960c6fb48b7419f927bf84d997c5e2a2b7c5853a0abbb0621d2fb160b5012fe",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-traceId-miss-v1",
    sha256: "02764b53c13b73e0f160770655f326a5f8a42a75ff02e70093a521c9ebc7640e",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-from-match-v1",
    sha256: "459e843db28df5138dc5ea8da3c55fbb977b0a73fbfc1e3a5f53dc442a6c6d10",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-from-miss-v1",
    sha256: "dce3874ef2196562d1f9f5f8fb2777f2b1f2c342d82d65cd531745bbead27abc",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-to-match-v1",
    sha256: "5b90dd32f32b6359d24160bac5a2f06ee0acbf1b24694aca9254fe8f0f1f225e",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-to-miss-v1",
    sha256: "4ad70264f6841056b3a855583fc2a29917eadcdd9d1a78e447b2cda918c0cd02",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-harness-match-v1",
    sha256: "bae6ebd1dfd03b30006e8f6534848681a02d7f3c796302be534ee671eba7b41b",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-harness-miss-v1",
    sha256: "1910e3097942b5acf164c990d8d9d7546eae9ca64272809960b81ae9e8ec8572",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-branch-match-v1",
    sha256: "d008451617aca3c5ffbcb72d0bed6c9bb539ae06f9314d1bd289369fec5007c7",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-branch-miss-v1",
    sha256: "3086725a6b0afa2716c34b205a5499cd6c0b66c8991e1d6c465aff2d1a17b62a",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-model-match-v1",
    sha256: "8c92d558b51606922188448bda0dc529cca45803941f3e45c26d1a654e8b5e80",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-model-miss-v1",
    sha256: "8291b6b9c91fc63656356b2412bd616858b74eb2e55ebbd46dc2a1cccf313bc4",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-session-match-v1",
    sha256: "24d9e392ee51750b43c057e046c3fb83aacd4e943b027d30fc5b0ed268c069f0",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-session-miss-v1",
    sha256: "ceab90df61bb4a0c63f1e2785bb03d64479171d317a5afed97a49e7252ca38b9",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-tags-match-v1",
    sha256: "2fd5237da5d454d1185ff91c46d847f36672617215e82b51ebd246f4cb672c42",
  },
  {
    fixtureId: "langfuse-self-hosted-v3-events-3.225.3-tags-miss-v1",
    sha256: "a7c567784a6c1dd1412edd0c6dbc203011f67a02f7d35277c69bdb4efc445213",
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
  capsule: LANGFUSE_CAPSULE_CONTRACT,
  capsuleHeader: {
    selector: `metadata:${LANGFUSE_CAPSULE_CONTRACT.keys.marker}:=:${LANGFUSE_CAPSULE_CONTRACT.marker}`,
    cardinality: "exactly-one-per-reporter-item-revision",
    multipleRevisions: "validate-all-then-first-provider-order-per-trace",
    exactDuplicate: "collapse",
    malformedOrConflicting: "malformed-response",
    summaryProjection: "selected-capsule-header-only",
  },
  reporterReceiptProof: {
    acceptedStatus: 200,
    responseMediaType: "ascii-case-insensitive-application-json",
    responseMediaTypeParameters: "none-or-one-charset-utf-8",
    missingWrongDuplicateOrAmbiguousMediaType: "outcome-unknown",
  },
  retrieverResponseProof: {
    successStatus: "200-through-299",
    responseMediaType: "ascii-case-insensitive-application-json",
    responseMediaTypeParameters: "none-or-one-charset-utf-8",
    missingWrongDuplicateOrAmbiguousMediaType: "malformed-response",
  },
  structuredFilter: {
    queryKey: "filter",
    queryKeyCardinality: "exactly-one",
    predicateOrder: [
      "current-capsule-marker",
      "trace-id",
      "from-inclusive",
      "to-exclusive",
      "harness",
      "branch",
      "model",
      "session",
      "tags",
    ],
    propertyOrder: ["type", "column", "key-if-present", "operator", "value"],
    construction: "closed-typed-values-as-data",
    serialization: "ecmascript-json-stringify-once",
    queryEncoding: "url-search-params-percent-encode-once",
    individualPortableQueryKeys: "forbidden",
    duplicateFilterKeys: "forbidden",
    v1Selector: "one-independent-useEventsTable=true",
    maximumRequestTargetBytes: 131_072,
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
        headerGetFieldGroups: [
          "core",
          "basic",
          "time",
          "metadata",
          "trace_context",
        ],
        carrierGetFieldGroups: ["core", "basic", "time", "metadata"],
      },
    },
    {
      profileId: "langfuse-self-hosted-v4",
      server: {
        deployment: "self-hosted",
        range: "=4.15.0",
        sourceRevision: "249b25734235d6b66fa36e57adb2c6cac0f40f98",
      },
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
        headerGetFieldGroups: [
          "core",
          "basic",
          "time",
          "metadata",
          "trace_context",
        ],
        carrierGetFieldGroups: ["core", "basic", "time", "metadata"],
      },
    },
    {
      profileId: "langfuse-self-hosted-v3-events-3.225.3",
      server: {
        deployment: "self-hosted",
        range: "=3.225.3",
        sourceRevision: "f6c77b70842bd84e3f22d820471345819cd9a1b4",
      },
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
    retryHeaderGrammar: "decimal-seconds-0-through-3600",
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
    {
      caseId: "present-true",
      value: "true",
      conforms: true,
      fixtureId: "observations-v1-events-root-search-v1",
    },
    {
      caseId: "omitted",
      value: null,
      conforms: false,
      fixtureId: "observations-v1-events-selector-omitted-v1",
    },
    {
      caseId: "false",
      value: "false",
      conforms: false,
      fixtureId: "observations-v1-events-selector-false-v1",
    },
    {
      caseId: "mutated",
      value: "1",
      conforms: false,
      fixtureId: "observations-v1-events-selector-mutated-v1",
    },
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
      fixtures: [
        "observations-v1-events-root-search-v1",
        "observations-v1-events-selector-omitted-v1",
        "observations-v1-events-selector-false-v1",
        "observations-v1-events-selector-mutated-v1",
      ],
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
