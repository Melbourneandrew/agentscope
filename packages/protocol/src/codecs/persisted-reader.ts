import { SUPPORTED_PROTOCOL_GENERATIONS } from "../schema/compatibility-profile.js";
import { deepFreeze } from "../schema/immutable.js";
import {
  readPersistedEnvelopeAgainstSupport,
  type PersistedCanonicalEnvelope,
  type PersistedEnvelopeReadResult,
} from "./persisted-source.js";

export type { PersistedCanonicalEnvelope, PersistedEnvelopeReadResult };

export const SUPPORTED_PERSISTED_MANIFEST_IDS = deepFreeze(
  SUPPORTED_PROTOCOL_GENERATIONS.map(({ manifestId }) => manifestId),
);

export const readPersistedCanonicalEnvelope = (
  input: unknown,
): PersistedEnvelopeReadResult =>
  readPersistedEnvelopeAgainstSupport(input, SUPPORTED_PROTOCOL_GENERATIONS);
