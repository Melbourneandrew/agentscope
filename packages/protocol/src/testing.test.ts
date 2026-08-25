import { describe, expect, it } from "vitest";

import { parseCanonicalTraceGraph } from "./schema/canonical-graph.js";
import {
  createSanitizedCanonicalTraceFixture,
  createSanitizedRedactedCanonicalTraceFixture,
} from "./testing.js";
import { isRedactedCanonicalTrace } from "./index.js";
import * as productionExports from "./index.js";
import * as testingExports from "./testing.js";

describe("Protocol testing fixture export", () => {
  it("keeps feedback construction public and mutation authority testing-only", () => {
    expect(productionExports.createFeedbackCarrierAttributes).toBeTypeOf(
      "function",
    );
    expect(productionExports.feedbackTransportIsPostHoc).toBeTypeOf("function");
    expect(productionExports.feedbackTransportIsPostHoc("post-hoc")).toBe(true);
    expect(productionExports.feedbackTransportIsPostHoc("inline")).toBe(false);
    expect(productionExports.FEEDBACK_TRANSPORT_ATTRIBUTE_KEY).toBe(
      "agentscope.feedback.transport",
    );
    expect(testingExports.compileCompatibilityProfileForTesting).toBeTypeOf(
      "function",
    );
    expect(testingExports.validateFeedbackProfileForTesting).toBeTypeOf(
      "function",
    );
    expect(productionExports).not.toHaveProperty(
      "compileCompatibilityProfileForTesting",
    );
    expect(productionExports).not.toHaveProperty(
      "validateFeedbackProfileForTesting",
    );
  });

  it("returns fresh valid canonical fixture data", () => {
    const first = createSanitizedCanonicalTraceFixture();
    const second = createSanitizedCanonicalTraceFixture();
    expect(first).not.toBe(second);
    expect(() => parseCanonicalTraceGraph(first)).not.toThrow();
    expect(() => parseCanonicalTraceGraph(second)).not.toThrow();
    (first as { resourceSpans: unknown[] }).resourceSpans.length = 0;
    expect(
      (second as { resourceSpans: unknown[] }).resourceSpans.length,
    ).toBeGreaterThan(0);
  });

  it("creates distinct branded redacted fixtures with bounded semantic options", () => {
    const first = createSanitizedRedactedCanonicalTraceFixture({
      branchName: "main",
      harnessName: "codex",
      sequence: 1,
      sessionId: "session-a",
      startTimeUnixNano: "2000000000",
      tags: ["safe"],
      modelName: "model-a",
    });
    const second = createSanitizedRedactedCanonicalTraceFixture({
      sequence: 2,
    });
    const defaulted = createSanitizedRedactedCanonicalTraceFixture();
    expect(isRedactedCanonicalTrace(first)).toBe(true);
    expect(first.delivery.identity).not.toBe(second.delivery.identity);
    expect(defaulted.delivery.identity).not.toBe(first.delivery.identity);
    expect(JSON.stringify(first.graph)).toContain("session-a");
    expect(JSON.stringify(first.graph)).toContain("model-a");
    expect(JSON.stringify(first.graph)).toContain("main");
    expect(JSON.stringify(first.graph)).toContain("codex");
    expect(
      first.graph.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.startTimeUnixNano,
    ).toBe("2000000000");
    for (const sequence of [-1, 1.5, 32])
      expect(() =>
        createSanitizedRedactedCanonicalTraceFixture({ sequence }),
      ).toThrowError("protocol.testing.fixture.invalid");
  });
});
