import {
  isReporterDeadline,
  reporterDeadlineRemainingMilliseconds,
  type ReporterDeadline,
} from "./deadline.js";
import {
  createDestinationConnectionId,
  createDestinationTypeId,
  type DestinationConnectionId,
  type DestinationTypeId,
} from "./identity.js";
import { cloneJsonObject, type JsonValue } from "./plain-data.js";
import {
  isRetrievedTrace,
  isRetrieverSearchPage,
  type RetrievedTrace,
  type RetrieverSearchPage,
} from "./retrieval-results.js";
import { isTraceLocator, type TraceLocator } from "./retrieval-identity.js";
import {
  isTraceSearchQuery,
  type TraceSearchQuery,
} from "./retrieval-query.js";

export const RETRIEVER_FAILURE_CODES = Object.freeze([
  "invalid-query",
  "unknown-connection",
  "retrieval-unsupported",
  "unauthorized",
  "forbidden",
  "rate-limited",
  "unavailable",
  "deadline-exceeded",
  "malformed-response",
  "incompatible-trace",
  "not-found",
] as const);
export type RetrieverFailureCode = (typeof RETRIEVER_FAILURE_CODES)[number];

declare const retrieverFailureBrand: unique symbol;
declare const traceSearchRequestBrand: unique symbol;
declare const traceGetRequestBrand: unique symbol;
declare const retrievalContextBrand: unique symbol;
declare const retrieverBrand: unique symbol;

export type RetrieverFailure = Readonly<{
  ok: false;
  code: RetrieverFailureCode;
  retryAfterMilliseconds?: number;
  readonly [retrieverFailureBrand]: true;
}>;

export type TraceSearchRequest = Readonly<{
  query: TraceSearchQuery;
  connectionId: DestinationConnectionId;
  destinationType: DestinationTypeId;
  continuationToken?: JsonValue;
  readonly [traceSearchRequestBrand]: true;
}>;

export type TraceGetRequest = Readonly<{
  locator: TraceLocator;
  readonly [traceGetRequestBrand]: true;
}>;

export type TraceGetBinding = Readonly<{
  connectionId: DestinationConnectionId;
  destinationType: DestinationTypeId;
}>;

export type RetrievalContext = Readonly<{
  signal: AbortSignal;
  deadline: ReporterDeadline;
  maximumResponseBytes: number;
  maximumProviderRequests: number;
  readonly [retrievalContextBrand]: true;
}>;

export type RetrieverOperationResult<T> =
  Readonly<{ ok: true; value: T }> | RetrieverFailure;

export type RetrieverImplementation = Readonly<{
  search: (
    request: TraceSearchRequest,
    context: RetrievalContext,
  ) => Promise<RetrieverOperationResult<RetrieverSearchPage>>;
  get: (
    request: TraceGetRequest,
    context: RetrievalContext,
  ) => Promise<RetrieverOperationResult<RetrievedTrace>>;
}>;

export type Retriever = Readonly<{ readonly [retrieverBrand]: true }>;

const failureRegistry = new WeakSet<object>();
const searchRequestRegistry = new WeakSet<object>();
const getRequestRegistry = new WeakSet<object>();
const contextRegistry = new WeakSet<object>();
const retrieverRegistry = new WeakMap<object, RetrieverImplementation>();
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectKeys = Object.keys;
const reflectApply = Reflect.apply;
const textEncoder = new TextEncoder();
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before caller-controlled prototype mutation.
const promiseThen = Promise.prototype.then;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before caller-controlled prototype mutation.
const eventTargetAdd = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before caller-controlled prototype mutation.
const eventTargetRemove = EventTarget.prototype.removeEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked against a candidate signal.
const abortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

export class RetrieverContractError extends Error {
  public readonly code = "destination.retriever.invalid";

  public constructor() {
    super("destination.retriever.invalid");
    this.name = "RetrieverContractError";
  }
}

const invalid = (): never => {
  throw new RetrieverContractError();
};

const signalIsAborted = (signal: unknown): boolean | undefined => {
  try {
    /* v8 ignore next -- Node exposes the AbortSignal intrinsic. */
    if (typeof abortedGetter !== "function") return undefined;
    return reflectApply(abortedGetter, signal, []) as boolean;
  } catch {
    return undefined;
  }
};

export const createRetrieverFailure = (
  code: RetrieverFailureCode,
  retryAfterMilliseconds?: number,
): RetrieverFailure => {
  if (
    !RETRIEVER_FAILURE_CODES.includes(code) ||
    (retryAfterMilliseconds !== undefined &&
      (!Number.isSafeInteger(retryAfterMilliseconds) ||
        retryAfterMilliseconds < 0 ||
        retryAfterMilliseconds > 3_600_000 ||
        !["rate-limited", "unavailable"].includes(code)))
  )
    return invalid();
  const failure = Object.freeze({
    ok: false as const,
    code,
    ...(retryAfterMilliseconds === undefined ? {} : { retryAfterMilliseconds }),
  }) as RetrieverFailure;
  failureRegistry.add(failure);
  return failure;
};

export const isRetrieverFailure = (value: unknown): value is RetrieverFailure =>
  typeof value === "object" && value !== null && failureRegistry.has(value);

export const createTraceSearchRequest = (
  query: TraceSearchQuery,
  binding: TraceGetBinding,
  continuationToken?: JsonValue,
): TraceSearchRequest => {
  if (!isTraceSearchQuery(query)) return invalid();
  if (typeof binding !== "object" || binding === null) return invalid();
  const bindingDescriptors = objectGetOwnPropertyDescriptors(binding);
  if (
    Reflect.ownKeys(bindingDescriptors).some(
      (key) => typeof key !== "string",
    ) ||
    objectKeys(bindingDescriptors).sort().join(",") !==
      "connectionId,destinationType" ||
    !bindingDescriptors.connectionId ||
    !("value" in bindingDescriptors.connectionId) ||
    !bindingDescriptors.destinationType ||
    !("value" in bindingDescriptors.destinationType)
  )
    return invalid();
  const request = Object.freeze({
    query,
    connectionId: createDestinationConnectionId(
      bindingDescriptors.connectionId.value,
    ),
    destinationType: createDestinationTypeId(
      bindingDescriptors.destinationType.value,
    ),
    ...(continuationToken === undefined
      ? {}
      : {
          continuationToken: cloneJsonObject({ value: continuationToken })[
            "value"
          ]!,
        }),
  }) as TraceSearchRequest;
  searchRequestRegistry.add(request);
  return request;
};

export const createTraceGetRequest = (
  locator: TraceLocator,
  binding: TraceGetBinding,
): TraceGetRequest => {
  if (
    !isTraceLocator(locator) ||
    typeof binding !== "object" ||
    binding === null
  )
    return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(binding);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    objectKeys(descriptors).sort().join(",") !==
      "connectionId,destinationType" ||
    !descriptors.connectionId ||
    !("value" in descriptors.connectionId) ||
    !descriptors.destinationType ||
    !("value" in descriptors.destinationType) ||
    descriptors.connectionId.value !== locator.connectionId ||
    descriptors.destinationType.value !== locator.destinationType
  )
    return invalid();
  const request = Object.freeze({ locator }) as TraceGetRequest;
  getRequestRegistry.add(request);
  return request;
};

export const createRetrievalContext = (input: {
  signal: AbortSignal;
  deadline: ReporterDeadline;
  maximumResponseBytes: number;
  maximumProviderRequests: number;
}): RetrievalContext => {
  try {
    if (typeof input !== "object" || input === null) return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      objectKeys(descriptors).sort().join(",") !==
        "deadline,maximumProviderRequests,maximumResponseBytes,signal"
    )
      return invalid();
    const signal = descriptors.signal;
    const deadline = descriptors.deadline;
    const maximumResponseBytes = descriptors.maximumResponseBytes;
    const maximumProviderRequests = descriptors.maximumProviderRequests;
    if (
      !signal ||
      !("value" in signal) ||
      signalIsAborted(signal.value) === undefined ||
      !deadline ||
      !("value" in deadline) ||
      !isReporterDeadline(deadline.value) ||
      !maximumResponseBytes ||
      !("value" in maximumResponseBytes) ||
      !Number.isSafeInteger(maximumResponseBytes.value) ||
      maximumResponseBytes.value < 1 ||
      maximumResponseBytes.value > 8 * 1_024 * 1_024 ||
      !maximumProviderRequests ||
      !("value" in maximumProviderRequests) ||
      !Number.isSafeInteger(maximumProviderRequests.value) ||
      maximumProviderRequests.value < 1 ||
      maximumProviderRequests.value > 16
    )
      return invalid();
    const context = Object.freeze({
      signal: signal.value,
      deadline: deadline.value,
      maximumResponseBytes: maximumResponseBytes.value,
      maximumProviderRequests: maximumProviderRequests.value,
    }) as RetrievalContext;
    contextRegistry.add(context);
    return context;
  } catch {
    return invalid();
  }
};

export const createDestinationRetriever = (
  implementation: RetrieverImplementation,
): Retriever => {
  try {
    if (typeof implementation !== "object" || implementation === null)
      return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(implementation);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      objectKeys(descriptors).sort().join(",") !== "get,search"
    )
      return invalid();
    const get = descriptors.get;
    const search = descriptors.search;
    if (
      !get ||
      !("value" in get) ||
      typeof get.value !== "function" ||
      !search ||
      !("value" in search) ||
      typeof search.value !== "function"
    )
      return invalid();
    const retriever = Object.freeze(Object.create(null)) as Retriever;
    retrieverRegistry.set(retriever, {
      get: get.value,
      search: search.value,
    });
    return retriever;
  } catch {
    return invalid();
  }
};

export const isDestinationRetriever = (value: unknown): value is Retriever =>
  typeof value === "object" && value !== null && retrieverRegistry.has(value);

type ObservedSettlement =
  | Readonly<{ kind: "fulfilled"; value: unknown }>
  | Readonly<{ kind: "rejected" }>;

const observePromise = (
  value: unknown,
): Promise<ObservedSettlement> | undefined => {
  let settle: ((value: ObservedSettlement) => void) | undefined;
  const observed = new Promise<ObservedSettlement>((resolve) => {
    settle = resolve;
  });
  try {
    void reflectApply(promiseThen, value, [
      (result: unknown) => settle?.({ kind: "fulfilled", value: result }),
      () => settle?.({ kind: "rejected" }),
    ]);
    return observed;
  } catch {
    return undefined;
  }
};

const raceOperation = async (
  settlement: Promise<ObservedSettlement>,
  context: RetrievalContext,
): Promise<ObservedSettlement | "deadline"> =>
  new Promise((resolve) => {
    let completed = false;
    const finish = (value: ObservedSettlement | "deadline"): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      try {
        reflectApply(eventTargetRemove, context.signal, ["abort", onAbort]);
      } catch {
        // A validated native signal can still be concurrently sabotaged.
      }
      resolve(value);
    };
    const onAbort = (): void => {
      finish("deadline");
    };
    const timer = setTimeout(() => {
      finish("deadline");
    }, reporterDeadlineRemainingMilliseconds(context.deadline));
    try {
      reflectApply(eventTargetAdd, context.signal, [
        "abort",
        onAbort,
        { once: true },
      ]);
    } catch {
      /* v8 ignore next -- the context registry contains only native AbortSignal instances. */
      finish("deadline");
      /* v8 ignore next -- paired with the unreachable intrinsic failure above. */
      return;
    }
    void settlement.then((result) => {
      finish(result);
    });
  });

const successResult = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

const accountResultObject = (
  current: object,
  pending: unknown[],
  seen: WeakSet<object>,
): number | undefined => {
  /* v8 ignore next -- all branded result constructors clone acyclic plain data. */
  if (seen.has(current)) return undefined;
  seen.add(current);
  const descriptors = objectGetOwnPropertyDescriptors(current);
  let bytes = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    /* v8 ignore next -- branded result constructors reject symbol keys. */
    if (typeof key !== "string") return undefined;
    if (Array.isArray(current) && key === "length") continue;
    const descriptor = descriptors[key];
    /* v8 ignore next -- branded result constructors reject sparse/accessor members. */
    if (!descriptor || !("value" in descriptor)) return undefined;
    bytes += textEncoder.encode(key).byteLength;
    pending.push(descriptor.value);
  }
  return bytes;
};

const resultFitsResponseBudget = (
  value: unknown,
  context: RetrievalContext,
): boolean => {
  try {
    const pending: unknown[] = [value];
    const seen = new WeakSet<object>();
    let bytes = 0;
    let nodes = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      nodes += 1;
      /* v8 ignore next -- canonical and retrieval constructors enforce much smaller aggregate budgets. */
      if (nodes > 100_000) return false;
      if (typeof current === "string") {
        bytes += textEncoder.encode(current).byteLength;
      } else if (
        current === null ||
        typeof current === "boolean" ||
        typeof current === "number"
      ) {
        bytes += 32;
      } else {
        /* v8 ignore next -- branded result DTOs contain no function, symbol, bigint, or undefined values. */
        if (typeof current !== "object") return false;
        const accounted = accountResultObject(current, pending, seen);
        /* v8 ignore next -- only branded, constructor-normalized results reach this traversal. */
        if (accounted === undefined) return false;
        bytes += accounted;
      }
      if (bytes > context.maximumResponseBytes) return false;
    }
    return true;
  } catch {
    /* v8 ignore next -- descriptor-safe traversal of frozen branded DTOs is non-throwing. */
    return false;
  }
};

const invoke = async <T>(
  implementation: () => unknown,
  context: RetrievalContext,
  guard: (value: unknown) => value is T,
): Promise<RetrieverOperationResult<T>> => {
  if (
    signalIsAborted(context.signal) !== false ||
    reporterDeadlineRemainingMilliseconds(context.deadline) === 0
  )
    return createRetrieverFailure("deadline-exceeded");
  let returned: unknown;
  try {
    returned = implementation();
  } catch {
    return createRetrieverFailure("unavailable");
  }
  const observed = observePromise(returned);
  if (!observed) return createRetrieverFailure("malformed-response");
  const settlement = await raceOperation(observed, context);
  if (
    settlement === "deadline" ||
    signalIsAborted(context.signal) !== false ||
    reporterDeadlineRemainingMilliseconds(context.deadline) === 0
  )
    return createRetrieverFailure("deadline-exceeded");
  if (settlement.kind === "rejected")
    return createRetrieverFailure("unavailable");
  const result = settlement.value;
  if (isRetrieverFailure(result)) return result;
  if (
    typeof result !== "object" ||
    result === null ||
    Reflect.ownKeys(objectGetOwnPropertyDescriptors(result)).some(
      (key) => typeof key !== "string",
    ) ||
    objectKeys(objectGetOwnPropertyDescriptors(result)).sort().join(",") !==
      "ok,value"
  )
    return createRetrieverFailure("malformed-response");
  const descriptors = objectGetOwnPropertyDescriptors(result);
  if (
    descriptors.ok &&
    "value" in descriptors.ok &&
    descriptors.ok.value === true &&
    descriptors.value &&
    "value" in descriptors.value &&
    guard(descriptors.value.value)
  )
    return successResult(descriptors.value.value);
  return createRetrieverFailure("malformed-response");
};

export const invokeRetrieverSearch = async (
  retriever: Retriever,
  request: TraceSearchRequest,
  context: RetrievalContext,
): Promise<RetrieverOperationResult<RetrieverSearchPage>> => {
  const implementation = retrieverRegistry.get(retriever);
  if (
    !implementation ||
    !searchRequestRegistry.has(request) ||
    !contextRegistry.has(context)
  )
    return invalid();
  return invoke(
    () => implementation.search(request, context),
    context,
    (value): value is RetrieverSearchPage =>
      isRetrieverSearchPage(value) &&
      value.summaries.length <= request.query.limit &&
      value.summaries.every(
        (summary) =>
          summary.locator.connectionId === request.connectionId &&
          summary.locator.destinationType === request.destinationType,
      ) &&
      resultFitsResponseBudget(value, context),
  );
};

export const invokeRetrieverGet = async (
  retriever: Retriever,
  request: TraceGetRequest,
  context: RetrievalContext,
): Promise<RetrieverOperationResult<RetrievedTrace>> => {
  const implementation = retrieverRegistry.get(retriever);
  if (
    !implementation ||
    !getRequestRegistry.has(request) ||
    !contextRegistry.has(context)
  )
    return invalid();
  return invoke(
    () => implementation.get(request, context),
    context,
    (value): value is RetrievedTrace =>
      isRetrievedTrace(value) &&
      value.locator === request.locator &&
      resultFitsResponseBudget(value, context),
  );
};

export const createRetrieverSuccess = <
  T extends RetrieverSearchPage | RetrievedTrace,
>(
  value: T,
): RetrieverOperationResult<T> => {
  if (!isRetrieverSearchPage(value) && !isRetrievedTrace(value))
    return invalid();
  return successResult(value);
};
