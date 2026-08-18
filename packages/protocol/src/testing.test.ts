import { describe, expect, it } from "vitest";

import { parseCanonicalTraceGraph } from "./schema/canonical-graph.js";
import { createSanitizedCanonicalTraceFixture } from "./testing.js";

describe("Protocol testing fixture export", () => {
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
});
