import { z } from "zod";

const strings = z.record(z.string(), z.string());
const timeout = z.number().int().positive().optional();
const role = z.literal("comms").optional().catch(undefined);
const common = { timeout, alwaysLoad: z.boolean().optional(), role };
const permissions = z.record(z.string(), z.enum(["allow", "ask", "blocked"]));
const oauth = z.object({
  clientId: z.string().optional(),
  callbackPort: z.number().int().positive().optional(),
  authServerMetadataUrl: z.string().url().startsWith("https://").optional(),
  scopes: z.string().min(1).optional(),
  xaa: z.boolean().optional(),
});
const network = {
  url: z.string(),
  headers: strings.optional(),
  headersHelper: z.string().optional(),
  oauth: oauth.optional(),
  request_timeout_ms: z.number().int().positive().optional().catch(undefined),
  tools: z
    .array(
      z.object({
        name: z.string(),
        permission_policy: z
          .enum(["always_allow", "always_ask", "always_deny"])
          .optional(),
      }),
    )
    .optional(),
  discoveryCache: z.boolean().optional(),
  toolPermissions: permissions.optional(),
  ...common,
};
const foldTimeout = <
  T extends {
    request_timeout_ms?: number | undefined;
    timeout?: number | undefined;
  },
>(
  value: T,
) => {
  const { request_timeout_ms: hint, ...rest } = value;
  return {
    ...rest,
    ...(rest.timeout === undefined && hint !== undefined
      ? { timeout: Math.min(hint, 300_000) }
      : {}),
  };
};
const ide = {
  url: z.string(),
  ideName: z.string(),
  ideRunningInWindows: z.boolean().optional(),
  ...common,
};

export const catalogMcpServer = z.union([
  z.object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: strings.optional(),
    ...common,
  }),
  z.object({ type: z.literal("sse"), ...network }).transform(foldTimeout),
  z.object({ type: z.literal("sse-ide"), ...ide }),
  z.object({
    type: z.literal("ws-ide"),
    authToken: z.string().optional(),
    ...ide,
  }),
  z
    .object({
      type: z
        .enum(["http", "streamable-http"])
        .transform(() => "http" as const),
      ...network,
    })
    .transform(foldTimeout),
  z.object({
    type: z.literal("ws"),
    url: z.string(),
    headers: strings.optional(),
    headersHelper: z.string().optional(),
    ...common,
  }),
  z.object({
    type: z.literal("sdk"),
    name: z.string(),
    timeout,
    alwaysLoad: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("claudeai-proxy"),
    url: z.string(),
    id: z.string(),
    displayName: z.string().optional(),
    iconUrl: z.string().optional(),
    timeout,
    alwaysLoad: z.boolean().optional(),
    toolPermissions: permissions.optional(),
    stateless: z.boolean().optional(),
    cachedInitResponse: z.record(z.string(), z.unknown()).nullish(),
    discoverSupport: z
      .enum(["supported", "legacy", "unknown"])
      .optional()
      .catch(undefined),
    cachedDiscoverResponse: z.record(z.string(), z.unknown()).nullish(),
    eligible: z.boolean().nullish(),
    ineligibleReason: z.string().nullish(),
    enterpriseManaged: z.boolean().optional(),
  }),
]);

const hookCommon = {
  if: z.string().optional(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
};
const cloud = z.enum(["device", "skip"]).optional().catch("skip");
const hook = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("command"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    shell: z.enum(["bash", "powershell"]).optional(),
    async: z.boolean().optional(),
    asyncRewake: z.boolean().optional(),
    rewakeMessage: z.string().min(1).optional(),
    rewakeSummary: z.string().min(1).optional(),
    cloud,
    ...hookCommon,
  }),
  z.object({
    type: z.literal("prompt"),
    prompt: z.string(),
    model: z.string().optional(),
    continueOnBlock: z.boolean().optional(),
    ...hookCommon,
  }),
  z.object({
    type: z.literal("agent"),
    prompt: z.string(),
    model: z.string().optional(),
    ...hookCommon,
  }),
  z.object({
    type: z.literal("mcp_tool"),
    server: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    ...hookCommon,
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
    headers: strings.optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    cloud,
    ...hookCommon,
  }),
]);
// A record keyed by an enum must stay partial in Zod 4: the vendor's record
// accepts any subset, not a required property for every event.
const events = z.enum([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "DirectoryAdded",
  "MessageDisplay",
]);
export const catalogHooks = z.partialRecord(
  events,
  z.array(
    z.object({
      matcher: z.string().optional(),
      hooks: z.array(hook),
    }),
  ),
);

const unavailable = (): Error =>
  new Error("cli.harness.plugin-inventory-unavailable");

const dataRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined;

// This is only a projection of already parsed JSON, not a command interpreter.
// Unknown declarations cannot become evidence of an empty hook collection.
export const claudePluginHookEventNames = (
  value: unknown,
): readonly string[] => {
  const record = (value: unknown): Record<string, unknown> => {
    const result = dataRecord(value);
    if (result === undefined) throw unavailable();
    return result;
  };
  const hooks = record(value);
  const events = Object.keys(hooks);
  if (events.length > 64) throw unavailable();
  for (const event of events) {
    const matchers = hooks[event];
    if (
      event.length === 0 ||
      Buffer.byteLength(event, "utf8") > 128 ||
      !Array.isArray(matchers) ||
      matchers.length > 64
    )
      throw unavailable();
    for (const matcher of matchers) {
      const entry = record(matcher);
      if (
        (entry.matcher !== undefined && typeof entry.matcher !== "string") ||
        !Array.isArray(entry.hooks) ||
        entry.hooks.length > 64
      )
        throw unavailable();
      for (const handler of entry.hooks) {
        const hook = record(handler);
        // Named native module hooks require a separate observed module closure.
        if (
          !["command", "prompt", "agent"].includes(hook.type as string) ||
          (hook.type === "command" && typeof hook.command !== "string") ||
          (hook.type !== "command" && typeof hook.prompt !== "string")
        )
          throw unavailable();
      }
    }
  }
  // Native dispatch executes the matcher handlers; a parsed empty matcher or
  // handler array is not an execution/ownership observation for that event.
  return Object.freeze(
    events.filter((event) =>
      (hooks[event] as { hooks: unknown[] }[]).some(
        (matcher) => matcher.hooks.length > 0,
      ),
    ),
  );
};
