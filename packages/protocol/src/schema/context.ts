import { z } from "zod";

import { deepFreeze } from "./immutable.js";
import {
  NATIVE_STATES,
  PROVENANCE_SOURCES,
  TIMING_BASES,
  timingProfile,
} from "./timing-profile.js";

export {
  NATIVE_STATES,
  PROVENANCE_SOURCES,
  TIMING_BASES,
} from "./timing-profile.js";

const MAXIMUM_LEDGER_ENTRIES = 192;
const MAXIMUM_LEDGER_JSON_CODE_UNITS = 16_384;
const MAXIMUM_GOVERNED_FIELD_CODE_UNITS = 1_024;
const DETACHED_HEAD_FIELD = "vcs.ref.head.name";
const DETACHED_HEAD_REASON = "detached-head";

export const ProvenanceSourceSchema = z.enum(PROVENANCE_SOURCES);

export const TimingBasisSchema = z.enum(TIMING_BASES);

const governedFieldSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_GOVERNED_FIELD_CODE_UNITS);
export const ProvenanceValueSchema = z
  .object({
    source: ProvenanceSourceSchema,
    timingBasis: TimingBasisSchema.optional(),
    nativeState: z.enum(NATIVE_STATES).optional(),
  })
  .strict();

const uniqueFields = <T extends { field: string }>(
  values: readonly T[],
  context: z.RefinementCtx,
) => {
  const seen = new Set<string>();
  values.forEach(({ field }, index) => {
    if (seen.has(field)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate provenance field: ${field}`,
        path: [index, "field"],
      });
    }
    seen.add(field);
  });
};

export const FieldProvenanceSchema = z
  .array(
    z
      .object({ field: governedFieldSchema, ...ProvenanceValueSchema.shape })
      .strict(),
  )
  .min(1)
  .max(MAXIMUM_LEDGER_ENTRIES)
  .superRefine(uniqueFields);

export const UNAVAILABLE_STATES = deepFreeze([
  "unavailable",
  "not-applicable",
  "redacted",
  "observed-empty",
] as const);
const unavailableStateSchema = z.enum(UNAVAILABLE_STATES);
export const UNAVAILABLE_REASONS = deepFreeze([
  "not-emitted",
  "resolution-failed",
  "unsupported",
  "not-applicable",
  "policy-redacted",
  "empty-native-value",
  "detached-head",
] as const);
const unavailableReasonSchema = z.enum(UNAVAILABLE_REASONS);
export const REASONS_BY_UNAVAILABLE_STATE = deepFreeze({
  unavailable: ["not-emitted", "resolution-failed", "unsupported"],
  "not-applicable": ["not-applicable", "detached-head"],
  redacted: ["policy-redacted"],
  "observed-empty": ["empty-native-value"],
} as const);
const reasonsByState = Object.fromEntries(
  Object.entries(REASONS_BY_UNAVAILABLE_STATE).map(([state, reasons]) => [
    state,
    new Set(reasons),
  ]),
) as unknown as Record<
  (typeof UNAVAILABLE_STATES)[number],
  ReadonlySet<string>
>;

export const CONTEXT_PROFILE_IDENTITY = deepFreeze({
  provenanceSources: PROVENANCE_SOURCES,
  timingBases: TIMING_BASES,
  nativeStates: NATIVE_STATES,
  timingCompatibility: timingProfile,
  unavailableStates: UNAVAILABLE_STATES,
  unavailableReasons: UNAVAILABLE_REASONS,
  reasonsByState: REASONS_BY_UNAVAILABLE_STATE,
  maximumLedgerEntries: MAXIMUM_LEDGER_ENTRIES,
  maximumLedgerJsonCodeUnits: MAXIMUM_LEDGER_JSON_CODE_UNITS,
  maximumGovernedFieldCodeUnits: MAXIMUM_GOVERNED_FIELD_CODE_UNITS,
  detachedHead: {
    field: DETACHED_HEAD_FIELD,
    reason: DETACHED_HEAD_REASON,
  },
});

export const FieldUnavailableSchema = z
  .array(
    z
      .object({
        field: governedFieldSchema,
        state: unavailableStateSchema,
        reason: unavailableReasonSchema,
      })
      .strict()
      .superRefine(({ field, state, reason }, context) => {
        if (!reasonsByState[state].has(reason)) {
          context.addIssue({
            code: "custom",
            message: `Reason ${reason} is not valid for state ${state}`,
            path: ["reason"],
          });
        }
        if (
          reason === CONTEXT_PROFILE_IDENTITY.detachedHead.reason &&
          field !== CONTEXT_PROFILE_IDENTITY.detachedHead.field
        ) {
          context.addIssue({
            code: "custom",
            message: `${CONTEXT_PROFILE_IDENTITY.detachedHead.reason} is valid only for ${CONTEXT_PROFILE_IDENTITY.detachedHead.field}`,
            path: ["field"],
          });
        }
      }),
  )
  .min(1)
  .max(MAXIMUM_LEDGER_ENTRIES)
  .superRefine(uniqueFields);

export type FieldProvenance = z.infer<typeof FieldProvenanceSchema>;
export type FieldUnavailable = z.infer<typeof FieldUnavailableSchema>;

const parseBoundedJson = (value: string): unknown => {
  if (value.length > MAXIMUM_LEDGER_JSON_CODE_UNITS) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

export const parseFieldProvenance = (value: string) =>
  FieldProvenanceSchema.safeParse(parseBoundedJson(value));

export const parseFieldUnavailable = (value: string) =>
  FieldUnavailableSchema.safeParse(parseBoundedJson(value));
