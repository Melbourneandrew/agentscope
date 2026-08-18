import canonicalFixture from "./testing/fixtures/sanitized-canonical-trace.json" with { type: "json" };

const serializedCanonicalFixture = JSON.stringify(canonicalFixture);

export const createSanitizedCanonicalTraceFixture = (): unknown =>
  JSON.parse(serializedCanonicalFixture) as unknown;
