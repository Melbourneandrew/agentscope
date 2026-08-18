import { describe, expect, it } from "vitest";

import {
  getAcceptedSemanticAttributeDescriptor,
  getStructuralSemanticDescriptor,
  REDACTION_TRANSFORMS,
} from "@agentscope/protocol";

import {
  applyDescriptorRedaction,
  CoreRedactionError,
  TRANSFORM_HANDLERS,
  type ResolvedRedactionPolicy,
} from "./transforms.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  fingerprintRedactionPolicyMaterialForTesting,
  REDACTION_POLICY_IDENTITIES,
  REDACTION_POLICY_MATERIAL_FOR_TESTING,
  REDACTION_POLICY_PROFILE,
  REDACTION_POLICY_PROFILE_FINGERPRINT,
  resolveRedactionPolicy,
} from "./policy.js";

const baseline: ResolvedRedactionPolicy = resolveRedactionPolicy(
  DEFAULT_REDACTION_POLICY_REGISTRY,
  BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
);
const strict: ResolvedRedactionPolicy = resolveRedactionPolicy(
  DEFAULT_REDACTION_POLICY_REGISTRY,
  BUILTIN_REDACTION_POLICY_REFERENCES.strict,
);
const descriptor = (field: string) => {
  const result = getAcceptedSemanticAttributeDescriptor(field);
  if (result === undefined) throw new Error("fixture descriptor missing");
  return result;
};
const jwtCanary = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiJDQU5BUlkifQ",
  "signature123",
].join(".");

describe("closed mandatory transform engine", () => {
  it("binds and freezes the complete built-in policy semantics", () => {
    expect(REDACTION_POLICY_PROFILE_FINGERPRINT).toBe(
      "sha256-0bd7538b7cffc7117cae907d238661611f01d262bf66d4ce18c9aeb146e2f11c",
    );
    expect(REDACTION_POLICY_IDENTITIES.baseline).toContain(
      REDACTION_POLICY_PROFILE_FINGERPRINT,
    );
    expect(
      Reflect.set(REDACTION_POLICY_PROFILE, "percentDecodePasses", 0),
    ).toBe(false);
    expect(
      Object.isFrozen(REDACTION_POLICY_PROFILE.terminalSemantics.routes),
    ).toBe(true);
    const changedTerminalBehavior = {
      ...REDACTION_POLICY_MATERIAL_FOR_TESTING,
      terminalSemantics: {
        ...REDACTION_POLICY_MATERIAL_FOR_TESTING.terminalSemantics,
        routes: {
          ...REDACTION_POLICY_MATERIAL_FOR_TESTING.terminalSemantics.routes,
          content: {
            ...REDACTION_POLICY_MATERIAL_FOR_TESTING.terminalSemantics.routes
              .content,
            strict: "retain",
          },
        },
      },
    };
    expect(
      fingerprintRedactionPolicyMaterialForTesting(changedTerminalBehavior),
    ).not.toBe(REDACTION_POLICY_PROFILE_FINGERPRINT);
  });

  it("implements the exact Protocol transform inventory", () => {
    expect(Object.keys(TRANSFORM_HANDLERS).sort()).toEqual(
      [...REDACTION_TRANSFORMS].sort(),
    );
  });

  it.each([
    ["openinference.span.kind", "AGENT"],
    ["llm.model_name", "gpt-safe"],
    ["input.value", "ordinary text"],
    ["metadata", '{"b":2,"a":1}'],
    ["image.url", "https://example.test/image.png"],
  ])("retains a safe %s value", (field, value) => {
    const result = applyDescriptorRedaction(descriptor(field), value, baseline);
    expect(result.outcome).toBe("retain");
    if (field === "metadata") {
      expect(result.value).toBe('{"a":1,"b":2}');
      expect(result.transformed).toBe(true);
    } else expect(result.value).toBe(value);
  });

  it("omits secrets and absolute paths without exposing them", () => {
    for (const value of [
      "password=CANARY_SECRET",
      "Bearer CANARY_SECRET",
      jwtCanary,
      "-----BEGIN PRIVATE KEY-----CANARY-----END PRIVATE KEY-----",
      "postgres://user:CANARY_SECRET@example.test/database",
      "accessToken=CANARY_SECRET",
      "openaiApiKey=CANARY_SECRET",
      "githubToken=CANARY_SECRET",
      "authToken=CANARY_SECRET",
      "sessionToken=CANARY_SECRET",
      "anthropicApiKey: CANARY_SECRET",
      "databasePassword=CANARY_SECRET",
      "dbPassword=CANARY_SECRET",
      "stripeToken=CANARY_SECRET",
      "serviceSecret=CANARY_SECRET",
      "credential=CANARY_SECRET",
      "clientSecret=CANARY_SECRET",
      "refreshToken=CANARY_SECRET",
      "privateKey=CANARY_SECRET",
      "GITHUB_TOKEN=CANARY_SECRET",
      "AWS_SECRET_ACCESS_KEY=CANARY_SECRET",
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"a".repeat(30)}`,
      `npm_${"a".repeat(30)}`,
      "pass\u200bword=CANARY_SECRET",
      "/Users/alice/private/file.txt",
      "/etc/agentscope/config",
      "~/private/file.txt",
      "C:\\Users\\alice\\secret.txt",
      "\\\\server\\share\\secret.txt",
      "\\\\?\\C:\\Users\\alice\\secret.txt",
      "%2FUsers%2Falice%2Fprivate.txt",
      "%252FUsers%252Falice%252Fprivate.txt",
      "file:///Users/alice/private.txt",
      "files=[/Users/alice/private.txt]",
      "prefix,/home/alice/key",
      "files=[C:\\Users\\alice\\CANARY.txt]",
      "prefix,C:\\Users\\alice\\CANARY.txt",
      "prefix,file:///Users/alice/CANARY",
    ]) {
      expect(
        applyDescriptorRedaction(descriptor("input.value"), value, baseline),
      ).toMatchObject({ outcome: "omit-redacted" });
    }
    expect(
      applyDescriptorRedaction(
        descriptor("agentscope.workspace.directory"),
        "workspace/project",
        baseline,
      ),
    ).toMatchObject({ outcome: "retain", transformed: false });
    for (const value of [
      "/Users/alice/project",
      "password=CANARY_SECRET",
      "x".repeat(16_385),
    ])
      expect(
        applyDescriptorRedaction(
          descriptor("agentscope.workspace.directory"),
          value,
          baseline,
        ),
        value.slice(0, 24),
      ).toMatchObject({ outcome: "omit-redacted" });
  });
});

describe("closed structured transform routes", () => {
  it("parses, recursively scans, and deterministically serializes JSON", () => {
    expect(
      applyDescriptorRedaction(
        descriptor("metadata"),
        '{"z":[null,1],"a":true}',
        baseline,
      ),
    ).toMatchObject({
      outcome: "retain",
      value: '{"a":true,"z":[null,1]}',
      transformed: true,
    });
    expect(
      applyDescriptorRedaction(
        descriptor("metadata"),
        '{"a":1,"b":2}',
        baseline,
      ),
    ).toMatchObject({ outcome: "retain" });
    for (const value of ["not-json", "[]"])
      expect(() =>
        applyDescriptorRedaction(descriptor("metadata"), value, baseline),
      ).toThrow(CoreRedactionError);
    for (const value of [
      '{"password":"CANARY_SECRET"}',
      '{"/Users/alice/private":"value"}',
      '{"pass\\u0077ord":"CANARY_SECRET"}',
      '{"accessToken":"CANARY_SECRET"}',
      '{"GITHUB_TOKEN":"CANARY_SECRET"}',
      '{"safe":1,"safe":"password=CANARY_SECRET"}',
    ])
      expect(
        applyDescriptorRedaction(descriptor("metadata"), value, baseline),
      ).toMatchObject({ outcome: "omit-redacted" });
  });
});

describe("closed URI and restricted transform routes", () => {
  it("strips safe URL query/fragment and omits unsafe URI forms", () => {
    expect(
      applyDescriptorRedaction(
        descriptor("image.url"),
        "https://example.test/a.png?token=secret#fragment",
        baseline,
      ),
    ).toMatchObject({
      outcome: "retain",
      value: "https://example.test/a.png",
      transformed: true,
    });
    expect(
      applyDescriptorRedaction(
        descriptor("image.url"),
        "HTTPS://EXAMPLE.TEST/a",
        baseline,
      ),
    ).toMatchObject({
      outcome: "retain",
      value: "https://example.test/a",
      transformed: true,
    });
    for (const value of [
      "data:text/plain,secret",
      "file:///Users/alice/file",
      "blob:https://example.test/id",
      "relative/path",
      "https://user:password@example.test/a",
      "https://example.test/%E0%A4%A",
      "https://example.test/%2FUsers%2Falice%2Fsecret",
      "https://example.test/%EF%BC%8FUsers%EF%BC%8Falice%EF%BC%8Fsecret",
    ])
      expect(
        applyDescriptorRedaction(descriptor("image.url"), value, baseline),
      ).toMatchObject({ outcome: "omit-redacted" });
  });

  it("drops opaque artifacts and embedding vectors without placeholders", () => {
    let inspected = false;
    const opaque = Object.create(null) as { toString?: () => string };
    Object.defineProperty(opaque, "toString", {
      get() {
        inspected = true;
        throw new Error("CANARY_SECRET");
      },
    });
    expect(
      applyDescriptorRedaction(
        descriptor(
          "llm.input_messages.0.message.contents.0.message_content.signature",
        ),
        "opaque-ciphertext",
        baseline,
      ),
    ).toEqual({ outcome: "omit-redacted", transformed: false });
    expect(
      applyDescriptorRedaction(
        descriptor(
          "llm.input_messages.0.message.contents.0.message_content.signature",
        ),
        opaque,
        baseline,
      ),
    ).toEqual({ outcome: "omit-redacted", transformed: false });
    expect(inspected).toBe(false);
    expect(
      applyDescriptorRedaction(
        descriptor("embedding.embeddings.0.embedding.vector"),
        [1, 2, 3],
        baseline,
      ),
    ).toEqual({ outcome: "omit-redacted", transformed: false });
  });

  it("treats strict policy as a monotone disclosure reduction", () => {
    expect(
      applyDescriptorRedaction(descriptor("input.value"), "safe", strict),
    ).toMatchObject({ outcome: "omit-redacted" });
    const spanName = getStructuralSemanticDescriptor("span.name")!;
    expect(
      applyDescriptorRedaction(spanName, "password=CANARY_SECRET", baseline),
    ).toMatchObject({ outcome: "replace-non-content" });
    const eventName = getStructuralSemanticDescriptor("span.event.name")!;
    expect(
      applyDescriptorRedaction(eventName, "password=CANARY_SECRET", baseline),
    ).toMatchObject({ outcome: "omit-event" });
  });

  it("suppresses structural secrets and oversize values after scanning", () => {
    expect(() =>
      applyDescriptorRedaction(
        descriptor("openinference.span.kind"),
        "password=CANARY_SECRET",
        baseline,
      ),
    ).toThrow(CoreRedactionError);
    expect(
      applyDescriptorRedaction(
        descriptor("input.value"),
        "x".repeat(16_385),
        baseline,
      ),
    ).toMatchObject({ outcome: "omit-redacted" });
  });
});
