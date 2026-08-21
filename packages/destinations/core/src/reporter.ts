import {
  isRedactedCanonicalTrace,
  type RedactedCanonicalTrace,
} from "@agentscope/protocol";

import {
  isRegisteredDestinationReporter,
  registerDestinationReporterForCore,
} from "./capability-brand.js";
import {
  isReporterDeadline,
  reporterDeadlineRemainingMilliseconds,
  type ReporterDeadline,
} from "./deadline.js";

export const MAXIMUM_REPORTER_BATCH_ITEMS = 32;

export const REPORTER_OUTCOMES = Object.freeze([
  "accepted",
  "rejected",
  "unavailable",
  "deadline-exceeded",
  "outcome-unknown",
] as const);

export type ReporterOutcome = (typeof REPORTER_OUTCOMES)[number];
export const REPORTER_RECEIPT_REASON_VERSION = 1 as const;
export const REPORTER_RECEIPT_REASONS = Object.freeze([
  "destination-busy",
  "destination-full",
  "destination-corrupt",
  "destination-migrating",
  "destination-retention",
  "destination-capacity",
] as const);
export type ReporterReceiptReason = (typeof REPORTER_RECEIPT_REASONS)[number];
export type ReporterReceipt = Readonly<{
  outcome: ReporterOutcome;
  reason?: ReporterReceiptReason;
}>;
export type RedactedTraceBatch = readonly [
  RedactedCanonicalTrace,
  ...RedactedCanonicalTrace[],
];

export type ReporterAttempt = Readonly<{
  traces: RedactedTraceBatch;
  signal: AbortSignal;
  deadline: ReporterDeadline;
  admissionTimeUnixNano: string;
}>;

export type ReporterImplementation = Readonly<{
  report: (attempt: ReporterAttempt) => Promise<ReporterReceipt>;
}>;

declare const reporterBrand: unique symbol;
export type Reporter = Readonly<{ readonly [reporterBrand]: true }>;

const reporterRegistry = new WeakMap<
  object,
  ReporterImplementation["report"]
>();
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const reflectOwnKeys = Reflect.ownKeys;
const reflectApply = Reflect.apply;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before caller-controlled prototype mutation.
const promiseThen = Promise.prototype.then;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before caller-controlled prototype mutation.
const eventTargetAdd = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before caller-controlled prototype mutation.
const eventTargetRemove = EventTarget.prototype.removeEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with Reflect.apply against a candidate signal.
const abortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

export class ReporterContractError extends Error {
  public readonly code = "destination.reporter.invalid";

  public constructor() {
    super("destination.reporter.invalid");
    this.name = "ReporterContractError";
  }
}

const invalid = (): never => {
  throw new ReporterContractError();
};

const unknownReceipt = Object.freeze({
  outcome: "outcome-unknown",
}) as ReporterReceipt;
const deadlineReceipt = Object.freeze({
  outcome: "deadline-exceeded",
}) as ReporterReceipt;
const maximumUnsignedInt64 = 18_446_744_073_709_551_615n;
const unsignedInt64Pattern = /^(?:0|[1-9][0-9]{0,19})$/u;

const receiptPairIsValid = (
  outcome: ReporterOutcome,
  reason: ReporterReceiptReason | undefined,
): boolean => {
  if (reason === undefined) return true;
  if (outcome === "rejected")
    return (
      reason === "destination-retention" || reason === "destination-capacity"
    );
  return outcome === "unavailable";
};

const admissionTimeIsValid = (value: unknown): value is string => {
  return (
    typeof value === "string" &&
    unsignedInt64Pattern.test(value) &&
    BigInt(value) <= maximumUnsignedInt64
  );
};

const signalIsAborted = (signal: unknown): boolean | undefined => {
  try {
    /* v8 ignore next -- Node's AbortSignal always exposes this intrinsic. */
    if (typeof abortedGetter !== "function") return undefined;
    return reflectApply(abortedGetter, signal, []) as boolean;
  } catch {
    return undefined;
  }
};

const parseReceipt = (value: unknown): ReporterReceipt | undefined => {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const descriptors = objectGetOwnPropertyDescriptors(value);
    const ownKeys = reflectOwnKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return undefined;
    const keys = ownKeys.sort().join(",");
    if (keys !== "outcome" && keys !== "outcome,reason") return undefined;
    const descriptor = descriptors.outcome;
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !REPORTER_OUTCOMES.includes(descriptor.value as ReporterOutcome)
    )
      return undefined;
    const outcome = descriptor.value as ReporterOutcome;
    const reasonDescriptor = descriptors.reason;
    const reason = reasonDescriptor?.value as unknown;
    if (
      (reasonDescriptor !== undefined &&
        (!("value" in reasonDescriptor) ||
          !REPORTER_RECEIPT_REASONS.includes(
            reason as ReporterReceiptReason,
          ))) ||
      !receiptPairIsValid(outcome, reason as ReporterReceiptReason | undefined)
    )
      return undefined;
    return Object.freeze({
      outcome,
      ...(reason === undefined
        ? {}
        : { reason: reason as ReporterReceiptReason }),
    });
  } catch {
    return undefined;
  }
};

const validateBatch = (input: unknown): RedactedTraceBatch => {
  try {
    if (
      !Array.isArray(input) ||
      input.length === 0 ||
      input.length > MAXIMUM_REPORTER_BATCH_ITEMS
    )
      return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(input);
    const traces: RedactedCanonicalTrace[] = [];
    const identities = new Set<string>();
    for (let index = 0; index < input.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !isRedactedCanonicalTrace(descriptor.value)
      )
        return invalid();
      const trace = descriptor.value;
      if (identities.has(trace.delivery.identity)) return invalid();
      identities.add(trace.delivery.identity);
      traces.push(trace);
    }
    for (const key of reflectOwnKeys(descriptors)) {
      if (
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key))
      )
        return invalid();
    }
    return Object.freeze(traces) as RedactedTraceBatch;
  } catch {
    return invalid();
  }
};

export const createReporterReceipt = (
  outcome: ReporterOutcome,
  reason?: ReporterReceiptReason,
): ReporterReceipt => {
  if (
    !REPORTER_OUTCOMES.includes(outcome) ||
    (reason !== undefined && !REPORTER_RECEIPT_REASONS.includes(reason)) ||
    !receiptPairIsValid(outcome, reason)
  )
    return invalid();
  return Object.freeze({
    outcome,
    ...(reason === undefined ? {} : { reason }),
  });
};

export const createDestinationReporter = (
  implementation: ReporterImplementation,
): Reporter => {
  try {
    if (typeof implementation !== "object" || implementation === null)
      return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(implementation);
    if (reflectOwnKeys(descriptors).join(",") !== "report") return invalid();
    const report = descriptors.report;
    if (!report || !("value" in report) || typeof report.value !== "function")
      return invalid();
    const reporter = Object.freeze(Object.create(null)) as Reporter;
    reporterRegistry.set(reporter, report.value);
    registerDestinationReporterForCore(reporter);
    return reporter;
  } catch {
    return invalid();
  }
};

export const isDestinationReporter = (value: unknown): value is Reporter =>
  isRegisteredDestinationReporter(value);

type ObservedSettlement =
  | Readonly<{ kind: "fulfilled"; value: unknown }>
  | Readonly<{ kind: "rejected" }>;

const observeNativePromise = (
  value: unknown,
): Promise<ObservedSettlement> | undefined => {
  let resolveSettlement: ((settlement: ObservedSettlement) => void) | undefined;
  const settlement = new Promise<ObservedSettlement>((resolve) => {
    resolveSettlement = resolve;
  });
  try {
    void reflectApply(promiseThen, value, [
      (result: unknown) => {
        resolveSettlement?.({ kind: "fulfilled", value: result });
      },
      () => {
        resolveSettlement?.({ kind: "rejected" });
      },
    ]);
    return settlement;
  } catch {
    return undefined;
  }
};

const raceReporter = async (
  settlement: Promise<ObservedSettlement>,
  signal: AbortSignal,
  deadline: ReporterDeadline,
): Promise<ReporterReceipt> => {
  const remaining = reporterDeadlineRemainingMilliseconds(deadline);
  return new Promise((resolve) => {
    let completed = false;
    const finish = (receipt: ReporterReceipt): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      try {
        reflectApply(eventTargetRemove, signal, ["abort", onAbort]);
      } catch {
        // The signal passed its internal-slot check; cleanup failure is non-fatal.
      }
      resolve(receipt);
    };
    const onAbort = (): void => {
      finish(unknownReceipt);
    };
    const timer = setTimeout(() => {
      finish(unknownReceipt);
    }, remaining);
    try {
      reflectApply(eventTargetAdd, signal, ["abort", onAbort, { once: true }]);
    } catch {
      /* v8 ignore start -- a signal that passed the AbortSignal internal-slot
         getter cannot fail the captured EventTarget intrinsic in Node. */
      finish(unknownReceipt);
      return;
      /* v8 ignore stop */
    }
    void settlement.then((result) => {
      if (
        signalIsAborted(signal) !== false ||
        reporterDeadlineRemainingMilliseconds(deadline) === 0 ||
        result.kind === "rejected"
      ) {
        finish(unknownReceipt);
        return;
      }
      finish(parseReceipt(result.value) ?? unknownReceipt);
    });
  });
};

export const invokeReporter = async (
  reporter: Reporter,
  attempt: ReporterAttempt,
): Promise<ReporterReceipt> => {
  let invoked = false;
  try {
    const report = reporterRegistry.get(reporter);
    if (!report || typeof attempt !== "object" || attempt === null)
      return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(attempt);
    if (
      reflectOwnKeys(descriptors).sort().join(",") !==
      "admissionTimeUnixNano,deadline,signal,traces"
    )
      return invalid();
    const traces = descriptors.traces;
    const signal = descriptors.signal;
    const deadline = descriptors.deadline;
    const admissionTimeUnixNano = descriptors.admissionTimeUnixNano;
    if (
      !traces ||
      !("value" in traces) ||
      !signal ||
      !("value" in signal) ||
      signalIsAborted(signal.value) === undefined ||
      !deadline ||
      !("value" in deadline) ||
      !isReporterDeadline(deadline.value) ||
      !admissionTimeUnixNano ||
      !("value" in admissionTimeUnixNano) ||
      !admissionTimeIsValid(admissionTimeUnixNano.value)
    )
      return invalid();
    if (
      signalIsAborted(signal.value) ||
      reporterDeadlineRemainingMilliseconds(deadline.value) === 0
    )
      return deadlineReceipt;
    const normalized = Object.freeze({
      traces: validateBatch(traces.value),
      signal: signal.value,
      deadline: deadline.value,
      admissionTimeUnixNano: admissionTimeUnixNano.value,
    });
    let returned: unknown;
    try {
      invoked = true;
      returned = report(normalized);
    } catch {
      return unknownReceipt;
    }
    const settlement = observeNativePromise(returned);
    if (!settlement) return unknownReceipt;
    return await raceReporter(
      settlement,
      normalized.signal,
      normalized.deadline,
    );
  } catch {
    /* v8 ignore else -- every post-invocation failure is contained at its exact seam. */
    if (!invoked) throw new ReporterContractError();
    /* v8 ignore next -- post-invocation failures are handled at their exact seam. */
    return unknownReceipt;
  }
};
