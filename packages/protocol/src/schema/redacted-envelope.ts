import type { CanonicalTraceGraph } from "./canonical-graph.js";
import type { DeliveryIdentity, IdentityStability } from "./identity.js";
import { redactedCanonicalTraceRegistry } from "./redacted-registry.js";
import { serializeCanonicalJsonData } from "../codecs/json-serialize.js";

declare const redactedCanonicalTraceBrand: unique symbol;

export type CanonicalTraceEnvelope = Readonly<{
  envelopeVersion: 1;
  protocolManifestId: string;
  delivery: Readonly<{
    identity: DeliveryIdentity;
    stability: IdentityStability;
  }>;
  graph: CanonicalTraceGraph;
}>;

export type RedactedCanonicalTrace = CanonicalTraceEnvelope & {
  readonly [redactedCanonicalTraceBrand]: true;
};

const invalid = () => new Error("protocol.redacted-trace.invalid");
/** Internal verification seam; intentionally absent from package exports. */
export const serializeJsonDataForTesting = (value: unknown) => {
  try {
    return serializeCanonicalJsonData(value);
  } catch {
    throw invalid();
  }
};

export const isRedactedCanonicalTrace = (
  value: unknown,
): value is RedactedCanonicalTrace =>
  typeof value === "object" &&
  value !== null &&
  redactedCanonicalTraceRegistry.has(value);

export const serializeRedactedCanonicalTrace = (
  value: RedactedCanonicalTrace,
): string => {
  try {
    if (!isRedactedCanonicalTrace(value)) throw invalid();
    return serializeCanonicalJsonData(value);
  } catch {
    throw invalid();
  }
};
