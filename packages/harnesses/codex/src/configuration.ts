const providerId = "agentscope_internal";
const safeModelPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const safeInternalHostPattern = /^[a-z][a-z0-9-]{0,62}$/u;

export class CodexConfigurationError extends Error {
  public readonly code = "codex.configuration.invalid";

  public constructor() {
    super("codex.configuration.invalid");
    this.name = "CodexConfigurationError";
  }
}

const invalid = (): never => {
  throw new CodexConfigurationError();
};

const exactInput = (
  input: Readonly<{ baseUrl: string; model: string }>,
): Readonly<{ baseUrl: string; model: string }> => {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).sort().join("\0") !== "baseUrl\0model" ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return invalid();
    const baseUrl = descriptors.baseUrl?.value as unknown;
    const model = descriptors.model?.value as unknown;
    if (
      typeof baseUrl !== "string" ||
      typeof model !== "string" ||
      !safeModelPattern.test(model)
    )
      return invalid();
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    const allowedHost =
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "localhost" ||
      safeInternalHostPattern.test(hostname);
    if (
      parsed.protocol !== "http:" ||
      !allowedHost ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port === "" ||
      parsed.pathname !== "/v1" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    )
      return invalid();
    const port = Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      return invalid();
    return Object.freeze({ baseUrl: parsed.href, model });
  } catch (error) {
    if (error instanceof CodexConfigurationError) throw error;
    return invalid();
  }
};

export const createCodexInternalProviderConfiguration = (
  input: Readonly<{ baseUrl: string; model: string }>,
): string => {
  const parsed = exactInput(input);
  return [
    `model = ${JSON.stringify(parsed.model)}`,
    `model_provider = ${JSON.stringify(providerId)}`,
    "check_for_update_on_startup = false",
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    "",
    "[otel]",
    "log_user_prompt = false",
    'trace_exporter = "none"',
    'metrics_exporter = "none"',
    "",
    `[model_providers.${providerId}]`,
    'name = "Agentscope internal model"',
    `base_url = ${JSON.stringify(parsed.baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "",
  ].join("\n");
};
