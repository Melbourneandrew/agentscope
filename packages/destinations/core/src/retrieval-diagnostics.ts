import { types } from "node:util";

// Adapter-reported observations only; these values confer no result authority.
export type RetrieverFailureObservation = Readonly<{
  stage: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
  cutoffExpired: boolean;
  workerJoined: boolean | null;
  watchdogJoined: boolean | null;
  leaseReleased: boolean | null;
}>;

const keys = "cutoffExpired,leaseReleased,stage,watchdogJoined,workerJoined";
const descriptorsOf = Object.getOwnPropertyDescriptors;
const prototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const freeze = Object.freeze;
const isProxy = types.isProxy;
const nullableBoolean = (value: unknown): value is boolean | null =>
  value === null || typeof value === "boolean";

export const normalizeRetrieverFailureObservation = (
  value: unknown,
): RetrieverFailureObservation | undefined => {
  try {
    if (typeof value !== "object" || value === null || isProxy(value))
      return undefined;
    const prototype: unknown = prototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = descriptorsOf(value);
    const names = ownKeys(descriptors);
    if (
      names.length !== 5 ||
      names.some((key) => typeof key !== "string") ||
      (names as string[]).sort().join(",") !== keys ||
      names.some((key) => !("value" in descriptors[key as string]!))
    )
      return undefined;
    const stage: unknown = descriptors.stage!.value;
    const cutoffExpired: unknown = descriptors.cutoffExpired!.value;
    const workerJoined: unknown = descriptors.workerJoined!.value;
    const watchdogJoined: unknown = descriptors.watchdogJoined!.value;
    const leaseReleased: unknown = descriptors.leaseReleased!.value;
    if (
      typeof stage !== "number" ||
      !Number.isInteger(stage) ||
      stage < 1 ||
      stage > 14 ||
      typeof cutoffExpired !== "boolean" ||
      !nullableBoolean(workerJoined) ||
      !nullableBoolean(watchdogJoined) ||
      !nullableBoolean(leaseReleased)
    )
      return undefined;
    return freeze({
      stage: stage as RetrieverFailureObservation["stage"],
      cutoffExpired,
      workerJoined,
      watchdogJoined,
      leaseReleased,
    });
  } catch {
    return undefined;
  }
};

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

export const normalizeRetrieverFailure = (
  code: (typeof RETRIEVER_FAILURE_CODES)[number],
  retryAfterMilliseconds?: number,
  observation?: unknown,
) => {
  if (
    !RETRIEVER_FAILURE_CODES.includes(code) ||
    (retryAfterMilliseconds !== undefined &&
      (!Number.isSafeInteger(retryAfterMilliseconds) ||
        retryAfterMilliseconds < 0 ||
        retryAfterMilliseconds > 3_600_000 ||
        !["rate-limited", "unavailable"].includes(code)))
  )
    return undefined;
  const adapterFailureObservation =
    observation === undefined
      ? undefined
      : normalizeRetrieverFailureObservation(observation);
  if (
    observation !== undefined &&
    (code !== "unavailable" || adapterFailureObservation === undefined)
  )
    return undefined;
  return freeze({
    ok: false as const,
    code,
    ...(retryAfterMilliseconds === undefined ? {} : { retryAfterMilliseconds }),
    ...(adapterFailureObservation === undefined
      ? {}
      : { adapterFailureObservation }),
  });
};
