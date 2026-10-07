import type { RetrieverFailure } from "@agentscope/destinations-core";

type Observation = NonNullable<RetrieverFailure["adapterFailureObservation"]>;
// Stable reported stage ordinals; none identifies a proven underlying cause.
export const retrievalFailureStages = Object.freeze({
  leaseAcquisition: 1,
  preChildCutoff: 2,
  familyObservation: 3,
  childSetup: 4,
  watchdogAssociation: 5,
  requestWrite: 6,
  readyFrame: 7,
  leaseAmendment: 8,
  permissionWrite: 9,
  resultTransport: 10,
  workerNegative: 11,
  workerTerminal: 12,
  resultEvidence: 13,
  settlement: 14,
} as const);

const observations = new WeakMap<object, Observation>();
const monotonicNow = performance.now.bind(performance);
const objectKey = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

export const readLocalSqliteFailureObservation = (
  invocation: unknown,
): Observation | undefined =>
  objectKey(invocation) ? observations.get(invocation) : undefined;

export const createLocalSqliteFailureLedger = (cutoffAt: number) => {
  let stage: Observation["stage"] = retrievalFailureStages.childSetup;
  let first: Readonly<Pick<Observation, "stage" | "cutoffExpired">> | undefined;
  let workerJoined: boolean | null = null;
  let watchdogJoined: boolean | null = null;
  let leaseReleased: boolean | null = null;
  const capture = (): void => {
    first ??= Object.freeze({
      stage,
      cutoffExpired: monotonicNow() >= cutoffAt,
    });
  };
  return Object.freeze({
    enter: (next: Observation["stage"]): void => {
      stage = next;
    },
    capture,
    settle: (
      workers: boolean | null,
      watchdog: boolean | null,
      lease: boolean | null,
    ): void => {
      workerJoined = workers;
      watchdogJoined = watchdog;
      leaseReleased = lease;
    },
    snapshot: (): Observation | undefined =>
      first === undefined
        ? undefined
        : Object.freeze({
            ...first,
            workerJoined,
            watchdogJoined,
            leaseReleased,
          }),
  });
};

export const associateLocalSqliteRetrieval = <Value>(
  operation: Promise<Value>,
  ledger: ReturnType<typeof createLocalSqliteFailureLedger>,
): Promise<Value> => {
  const invocation = operation.then(
    (value) => value,
    (error: unknown) => {
      ledger.capture();
      const observation = ledger.snapshot();
      if (observation !== undefined) observations.set(invocation, observation);
      throw error;
    },
  );
  return invocation;
};

export const bounded = async <Value>(
  promise: Promise<Value>,
  milliseconds: number,
): Promise<Value | undefined> =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        /* v8 ignore next -- the resolved promise can race the timer, but cannot
           deterministically execute both settlements in one source test. */
        if (settled) return;
        settled = true;
        resolve(undefined);
      },
      Math.max(0, milliseconds),
    );
    timer.unref();
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      /* v8 ignore start -- all promises supplied by this module normalize
         failure into values; rejection handling remains fail-closed. */
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
      /* v8 ignore stop */
    );
  });
