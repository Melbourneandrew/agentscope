export type ModelProtocolProvider =
  "openai-responses" | "openai-chat" | "anthropic" | "gemini";

export interface ModelProtocolRoute {
  readonly routeId: string;
  readonly provider: ModelProtocolProvider;
  readonly method: "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestBody: Readonly<Record<string, unknown>>;
  readonly responseBody: Readonly<Record<string, unknown>>;
}

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const MODEL_PROTOCOL_ROUTES = deepFreeze([
  {
    routeId: "openai-responses",
    provider: "openai-responses",
    method: "POST",
    path: "/v1/responses",
    headers: {
      authorization: "Bearer DUMMY_OPENAI_KEY",
      "content-type": "application/json",
    },
    requestBody: {
      model: "fixture-model",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "FIXTURE_PROMPT" }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "fixture_tool",
          description: "fixture tool",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    responseBody: {
      id: "resp_fixture",
      object: "response",
      status: "completed",
      output: [
        {
          id: "call_fixture",
          type: "function_call",
          call_id: "call_fixture",
          name: "fixture_tool",
          arguments: "{}",
          status: "completed",
        },
      ],
      usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
    },
  },
  {
    routeId: "openai-chat-completions",
    provider: "openai-chat",
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      authorization: "Bearer DUMMY_OPENAI_KEY",
      "content-type": "application/json",
    },
    requestBody: {
      model: "fixture-model",
      messages: [{ role: "user", content: "FIXTURE_PROMPT" }],
      tools: [
        {
          type: "function",
          function: {
            name: "fixture_tool",
            description: "fixture tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    },
    responseBody: {
      id: "chatcmpl_fixture",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_fixture",
                type: "function",
                function: { name: "fixture_tool", arguments: "{}" },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    },
  },
  {
    routeId: "anthropic-messages",
    provider: "anthropic",
    method: "POST",
    path: "/v1/messages",
    headers: {
      "x-api-key": "DUMMY_ANTHROPIC_KEY",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    requestBody: {
      model: "fixture-model",
      max_tokens: 64,
      messages: [{ role: "user", content: "FIXTURE_PROMPT" }],
      tools: [
        {
          name: "fixture_tool",
          description: "fixture tool",
          input_schema: { type: "object", properties: {} },
        },
      ],
    },
    responseBody: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "fixture-model",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_fixture",
          name: "fixture_tool",
          input: {},
        },
      ],
      usage: { input_tokens: 11, output_tokens: 3 },
    },
  },
  {
    routeId: "gemini-generate-content",
    provider: "gemini",
    method: "POST",
    path: "/v1beta/models/fixture-model:generateContent",
    query: { key: "DUMMY_GEMINI_KEY" },
    headers: { "content-type": "application/json" },
    requestBody: {
      contents: [{ role: "user", parts: [{ text: "FIXTURE_PROMPT" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "fixture_tool",
              description: "fixture tool",
              parameters: { type: "OBJECT", properties: {} },
            },
          ],
        },
      ],
    },
    responseBody: {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [{ functionCall: { name: "fixture_tool", args: {} } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 },
    },
  },
] as const satisfies readonly ModelProtocolRoute[]);

export const createMockServerInitialization = (): readonly unknown[] =>
  deepFreeze(
    MODEL_PROTOCOL_ROUTES.map((fixture) => {
      const route: ModelProtocolRoute = fixture;
      return {
        id: route.routeId,
        priority: 100,
        httpRequest: {
          method: route.method,
          path: route.path,
          ...(route.query === undefined
            ? {}
            : {
                queryStringParameters: Object.fromEntries(
                  Object.entries(route.query).map(([key, value]) => [
                    key,
                    [value],
                  ]),
                ),
              }),
          headers: Object.fromEntries(
            Object.entries(route.headers).map(([key, value]) => [key, [value]]),
          ),
          body: {
            type: "JSON",
            json: JSON.stringify(route.requestBody),
            matchType: "STRICT",
          },
        },
        httpResponse: {
          statusCode: 200,
          headers: { "content-type": ["application/json"] },
          body: JSON.stringify(route.responseBody),
        },
        times: { unlimited: true },
        timeToLive: { unlimited: true },
      };
    }),
  );
