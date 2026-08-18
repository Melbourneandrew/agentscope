declare const validatedEndpointBrand: unique symbol;

export type ValidatedDestinationEndpoint = Readonly<{
  href: string;
  origin: string;
  readonly [validatedEndpointBrand]: true;
}>;

export type DestinationEndpointPolicy = Readonly<{
  allowInsecureLoopback: boolean;
}>;

const endpointRegistry = new WeakSet<object>();

export class DestinationEndpointError extends Error {
  public readonly code = "destination.endpoint.invalid";

  public constructor() {
    super("destination.endpoint.invalid");
    this.name = "DestinationEndpointError";
  }
}

const invalid = (): never => {
  throw new DestinationEndpointError();
};

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

const isIpv4Loopback = (hostname: string): boolean => {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  // WHATWG URL parsing has already canonicalized and range-checked IPv4.
  return true;
};

const isLiteralLoopback = (hostname: string): boolean =>
  hostname === "[::1]" || isIpv4Loopback(hostname);

export const isValidatedDestinationEndpoint = (
  value: unknown,
): value is ValidatedDestinationEndpoint =>
  typeof value === "object" && value !== null && endpointRegistry.has(value);

export const validateDestinationEndpoint = (
  value: unknown,
  policy: DestinationEndpointPolicy,
): ValidatedDestinationEndpoint => {
  try {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 2_048 ||
      hasLoneSurrogate(value) ||
      typeof policy !== "object" ||
      policy === null ||
      typeof policy.allowInsecureLoopback !== "boolean"
    )
      return invalid();
    const url = new URL(value);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.port === "0"
    )
      return invalid();
    if (url.protocol === "http:") {
      if (!policy.allowInsecureLoopback || !isLiteralLoopback(url.hostname))
        return invalid();
    } else if (url.protocol !== "https:") return invalid();
    const endpoint = Object.freeze({
      href: url.href,
      origin: url.origin,
    }) as ValidatedDestinationEndpoint;
    endpointRegistry.add(endpoint);
    return endpoint;
  } catch {
    return invalid();
  }
};
