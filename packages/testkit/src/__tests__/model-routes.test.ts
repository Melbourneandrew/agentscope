import { describe, expect, it } from "vitest";

import {
  createMockServerInitialization,
  MODEL_PROTOCOL_ROUTES,
} from "../model-routes.js";

describe("model protocol routes", () => {
  it("defines the exact extensible provider inventory", () => {
    expect(MODEL_PROTOCOL_ROUTES.map(({ routeId }) => routeId)).toEqual([
      "codex-tui-responses",
      "openai-responses",
      "openai-chat-completions",
      "anthropic-messages",
      "gemini-generate-content",
    ]);
    expect(new Set(MODEL_PROTOCOL_ROUTES.map(({ path }) => path)).size).toBe(4);
    expect(MODEL_PROTOCOL_ROUTES.every(Object.isFrozen)).toBe(true);
    expect(
      MODEL_PROTOCOL_ROUTES.every(
        (route) =>
          (!("requestBody" in route) || Object.isFrozen(route.requestBody)) &&
          (!("responseBody" in route) || Object.isFrozen(route.responseBody)),
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

  it("keeps the Codex TUI response independent of its runtime prompt", () => {
    const route = MODEL_PROTOCOL_ROUTES[0];
    expect(route).toMatchObject({
      routeId: "codex-tui-responses",
      headers: { "content-type": "application/json" },
    });
    expect("requestBody" in route).toBe(false);
    expect(route.responseBodyText).not.toContain("AGENTSCOPE_PTY_COMPLETE");
    expect(
      route.responseBodyText
        .split("\n\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)) as { type: string })
        .map(({ type }) => type),
    ).toEqual([
      "response.created",
      "response.output_item.done",
      "response.completed",
    ]);
    const expectation = createMockServerInitialization()[0] as {
      httpRequest: Record<string, unknown>;
      httpResponse: { headers: Record<string, readonly string[]> };
    };
    expect(expectation.httpRequest).not.toHaveProperty("body");
    expect(expectation.httpRequest).not.toHaveProperty("authorization");
    expect(expectation.httpResponse.headers["content-type"]).toEqual([
      "text/event-stream",
    ]);
  });
});
