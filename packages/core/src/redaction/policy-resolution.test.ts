import { describe, expect, it } from "vitest";

import { getAcceptedSemanticAttributeDescriptor } from "@agentscope/protocol";

import { applyDescriptorRedaction, CoreRedactionError } from "./transforms.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  compileRedactionPolicyRegistry,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  RedactionPolicyError,
  redactionRuleOmits,
  resolveRedactionPolicy,
  validateResolvedRedactionPolicy,
} from "./policy.js";

const descriptor = (key: string) => {
  const value = getAcceptedSemanticAttributeDescriptor(key);
  if (value === undefined) throw new Error("missing descriptor fixture");
  return value;
};

const definition = (rules: readonly unknown[]) => ({
  version: 1,
  reference: "user-policy-v1",
  mode: "baseline",
  rules,
});

describe("declarative redaction policy behavior", () => {
  it("canonicalizes an omit-only rule set into one immutable identity", () => {
    const rules = [
      {
        selector: { kind: "semantic-key", value: "tool.description" },
        spanKind: "TOOL",
        action: "omit",
      },
      {
        selector: { kind: "template", value: "llm-message-content" },
        action: "omit",
      },
    ] as const;
    const first = resolveRedactionPolicy(
      compileRedactionPolicyRegistry([definition(rules)]),
      "user-policy-v1",
    );
    const second = resolveRedactionPolicy(
      compileRedactionPolicyRegistry([definition([...rules].reverse())]),
      "user-policy-v1",
    );
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.rules)).toBe(true);
    expect(first.identity).toMatch(/^agentscope\.redaction\.effective\.v1\./u);
    expect(
      redactionRuleOmits(
        first,
        "llm.input_messages.0.message.content",
        "llm-message-content",
        "LLM",
      ),
    ).toBe(true);
    expect(
      redactionRuleOmits(first, "tool.description", undefined, "AGENT"),
    ).toBe(false);
  });

  it("omits additional safe values but never weakens the mandatory scan", () => {
    const policy = resolveRedactionPolicy(
      compileRedactionPolicyRegistry([
        definition([
          {
            selector: { kind: "semantic-key", value: "tool.description" },
            action: "omit",
          },
        ]),
      ]),
      "user-policy-v1",
    );
    expect(
      applyDescriptorRedaction(
        descriptor("tool.description"),
        "safe description",
        policy,
        undefined,
        { semanticKey: "tool.description", spanKind: "TOOL" },
      ),
    ).toMatchObject({ outcome: "omit-redacted" });
    expect(() =>
      applyDescriptorRedaction(
        descriptor("service.name"),
        "githubToken=CANARY_SECRET",
        policy,
        undefined,
        { semanticKey: "service.name", spanKind: "AGENT" },
      ),
    ).toThrow(CoreRedactionError);
  });
});

describe("declarative redaction policy validation", () => {
  it("rejects unknown, duplicate, executable, and behavior-widening rules", () => {
    const invalidRules: readonly unknown[][] = [
      [
        {
          selector: { kind: "semantic-key", value: "unknown.value" },
          action: "omit",
        },
      ],
      [
        {
          selector: { kind: "semantic-key", value: "tool.description" },
          action: "retain",
        },
      ],
      [
        {
          selector: { kind: "semantic-key", value: "tool.description" },
          action: "omit",
          callback: () => true,
        },
      ],
      [
        {
          selector: { kind: "semantic-key", value: "tool.description" },
          action: "omit",
        },
        {
          selector: { kind: "semantic-key", value: "tool.description" },
          action: "omit",
        },
      ],
    ];
    for (const rules of invalidRules)
      expect(() => compileRedactionPolicyRegistry([definition(rules)])).toThrow(
        RedactionPolicyError,
      );
    expect(() =>
      resolveRedactionPolicy(
        DEFAULT_REDACTION_POLICY_REGISTRY,
        "unknown-policy",
      ),
    ).toThrow(RedactionPolicyError);
    expect(() =>
      compileRedactionPolicyRegistry([
        definition([
          {
            selector: {
              kind: "semantic-key",
              value: "tool.description",
            },
            action: "omit",
            padding: "x".repeat(32_768),
          },
        ]),
      ]),
    ).toThrow(RedactionPolicyError);
    const sparse = new Array<unknown>(1);
    for (const registryInput of [
      null,
      new Array(65).fill(definition([])),
      sparse,
      [definition([]), definition([])],
    ])
      expect(() =>
        compileRedactionPolicyRegistry(registryInput as never),
      ).toThrow(RedactionPolicyError);
  });

  it("rejects coordinated resolved-policy identity mutations", () => {
    const baseline = resolveRedactionPolicy(
      DEFAULT_REDACTION_POLICY_REGISTRY,
      BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
    );
    expect(validateResolvedRedactionPolicy(baseline)).toEqual(baseline);
    for (const mutation of [
      { ...baseline, identity: "invalid" },
      { ...baseline, mode: "strict" },
      { ...baseline, reference: "other" },
      { ...baseline, rules: [{ callback: () => true }] },
      { ...baseline, extra: true },
      Object.defineProperty({ ...baseline }, "identity", {
        get: () => baseline.identity,
      }),
      { ...baseline, identity: 1 },
      null,
    ])
      expect(() => validateResolvedRedactionPolicy(mutation)).toThrow(
        RedactionPolicyError,
      );
  });
});
