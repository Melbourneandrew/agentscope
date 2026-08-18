import { describe, expect, it } from "vitest";

import {
  createMockServerInitialization,
  MODEL_PROTOCOL_ROUTES,
} from "../model-routes.js";

describe("model protocol routes", () => {
  it("defines the exact extensible provider inventory", () => {
    expect(MODEL_PROTOCOL_ROUTES.map(({ routeId }) => routeId)).toEqual([
      "openai-responses",
      "openai-chat-completions",
      "anthropic-messages",
      "gemini-generate-content",
    ]);
    expect(new Set(MODEL_PROTOCOL_ROUTES.map(({ path }) => path)).size).toBe(4);
    expect(MODEL_PROTOCOL_ROUTES.every(Object.isFrozen)).toBe(true);
    expect(
      MODEL_PROTOCOL_ROUTES.every(
        ({ requestBody, responseBody }) =>
          Object.isFrozen(requestBody) && Object.isFrozen(responseBody),
      ),
    ).toBe(true);
  });

  it("compiles deterministic strict MockServer expectations", () => {
    const first = createMockServerInitialization();
    const second = createMockServerInitialization();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(
      first.every(
        (expectation) =>
          typeof expectation === "object" &&
          expectation !== null &&
          Object.isFrozen(expectation),
      ),
    ).toBe(true);
  });
});
