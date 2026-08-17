import { describe, expect, it } from "vitest";

import {
  FEEDBACK_PROFILE,
  feedbackAttribute,
  feedbackAttributesAreValid,
  validateFeedbackProfileForTesting,
  isFeedbackAttributeKey,
} from "./feedback-profile.js";
import { getAcceptedSemanticAttributeDescriptor } from "./semantic-profile.js";
import type { OtlpKeyValue, OtlpSpan } from "./otlp.js";
import { fingerprintCanonicalMaterial } from "./extensions.js";

const span = (attributes: OtlpKeyValue[], links: OtlpSpan["links"] = []) =>
  ({
    traceId: "01".repeat(16),
    spanId: "02".repeat(8),
    name: "feedback",
    kind: 1,
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    attributes,
    links,
  }) satisfies OtlpSpan;
const string = (key: string, value: string) =>
  feedbackAttribute(key, { stringValue: value });
const score = (key: string, value = 1) =>
  feedbackAttribute(key, { doubleValue: value });
const external = { traceId: "03".repeat(16), spanId: "04".repeat(8) };

describe("feedback profile", () => {
  it("binds its exact machine-readable descriptor", () => {
    expect(isFeedbackAttributeKey("annotations.0.annotation.name")).toBe(true);
    expect(isFeedbackAttributeKey("annotations.00.annotation.name")).toBe(
      false,
    );
    expect(validateFeedbackProfileForTesting(FEEDBACK_PROFILE)).toStrictEqual(
      FEEDBACK_PROFILE,
    );
    expect(() =>
      validateFeedbackProfileForTesting({
        ...FEEDBACK_PROFILE,
        aliasRule: "by-index",
      }),
    ).toThrow("protocol.feedback-profile.invalid");
    expect(() => validateFeedbackProfileForTesting([])).toThrow(
      "protocol.feedback-profile.invalid",
    );
    const coordinated = structuredClone(FEEDBACK_PROFILE) as unknown as {
      descriptorFingerprint: string;
      fields: { name: { required: boolean } };
      [key: string]: unknown;
    };
    coordinated.fields.name.required = false;
    const material: Partial<typeof coordinated> = { ...coordinated };
    delete material.descriptorFingerprint;
    coordinated.descriptorFingerprint = fingerprintCanonicalMaterial(material);
    expect(() => validateFeedbackProfileForTesting(coordinated)).toThrow(
      "protocol.feedback-profile.invalid",
    );
    const privacyLie = structuredClone(FEEDBACK_PROFILE) as unknown as {
      descriptorFingerprint: string;
      fields: { explanation: { sensitivity: string } };
      [key: string]: unknown;
    };
    privacyLie.fields.explanation.sensitivity = "safe";
    const privacyMaterial: Partial<typeof privacyLie> = { ...privacyLie };
    delete privacyMaterial.descriptorFingerprint;
    privacyLie.descriptorFingerprint =
      fingerprintCanonicalMaterial(privacyMaterial);
    expect(() => validateFeedbackProfileForTesting(privacyLie)).toThrow(
      "protocol.feedback-profile.invalid",
    );
  });

  it("governs all 42 flattened terminals with complete privacy metadata", () => {
    for (const form of FEEDBACK_PROFILE.forms) {
      for (const [field, privacy] of Object.entries(FEEDBACK_PROFILE.fields)) {
        const key = `${form.prefix}.7.${form.object}.${field}`;
        const descriptor = getAcceptedSemanticAttributeDescriptor(key);
        expect(descriptor, key).toBeDefined();
        expect(descriptor?.contentClass).toBe(privacy.contentClass);
        expect(descriptor?.sensitivity).toBe(privacy.sensitivity);
        expect(descriptor?.redaction).toBe(privacy.redaction);
      }
    }
  });

  it.each(FEEDBACK_PROFILE.forms)(
    "accepts complete $scope $noun objects while preserving index holes",
    (form) => {
      const prefix = `${form.prefix}.9.${form.object}`;
      const correlation =
        form.scope === "session" ? [string("session.id", "session-123")] : [];
      expect(
        feedbackAttributesAreValid(
          span([
            string("agentscope.feedback.transport", "inline"),
            ...correlation,
            string(`${prefix}.name`, "correctness"),
            score(`${prefix}.score`),
          ]),
        ),
      ).toBe(true);
    },
  );

  it("requires a name and at least one result atomically", () => {
    expect(
      feedbackAttributesAreValid(
        span([
          string("agentscope.feedback.transport", "inline"),
          string("annotations.0.annotation.name", "correctness"),
        ]),
      ),
    ).toBe(false);
    expect(
      feedbackAttributesAreValid(
        span([
          string("agentscope.feedback.transport", "inline"),
          string("annotations.0.evaluation.name", "mismatched"),
          score("annotations.0.evaluation.score"),
        ]),
      ),
    ).toBe(false);
    expect(
      feedbackAttributesAreValid(
        span([
          string("agentscope.feedback.transport", "inline"),
          score("annotations.0.annotation.score"),
        ]),
      ),
    ).toBe(false);
  });
});

describe("feedback alias semantics", () => {
  it("matches aliases by name and identifier rather than index", () => {
    const matching = [
      string("agentscope.feedback.transport", "inline"),
      string("annotations.8.annotation.name", "correctness"),
      string("annotations.8.annotation.identifier", "judge-v2"),
      score("annotations.8.annotation.score"),
      string("evaluations.3.evaluation.name", "correctness"),
      string("evaluations.3.evaluation.identifier", "judge-v2"),
      score("evaluations.3.evaluation.score"),
    ];
    expect(feedbackAttributesAreValid(span(matching))).toBe(true);
    matching[6] = score("evaluations.3.evaluation.score", 0);
    expect(feedbackAttributesAreValid(span(matching))).toBe(false);
  });

  it("uses mathematical numeric alias equality and rejects duplicate fields", () => {
    const attributes = [
      string("agentscope.feedback.transport", "inline"),
      string("annotations.0.annotation.name", "correctness"),
      feedbackAttribute("annotations.0.annotation.score", { intValue: "1" }),
      string("evaluations.4.evaluation.name", "correctness"),
      feedbackAttribute("evaluations.4.evaluation.score", { doubleValue: 1 }),
    ];
    expect(feedbackAttributesAreValid(span(attributes))).toBe(true);
    attributes.push(score("evaluations.4.evaluation.score"));
    expect(feedbackAttributesAreValid(span(attributes))).toBe(false);

    const reversed = attributes.slice(0, 5);
    reversed[2] = feedbackAttribute("annotations.0.annotation.score", {
      doubleValue: 1,
    });
    reversed[4] = feedbackAttribute("evaluations.4.evaluation.score", {
      intValue: "1",
    });
    expect(feedbackAttributesAreValid(span(reversed))).toBe(true);
    reversed[2] = feedbackAttribute("annotations.0.annotation.score", {
      intValue: "1",
    });
    expect(feedbackAttributesAreValid(span(reversed))).toBe(true);
  });
});

describe("feedback correlation", () => {
  it("rejects ambiguous duplicate-name aliases without identifiers", () => {
    expect(
      feedbackAttributesAreValid(
        span([
          string("agentscope.feedback.transport", "inline"),
          string("annotations.0.annotation.name", "correctness"),
          score("annotations.0.annotation.score"),
          string("annotations.1.annotation.name", "correctness"),
          score("annotations.1.annotation.score"),
          string("evaluations.7.evaluation.name", "correctness"),
          score("evaluations.7.evaluation.score"),
        ]),
      ),
    ).toBe(false);
  });

  it("requires session correlation", () => {
    const attributes = [
      string("agentscope.feedback.transport", "inline"),
      string("session.annotations.0.annotation.name", "coherence"),
      string("session.annotations.0.annotation.label", "coherent"),
    ];
    expect(feedbackAttributesAreValid(span(attributes))).toBe(false);
    attributes.push(string("session.id", "session-123"));
    expect(feedbackAttributesAreValid(span(attributes))).toBe(true);
  });

  it.each(["span", "trace"] as const)(
    "enforces one external link for explicit post-hoc $0 carriers",
    (scope) => {
      const base = scope === "span" ? "annotations" : "trace.annotations";
      const attributes = [
        string("agentscope.feedback.transport", "post-hoc"),
        string(`${base}.0.annotation.name`, "correctness"),
        score(`${base}.0.annotation.score`),
      ];
      expect(feedbackAttributesAreValid(span(attributes))).toBe(false);
      expect(feedbackAttributesAreValid(span(attributes, [external]))).toBe(
        true,
      );
      expect(
        feedbackAttributesAreValid(
          span(attributes, [external, { ...external, spanId: "05".repeat(8) }]),
        ),
      ).toBe(false);
    },
  );

  it("enforces session post-hoc correlation and mixed-scope rejection", () => {
    const session = [
      string("agentscope.feedback.transport", "post-hoc"),
      string("session.id", "session-123"),
      string("session.evaluations.0.evaluation.name", "coherence"),
      string("session.evaluations.0.evaluation.label", "coherent"),
    ];
    expect(feedbackAttributesAreValid(span(session))).toBe(true);
    const withoutLinks = span(session);
    Reflect.deleteProperty(withoutLinks, "links");
    expect(feedbackAttributesAreValid(withoutLinks)).toBe(true);
    expect(feedbackAttributesAreValid(span(session, [external]))).toBe(true);
    expect(
      feedbackAttributesAreValid(
        span([
          ...session,
          string("annotations.1.annotation.name", "x"),
          score("annotations.1.annotation.score"),
        ]),
      ),
    ).toBe(false);
    expect(
      feedbackAttributesAreValid(
        span([string("agentscope.feedback.transport", "post-hoc")]),
      ),
    ).toBe(false);
    expect(
      feedbackAttributesAreValid(
        span([
          ...session.slice(1),
          string("agentscope.feedback.transport", "invalid"),
        ]),
      ),
    ).toBe(false);
  });

  it("does not infer post-hoc status from ordinary inline links", () => {
    expect(
      feedbackAttributesAreValid(
        span(
          [
            string("annotations.0.annotation.name", "correctness"),
            score("annotations.0.annotation.score"),
          ],
          [external, { ...external, spanId: "05".repeat(8) }],
        ),
        false,
      ),
    ).toBe(true);
  });
});
