import {
  isReporterDeadline,
  reporterDeadlineRemainingMilliseconds,
  type ReporterDeadline,
} from "./deadline.js";
import {
  isValidatedDestinationEndpoint,
  type ValidatedDestinationEndpoint,
} from "./endpoint.js";

declare const boundTransportBrand: unique symbol;

export type BoundDestinationTransport = Readonly<{
  endpoint: ValidatedDestinationEndpoint;
  readonly [boundTransportBrand]: true;
}>;

export type DestinationTransportRequest = Readonly<{
  method: "GET" | "POST" | "PUT" | "DELETE";
  pathAndQuery: string;
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  signal: AbortSignal;
  deadline: ReporterDeadline;
}>;

export type DestinationTransportResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

export type DestinationTransportExecutor = (
  request: Readonly<{
    method: DestinationTransportRequest["method"];
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: Uint8Array;
    signal: AbortSignal;
    deadline: ReporterDeadline;
  }>,
) => Promise<DestinationTransportResponse>;

const executorRegistry = new WeakMap<object, DestinationTransportExecutor>();
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectKeys = Object.keys;
const textEncoder = new TextEncoder();
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before caller-controlled prototype mutation.
const abortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

export const MAXIMUM_TRANSPORT_REQUEST_BYTES = 16 * 1_024 * 1_024;
export const MAXIMUM_TRANSPORT_RESPONSE_BYTES = 1 * 1_024 * 1_024;
export const MAXIMUM_TRANSPORT_PATH_AND_QUERY_BYTES = 128 * 1_024;

export class DestinationTransportError extends Error {
  public readonly code = "destination.transport.invalid";

  public constructor() {
    super("destination.transport.invalid");
    this.name = "DestinationTransportError";
  }
}

const invalid = (): never => {
  throw new DestinationTransportError();
};

const signalIsValid = (signal: unknown): signal is AbortSignal => {
  try {
    return (
      typeof abortedGetter === "function" &&
      typeof Reflect.apply(abortedGetter, signal, []) === "boolean"
    );
  } catch {
    return false;
  }
};

const signalIsAborted = (signal: AbortSignal): boolean =>
  Reflect.apply(abortedGetter as () => boolean, signal, []);

const attemptCanStart = (
  signal: AbortSignal,
  deadline: ReporterDeadline,
): boolean =>
  !signalIsAborted(signal) &&
  reporterDeadlineRemainingMilliseconds(deadline) > 0;

const cloneHeaders = (input: unknown): Readonly<Record<string, string>> => {
  if (
    typeof input !== "object" ||
    input === null ||
    (objectGetPrototypeOf(input) !== Object.prototype &&
      objectGetPrototypeOf(input) !== null)
  )
    return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(input);
  const keys = objectKeys(descriptors).sort();
  if (keys.length > 64) return invalid();
  const output: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let totalBytes = 0;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      key.length > 256 ||
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) ||
      ["connection", "content-length", "host", "transfer-encoding"].includes(
        key,
      ) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > 8_192 ||
      /[\r\n]/u.test(descriptor.value)
    )
      return invalid();
    totalBytes +=
      textEncoder.encode(key).byteLength +
      textEncoder.encode(descriptor.value).byteLength;
    if (totalBytes > 32_768) return invalid();
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
};

const cloneBody = (value: unknown, maximum: number): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum)
    return invalid();
  return Uint8Array.from(value);
};

const cloneResponse = (value: unknown): DestinationTransportResponse => {
  if (typeof value !== "object" || value === null) return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(value);
  if (objectKeys(descriptors).sort().join(",") !== "body,headers,status")
    return invalid();
  const status = descriptors.status;
  const headers = descriptors.headers;
  const body = descriptors.body;
  if (
    !status ||
    !("value" in status) ||
    !Number.isInteger(status.value) ||
    status.value < 100 ||
    status.value > 599 ||
    !headers ||
    !("value" in headers) ||
    !body ||
    !("value" in body)
  )
    return invalid();
  return Object.freeze({
    status: status.value as number,
    headers: cloneHeaders(headers.value),
    body: cloneBody(body.value, MAXIMUM_TRANSPORT_RESPONSE_BYTES),
  });
};

export const bindDestinationTransport = (
  endpoint: ValidatedDestinationEndpoint,
  executor: DestinationTransportExecutor,
): BoundDestinationTransport => {
  if (
    !isValidatedDestinationEndpoint(endpoint) ||
    typeof executor !== "function"
  )
    return invalid();
  const transport = Object.freeze({ endpoint }) as BoundDestinationTransport;
  executorRegistry.set(transport, executor);
  return transport;
};

export const isBoundDestinationTransport = (
  value: unknown,
): value is BoundDestinationTransport =>
  typeof value === "object" && value !== null && executorRegistry.has(value);

const isRelativePathAndQuery = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAXIMUM_TRANSPORT_PATH_AND_QUERY_BYTES &&
  textEncoder.encode(value).byteLength <=
    MAXIMUM_TRANSPORT_PATH_AND_QUERY_BYTES &&
  value.startsWith("/") &&
  !value.startsWith("//");

export const executeBoundDestinationRequest = async (
  transport: BoundDestinationTransport,
  request: DestinationTransportRequest,
): Promise<DestinationTransportResponse> => {
  try {
    const executor = executorRegistry.get(transport);
    if (!executor || typeof request !== "object" || request === null)
      return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(request);
    const keys = objectKeys(descriptors).sort();
    if (
      keys.some(
        (key) =>
          ![
            "body",
            "deadline",
            "headers",
            "method",
            "pathAndQuery",
            "signal",
          ].includes(key),
      ) ||
      !descriptors.method ||
      !("value" in descriptors.method) ||
      !["GET", "POST", "PUT", "DELETE"].includes(descriptors.method.value) ||
      !descriptors.pathAndQuery ||
      !("value" in descriptors.pathAndQuery) ||
      !isRelativePathAndQuery(descriptors.pathAndQuery.value) ||
      !descriptors.headers ||
      !("value" in descriptors.headers) ||
      !descriptors.signal ||
      !("value" in descriptors.signal) ||
      !signalIsValid(descriptors.signal.value) ||
      !descriptors.deadline ||
      !("value" in descriptors.deadline) ||
      !isReporterDeadline(descriptors.deadline.value)
    )
      return invalid();
    const url = new URL(
      descriptors.pathAndQuery.value,
      transport.endpoint.href,
    );
    if (
      url.origin !== transport.endpoint.origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    )
      return invalid();
    const bodyDescriptor = descriptors.body;
    const body = bodyDescriptor
      ? "value" in bodyDescriptor
        ? cloneBody(bodyDescriptor.value, MAXIMUM_TRANSPORT_REQUEST_BYTES)
        : invalid()
      : undefined;
    const normalized = Object.freeze({
      method: descriptors.method.value,
      url: url.href,
      headers: cloneHeaders(descriptors.headers.value),
      ...(body ? { body } : {}),
      signal: descriptors.signal.value,
      deadline: descriptors.deadline.value,
    });
    if (!attemptCanStart(normalized.signal, normalized.deadline))
      return invalid();
    return cloneResponse(await executor(normalized));
  } catch {
    return invalid();
  }
};
