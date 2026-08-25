import canonicalFixture from "../testing/fixtures/sanitized-canonical-trace.json" with { type: "json" };
import historicalV1Fixture from "../testing/fixtures/history/sanitized-canonical-trace-v1.json" with { type: "json" };
import {
  HISTORICAL_V1_SOURCE_SCHEMA_DESCRIPTOR,
  PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR,
} from "../codecs/persisted-source.js";
import { standardsManifest } from "../standards/manifest.js";
import historicalV1Manifest from "../standards/history/manifest-v1.json" with { type: "json" };
import { deepFreeze } from "./immutable.js";
import { replaceCurrentManifestToken } from "./compatibility-profile-compiler.js";

export const CURRENT_COMPATIBILITY_SOURCE_ARTIFACTS = deepFreeze({
  sourceSchemaDescriptor: PERSISTED_ENVELOPE_SOURCE_SCHEMA_DESCRIPTOR,
  sourceFixture: {
    envelopeVersion: 1,
    protocolManifestId: "$current",
    delivery: {
      identity: "ab".repeat(32),
      stability: "session-stable",
    },
    graph: replaceCurrentManifestToken(
      canonicalFixture,
      standardsManifest.manifestId,
      "$current",
    ),
  },
});

export const COMPATIBILITY_EXTENSION_ARCHIVE = deepFreeze([
  {
    selector: {
      kind: "manifest" as const,
      manifestId: historicalV1Manifest.manifestId,
    },
    registryFingerprint:
      historicalV1Manifest.agentscopeExtensions.registryFingerprint,
    entries: historicalV1Manifest.agentscopeExtensions.entries,
    sourceSchemaDescriptor: HISTORICAL_V1_SOURCE_SCHEMA_DESCRIPTOR,
    sourceFixture: {
      envelopeVersion: 1,
      protocolManifestId: historicalV1Manifest.manifestId,
      delivery: {
        identity: "ab".repeat(32),
        stability: "session-stable",
      },
      graph: historicalV1Fixture,
    },
  },
  {
    selector: { kind: "current" as const },
    registryFingerprint:
      standardsManifest.agentscopeExtensions.registryFingerprint,
    entries: standardsManifest.agentscopeExtensions.entries,
    ...CURRENT_COMPATIBILITY_SOURCE_ARTIFACTS,
  },
]);
