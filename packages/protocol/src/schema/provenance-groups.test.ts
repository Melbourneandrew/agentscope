import { OpenInferenceSpanKind } from "@arizeai/openinference-semantic-conventions";
import { describe, expect, it } from "vitest";

import { parseFieldProvenance } from "./context.js";
import {
  buildSpanEvidenceLedger,
  getProvenanceTargets,
  isProvenanceGroupField,
  PROVENANCE_GROUP_PROFILE_IDENTITY,
  PROVENANCE_GROUP_SPECS,
  provenanceSegmentCoversForTesting,
  provenanceSegmentsOverlapForTesting,
  ProvenanceLedgerError,
  resolveFieldProvenance,
  validateProvenanceGroupSpecsForTesting,
} from "./provenance-groups.js";

const LLM = String(OpenInferenceSpanKind.LLM);
const role = "llm.input_messages.0.message.role";
const name = "llm.input_messages.0.message.name";
const content = "llm.input_messages.0.message.content";
const contentText =
  "llm.input_messages.0.message.contents.2.message_content.text";
const contentType =
  "llm.input_messages.0.message.contents.2.message_content.type";
const contentId = "llm.input_messages.0.message.contents.2.message_content.id";

const claim = (
  field: string,
  source: "native-artifact" | "derived" | "hook-payload",
) => ({ field, source });

describe("provenance group grammar", () => {
  it("governs exact indexed event/link members and descriptor-valid suffixes", () => {
    for (const field of [
      "span.events.0.event",
      "span.events.9999.name",
      "span.events.2.time_unix_nano",
      "span.events.2.attributes.exception.message",
      "span.links.0.link",
      "span.links.9999.relationship",
    ])
      expect(getProvenanceTargets(field, LLM)).toEqual({
        exact: field,
        groups: [],
      });
    for (const field of [
      "span.events.00.event",
      "span.events.10000.event",
      "span.events.0.attributes.input.value",
      "span.links.0.attributes.exception.message",
      "span.links.0.target",
      "span.events.0.link",
      "span.links.0.name",
      "span.events.0.attributes.unknown.secret",
      "span.events.0.attributes.__proto__",
    ])
      expect(getProvenanceTargets(field, LLM)).toBeUndefined();
  });

  it("builds exact mixed member evidence and preserves omitted holes", () => {
    const ledger = buildSpanEvidenceLedger({
      spanKind: LLM,
      presentFields: [
        "span.events",
        "span.events.2.event",
        "span.events.2.name",
        "span.events.2.time_unix_nano",
      ],
      provenanceClaims: [
        claim("span.events", "derived"),
        claim("span.events.2.event", "derived"),
        claim("span.events.2.name", "hook-payload"),
        claim("span.events.2.time_unix_nano", "native-artifact"),
      ],
      unavailableClaims: [
        {
          field: "span.events.0.event",
          source: "native-artifact",
          state: "redacted",
          reason: "policy-redacted",
        },
      ],
    });
    expect(ledger.provenance.map(({ field }) => field)).toEqual([
      "span.events",
      "span.events.0.event",
      "span.events.2.event",
      "span.events.2.name",
      "span.events.2.time_unix_nano",
    ]);
    expect(ledger.unavailable).toEqual([
      {
        field: "span.events.0.event",
        state: "redacted",
        reason: "policy-redacted",
      },
    ]);
  });

  it("cross-validates every group against accepted semantic templates", () => {
    expect(() => {
      validateProvenanceGroupSpecsForTesting(PROVENANCE_GROUP_SPECS);
    }).not.toThrow();
    expect(PROVENANCE_GROUP_PROFILE_IDENTITY.precedence).toEqual([
      "exact-terminal",
      "deepest-claimed-group",
      "ancestor-group",
    ]);
    expect(Reflect.set(PROVENANCE_GROUP_SPECS[0], "kind", "attacker")).toBe(
      false,
    );
  });
});

describe("provenance group grammar rejection", () => {
  it("rejects missing ownership, wrong kinds, prefix drift, and ambiguity", () => {
    const withoutOwner = PROVENANCE_GROUP_SPECS.map((spec) =>
      spec.id === "llm-message"
        ? {
            ...spec,
            templateIds: spec.templateIds.filter(
              (id) => id !== "llm-message-content",
            ),
          }
        : spec,
    );
    const wrongKind = PROVENANCE_GROUP_SPECS.map((spec) =>
      spec.id === "llm-tool" ? { ...spec, kind: "TOOL" } : spec,
    );
    const prefixDrift = PROVENANCE_GROUP_SPECS.map((spec) =>
      spec.id === "llm-tool"
        ? {
            ...spec,
            segments: ["llm", "attacker", { index: true }] as const,
          }
        : spec,
    );
    const duplicateId = [
      ...PROVENANCE_GROUP_SPECS,
      { ...PROVENANCE_GROUP_SPECS[3] },
    ];
    const ambiguous = [
      ...PROVENANCE_GROUP_SPECS,
      { ...PROVENANCE_GROUP_SPECS[1], id: "ambiguous-copy" },
    ];
    const partialAlternative = PROVENANCE_GROUP_SPECS.map((spec) =>
      spec.id === "llm-message"
        ? {
            ...spec,
            segments: [
              "llm",
              { oneOf: ["input_messages"] },
              { index: true },
            ] as const,
          }
        : spec,
    );
    for (const specs of [
      withoutOwner,
      wrongKind,
      prefixDrift,
      duplicateId,
      ambiguous,
      partialAlternative,
    ]) {
      expect(() => {
        validateProvenanceGroupSpecsForTesting(specs);
      }).toThrow(ProvenanceLedgerError);
    }
  });
});

describe("provenance segment matching", () => {
  it("covers every segment-overlap relation without regex inference", () => {
    expect(provenanceSegmentsOverlapForTesting("0", { index: true })).toBe(
      true,
    );
    expect(provenanceSegmentsOverlapForTesting("x", { index: true })).toBe(
      false,
    );
    expect(
      provenanceSegmentsOverlapForTesting("x", { oneOf: ["x", "y"] }),
    ).toBe(true);
    expect(
      provenanceSegmentsOverlapForTesting("z", { oneOf: ["x", "y"] }),
    ).toBe(false);
    expect(
      provenanceSegmentsOverlapForTesting("x", {
        identifier: { style: "lower-snake", maxLength: 8 },
      }),
    ).toBe(false);
    expect(provenanceSegmentsOverlapForTesting({ index: true }, "0")).toBe(
      true,
    );
    expect(
      provenanceSegmentsOverlapForTesting({ index: true }, { index: true }),
    ).toBe(true);
    expect(
      provenanceSegmentsOverlapForTesting({ oneOf: ["x"] }, { oneOf: ["x"] }),
    ).toBe(true);
    expect(
      provenanceSegmentsOverlapForTesting({ oneOf: ["x"] }, { oneOf: ["y"] }),
    ).toBe(false);
    expect(
      provenanceSegmentsOverlapForTesting({ oneOf: ["x"] }, { index: true }),
    ).toBe(false);
    expect(
      provenanceSegmentsOverlapForTesting(
        { oneOf: ["x"] },
        { identifier: { style: "lower-snake", maxLength: 8 } },
      ),
    ).toBe(false);
  });

  it("uses directional alternative coverage for ownership", () => {
    expect(provenanceSegmentCoversForTesting("x", "x")).toBe(true);
    expect(provenanceSegmentCoversForTesting("x", { index: true })).toBe(false);
    expect(
      provenanceSegmentCoversForTesting({ index: true }, { index: true }),
    ).toBe(true);
    expect(
      provenanceSegmentCoversForTesting({ index: true }, { oneOf: ["x"] }),
    ).toBe(false);
    expect(
      provenanceSegmentCoversForTesting(
        { oneOf: ["x", "y"] },
        { oneOf: ["x"] },
      ),
    ).toBe(true);
    expect(
      provenanceSegmentCoversForTesting(
        { oneOf: ["x"] },
        { identifier: { style: "lower-snake", maxLength: 8 } },
      ),
    ).toBe(false);
  });

  it("matches canonical indices, kinds, and exact segment boundaries", () => {
    expect(getProvenanceTargets(role, LLM)?.groups).toEqual([
      "llm.input_messages.0",
    ]);
    expect(
      getProvenanceTargets("llm.output_messages.9999.message.role", LLM)
        ?.groups,
    ).toEqual(["llm.output_messages.9999"]);
    expect(getProvenanceTargets(contentText, LLM)?.groups).toEqual([
      "llm.input_messages.0.message.contents.2",
      "llm.input_messages.0",
    ]);
    expect(
      getProvenanceTargets("llm.input_messages.00.message.role", LLM),
    ).toBeUndefined();
    expect(
      getProvenanceTargets("llm.input_messages.10000.message.role", LLM),
    ).toBeUndefined();
    expect(getProvenanceTargets(role, "TOOL")).toBeUndefined();
    expect(getProvenanceTargets("", LLM)).toBeUndefined();
    expect(
      getProvenanceTargets("llm.token_count.prompt_details.custom", LLM),
    ).toEqual({
      exact: "llm.token_count.prompt_details.custom",
      groups: [],
    });
    expect(isProvenanceGroupField("llm.input_messages.0", LLM)).toBe(true);
    expect(isProvenanceGroupField("llm.input_messages.0.message", LLM)).toBe(
      false,
    );
  });

  it("resolves every concrete provenance group family", () => {
    const cases = [
      ["llm.input_messages.0.message.tool_calls.2.tool_call.id", LLM],
      ["llm.tools.1.tool.json_schema", LLM],
      ["llm.prompts.1.prompt.text", LLM],
      ["llm.choices.1.completion.text", LLM],
      ["embedding.embeddings.1.embedding.text", "EMBEDDING"],
      ["retrieval.documents.1.document.id", "RETRIEVER"],
      ["reranker.input_documents.1.document.id", "RERANKER"],
      ["reranker.output_documents.1.document.id", "RERANKER"],
    ] as const;
    for (const [field, kind] of cases)
      expect(getProvenanceTargets(field, kind)?.groups.length).toBeGreaterThan(
        0,
      );
  });
});

describe("provenance ledger construction", () => {
  it("compresses a uniform object to one group default", () => {
    const ledger = buildSpanEvidenceLedger({
      spanKind: LLM,
      presentFields: [role, name],
      provenanceClaims: [
        claim(role, "native-artifact"),
        claim(name, "native-artifact"),
      ],
      unavailableClaims: [],
    });
    expect(ledger.provenance).toEqual([
      { field: "llm.input_messages.0", source: "native-artifact" },
    ]);
    expect(ledger.unavailable).toEqual([]);
  });

  it("keeps exact claims when no unique compression default exists", () => {
    const ledger = buildSpanEvidenceLedger({
      spanKind: LLM,
      presentFields: [role, content],
      provenanceClaims: [
        claim(role, "native-artifact"),
        claim(content, "derived"),
      ],
      unavailableClaims: [],
    });
    expect(ledger.provenance.map(({ field }) => field)).toEqual([
      content,
      role,
    ]);
  });
});

describe("mixed and unavailable provenance construction", () => {
  it("uses deepest groups and exact overrides for mixed-source members", () => {
    const presentFields = [
      role,
      name,
      content,
      contentText,
      contentType,
      contentId,
    ];
    const ledger = buildSpanEvidenceLedger({
      spanKind: LLM,
      presentFields,
      provenanceClaims: [
        claim(role, "native-artifact"),
        claim(name, "native-artifact"),
        claim(content, "native-artifact"),
        claim(contentText, "derived"),
        claim(contentType, "derived"),
        claim(contentId, "native-artifact"),
      ],
      unavailableClaims: [],
    });
    expect(ledger.provenance).toEqual([
      { field: "llm.input_messages.0", source: "native-artifact" },
      {
        field: "llm.input_messages.0.message.contents.2",
        source: "derived",
      },
      { field: contentId, source: "native-artifact" },
    ]);
    expect(
      resolveFieldProvenance({
        spanKind: LLM,
        field: role,
        provenance: ledger.provenance,
      }),
    ).toMatchObject({ matchedField: "llm.input_messages.0", match: "group" });
    expect(
      resolveFieldProvenance({
        spanKind: LLM,
        field: contentText,
        provenance: ledger.provenance,
      }),
    ).toMatchObject({
      matchedField: "llm.input_messages.0.message.contents.2",
      match: "group",
    });
    expect(
      resolveFieldProvenance({
        spanKind: LLM,
        field: contentId,
        provenance: ledger.provenance,
      }),
    ).toMatchObject({ matchedField: contentId, match: "exact" });
  });

  it("does not emit a redundant nested group equal to its ancestor", () => {
    const fields = [role, name, content, contentText, contentType];
    const ledger = buildSpanEvidenceLedger({
      spanKind: LLM,
      presentFields: fields,
      provenanceClaims: fields.map((field) => claim(field, "native-artifact")),
      unavailableClaims: [],
    });
    expect(ledger.provenance).toEqual([
      { field: "llm.input_messages.0", source: "native-artifact" },
    ]);
  });

  it("retains an exact nested exception under an equal ancestor default", () => {
    const fields = [role, name, content, contentText, contentType, contentId];
    const ledger = buildSpanEvidenceLedger({
      spanKind: LLM,
      presentFields: fields,
      provenanceClaims: fields.map((field) =>
        claim(field, field === contentId ? "derived" : "native-artifact"),
      ),
      unavailableClaims: [],
    });
    expect(ledger.provenance).toContainEqual(claim(contentId, "derived"));
  });

  it("keeps unavailable members exact with matching provenance", () => {
    const ledger = buildSpanEvidenceLedger({
      spanKind: LLM,
      presentFields: [role],
      provenanceClaims: [claim(role, "native-artifact")],
      unavailableClaims: [
        {
          field: content,
          source: "native-artifact",
          state: "unavailable",
          reason: "not-emitted",
        },
      ],
    });
    expect(ledger.provenance).toContainEqual(claim(content, "native-artifact"));
    expect(ledger.unavailable).toEqual([
      { field: content, state: "unavailable", reason: "not-emitted" },
    ]);
  });
});

describe("provenance builder invariants", () => {
  it("is permutation-invariant and recursively frozen", () => {
    const input = {
      spanKind: LLM,
      presentFields: [role, name],
      provenanceClaims: [
        claim(role, "native-artifact"),
        claim(name, "native-artifact"),
      ],
      unavailableClaims: [],
    } as const;
    const forward = buildSpanEvidenceLedger(input);
    const reverse = buildSpanEvidenceLedger({
      ...input,
      presentFields: [...input.presentFields].reverse(),
      provenanceClaims: [...input.provenanceClaims].reverse(),
    });
    expect(reverse).toEqual(forward);
    expect(Reflect.set(forward.provenance[0]!, "source", "derived")).toBe(
      false,
    );
  });

  it("rejects missing, duplicate, conflicting, unavailable-group, and unknown claims", () => {
    const invalidInputs = [
      {
        spanKind: LLM,
        presentFields: [role],
        provenanceClaims: [],
        unavailableClaims: [],
      },
      {
        spanKind: LLM,
        presentFields: [role, role],
        provenanceClaims: [claim(role, "native-artifact")],
        unavailableClaims: [],
      },
      {
        spanKind: LLM,
        presentFields: [role],
        provenanceClaims: [claim(role, "native-artifact")],
        unavailableClaims: [
          {
            field: role,
            source: "derived",
            state: "redacted",
            reason: "policy-redacted",
          },
        ],
      },
      {
        spanKind: LLM,
        presentFields: [],
        provenanceClaims: [],
        unavailableClaims: [
          {
            field: "llm.input_messages.0",
            source: "derived",
            state: "unavailable",
            reason: "not-emitted",
          },
        ],
      },
      {
        spanKind: LLM,
        presentFields: ["attacker.secret"],
        provenanceClaims: [claim("attacker.secret", "derived")],
        unavailableClaims: [],
      },
      {
        spanKind: "ATTACKER",
        presentFields: ["span.name"],
        provenanceClaims: [claim("span.name", "derived")],
        unavailableClaims: [],
      },
      {
        spanKind: LLM,
        presentFields: [`llm.${"x".repeat(1_025)}`],
        provenanceClaims: [claim(`llm.${"x".repeat(1_025)}`, "derived")],
        unavailableClaims: [],
      },
    ] as const;
    for (const input of invalidInputs) {
      expect(() => buildSpanEvidenceLedger(input)).toThrowError(
        "protocol.provenance-ledger.invalid",
      );
    }
  });
});

describe("provenance builder boundaries", () => {
  it("rejects claim overflow and ambiguous resolver input", () => {
    const fields = Array.from({ length: 193 }, (_, index) => `span.${index}`);
    expect(() =>
      buildSpanEvidenceLedger({
        spanKind: LLM,
        presentFields: fields,
        provenanceClaims: fields.map((field) => claim(field, "derived")),
        unavailableClaims: [],
      }),
    ).toThrow(ProvenanceLedgerError);
    expect(() =>
      resolveFieldProvenance({
        spanKind: LLM,
        field: role,
        provenance: [claim(role, "derived"), claim(role, "native-artifact")],
      }),
    ).toThrow(ProvenanceLedgerError);
    expect(() =>
      resolveFieldProvenance({
        spanKind: LLM,
        field: role,
        provenance: [
          { field: "llm.input_messages.0", source: "derived" },
          { field: "llm.input_messages.0", source: "native-artifact" },
        ],
      }),
    ).toThrow(ProvenanceLedgerError);
    expect(() =>
      resolveFieldProvenance({
        spanKind: LLM,
        field: "attacker.secret",
        provenance: [],
      }),
    ).toThrow(ProvenanceLedgerError);
  });

  it("retains bounded timing provenance values for structural fields", () => {
    const ledger = buildSpanEvidenceLedger({
      spanKind: LLM,
      presentFields: ["span.start_time_unix_nano", "span.end_time_unix_nano"],
      provenanceClaims: [
        {
          field: "span.start_time_unix_nano",
          source: "native-artifact",
          timingBasis: "native-interval",
          nativeState: "observed",
        },
        {
          field: "span.end_time_unix_nano",
          source: "native-artifact",
          timingBasis: "native-interval",
          nativeState: "observed",
        },
      ],
      unavailableClaims: [],
    });
    expect(ledger.provenance).toHaveLength(2);
  });

  it("accepts the exact governed-row boundary and rejects doubled unavailable rows", () => {
    const fields = Array.from(
      { length: 192 },
      (_, index) => `llm.input_messages.${index}.message.role`,
    );
    expect(
      buildSpanEvidenceLedger({
        spanKind: LLM,
        presentFields: fields,
        provenanceClaims: fields.map((field, index) =>
          claim(field, index % 2 === 0 ? "derived" : "native-artifact"),
        ),
        unavailableClaims: [],
      }).provenance,
    ).toHaveLength(192);
    const unavailableFields = fields.slice(0, 97);
    expect(() =>
      buildSpanEvidenceLedger({
        spanKind: LLM,
        presentFields: [],
        provenanceClaims: [],
        unavailableClaims: unavailableFields.map((field) => ({
          field,
          source: "native-artifact" as const,
          state: "unavailable" as const,
          reason: "not-emitted" as const,
        })),
      }),
    ).toThrow(ProvenanceLedgerError);
  });
});

describe("provenance builder hostile and wire boundaries", () => {
  it("rejects ledgers over the serialized wire budget", () => {
    const fields = Array.from(
      { length: 192 },
      (_, index) =>
        `llm.input_messages.9999.message.contents.${9000 + index}.tool_call.reasoning_signature`,
    );
    expect(() =>
      buildSpanEvidenceLedger({
        spanKind: LLM,
        presentFields: fields,
        provenanceClaims: fields.map((field, index) =>
          claim(field, index % 2 === 0 ? "derived" : "native-artifact"),
        ),
        unavailableClaims: [],
      }),
    ).toThrow(ProvenanceLedgerError);
    const small = buildSpanEvidenceLedger({
      spanKind: LLM,
      presentFields: [role],
      provenanceClaims: [claim(role, "native-artifact")],
      unavailableClaims: [],
    });
    expect(parseFieldProvenance(JSON.stringify(small.provenance)).success).toBe(
      true,
    );
  });

  it("sanitizes hostile inputs and keeps query helpers total", () => {
    const canary = "CANARY_SECRET";
    for (const unsafe of [
      null,
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error(canary);
          },
        },
      ),
    ]) {
      expect(() => buildSpanEvidenceLedger(unsafe as never)).toThrowError(
        "protocol.provenance-ledger.invalid",
      );
    }
    expect(() =>
      resolveFieldProvenance({
        spanKind: LLM,
        field: role,
        provenance: null as never,
      }),
    ).toThrowError("protocol.provenance-ledger.invalid");
    expect(() =>
      resolveFieldProvenance({
        spanKind: LLM,
        field: role,
        provenance: new Proxy([], {
          getOwnPropertyDescriptor() {
            throw new Error(canary);
          },
        }),
      }),
    ).toThrowError("protocol.provenance-ledger.invalid");
    expect(() =>
      resolveFieldProvenance({
        spanKind: LLM,
        field: role,
        provenance: [
          {
            field: "llm.input_messages.0",
            source: "ATTACKER",
            timingBasis: "native-interval",
          },
        ] as never,
      }),
    ).toThrowError("protocol.provenance-ledger.invalid");
    expect(getProvenanceTargets(null as never, LLM)).toBeUndefined();
    expect(isProvenanceGroupField(null as never, LLM)).toBe(false);
  });
});

describe("provenance builder plain-data preflight", () => {
  it("rejects accessors, holes, extra keys, and resolver overflow", () => {
    let invoked = false;
    const accessor = {
      spanKind: LLM,
      presentFields: [role],
      provenanceClaims: [claim(role, "native-artifact")],
      unavailableClaims: [],
    };
    Object.defineProperty(accessor, "spanKind", {
      enumerable: true,
      get() {
        invoked = true;
        return LLM;
      },
    });
    expect(() => buildSpanEvidenceLedger(accessor as never)).toThrow(
      ProvenanceLedgerError,
    );
    expect(invoked).toBe(false);

    const holes = new Array(1);
    const extra = [role] as string[] & { extra?: string };
    extra.extra = "x";
    for (const presentFields of [holes, extra]) {
      expect(() =>
        buildSpanEvidenceLedger({
          spanKind: LLM,
          presentFields,
          provenanceClaims: [],
          unavailableClaims: [],
        }),
      ).toThrow(ProvenanceLedgerError);
    }
    expect(() =>
      resolveFieldProvenance({
        spanKind: LLM,
        field: role,
        provenance: Array.from({ length: 193 }, () =>
          claim(role, "native-artifact"),
        ),
      }),
    ).toThrow(ProvenanceLedgerError);

    expect(() =>
      buildSpanEvidenceLedger({
        spanKind: 1 as never,
        presentFields: [],
        provenanceClaims: [],
        unavailableClaims: [],
      }),
    ).toThrow(ProvenanceLedgerError);
    expect(() =>
      buildSpanEvidenceLedger({
        spanKind: LLM,
        presentFields: [1 as never],
        provenanceClaims: [],
        unavailableClaims: [],
      }),
    ).toThrow(ProvenanceLedgerError);
    expect(() =>
      buildSpanEvidenceLedger({
        spanKind: LLM,
        presentFields: [],
        provenanceClaims: [],
        unavailableClaims: [
          {
            field: role,
            source: "derived",
            state: "unavailable",
            reason: "ATTACKER",
          } as never,
        ],
      }),
    ).toThrow(ProvenanceLedgerError);
    expect(() =>
      resolveFieldProvenance({
        spanKind: 1 as never,
        field: role,
        provenance: [],
      }),
    ).toThrow(ProvenanceLedgerError);
  });
});
