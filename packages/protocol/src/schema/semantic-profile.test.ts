import * as openInferencePackage from "@arizeai/openinference-semantic-conventions";
import { describe, expect, it } from "vitest";

import rawSemanticProfile from "../standards/semantic-profile.json" with { type: "json" };
import { standardsManifest } from "../standards/manifest.js";
import { fingerprintCanonicalMaterial } from "./extensions.js";
import {
  compareCanonicalStringsForTesting,
  getAcceptedSemanticAttributeDescriptor,
  getSemanticAttributeDescriptor,
  getStructuralSemanticDescriptor,
  isSemanticCandidateUpstreamConstraintValid,
  semanticProfileDescriptors,
  semanticProfileOpenEnumPolicy,
  semanticProfilePackageBindings,
  semanticProfilePackageEnumBindings,
  semanticProfilePackageExportDispositions,
  SEMANTIC_PROFILE_FINGERPRINT,
  SEMANTIC_PROFILE_IDENTITY,
  SemanticProfileError,
  templateSegmentsOverlapForTesting,
  REDACTION_TRANSFORMS,
  validateRedactionTransformInventoryForTesting,
  validateSemanticProfileIdentity,
  validateSemanticProfileForTesting,
} from "./semantic-profile.js";

const cloneProfile = () => structuredClone(rawSemanticProfile);

describe("semantic candidate constraints", () => {
  it("enforces candidate-visible upstream compound constraints", () => {
    const candidate = {
      kind: "LLM",
      spanName: "chat",
      presentFields: ["llm.system"],
      unavailable: [] as { field: string; state: string }[],
    };
    expect(isSemanticCandidateUpstreamConstraintValid(candidate)).toBe(true);
    expect(
      isSemanticCandidateUpstreamConstraintValid({
        ...candidate,
        presentFields: [],
        unavailable: [{ field: "llm.system", state: "unavailable" }],
      }),
    ).toBe(true);
    expect(
      isSemanticCandidateUpstreamConstraintValid({
        ...candidate,
        unavailable: [{ field: "llm.system", state: "unavailable" }],
      }),
    ).toBe(false);
    expect(
      isSemanticCandidateUpstreamConstraintValid({
        ...candidate,
        presentFields: [],
        unavailable: [],
      }),
    ).toBe(false);
    expect(
      isSemanticCandidateUpstreamConstraintValid({
        ...candidate,
        kind: "EMBEDDING",
        spanName: "not-create-embeddings",
      }),
    ).toBe(false);
    expect(
      isSemanticCandidateUpstreamConstraintValid({
        ...candidate,
        kind: "EMBEDDING",
        spanName: "CreateEmbeddings",
      }),
    ).toBe(true);
  });
});

describe("machine-readable semantic profile", () => {
  it("uses locale-independent binary ordering", () => {
    expect(compareCanonicalStringsForTesting("a", "b")).toBe(-1);
    expect(compareCanonicalStringsForTesting("b", "a")).toBe(1);
    expect(compareCanonicalStringsForTesting("a", "a")).toBe(0);
  });

  it("binds the complete descriptor identity into the standards manifest", () => {
    expect(SEMANTIC_PROFILE_FINGERPRINT).toBe(
      standardsManifest.canonicalProfile.semanticDescriptorFingerprint,
    );
    expect(fingerprintCanonicalMaterial(SEMANTIC_PROFILE_IDENTITY)).toBe(
      SEMANTIC_PROFILE_FINGERPRINT,
    );
    expect(Object.isFrozen(SEMANTIC_PROFILE_IDENTITY)).toBe(true);
    expect(Object.isFrozen(semanticProfileDescriptors.attributes)).toBe(true);
    expect(Object.isFrozen(semanticProfileDescriptors.structural)).toBe(true);
    expect(
      Reflect.set(SEMANTIC_PROFILE_IDENTITY.redactionRoutes, "opaque-drop", [
        "retain",
      ]),
    ).toBe(false);
    expect(SEMANTIC_PROFILE_IDENTITY.redactionRoutes["opaque-drop"]).toEqual([
      "drop",
    ]);
    expect(Object.isFrozen(REDACTION_TRANSFORMS)).toBe(true);
    expect(() => {
      validateRedactionTransformInventoryForTesting(
        SEMANTIC_PROFILE_IDENTITY.redactionRoutes,
        REDACTION_TRANSFORMS.slice(1),
      );
    }).toThrow(
      new SemanticProfileError("semantic.profile.transform-inventory"),
    );
    expect(() => {
      validateRedactionTransformInventoryForTesting(
        SEMANTIC_PROFILE_IDENTITY.redactionRoutes,
        [...REDACTION_TRANSFORMS, REDACTION_TRANSFORMS[0]],
      );
    }).toThrow(
      new SemanticProfileError("semantic.profile.transform-inventory"),
    );
    expect(() => {
      validateSemanticProfileIdentity(1, SEMANTIC_PROFILE_IDENTITY);
    }).toThrow(new SemanticProfileError("semantic.profile.identity"));
  });

  it("classifies every accepted attribute and structural leaf with a mandatory route", () => {
    for (const descriptor of semanticProfileDescriptors.attributes) {
      expect(descriptor.diagnosticExposure).toBe("never");
      expect(descriptor.mandatoryTransforms.length).toBeGreaterThan(0);
      expect(descriptor.allowedOutcomes.length).toBeGreaterThan(0);
      expect(descriptor.sensitivity).toMatch(
        /^(?:safe|potentially-sensitive)$/u,
      );
      expect(descriptor.contentClass.length).toBeGreaterThan(0);
      if (descriptor.key !== undefined && descriptor.support === "accepted") {
        expect(getAcceptedSemanticAttributeDescriptor(descriptor.key)).toBe(
          descriptor,
        );
      }
    }
    for (const descriptor of semanticProfileDescriptors.structural) {
      expect(getStructuralSemanticDescriptor(descriptor.key)).toBe(descriptor);
      expect(descriptor.diagnosticExposure).toBe("never");
      expect(descriptor.mandatoryTransforms.length).toBeGreaterThan(0);
    }
    expect(
      getStructuralSemanticDescriptor("span.name")?.allowedOutcomes,
    ).toEqual(["retain", "replace-non-content", "suppress-trace"]);
    expect(
      getStructuralSemanticDescriptor("span.event.name")?.allowedOutcomes,
    ).toEqual(["retain", "replace-non-content", "omit-event"]);
    expect(
      getStructuralSemanticDescriptor("span.trace_id")?.allowedOutcomes,
    ).toEqual(["retain"]);
    expect(
      semanticProfileDescriptors.structural.map(({ key }) => key).sort(),
    ).toEqual(
      [
        "resource.dropped_attributes_count",
        "scope.dropped_attributes_count",
        "scope.name",
        "scope.version",
        "span.dropped_attributes_count",
        "span.dropped_events_count",
        "span.dropped_links_count",
        "span.end_time_unix_nano",
        "span.event.dropped_attributes_count",
        "span.event.name",
        "span.event.time_unix_nano",
        "span.flags",
        "span.kind",
        "span.link.dropped_attributes_count",
        "span.link.flags",
        "span.link.span_id",
        "span.link.trace_id",
        "span.name",
        "span.parent_span_id",
        "span.span_id",
        "span.start_time_unix_nano",
        "span.status.code",
        "span.status.message",
        "span.trace_id",
      ].sort(),
    );
  });
});

describe("semantic descriptor lookup", () => {
  it("uses exact-before-template lookup and retains rejected upstream semantics as known", () => {
    expect(
      getSemanticAttributeDescriptor("llm.system")?.templateId,
    ).toBeUndefined();
    expect(
      getSemanticAttributeDescriptor("llm.input_messages.0.message.content")
        ?.templateId,
    ).toBe("llm-message-content");
    expect(
      getSemanticAttributeDescriptor("annotations.0.annotation.explanation"),
    ).toMatchObject({ support: "accepted", redaction: "content-policy" });
    expect(
      getAcceptedSemanticAttributeDescriptor(
        "annotations.0.annotation.explanation",
      ),
    ).toBeDefined();
    expect(getSemanticAttributeDescriptor("vendor.secret")).toBeUndefined();
  });

  it("classifies opaque provider artifacts and embeddings with non-retaining routes", () => {
    expect(
      getAcceptedSemanticAttributeDescriptor(
        "llm.input_messages.0.message.contents.0.message_content.signature",
      ),
    ).toMatchObject({
      contentClass: "opaque-provider-artifact",
      redaction: "opaque-drop",
      allowedOutcomes: ["omit-redacted", "suppress-trace"],
    });
    expect(
      getAcceptedSemanticAttributeDescriptor(
        "embedding.embeddings.0.embedding.vector",
      ),
    ).toMatchObject({
      contentClass: "embedding-vector",
      redaction: "embedding-restricted",
    });
    expect(
      getAcceptedSemanticAttributeDescriptor("agentscope.mapping.provenance"),
    ).toMatchObject({
      contentClass: "derived-metadata",
      redaction: "retain-structural",
    });
  });

  it("accepts the pinned snapshot-only nested audio URL without inventing sibling fields", () => {
    expect(
      getAcceptedSemanticAttributeDescriptor(
        "llm.input_messages.0.message.contents.1.message_content.audio.audio.url",
      ),
    ).toMatchObject({
      sourceStatus: "snapshot-experimental-no-package-constant",
      redaction: "uri-media-policy",
    });
    expect(
      getSemanticAttributeDescriptor(
        "llm.output_messages.0.message.contents.1.message_content.audio.audio.url",
      ),
    ).toBeUndefined();
    expect(
      getSemanticAttributeDescriptor(
        "llm.input_messages.0.message.contents.1.message_content.audio.audio.mime_type",
      ),
    ).toBeUndefined();
  });
});

describe("pinned package drift alarms", () => {
  it("resolves every named package constant by export name and expected value", () => {
    const namespace = openInferencePackage as unknown as Record<
      string,
      unknown
    >;
    for (const binding of semanticProfilePackageBindings) {
      const container =
        binding.containerName === undefined
          ? namespace
          : (namespace[binding.containerName] as Record<string, unknown>);
      expect(container[binding.exportName]).toBe(binding.key);
      expect(getSemanticAttributeDescriptor(binding.key)?.support).toBe(
        "accepted",
      );
    }
  });

  it("accounts for every SemanticConventions member without deriving grammar from values", () => {
    const inventory = new Set([
      ...semanticProfilePackageBindings.map(({ exportName }) => exportName),
      ...Object.values(semanticProfilePackageExportDispositions).flatMap(
        (entries) => Object.keys(entries),
      ),
    ]);
    expect(
      Object.keys(openInferencePackage.SemanticConventions).filter(
        (name) => !inventory.has(name),
      ),
    ).toEqual([]);
    const namespace = openInferencePackage as unknown as Record<
      string,
      unknown
    >;
    for (const entries of Object.values(
      semanticProfilePackageExportDispositions,
    )) {
      for (const [name, expected] of Object.entries(entries)) {
        expect(namespace[name]).toBe(expected);
      }
    }
  });

  it("proves named enum members while keeping all but span kind open", () => {
    const namespace = openInferencePackage as unknown as Record<
      string,
      unknown
    >;
    for (const [enumName, expected] of Object.entries(
      semanticProfilePackageEnumBindings,
    )) {
      expect(namespace[enumName]).toEqual(expected);
    }
    expect(semanticProfileOpenEnumPolicy).toEqual([
      "LLMSystem",
      "LLMProvider",
      "AnnotatorKind",
      "MimeType",
    ]);
    expect(
      getAcceptedSemanticAttributeDescriptor("llm.system")?.allowedValues,
    ).toBeUndefined();
    expect(
      getAcceptedSemanticAttributeDescriptor("input.mime_type")?.allowedValues,
    ).toBeUndefined();
  });
});

describe("semantic profile compiler rejection", () => {
  it.each([
    ["llm", "llm", true],
    ["llm", "tool", false],
    ["0", { index: true }, true],
    ["01", { index: true }, false],
    [{ index: true }, "1", true],
    [{ index: true }, { index: true }, true],
    [
      { index: true },
      { identifier: { style: "lower-snake", maxLength: 8 } },
      false,
    ],
    [
      { oneOf: ["llm"] },
      { identifier: { style: "lower-snake", maxLength: 8 } },
      true,
    ],
    [
      { identifier: { style: "lower-snake", maxLength: 8 } },
      { oneOf: ["llm"] },
      true,
    ],
    [
      "long_identifier",
      { identifier: { style: "lower-snake", maxLength: 4 } },
      false,
    ],
  ] as const)(
    "computes structured segment overlap",
    (left, right, expected) => {
      expect(templateSegmentsOverlapForTesting(left, right)).toBe(expected);
    },
  );
});

describe("semantic profile drift rejection", () => {
  it.each([
    [
      "schema",
      (profile: ReturnType<typeof cloneProfile>) =>
        delete (profile as { profileId?: string }).profileId,
    ],
    [
      "baseline",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.upstream.openTelemetrySemanticConventionsVersion = "0.0.0";
      },
    ],
    [
      "duplicate-key",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.directGroups[1]!.keys = [...profile.directGroups[0]!.keys];
      },
    ],
    [
      "duplicate-template-id",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.templates[1]!.id = profile.templates[0]!.id;
      },
    ],
    [
      "duplicate-template-pattern",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.templates[1]!.match = structuredClone(
          profile.templates[0]!.match,
        );
      },
    ],
    [
      "duplicate-structural-key",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.structuralLeaves[1]!.key = profile.structuralLeaves[0]!.key;
      },
    ],
    [
      "duplicate-upstream-constraint",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.upstreamConstraints[1] = structuredClone(
          profile.upstreamConstraints[0],
        ) as never;
      },
    ],
    [
      "upstream-constraints",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.upstreamConstraints.pop();
      },
    ],
    [
      "schema",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.upstreamConstraints[2]!.spanName = "Changed";
      },
    ],
  ])("rejects %s drift with a fixed error code", (suffix, mutate) => {
    const profile = cloneProfile();
    mutate(profile);
    expect(() => validateSemanticProfileForTesting(profile)).toThrow(
      new SemanticProfileError(`semantic.profile.${suffix}`),
    );
  });
});

describe("semantic profile policy drift rejection", () => {
  it.each([
    [
      "duplicate-package-binding",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.packageConstantBindings[1]!.exportName =
          profile.packageConstantBindings[0]!.exportName;
      },
    ],
    [
      "duplicate-package-disposition",
      (profile: ReturnType<typeof cloneProfile>) => {
        const dispositions = profile.packageExportDispositions
          .acceptedPrefix as Record<string, string>;
        dispositions[profile.packageConstantBindings[0]!.exportName] =
          "duplicate";
      },
    ],
    [
      "schema",
      (profile: ReturnType<typeof cloneProfile>) => {
        delete (profile.allowedOutcomesByRoute as Record<string, unknown>)[
          "content-policy"
        ];
      },
    ],
    [
      "schema",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.redactionRoutes["retain-structural"] = ["exfiltrate"] as never;
      },
    ],
    [
      "schema",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.allowedOutcomesByRoute["content-policy"] = ["leak"] as never;
      },
    ],
    [
      "ambiguous-template",
      (profile: ReturnType<typeof cloneProfile>) => {
        const alternatives = profile.templates[1]!.match
          .alternatives as unknown[];
        alternatives.push(
          structuredClone(profile.templates[0]!.match.alternatives[0]!),
        );
      },
    ],
    [
      "ambiguous-template",
      (profile: ReturnType<typeof cloneProfile>) => {
        const alternatives = profile.templates[0]!.match
          .alternatives as unknown[];
        alternatives.push(
          structuredClone(profile.templates[0]!.match.alternatives[0]!),
        );
      },
    ],
    [
      "schema",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.templates[0]!.match.alternatives[0]![0] = {
          oneOf: [],
        };
      },
    ],
    [
      "class-route",
      (profile: ReturnType<typeof cloneProfile>) => {
        profile.directGroups[0]!.redaction = "content-policy";
      },
    ],
  ])("rejects %s drift with a fixed error code", (suffix, mutate) => {
    const profile = cloneProfile();
    mutate(profile);
    expect(() => validateSemanticProfileForTesting(profile)).toThrow(
      new SemanticProfileError(`semantic.profile.${suffix}`),
    );
  });

  it("changes the descriptor fingerprint for a semantic classification mutation", () => {
    const profile = cloneProfile();
    profile.directGroups[0]!.contentClass = "identifier";
    const compiled = validateSemanticProfileForTesting(profile);
    expect(fingerprintCanonicalMaterial(compiled.identity)).not.toBe(
      SEMANTIC_PROFILE_FINGERPRINT,
    );
  });
});
