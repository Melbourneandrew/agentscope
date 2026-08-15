export const agentscope = {
  framework: "agentscope",
  purpose: "agent-trace-observability",
} as const;

export * from "./native-traces/index.js";
export * from "./native-turns/index.js";
export * from "./agent-trace/index.js";
