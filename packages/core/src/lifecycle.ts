import {
  invokeRedactedTraceSink,
  type RedactedTraceSink,
} from "@agentscope/destinations-core/lifecycle-sink";

import type {
  CapturedTrace,
  CapturedTraceCandidate,
  CaptureInvocationContext,
  HarnessCaptureFactory,
} from "./capture/types.js";
import { withCaptureInvocationSyncForCore } from "./capture/runtime.js";
import { redactCapturedTrace } from "./redaction/pipeline.js";

export type LifecycleStage = "capture" | "redaction" | "sink";
export type LifecycleFailureReason = "cancelled" | "failed";

export type LifecycleResult =
  | Readonly<{ outcome: "sink-returned"; stage: "sink" }>
  | Readonly<{
      outcome: "failed-open";
      stage: LifecycleStage;
      reason: LifecycleFailureReason;
    }>;

export type CaptureAdapter = (
  factory: HarnessCaptureFactory,
  signal?: AbortSignal,
) => CapturedTrace;

export type TraceLifecycleInput = Readonly<{
  invocation: CaptureInvocationContext;
  capture: CaptureAdapter;
  sink: RedactedTraceSink;
  signal?: AbortSignal;
}>;

const sinkReturned = Object.freeze({
  outcome: "sink-returned",
  stage: "sink",
} as const);
const failures = Object.freeze(
  Object.fromEntries(
    (["capture", "redaction", "sink"] as const).flatMap((stage) =>
      (["cancelled", "failed"] as const).map((reason) => [
        `${stage}:${reason}`,
        Object.freeze({ outcome: "failed-open" as const, stage, reason }),
      ]),
    ),
  ) as Record<
    `${LifecycleStage}:${LifecycleFailureReason}`,
    Exclude<LifecycleResult, { outcome: "sink-returned" }>
  >,
);

const promiseResolve = Promise.resolve.bind(Promise) as (
  value: unknown,
) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before caller-controlled prototype mutation.
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;

const attachPromiseReaction = (value: unknown): boolean => {
  try {
    void reflectApply(promiseThen, value, [() => undefined, () => undefined]);
    return true;
  } catch {
    return false;
  }
};

const observeUnexpectedReturn = (value: unknown): void => {
  if (value === undefined) return;
  if (attachPromiseReaction(value)) return;
  try {
    const observed = promiseResolve(value);
    void attachPromiseReaction(observed);
  } catch {
    // Hostile thenables are rejected without exposing their thrown content.
  }
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean => {
  try {
    return signal?.aborted === true;
  } catch {
    return true;
  }
};

const failOpen = (
  stage: LifecycleStage,
  reason: LifecycleFailureReason,
): LifecycleResult => failures[`${stage}:${reason}`];

export const runFailOpenTraceLifecycle = (
  input: TraceLifecycleInput,
): LifecycleResult => {
  let stage: LifecycleStage = "capture";
  let signal: AbortSignal | undefined;
  try {
    signal = input.signal;
    if (signalIsAborted(signal)) return failOpen(stage, "cancelled");
    let minted: CapturedTrace | undefined;
    const captured = withCaptureInvocationSyncForCore(
      input.invocation,
      (factory) => {
        const trackingFactory: HarnessCaptureFactory = Object.freeze({
          capture(candidate: CapturedTraceCandidate) {
            minted = factory.capture(candidate);
            return minted;
          },
        });
        const runtimeCapture = input.capture as unknown as (
          scopedFactory: HarnessCaptureFactory,
          scopedSignal?: AbortSignal,
        ) => unknown;
        const returned = runtimeCapture(trackingFactory, signal);
        if (minted === undefined || returned !== minted) {
          observeUnexpectedReturn(returned);
          throw new Error("core.lifecycle.invalid");
        }
        return minted;
      },
    );
    stage = "redaction";
    if (signalIsAborted(signal)) return failOpen(stage, "cancelled");
    const redacted = redactCapturedTrace(captured);
    stage = "sink";
    if (signalIsAborted(signal)) return failOpen(stage, "cancelled");
    return invokeRedactedTraceSink(input.sink, redacted) === "returned"
      ? sinkReturned
      : failOpen(stage, "failed");
  } catch {
    return failOpen(stage, signalIsAborted(signal) ? "cancelled" : "failed");
  }
};
