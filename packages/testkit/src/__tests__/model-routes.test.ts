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
    const frames = route.responseBodyText.split("\n\n").filter(Boolean);
    const events = frames.map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      const event = JSON.parse(dataLine!.slice(6)) as Record<string, unknown>;
      expect(eventLine).toBe(`event: ${String(event.type)}`);
      return event;
    });
    expect(events.map(({ type }) => type)).toEqual([
      "response.created",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[1]).toMatchObject({
      item: {
        content: [{ type: "output_text", text: "AGENTSCOPE_PTY_COMPLETE" }],
      },
    });
    expect(route.responseBodyText).not.toContain("[DONE]");
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
