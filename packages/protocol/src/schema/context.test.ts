import { describe, expect, it } from "vitest";

import {
  FieldProvenanceSchema,
  FieldUnavailableSchema,
  parseFieldProvenance,
  parseFieldUnavailable,
} from "./context.js";

describe("field provenance and unavailable records", () => {
  it("accepts bounded, ordered-ready provenance without raw source references", () => {
    expect(
      FieldProvenanceSchema.parse([
        { field: "llm.model_name", source: "native-artifact" },
        {
          field: "span.start_time_unix_nano",
          source: "derived",
          timingBasis: "hook-observed-point",
          nativeState: "unavailable",
        },
      ]),
    ).toHaveLength(2);
  });

  it("rejects duplicate provenance fields", () => {
    expect(
      FieldProvenanceSchema.safeParse([
        { field: "llm.model_name", source: "native-artifact" },
        { field: "llm.model_name", source: "derived" },
      ]).success,
    ).toBe(false);
  });

  it.each([
    ["unavailable", "not-emitted"],
    ["unavailable", "resolution-failed"],
    ["unavailable", "unsupported"],
    ["not-applicable", "not-applicable"],
    ["not-applicable", "detached-head"],
    ["redacted", "policy-redacted"],
    ["observed-empty", "empty-native-value"],
  ] as const)("accepts %s with %s", (state, reason) => {
    const field =
      reason === "detached-head" ? "vcs.ref.head.name" : "llm.provider";
    expect(
      FieldUnavailableSchema.safeParse([{ field, state, reason }]).success,
    ).toBe(true);
  });

  it("rejects invalid state/reason pairs, detached misuse, and duplicates", () => {
    expect(
      FieldUnavailableSchema.safeParse([
        {
          field: "llm.provider",
          state: "redacted",
          reason: "not-emitted",
        },
      ]).success,
    ).toBe(false);
    expect(
      FieldUnavailableSchema.safeParse([
        {
          field: "llm.provider",
          state: "not-applicable",
          reason: "detached-head",
        },
      ]).success,
    ).toBe(false);
    expect(
      FieldUnavailableSchema.safeParse([
        {
          field: "llm.provider",
          state: "unavailable",
          reason: "not-emitted",
        },
        {
          field: "llm.provider",
          state: "unavailable",
          reason: "unsupported",
        },
      ]).success,
    ).toBe(false);
  });

  it("parses bounded JSON and safely rejects malformed or oversized JSON", () => {
    expect(
      parseFieldProvenance(
        JSON.stringify([{ field: "span.name", source: "hook-payload" }]),
      ).success,
    ).toBe(true);
    expect(parseFieldProvenance("not-json").success).toBe(false);
    expect(parseFieldProvenance(`"${"x".repeat(16_385)}"`).success).toBe(false);
    expect(
      parseFieldUnavailable(
        JSON.stringify([
          {
            field: "llm.provider",
            state: "unavailable",
            reason: "not-emitted",
          },
        ]),
      ).success,
    ).toBe(true);
  });
});
